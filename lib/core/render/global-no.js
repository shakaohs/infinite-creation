// 镜号分配与两阶段重编（D02-06 V7 §4.4.1 / A-03.1 / V3-B-01 / V3-B-06）
//
// 一句话模型：**号是位置，镜是身份**。
//   `shot_no`   = 章内序号，1..n 连续（给 shotRange、人工沟通用）
//   `global_no` = 项目内全局序号，唯一且**随权威序严格递增**，允许不连续（给求解、增量、API 排序用）
//
// 三条不许越界：
//   ① **权威序只有一个来源**：`chapters.seq ASC, chapters.id ASC` + `shot_no ASC, story_shots.id ASC`。
//      不得用数据库自然返回顺序，也不得按 `prev_shot_id`（那是提示，不是顺序）。
//   ② **纯追加与改变顺序必须分开**。`MAX+1` 只表达"最后来的"，不表达"排在哪"；往中间插镜用它，
//      号与真实顺序就解耦，求解按 `global_no` 排序会把插入镜排到最后，`state_in` 静默继承错人。
//   ③ **负号只是事务内的中间态**（`uq_ss_sn` / `uq_ss_gn` 是即时检查，不腾空旧值就撞索引），
//      绝不能越过事务边界；`assertGlobalOrder` 是兜底，不只依赖唯一索引。
//
// 本模块只做"号"与"落行"，不写动作/站位/状态，也不是权限边界（权限在工具层）。
import { getDb, tx } from '../db.js';
import { uid, now } from '../utils.js';

/** 带错误码的业务错误（与 tools.js / 路由的 `e.code` 约定一致） */
export function globalOrderError(code, message, detail = {}) {
  const e = new Error(message);
  e.code = code;
  e.detail = detail;
  return e;
}

/** 两个号共用同一份两阶段原语（R-2：同一事务内先做完一个字段，再做另一个） */
export const NUMBER_FIELDS = ['shot_no', 'global_no'];

// ── 调用计数（N-T3 用：证明纯追加没有偷偷走全项目重编）──────────────────────
// 真实调用一次就 +1；测试用 `renumberCallCount()` 前后对比。这不是 mock 框架，
// 而是把"是否调用了两阶段重编"变成可观测事实——结果正确并不等于路径正确。
let renumberCalls = 0;
export function renumberCallCount() { return renumberCalls; }
export function resetRenumberCallCount() { renumberCalls = 0; }

/** 章序（唯一权威来源；`seq` 允许同值，必须带 `id` 作稳定次序） */
export function chapterOrder(projectId) {
  return getDb()
    .prepare('SELECT id, seq, title FROM chapters WHERE project_id = ? ORDER BY seq ASC, id ASC')
    .all(projectId);
}

/**
 * 按权威序读回全部镜（`assertGlobalOrder` 与"受影响区间"计算都用这一份）。
 * 注意 `ORDER BY` 与 §4.4.1.1 逐字一致：章 `seq` → 章 `id` → `shot_no` → 镜 `id`。
 */
export function listAuthoritativeShots(projectId) {
  return getDb().prepare(`
    SELECT s.id, s.project_id, s.chapter_id, s.scene_key, s.scene_id, s.shot_no, s.global_no,
           s.visual_content, s.story_duration,
           c.seq AS chapter_seq, c.title AS chapter_title
      FROM story_shots s
      JOIN chapters c ON c.id = s.chapter_id
     WHERE s.project_id = ?
     ORDER BY c.seq ASC, c.id ASC, s.shot_no ASC, s.id ASC
  `).all(projectId);
}

function assertProjectId(projectId) {
  if (!projectId || typeof projectId !== 'string') {
    throw globalOrderError('PROJECT_REQUIRED', '镜号操作必须指定 projectId');
  }
}

/** 某章当前最大 `shot_no`（无镜返回 0） */
export function maxShotNo(projectId, chapterId) {
  const r = getDb()
    .prepare('SELECT MAX(shot_no) AS m FROM story_shots WHERE project_id = ? AND chapter_id = ?')
    .get(projectId, chapterId);
  return Number(r?.m ?? 0) || 0;
}

/**
 * 纯追加的下一个 `global_no`（`COALESCE(MAX,0)+1`）。
 * **必须在写入的同一事务内调用**——事务外取号会让并发写拿到同一个号。
 */
export function nextAppendGlobalNo(projectId) {
  const r = getDb().prepare('SELECT COALESCE(MAX(global_no), 0) AS m FROM story_shots WHERE project_id = ?').get(projectId);
  return (Number(r?.m ?? 0) || 0) + 1;
}

/**
 * 纯追加判定（§4.4.1.2）：三个条件全部满足才算纯追加。
 *  ① 目标章是权威序的最后一章；② 新镜 `shot_no` 全部大于该章现有最大号；③ 该章没有"未提交的镜"（由调用方保证）
 * 返回 `{ pure, reason }`：`pure=false` 时调用方必须走"目标序 + 两阶段重编"。
 */
export function isPureAppend(projectId, chapterId, shotNos) {
  assertProjectId(projectId);
  const chapters = chapterOrder(projectId);
  if (!chapters.length) return { pure: false, reason: 'NO_CHAPTER' };
  if (chapters[chapters.length - 1].id !== chapterId) {
    return { pure: false, reason: 'NOT_LAST_CHAPTER', last_chapter: chapters[chapters.length - 1].id };
  }
  const nums = (Array.isArray(shotNos) ? shotNos : []).map((n) => Number(n));
  if (!nums.length || nums.some((n) => !Number.isInteger(n) || n < 1)) {
    return { pure: false, reason: 'BAD_SHOT_NO' };
  }
  const max = maxShotNo(projectId, chapterId);
  if (!(Math.min(...nums) > max)) return { pure: false, reason: 'NOT_TAIL', max_existing: max };
  return { pure: true, reason: 'TAIL_APPEND', max_existing: max };
}

/** 同章内 `shot_no` 重复 → `SHOT_NO_DUPLICATED`（章级 C3：重复让目标序不可判定，整批拒写） */
export function assertNoDuplicateShotNos(shotNos, detail = {}) {
  const seen = new Set();
  const dup = new Set();
  for (const n of shotNos) {
    const v = Number(n);
    if (seen.has(v)) dup.add(v);
    seen.add(v);
  }
  if (dup.size) {
    throw Object.assign(
      globalOrderError('SHOT_NO_DUPLICATED', `同章内 shot_no 重复：${[...dup].join(', ')}（该章整批拒写）`, {
        ...detail, duplicates: [...dup].sort((a, b) => a - b),
      }),
      { level: 'fail', scope: 'chapter' },
    );
  }
}

/**
 * 章级提交完整性（§4.4.1.4 / CI-1~CI-6）。
 *
 * `submitted` 形如 `[{ shot_no, id? }]`：`id` 可省略；给了 `id` 才能识别"调换/挪位"。
 * 返回 `{ mode: 'append'|'full'|'in_place', missing }`；不合法直接抛 C3 错误（四要素见 CI-4）。
 *
 * 判据（故意不引入"插入锚点"参数，就不用猜）：
 *  · 有新增镜且不是尾部纯追加 → 必须提交本章全部镜 → 否则 `CHAPTER_SUBMIT_INCOMPLETE`
 *  · 提交里某个已有 `id` 的 `shot_no` 变了（调换/挪位）且未提交全部 → 同上
 *  · 只做就地更新（号没变、也没新增）→ 允许部分提交
 */
export function assertChapterSubmitComplete({ projectId, chapterId, submitted }) {
  assertProjectId(projectId);
  const list = Array.isArray(submitted) ? submitted : [];
  assertNoDuplicateShotNos(list.map((s) => s?.shot_no), { chapter_id: chapterId });

  const db = getDb();
  const chapter = db.prepare('SELECT id, title FROM chapters WHERE id = ? AND project_id = ?').get(chapterId, projectId);
  if (!chapter) {
    throw Object.assign(
      globalOrderError('CHAPTER_NOT_FOUND', `章节不存在或不属于本项目：${chapterId}`, { chapter_id: chapterId }),
      { level: 'fail', scope: 'chapter' },
    );
  }
  const existing = db.prepare('SELECT id, shot_no FROM story_shots WHERE chapter_id = ? ORDER BY shot_no ASC').all(chapterId);
  const existNos = new Set(existing.map((r) => Number(r.shot_no)));
  const submittedNos = new Set(list.map((s) => Number(s?.shot_no)));
  const missing = existing.filter((r) => !submittedNos.has(Number(r.shot_no))).map((r) => Number(r.shot_no));
  const added = [...submittedNos].filter((n) => !existNos.has(n));
  const maxExisting = existing.length ? Math.max(...existing.map((r) => Number(r.shot_no))) : 0;
  const tailAppend = added.length > 0 && missing.length === 0 && added.every((n) => n > maxExisting);

  let reorder = false;
  if (!added.length) {
    const byId = new Map(existing.map((r) => [r.id, Number(r.shot_no)]));
    for (const s of list) {
      if (!s || !s.id || !byId.has(s.id)) continue;
      if (byId.get(s.id) !== Number(s.shot_no)) { reorder = true; break; }
    }
  }

  if (!tailAppend && (added.length > 0 || reorder) && missing.length > 0) {
    // CI-4：结构化四要素（章节标识 / 错误字段 / 预期 / 实际），不得只给一句文案
    const err = globalOrderError(
      'CHAPTER_SUBMIT_INCOMPLETE',
      `本章还有 ${missing.length} 镜未提交（shot_no ${missing.join(', ')}）：中间插入/调换必须整章提交，序号由程序按目标序重排`,
      {
        chapter_id: chapterId,
        field: 'shots[]',
        expected: `本章 ${existing.length} 镜全部提交（目标序可判定）`,
        actual: `提交 ${list.length} 镜，缺 shot_no [${missing.join(',')}]`,
        missing_shots: missing,
        added_shots: added,
      },
    );
    err.level = 'fail';
    err.scope = 'chapter';
    throw err;
  }

  return { mode: tailAppend ? 'append' : (added.length > 0 || reorder ? 'full' : 'in_place'), missing };
}

// 允许 `insertStoryShot` 写入的列（其余走 DDL 默认值；`voice_ids` 故意不在表内 —— AS-9 只能由程序派生）
const INSERT_COLUMNS = [
  'scene_id', 'beat_key', 'prev_shot_id', 'purpose', 'dramatic_value', 'info_delta', 'dialogue_function',
  'is_insert', 'visual_content', 'composition', 'lighting', 'shot_size', 'dialogue', 'speakers',
  'narration', 'sfx', 'music_cue', 'story_duration', 'time_slices', 'is_cut_point', 'spec_source',
];
const JSON_COLUMNS = new Set(['speakers', 'time_slices']);

/**
 * 低层单行插入（不做排序判定、不重编）：号由调用方按 §4.4.1.2 决定。
 * `voice_ids` 不接受（AS-9：派生列只能由 `writeShotAssets` 回填）。
 */
export function insertStoryShot(fields = {}) {
  const projectId = fields.project_id;
  const chapterId = fields.chapter_id;
  const sceneKey = String(fields.scene_key ?? '').trim();
  const shotNo = Number(fields.shot_no);
  const globalNo = Number(fields.global_no);
  assertProjectId(projectId);
  if (!chapterId) throw globalOrderError('CHAPTER_REQUIRED', '写入镜必须指定 chapter_id');
  if (!sceneKey) throw globalOrderError('SCENE_KEY_REQUIRED', '写入镜必须指定 scene_key（§4.4 必填）');
  if (!Number.isInteger(shotNo) || shotNo < 1) throw globalOrderError('SHOT_NO_INVALID', `shot_no 必须是 ≥1 的整数：${fields.shot_no}`);
  if (!Number.isInteger(globalNo) || globalNo < 1) throw globalOrderError('GLOBAL_NO_INVALID', `global_no 必须是 ≥1 的整数：${fields.global_no}`);

  const id = fields.id || uid();
  const t = now();
  const cols = ['id', 'project_id', 'chapter_id', 'scene_key', 'shot_no', 'global_no', 'created_at', 'updated_at'];
  const vals = [id, projectId, chapterId, sceneKey, shotNo, globalNo, t, t];
  for (const c of INSERT_COLUMNS) {
    const v = fields[c];
    if (v === undefined) continue;
    cols.push(c);
    vals.push(JSON_COLUMNS.has(c) && v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
  }
  getDb().prepare(`INSERT INTO story_shots (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
  return { id, project_id: projectId, chapter_id: chapterId, scene_key: sceneKey, shot_no: shotNo, global_no: globalNo };
}

/**
 * 两阶段重编原语（`shot_no` 与 `global_no` 共用同一份）。
 *
 * @param {'shot_no'|'global_no'} field 要重编的列（不能一条语句同时改两列：唯一索引是即时检查）
 * @param {Array<{id:string,value:number}>} rows 区间内每一行的**最终值**，顺序即目标序
 * @param {{onPhase?:(phase:number, field:string)=>void}} [opts] `onPhase` 仅供测试注入故障（模拟"第二步失败"）
 * @returns {number} 重编行数
 *
 * 步骤：① 区间内该列全部写负值 `-(i+1)`（腾空旧值，避免撞 `uq_ss_*`）→ ② 再写最终正值。
 * 两步在**同一事务**内；本函数自己开 `tx`，被外层 `tx` 包住时自动复用（`tx` 支持嵌套复用）。
 */
export function renumberTwoPhase(field, rows, opts = {}) {
  if (!NUMBER_FIELDS.includes(field)) {
    throw globalOrderError('RENUMBER_BAD_FIELD', `只支持重编 ${NUMBER_FIELDS.join(' / ')}，收到 ${field}`);
  }
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return 0;
  // 先整体校验，避免"写到一半才发现参数不对"（真正的半途失败由故障注入覆盖）
  const seen = new Set();
  for (const r of list) {
    if (!r || !r.id) throw globalOrderError('RENUMBER_BAD_ROW', `${field} 重编需要每行都有 id`);
    if (seen.has(r.id)) throw globalOrderError('RENUMBER_BAD_ROW', `${field} 重编出现重复 id：${r.id}`);
    seen.add(r.id);
    if (!Number.isInteger(r.value) || r.value < 1) {
      throw globalOrderError('RENUMBER_BAD_VALUE', `${field} 的最终值必须是 ≥1 的整数：${r.value}（id=${r.id}）`);
    }
  }

  const db = getDb();
  const sql = `UPDATE story_shots SET ${field} = ? WHERE id = ?`;
  const upd = db.prepare(sql);

  return tx(() => {
    renumberCalls += 1;
    // ① 负值：只为腾空旧值，绝不允许提交到库
    list.forEach((r, i) => {
      const changes = upd.run(-(i + 1), r.id).changes;
      if (changes !== 1) throw globalOrderError('GLOBAL_ORDER_BROKEN', `${field} 重编找不到镜 ${r.id}（影响 ${changes} 行）`);
    });
    if (opts.onPhase) opts.onPhase(1, field);
    // ② 最终正值
    for (const r of list) {
      const changes = upd.run(r.value, r.id).changes;
      if (changes !== 1) throw globalOrderError('GLOBAL_ORDER_BROKEN', `${field} 重编找不到镜 ${r.id}（影响 ${changes} 行）`);
    }
    if (opts.onPhase) opts.onPhase(2, field);
    return list.length;
  });
}

/**
 * 按"完整目标序"重编（改变顺序的唯一入口）。
 *
 * @param {string} projectId
 * @param {string[]} orderedIds 项目内**全部**镜的目标顺序（必须与当前 id 集合完全一致）
 * @param {{onPhase?:(phase:number, field:string)=>void}} [opts] 仅供测试注入故障
 * @returns {{changed:boolean, shot_no_rows:number, global_no_rows:number, first_changed_index:number}}
 *
 * 区间（§4.4.1.3）：
 *  · `shot_no`：只要某章有任何一镜的号变了，就重编**该章全部镜**（章内必须 1..n）
 *  · `global_no`：从"目标序中排名变化的第一镜"到项目最后一镜；前置镜一个不动
 */
export function applyTargetOrder(projectId, orderedIds, opts = {}) {
  assertProjectId(projectId);
  const rows = listAuthoritativeShots(projectId);
  const currentIds = rows.map((r) => r.id);
  const target = Array.isArray(orderedIds) ? orderedIds.map(String) : [];

  if (target.length !== currentIds.length) {
    throw globalOrderError('TARGET_ORDER_INVALID', `目标序必须覆盖项目全部镜：给了 ${target.length} 个，库里有 ${currentIds.length} 个`);
  }
  const known = new Set(currentIds);
  const seen = new Set();
  for (const id of target) {
    if (!known.has(id)) throw globalOrderError('TARGET_ORDER_INVALID', `目标序里出现不属于本项目的镜：${id}`);
    if (seen.has(id)) throw globalOrderError('TARGET_ORDER_INVALID', `目标序里同一个镜出现两次：${id}`);
    seen.add(id);
  }
  if (!currentIds.length) return { changed: false, shot_no_rows: 0, global_no_rows: 0, first_changed_index: -1 };

  const byId = new Map(rows.map((r) => [r.id, r]));

  // ① 目标 shot_no：章内位置（1..n）
  const perChapter = new Map();
  const shotNoPlan = new Map();
  for (const id of target) {
    const row = byId.get(id);
    const n = (perChapter.get(row.chapter_id) || 0) + 1;
    perChapter.set(row.chapter_id, n);
    shotNoPlan.set(id, n);
  }

  // ② 第一个排名变化的镜
  let k = -1;
  for (let i = 0; i < target.length; i += 1) {
    if (target[i] !== currentIds[i]) { k = i; break; }
  }

  // 受影响区间
  const dirtyChapters = new Set();
  for (const id of target) {
    const row = byId.get(id);
    if (Number(row.shot_no) !== shotNoPlan.get(id)) dirtyChapters.add(row.chapter_id);
  }
  const shotNoRows = target
    .filter((id) => dirtyChapters.has(byId.get(id).chapter_id))
    .map((id) => ({ id, value: shotNoPlan.get(id) }));

  const globalNoRows = [];
  if (k >= 0) {
    const base = k > 0 ? Number(byId.get(target[k - 1]).global_no) : 0;
    for (let i = k; i < target.length; i += 1) globalNoRows.push({ id: target[i], value: base + (i - k) + 1 });
  }

  if (!shotNoRows.length && !globalNoRows.length) {
    // 恒等操作（N-T4：同一请求重放两次不漂移）——仍然自检一次，但不写库
    assertGlobalOrder(projectId);
    return { changed: false, shot_no_rows: 0, global_no_rows: 0, first_changed_index: -1 };
  }

  // R-2：两个字段的重编属于同一事务（任一异常整体回滚，不留负号）
  tx(() => {
    if (shotNoRows.length) renumberTwoPhase('shot_no', shotNoRows, opts);
    if (globalNoRows.length) renumberTwoPhase('global_no', globalNoRows, opts);
    assertGlobalOrder(projectId);
  });

  return {
    changed: true,
    shot_no_rows: shotNoRows.length,
    global_no_rows: globalNoRows.length,
    first_changed_index: k,
    chapters_renumbered: [...dirtyChapters],
  };
}

/**
 * 尾部纯追加（不调用 `renumberTwoPhase`）。
 * 三个条件由 `isPureAppend` 判定；不满足直接拒绝，调用方应改走 `applyTargetOrder`。
 * `global_no` 在同一事务内按 `COALESCE(MAX,0)+1` 递增。
 */
export function appendStoryShots({ projectId, chapterId, shots = [], fields = {} }) {
  assertProjectId(projectId);
  const list = Array.isArray(shots) ? shots : [];
  if (!list.length) return { created: 0, ids: [], global_nos: [] };
  const shotNos = list.map((s) => Number(s.shot_no));
  assertNoDuplicateShotNos(shotNos, { chapter_id: chapterId });
  const plan = isPureAppend(projectId, chapterId, shotNos);
  if (!plan.pure) {
    throw globalOrderError('NOT_PURE_APPEND', `不满足纯追加条件（${plan.reason}），必须按目标序做两阶段重编`, {
      reason: plan.reason, detail: plan, chapter_id: chapterId,
    });
  }

  return tx(() => {
    let g = nextAppendGlobalNo(projectId);
    const ids = [];
    const globalNos = [];
    for (const s of list) {
      const row = insertStoryShot({
        ...fields, ...s, project_id: projectId, chapter_id: chapterId,
        scene_key: s.scene_key ?? fields.scene_key,
        shot_no: Number(s.shot_no),
        global_no: g,
      });
      ids.push(row.id);
      globalNos.push(g);
      g += 1;
    }
    // 必须断言：写入后它确实是权威序的最后一镜（§4.4.1.2 表格末列）
    assertAppendedLast(projectId, ids);
    return { created: ids.length, ids, global_nos: globalNos };
  });
}

/** 追加后校验："新增的这 N 镜恰好在权威序末尾，且顺序与传入一致" */
export function assertAppendedLast(projectId, ids) {
  const list = Array.isArray(ids) ? ids : [];
  if (!list.length) return true;
  const rows = listAuthoritativeShots(projectId);
  const tail = rows.slice(-list.length).map((r) => r.id);
  if (tail.length !== list.length || tail.some((id, i) => id !== list[i])) {
    throw globalOrderError('GLOBAL_ORDER_BROKEN', '追加后的镜并不在权威序末尾（号与真实顺序不一致）', { expected_tail: list, actual_tail: tail });
  }
  return true;
}

/**
 * 编号自检（N-6 / N-7）：**按权威序读回**，检查① 章内 `shot_no` 恰为 1..n；② `global_no` 严格递增；
 * ③ 无负值/非正整数；④ 无重复。任一不满足抛 `GLOBAL_ORDER_BROKEN`，由调用方事务整体回滚。
 *
 * 故意不只看唯一索引：索引只能证明"没重号"，证明不了"号与目标序一致"——后者才是 V3-B-06 的漏洞。
 */
export function assertGlobalOrder(projectId) {
  assertProjectId(projectId);
  const rows = listAuthoritativeShots(projectId);
  for (const r of rows) {
    if (!Number.isInteger(r.shot_no) || r.shot_no < 1) {
      throw globalOrderError('GLOBAL_ORDER_BROKEN', `shot_no 非法（负数/空值/非整数）：${r.shot_no}`, { shot_id: r.id, chapter_id: r.chapter_id, field: 'shot_no' });
    }
    if (!Number.isInteger(r.global_no) || r.global_no < 1) {
      throw globalOrderError('GLOBAL_ORDER_BROKEN', `global_no 非法（负数/空值/非整数）：${r.global_no}`, { shot_id: r.id, field: 'global_no' });
    }
  }
  // 章内 1..n（rows 已按章 + shot_no 排序，重复号会让 list[i].shot_no !== i+1）
  const byChapter = new Map();
  for (const r of rows) {
    if (!byChapter.has(r.chapter_id)) byChapter.set(r.chapter_id, []);
    byChapter.get(r.chapter_id).push(r);
  }
  for (const [chapterId, list] of byChapter) {
    list.forEach((r, i) => {
      if (r.shot_no !== i + 1) {
        throw globalOrderError('GLOBAL_ORDER_BROKEN', `章 ${chapterId} 的 shot_no 不是 1..n 连续（第 ${i + 1} 位是 ${r.shot_no}）`, {
          chapter_id: chapterId, index: i + 1, shot_no: r.shot_no, shot_id: r.id,
        });
      }
    });
  }
  // 项目内 global_no 严格递增（同时排除重复）
  for (let i = 1; i < rows.length; i += 1) {
    if (!(rows[i].global_no > rows[i - 1].global_no)) {
      throw globalOrderError('GLOBAL_ORDER_BROKEN', `global_no 未严格递增：${rows[i - 1].global_no} → ${rows[i].global_no}`, {
        prev: { shot_id: rows[i - 1].id, global_no: rows[i - 1].global_no },
        next: { shot_id: rows[i].id, global_no: rows[i].global_no },
      });
    }
  }
  return { shots: rows.length, chapters: byChapter.size };
}
