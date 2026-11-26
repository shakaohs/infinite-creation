// 单元选片（D02-03 V3 §五 D-04）
//
// 一句话模型：**选择属于"单元"，存储指向"尝试"**。
//   `render_selections(unit_id PK, attempt_id, ...)` —— 一个单元任何时刻至多一条当前选择。
//   upsert 天然原子，不需要"先全置 0 再置 1"那种两步 UPDATE（那种写法中途崩了会变成"零选中"，
//   而且没人发现）。
//
// 三条不许越界：
//   · 选片**不改** task 状态（succeeded 只表示生成成功），也不删 attempt / 视频文件
//   · 被选中的 attempt **不许删**（删之前先查这里）
//   · set / clear / 重选三条路径都必须"业务写 + 审计"同事务；`recordChange` 返回 null
//     就得整体回滚——那代表审计丢了，不能让业务悄悄提交
import { getDb, tx } from '../db.js';
import { now } from '../utils.js';
import { recordChange } from '../changelog.js';

const SELECTION_COLUMNS = ['unit_id', 'attempt_id', 'selected_at', 'selected_by', 'note'];

function snap(unitId) {
  const r = getDb().prepare('SELECT * FROM render_selections WHERE unit_id = ?').get(unitId);
  if (!r) return null;
  const out = {};
  for (const c of SELECTION_COLUMNS) out[c] = r[c] === undefined ? null : r[c];
  return out;
}

/** 读当前选择（无选择返回 null） */
export function getSelection(unitId) {
  return snap(unitId);
}

/** 校验一条 attempt 能否被选为某单元的结果 */
export function assertSelectable(unitId, attemptId) {
  const db = getDb();
  const a = db.prepare('SELECT * FROM render_attempts WHERE id = ?').get(attemptId);
  if (!a) throw Object.assign(new Error('Attempt 不存在：' + attemptId), { code: 'SELECTION_INVALID_ATTEMPT' });
  const t = db.prepare('SELECT * FROM render_tasks WHERE id = ?').get(a.task_id);
  if (!t) throw Object.assign(new Error('Attempt 所属 Task 不存在'), { code: 'SELECTION_INVALID_ATTEMPT' });
  if (String(t.unit_id) !== String(unitId)) {
    throw Object.assign(new Error(`Attempt 属于单元 ${t.unit_id}，不是 ${unitId}`), { code: 'SELECTION_INVALID_ATTEMPT' });
  }
  if (String(a.status) !== 'succeeded') {
    throw Object.assign(new Error(`Attempt 状态为 ${a.status}，只有 succeeded 可选`), { code: 'SELECTION_INVALID_ATTEMPT' });
  }
  if (!a.output_path || !String(a.output_path).trim()) {
    throw Object.assign(new Error('Attempt 的 output_path 为空，无可选产物'), { code: 'SELECTION_INVALID_ATTEMPT' });
  }
  return { attempt: a, task: t };
}

/** 单元是否存在（孤儿校验的显式入口） */
function assertUnitExists(unitId) {
  const u = getDb().prepare('SELECT id FROM render_units WHERE id = ?').get(unitId);
  if (!u) throw Object.assign(new Error('单元不存在：' + unitId), { code: 'SELECTION_ORPHAN_UNIT' });
  return u;
}

/**
 * 选中一条 attempt（含重选：upsert）。
 * @returns {{created:boolean, selection:object, logId:string}}
 */
export function setSelection(unitId, attemptId, { selectedBy = '', note = '' } = {}) {
  return tx(() => {
    assertUnitExists(unitId);
    assertSelectable(unitId, attemptId);
    const before = snap(unitId);
    const t = now();
    getDb().prepare(`INSERT INTO render_selections (unit_id, attempt_id, selected_at, selected_by, note)
      VALUES (?,?,?,?,?)
      ON CONFLICT(unit_id) DO UPDATE SET attempt_id=excluded.attempt_id, selected_at=excluded.selected_at,
        selected_by=excluded.selected_by, note=excluded.note`)
      .run(unitId, attemptId, t, String(selectedBy || ''), String(note || ''));
    const after = snap(unitId);
    const logId = recordChange({
      entity: 'render_selection',
      action: before ? 'update' : 'create',
      before, after, entityId: unitId,
      meta: { from: before?.attempt_id || '', to: attemptId },
    });
    if (!logId) {
      // 审计没写进去 → 整笔回滚（S10）。tx() 抛错时会 ROLLBACK。
      throw Object.assign(new Error('选片审计写入失败（recordChange 返回 null），已回滚'), { code: 'SELECTION_AUDIT_LOST' });
    }
    return { created: !before, selection: after, logId };
  });
}

/** 取消选择：删选择行，**不删 attempt、不删文件、不改 task 状态** */
export function clearSelection(unitId, { reason = '' } = {}) {
  return tx(() => {
    const before = snap(unitId);
    if (!before) return { cleared: false, logId: '' };
    getDb().prepare('DELETE FROM render_selections WHERE unit_id = ?').run(unitId);
    const logId = recordChange({
      entity: 'render_selection', action: 'delete', before, after: null, entityId: unitId,
      meta: { reason: String(reason || '') },
    });
    if (!logId) {
      throw Object.assign(new Error('取消选片审计写入失败（recordChange 返回 null），已回滚'), { code: 'SELECTION_AUDIT_LOST' });
    }
    return { cleared: true, logId };
  });
}

/** 删除 attempt 前的守卫：被选中就拒（任务书 §7.3「不得删除被选中的 Attempt」） */
export function assertAttemptNotSelected(attemptId) {
  const r = getDb().prepare('SELECT unit_id FROM render_selections WHERE attempt_id = ? LIMIT 1').get(attemptId);
  if (r) {
    throw Object.assign(new Error(`Attempt ${attemptId} 已被单元 ${r.unit_id} 选中，禁止删除`), { code: 'ATTEMPT_SELECTED' });
  }
  return true;
}

/** 成片侧：取一批单元的当前选择（未选中的单元不出现在结果里） */
export function selectionsOfProject(projectId) {
  return getDb().prepare(`
    SELECT s.unit_id, s.attempt_id, s.selected_at, u.chapter_id, u.unit_no
      FROM render_selections s
      JOIN render_units u ON u.id = s.unit_id
     WHERE u.project_id = ?
     ORDER BY u.chapter_id, u.unit_no`).all(projectId);
}
