// 阶段 0 · 任务 6：迁移基准快照（真库只读）
//
// 记录：一致性副本 + SHA-256 + 关键表行数 + 结构（逐表列名）+ shots.blocking 非空数。
// 快照落在 IC_DATA_DIR 内（仓库外），不入库；报告里的 SHA 可以在任何一台机器上复算。
//
// 用法：
//   IC_DATA_DIR=/tmp/ic-stage0 node scripts/stage0/baseline-snapshot.mjs
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertStage0Env, REPO_ROOT } from '../../lib/core/env-guard.js';
import { sha256File, ensureDir, writeJson, rowCounts, schemaDump, integrityCheck, blockingStats, stamp, STAGE0_TABLES } from './lib.mjs';

const env = assertStage0Env('迁移基准快照');
const SOURCE = process.env.IC_STAGE0_SOURCE || path.join(REPO_ROOT, 'data', 'ic.db');
const DIR = ensureDir(path.join(env.dataDir, `baseline-${stamp()}`));
const COPY = path.join(DIR, 'ic-baseline.db');

if (!fs.existsSync(SOURCE)) {
  console.error('源数据库不存在：' + SOURCE);
  process.exit(2);
}

console.log('── 阶段 0 · 迁移基准快照 ──────────────────────────────');
console.log('source(ro) ', SOURCE);

const srcShaBefore = sha256File(SOURCE);
const src = new DatabaseSync(SOURCE, { readOnly: true });

const counts = rowCounts(src, STAGE0_TABLES);
const schema = schemaDump(src);
const blocking = blockingStats(src);
const integ = integrityCheck(src);
const sqliteVersion = src.prepare('SELECT sqlite_version() AS v').get().v;
const shotsCols = schema.shots || [];

// 一致副本
fs.rmSync(COPY, { force: true });
src.exec(`VACUUM INTO '${COPY.replace(/\\/g, '/').replace(/'/g, "''")}'`);
src.close();

const copySha = sha256File(COPY);
const srcShaAfter = sha256File(SOURCE);

const snapshot = {
  stage: 0,
  task: 'baseline-snapshot',
  at: new Date().toISOString(),
  source: SOURCE,
  copy: COPY,
  sourceSha256Before: srcShaBefore,
  sourceSha256After: srcShaAfter,
  sourceUntouched: srcShaBefore === srcShaAfter,
  copySha256: copySha,
  sqliteVersion,
  integrity: integ,
  shots: {
    columnCount: shotsCols.length,
    columns: shotsCols,
    blockingColumn: blocking.hasColumn,
    blockingNonEmpty: blocking.nonEmpty,
    rows: blocking.total,
  },
  rowCounts: counts,
  tableCount: Object.keys(schema).length,
};
writeJson(path.join(DIR, 'baseline.json'), snapshot);
writeJson(path.join(DIR, 'schema.json'), schema);
writeJson(path.join(env.dataDir, 'baseline-latest.json'), snapshot);

console.log('快照副本    ', COPY);
console.log('源库 SHA256 ', srcShaBefore);
console.log('副本 SHA256 ', copySha, srcShaBefore === copySha ? '（与源一致：只读库无 -wal 残留时成立）' : '（与源不同属正常：VACUUM INTO 重写页布局）');
console.log('integrity   ', integ, '| sqlite', sqliteVersion);
console.log('表数量      ', Object.keys(schema).length, '| shots 列数', shotsCols.length);
console.log('shots.blocking 非空', blocking.nonEmpty, '/', blocking.total);
console.log('');
for (const t of STAGE0_TABLES) console.log(`  ${t.padEnd(18)} ${String(counts[t]).padStart(6)}`);
console.log('\n基准快照完成：' + path.join(DIR, 'baseline.json'));
