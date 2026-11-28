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
 * @returns {{projectId:string, chapterId:string, units:Array, created:number, updated:number, unchanged:number, deleted:string[], blocked:Array}}
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

    if (units) validateUnitsInput(units, shotRows);

    // ① 分组：显式给出就用；否则按既有 segment_id 分组，未分组的每镜自成一段
    const groups = units
      ? units.map((u) => ({ segmentId: String(u.segment_id || ''), shotIds: u.shot_ids.map(String) }))
      : groupByExistingSegment(shotRows);

    // ② 段内顺序：按 global_no（安定序，不依赖数据库返回顺序）
    const byId = new Map(shotRows.map((r) => [String(r.id), r]));
    for (const g of groups) {
      g.shotIds.sort((a, b) => Number(byId.get(a).global_no) - Number(byId.get(b).global_no));
      g.sortKey = Math.min(...g.shotIds.map((id) => Number(byId.get(id).global_no)));
    }
    groups.sort((a, b) => a.sortKey - b.sortKey);

    // ③ 逐段投影（idx 从 1 连续）
    let created = 0; let updated = 0; let unchanged = 0;
    const outUnits = [];
    const keepIds = new Set();
    const segmentWrites = [];

    groups.forEach((g, i) => {
      const idx = i + 1;
      const rows = g.shotIds.map((id) => byId.get(id));
      const fields = projectionFieldsOf({ chapterTitle: chapter.title, sceneUid, rows, idx, db, projectId: pid });
      const segmentId = g.segmentId || newSegmentId(pid, cid, sceneUid, idx);
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

      // ④ segment_id 回写：只在值真的不同的时候写（幂等 + 不刷无意义写入）
      for (const r of rows) {
        if (String(r.segment_id || '') === segmentId) continue;
        db.prepare('UPDATE story_shots SET segment_id = ?, updated_at = ? WHERE id = ?').run(segmentId, now(), r.id);
        segmentWrites.push({ story_shot_id: r.id, segment_id: segmentId });
      }

      outUnits.push({ segment_id: segmentId, idx, shot_ids: g.shotIds });
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
      const cand = db.prepare('SELECT COUNT(*) AS n FROM shot_videos WHERE shot_id = ?').get(sid);
      if (Number(cand?.n || 0) > 0) {
        // 候选与段的关联无法安全迁移 ⇒ 拒绝删除并报告（不得静默丢候选）
        blocked.push({ segment_id: sid, candidates: Number(cand.n) });
        continue;
      }
      // 专用删除路径：**不经过 Shots.remove**（那会级联删 shot_videos）
      db.prepare('DELETE FROM shots WHERE id = ?').run(sid);
      deleted.push(sid);
    }

    return {
      projectId: pid, chapterId: cid, sceneUid: String(sceneUid || ''),
      units: outUnits, created, updated, unchanged, deleted, blocked,
      segmentWrites,
    };
  });
}

/** 对外正式名（D02-40 §4.2/§4.6 用的是 `projectRenderUnits`）。 */
export const projectRenderUnits = projectSceneUnits;

// ── 内部 ───────────────────────────────────────────────────────────────────

function validateUnitsInput(units, shotRows) {
  if (!Array.isArray(units) || !units.length) {
    throw projError('UNITS_REQUIRED', 'units 必须是非空数组；省略该参数表示按既有 segment_id 自动分组');
  }
  const known = new Set(shotRows.map((r) => String(r.id)));
  const seen = new Set();
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
    for (const id of u.shot_ids) {
      const s = String(id);
      if (!known.has(s)) {
        throw projError('UNIT_SHOT_NOT_IN_SCOPE', `units[${i}] 引用的镜头不在本次投影范围：${s}`, { index: i, shot_id: s });
      }
      if (seen.has(s)) {
        throw projError('UNIT_SHOT_DUPLICATED', `镜头 ${s} 出现在多个段里（一镜只能属于一段）`, { shot_id: s });
      }
      seen.add(s);
    }
  }
}

function groupByExistingSegment(shotRows) {
  const groups = new Map();
  const singles = [];
  for (const r of shotRows) {
    const sid = String(r.segment_id || '');
    if (!sid) { singles.push({ segmentId: '', shotIds: [String(r.id)] }); continue; }
    if (!groups.has(sid)) groups.set(sid, { segmentId: sid, shotIds: [] });
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
