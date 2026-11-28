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

// 阶段 3 · P0：默认**不打开真实库**。T-08 / T-09 / T-05b 的历史库分支会以只读方式打开
// data/ic.db —— 只读打开在 WAL 模式下仍会刷新 `ic.db-shm` 的 mtime（实测内容 SHA 不变，
// 但"测试运行不得触碰真实库"这条门槛不接受任何形式的写窗口）。要跑历史库核对时显式开启：
//   IC_ALLOW_REAL_DB_READ=1 npm test
// 指纹基线 REAL_SHA_AT_START 仍然在任何 lib 加载前取（只 readFile，不开 SQLite）。
const READ_REAL_DB = process.env.IC_ALLOW_REAL_DB_READ === '1';
const SKIP_REAL = '默认不接触真实库（只读打开也会刷新 -shm）；需 IC_ALLOW_REAL_DB_READ=1 显式开启';


// 先拿 env-guard（此时 IC_DATA_DIR 可能是未设置状态），再设隔离目录后加载 core
delete process.env.IC_DATA_DIR;
delete process.env.IC_DB_SQLITE_PATH;
const guardMod = await import('../lib/core/env-guard.js');
const { assertEnv, assertStage0Env, assertDbIsolation } = guardMod;

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
  if (!READ_REAL_DB) { t.skip(SKIP_REAL); return; }
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
test('T-09 业务数据保护：真库全程只读，测试结束时指纹与开跑前一致', (t) => {
  if (!READ_REAL_DB) { t.skip(SKIP_REAL); return; }
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

  // 阶段 1 起 `projects` 增加 `structured_spec`（D02-03 V3 §六 D-05）。
  // 阶段 0 的这份快照是"历史证据"、冻结不更新，所以在内存里补一条容忍，
  // 并**显式断言多出来的恰好是这一列**——这是把变化写清楚，不是放宽标准。
  manifest.tables.projects.tolerate_extra = ['structured_spec'];
  // P10-A A-03（D-30-08）给 `shot_videos` 补了 `input_hash`，同理：阶段 0 快照冻结不改，
  // 在内存里补一条容忍，并在下面**显式断言多出来的恰好是这一列**（不是放宽标准）。
  manifest.tables.shot_videos.tolerate_extra = ['input_hash'];

  const fresh = verifyManifest(path.join(FRESH, 'ic.db'), manifest);
  assert.equal(fresh.ok, true, '新库 manifest 校验应 PASS：' + JSON.stringify(fresh.tables.filter((x) => x.status === 'FAIL')));
  const shotsFresh = fresh.tables.find((x) => x.table === 'shots');
  assert.equal(shotsFresh.columnCount, 35);
  assert.deepEqual(shotsFresh.tolerated, [], '新库不应出现历史遗留列');
  const projFresh = fresh.tables.find((x) => x.table === 'projects');
  assert.deepEqual(projFresh.tolerated, ['structured_spec'], '阶段 1 起 projects 必须恰好多这一列');
  assert.equal(projFresh.columnCount, 22);
  const svFresh = fresh.tables.find((x) => x.table === 'shot_videos');
  assert.deepEqual(svFresh.tolerated, ['input_hash'], '阶段 A 起 shot_videos 必须恰好多这一列');
  assert.equal(svFresh.columnCount, 10);

  if (!READ_REAL_DB || !fs.existsSync(REAL_DB)) return;
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
  const r = spawnSync(process.execPath, [PROBE], { env, encoding: 'utf8', cwd: BASE });
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

// ── A-01 悬空文件符号链接（第二轮复核: existsSync 判不出"目标不存在的链接"） ──────
// 每条用例仍在独立进程里跑；链接必须建在隔离目录**内**，目标在隔离目录**外**。
function tryFileLink(target, link) {
  try { fs.symlinkSync(target, link, 'file'); return true; } catch { return false; }
}

test('A-01-8 文件软链指向外部已存在文件 → 拒绝，且外部文件内容未被改动', (t) => {
  const iso = path.join(BASE, 'a01-filelink-exist', 'iso');
  const outsideDir = path.join(BASE, 'a01-filelink-exist', 'outside');
  fs.mkdirSync(iso, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  const target = path.join(outsideDir, 'victim.db');
  fs.writeFileSync(target, 'ORIGINAL-NOT-A-DATABASE');
  const link = path.join(iso, 'ic.db');
  if (!tryFileLink(target, link)) { t.skip('当前环境不允许创建文件符号链接（Windows 需管理员或开发者模式）'); return; }

  const r = runProbe({ IC_DATA_DIR: iso, IC_DB_SQLITE_PATH: link });
  assert.equal(r.ok, false, '指向外部的文件软链必须被拒绝');
  assert.equal(r.code, 'IC_DB_PATH_OUTSIDE_DATA_DIR');
  assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL-NOT-A-DATABASE', '拒绝必须发生在打开之前：外部文件一个字节都不许动');
});

test('A-01-9 文件软链指向外部尚不存在的文件（悬空链接）→ 拒绝，且外部文件未被创建', (t) => {
  const iso = path.join(BASE, 'a01-filelink-dangling', 'iso');
  const outsideDir = path.join(BASE, 'a01-filelink-dangling', 'outside');
  fs.mkdirSync(iso, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  const target = path.join(outsideDir, 'escaped.db');
  const link = path.join(iso, 'ic.db');
  if (!tryFileLink(target, link)) { t.skip('当前环境不允许创建文件符号链接（Windows 需管理员或开发者模式）'); return; }

  assert.equal(fs.existsSync(link), false, '前提：悬空链接在 existsSync 下就是 false（旧实现的判断依据）');
  const r = runProbe({ IC_DATA_DIR: iso, IC_DB_SQLITE_PATH: link });
  assert.equal(r.ok, false, '悬空文件软链同样必须被拒绝');
  assert.equal(r.code, 'IC_DB_PATH_OUTSIDE_DATA_DIR');
  assert.equal(fs.existsSync(target), false, '外部目标文件不得被创建（SQLite 不得跟随链接在隔离目录外建库）');
});

test('A-01-10 相对目标的悬空链接（../outside/x.db）→ 按链接目标拒绝，外部不落文件', (t) => {
  const root = path.join(BASE, 'a01-filelink-relative');
  const iso = path.join(root, 'iso');
  const outsideDir = path.join(root, 'outside-rel');
  fs.mkdirSync(iso, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  const link = path.join(iso, 'ic.db');
  if (!tryFileLink(path.join('..', 'outside-rel', 'escaped.db'), link)) { t.skip('当前环境不允许创建文件符号链接'); return; }

  const r = runProbe({ IC_DATA_DIR: iso, IC_DB_SQLITE_PATH: link });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'IC_DB_PATH_OUTSIDE_DATA_DIR');
  assert.equal(fs.existsSync(path.join(outsideDir, 'escaped.db')), false, '相对链接也必须按目标判定');
});

test('A-01-11 多级尚不存在的隔离目录 + 默认库路径 → 仍然放行并建库（不过度收紧）', () => {
  const iso = path.join(BASE, 'a01-nested', 'a', 'b', 'c');
  const r = runProbe({ IC_DATA_DIR: iso });
  assert.equal(r.ok, true, '合法隔离目录不得被误拒：' + r.message);
  assert.equal(path.resolve(r.sqlitePath), path.resolve(path.join(iso, 'ic.db')));
  assert.equal(r.dbExists, true);
  assert.equal(fs.lstatSync(path.join(iso, 'ic.db')).isSymbolicLink(), false, '正常建库不应产生链接');
});

// ── 解析器本身的边界（不经环境变量：直接喂原始路径给 assertDbIsolation） ─────────
test('A-01-12 链接后接 `..` 的逃逸（iso/jdir/../ic.db，jdir 指向外部）→ 按物理解析拒绝', (t) => {
  const root = path.join(BASE, 'a01-link-dotdot');
  const iso = path.join(root, 'iso');
  const outsideDir = path.join(root, 'outside');
  fs.mkdirSync(iso, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  const jdir = path.join(iso, 'jdir');
  if (!tryLink(outsideDir, jdir)) { t.skip('当前环境不允许创建目录符号链接'); return; }

  // 必须用字符串拼接：path.join(iso,'jdir','..','ic.db') 会先词法折叠成 iso/ic.db，
  // 那样测到的是 path.join，不是解析器。OS 的语义是"先跟随 jdir，再 .."，落点在 root/ic.db。
  const raw = iso + path.sep + 'jdir' + path.sep + '..' + path.sep + 'ic.db';
  assert.throws(
    () => assertDbIsolation({ dataDir: iso, dbPath: raw, purpose: 'A-01-12' }),
    (e) => e.code === 'IC_DB_PATH_OUTSIDE_DATA_DIR',
    '词法折叠会把这个路径洗成 iso/ic.db，物理解析必须落回 root/ic.db 并拒绝',
  );
});

test('A-01-13 链接链 a→b→外部 必须跟到底；a↔b 循环报 PATH_SYMLINK_LOOP', (t) => {
  const root = path.join(BASE, 'a01-chain');
  const iso = path.join(root, 'iso');
  const outsideDir = path.join(root, 'outside');
  fs.mkdirSync(iso, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });

  // 链：a.db → b.db → 外部/chain.db（两级链接，只解析一层会误判成"内部"）
  const a = path.join(iso, 'a.db');
  const b = path.join(iso, 'b.db');
  if (!tryFileLink(b, a) || !tryFileLink(path.join(outsideDir, 'chain.db'), b)) {
    t.skip('当前环境不允许创建文件符号链接'); return;
  }
  assert.throws(
    () => assertDbIsolation({ dataDir: iso, dbPath: a, purpose: 'A-01-13 chain' }),
    (e) => e.code === 'IC_DB_PATH_OUTSIDE_DATA_DIR',
    '链接必须递归解析到最终目标，否则会被当成隔离目录内的普通文件',
  );

  // 环：x ↔ y（读到读不到都不许挂起，也不许当成内部）
  const x = path.join(iso, 'x.db');
  const y = path.join(iso, 'y.db');
  if (!tryFileLink(y, x) || !tryFileLink(x, y)) { t.skip('当前环境不允许创建第二组文件符号链接'); return; }
  assert.throws(
    () => assertDbIsolation({ dataDir: iso, dbPath: x, purpose: 'A-01-13 loop' }),
    (e) => e.code === 'PATH_SYMLINK_LOOP',
  );
});

// ── A-01 解析失败必须拒（第三轮复核）：真实 FS 几乎造不出"能 lstat 不能 readlink"，用注入 ──
// 注入只换 io 实现，判定逻辑一字不改；真实文件系统的链接用例（A-01-4/6/8~13）仍在跑。
function fakeIo({ onLstat, onReadlink } = {}) {
  return {
    lstatSync: (p) => (onLstat ? onLstat(p) : { isSymbolicLink: () => false }),
    readlinkSync: (p) => (onReadlink ? onReadlink(p) : ''),
    realpathSync: (p) => p,
  };
}
const isDbFile = (p) => path.basename(p).toLowerCase() === 'ic.db';

test('A-01-14 能识别为链接但读不出目标 → PATH_SYMLINK_UNRESOLVED，且不返回"看似合法"的路径', () => {
  const iso = path.join(BASE, 'a01-unresolved', 'iso');
  const dbPath = path.join(iso, 'ic.db');
  const io = fakeIo({
    onLstat: (p) => (isDbFile(p) ? { isSymbolicLink: () => true } : { isSymbolicLink: () => false }),
    onReadlink: () => {
      const e = new Error('EACCES: permission denied, readlink');
      e.code = 'EACCES';
      throw e;
    },
  });

  let detail = null;
  assert.throws(
    () => assertDbIsolation({ dataDir: iso, dbPath, purpose: 'A-01-14', io }),
    (e) => {
      detail = e;
      return e.code === 'PATH_SYMLINK_UNRESOLVED';
    },
    '读不出链接目标时不得按"链接所在位置"判为合法',
  );
  assert.equal(detail.detail.path, dbPath, '错误详情应带当前路径');
  assert.equal(detail.detail.code, 'EACCES', '错误详情应带底层错误码');
  assert.ok(String(detail.detail.target).includes('ic.db'), '错误详情应带原始目标路径');

  // 也不能悄悄放过：resolvePathDetail 同样必须抛，而不是回退成原路径
  const { resolvePathDetail } = guardMod;
  assert.throws(() => resolvePathDetail(dbPath, io), (e) => e.code === 'PATH_SYMLINK_UNRESOLVED');
});

test('A-01-15 lstat 抛 EACCES/EPERM → PATH_RESOLUTION_FAILED；ENOENT/ENOTDIR 仍按不存在放行', () => {
  const iso = path.join(BASE, 'a01-eacces', 'iso');
  const dbPath = path.join(iso, 'ic.db');

  for (const code of ['EACCES', 'EPERM', 'ELOOP', 'EIO']) {
    const io = fakeIo({
      onLstat: (p) => {
        if (!isDbFile(p)) return { isSymbolicLink: () => false };
        const e = new Error(`${code}: cannot access`);
        e.code = code;
        throw e;
      },
    });
    assert.throws(
      () => assertDbIsolation({ dataDir: iso, dbPath, purpose: 'A-01-15', io }),
      (e) => e.code === 'PATH_RESOLUTION_FAILED' && e.detail.code === code,
      `${code} 不得被当成"路径不存在"`,
    );
  }

  // 反向断言：ENOENT / ENOTDIR 必须仍然放行（正常"库还没建"就靠这条）
  for (const code of ['ENOENT', 'ENOTDIR']) {
    const io = fakeIo({
      onLstat: (p) => {
        if (!isDbFile(p)) return { isSymbolicLink: () => false };
        const e = new Error(`${code}: no such entry`);
        e.code = code;
        throw e;
      },
    });
    const r = assertDbIsolation({ dataDir: iso, dbPath, purpose: 'A-01-15 ok', io });
    assert.equal(r.enforced, true, `${code} 应视为"尚未创建"，不得拒绝`);
    assert.equal(path.basename(r.dbPath), 'ic.db');
  }
});

test('A-01-16 五级尚不存在的隔离目录 + 默认库路径 → 放行、建库、且是普通文件', () => {
  const iso = path.join(BASE, 'a01-deep', 'x', 'y', 'z', 'w');
  const r = runProbe({ IC_DATA_DIR: iso });
  assert.equal(r.ok, true, '合法隔离目录不得被误拒：' + r.message);
  assert.equal(path.resolve(r.sqlitePath), path.resolve(path.join(iso, 'ic.db')));
  assert.equal(r.dbExists, true);
  assert.equal(fs.lstatSync(path.join(iso, 'ic.db')).isSymbolicLink(), false, '建出的必须是普通文件');
  assert.equal(fs.lstatSync(path.join(iso, 'ic.db')).isFile(), true);
});

test('A-01-17 隔离矩阵回归：四类绕过在真实文件系统上仍全部被拒且不落文件', (t) => {
  const root = path.join(BASE, 'a01-matrix');
  const iso = path.join(root, 'iso');
  const outsideDir = path.join(root, 'outside');
  fs.mkdirSync(iso, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });

  // ① IC_DB_SQLITE_PATH 指外部
  const p1 = path.join(outsideDir, 'env.db');
  assert.equal(runProbe({ IC_DATA_DIR: iso, IC_DB_SQLITE_PATH: p1 }).code, 'IC_DB_PATH_OUTSIDE_DATA_DIR');
  assert.equal(fs.existsSync(p1), false);

  // ② config.json 的 db.sqlite.path 指外部
  const p2 = path.join(outsideDir, 'cfg.db');
  const cfgFile = path.join(root, 'cfg.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ db: { provider: 'sqlite', sqlite: { path: p2 } } }), 'utf8');
  assert.equal(runProbe({ IC_DATA_DIR: iso, IC_CONFIG: cfgFile }).code, 'IC_DB_PATH_OUTSIDE_DATA_DIR');
  assert.equal(fs.existsSync(p2), false);

  // ③ 悬空文件软链 → 外部
  const danglingLink = path.join(iso, 'dangling.db');
  const p3 = path.join(outsideDir, 'dangling.db');
  if (!tryFileLink(p3, danglingLink)) { t.skip('当前环境不允许创建文件符号链接'); return; }
  assert.equal(runProbe({ IC_DATA_DIR: iso, IC_DB_SQLITE_PATH: danglingLink }).code, 'IC_DB_PATH_OUTSIDE_DATA_DIR');
  assert.equal(fs.existsSync(p3), false);

  // ④ 目录 junction → 外部
  const jdir = path.join(iso, 'jdir');
  if (!tryLink(outsideDir, jdir)) { t.skip('当前环境不允许创建目录符号链接'); return; }
  assert.equal(runProbe({ IC_DATA_DIR: iso, IC_DB_SQLITE_PATH: path.join(jdir, 'dir.db') }).code, 'IC_DB_PATH_OUTSIDE_DATA_DIR');
  assert.equal(fs.existsSync(path.join(outsideDir, 'dir.db')), false);

  // ⑤ 同一隔离目录在没有任何绕过时仍能建库（证明上面四条不是因为"全都拒"才通过）
  const ok = runProbe({ IC_DATA_DIR: iso });
  assert.equal(ok.ok, true, '合法路径必须放行：' + ok.message);
});
