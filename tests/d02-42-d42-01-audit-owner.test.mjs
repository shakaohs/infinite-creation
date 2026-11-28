// P10-A · D42-01：A 类审计实体项目归属 fail-closed
//
// 这一组锁的是 `recordChange()` 的**归属来源**，不是 Stage 3 写入器（阶段 B 才接）。
// 上一版实现是 `projectIdOf(a || b) || String(projectId || '')`：只要调用方顺手传一个
// projectId，就能把「这张 shot_asset 的 shot 已经不存在」盖掉，日志落到一个看起来合法的
// 项目名下。事后无法区分「归属是从真实行算出来的」与「归属是调用方嘴报的」——
// 而这正是审计唯一的价值所在。本轮把 A 类改成只认行快照。
//
// 边界（必须写清楚）：
//   · 只改 A 类五个实体；既有 6 个非必需实体的历史口径一字不变（D42-01 第 5 条）。
//   · 不改复合主键编码、不改快照结构、不改回滚拒绝策略（第 6 条）。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-d42-01-'));
process.env.IC_DATA_DIR = TMP;

const core = await import('../lib/core/index.js');
const {
  getDb, tx, recordChange, rawGet, listChanges, rollbackLogs, entityIdOf,
} = core;

const db = getDb();
const T = 1700000000000;

db.prepare('INSERT INTO projects (id,name,context,status,structured_spec,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
  .run('p-d42', 'D42 归属测试项目', '{}', 'idle', 1, T, T);
db.prepare('INSERT INTO projects (id,name,context,status,structured_spec,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
  .run('p-d42-other', '另一个项目（用于证明显式 projectId 不被采纳）', '{}', 'idle', 1, T, T);
db.prepare('INSERT INTO chapters (id,project_id,title,novel,script,seq,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
  .run('ch-d42', 'p-d42', '第1章', '', '', 1, 'pending', T, T);

let ssSeq = 0;
function mkStoryShot(id, projectId = 'p-d42', extra = {}) {
  // story_shots 有 UNIQUE(chapter_id, shot_no)：每个夹具必须拿到不同的镜号
  ssSeq += 1;
  const row = {
    id, project_id: projectId, chapter_id: 'ch-d42', scene_key: 'sc-d42',
    shot_no: ssSeq, global_no: ssSeq, created_at: T, updated_at: T, ...extra,
  };
  db.prepare(`INSERT INTO story_shots (id,project_id,chapter_id,scene_key,shot_no,global_no,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(row.id, row.project_id, row.chapter_id, row.scene_key, row.shot_no, row.global_no, row.created_at, row.updated_at);
  return row;
}

const orphanAsset = (shotId = 'ss-不存在') => ({ shot_id: shotId, asset_id: 'as-z', role: 'char', order_no: 1, variant_of: '' });

test('D42-01-A 孤儿 shot_asset + 不传 projectId：拒绝', () => {
  assert.throws(
    () => recordChange({ entity: 'shot_asset', action: 'create', after: orphanAsset() }),
    (e) => e.code === 'AUDIT_PROJECT_UNRESOLVED',
  );
});

test('D42-01-B 孤儿 shot_asset + 传入**有效** projectId：仍然拒绝（本轮核心）', () => {
  // 上一版会静默记到 p-d42 名下。这里必须仍然抛，且不得留下日志。
  const before = listChanges('p-d42', { entity: 'shot_asset', limit: 1000 }).length;
  assert.throws(
    () => recordChange({ entity: 'shot_asset', action: 'create', after: orphanAsset(), projectId: 'p-d42' }),
    (e) => e.code === 'AUDIT_PROJECT_UNRESOLVED' && e.side === 'after',
    '调用方传入的 projectId 不得掩盖归属反查失败',
  );
  assert.equal(listChanges('p-d42', { entity: 'shot_asset', limit: 1000 }).length, before, '失败时不得写出任何日志');
});

test('D42-01-C 正常 shot_asset：经 story_shots 解析出项目，且显式 projectId 不参与', () => {
  mkStoryShot('ss-d42-ok');
  const row = { shot_id: 'ss-d42-ok', asset_id: 'as-ok', role: 'char', order_no: 1, variant_of: '' };
  db.prepare('INSERT INTO shot_assets (shot_id,asset_id,role,order_no,variant_of) VALUES (?,?,?,?,?)')
    .run(row.shot_id, row.asset_id, row.role, row.order_no, row.variant_of);
  // 故意传一个**另一个有效项目**的 id：归属必须来自真实行（p-d42），不是入参
  const id = recordChange({ entity: 'shot_asset', action: 'create', after: row, projectId: 'p-d42-other' });
  assert.ok(id);
  const log = listChanges('p-d42', { entity: 'shot_asset', limit: 1000 }).find((l) => l.id === id);
  assert.ok(log, '日志必须记在真实项目下');
  assert.equal(log.project_id, 'p-d42');
  assert.equal(log.entity_id, entityIdOf('shot_asset', row));
  assert.deepEqual(log.after, row);
});

test('D42-01-D shot_blocking / shot_action：归属反查失败同样拒绝（不得因入参而放行）', () => {
  const blocking = {
    shot_id: 'ss-不存在', character_id: 'char-1', position_abs: '', norm_confidence: 0,
    position_track: '[]', occlusion: 'none', in_frame: 1,
  };
  assert.throws(
    () => recordChange({ entity: 'shot_blocking', action: 'create', after: blocking, projectId: 'p-d42' }),
    (e) => e.code === 'AUDIT_PROJECT_UNRESOLVED',
  );
  const action = { id: 'act-x', shot_id: 'ss-不存在', actor_id: 'char-1', action_type: 'walk', tier: 'T1' };
  assert.throws(
    () => recordChange({ entity: 'shot_action', action: 'create', after: action, projectId: 'p-d42' }),
    (e) => e.code === 'AUDIT_PROJECT_UNRESOLVED',
  );
});

test('D42-01-E 直接带 project_id 的 A 类实体（story_shot）：project_id 为空也拒绝', () => {
  const ghost = { id: 'ss-ghost', project_id: '', chapter_id: 'ch-d42', scene_key: 'sc-d42', shot_no: 9, global_no: 9 };
  assert.throws(
    () => recordChange({ entity: 'story_shot', action: 'create', after: ghost, projectId: 'p-d42' }),
    (e) => e.code === 'AUDIT_PROJECT_UNRESOLVED',
  );
});

test('D42-01-F before/after 归属不一致：拒绝而不是挑一侧记账', () => {
  mkStoryShot('ss-d42-a', 'p-d42');
  mkStoryShot('ss-d42-b', 'p-d42-other');
  const before = rawGet('story_shot', 'ss-d42-a');
  const after = { ...rawGet('story_shot', 'ss-d42-b'), id: 'ss-d42-a' };
  assert.throws(
    () => recordChange({ entity: 'story_shot', action: 'update', before, after, projectId: 'p-d42' }),
    (e) => e.code === 'AUDIT_PROJECT_UNRESOLVED' && e.side === 'both',
  );
});

test('D42-01-G 唯一例外：两侧都无行快照的回滚，允许沿用显式 projectId', () => {
  // 直接调 recordChange 打这条分支（真实回滚路径在 H 用例里端到端验）
  assert.throws(
    () => recordChange({ entity: 'story_shot', action: 'rollback', before: null, after: null }),
    (e) => e.code === 'AUDIT_PROJECT_UNRESOLVED' && e.side === 'none',
    '例外不等于放任：显式 projectId 为空仍必须拒绝',
  );
  const id = recordChange({ entity: 'story_shot', action: 'rollback', before: null, after: null, projectId: 'p-d42' });
  assert.ok(id, '回滚的无快照场景不得被误伤');
  const log = listChanges('p-d42', { entity: 'story_shot', limit: 1000 }).find((l) => l.id === id);
  assert.equal(log.project_id, 'p-d42');
  assert.equal(log.action, 'rollback');
});

test('D42-01-H 端到端回滚：行早已不存在 ⇒ 无快照回滚成功且归属沿用日志的 project_id', () => {
  const row = mkStoryShot('ss-d42-gone');
  const createLog = recordChange({ entity: 'story_shot', action: 'create', after: row });
  assert.ok(createLog);
  // 行被别的东西删掉了（模拟漂移），此时回滚"新建"没有行可归属
  db.prepare('DELETE FROM story_shots WHERE id = ?').run('ss-d42-gone');
  const r = rollbackLogs({ projectId: 'p-d42', logId: createLog, force: true });
  assert.equal(r.applied.length, 1);
  const rollbackLog = listChanges('p-d42', { entity: 'story_shot', limit: 1000 })
    .find((l) => l.action === 'rollback' && l.revert_of === createLog);
  assert.ok(rollbackLog, '无快照回滚仍必须留档（否则审计断链、reverted_by 打不上）');
  assert.equal(rollbackLog.project_id, 'p-d42');
});

test('D42-01-I 审计失败与业务写入同事务回滚', () => {
  const beforeRows = db.prepare('SELECT COUNT(*) AS c FROM shot_assets').get().c;
  assert.throws(() => tx(() => {
    db.prepare('INSERT INTO shot_assets (shot_id,asset_id,role,order_no,variant_of) VALUES (?,?,?,?,?)')
      .run('ss-不存在', 'as-ghost', 'char', 7, '');
    recordChange({
      entity: 'shot_asset', action: 'create',
      after: { shot_id: 'ss-不存在', asset_id: 'as-ghost', role: 'char', order_no: 7, variant_of: '' },
      projectId: 'p-d42',   // 传了也不许放行
    });
  }), (e) => e.code === 'AUDIT_PROJECT_UNRESOLVED');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM shot_assets').get().c, beforeRows,
    '审计失败必须把业务写入一起回滚');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM shot_assets WHERE asset_id='as-ghost'").get().c, 0);
});

test('D42-01-J 既有 6 个非必需实体：历史兼容行为不变（显式 projectId 仍可兜底）', () => {
  // 孤儿 shot 行（project_id 空）+ 显式 projectId —— 这是 B 类的历史口径，不许因本轮收紧而改变
  const ghostShot = { id: 'sh-ghost', project_id: '', chapter: '', idx: 99 };
  const id = recordChange({ entity: 'shot', action: 'delete', before: ghostShot, projectId: 'p-d42' });
  assert.ok(id, 'B 类历史行为：显式 projectId 兜底必须仍然生效');
  const log = listChanges('p-d42', { entity: 'shot', limit: 1000 }).find((l) => l.id === id);
  assert.equal(log.project_id, 'p-d42');
});
