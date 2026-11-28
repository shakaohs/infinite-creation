// 站位写入器（`shot_blockings`）—— D02-06 §4.3 / A1~A5 审计矩阵 A4（D02-40 §6.2）
//
// 一句话模型：**一个镜 + 一个角色 = 一条站位**，主键 `(shot_id, character_id)`。
//
// 三条不许越界：
//   ① **不得写回 legacy `shots.blocking` 文本**。那是"给提示词用的一句话站位"，不是结构化站位数据；
//      两边都写会出现两个权威，投影阶段只能二选一，谁也说不清哪个对。
//   ② **差集按 `(shot_id, character_id)` 算**。物理写入可以整组删了重建，但审计必须如实记
//      create/update/delete —— 按 SQL 条数记会把"只改了 facing"写成整组重来。
//   ③ **缺省字段不落默认值去覆盖**。调用方没给的列不出现在 UPDATE 里；只有新建行才吃 DDL 默认。
//
// 归属：`shot_blockings` 没有 `project_id`，项目只能经 `story_shots` 反查（D02-40 §6.3）。
// 反查不到 = 这行是孤儿 ⇒ A4 fail-closed（`recordChange` 抛 AUDIT_PROJECT_UNRESOLVED，整事务回滚）。
import { getDb, txProject, assertProjectLocked } from '../db.js';
import { recordChange, rawGet } from '../changelog.js';

export function shotBlockingError(code, message, detail = {}) {
  const e = new Error(message);
  e.code = code;
  e.detail = detail;
  return e;
}

/** 可写列（`shot_id` 由参数决定，`character_id` 是键的一部分） */
const BLOCKING_COLUMNS = [
  'position_abs', 'norm_x', 'norm_y', 'norm_z', 'norm_confidence', 'position_track',
  'anchor_object', 'behind_object', 'facing', 'gaze_target', 'posture', 'distance_to_camera',
  'occlusion', 'hand_state', 'current_task', 'in_frame', 'power_level', 'instance_anchor',
];
const JSON_COLUMNS = new Set(['position_track']);
const KEY_OF = (r) => String(r.character_id);

/** 同一镜内按 `character_id` 做差集（纯函数，不写库） */
export function diffShotBlockings(beforeRows, afterRows) {
  const before = new Map((beforeRows || []).map((r) => [KEY_OF(r), r]));
  const after = new Map((afterRows || []).map((r) => [KEY_OF(r), r]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [k, r] of after) if (!before.has(k)) added.push(r);
  for (const [k, r] of before) if (!after.has(k)) removed.push(r);
  for (const [k, r] of after) {
    const b = before.get(k);
    if (!b) continue;
    // 只比调用方**显式给出**的列：没给的列不该让它变成"有变化"
    if (Object.keys(r).some((col) => col !== 'shot_id' && col !== 'character_id' && String(b[col] ?? '') !== String(r[col] ?? ''))) {
      changed.push({ before: b, after: r });
    }
  }
  return { added, removed, changed };
}

/**
 * 写入某镜的站位（整组替换语义：本镜没出现的角色 = 删除）。
 * @param {string} shotId
 * @param {Array<object>} rows 每行至少含 `character_id`
 * @returns {{shot_id:string, written:number, audit:{added:number,removed:number,changed:number}}}
 */
export function writeShotBlockings(shotId, rows) {
  if (!shotId) throw shotBlockingError('SHOT_REQUIRED', 'writeShotBlockings 必须指定 shotId');
  const list = Array.isArray(rows) ? rows : [];
  const shot = getDb().prepare('SELECT id, project_id FROM story_shots WHERE id = ?').get(shotId);
  if (!shot) throw shotBlockingError('SHOT_NOT_FOUND', `镜不存在：${shotId}`, { shot_id: shotId });
  const projectId = shot.project_id;

  // 先做纯校验（键必填、未知列当场拒），避免写到一半才发现第 3 行缺 character_id
  const seen = new Set();
  const normalized = list.map((raw, i) => {
    if (!raw || typeof raw !== 'object') throw shotBlockingError('BLOCKING_INVALID', `rows[${i}] 必须是对象`, { index: i });
    const characterId = String(raw.character_id ?? '').trim();
    if (!characterId) throw shotBlockingError('CHARACTER_REQUIRED', `rows[${i}] 缺少 character_id`, { index: i });
    if (seen.has(characterId)) {
      throw shotBlockingError('BLOCKING_DUPLICATED', `同一镜里 character_id「${characterId}」出现多次`, { character_id: characterId });
    }
    seen.add(characterId);
    const out = { shot_id: shotId, character_id: characterId };
    for (const [k, v] of Object.entries(raw)) {
      if (k === 'shot_id' || k === 'character_id') continue;
      if (!BLOCKING_COLUMNS.includes(k)) {
        throw shotBlockingError('BLOCKING_FIELD_INVALID', `站位不接受字段 ${k}`, { index: i, field: k });
      }
      out[k] = JSON_COLUMNS.has(k) && v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
    }
    return out;
  });

  return txProject(projectId, () => {
    assertProjectLocked(projectId);
    const db = getDb();
    // 锁内复核：`shot` 是在取锁**之前**读的（projectId 只能这么拿）。中间若镜被删，
    // 拿锁后再写就变成给一个不存在的镜挂站位 —— 后面 recordChange 会因归属反查失败抛错，
    // 但那已经是"靠审计兜底"。这里先明确报 SHOT_NOT_FOUND，错误指向真实原因。
    const still = db.prepare('SELECT project_id FROM story_shots WHERE id = ?').get(shotId);
    if (!still) throw shotBlockingError('SHOT_NOT_FOUND', `镜在取锁前被删除：${shotId}`, { shot_id: shotId });
    if (String(still.project_id) !== String(projectId)) {
      throw shotBlockingError('SHOT_NOT_IN_PROJECT', `镜 ${shotId} 的项目在取锁前后发生变化`, {
        shot_id: shotId, expected: projectId, actual: still.project_id,
      });
    }
    const beforeRows = db.prepare('SELECT * FROM shot_blockings WHERE shot_id = ? ORDER BY character_id ASC').all(shotId);
    const diff = diffShotBlockings(beforeRows, normalized);

    // 物理写入：整组替换（与 shot_assets 同策略，差别只在键）。
    // 逐行拼列：没给的列不进 INSERT，才能让 DDL 默认值（norm_confidence=0、in_frame=1…）生效 ——
    // 统一填 null 会把默认值覆盖成空，下游按 0/1 判读时立刻错。
    db.prepare('DELETE FROM shot_blockings WHERE shot_id = ?').run(shotId);
    for (const r of normalized) {
      const use = Object.keys(r).filter((c) => r[c] !== undefined);
      getDb().prepare(`INSERT INTO shot_blockings (${use.join(',')}) VALUES (${use.map(() => '?').join(',')})`)
        .run(...use.map((c) => r[c]));
    }

    for (const r of diff.removed) {
      recordChange({ entity: 'shot_blocking', action: 'delete', before: r, entityId: key(r), meta: { origin: 'writeShotBlockings' } });
    }
    for (const r of diff.added) {
      recordChange({ entity: 'shot_blocking', action: 'create', after: rawGet('shot_blocking', [shotId, r.character_id]) || r, entityId: key(r), meta: { origin: 'writeShotBlockings' } });
    }
    for (const c of diff.changed) {
      recordChange({ entity: 'shot_blocking', action: 'update', before: c.before, after: rawGet('shot_blocking', [shotId, c.after.character_id]) || c.after, entityId: key(c.after), meta: { origin: 'writeShotBlockings' } });
    }

    return { shot_id: shotId, written: normalized.length, audit: { added: diff.added.length, removed: diff.removed.length, changed: diff.changed.length } };
  });
}

/** 读回（投影/求解只读用）：按 character_id 排序，JSON 列解析回对象 */
export function listShotBlockings(shotId) {
  return getDb().prepare('SELECT * FROM shot_blockings WHERE shot_id = ? ORDER BY character_id ASC').all(shotId).map((r) => ({
    ...r,
    position_track: JSON.parse(r.position_track || '[]'),
  }));
}

/** 复合主键的 entity_id（与 changelog 同一编码：JSON 数组串） */
function key(r) {
  return JSON.stringify([String(r.shot_id ?? ''), String(r.character_id ?? '')]);
}
