// 阶段 0 · 任务 4：全新数据库初始化测试（隔离目录内）
//
// 验三件事：
//   1. initSchema 在空库上把 shots 建出 **35 列**（含 blocking）——修复前建出来是 34 列，
//      于是 Shots.create 的第一条 INSERT 就报 "table shots has no column named blocking"。
//   2. Shots.create → Shots.get 能读回 blocking（不丢字段、默认值为空串）。
//   3. 重复 initSchema 不报错、不重复加列、不改已有数据（幂等）。
//
// 用法：
//   IC_DATA_DIR=/tmp/ic-stage0 node scripts/stage0/init-fresh-db.mjs
import fs from 'node:fs';
import path from 'node:path';
import { assertStage0Env } from '../../lib/core/env-guard.js';
import { ensureDir, writeJson, stamp, integrityCheck } from './lib.mjs';

const base = assertStage0Env('全新库初始化');
const dir = ensureDir(path.join(base.dataDir, `fresh-${stamp()}`));

// 只把数据目录收窄到这个子目录；IC_DB_SQLITE_PATH 若存在会让 DB_PATH 指到别处，先摘掉
const savedSqlitePath = process.env.IC_DB_SQLITE_PATH;
delete process.env.IC_DB_SQLITE_PATH;
process.env.IC_DATA_DIR = dir;

const fail = [];
const ok = (cond, msg) => { if (!cond) fail.push(msg); return cond; };

const { DatabaseSync } = await import('node:sqlite');
const dbMod = await import('../../lib/core/db.js');
const { initSchema, ensureColumn, Projects, Shots } = dbMod;
// DB_PATH 来自 config（在 IC_DATA_DIR 设好之后再取）
const { DB_PATH } = await import('../../lib/core/config.js');

console.log('── 阶段 0 · 全新库初始化 ──────────────────────────────');
console.log('fresh dir  ', dir);
console.log('db path    ', DB_PATH);

const cols = (file) => {
  const d = new DatabaseSync(file, { readOnly: true });
  const c = d.prepare('PRAGMA table_info(shots)').all().map((x) => x.name);
  d.close();
  return c;
};

// 1) 空库初始化（getDb 内部会 initSchema；这里显式再调一次，验证可重复执行）
const db = dbMod.getDb();
const shotsCols1 = db.tableColumns('shots');
console.log('shots 列数 ', shotsCols1.length);
ok(shotsCols1.length === 35, `新库 shots 应为 35 列，实际 ${shotsCols1.length}`);
ok(shotsCols1.includes('blocking'), '新库 shots 缺少 blocking 列');
ok(!shotsCols1.includes('seam'), '新库不应包含历史遗留列 seam');
ok(!shotsCols1.includes('storyboard_sheet'), '新库不应包含历史遗留列 storyboard_sheet');

// 2) 建项目 + 建分镜（带 blocking / 不带 blocking）
const p = Projects.create({ name: '阶段0-新库测试' });
const s1 = Shots.create(p.id, { idx: 1, chapter: '第1章', visual: '中景，桌面两只茶杯', blocking: 'A 坐在左，B 站在右', duration: 4 });
const s2 = Shots.create(p.id, { idx: 2, chapter: '第1章', visual: '空镜', duration: 3 });
const got1 = Shots.get(s1.id);
const got2 = Shots.get(s2.id);
console.log('create#1   ', s1.id, 'blocking=', JSON.stringify(got1.blocking));
console.log('create#2   ', s2.id, 'blocking=', JSON.stringify(got2.blocking));
ok(got1 && got1.blocking === 'A 坐在左，B 站在右', 'Shots.get 读回的 blocking 与写入不一致');
ok(got2 && got2.blocking === '', '未传 blocking 时默认值应为空串');

// 3) 幂等：再跑两次 initSchema，列数与数据都不能变
const addedAgain = ensureColumn(db, 'shots', 'blocking', "blocking TEXT DEFAULT ''");
ok(addedAgain === false, 'ensureColumn 在列已存在时仍报告"补列"（说明没先查存在性）');
initSchema(db);
initSchema(db);
const shotsCols2 = db.tableColumns('shots');
ok(shotsCols2.length === 35, `重复 initSchema 后列数变化：${shotsCols2.length}`);
ok(Shots.get(s1.id).blocking === 'A 坐在左，B 站在右', '重复 initSchema 后 blocking 数据被改动');

const integ = integrityCheck(db);
ok(integ === 'ok', 'integrity_check 非 ok：' + integ);

const report = {
  stage: 0,
  task: 'init-fresh-db',
  at: new Date().toISOString(),
  dataDir: dir,
  dbPath: DB_PATH,
  shotsColumns: shotsCols2,
  shotsColumnCount: shotsCols2.length,
  columnsAfterFirstInit: shotsCols1.length,
  idsempotentEnsureColumn: addedAgain === false,
  created: { projectId: p.id, shot1: s1.id, shot2: s2.id, blocking1: got1.blocking, blocking2: got2.blocking },
  integrity: integ,
  failures: fail,
};
writeJson(path.join(base.dataDir, 'report-fresh-db.json'), report);
writeJson(path.join(dir, 'report.json'), report);

if (savedSqlitePath !== undefined) process.env.IC_DB_SQLITE_PATH = savedSqlitePath;

console.log('integrity  ', integ);
if (fail.length) {
  console.error('\nFAIL（' + fail.length + ' 项）：');
  for (const f of fail) console.error('  - ' + f);
  process.exit(1);
}
console.log('\nFRESH-DB PASS：35 列、blocking 可写可读、重复初始化幂等。');
