// 阶段 3 · P0：测试环境隔离的自动化验收（对应 P0 执行任务书 §4.3 步骤3 的八条场景）。
//
// 本文件**不 import 任何 lib/core 业务模块**（那会在本进程里开库）；所有断言都在独立子进程里做：
//   · scripts/test-runner.mjs --check  → 入口前置校验（不跑测试、不建库）
//   · tests/helpers/db-guard-probe.mjs → 真的过守卫 + 开库，把结果打成一行 JSON
//
// 为什么必须独立进程：config.js 在模块加载时就把 IC_DATA_DIR 固化成 DATA_DIR/DB_PATH，
// 同进程里换环境变量再 import 不生效，测到的会是上一场景的模块缓存。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(ROOT, 'scripts', 'test-runner.mjs');
const PROBE = path.join(ROOT, 'tests', 'helpers', 'db-guard-probe.mjs');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-p0-'));

const real = (p) => {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
};
const same = (a, b) => {
  const norm = (x) => (process.platform === 'win32' ? x.toLowerCase() : x);
  return norm(real(a)) === norm(real(b));
};

/** 干净环境：删掉一切能把库指到别处的变量，避免宿主机环境影响结论 */
function cleanEnv() {
  const env = { ...process.env };
  for (const k of ['IC_DATA_DIR', 'IC_DB_SQLITE_PATH', 'IC_DB', 'DATABASE_URL', 'IC_CONFIG']) delete env[k];
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function runRunner(overrides = {}) {
  const env = { ...cleanEnv(), ...overrides };
  const r = spawnSync(process.execPath, [RUNNER, '--check'], { env, cwd: ROOT, encoding: 'utf8' });
  const line = String(r.stdout || '').split('\n').filter((l) => l.startsWith('TEST-RUNNER ')).pop();
  assert.ok(line, 'runner 未输出结果：' + String(r.stderr || '').slice(0, 400));
  return { status: r.status, json: JSON.parse(line.slice('TEST-RUNNER '.length)), err: String(r.stderr || '') };
}

function runProbe(overrides = {}) {
  const env = { ...cleanEnv(), ...overrides };
  const r = spawnSync(process.execPath, [PROBE], { env, cwd: ROOT, encoding: 'utf8' });
  const line = String(r.stdout || '').split('\n').filter((l) => l.startsWith('PROBE ')).pop();
  assert.ok(line, '探针未输出结果：' + String(r.stderr || '').slice(0, 400));
  return { status: r.status, json: JSON.parse(line.slice('PROBE '.length)) };
}

// Windows 上目录软链要额外权限，junction 不需要；都不行时用例 skip
function tryJunction(target, link) {
  try { fs.symlinkSync(target, link, 'junction'); return true; } catch { /* 落到下面 */ }
  try { fs.symlinkSync(target, link, 'dir'); return true; } catch { return false; }
}

// ── 1. 入口：未设置 IC_DATA_DIR → 拒绝运行 ────────────────────────────────
test('P0-T1 未设置 IC_DATA_DIR → 测试入口拒绝运行（退出码 2，不启动测试进程）', () => {
  const r = runRunner();
  assert.equal(r.status, 2, '必须拒绝：' + JSON.stringify(r.json));
  assert.equal(r.json.ok, false);
  assert.equal(r.json.code, 'IC_DATA_DIR_NOT_SET');
  assert.match(r.err, /IC_DATA_DIR/);
});

// ── 2. 入口：合法隔离目录 → 放行，且库路径落在目录内 ──────────────────────
test('P0-T2 合法隔离目录 → 入口放行，报告的实际库文件位于隔离目录内', () => {
  const iso = path.join(BASE, 't2-ok');
  const r = runRunner({ IC_DATA_DIR: iso });
  assert.equal(r.status, 0, '应放行：' + JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.equal(r.json.checkOnly, true);
  assert.ok(same(r.json.dataDir, iso), `dataDir 应为 ${iso}，实际 ${r.json.dataDir}`);
  assert.ok(same(r.json.dbPath, path.join(iso, 'ic.db')), `dbPath 应为 ${iso}/ic.db，实际 ${r.json.dbPath}`);
  assert.equal(r.json.dbPathSource, 'default:DATA_DIR/ic.db');
});

// ── 3. 入口：相对路径 / 生产目录 / 生产目录子目录 → 拒绝 ───────────────────
test('P0-T3 IC_DATA_DIR 相对路径 → 拒绝（NOT_ABSOLUTE）', () => {
  const r = runRunner({ IC_DATA_DIR: 'relative/dir' });
  assert.equal(r.status, 2);
  assert.equal(r.json.code, 'IC_DATA_DIR_NOT_ABSOLUTE');
});

test('P0-T4 IC_DATA_DIR 指向生产目录或其子目录 → 拒绝（IS_DEFAULT / INSIDE_PRODUCTION）', () => {
  const prod = path.join(ROOT, 'data');
  const a = runRunner({ IC_DATA_DIR: prod });
  assert.equal(a.status, 2);
  assert.equal(a.json.code, 'IC_DATA_DIR_IS_DEFAULT');

  const b = runRunner({ IC_DATA_DIR: path.join(prod, 'projects') });
  assert.equal(b.status, 2);
  assert.equal(b.json.code, 'IC_DATA_DIR_INSIDE_PRODUCTION');
});

test('P0-T5 IC_DATA_DIR 是 junction 指向生产目录 → 按真实路径拒绝', (t) => {
  const link = path.join(BASE, 't5-prod-link');
  if (!tryJunction(path.join(ROOT, 'data'), link)) { t.skip('当前环境不允许创建目录链接'); return; }
  const r = runRunner({ IC_DATA_DIR: link });
  assert.equal(r.status, 2);
  assert.equal(r.json.code, 'IC_DATA_DIR_SYMLINK_TO_PRODUCTION');
});

// ── 4. 入口：库文件被指到隔离目录之外 → 打开前拒绝，且不产生文件 ──────────
test('P0-T6 IC_DB_SQLITE_PATH 指向隔离目录之外 → 拒绝，外部不落文件', () => {
  const iso = path.join(BASE, 't6-iso');
  const outside = path.join(BASE, 't6-out', 'escaped.db');
  const r = runRunner({ IC_DATA_DIR: iso, IC_DB_SQLITE_PATH: outside });
  assert.equal(r.status, 2);
  assert.equal(r.json.code, 'IC_DB_PATH_OUTSIDE_DATA_DIR');
  assert.equal(fs.existsSync(outside), false, '拒绝必须发生在建库之前');
});

test('P0-T7 隔离目录内的 junction 指向外部 → 入口按真实路径拒绝', (t) => {
  const iso = path.join(BASE, 't7-iso');
  const outsideDir = path.join(BASE, 't7-out');
  fs.mkdirSync(iso, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  const link = path.join(iso, 'escape');
  if (!tryJunction(outsideDir, link)) { t.skip('当前环境不允许创建目录链接'); return; }
  const r = runRunner({ IC_DATA_DIR: iso, IC_DB_SQLITE_PATH: path.join(link, 'ic.db') });
  assert.equal(r.status, 2);
  assert.equal(r.json.code, 'IC_DB_PATH_OUTSIDE_DATA_DIR');
  assert.equal(fs.existsSync(path.join(outsideDir, 'ic.db')), false, '链接外部的库文件不得被创建');
});

// ── 5. 进程级兜底：测试进程没有 IC_DATA_DIR → db.js 在打开前拒绝 ───────────
// 这是本轮补的 A 级缺口：`npm test` 以前没有入口，直接 `node --test` 更是任何断言都没有。
// 诱饵库路径只用于**可观察**：守卫若失效，探针会在这里建出文件，断言立刻红；真实库不受影响。
test('P0-T8 测试进程（NODE_TEST_CONTEXT）未设 IC_DATA_DIR → 打开前拒绝，且不建库', () => {
  const victim = path.join(BASE, 't8-victim', 'victim.db');
  const r = runProbe({ NODE_TEST_CONTEXT: 'child-v8', IC_DB_SQLITE_PATH: victim });
  assert.equal(r.json.ok, false, '必须拒绝：' + JSON.stringify(r.json));
  assert.equal(r.json.code, 'TEST_REQUIRES_IC_DATA_DIR');
  assert.equal(fs.existsSync(victim), false, '拒绝必须发生在打开数据库之前（不得建出库文件）');
});

test('P0-T9 测试进程设了 IC_DATA_DIR → 放行并真的建库在隔离目录内（守卫不误伤）', () => {
  const iso = path.join(BASE, 't9-ok');
  const r = runProbe({ NODE_TEST_CONTEXT: 'child-v8', IC_DATA_DIR: iso });
  assert.equal(r.json.ok, true, '应放行：' + r.json.message);
  assert.equal(r.json.dbExists, true);
  assert.ok(same(r.json.sqlitePath, path.join(iso, 'ic.db')));
});

// ── 6. 入口：PG 模式不接受（P0 判的是 SQLite 文件路径） ────────────────────
test('P0-T10 IC_DB=postgres → 入口拒绝（TEST_REQUIRES_SQLITE），不起测', () => {
  const r = runRunner({ IC_DATA_DIR: path.join(BASE, 't10'), IC_DB: 'postgres' });
  assert.equal(r.status, 2);
  assert.equal(r.json.code, 'TEST_REQUIRES_SQLITE');
});
