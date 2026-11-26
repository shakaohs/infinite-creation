// 阶段 0 验收测试（D02-02 阶段 0 任务书 §4：T-01 ~ T-09）
//
// 约定：所有库操作都在 os.tmpdir() 下的隔离目录内完成；真实库 data/ic.db 只以只读方式
// 打开一次（T-08/T-09），并且**先复制再操作**——测试结束时用 SHA-256 证明它没被写过。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-stage0-'));
const FRESH = path.join(BASE, 'fresh');
const REAL_DB = path.resolve('data', 'ic.db');
const MANIFEST = path.resolve('scripts', 'stage0', 'schema-manifest.stage0.json');

const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// 真库指纹基线：在任何 lib 代码加载之前取。整份测试跑完后 T-09 会比对——
// 这条断言存在的理由很具体：阶段 0 第一版测试因为 import 顺序错误，core 连到了 data/ic.db，
// 往真库里写了 2 个项目 4 条分镜。指纹基线能在第一时间把这种事故变成一条红色断言。
const REAL_SHA_AT_START = fs.existsSync(REAL_DB) ? sha256(REAL_DB) : null;

// 先拿 env-guard（此时 IC_DATA_DIR 可能是未设置状态），再设隔离目录后加载 core
delete process.env.IC_DATA_DIR;
delete process.env.IC_DB_SQLITE_PATH;
const { assertEnv, assertStage0Env } = await import('../lib/core/env-guard.js');

process.env.IC_DATA_DIR = FRESH;
const dbMod = await import('../lib/core/db.js');
const { initSchema, ensureColumn, Projects, Shots, getDb } = dbMod;
// DB_PATH 属于 config，必须在 IC_DATA_DIR 设好之后再取（config 在加载时固化路径）
const { DB_PATH } = await import('../lib/core/config.js');
const { verifyManifest } = await import('../scripts/stage0/verify-manifest.mjs');

test.after(() => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* Windows 上库文件可能仍被占用 */ } });

// ── T-01 ────────────────────────────────────────────────────────────────
test('T-01 未设置 IC_DATA_DIR → assertEnv 抛 IC_DATA_DIR_NOT_SET', () => {
  const saved = process.env.IC_DATA_DIR;
  delete process.env.IC_DATA_DIR;
  try {
    assert.throws(() => assertEnv({ purpose: 'T-01' }), (e) => e.code === 'IC_DATA_DIR_NOT_SET');
    // 空串也算未设置
    process.env.IC_DATA_DIR = '   ';
    assert.throws(() => assertEnv({ purpose: 'T-01' }), (e) => e.code === 'IC_DATA_DIR_NOT_SET');
  } finally {
    process.env.IC_DATA_DIR = saved;
  }
});

// ── T-02 ────────────────────────────────────────────────────────────────
test('T-02 设置合法隔离目录 → assertEnv 通过；相对路径与生产目录被拒', () => {
  const r = assertStage0Env('T-02');
  assert.equal(path.resolve(r.dataDir), path.resolve(FRESH));
  assert.equal(path.resolve(r.dbPath), path.resolve(path.join(FRESH, 'ic.db')));

  const saved = process.env.IC_DATA_DIR;
  try {
    process.env.IC_DATA_DIR = 'relative/dir';
    assert.throws(() => assertEnv({ purpose: 'T-02' }), (e) => e.code === 'IC_DATA_DIR_NOT_ABSOLUTE');

    // 生产目录本体与其子目录都必须被拒
    const prod = path.resolve('data');
    process.env.IC_DATA_DIR = prod;
    assert.throws(() => assertEnv({ purpose: 'T-02' }), (e) => e.code === 'IC_DATA_DIR_IS_DEFAULT');
    process.env.IC_DATA_DIR = path.join(prod, 'projects');
    assert.throws(() => assertEnv({ purpose: 'T-02' }), (e) => e.code === 'IC_DATA_DIR_INSIDE_PRODUCTION');
  } finally {
    process.env.IC_DATA_DIR = saved;
  }
});

// ── T-03 ────────────────────────────────────────────────────────────────
test('T-03 全新库初始化：shots 35 列含 blocking，重复 initSchema 不报错', () => {
  const db = getDb();
  assert.equal(path.resolve(DB_PATH), path.resolve(path.join(FRESH, 'ic.db')), '测试库必须落在隔离目录内');
  const cols = db.tableColumns('shots');
  assert.equal(cols.length, 35, '新库 shots 应为 35 列');
  assert.ok(cols.includes('blocking'), '新库 shots 必须含 blocking');
  assert.ok(!cols.includes('seam') && !cols.includes('storyboard_sheet'), '新库不应建历史遗留列');
  initSchema(db); // 第二次
  initSchema(db); // 第三次
  assert.equal(db.tableColumns('shots').length, 35, '重复初始化不得改变列数');
});

// ── T-04 ────────────────────────────────────────────────────────────────
test('T-04 Shots.create / get：blocking 可写可读，未传时为默认空串', () => {
  const p = Projects.create({ name: 'T-04 项目' });
  const s1 = Shots.create(p.id, { idx: 1, chapter: '第1章', visual: '中景', blocking: 'A 左 B 右', duration: 4 });
  const s2 = Shots.create(p.id, { idx: 2, chapter: '第1章', visual: '空镜', duration: 3 });
  assert.equal(Shots.get(s1.id).blocking, 'A 左 B 右');
  assert.equal(Shots.get(s2.id).blocking, '');
  assert.equal(typeof Shots.get(s1.id).blocking, 'string');
});

// ── T-05 ────────────────────────────────────────────────────────────────
test('T-05 blocking 幂等：连续两次 initSchema 结果一致，数据不被覆盖', () => {
  const db = getDb();
  const before = db.prepare('SELECT id, blocking FROM shots ORDER BY idx').all();
  const added = ensureColumn(db, 'shots', 'blocking', "blocking TEXT DEFAULT ''");
  assert.equal(added, false, '列已存在时 ensureColumn 必须返回 false（不做 ALTER）');
  initSchema(db);
  initSchema(db);
  const after = db.prepare('SELECT id, blocking FROM shots ORDER BY idx').all();
  assert.deepEqual(after, before, '重复 initSchema 后数据必须完全一致');
  assert.equal(db.tableColumns('shots').length, 35);
});

// ── T-06 / T-07 ─────────────────────────────────────────────────────────
test('T-06 备份恢复：删除测试库后从备份恢复，行数一致；T-07 integrity_check = ok', () => {
  const src = path.join(FRESH, 'ic.db');
  const bakDir = path.join(BASE, 'backup'); fs.mkdirSync(bakDir, { recursive: true });
  const bak = path.join(bakDir, 'ic-backup.db');
  const restoreDir = path.join(BASE, 'restore'); fs.mkdirSync(restoreDir, { recursive: true });
  const restored = path.join(restoreDir, 'ic.db');

  const counts = (file) => {
    const d = new DatabaseSync(file, { readOnly: true });
    try {
      return {
        shots: d.prepare('SELECT COUNT(*) AS n FROM shots').get().n,
        projects: d.prepare('SELECT COUNT(*) AS n FROM projects').get().n,
        chapters: d.prepare('SELECT COUNT(*) AS n FROM chapters').get().n,
        integrity: d.prepare('PRAGMA integrity_check').get().integrity_check,
      };
    } finally { d.close(); }
  };

  const s = new DatabaseSync(src, { readOnly: true });
  s.exec(`VACUUM INTO '${bak.replace(/\\/g, '/').replace(/'/g, "''")}'`);
  s.close();

  const before = counts(src);
  const bakSha = sha256(bak);
  assert.equal(sha256(bak), bakSha, '备份 SHA-256 必须可复算一致');
  assert.equal(counts(bak).integrity, 'ok', '备份 integrity_check 应为 ok');
  assert.equal(counts(bak).shots, before.shots, '备份行数应与源一致');

  // 第一次恢复 → 删除测试库 → 再从备份恢复
  fs.copyFileSync(bak, restored);
  assert.equal(counts(restored).shots, before.shots);
  fs.rmSync(restored, { force: true });
  assert.equal(fs.existsSync(restored), false, '测试库应已删除');
  fs.copyFileSync(bak, restored);

  const afterRestore = counts(restored);
  assert.equal(afterRestore.integrity, 'ok', 'T-07 恢复后 integrity_check 必须为 ok');
  assert.equal(afterRestore.shots, before.shots, 'T-06 恢复后 shots 行数一致');
  assert.equal(afterRestore.projects, before.projects);
  assert.equal(afterRestore.chapters, before.chapters);
});

// ── T-08 ────────────────────────────────────────────────────────────────
test('T-08 历史库结构核对：VACUUM INTO 取一致副本后 initSchema，不丢历史列 / blocking / 行数', (t) => {
  if (!fs.existsSync(REAL_DB)) { t.skip('真实库 data/ic.db 不存在，跳过'); return; }
  const copyDir = path.join(BASE, 'legacy'); fs.mkdirSync(copyDir, { recursive: true });
  const copy = path.join(copyDir, 'ic.db');

  // 只读打开真库 → VACUUM INTO 生成一致快照（B-01）。
  // 直接 copyFileSync 在 WAL 模式下可能漏掉 -wal 里已提交的页：副本"少几个事务"，
  // 而结构核对恰恰要以"完整的历史库"为前提，否则等于拿残缺样本证明没丢列。
  const ro = new DatabaseSync(REAL_DB, { readOnly: true });
  ro.exec(`VACUUM INTO '${copy.replace(/\\/g, '/').replace(/'/g, "''")}'`);
  const realCounts = {
    shots: ro.prepare('SELECT COUNT(*) AS n FROM shots').get().n,
    chapters: ro.prepare('SELECT COUNT(*) AS n FROM chapters').get().n,
    assets: ro.prepare('SELECT COUNT(*) AS n FROM assets').get().n,
    blocking: ro.prepare("SELECT COUNT(*) AS n FROM shots WHERE blocking <> ''").get().n,
  };
  ro.close();

  const raw = new DatabaseSync(copy);
  const db = {
    exec: (s) => raw.exec(s),
    prepare: (s) => raw.prepare(s),
    tableColumns: (tb) => raw.prepare(`PRAGMA table_info(${tb})`).all().map((c) => c.name),
  };
  const beforeCols = db.tableColumns('shots');
  const beforeRows = raw.prepare("SELECT COUNT(*) AS n FROM shots WHERE blocking <> ''").get().n;

  // 副本行数必须与真库一致（证明快照完整，而不是"少几页也能跑"）
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM shots').get().n, realCounts.shots, '副本 shots 行数应与真库一致');
  assert.equal(beforeRows, realCounts.blocking, '副本 blocking 非空数应与真库一致');

  initSchema(db); // 历史库上跑迁移：不该删列、不该重复加列
  initSchema(db);

  const afterCols = db.tableColumns('shots');
  assert.deepEqual(afterCols, beforeCols, '历史库列集合必须与迁移前完全一致');
  assert.ok(afterCols.includes('seam'), 'seam 历史列不得被删除');
  assert.ok(afterCols.includes('storyboard_sheet'), 'storyboard_sheet 历史列不得被删除');
  assert.ok(afterCols.includes('blocking'), 'blocking 列必须存在');
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM shots WHERE blocking <> ''").get().n, beforeRows, 'blocking 数据不得被覆盖');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM shots').get().n, realCounts.shots, '迁移后行数不得变化');
  assert.equal(raw.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  raw.close();
});

// ── T-09 ────────────────────────────────────────────────────────────────
test('T-09 业务数据保护：真库全程只读，测试结束时指纹与开跑前一致', () => {
  if (!fs.existsSync(REAL_DB)) return;
  const d = new DatabaseSync(REAL_DB, { readOnly: true });
  const n = d.prepare('SELECT COUNT(*) AS n FROM shots').get().n;
  d.close();
  assert.ok(n > 0, '真实库应有分镜数据（本测试只读）');
  assert.equal(sha256(REAL_DB), REAL_SHA_AT_START, '真实库 SHA-256 在整轮测试前后必须一致（说明从未以写方式打开）');
});

// ── Manifest ────────────────────────────────────────────────────────────
test('T-05b Manifest：新库 PASS；历史库副本 PASS 且 seam/storyboard_sheet 记为 tolerated', (t) => {
  if (!fs.existsSync(MANIFEST)) { t.skip('manifest 未生成，先跑 scripts/stage0/gen-manifest.mjs'); return; }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

  const fresh = verifyManifest(path.join(FRESH, 'ic.db'), manifest);
  assert.equal(fresh.ok, true, '新库 manifest 校验应 PASS：' + JSON.stringify(fresh.tables.filter((x) => x.status === 'FAIL')));
  const shotsFresh = fresh.tables.find((x) => x.table === 'shots');
  assert.equal(shotsFresh.columnCount, 35);
  assert.deepEqual(shotsFresh.tolerated, [], '新库不应出现历史遗留列');

  if (!fs.existsSync(REAL_DB)) return;
  const legacyCopy = path.join(BASE, 'legacy', 'ic.db');
  if (!fs.existsSync(legacyCopy)) return;
  const r = verifyManifest(legacyCopy, manifest);
  const shotsLegacy = r.tables.find((x) => x.table === 'shots');
  assert.equal(r.ok, true, '历史库副本 manifest 校验应 PASS');
  assert.deepEqual(shotsLegacy.tolerated.sort(), ['seam', 'storyboard_sheet'], '历史列应被记为 tolerated 而不是 unknownExtra');
  assert.equal(shotsLegacy.columnCount, 37);
});

// ── A-01 数据库隔离矩阵（每条场景起独立进程：config 在加载时固化路径） ──────
const PROBE = path.resolve('tests', 'helpers', 'db-guard-probe.mjs');

function runProbe(overrides = {}) {
  const env = { ...process.env };
  for (const k of ['IC_DATA_DIR', 'IC_DB_SQLITE_PATH', 'IC_CONFIG', 'IC_DB', 'DATABASE_URL']) delete env[k];
  Object.assign(env, overrides);
  const r = spawnSync(process.execPath, [PROBE], { env, encoding: 'utf8', cwd: process.cwd() });
  const line = String(r.stdout || '').split('\n').filter((l) => l.startsWith('PROBE ')).pop();
  assert.ok(line, '探针未输出结果：' + String(r.stderr || '').slice(0, 400));
  return JSON.parse(line.slice(6));
}

// Windows 上目录软链需要额外权限，junction 不需要；两者都不行时返回 false 由用例 skip
function tryLink(target, link) {
  try { fs.symlinkSync(target, link, 'junction'); return true; } catch { /* 落到下面 */ }
  try { fs.symlinkSync(target, link, 'dir'); return true; } catch { return false; }
}

test('A-01-1 正常隔离目录：放行，且实际库文件落在隔离目录内', () => {
  const iso = path.join(BASE, 'a01-ok');
  const r = runProbe({ IC_DATA_DIR: iso });
  assert.equal(r.ok, true, '应放行：' + r.message);
  assert.equal(r.sqlitePathSource, 'default:DATA_DIR/ic.db');
  assert.equal(path.resolve(r.sqlitePath), path.resolve(path.join(iso, 'ic.db')));
  assert.equal(r.dbExists, true, '放行后应真的建出库文件');
});

test('A-01-2 IC_DB_SQLITE_PATH 指向隔离目录之外 → 打开前拒绝，且不产生文件', () => {
  const iso = path.join(BASE, 'a01-envpath');
  const outside = path.join(BASE, 'outside-env', 'ic.db');
  const r = runProbe({ IC_DATA_DIR: iso, IC_DB_SQLITE_PATH: outside });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'IC_DB_PATH_OUTSIDE_DATA_DIR');
  assert.equal(fs.existsSync(outside), false, '拒绝必须发生在建库之前（外部路径不许出现文件）');
});

test('A-01-3 config.json 的 db.sqlite.path 指向隔离目录之外 → 同样拒绝', () => {
  const iso = path.join(BASE, 'a01-cfgpath');
  const outside = path.join(BASE, 'outside-cfg', 'ic.db');
  const cfgFile = path.join(BASE, 'cfg-external.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ db: { provider: 'sqlite', sqlite: { path: outside } } }), 'utf8');
  const r = runProbe({ IC_DATA_DIR: iso, IC_CONFIG: cfgFile });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'IC_DB_PATH_OUTSIDE_DATA_DIR');
  assert.equal(r.sqlitePathSource === 'config:db.sqlite.path' || r.ok === false, true);
  assert.equal(fs.existsSync(outside), false, '拒绝必须发生在建库之前');
});

test('A-01-4 隔离目录内的符号链接指向外部 → 按真实路径拒绝', (t) => {
  const iso = path.join(BASE, 'a01-link');
  const outsideDir = path.join(BASE, 'outside-link');
  fs.mkdirSync(iso, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  const link = path.join(iso, 'escape');
  if (!tryLink(outsideDir, link)) { t.skip('当前环境不允许创建目录符号链接'); return; }

  const target = path.join(link, 'ic.db');
  const r = runProbe({ IC_DATA_DIR: iso, IC_DB_SQLITE_PATH: target });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'IC_DB_PATH_OUTSIDE_DATA_DIR');
  assert.equal(fs.existsSync(path.join(outsideDir, 'ic.db')), false, '符号链接外部的库文件不得被创建');
});

test('A-01-5 生产目录及其子目录 → 拒绝（IS_DEFAULT / INSIDE_PRODUCTION）', () => {
  const prod = path.resolve('data');
  const r1 = runProbe({ IC_DATA_DIR: prod });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'IC_DATA_DIR_IS_DEFAULT');

  const r2 = runProbe({ IC_DATA_DIR: path.join(prod, 'projects') });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'IC_DATA_DIR_INSIDE_PRODUCTION');
});

test('A-01-6 IC_DATA_DIR 是指向生产目录的符号链接 → 按真实路径拒绝', (t) => {
  const prod = path.resolve('data');
  const link = path.join(BASE, 'prod-link');
  if (!tryLink(prod, link)) { t.skip('当前环境不允许创建目录符号链接'); return; }
  const r = runProbe({ IC_DATA_DIR: link });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'IC_DATA_DIR_SYMLINK_TO_PRODUCTION');
});

test('A-01-7 相对路径 → 拒绝', () => {
  const r = runProbe({ IC_DATA_DIR: 'relative/dir' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'IC_DATA_DIR_NOT_ABSOLUTE');
});
