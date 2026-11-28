// 动作写入器（`shot_actions`）—— D02-06 §4.4 / A1~A5 审计矩阵 A5（D02-40 §6.2）
//
// 一句话模型：**一条动作 = 一行**，主键 `id`（不是复合键），项目经 `shot_id` 反查。
//
// 三条不许越界：
//   ① **不得把动作塞进站位或文本字段**。动作有 `t_from`/`t_to`/`tier`/`path_json` 等时间与轨迹语义，
//      塞进 `shot_blockings.current_task` 就只剩一句自然语言，投影与求解都拿不到结构。
//   ② **按行做 create/update/delete**。同一镜的动作行由 `id` 定位；调用方给 id = 改这一行，
//      不给 id = 新增一行。**不做"整组删除重建"** —— 重建会让每一轮都产生全量假日志。
//   ③ **`shot_id` 不可跨镜移动**。给 id 却指向别的镜，等于把动作搬走；这里当场拒。
//
// 归属：`shot_actions` 无 `project_id`，只能经 `story_shots` 反查（D02-40 §6.3）。
import { getDb, txProject, assertProjectLocked } from '../db.js';
import { recordChange, rawGet } from '../changelog.js';
import { uid } from '../utils.js';

export function shotActionError(code, message, detail = {}) {
  const e = new Error(message);
  e.code = code;
  e.detail = detail;
  return e;
}

const ACTION_COLUMNS = [
  'actor_id', 'action_type', 'is_primary', 'tier', 'init_state', 'trigger_json', 'path_json',
  'force_json', 'speed_json', 'power', 'cog', 'body_parts', 'contact_json', 'result_json',
  'follow_through', 'recovery', 'end_state', 'sync_json', 't_from', 't_to',
];
const JSON_COLUMNS = new Set([
  'init_state', 'trigger_json', 'path_json', 'force_json', 'speed_json', 'body_parts',
  'contact_json', 'result_json', 'end_state', 'sync_json',
]);

/**
 * 写入某镜的动作（**行级** upsert + delete）。
 * @param {string} shotId
 * @param {Array<object>} rows 有 `id` 的按 id 更新；无 `id` 的新建；本次未出现的既有行 = 删除
 * @returns {{shot_id:string, written:number, audit:{added:number,removed:number,changed:number}}}
 */
export function writeShotActions(shotId, rows) {
  if (!shotId) throw shotActionError('SHOT_REQUIRED', 'writeShotActions 必须指定 shotId');
  const list = Array.isArray(rows) ? rows : [];
  const shot = getDb().prepare('SELECT id, project_id FROM story_shots WHERE id = ?').get(shotId);
  if (!shot) throw shotActionError('SHOT_NOT_FOUND', `镜不存在：${shotId}`, { shot_id: shotId });
  const projectId = shot.project_id;

  // 纯校验：字段白名单 + 同一批 id 不得重复
  const seen = new Set();
  const normalized = list.map((raw, i) => {
    if (!raw || typeof raw !== 'object') throw shotActionError('ACTION_INVALID', `rows[${i}] 必须是对象`, { index: i });
    const id = String(raw.id ?? '').trim();
    if (id) {
      if (seen.has(id)) throw shotActionError('ACTION_DUPLICATED', `同一批里动作 id「${id}」出现多次`, { id });
      seen.add(id);
    }
    const out = { ...(id ? { id } : {}) };
    for (const [k, v] of Object.entries(raw)) {
      if (k === 'id' || k === 'shot_id') continue;
      if (!ACTION_COLUMNS.includes(k)) {
        throw shotActionError('ACTION_FIELD_INVALID', `动作不接受字段 ${k}`, { index: i, field: k });
      }
      out[k] = JSON_COLUMNS.has(k) && v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
    }
    return out;
  });

  return txProject(projectId, () => {
    assertProjectLocked(projectId);
    const db = getDb();
    // 锁内复核（同 shot-blockings）：镜在读锁前被删/换项目时，明确报错而不是靠审计反查兜底。
    const still = db.prepare('SELECT project_id FROM story_shots WHERE id = ?').get(shotId);
    if (!still) throw shotActionError('SHOT_NOT_FOUND', `镜在取锁前被删除：${shotId}`, { shot_id: shotId });
    if (String(still.project_id) !== String(projectId)) {
      throw shotActionError('SHOT_NOT_IN_PROJECT', `镜 ${shotId} 的项目在取锁前后发生变化`, {
        shot_id: shotId, expected: projectId, actual: still.project_id,
      });
    }
    const beforeRows = db.prepare('SELECT * FROM shot_actions WHERE shot_id = ? ORDER BY t_from ASC, id ASC').all(shotId);
    const beforeById = new Map(beforeRows.map((r) => [r.id, r]));
    const keep = new Set();

    let added = 0; let changed = 0; let removed = 0;

    for (const r of normalized) {
      if (r.id) {
        const b = beforeById.get(r.id);
        if (!b) throw shotActionError('ACTION_NOT_FOUND', `动作不存在：${r.id}`, { shot_id: shotId, id: r.id });
        // 跨镜移动必须拒：否则日志会记在"新镜"名下，回滚时还原到错的位置
        if (String(b.shot_id) !== String(shotId)) {
          throw shotActionError('ACTION_CROSS_SHOT', `动作 ${r.id} 属于镜 ${b.shot_id}，不得移动到 ${shotId}`, {
            shot_id: shotId, id: r.id, owner_shot: b.shot_id,
          });
        }
        keep.add(r.id);
        const cols = Object.keys(r).filter((c) => c !== 'id');
        if (!cols.length) continue;
        const sets = cols.map((c) => c + ' = ?');
        db.prepare(`UPDATE shot_actions SET ${sets.join(', ')} WHERE id = ?`).run(...cols.map((c) => r[c]), r.id);
        const after = rawGet('shot_action', r.id);
        const logId = recordChange({ entity: 'shot_action', action: 'update', before: b, after, entityId: r.id, meta: { origin: 'writeShotActions' } });
        // `recordChange` 对"只有易变列变化"返回 null；该表 VOLATILE 为空集，所以恒有日志
        if (logId) changed += 1;
        continue;
      }
      // 新建：id 由这里生成（不接受调用方伪造的 shot_id）
      const id = uid();
      const cols = ['id', 'shot_id', ...Object.keys(r)];
      const vals = [id, shotId, ...Object.values(r)];
      db.prepare(`INSERT INTO shot_actions (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
      const after = rawGet('shot_action', id);
      recordChange({ entity: 'shot_action', action: 'create', after, entityId: id, meta: { origin: 'writeShotActions' } });
      added += 1;
    }

    // 本次未出现的既有行 = 删除（行级，不整组重来）
    for (const b of beforeRows) {
      if (keep.has(b.id)) continue;
      db.prepare('DELETE FROM shot_actions WHERE id = ?').run(b.id);
      recordChange({ entity: 'shot_action', action: 'delete', before: b, entityId: b.id, meta: { origin: 'writeShotActions' } });
      removed += 1;
    }

    return { shot_id: shotId, written: normalized.length, audit: { added, removed, changed } };
  });
}

/** 读回（投影/求解只读用） */
export function listShotActions(shotId) {
  return getDb().prepare('SELECT * FROM shot_actions WHERE shot_id = ? ORDER BY t_from ASC, id ASC').all(shotId);
}
