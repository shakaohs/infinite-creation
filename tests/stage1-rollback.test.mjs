// 阶段 1 · 回滚脚本的数据库隔离（V1.1 A-01）
//
// 原版脚本只有 `new DatabaseSync(dbPath)`：给个路径就能 DROP 21 张表。
// 这里逐条验证"**拒绝发生在打开数据库之前**"，而不是"打开后才发现不该删"——
// 判定方式：把 --db 指向一个**尚不存在**的可写路径，被拒后该文件必须仍然不存在
// （如果脚本先打开了库，SQLite 会立刻建出一个空文件）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { initSchema } from '../lib/core/db.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'stage1', 'rollback-stage1.mjs');
const REAL_DB = path.join(ROOT, 'data', 'ic.db');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-s1-rb-'));

/** 用 initSchema + 自己的 adapter 造一个"阶段 1 刚初始化完"的库（不碰单例、不碰 IC_DATA_DIR） */
function makeStage1Db(dir, name = 'ic.db') {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const raw = new DatabaseSync(file);
  const db = {
    exec: (s) => raw.exec(s),
    prepare: (s) => raw.prepare(s),
    tableColumns: (t) => raw.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name),
    dialect: 'sqlite',
  };
  initSchema(db);
  raw.close();
  return file;
}

function run(args, { dataDir, extraEnv = {} } = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.IC_DB_SQLITE_PATH;
  delete env.IC_DATA_DIR;
  delete env.DATABASE_URL;
  delete env.IC_DB;
  if (dataDir !== undefined) env.IC_DATA_DIR = dataDir;
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '', all: (r.stdout || '') + (r.stderr || '') };
}

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// ── 1. 未设置 IC_DATA_DIR ───────────────────────────────────────────────
test('R-01 未设置 IC_DATA_DIR → 拒绝', () => {
  const dir = path.join(BASE, 'r01');
  const file = makeStage1Db(dir);
  const r = run(['--db', file, '--execute']);
  assert.equal(r.code, 2);
  assert.match(r.all, /IC_DATA_DIR_NOT_SET/);
});

// ── 2. IC_DATA_DIR 为相对路径 ───────────────────────────────────────────
test('R-02 IC_DATA_DIR 为相对路径 → 拒绝', () => {
  const dir = path.join(BASE, 'r02');
  const file = makeStage1Db(dir);
  const r = run(['--db', file, '--execute'], { dataDir: 'relative/dir' });
  assert.equal(r.code, 2);
  assert.match(r.all, /IC_DATA_DIR_NOT_ABSOLUTE/);
});

// ── 3. 数据库位于隔离目录外 ─────────────────────────────────────────────
test('R-03 数据库在隔离目录外 → 拒绝，且不创建文件（证明未打开过）', () => {
  const dataDir = path.join(BASE, 'r03-in');
  fs.mkdirSync(dataDir, { recursive: true });
  const outside = path.join(BASE, 'r03-out', 'new.db');
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  const r = run(['--db', outside, '--execute'], { dataDir });
  assert.equal(r.code, 2);
  assert.match(r.all, /IC_DB_PATH_OUTSIDE_DATA_DIR/);
  assert.equal(fs.existsSync(outside), false, '被拒后不得留下任何文件（否则说明库被打开过）');
});

// ── 4. 通过符号链接指向隔离目录外 ───────────────────────────────────────
test('R-04 数据库经目录链接指向隔离目录外 → 拒绝（按真实路径判定）', (t) => {
  const dataDir = path.join(BASE, 'r04-in');
  const outsideDir = path.join(BASE, 'r04-out');
  const outsideFile = makeStage1Db(outsideDir);
  fs.mkdirSync(dataDir, { recursive: true });
  const link = path.join(dataDir, 'esc');
  try {
    fs.symlinkSync(outsideDir, link, 'junction');
  } catch (e) {
    t.skip('本机不支持创建目录链接：' + e.message);
    return;
  }
  const viaLink = path.join(link, path.basename(outsideFile));
  const r = run(['--db', viaLink, '--execute'], { dataDir });
  assert.equal(r.code, 2);
  assert.match(r.all, /IC_DB_PATH_OUTSIDE_DATA_DIR/);
  assert.match(r.all, /符号链接|junction/);
  // 真实库没被删：21 张表仍在
  const chk = new DatabaseSync(outsideFile, { readOnly: true });
  assert.ok(chk.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='render_tasks'").get());
  chk.close();
});

// ── 5. --execute 指向真实库 ─────────────────────────────────────────────
test('R-05 --execute 指向真实库 → 打开前拒绝，真实库 SHA 不变', (t) => {
  if (!fs.existsSync(REAL_DB)) { t.skip('无真实库'); return; }
  const dataDir = path.join(BASE, 'r05');
  fs.mkdirSync(dataDir, { recursive: true });
  const before = sha(REAL_DB);
  const r = run(['--db', REAL_DB, '--execute'], { dataDir });
  assert.equal(r.code, 2);
  assert.match(r.all, /IC_DB_PATH_OUTSIDE_DATA_DIR|DB_IN_PRODUCTION/);
  assert.equal(sha(REAL_DB), before, '真实库 SHA 必须不变');
});

// ── 6. Manifest 被换成未知表 ─────────────────────────────────────────────
test('R-06 Manifest 用未知表替换一张阶段 1 表 → 拒绝（不是只看数量 21）', () => {
  const dir = path.join(BASE, 'r06');
  const file = makeStage1Db(dir);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'core', 'schema-manifest.json'), 'utf8'));
  const bad = JSON.parse(JSON.stringify(manifest));
  delete bad.groups.biz.scene_states;
  bad.groups.biz.evil_table = {
    kind: 'biz', source: 'x', expected_columns: ['id'], tolerate_extra_columns: [], required_columns: ['id'],
  };
  const badPath = path.join(dir, 'bad-manifest.json');
  fs.writeFileSync(badPath, JSON.stringify(bad));
  const r = run(['--db', file, '--manifest', badPath, '--execute'], { dataDir: dir });
  assert.equal(r.code, 2);
  assert.match(r.all, /未知表|缺少阶段 1 正式表/);
  // 表没被删
  const chk = new DatabaseSync(file, { readOnly: true });
  assert.ok(chk.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='render_tasks'").get());
  chk.close();
});

// ── 7. 合法临时库干跑 ───────────────────────────────────────────────────
test('R-07 合法临时库干跑：只读连接、DRY_RUN_OK、结构一行没动', () => {
  const dir = path.join(BASE, 'r07');
  const file = makeStage1Db(dir);
  const before = sha(file);
  const r = run(['--db', file], { dataDir: dir });
  assert.equal(r.code, 0, r.all);
  const out = JSON.parse(r.out);
  assert.equal(out.result, 'DRY_RUN_OK');
  assert.equal(out.mode, 'dry-run');
  assert.equal(out.connection, 'read-only');
  assert.equal(out.targets, 21);
  assert.equal(out.whitelist, 'exact');
  assert.equal(sha(file), before, '干跑不得改库（一个字节都不行）');
});

// ── 8. 合法临时库真回滚 ─────────────────────────────────────────────────
test('R-08 合法临时库真回滚：21 张清理、12 张既有表保留、既有列不变', () => {
  const dir = path.join(BASE, 'r08');
  const file = makeStage1Db(dir);
  const r = run(['--db', file, '--execute'], { dataDir: dir });
  assert.equal(r.code, 0, r.all);
  const out = JSON.parse(r.out);
  assert.equal(out.result, 'DROPPED');
  assert.deepEqual(out.remaining, []);
  assert.equal(out.keptExisting.length, 12);

  const db = new DatabaseSync(file, { readOnly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((x) => x.name);
  assert.equal(tables.length, 12);
  for (const t of ['shots', 'projects', 'chapters', 'assets']) assert.ok(tables.includes(t), `${t} 必须保留`);
  assert.equal(db.prepare('PRAGMA table_info(shots)').all().length, 35);
  // structured_spec 列保留（§12.1：允许保留默认 0 的兼容列）
  assert.ok(db.prepare('PRAGMA table_info(projects)').all().some((c) => c.name === 'structured_spec'));
  db.close();
});
