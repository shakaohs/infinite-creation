// P9-A：连续性求解结果 → `shot_states`（D02-21 §三）
//
// 三件事，且只有这三件：
//  ① 把求解器输出的 `{in, out, meta, derived_from, conflicts}` 映射成 **DDL 里那 8 列**；
//  ② 用**内容 Hash** 判断"要不要写"——重复求解同一输入时不得刷 `updated_at`，
//     否则"这一轮到底重算过没有"就再也看不出来（幂等不是"不报错"，是"不产生新事实"）；
//  ③ 整场重建时，把已不在场次里的旧行删掉，避免删除镜头后残留一条状态让下游以为它还活着。
//
// 字段语义只认 DDL 与 D01-04 §5.1，**不按字段名推断**：
//  · `state_in` / `state_out`：首/尾状态（求解器的 `in` / `out`）；
//  · `meta`：字段级可靠性，**只落 `metaOut`**（求解器另有 `meta_in`，但表里没有这一列，
//    详见 D02-21 §十一 U-P9-2，不得自行加列）；
//  · `derived_from`：`scene_baseline` 或 `prev_shot:<id>`，原样落库；
//  · `state_source`：本轮只有 `solved`（`manual` 需要人工标注持久化，P8-A 未授权 DDL）；
//  · `conflicts`：求解器单镜 `conflicts`（数组）；`diagnostics` **不落库**（表里没有列）。
//
// `carried` 的可追溯性完全靠 `meta` 里的 `{rel, src:'carried:<起点镜>', conf}` 三个键 ——
// 它们必须原样进 JSON，任何"归一化"都会把继承链起点抹掉（那是 P8 反复堵的假失效来源）。
import { createHash } from 'node:crypto';
import { getDb, tx } from '../db.js';
import { canonicalStringify } from '../hash/canonical-stringify.js';
import { solveError } from './solver-error.js';

/** `shot_states.state_source` 本轮唯一取值（`manual` 需人工标注持久化，P8-A 未授权） */
export const STATE_SOURCE_SOLVED = 'solved';

/** 参与"内容是否变化"比较的列（`updated_at` 刻意不在内：它是写入时间，不是内容） */
export const STATE_PAYLOAD_COLUMNS = Object.freeze([
  'state_in', 'state_out', 'meta', 'derived_from', 'state_source', 'conflicts',
]);

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function stateError(message, extra = {}) {
  return solveError(message, { reason: 'STATE_PERSIST_INVALID', ...extra });
}

function requireObject(v, field, shotId) {
  if (v === null || v === undefined) return {};
  if (!isPlainObject(v)) {
    throw stateError(`shot_states.${field} 必须是对象（镜头 ${shotId}，实际 ${Array.isArray(v) ? 'array' : typeof v}）`, { shotId, field });
  }
  return v;
}

function requireArray(v, field, shotId) {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) {
    throw stateError(`shot_states.${field} 必须是数组（镜头 ${shotId}，实际 ${typeof v}）`, { shotId, field });
  }
  return v;
}

/**
 * 求解器单镜结果 → `shot_states` 行（8 列，JSON 列已序列化）。
 *
 * 不接受缺 `id` 的结果：一行状态写错镜头，比少写一行严重得多 —— 前者会让别的镜"继承"
 * 到它从未有过的状态，而且看起来完全正常。
 *
 * @param {object} state 求解器 `states[shotId]`
 * @param {{shotId?:string, updatedAt?:number}} o
 * @returns {{shot_id:string, state_in:string, state_out:string, meta:string,
 *            derived_from:string, state_source:string, conflicts:string, updated_at:number}}
 */
export function toShotStateRow(state, { shotId, updatedAt } = {}) {
  if (!isPlainObject(state)) throw stateError('toShotStateRow：state 必须是对象', { shotId });
  const id = String(shotId ?? state.id ?? '');
  if (!id) throw stateError('toShotStateRow：缺少镜头 id（不得写出一行不知道属于谁的状态）');

  const stateIn = requireObject(state.in, 'state_in', id);
  const stateOut = requireObject(state.out, 'state_out', id);
  const meta = requireObject(state.meta, 'meta', id);
  const conflicts = requireArray(state.conflicts, 'conflicts', id);
  const derivedFrom = state.derived_from === null || state.derived_from === undefined ? '' : String(state.derived_from);

  return {
    shot_id: id,
    state_in: JSON.stringify(stateIn),
    state_out: JSON.stringify(stateOut),
    meta: JSON.stringify(meta),
    derived_from: derivedFrom,
    state_source: STATE_SOURCE_SOLVED,
    conflicts: JSON.stringify(conflicts),
    updated_at: Number(updatedAt ?? Date.now()),
  };
}

/** 内容 Hash：只覆盖 6 个内容列；先解析再规范化序列化，键序不同不算变化 */
export function stateContentHash(row) {
  const parse = (v, fallback) => {
    if (v === null || v === undefined) return fallback;
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch { return v; }
  };
  const payload = {
    state_in: parse(row.state_in, {}),
    state_out: parse(row.state_out, {}),
    meta: parse(row.meta, {}),
    derived_from: row.derived_from ?? '',
    state_source: row.state_source ?? '',
    conflicts: parse(row.conflicts, []),
  };
  return 'sha256:' + createHash('sha256').update(canonicalStringify(payload), 'utf8').digest('hex');
}

/**
 * 把一个场次的求解结果写入 `shot_states`。
 *
 * 调用方负责事务边界（本函数内部也走 `tx()`，嵌套时直接并入外层 —— `db.tx` 的 `txDepth` 语义）。
 * 这样"状态 + 报告"可以同属一个事务：任一步失败整体回滚，不留半套。
 *
 * @param {{projectId:string, sceneKey:string, states:object, updatedAt?:number}} p
 * @returns {{written:Array<{shot_id:string, action:'inserted'|'updated', content_hash:string}>,
 *            unchanged:string[], deleted:string[]}}
 */
export function persistSceneStates({ projectId, sceneKey, states, updatedAt } = {}) {
  if (!projectId) throw stateError('persistSceneStates：缺少 projectId');
  const key = String(sceneKey ?? '').trim();
  if (!key) throw stateError('persistSceneStates：缺少 sceneKey（一次只写一场）');
  if (!isPlainObject(states)) throw stateError('persistSceneStates：states 必须是对象（shotId → 状态）');

  return tx(() => {
    const db = getDb();
    const existing = new Map(
      db.prepare(
        'SELECT * FROM shot_states WHERE shot_id IN'
        + ' (SELECT id FROM story_shots WHERE project_id = ? AND scene_key = ?)',
      ).all(projectId, key).map((r) => [String(r.shot_id), r]),
    );

    const written = [];
    const unchanged = [];
    for (const shotId of Object.keys(states).sort()) {
      const row = toShotStateRow(states[shotId], { shotId, updatedAt });
      const prev = existing.get(shotId);
      const contentHash = stateContentHash(row);
      if (prev && stateContentHash(prev) === contentHash) {
        unchanged.push(shotId);
        continue;
      }
      // 明确 UPDATE 而不是 `INSERT OR REPLACE`：后者会先删后插，把主键当成"整行替换"，
      // 将来任何外键/触发器都会在这条路上出问题；同时 `OR REPLACE` 无法表达"没变就不写"。
      db.prepare(
        'INSERT INTO shot_states (shot_id, state_in, state_out, meta, derived_from, state_source, conflicts, updated_at)'
        + ' VALUES (?,?,?,?,?,?,?,?)'
        + ' ON CONFLICT(shot_id) DO UPDATE SET state_in=excluded.state_in, state_out=excluded.state_out,'
        + ' meta=excluded.meta, derived_from=excluded.derived_from, state_source=excluded.state_source,'
        + ' conflicts=excluded.conflicts, updated_at=excluded.updated_at',
      ).run(
        row.shot_id, row.state_in, row.state_out, row.meta, row.derived_from,
        row.state_source, row.conflicts, row.updated_at,
      );
      written.push({ shot_id: shotId, action: prev ? 'updated' : 'inserted', content_hash: contentHash });
    }

    // 整场重建：结果里已经没有的镜（被删/被移场）必须清掉状态行。
    // 留着它不会报错，但下一篇报告会把它当"当前结论"读走。
    const deleted = [];
    for (const shotId of existing.keys()) {
      if (Object.prototype.hasOwnProperty.call(states, shotId)) continue;
      db.prepare('DELETE FROM shot_states WHERE shot_id = ?').run(shotId);
      deleted.push(shotId);
    }

    return { written, unchanged, deleted };
  });
}

/** 读回一组镜头的状态行（JSON 列已解析）；供 QC 消费与测试断言 */
export function listShotStates(shotIds = []) {
  const ids = (Array.isArray(shotIds) ? shotIds : []).map(String).filter(Boolean);
  if (!ids.length) return [];
  const db = getDb();
  const out = [];
  for (const id of ids) {
    const r = db.prepare('SELECT * FROM shot_states WHERE shot_id = ?').get(id);
    if (!r) continue;
    out.push({
      ...r,
      state_in: JSON.parse(r.state_in || '{}'),
      state_out: JSON.parse(r.state_out || '{}'),
      meta: JSON.parse(r.meta || '{}'),
      conflicts: JSON.parse(r.conflicts || '[]'),
    });
  }
  return out;
}
