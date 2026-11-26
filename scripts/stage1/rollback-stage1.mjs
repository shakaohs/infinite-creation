#!/usr/bin/env node
// 阶段 1 回滚：清理本阶段新建的 21 张表（任务书 §12）
//
// 安全门槛（任何一条不满足就中止，不给 --force 这种口子）：
//   1. 只处理 manifest.groups 里的 21 张；`shots` / `projects` **永远不在清单里**
//   2. 逐表检查：只要存在业务数据就中止（空表才允许 DROP）
//   3. `migration_items` / `migration_edges` 有任何实际数据 → 立即中止
//   4. `migration_batches` 只允许存在"基线记录"（name='schema-init' 且无迁移记录）
//   5. 默认干跑；要真删必须显式 --execute
//
// 用法：
//   node scripts/stage1/rollback-stage1.mjs --db <路径>              # 干跑，打印计划
//   node scripts/stage1/rollback-stage1.mjs --db <路径> --execute     # 真删
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST = path.join(ROOT, 'lib', 'core', 'schema-manifest.json');

// 明确写死的不许删清单（多一道保险：即使 manifest 被人改坏也不会误删）
const NEVER_DROP = ['shots', 'projects', 'chapters', 'assets', 'shot_videos', 'change_logs', 'jobs', 'queue_items', 'messages', 'reference_images', 'skills', 'workflows'];

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : '';
}

function main() {
  const dbPath = arg('--db');
  const execute = process.argv.includes('--execute');
  if (!dbPath) { console.error('用法: --db <sqlite 路径> [--execute]'); process.exit(2); }
  if (!fs.existsSync(dbPath)) { console.error('数据库不存在：' + dbPath); process.exit(2); }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const targets = [];
  for (const g of ['ops', 'archive', 'biz', 'd02_ext']) targets.push(...Object.keys(manifest.groups[g]));
  if (targets.length !== 21) { console.error(`manifest 分组应为 21 张，实际 ${targets.length}`); process.exit(2); }
  for (const t of targets) {
    if (NEVER_DROP.includes(t)) { console.error(`拒绝：${t} 在"永不删除"清单里`); process.exit(2); }
  }
  if (targets.includes('shots') || targets.includes('projects')) { console.error('拒绝：清单里出现既有表'); process.exit(2); }

  const db = new DatabaseSync(dbPath);
  const exists = (t) => {
    const r = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    return !!r;
  };
  const count = (t) => (exists(t) ? db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n : 0);

  const report = { db: dbPath, execute, targets: targets.length, blockers: [], plan: [] };

  // 门槛：运维表数据
  const mi = count('migration_items');
  const me = count('migration_edges');
  if (mi > 0) report.blockers.push(`migration_items 有 ${mi} 行实际迁移记录`);
  if (me > 0) report.blockers.push(`migration_edges 有 ${me} 行依赖边`);
  if (exists('migration_batches')) {
    const rows = db.prepare('SELECT id,name FROM migration_batches').all();
    const nonBaseline = rows.filter((r) => r.name !== 'schema-init');
    if (nonBaseline.length) report.blockers.push(`migration_batches 存在非基线批次：${nonBaseline.map((r) => r.id).join(',')}`);
  }

  // 逐表清点
  for (const t of targets) {
    const n = count(t);
    const isBaselineOnly = t === 'migration_batches' && n > 0 && report.blockers.length === 0;
    const allowed = n === 0 || isBaselineOnly;
    report.plan.push({ table: t, rows: n, exists: exists(t), droppable: allowed });
    if (!allowed) report.blockers.push(`${t} 有 ${n} 行业务数据，不允许 DROP`);
  }

  if (report.blockers.length) {
    console.log(JSON.stringify({ ...report, result: 'ABORTED' }, null, 2));
    process.exit(1);
  }

  if (!execute) {
    db.close();
    console.log(JSON.stringify({ ...report, result: 'DRY_RUN_OK' }, null, 2));
    return;
  }

  // 真删：先删索引随表自动消失；按建表逆序 DROP
  const order = targets.slice().reverse();
  db.exec('BEGIN');
  try {
    for (const t of order) if (exists(t)) db.exec(`DROP TABLE IF EXISTS ${t}`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    db.close();
    console.log(JSON.stringify({ ...report, result: 'FAILED', error: e.message }, null, 2));
    process.exit(1);
  }
  const left = targets.filter(exists);
  const kept = NEVER_DROP.filter(exists);
  db.close();
  console.log(JSON.stringify({ ...report, result: left.length === 0 ? 'DROPPED' : 'PARTIAL', remaining: left, keptExisting: kept }, null, 2));
}

main();
