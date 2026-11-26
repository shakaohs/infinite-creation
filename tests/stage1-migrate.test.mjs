// 阶段 1 · 迁移登记模型（任务书 §11.5）
//
// 重点验证的不是"能增删改"，而是三条硬约束：
//   · 状态机四终态无出边（写错就抛）
//   · migrated_content_hash 写一次后没有任何接口能改它
//   · 依赖读取用 LEFT JOIN，未匹配边不被吃掉；多父合法、关联歧义单独可判
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initStage1Schema } from '../lib/core/schema/index.js';
import {
  createMigrateStore, assertRollbackTransition, assertBatchTransition,
  batchIdFor, ROLLBACK_TERMINAL,
} from '../lib/core/migrate/index.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-s1-migrate-'));
const file = path.join(TMP, 'ic.db');
const raw = new DatabaseSync(file);
const db = {
  exec: (s) => raw.exec(s),
  prepare: (s) => raw.prepare(s),
  tableColumns: (t) => raw.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name),
};
initStage1Schema(db);
const store = createMigrateStore(db);

test('M-01 批次 id 必须是 mig-YYYYMMDD-NN', () => {
  assert.equal(batchIdFor(new Date(2026, 10, 26), 1), 'mig-20261126-01');
  assert.throws(() => store.Batches.create({ id: 'batch-1' }), /mig-YYYYMMDD-NN/);
});

test('M-02 批次状态机：staged → committed → partially_rolled_back → rolled_back', () => {
  const b = store.Batches.create({ id: 'mig-20261126-01', name: 't1', sourceCounts: { shots: 66 } });
  assert.equal(b.status, 'staged');
  assert.equal(store.Batches.transition(b.id, 'committed', { targetCounts: { story_shots: 53 } }).status, 'committed');
  assert.equal(store.Batches.transition(b.id, 'partially_rolled_back').status, 'partially_rolled_back');
  assert.equal(store.Batches.transition(b.id, 'rolled_back').status, 'rolled_back');
});

test('M-03 批次非法转移被拒（rolled_back 是终态、failed 不许回滚）', () => {
  assert.throws(() => assertBatchTransition('rolled_back', 'committed'), /非法状态转移/);
  assert.throws(() => assertBatchTransition('failed', 'rolled_back'), /非法状态转移/);
  assert.throws(() => assertBatchTransition('staged', 'rolled_back'), /非法状态转移/);
  // 现实：往终态批次再转移必须抛，而不是"0 变更但返回成功"
  assert.throws(() => store.Batches.transition('mig-20261126-01', 'committed'), /非法状态转移/);
});

test('M-04 基线记录幂等：同一天重复 ensureBaseline 只产生一条', () => {
  const d = new Date(2026, 10, 26);
  const a = store.Batches.ensureBaseline({ date: d });
  assert.equal(a.created, true);
  assert.equal(a.batch.id, 'mig-20261126-00');
  assert.equal(a.batch.name, 'schema-init');
  const b = store.Batches.ensureBaseline({ date: d });
  assert.equal(b.created, false);
  const n = db.prepare("SELECT COUNT(*) n FROM migration_batches WHERE id='mig-20261126-00'").get().n;
  assert.equal(n, 1);
});

test('M-05 记录三元组唯一：同一目标行不能在同批次登记两次', () => {
  store.Items.add({ batchId: 'mig-20261126-01', targetTable: 'shot_actions', targetPk: 'sa_1', migratedContentHash: 'h1' });
  assert.throws(
    () => store.Items.add({ batchId: 'mig-20261126-01', targetTable: 'shot_actions', targetPk: 'sa_1' }),
    /已在本批次登记过/,
  );
  // 不同批次可以登记同一目标行（各自独立回滚）
  store.Items.add({ batchId: 'mig-20261126-00', targetTable: 'shot_actions', targetPk: 'sa_1' });
  assert.equal(store.Items.listByBatch('mig-20261126-01').length, 1);
});

test('M-06 migrated_content_hash 写一次后没有任何接口能改它', () => {
  const before = store.Items.get('mig-20261126-01', 'shot_actions', 'sa_1').migrated_content_hash;
  // 模块导出的方法里不存在 updateHash 一类入口
  assert.deepEqual(Object.keys(store.Items).sort(), ['add', 'counts', 'get', 'listByBatch', 'setMigrationStatus', 'setRollbackStatus']);
  // 直接改库当然可以（人在 sqlite 里做任何事都行），但那不是产品路径；
  // 这里断言"产品路径不会改"——setMigrationStatus 不碰 hash
  store.Items.setMigrationStatus('mig-20261126-01', 'shot_actions', 'sa_1', 'committed');
  assert.equal(store.Items.get('mig-20261126-01', 'shot_actions', 'sa_1').migrated_content_hash, before);
});

test('M-07 回滚状态机全边：none→四类、eligible→两终态、四终态无出边', () => {
  for (const to of ['eligible', 'protected', 'missing', 'unverifiable']) assert.ok(assertRollbackTransition('none', to));
  assert.ok(assertRollbackTransition('eligible', 'rolled_back'));
  assert.ok(assertRollbackTransition('eligible', 'protected'));
  for (const t of ROLLBACK_TERMINAL) {
    for (const to of ['none', 'eligible', 'rolled_back', 'protected']) {
      assert.throws(() => assertRollbackTransition(t, to), /非法状态转移/, `${t} → ${to} 应被拒`);
    }
  }
  // 关键：不存在 protected → eligible 的回边
  assert.throws(() => assertRollbackTransition('protected', 'eligible'), /非法状态转移/);
});

test('M-08 逐行转移走状态机，非法路径抛且不改库', () => {
  store.Items.add({ batchId: 'mig-20261126-01', targetTable: 'shot_states', targetPk: 'ss_1', migratedContentHash: 'h2' });
  store.Items.setRollbackStatus('mig-20261126-01', 'shot_states', 'ss_1', 'eligible');
  assert.throws(() => store.Items.setRollbackStatus('mig-20261126-01', 'shot_states', 'ss_1', 'none'), /非法状态转移/);
  store.Items.setRollbackStatus('mig-20261126-01', 'shot_states', 'ss_1', 'rolled_back');
  // 终态后任何转移都拒，且原状态保持
  assert.throws(() => store.Items.setRollbackStatus('mig-20261126-01', 'shot_states', 'ss_1', 'missing'), /非法状态转移/);
  assert.equal(store.Items.get('mig-20261126-01', 'shot_states', 'ss_1').rollback_status, 'rolled_back');
});

test('M-09 保护路径记 protected_at', () => {
  store.Items.add({ batchId: 'mig-20261126-01', targetTable: 'story_shots', targetPk: 'sh_1', migratedContentHash: 'h3' });
  store.Items.setRollbackStatus('mig-20261126-01', 'story_shots', 'sh_1', 'protected', 'hash_changed');
  const it = store.Items.get('mig-20261126-01', 'story_shots', 'sh_1');
  assert.equal(it.rollback_status, 'protected');
  assert.equal(it.rollback_reason, 'hash_changed');
  assert.ok(it.protected_at > 0);
});

test('M-10 依赖边：多父合法，不当成 ambiguous', () => {
  // render_unit_shots 天生双父：一个子行挂 unit 与 shot 两个父
  store.Items.add({ batchId: 'mig-20261126-01', targetTable: 'render_unit_shots', targetPk: 'rus_1', migratedContentHash: 'h4' });
  store.Edges.add({ batchId: 'mig-20261126-01', childTable: 'render_unit_shots', childPk: 'rus_1', parentTable: 'render_units', parentPk: 'u1' });
  store.Edges.add({ batchId: 'mig-20261126-01', childTable: 'render_unit_shots', childPk: 'rus_1', parentTable: 'story_shots', parentPk: 'sh_1' });
  const snap = store.Edges.snapshot('mig-20261126-01', 'render_units', 'u1');
  assert.equal(snap.edgeCount, 1);
  assert.equal(snap.ambiguous, 0);
  assert.equal(snap.unmatched, 0);
  assert.equal(snap.ok, true);
  // 从 shot 侧看也是 1 条边，同样不歧义
  const snap2 = store.Edges.snapshot('mig-20261126-01', 'story_shots', 'sh_1');
  assert.equal(snap2.ambiguous, 0);
  assert.equal(snap2.ok, true);
});

test('M-11 同名主键跨表不串联：child_pk 相同但 child_table 不同必须分开判', () => {
  // 两个不同表都用 '1' 作为主键
  store.Items.add({ batchId: 'mig-20261126-01', targetTable: 'shot_actions', targetPk: '1', migratedContentHash: 'h5' });
  store.Edges.add({ batchId: 'mig-20261126-01', childTable: 'shot_actions', childPk: '1', parentTable: 'story_shots', parentPk: 'sh_p' });
  store.Edges.add({ batchId: 'mig-20261126-01', childTable: 'shot_states', childPk: '1', parentTable: 'story_shots', parentPk: 'sh_p' });
  const snap = store.Edges.snapshot('mig-20261126-01', 'story_shots', 'sh_p');
  assert.equal(snap.edgeCount, 2);
  const byChild = Object.fromEntries(snap.edges.map((e) => [e.child_table, e]));
  assert.equal(byChild.shot_actions.status, 'OK', 'shot_actions.1 有迁移记录');
  assert.equal(byChild.shot_states.status, 'EDGE_UNMATCHED', 'shot_states.1 没有迁移记录，不得因同号被串到 shot_actions');
});

test('M-12 未匹配边必须被检出（LEFT JOIN，不被静默过滤）', () => {
  const snap = store.Edges.snapshot('mig-20261126-01', 'story_shots', 'sh_p');
  assert.ok(snap.unmatched >= 1);
  assert.equal(snap.ok, false);
  assert.ok(snap.edges.some((e) => e.status === 'EDGE_UNMATCHED' && e.child_table === 'shot_states'));
});

test('M-13 重复三元组造成的关联歧义能被检出（隔离夹具：临时去掉主键约束）', () => {
  // 正常库上无法插出重复三元组（主键挡住）。必须用隔离库模拟"约束被破坏"或"被外部工具写过"。
  const f2 = path.join(TMP, 'amb.db');
  const r2 = new DatabaseSync(f2);
  const d2 = { exec: (s) => r2.exec(s), prepare: (s) => r2.prepare(s), tableColumns: (t) => r2.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name) };
  // 只有主键列、没有主键约束的两张表
  d2.exec('CREATE TABLE migration_items (batch_id TEXT, target_table TEXT, target_pk TEXT, rollback_status TEXT DEFAULT \'none\', migration_status TEXT DEFAULT \'staged\')');
  d2.exec(`CREATE TABLE migration_edges (batch_id TEXT, child_table TEXT, child_pk TEXT, parent_table TEXT, parent_pk TEXT, edge_kind TEXT, created_at INTEGER)`);
  d2.exec("INSERT INTO migration_items VALUES ('b1','shot_actions','sa_dup','none','committed')");
  d2.exec("INSERT INTO migration_items VALUES ('b1','shot_actions','sa_dup','none','committed')");  // 重复三元组
  d2.exec("INSERT INTO migration_edges VALUES ('b1','shot_actions','sa_dup','story_shots','sh_1','fk',1)");
  const s2 = createMigrateStore(d2);
  const snap = s2.Edges.snapshot('b1', 'story_shots', 'sh_1');
  assert.equal(snap.edges[0].hits, 2);
  assert.equal(snap.ambiguous, 1);
  assert.equal(snap.edges[0].status, 'EDGE_AMBIGUOUS');
  r2.close();
});

test('M-14 边写入幂等：同一五元组重复 add 返回 false 且不产生第二行', () => {
  const again = store.Edges.add({ batchId: 'mig-20261126-01', childTable: 'render_unit_shots', childPk: 'rus_1', parentTable: 'render_units', parentPk: 'u1' });
  assert.equal(again, false);
  const n = db.prepare("SELECT COUNT(*) n FROM migration_edges WHERE child_pk='rus_1'").get().n;
  assert.equal(n, 2);  // 两个不同父，各一行
});

test('M-15 回滚读取边不删边（E2）', () => {
  const before = db.prepare('SELECT COUNT(*) n FROM migration_edges').get().n;
  store.Items.setRollbackStatus('mig-20261126-01', 'render_unit_shots', 'rus_1', 'eligible');
  store.Items.setRollbackStatus('mig-20261126-01', 'render_unit_shots', 'rus_1', 'rolled_back');
  const after = db.prepare('SELECT COUNT(*) n FROM migration_edges').get().n;
  assert.equal(after, before, '回滚不得删边');
});

test('M-16 运维三表不进 changelog 实体映射', async () => {
  const { ENTITY_TABLE } = await import('../lib/core/changelog.js');
  for (const t of ['migration_batches', 'migration_items', 'migration_edges']) {
    assert.equal(Object.keys(ENTITY_TABLE).includes(t), false, t);
  }
  // 也不是按表名映射（值是元数据对象/表名，两种形态都要查）
  const flat = Object.values(ENTITY_TABLE).map((v) => (typeof v === 'string' ? v : v?.table)).filter(Boolean);
  for (const t of ['migration_batches', 'migration_items', 'migration_edges']) {
    assert.equal(flat.includes(t), false);
  }
});

test('M-17 计数按 rollback_status 分组，六个状态都在（缺的补 0）', () => {
  const c = store.Items.counts('mig-20261126-01');
  for (const s of ['none', 'eligible', 'protected', 'missing', 'unverifiable', 'rolled_back']) {
    assert.equal(typeof c[s], 'number', s);
  }
  assert.ok(c.rolled_back >= 1);
  assert.ok(c.protected >= 1);
});

test.after(() => { try { raw.close(); } catch { /* 已关闭 */ } });
