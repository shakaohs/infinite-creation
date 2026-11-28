// 段级生成参数专用写入入口（P10-A 阶段 C · C-02 / D02-40 §4.2 `ShotParams.update`）
//
// 为什么必须单独一个入口：`video_prompt` / `mode` / 三张图属 B 组，矩阵里**只有**它能写。
//   · 让 `creative` 写 B 组 ⇒ 结构化项目上「创作」与「生成参数」两种权威混在一条路径里；
//   · 让 `render` 写 B 组 ⇒ 生成侧可以改用户给的段级参数（§4.4 规则 4 明令禁止）。
// 所以把它拆成独立入口，按段 id 定位、只写 5 列、写审计、整体回滚。
//
// 与 `Shots.update` 的分工：后者是**迁移期兼容**（legacy 项目仍可一次改 A+B），
// 本模块是 B 组的**唯一正式入口**，结构化项目的 PATCH 走这里（C-06）。
import { getDb, txProject, assertProjectLocked } from '../db.js';
import { recordChange, rawGet } from '../changelog.js';
import { now } from '../utils.js';

/** B 组 5 列（D02-40 §4.1，逐字）。只读快照，外部不得修改。 */
export const UNIT_PARAM_FIELDS = Object.freeze([
  'video_prompt', 'mode', 'first_frame_path', 'last_frame_path', 'reference_image_path',
]);

const ALLOWED = new Set(UNIT_PARAM_FIELDS);

function paramError(code, message, detail) {
  const e = new Error(message);
  e.code = code;
  if (detail) e.detail = detail;
  return e;
}

/**
 * 写某个生成段（= `shots` 一行）的段级生成参数。
 *
 * 三态语义（D02-40 §4.3 写死）：键缺失 ⇒ 不写；`undefined` ⇒ 不写；`''` / `null` ⇒ 显式清空。
 * **不接受**「缺失即落默认」——`mode` 缺失不应被写成 auto，`video_prompt` 缺失不应被清空。
 *
 * @param {string} unitId 段 id（`shots.id`）
 * @param {Record<string, unknown>} fields B 组字段
 * @param {{origin?: string}} [opts] origin 只用于审计标签
 * @returns {{unit_id: string, changed: boolean, updated: string[], shot: object|null}}
 */
export function update(unitId, fields = {}, opts = {}) {
  const id = String(unitId || '').trim();
  if (!id) throw paramError('UNIT_REQUIRED', 'ShotParams.update 必须指定段 id（shots.id）');

  const row = rawGet('shot', id);
  if (!row) throw paramError('UNIT_NOT_FOUND', `生成段不存在：${id}`, { unit_id: id });
  const projectId = String(row.project_id || '');
  if (!projectId) throw paramError('UNIT_PROJECT_UNRESOLVED', `生成段 ${id} 没有项目归属，拒绝写入`, { unit_id: id });

  // 越权字段当场拒（不静默丢：静默丢会让调用方以为改成功了）
  const unknown = Object.keys(fields).filter((k) => !ALLOWED.has(k) && fields[k] !== undefined);
  if (unknown.length) {
    throw paramError('UNIT_PARAM_FIELD_DENIED',
      `ShotParams.update 只接受 B 组 5 列（${UNIT_PARAM_FIELDS.join(' / ')}），拒绝：${unknown.join(', ')}`,
      { unit_id: id, fields: unknown });
  }

  // 三态：undefined 与"键缺失"等价 ⇒ 直接过滤
  const keys = UNIT_PARAM_FIELDS.filter((k) => Object.prototype.hasOwnProperty.call(fields, k) && fields[k] !== undefined);
  if (!keys.length) return { unit_id: id, changed: false, updated: [], shot: row };

  return txProject(projectId, () => {
    assertProjectLocked(projectId);
    const db = getDb();
    const before = rawGet('shot', id);            // 锁内重读：这才是本次的 before 快照
    if (!before) throw paramError('UNIT_NOT_FOUND', `生成段在取锁后被删除：${id}`, { unit_id: id });
    if (String(before.project_id) !== projectId) {
      throw paramError('UNIT_NOT_IN_PROJECT',
        `生成段 ${id} 的项目在取锁前后发生变化（${projectId} → ${before.project_id}）`,
        { unit_id: id, expected: projectId, actual: before.project_id });
    }

    const sets = [];
    const vals = [];
    for (const k of keys) {
      sets.push(k + ' = ?');
      // '' 与 null 都按调用方原样落库：TEXT 列写 NULL 与写空串在读取端语义不同，
      // 但两者都属于"显式清空"，由调用方选择；本层不做隐式归一（§4.3 三态）。
      vals.push(fields[k]);
    }
    sets.push('updated_at = ?'); vals.push(now());
    const res = db.prepare(`UPDATE shots SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    if (Number(res.changes) !== 1) {
      throw paramError('UNIT_NOT_FOUND', `更新影响 ${res.changes} 行（应为 1）：${id}`, { unit_id: id });
    }

    const after = rawGet('shot', id);
    // entity='shot' 的 update 审计：changelog 按 VOLATILE.shot 过滤，B 组是内容 ⇒ 有实质变化才留档。
    recordChange({
      entity: 'shot', action: 'update', before, after, entityId: id,
      meta: { origin: String((opts && opts.origin) || 'ShotParams.update'), group: 'B' },
    });
    return { unit_id: id, changed: true, updated: keys, shot: after };
  });
}

/** 对象形态（冻结契约写的是 `ShotParams.update(unitId, fields, {origin})`）。 */
export const ShotParams = Object.freeze({ update, FIELDS: UNIT_PARAM_FIELDS });
