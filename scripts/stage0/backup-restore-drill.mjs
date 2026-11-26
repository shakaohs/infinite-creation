// 阶段 0 · 任务 2：备份与恢复演练（只在隔离目录内操作）
//
// 真库 data/ic.db 只以 **只读连接** 打开一次，用 VACUUM INTO 做一致性备份：
//   - 直接 copyFile 在 WAL 模式下可能漏掉 -wal 里的已提交页，VACUUM INTO 是 SQLite 官方的
//     "生成一致快照"手段，且对只读库可用（实测 Node 22 / node:sqlite 通过）。
//   - 备份、恢复、删除都在 IC_DATA_DIR 下进行，真库全程只读。
//
// 用法：
//   IC_DATA_DIR=/tmp/ic-stage0 node scripts/stage0/backup-restore-drill.mjs
//   IC_DATA_DIR=%TEMP%\ic-stage0 node scripts/stage0/backup-restore-drill.mjs
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertStage0Env, REPO_ROOT } from '../../lib/core/env-guard.js';
import { sha256File, ensureDir, writeJson, rowCounts, schemaDump, integrityCheck, blockingStats, stamp, STAGE0_TABLES } from './lib.mjs';

const env = assertStage0Env('备份恢复演练');
const SOURCE = process.env.IC_STAGE0_SOURCE || path.join(REPO_ROOT, 'data', 'ic.db');
const stampStr = stamp();
const WORK = ensureDir(path.join(env.dataDir, `drill-${stampStr}`));
const BACKUP_DIR = ensureDir(path.join(WORK, 'backup'));
const RESTORE_DIR = ensureDir(path.join(WORK, 'restore'));
const BACKUP = path.join(BACKUP_DIR, 'ic-backup.db');
const RESTORED = path.join(RESTORE_DIR, 'ic.db');

const fail = [];
const ok = (cond, msg) => { if (!cond) fail.push(msg); return cond; };

function open(file, readOnly = false) {
  return new DatabaseSync(file, readOnly ? { readOnly: true } : undefined);
}

console.log('── 阶段 0 · 备份恢复演练 ──────────────────────────────');
console.log('IC_DATA_DIR   ', env.dataDir);
console.log('source (ro)   ', SOURCE);
console.log('backup        ', BACKUP);

if (!fs.existsSync(SOURCE)) {
  console.error('源数据库不存在：' + SOURCE);
  process.exit(2);
}

// 1) 真库指纹（演练前后各算一次，用来证明没写它）
const srcShaBefore = sha256File(SOURCE);

// 2) 只读打开真库 → 记录基线
const src = open(SOURCE, true);
const srcCounts = rowCounts(src, STAGE0_TABLES);
const srcSchema = schemaDump(src);
const srcBlocking = blockingStats(src);
const srcIntegrity = integrityCheck(src);

// 3) VACUUM INTO 生成备份（一致性快照）
fs.rmSync(BACKUP, { force: true });
src.exec(`VACUUM INTO '${BACKUP.replace(/\\/g, '/').replace(/'/g, "''")}'`);
src.close();

// 4) 备份指纹 + 可打开 + 完整性 + 行数
const backupSha = sha256File(BACKUP);
const backupSha2 = sha256File(BACKUP);
ok(backupSha === backupSha2, '备份 SHA-256 复算不一致');

const bak = open(BACKUP, true);
const bakCounts = rowCounts(bak, STAGE0_TABLES);
const bakSchema = schemaDump(bak);
const bakBlocking = blockingStats(bak);
const bakIntegrity = integrityCheck(bak);
bak.close();

ok(bakIntegrity === 'ok', '备份 integrity_check 非 ok：' + bakIntegrity);
for (const t of STAGE0_TABLES) {
  ok(srcCounts[t] === bakCounts[t], `备份与源行数不一致：${t} ${srcCounts[t]} != ${bakCounts[t]}`);
}
ok(srcBlocking.nonEmpty === bakBlocking.nonEmpty, '备份 shots.blocking 非空数不一致');

// 5) 隔离目录内"第一次恢复"：备份 → restore/ic.db，验证后删除（模拟测试库丢失）
fs.copyFileSync(BACKUP, RESTORED);
{
  const r = open(RESTORED, true);
  ok(integrityCheck(r) === 'ok', '第一次恢复后 integrity_check 非 ok');
  const c = rowCounts(r, STAGE0_TABLES);
  for (const t of STAGE0_TABLES) ok(c[t] === srcCounts[t], `第一次恢复行数不一致：${t}`);
  r.close();
}
fs.rmSync(RESTORED, { force: true });
ok(!fs.existsSync(RESTORED), '删除测试库失败（文件仍存在）');

// 6) 从备份再恢复一次（restore 真流程），重新校验
fs.copyFileSync(BACKUP, RESTORED);
const res = open(RESTORED, true);
const resIntegrity = integrityCheck(res);
const resCounts = rowCounts(res, STAGE0_TABLES);
const resSchema = schemaDump(res);
const resBlocking = blockingStats(res);
res.close();
ok(resIntegrity === 'ok', '恢复后 integrity_check 非 ok：' + resIntegrity);
for (const t of STAGE0_TABLES) {
  ok(resCounts[t] === srcCounts[t], `恢复后行数不一致：${t} ${resCounts[t]} != ${srcCounts[t]}`);
}
ok(resBlocking.nonEmpty === srcBlocking.nonEmpty, '恢复后 shots.blocking 非空数不一致');
ok(JSON.stringify(resSchema) === JSON.stringify(srcSchema), '恢复后表结构与源不一致');

// 7) 真库指纹复核
const srcShaAfter = sha256File(SOURCE);
const sourceUntouched = srcShaBefore === srcShaAfter;

const report = {
  stage: 0,
  task: 'backup-restore-drill',
  at: new Date().toISOString(),
  dataDir: env.dataDir,
  source: SOURCE,
  backup: BACKUP,
  restored: RESTORED,
  sourceSha256Before: srcShaBefore,
  sourceSha256After: srcShaAfter,
  sourceUntouched,
  backupSha256: backupSha,
  backupSha256Recomputed: backupSha2,
  integrity: { source: srcIntegrity, backup: bakIntegrity, restored: resIntegrity },
  rowCounts: { source: srcCounts, backup: bakCounts, restored: resCounts },
  shotsBlocking: { source: srcBlocking, backup: bakBlocking, restored: resBlocking },
  tables: STAGE0_TABLES.length,
  failures: fail,
};
writeJson(path.join(WORK, 'drill-report.json'), report);

console.log('');
console.log('源库 integrity      ', srcIntegrity);
console.log('备份 SHA-256        ', backupSha);
console.log('备份 integrity      ', bakIntegrity);
console.log('恢复 integrity      ', resIntegrity);
console.log('真库指纹未变        ', sourceUntouched ? '是' : '否（演练期间有外部进程写入）');
console.log('');
for (const t of STAGE0_TABLES) {
  console.log(`  ${t.padEnd(18)} source=${String(srcCounts[t]).padStart(5)}  backup=${String(bakCounts[t]).padStart(5)}  restored=${String(resCounts[t]).padStart(5)}`);
}
console.log('');
console.log('shots.blocking 非空 ', srcBlocking.nonEmpty, '/', srcBlocking.total);
console.log('报告               ', path.join(WORK, 'drill-report.json'));

if (fail.length) {
  console.error('\nFAIL（' + fail.length + ' 项）：');
  for (const f of fail) console.error('  - ' + f);
  process.exit(1);
}
console.log('\nDRILL PASS：备份可复算、可恢复、行数与结构一致。');
