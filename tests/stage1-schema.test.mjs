// 阶段 1 · 结构与 Manifest（任务书 §11.1 / §11.2 / §11.3）
//
// 全部在**临时库**上跑，通过给 initSchema 传入自己的 adapter 完全绕开单例与
// IC_DATA_DIR —— 这样测试物理上不可能碰到 data/ic.db（阶段 0 的事故就是因为
// "import 即固化 DATA_DIR"，本条测试连那条路径都不走）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initSchema, ensureColumn } from '../lib/core/db.js';
import { initStage1Schema, stage1Status, stage1TableNames, stage1TablesByGroup } from '../lib/core/schema/index.js';
import { STAGE1_INDEXES, STAGE1_TABLES } from '../lib/core/schema/tables.js';
import { createMigrateStore } from '../lib/core/migrate/index.js';
import { verify } from '../scripts/schema/verify-manifest.mjs';
import { buildManifest } from '../scripts/schema/gen-manifest.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-s1-schema-'));

function makeDb(name = 'fresh') {
  const dir = path.join(TMP, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'ic.db');
  const raw = new DatabaseSync(file);
  const db = {
    exec: (s) => raw.exec(s),
    prepare: (s) => raw.prepare(s),
    tableColumns: (t) => raw.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name),
    dialect: 'sqlite',
    raw,
    file,
  };
  return db;
}

const fresh = makeDb('fresh');
initSchema(fresh);

test('S-01 21 张新建表全部建立', () => {
  const st = stage1Status(fresh);
  assert.deepEqual(st.missingTables, []);
  assert.equal(stage1TableNames().length, 21);
});

test('S-02 分组数量 3 ops / 1 archive / 14 biz / 3 d02_ext', () => {
  const g = stage1TablesByGroup();
  assert.equal(g.ops.length, 3);
  assert.equal(g.archive.length, 1);
  assert.equal(g.biz.length, 14);
  assert.equal(g.d02_ext.length, 3);
});

test('S-03 索引全部建立（25 条），无半成品', () => {
  const st = stage1Status(fresh);
  assert.deepEqual(st.missingIndexes, []);
  assert.equal(STAGE1_INDEXES.length, 25);
});

test('S-04 新库 projects 22 列，structured_spec NOT NULL DEFAULT 0', () => {
  const cols = fresh.prepare('PRAGMA table_info(projects)').all();
  assert.equal(cols.length, 22);
  const c = cols.find((x) => x.name === 'structured_spec');
  assert.ok(c, '缺 structured_spec');
  assert.equal(c.notnull, 1);
  assert.equal(String(c.dflt_value), '0');
});

test('S-05 新库 shots 35 列且含 blocking', () => {
  const cols = fresh.tableColumns('shots');
  assert.equal(cols.length, 35);
  assert.ok(cols.includes('blocking'));
  assert.ok(!cols.includes('seam'), '新库不应有历史列 seam');
  assert.ok(!cols.includes('storyboard_sheet'));
});

test('S-06 幂等：连续两次 initSchema，所有表列集合完全一致', () => {
  const snap = () => Object.fromEntries(stage1TableNames().map((n) => [n, fresh.tableColumns(n).join(',')]));
  const before = snap();
  initSchema(fresh);
  initSchema(fresh);
  assert.deepEqual(snap(), before);
});

test('S-07 业务表零迁移列（14 张逐一扫）', () => {
  const bad = [];
  for (const name of stage1TablesByGroup().biz) {
    for (const c of fresh.tableColumns(name)) {
      if (/^migration_batch_id$|^batch_id$|^migrated_/.test(c)) bad.push(`${name}.${c}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('S-08 三处"不许加列"逐条核对', () => {
  assert.ok(!fresh.tableColumns('render_tasks').includes('job_id'));
  assert.ok(!fresh.tableColumns('render_attempts').includes('selected'));
  assert.ok(!fresh.tableColumns('render_adaptations').includes('g0_locks'));
});

test('S-09 Manifest 条目 25 / groups 21 / stage_a 1 / existing 3 / pending 空', () => {
  const m = buildManifest();
  assert.equal(m.counts.groups_total, 21);
  assert.equal(m.counts.stage_a, 1);
  assert.equal(m.counts.existing, 3);
  assert.equal(m.counts.entries_total, 25);
  assert.deepEqual(Object.keys(m.pending), []);
  assert.deepEqual(Object.keys(m.groups.ops), ['migration_batches', 'migration_items', 'migration_edges']);
  assert.deepEqual(Object.keys(m.groups.archive), ['legacy_artifacts']);
  assert.deepEqual(Object.keys(m.groups.d02_ext).sort(), ['adaptation_locks', 'render_selections', 'render_task_jobs']);
  assert.deepEqual(Object.keys(m.existing).sort(), ['projects', 'shot_videos', 'shots']);
  // P10-A A-04：continuity_runs 单列成组，shot_videos 纳入既有表 —— 两张都不能落进 21 张新建表
  assert.deepEqual(Object.keys(m.groups.stage_a), ['continuity_runs']);
});

test('S-10 生成器重复执行结果稳定（两次 build 字节一致）', () => {
  assert.equal(JSON.stringify(buildManifest()), JSON.stringify(buildManifest()));
});

test('S-11 生成器不读数据库（只解析 DDL 文本）', () => {
  const src = fs.readFileSync(new URL('../scripts/schema/gen-manifest.mjs', import.meta.url), 'utf8');
  assert.ok(!/node:sqlite|DatabaseSync|PRAGMA table_info/.test(src), '生成器不应读库');
  // 且把 DB 环境变量指到不存在的路径，生成结果不变
  const before = JSON.stringify(buildManifest());
  const old = process.env.IC_DB_SQLITE_PATH;
  process.env.IC_DB_SQLITE_PATH = path.join(TMP, 'no-such-dir', 'nope.db');
  try { assert.equal(JSON.stringify(buildManifest()), before); } finally {
    if (old === undefined) delete process.env.IC_DB_SQLITE_PATH; else process.env.IC_DB_SQLITE_PATH = old;
  }
});

test('S-12 fresh 库 verify 25/25 通过；groups 断言正确', () => {
  const r = verify(fresh.file, 'fresh');
  assert.equal(r.ok, true, JSON.stringify(r.failed));
  assert.equal(r.entries, 25);
  assert.equal(r.fail, 0);
  assert.equal(r.groupsAssert.pendingEmpty, true);
  assert.equal(r.groupsAssert.groups_total ?? 21, 21);
});

test('S-13 R-41 shot_assets 的 UNIQUE / CHECK 由数据库拦（不是靠 hash）', () => {
  fresh.exec("INSERT INTO shot_assets VALUES ('sh_x','as_a','voice',1,'')");
  // 同 order_no 不同 asset → UNIQUE 拒
  assert.throws(() => fresh.exec("INSERT INTO shot_assets VALUES ('sh_x','as_b','voice',1,'')"), /UNIQUE/i);
  // order_no = 0 → CHECK 拒
  assert.throws(() => fresh.exec("INSERT INTO shot_assets VALUES ('sh_x','as_c','voice',0,'')"), /CHECK/i);
  // voice 第 4 条 → CHECK 拒
  fresh.exec("INSERT INTO shot_assets VALUES ('sh_x','as_d','voice',2,'')");
  fresh.exec("INSERT INTO shot_assets VALUES ('sh_x','as_e','voice',3,'')");
  assert.throws(() => fresh.exec("INSERT INTO shot_assets VALUES ('sh_x','as_f','voice',4,'')"), /CHECK|UNIQUE/i);
});

test('S-14 缺列必须被识别为 missing（构造少一列的 shots）', () => {
  const db = makeDb('missing-col');
  // 只建 projects 与一个缺 blocking 的 shots，再补 21 表 → verify 应报 shots 缺列
  initStage1Schema(db);
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, context TEXT DEFAULT '{}', status TEXT DEFAULT 'idle', structured_spec INTEGER NOT NULL DEFAULT 0, created_at INTEGER, updated_at INTEGER)");
  db.exec('CREATE TABLE shots (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, idx INTEGER NOT NULL)');
  const r = verify(db.file, 'fresh');
  assert.equal(r.ok, false);
  const shots = r.failed.find((f) => f.table === 'shots');
  assert.ok(shots, '应报 shots');
  assert.ok(shots.missing.includes('blocking'), '应指出缺 blocking');
  assert.ok(shots.missing.includes('updated_at'));
});

test('S-15 未知额外列必须 FAIL（fresh 不允许任何 extra）', () => {
  const db = makeDb('unknown-extra');
  initSchema(db);
  db.exec("ALTER TABLE shots ADD COLUMN weird_new_col TEXT DEFAULT ''");
  const r = verify(db.file, 'fresh');
  assert.equal(r.ok, false);
  const shots = r.failed.find((f) => f.table === 'shots');
  assert.deepEqual(shots.unknownExtra, ['weird_new_col']);
});

test('S-16 把 shots 挪进 groups（当成新建表）必须被结构断言拦住', () => {
  const m = buildManifest();
  assert.ok(Object.keys(m.existing).includes('shots'));
  for (const g of ['ops', 'archive', 'biz', 'd02_ext']) {
    assert.equal(Object.keys(m.groups[g]).includes('shots'), false, `groups.${g} 不应包含 shots`);
    assert.equal(Object.keys(m.groups[g]).includes('projects'), false);
  }
  // 反向：21 张新建表里一张都不许出现在 existing
  for (const n of stage1TableNames()) assert.equal(Object.keys(m.existing).includes(n), false, n);
});

test('S-17 三张扩展表列结构（4 / 3 / 5）', () => {
  assert.deepEqual(fresh.tableColumns('adaptation_locks'), ['adaptation_id', 'lock_key', 'lock_value', 'created_at']);
  assert.deepEqual(fresh.tableColumns('render_task_jobs'), ['task_id', 'job_id', 'created_at']);
  assert.deepEqual(fresh.tableColumns('render_selections'), ['unit_id', 'attempt_id', 'selected_at', 'selected_by', 'note']);
});

test('S-18 render_task_jobs.task_id 是主键：一个 task 不能绑两个 job', () => {
  fresh.exec("INSERT INTO render_task_jobs VALUES ('t1','j1',1)");
  assert.throws(() => fresh.exec("INSERT INTO render_task_jobs VALUES ('t1','j2',2)"), /UNIQUE|PRIMARY/i);
});

test('S-19 render_selections.unit_id 是主键：一个单元只能一条当前选择', () => {
  fresh.exec("INSERT INTO render_selections (unit_id,attempt_id,selected_at) VALUES ('u1','a1',1)");
  assert.throws(() => fresh.exec("INSERT INTO render_selections (unit_id,attempt_id,selected_at) VALUES ('u1','a2',2)"), /UNIQUE|PRIMARY/i);
  // upsert 写法必须成功且只留一行
  fresh.exec("INSERT INTO render_selections (unit_id,attempt_id,selected_at) VALUES ('u1','a3',3) ON CONFLICT(unit_id) DO UPDATE SET attempt_id=excluded.attempt_id, selected_at=excluded.selected_at");
  const rows = fresh.prepare("SELECT * FROM render_selections WHERE unit_id='u1'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attempt_id, 'a3');
});

test('S-20 adaptation_locks 主键 (adaptation_id, lock_key)，同方案同 key 不可重复', () => {
  fresh.exec("INSERT INTO adaptation_locks (adaptation_id,lock_key,lock_value) VALUES ('ad1','mode','Ref2VA')");
  assert.throws(() => fresh.exec("INSERT INTO adaptation_locks (adaptation_id,lock_key,lock_value) VALUES ('ad1','mode','T2VA')"), /UNIQUE|PRIMARY/i);
  fresh.exec("INSERT INTO adaptation_locks (adaptation_id,lock_key,lock_value) VALUES ('ad1','aspect','9:16')");
  assert.equal(fresh.prepare("SELECT COUNT(*) n FROM adaptation_locks WHERE adaptation_id='ad1'").get().n, 2);
});

test('S-21 历史库补列：ensureColumn 幂等且不吞异常', () => {
  const db = makeDb('hist-col');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
  assert.equal(ensureColumn(db, 'projects', 'structured_spec', 'structured_spec INTEGER NOT NULL DEFAULT 0'), true);
  assert.equal(ensureColumn(db, 'projects', 'structured_spec', 'structured_spec INTEGER NOT NULL DEFAULT 0'), false);
  // 表不存在时必须抛，而不是"当作已经有了"
  assert.throws(() => ensureColumn(db, 'no_such_table', 'x', 'x TEXT'));
});

test('S-22 21 张表全部 IF NOT EXISTS：重复建表不报错', () => {
  assert.doesNotThrow(() => initStage1Schema(fresh));
  assert.doesNotThrow(() => initStage1Schema(fresh));
});

test('S-23 建表顺序表与 DDL 一一对应（不多不少）', () => {
  const fromTables = STAGE1_TABLES.map((t) => t.name).sort();
  const fromFiles = stage1TableNames().sort();
  assert.deepEqual(fromFiles, fromTables);
  assert.equal(new Set(fromTables).size, 21);
});

test.after(() => {
  try { fresh.raw.close(); } catch { /* 已关闭 */ }
});

// ── B-02：schema 初始化基线批次（V1.1 修复"只提供模型方法、没有接线"）─────
// 基线记录的含义：这套 21 表结构已就位。所以它必须
//   ① 在表与索引成功创建**之后**写；② 幂等（不是每天开一次应用就多一条）；③ 失败即抛出。
function batchesOf(db) {
  return db.raw.prepare('SELECT id,name,status,script_ver FROM migration_batches ORDER BY id').all();
}

test('B-01 全新库 initSchema 后存在 schema-init 基线，且 id 符合 mig-YYYYMMDD-00', () => {
  const db = makeDb('baseline-fresh');
  initSchema(db);
  const rows = batchesOf(db);
  assert.equal(rows.length, 1, '全新库应恰好一条基线');
  assert.equal(rows[0].name, 'schema-init');
  assert.equal(rows[0].status, 'committed');
  assert.match(rows[0].id, /^mig-\d{8}-00$/);
  const d = new Date();
  const expect = `mig-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-00`;
  assert.equal(rows[0].id, expect, '基线 id 应取当天日期 + 00');
});

test('B-02 重复 initSchema 不重复创建基线（同日与跨日都不新增）', () => {
  const db = makeDb('baseline-idem');
  initSchema(db);
  initSchema(db);
  initSchema(db);
  assert.equal(batchesOf(db).length, 1, '同一天重复初始化只能有一条基线');

  // 跨日也复用：直接调模型层换一个日期
  const store = createMigrateStore(db);
  const r = store.Batches.ensureBaseline({ date: new Date('2030-01-01T00:00:00Z'), scriptVer: 'x' });
  assert.equal(r.created, false, '已有基线就复用，不按天新建');
  assert.equal(r.reason, 'baseline_exists');
  assert.equal(batchesOf(db).length, 1);
});

test('B-03 既有业务迁移批次不被覆盖，基线照常共存', () => {
  const db = makeDb('baseline-coexist');
  initSchema(db);
  const t = Date.now();
  db.raw.prepare(`INSERT INTO migration_batches (id,name,script_ver,status,source_counts,target_counts,backup_path,backup_sha256,rollback_preview,rollback_counts,note,started_at,finished_at,rolled_back_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('mig-20260101-01', 'legacy-import', 'v1', 'committed', '{}', '{}', '', '', '', '{}', '', t, t, null);
  initSchema(db);
  const rows = batchesOf(db);
  assert.equal(rows.length, 2, '业务批次与基线共存');
  assert.equal(rows.find((r) => r.id === 'mig-20260101-01').name, 'legacy-import', '业务批次内容不得被改写');
  assert.equal(rows.filter((r) => r.name === 'schema-init').length, 1);
});

test('B-04 -00 被非基线批次占用 → 抛 MIG_BASELINE_ID_TAKEN，不覆盖', () => {
  const db = makeDb('baseline-taken');
  db.exec('CREATE TABLE IF NOT EXISTS migration_batches (id TEXT PRIMARY KEY, name TEXT DEFAULT \'\', script_ver TEXT DEFAULT \'\', status TEXT DEFAULT \'staged\', source_counts TEXT DEFAULT \'{}\', target_counts TEXT DEFAULT \'{}\', backup_path TEXT DEFAULT \'\', backup_sha256 TEXT DEFAULT \'\', rollback_preview TEXT DEFAULT \'\', rollback_counts TEXT DEFAULT \'{}\', note TEXT DEFAULT \'\', started_at INTEGER, finished_at INTEGER, rolled_back_at INTEGER)');
  const d = new Date();
  const id = `mig-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-00`;
  db.raw.prepare('INSERT INTO migration_batches (id,name,status,started_at) VALUES (?,?,?,?)').run(id, 'real-import', 'committed', Date.now());
  try {
    createMigrateStore(db).Batches.ensureBaseline({});
    assert.fail('应抛 MIG_BASELINE_ID_TAKEN');
  } catch (e) {
    assert.equal(e.code, 'MIG_BASELINE_ID_TAKEN');
  }
  const rows = batchesOf(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'real-import', '不得覆盖既有批次');
});

test('B-05 建表中途失败 → initSchema 抛出，且不产生"成功基线"', () => {
  const file = path.join(TMP, 'baseline-fail', 'ic.db');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  const db = {
    exec: (s) => {
      // 模拟第 5 张表建表失败（migration_batches 已建、业务表未全）
      if (/CREATE TABLE IF NOT EXISTS\s+shot_actions/.test(s)) throw new Error('模拟建表失败');
      return raw.exec(s);
    },
    prepare: (s) => raw.prepare(s),
    tableColumns: (t) => raw.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name),
    dialect: 'sqlite',
    raw,
    file,
  };
  assert.throws(() => initSchema(db), /模拟建表失败/);
  const n = raw.prepare('SELECT COUNT(*) n FROM migration_batches').get().n;
  assert.equal(n, 0, '结构没建完就不许留下成功基线');
  raw.close();
});
