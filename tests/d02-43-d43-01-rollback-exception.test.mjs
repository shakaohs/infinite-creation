// P10-A · D02-43：回滚归属例外边界收口
//
// D42-01 把 A 类归属改成「只认行快照」，但留了一个例外：before / after 都为空时可以用显式
// projectId。例外没写 `action === 'rollback'` 这个前提 —— 于是任何**未在快照铁律里枚举的动作名**
// （自定义批次名、导入标记等）都能绕过归属检查：create/update/delete 会被
// AUDIT_SNAPSHOT_UNREADABLE 挡住，别的动作名不会。
//
// 本组用例把例外的边界钉死：无快照 + 显式 projectId 只在 rollback 上成立。
// 错误码集合不变（仍是 AUDIT_PROJECT_UNRESOLVED），D42-01 的 A~J 十条由原文件继续守。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-d43-'));
process.env.IC_DATA_DIR = TMP;

const core = await import('../lib/core/index.js');
const { getDb, recordChange, listChanges } = core;

const db = getDb();
const T = 1700000000000;

db.prepare('INSERT INTO projects (id,name,context,status,structured_spec,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
  .run('p-d43', 'D43 例外边界测试项目', '{}', 'idle', 1, T, T);

const logsOf = () => listChanges('p-d43', { entity: 'story_shot', limit: 1000 });

test('D43-01 两侧无快照 + rollback + 有效 projectId：通过（已有行为保持）', () => {
  const id = recordChange({
    entity: 'story_shot', action: 'rollback', before: null, after: null, projectId: 'p-d43',
  });
  assert.ok(id, 'D42-01 已通过的场景不得被本轮收口误伤');
  const log = logsOf().find((l) => l.id === id);
  assert.equal(log.project_id, 'p-d43');
  assert.equal(log.action, 'rollback');
});

test('D43-02 两侧无快照 + rollback + 无 projectId：拒绝', () => {
  assert.throws(
    () => recordChange({ entity: 'story_shot', action: 'rollback', before: null, after: null }),
    (e) => e.code === 'AUDIT_PROJECT_UNRESOLVED' && e.side === 'none',
  );
});

test('D43-03 两侧无快照 + 非 rollback + 有效 projectId：拒绝（本轮核心）', () => {
  // 这些动作名不在 create/update/delete 里，因此**不会**先被 AUDIT_SNAPSHOT_UNREADABLE 拦下，
  // 上一版会直接拿 p-d43 记账 —— 本轮必须抛。
  const before = logsOf().length;
  for (const action of ['import', 'restore', 'bulk_sync', '']) {
    assert.throws(
      () => recordChange({ entity: 'story_shot', action, before: null, after: null, projectId: 'p-d43' }),
      (e) => e.code === 'AUDIT_PROJECT_UNRESOLVED' && e.providedProjectId === 'p-d43',
      `action=${JSON.stringify(action)} 不得走无快照例外`,
    );
  }
  assert.equal(logsOf().length, before, '拒绝时不得写出任何日志');
});

test('D43-04 快照铁律顺序未变：create 缺 after 仍是 AUDIT_SNAPSHOT_UNREADABLE', () => {
  // 本轮只改「两侧都空」那一支，枚举动作的报错优先级一字未动（错误码集合不变）
  assert.throws(
    () => recordChange({ entity: 'story_shot', action: 'create', after: null, projectId: 'p-d43' }),
    (e) => e.code === 'AUDIT_SNAPSHOT_UNREADABLE',
  );
});

test('D43-05 B 类不受影响：无快照 + 显式 projectId 仍按历史口径记录', () => {
  // 既有 6 个非必需实体根本不走 requiredProjectIdOf：这里守的是「收口没越界」
  const id = recordChange({ entity: 'shot', action: 'delete', before: null, projectId: 'p-d43' });
  assert.ok(id, 'B 类历史行为：显式 projectId 兜底必须仍然生效');
});
