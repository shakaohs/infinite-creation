// 生成段投影器（P10-A 阶段 C · C-01 / D02-40 §4.2「投影 projectRenderUnits」）
//
// 职责单一：把 Stage 3 的 `story_shots`（+ `shot_assets`）**投影**成生成系统用的 `shots` 段行。
//
// 五条边界，越界就不是投影而是第二套创作权威：
//   ① 只写 A 组 17 列（+ 建行时 `status='pending'` / `error=''`）。B/C/E 组一律不碰 ——
//      段级参数归 `ShotParams.update`，产物归 `render`，快照归 `system`（§4.2）。
//   ② 不记内容日志：投影是**派生**，同一份输入重复投影必须零增量（§C-01 §10.1「A6 日志增量为 0」）。
//   ③ 幂等靠 `ON CONFLICT(id) DO UPDATE` + "逐列比较、相同不写"，不是靠删了重建。
//   ④ `story_shots.segment_id` 回写只用**直写 SQL 且仅当值变化**：它是投影派生的归属指针，
//      走 A2 审计会让每次重投影刷出一批无意义日志（D02-40 登记的 U-36-2）。
//      本模块**不**把它加进 `VOLATILE.story_shot`（那属于改冻结审计策略，须单独报告）。
//   ⑤ 0 镜段的删除走**专用裸 SQL**，绝不调用 `Shots.remove`（它会级联删 `shot_videos`，
//      等于顺手销毁生成候选）。有候选的段一律拒绝删除并报告（C-07）。
//
// ── D02-48 两项定向修复 ────────────────────────────────────────────────────
// D48-01 **显式分段必须完整覆盖**：显式 `units` 不是"随便挑几镜投"，而是调用方对本次范围的
//        完整分段意图。少一镜 ⇒ `UNIT_SHOT_COVERAGE_INCOMPLETE`（带四个 id 列表），
//        **不得静默补齐**——补齐等于替调用方编造分段。校验在任何写入之前完成。
// D48-02 **禁止复用仍有候选的历史段 id**：段 id 由「项目:章:场次:段序」确定性派生，
//        镜被删后其段因候选而保留，新镜进入同一段序就会算出同一个 id。
//        因此 id 相同**不再等于**同一逻辑段：必须先验证「该段现有归属镜全部属于本组」，
//        否则一律换新 id（`|alt|` 摘要），旧段原样保留、候选不迁移、不删除、不级联。
//        无法证明同一逻辑段时 fail-closed 到新身份，而不是覆盖。
// D49-01 **有候选的段只允许完全幂等的重投影**：段上已有 `shot_videos` 时，
//        A 组内容变化（`content_changed`）或归属镜集合变化（增/减/合并/拆分）一律
//        `UNIT_SEGMENT_CANDIDATE_CONFLICT`，既不覆盖内容、也不换 id 绕过、更不动候选行。
//        理由：候选的 `input_hash` 由段内容算出，内容变了候选就与段对不上；换 id 只是把
//        "错误关联"换成"静默孤儿"。要给新内容出片，应先清掉该段候选或用新的段。
// D50-01 **跨段守卫**：候选保护不能只看"最终计划里的段"。合并 A+B 时若候选只在 B 上，
//        B 不在计划里、只会在 stale 清理阶段被 blocked —— 那时 A 已经吸收了 B 的内容。
//        因此写入前对「本次范围内所有镜当前指向的段 ∪ 计划段」逐段比对归属前后值，
//        任何有候选的段只要归属/生命周期会变就拒绝（`reason=segment_absorbed`）。
import { createHash } from 'node:crypto';
import { getDb, txProject, assertProjectLocked } from '../db.js';
import { now } from '../utils.js';

/** 投影可写的 A 组 17 列（D02-40 §4.1，逐字；`refs` 见下） */
export const PROJECTION_FIELDS = Object.freeze([
  'idx', 'chapter', 'scene_name', 'camera', 'visual', 'dialogue', 'narration', 'sub_shots', 'blocking',
  'duration', 'character_ids', 'scene_ids', 'prop_ids', 'costume_ids', 'age_ids', 'audio_ids',
]);

/** 结构化项目拒绝写入的遗留字段（无 Stage 3 落点、无生成消费方）。`refs` 在库里，名字对不上是刻意的。 */
const LEGACY_ONLY_FIELDS = Object.freeze(['refs', 'references']);

const ROLE_TO_COLUMN = Object.freeze({
  character: 'character_ids', scene: 'scene_ids', prop: 'prop_ids',
  costume: 'costume_ids', age: 'age_ids', voice: 'audio_ids',
});

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function projError(code, message, detail) {
  const e = new Error(message);
  e.code = code;
  if (detail) e.detail = detail;
  return e;
}

const jsonArr = (v) => {
  if (Array.isArray(v)) return v;
  try { const p = JSON.parse(v || '[]'); return Array.isArray(p) ? p : []; } catch { return []; }
};
const joinText = (rows, key) => rows.map((r) => String(r[key] ?? '').trim()).filter(Boolean).join('\n');

/**
 * 投影一个场次的镜头到生成段。
 *
 * @param {object} p
 * @param {string} p.projectId
 * @param {string} p.chapterId
 * @param {string} [p.sceneUid] 只投该场次；省略 = 该章全部场次
 * @param {Array<{segment_id?:string, shot_ids:string[]}>|null} [p.units] 显式分段；省略 = 按既有 segment_id 分组、未分组的每镜一段
 * @param {string} [p.writer] 仅用于拒绝 `system`（§4.4 规则 3：投影不得借 system 绕权限）
 * @returns {{projectId:string, chapterId:string, units:Array, created:number, updated:number, unchanged:number,
 *            deleted:string[], blocked:Array, conflicts:Array, reused_with_candidates:Array, segmentWrites:Array}}
 */
export function projectSceneUnits({ projectId, chapterId, sceneUid = '', units = null, writer = '' } = {}) {
  const pid = String(projectId || '').trim();
  if (!pid) throw projError('PROJECT_REQUIRED', 'projectRenderUnits 必须指定 projectId');
  if (String(writer) === 'system') {
    // 投影有自己的白名单，不需要也不允许借 system writer（借了就顺手能写 E 组）
    throw projError('PROJECTION_WRITER_FORBIDDEN', '投影不得使用 system writer（D02-40 §4.4 规则 3）');
  }
  const cid = String(chapterId || '').trim();
  if (!cid) throw projError('CHAPTER_REQUIRED', 'projectRenderUnits 必须指定 chapterId');

  return txProject(pid, () => {
    assertProjectLocked(pid);
    const db = getDb();

    const chapter = db.prepare('SELECT id, title FROM chapters WHERE id = ? AND project_id = ?').get(cid, pid);
    if (!chapter) throw projError('CHAPTER_NOT_FOUND', `章节不存在或不属于项目：${cid}`, { chapterId: cid, projectId: pid });

    const shotsSql = 'SELECT * FROM story_shots WHERE project_id = ? AND chapter_id = ?'
      + (sceneUid ? ' AND scene_uid = ?' : '')
      + ' ORDER BY global_no ASC, shot_no ASC';
    const shotRows = sceneUid ? db.prepare(shotsSql).all(pid, cid, sceneUid) : db.prepare(shotsSql).all(pid, cid);

    // D48-01：完整覆盖校验。必须在任何段写入 / segment_id 回写 / 旧段清理之前（要求 7）。
    if (units) validateUnitsInput(units, shotRows, { sceneUid });

    // ① 分组：显式给出就用；否则按既有 segment_id 分组，未分组的每镜自成一段
    const groups = units
      ? units.map((u) => ({
        segmentId: String(u.segment_id || '').trim(),
        shotIds: u.shot_ids.map(String),
        explicit: !!String(u.segment_id || '').trim(),
      }))
      : groupByExistingSegment(shotRows);

    // ② 段内顺序：按 global_no（安定序，不依赖数据库返回顺序）
    const byId = new Map(shotRows.map((r) => [String(r.id), r]));
    for (const g of groups) {
      g.shotIds.sort((a, b) => Number(byId.get(a).global_no) - Number(byId.get(b).global_no));
      g.sortKey = Math.min(...g.shotIds.map((id) => Number(byId.get(id).global_no)));
    }
    groups.sort((a, b) => a.sortKey - b.sortKey);

    // ②-b 段身份裁决（D48-02）：在**写之前**把每段的最终 id 定下来。
    //      同一逻辑段的判据是「该段当前归属的镜全部属于本组」，不是「id 相等」。
    const conflicts = [];
    const plan = [];
    const planned = new Set();
    groups.forEach((g, i) => {
      const idx = i + 1;
      const shotSet = new Set(g.shotIds);
      const baseId = g.segmentId || newSegmentId(pid, cid, sceneUid, idx);
      const segmentId = decideSegmentId({
        db, pid, baseId, shotSet, shotIds: g.shotIds, explicit: g.explicit, conflicts,
        currentIds: [...new Set(g.shotIds.map((id) => String(byId.get(id).segment_id || '')).filter(Boolean))],
      });
      if (planned.has(segmentId)) {
        throw projError('UNIT_SEGMENT_ID_DUPLICATED', `同一段 id 被分配给两个段：${segmentId}`, { segment_id: segmentId });
      }
      planned.add(segmentId);
      const rows = g.shotIds.map((id) => byId.get(id));
      plan.push({
        idx, segmentId, shotIds: g.shotIds, rows, shotSet,
        fields: projectionFieldsOf({ chapterTitle: chapter.title, sceneUid, rows, idx, db, projectId: pid }),
      });
    });

    // ②-c 候选有效性守卫（D02-49 §二）：仍在**任何写入之前**。
    //      段上已有 `shot_videos` 时，投影只允许「完全无变化」的重投影：
    //        · A 组内容变了 ⇒ 旧候选对应的生成输入已变，静默覆盖等于让候选挂在新内容上；
    //        · 归属镜集合变了（增/减/合并/拆分）⇒ 候选是哪几镜合成的无从证明。
    //      两种都不猜、不删候选、不靠换 id 绕过，直接 fail-closed。
    for (const p of plan) {
      assertCandidateSafe({ db, pid, plan: p });
    }

    // ②-d 跨段守卫（D02-50 §二）：上面只看了「最终计划里的段」。
    //      合并 A+B 时，若候选只在 B 上，B 不在计划里（它会被 stale 清理挡下），
    //      旧实现因此放行 —— A 照样吸收了 B 的内容，B 的候选直接变孤儿。
    //      这里把**本次投影会改变归属/生命周期的全部历史段**都查一遍（仍在任何写入之前）。
    assertAffectedSegmentsSafe({ db, pid, plan, shotRows });

    // ③ 逐段投影（idx 从 1 连续）
    let created = 0; let updated = 0; let unchanged = 0;
    const outUnits = [];
    const keepIds = new Set();
    const segmentWrites = [];
    const reusedWithCandidates = [];

    plan.forEach(({ idx, segmentId, shotIds, rows, fields }) => {
      keepIds.add(segmentId);

      const existing = db.prepare('SELECT * FROM shots WHERE id = ?').get(segmentId);
      const same = existing && PROJECTION_FIELDS.every((k) => String(existing[k] ?? '') === String(fields[k] ?? ''));
      if (!existing) {
        db.prepare(`INSERT INTO shots (id, project_id, ${PROJECTION_FIELDS.join(', ')}, status, error, created_at, updated_at)`
          + ` VALUES (?, ?, ${PROJECTION_FIELDS.map(() => '?').join(', ')}, ?, ?, ?, ?)`)
          .run(segmentId, pid, ...PROJECTION_FIELDS.map((k) => fields[k]), 'pending', '', now(), now());
        created += 1;
      } else if (!same) {
        // 只更新 A 组：生成参数（B 组）、产物（C 组）、快照（E 组）一律不动
        db.prepare(`UPDATE shots SET ${PROJECTION_FIELDS.map((k) => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`)
          .run(...PROJECTION_FIELDS.map((k) => fields[k]), now(), segmentId);
        updated += 1;
      } else {
        unchanged += 1;
      }

      // 候选与段的关联：**不迁移、不删除、不改 `selected` / `input_hash` / `shot_id`**。
      // D02-49 起「内容变化 + 有候选」在 ②-c 就被拒绝，所以这里只会记录"无变化的幂等重投影"。
      // 保留该字段是为了让调用方能看见"这一段是有候选的、刚才那次投影没有动它"。
      if (existing) {
        const candidates = candidateCount(db, segmentId);
        if (candidates > 0) {
          reusedWithCandidates.push({ segment_id: segmentId, candidates, content_changed: !same });
        }
      }

      // ④ segment_id 回写：只在值真的不同的时候写（幂等 + 不刷无意义写入）
      for (const r of rows) {
        if (String(r.segment_id || '') === segmentId) continue;
        db.prepare('UPDATE story_shots SET segment_id = ?, updated_at = ? WHERE id = ?').run(segmentId, now(), r.id);
        segmentWrites.push({ story_shot_id: r.id, segment_id: segmentId });
      }

      outUnits.push({ segment_id: segmentId, idx, shot_ids: shotIds });
    });

    // ⑤ 0 镜段：本次范围内**曾经指向**、但已不在新分区里的段 ⇒ 专用裸 SQL 删除
    const deleted = [];
    const blocked = [];
    // 范围 = ①仍被本范围镜头引用的段 + ②本场次按 idx 确定性派生出的段 id。
    // ② 不可省：某一镜被删掉后，它那段就**没有任何 story_shots 指向它**了，
    // 只按 ① 找会把 0 镜段永远留在库里（正是 C-01「0 镜段必须删除」要防的事）。
    const scopeIds = new Set();
    for (const r of shotRows) {
      const sid = String(r.segment_id || '');
      if (sid) scopeIds.add(sid);
    }
    const span = Math.max(12, groups.length + 4);
    for (let i = 1; i <= span; i++) scopeIds.add(newSegmentId(pid, cid, sceneUid, i));
    const stale = new Set();
    for (const sid of scopeIds) if (!keepIds.has(sid)) stale.add(sid);
    for (const sid of stale) {
      const row = db.prepare('SELECT id FROM shots WHERE id = ? AND project_id = ?').get(sid, pid);
      if (!row) continue;
      const cand = candidateCount(db, sid);
      if (cand > 0) {
        // 候选与段的关联无法安全迁移 ⇒ 拒绝删除并报告（不得静默丢候选）
        blocked.push({ segment_id: sid, candidates: cand, reason: 'orphaned_with_candidates' });
        continue;
      }
      // 专用删除路径：**不经过 Shots.remove**（那会级联删 shot_videos）
      db.prepare('DELETE FROM shots WHERE id = ?').run(sid);
      deleted.push(sid);
    }

    return {
      projectId: pid, chapterId: cid, sceneUid: String(sceneUid || ''),
      units: outUnits, created, updated, unchanged, deleted, blocked,
      conflicts, reused_with_candidates: reusedWithCandidates, segmentWrites,
    };
  });
}

/** 对外正式名（D02-40 §4.2/§4.6 用的是 `projectRenderUnits`）。 */
export const projectRenderUnits = projectSceneUnits;

// ── 内部 ───────────────────────────────────────────────────────────────────

/**
 * D48-02：判定一个候选段 id 能否被本组复用。
 *
 * 复用条件（三者同时成立，缺一即换新身份）：
 *   ① 段行存在且属于本项目；
 *   ② 该段**当前归属的镜非空**；
 *   ③ 这些镜全部属于本组（`owners ⊆ group`）。
 *
 * ② 不可省：镜被删光后段上 owners 为空，空集是任何集合的子集 —— 只做子集判断会把
 * 「旧段（还挂着候选）」判成「同一逻辑段」，正是本次要修的错误关联。
 */
function decideSegmentId({ db, pid, baseId, shotSet, shotIds, explicit, conflicts, currentIds = [] }) {
  // ① 组内镜**当前已经共同指向**同一个段 ⇒ 那就是它们的逻辑段身份，不因段序变化而换。
  //    没有这一步，显式 units（不给 segment_id）会在「alt 身份」与「段序 base 身份」之间来回翻，
  //    每次翻动都会把上一次的段变成孤儿（候选还在，只是不再被引用）。
  if (!explicit && currentIds.length === 1 && currentIds[0] !== baseId) {
    const cur = currentIds[0];
    const curRow = db.prepare('SELECT * FROM shots WHERE id = ?').get(cur);
    const curCand = candidateCount(db, cur);
    if (!curRow && curCand === 0) return cur;           // 悬空指针：沿用该身份重建，不另起炉灶
    if (curRow && String(curRow.project_id) === String(pid)) {
      const curOwners = ownerIdsOf(db, pid, cur);
      if (curOwners.length > 0 && curOwners.every((o) => shotSet.has(o))) return cur;
    }
  }

  const row = db.prepare('SELECT * FROM shots WHERE id = ?').get(baseId);
  const foreign = !!row && String(row.project_id) !== String(pid);
  const owners = row && !foreign ? ownerIdsOf(db, pid, baseId) : [];
  const candidates = candidateCount(db, baseId);
  const sameLogical = !!row && !foreign && owners.length > 0 && owners.every((o) => shotSet.has(o));

  if (sameLogical) return baseId;
  // 无段行、无历史候选 ⇒ 这个 id 从来没人用过，直接新建
  if (!row && candidates === 0) return baseId;

  // D02-49 §二：该段仍有候选，且与本组存在归属交集（增镜 / 减镜 / 合并 / 拆分）。
  // 交集非空 ⇒ 本组就是这条已出片段的"改造者"，而候选是哪几镜、哪份 A 组内容合成的已不可证。
  // 不换 id 绕过（换 id 只会把候选变成孤儿，等于用另一种方式丢关联），直接拒绝。
  if (!foreign && candidates > 0) {
    const overlap = owners.filter((o) => shotSet.has(o));
    if (overlap.length) {
      const groupSubset = [...shotSet].every((x) => owners.includes(x));
      const ownersSubset = owners.every((x) => shotSet.has(x));
      throw candidateConflict({
        segmentId: baseId,
        candidates,
        owners,
        groupShotIds: shotIds,
        ownershipChanged: true,
        changedFields: [],
        reason: groupSubset ? 'segment_split' : (ownersSubset ? 'segment_grew' : 'ownership_mixed'),
      });
    }
  }

  // 到这里必须换身份：段行存在但归属不是本组，或没有段行却残留着指向它的候选。
  if (explicit) {
    throw projError('UNIT_SEGMENT_ID_CONFLICT',
      `显式指定的段 ${baseId} 不属于本组（现归属 ${owners.length} 镜、候选 ${candidates} 条）：`
      + '不得把新镜头写进历史段，也不得覆盖仍有候选的段', {
        segment_id: baseId, group_shot_ids: [...shotIds].sort(cmpStr),
        current_owners: owners, candidates,
      });
  }

  const altId = altSegmentId(baseId, shotIds);
  const altRow = db.prepare('SELECT * FROM shots WHERE id = ?').get(altId);
  const altCandidates = candidateCount(db, altId);
  if (!altRow && altCandidates === 0) {
    // 四类情形必须能分开（D02-48 §三）：① 段还在但归属别的镜；② 段已失去全部镜归属；
    // ③ 段已失去归属且仍挂着候选（本次修复的主场景）；④ 段行没了但候选还指向它。
    const reason = !row
      ? 'candidates_without_segment'
      : (owners.length ? 'owners_outside_group' : (candidates > 0 ? 'orphaned_with_candidates' : 'orphaned_without_candidates'));
    conflicts.push({
      base_segment_id: baseId,
      assigned_segment_id: altId,
      reason,
      current_owners: owners.length,
      candidates,
      has_candidates: candidates > 0,
    });
    return altId;
  }
  // 备选 id 也被占用：说明同一组镜曾经以另一个归属存在过，或摘要撞了。
  // 不猜、不覆盖 —— fail-closed 交给人工，这属于需要架构裁定的异常。
  const altOwners = altRow ? ownerIdsOf(db, pid, altId) : [];
  const altSame = !!altRow && altOwners.length > 0 && altOwners.every((o) => shotSet.has(o));
  if (altSame) return altId;
  throw projError('UNIT_SEGMENT_ID_CONFLICT',
    `段 id ${baseId} 与备选 id ${altId} 都被占用且归属不明：无法证明属于同一逻辑段`, {
      segment_id: baseId, alt_segment_id: altId,
      current_owners: owners, alt_owners: altOwners, candidates, alt_candidates: altCandidates,
    });
}

/**
 * D02-49 §二：候选有效性守卫的**唯一构造点**，保证错误码与 detail 形状一致。
 *
 * 为什么必须 fail-closed 而不是"覆盖 + 报告"：候选的 `input_hash` 是从段的 A/B 组内容算出来的，
 * 内容一变，候选就与段对不上了；此时保留候选并覆盖内容，等于让下游把旧视频当新内容的产物选中。
 * 也不能靠"换段 id"绕：换 id 会让候选变成孤儿段，只是把"错误关联"换成"静默丢失"。
 */
function candidateConflict({ segmentId, candidates, owners, groupShotIds, ownershipChanged, changedFields, reason }) {
  return projError('UNIT_SEGMENT_CANDIDATE_CONFLICT',
    `段 ${segmentId} 上已有 ${candidates} 条生成候选，本次投影会改变`
    + (ownershipChanged
      ? `它的镜头归属或生命周期（现归属 ${owners.length} 镜、投影后 ${groupShotIds.length} 镜）`
      : `它的 A 组内容（${changedFields.join(', ')}）`)
    + '：候选的有效性无法证明。请先删除该段的候选，或把改动落到新的段上', {
      segment_id: segmentId,
      candidates,
      ownership_changed: ownershipChanged,
      content_changed: changedFields.length > 0,
      changed_fields: changedFields,
      current_owners: owners,
      group_shot_ids: [...groupShotIds].sort(cmpStr),
      reason,
    });
}

/** ②-c：写之前逐段检查「有候选的段是否被改动」。 */
function assertCandidateSafe({ db, pid, plan }) {
  const existing = db.prepare('SELECT * FROM shots WHERE id = ?').get(plan.segmentId);
  if (!existing) return;                       // 新建段不可能有候选
  const candidates = candidateCount(db, plan.segmentId);
  if (!candidates) return;                     // 无候选 ⇒ 按冻结投影规则正常更新
  const owners = ownerIdsOf(db, pid, plan.segmentId);
  const sameOwners = owners.length === plan.shotSet.size && owners.every((o) => plan.shotSet.has(o));
  const changedFields = PROJECTION_FIELDS.filter((k) => String(existing[k] ?? '') !== String(plan.fields[k] ?? ''));
  if (sameOwners && !changedFields.length) return;   // 完全幂等：允许
  throw candidateConflict({
    segmentId: plan.segmentId,
    candidates,
    owners,
    groupShotIds: plan.shotIds,
    ownershipChanged: !sameOwners,
    changedFields,
    reason: sameOwners ? 'content_changed' : 'ownership_changed',
  });
}

/**
 * ②-d（D02-50 §二）：**跨段**候选守卫。
 *
 * 受影响段 = ① 本次范围内所有镜当前指向的段（含会被合并吸收、被拆分、被迁走、被清掉的）
 *          ∪ ② 最终计划里的段（计划段另由 `assertCandidateSafe` 查内容变化）。
 *
 * 对每个有候选的受影响段，比较「投影前归属」与「投影后归属」：
 *   · 在计划里      ⇒ 投影后归属 = 该组全部镜
 *   · 不在计划里    ⇒ 投影后归属 = 它在本范围之外的剩余归属（范围内的会被改到别处）
 * 两者不同 ⇒ 该段的内容或生命周期会被本次投影改变 ⇒ 拒绝。
 *
 * **不误伤已孤儿段**：投影前就是 0 归属、投影后仍 0 归属（只是继续 blocked）的段，
 * 本次投影没有改变它任何东西，一律放行（D02-48/49 的 `orphaned_with_candidates` 场景）。
 */
function assertAffectedSegmentsSafe({ db, pid, plan, shotRows }) {
  const scopeShotIds = new Set(shotRows.map((r) => String(r.id)));
  const planById = new Map(plan.map((p) => [p.segmentId, p]));
  const affected = new Set();
  for (const r of shotRows) {
    const sid = String(r.segment_id || '');
    if (sid) affected.add(sid);
  }
  for (const sid of planById.keys()) affected.add(sid);

  for (const sid of affected) {
    const candidates = candidateCount(db, sid);
    if (!candidates) continue;
    const owners = ownerIdsOf(db, pid, sid);
    const entry = planById.get(sid);
    const after = entry ? entry.shotIds : owners.filter((o) => !scopeShotIds.has(o));
    const sameAfter = owners.length === after.length && owners.every((o) => after.includes(o));
    if (sameAfter) continue;
    throw candidateConflict({
      segmentId: sid,
      candidates,
      owners,
      groupShotIds: after,
      ownershipChanged: true,
      changedFields: [],
      reason: entry ? 'ownership_changed' : 'segment_absorbed',
    });
  }
}

function ownerIdsOf(db, pid, segmentId) {
  return db.prepare('SELECT id FROM story_shots WHERE project_id = ? AND segment_id = ?').all(pid, segmentId)
    .map((r) => String(r.id));
}

function candidateCount(db, segmentId) {
  const r = db.prepare('SELECT COUNT(*) AS n FROM shot_videos WHERE shot_id = ?').get(segmentId);
  return Number(r?.n || 0);
}

/**
 * D48-01：显式分段的完整覆盖校验。
 *
 * 「完整覆盖」的定义：本次投影范围内的每一个 `story_shots` 行，在 `units` 中**恰好出现一次**。
 * 少一镜 → 覆盖不完整；多一镜 → 不在范围；同一镜两次 → 重复；空段 → 无意义。
 * 报错必须带 expected / actual / missing / duplicated 四个列表，让调用方能自己对齐意图。
 * **不静默补齐**：补齐等于替调用方编造分段，投影就从"执行意图"变成"猜测意图"。
 */
function validateUnitsInput(units, shotRows, { sceneUid = '' } = {}) {
  if (!Array.isArray(units) || !units.length) {
    throw projError('UNITS_REQUIRED', 'units 必须是非空数组；省略该参数表示按既有 segment_id 自动分组');
  }
  const known = new Map(shotRows.map((r) => [String(r.id), r]));
  const seen = new Set();
  const duplicated = [];
  const segIds = new Set();
  const duplicatedSeg = [];
  for (const [i, u] of units.entries()) {
    if (!u || typeof u !== 'object') throw projError('UNIT_INVALID', `units[${i}] 必须是对象`);
    for (const f of LEGACY_ONLY_FIELDS) {
      // 结构化项目写 refs 一律报错（不静默忽略）：它没有 Stage 3 落点
      if (Object.prototype.hasOwnProperty.call(u, f)) {
        throw projError('PROJECTION_LEGACY_FIELD_REJECTED',
          `投影不接受遗留字段 ${f}（无 Stage 3 落点）；请改用 shot_assets 的 role`, { index: i, field: f });
      }
    }
    if (!Array.isArray(u.shot_ids) || !u.shot_ids.length) {
      throw projError('UNIT_SHOTS_REQUIRED', `units[${i}] 必须给出非空 shot_ids`);
    }
    const unitScenes = new Set();
    for (const id of u.shot_ids) {
      const s = String(id);
      const row = known.get(s);
      if (!row) {
        throw projError('UNIT_SHOT_NOT_IN_SCOPE', `units[${i}] 引用的镜头不在本次投影范围：${s}`, { index: i, shot_id: s });
      }
      if (seen.has(s)) duplicated.push(s);
      else seen.add(s);
      const su = String(row.scene_uid || '');
      if (su) unitScenes.add(su);
    }
    // 整章投影时（sceneUid 省略）也禁止一个段跨场次：段是"一场戏里的一个生成单元"
    if (!sceneUid && unitScenes.size > 1) {
      throw projError('UNIT_SHOT_CROSS_SCENE', `units[${i}] 跨场次引用：${[...unitScenes].join(', ')}（一段只能属于一个场次）`, {
        index: i, scene_uids: [...unitScenes],
      });
    }
    const sid = String(u.segment_id || '').trim();
    if (sid) {
      if (segIds.has(sid)) duplicatedSeg.push(sid);
      segIds.add(sid);
    }
  }

  const expected = [...known.keys()];
  const actual = [...seen];
  const missing = expected.filter((id) => !seen.has(id));
  const detail = {
    expected_shot_ids: expected,
    actual_shot_ids: actual,
    missing_shot_ids: missing,
    duplicated_shot_ids: duplicated,
  };
  if (duplicated.length) {
    throw projError('UNIT_SHOT_DUPLICATED', `镜头出现在多个段里（一镜只能属于一段）：${duplicated.join(', ')}`, detail);
  }
  if (duplicatedSeg.length) {
    throw projError('UNIT_SEGMENT_ID_DUPLICATED', `同一 segment_id 被用于多个段：${duplicatedSeg.join(', ')}`, {
      ...detail, duplicated_segment_ids: duplicatedSeg,
    });
  }
  if (missing.length) {
    throw projError('UNIT_SHOT_COVERAGE_INCOMPLETE',
      `显式 units 未覆盖本次投影范围的全部镜头（缺 ${missing.length}/${expected.length}）：${missing.join(', ')}。`
      + '投影不会替你补齐遗漏镜头 —— 那会改变你明确指定的分段意图', detail);
  }
}

function groupByExistingSegment(shotRows) {
  const groups = new Map();
  const singles = [];
  for (const r of shotRows) {
    const sid = String(r.segment_id || '');
    if (!sid) { singles.push({ segmentId: '', shotIds: [String(r.id)], explicit: false }); continue; }
    if (!groups.has(sid)) groups.set(sid, { segmentId: sid, shotIds: [], explicit: false });
    groups.get(sid).shotIds.push(String(r.id));
  }
  return [...groups.values(), ...singles];
}

function projectionFieldsOf({ chapterTitle, sceneUid, rows, idx, db, projectId }) {
  const vals = { character_ids: [], scene_ids: [], prop_ids: [], costume_ids: [], age_ids: [], audio_ids: [] };
  const ids = rows.map((r) => String(r.id));
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const assets = db.prepare(`SELECT shot_id, role, asset_id FROM shot_assets WHERE shot_id IN (${placeholders}) ORDER BY shot_id, role, order_no`)
      .all(...ids);
    for (const a of assets) {
      const col = ROLE_TO_COLUMN[a.role];
      if (col && !vals[col].includes(a.asset_id)) vals[col].push(a.asset_id);
    }
  }
  const duration = rows.reduce((n, r) => n + (Number(r.story_duration) || 0), 0);
  return {
    idx,
    chapter: chapterTitle,
    scene_name: String(rows[0].scene_key || sceneUid || ''),
    camera: String(rows[0].cam_note || ''),
    visual: joinText(rows, 'visual_content'),
    dialogue: joinText(rows, 'dialogue'),
    narration: joinText(rows, 'narration'),
    // 一段多镜时把各镜的时间切片按行拼起来，单镜时为空串（与 legacy 语义一致：sub_shots 是"补充说明"）
    sub_shots: rows.length > 1 ? rows.map((r) => JSON.stringify(jsonArr(r.time_slices))).join('\n') : '',
    blocking: '',
    duration: duration > 0 ? duration : 5,
    // 六个 *_ids 是 JSON 文本列（与 Shots.create 同口径），不能直接绑数组
    character_ids: JSON.stringify(vals.character_ids),
    scene_ids: JSON.stringify(vals.scene_ids),
    prop_ids: JSON.stringify(vals.prop_ids),
    costume_ids: JSON.stringify(vals.costume_ids),
    age_ids: JSON.stringify(vals.age_ids),
    audio_ids: JSON.stringify(vals.audio_ids),
  };
}

/** 段 id：由「项目 + 章 + 场次 + 段序」确定性派生。
 *  必须是**定长摘要**而不是截断的 base64 —— 后者在 idx 位于末尾时会把不同的段截成同一个 id
 *  （第一版就是这么错的：三个段塌成一段，投影看起来"成功"其实只建了一行）。 */
function newSegmentId(projectId, chapterId, sceneUid, idx) {
  const base = [projectId, chapterId, sceneUid || '-', String(idx)].join(':');
  return 'seg_' + createHash('sha256').update(base).digest('hex').slice(0, 32);
}

/**
 * D48-02：历史段占位时的备选 id。
 * 摘要输入含**本组镜 id 的全集**（排序后），因此：
 *   · 同一组镜重复投影 ⇒ 同一个备选 id（幂等，段身份稳定）；
 *   · 组内换了一镜 ⇒ 换一个备选 id（不会继承旧候选的关联）。
 * 这是"新逻辑段与历史段 id 冲突"时的隔离手段，不改变「镜 = story_shots.id，段 = shots.id，
 * 镜→段 1:N 靠 story_shots.segment_id」的冻结身份模型（D02-40 §4.2）。
 */
function altSegmentId(baseId, shotIds) {
  const ids = [...shotIds].map(String).sort(cmpStr).join(',');
  return 'seg_' + createHash('sha256').update(baseId + '|alt|' + ids).digest('hex').slice(0, 32);
}
