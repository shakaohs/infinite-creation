#!/usr/bin/env node
// 校验数据库结构与 lib/core/schema-manifest.json 是否一致
//
// 两种库必须显式声明，不靠猜（任务书 §4.5 最后一段）：
//   --profile=fresh       新建库：shots 必须恰好 35 列，extra 必须为 0
//   --profile=historical  历史库：允许 seam / storyboard_sheet 两项额外列，第 3 项即 FAIL
//
// 比对一律按**列名集合**：不按列数、不按列位置（历史库 projects 的 video_model/seam
// 是 ALTER 追加的，位置与新库不同，按位置比必错）。
//
// 用法：
//   node scripts/schema/verify-manifest.mjs --db <sqlite 路径> --profile=fresh
//   node scripts/schema/verify-manifest.mjs --db <副本> --profile=historical --json
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST = path.join(ROOT, 'lib', 'core', 'schema-manifest.json');

function parseArgs(argv) {
  const out = { db: '', profile: '', json: false };
  for (const a of argv) {
    if (a.startsWith('--db=')) out.db = a.slice(5);
    else if (a === '--db') out.dbNext = true;
    else if (a.startsWith('--profile=')) out.profile = a.slice(10);
    else if (a === '--json') out.json = true;
    else if (out.dbNext) { out.db = a; out.dbNext = false; }
  }
  return out;
}

const setOf = (arr) => new Set(arr);
const diff = (a, b) => [...a].filter((x) => !b.has(x));

/** 校验一张表 */
function checkTable(db, name, entry, profile) {
  const cols = db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name);
  if (!cols.length) return { table: name, ok: false, error: 'TABLE_MISSING' };

  const actual = setOf(cols);
  const expected = setOf(entry.expected_columns);
  const tolerate = setOf(entry.tolerate_extra_columns || []);
  const required = setOf(entry.required_columns || []);

  const missing = diff(expected, actual);
  const extra = diff(actual, expected);              // 实际有、规范没有
  const tolerated = extra.filter((c) => tolerate.has(c));
  const unknownExtra = extra.filter((c) => !tolerate.has(c));
  const requiredMissing = diff(required, actual);

  let ok = missing.length === 0 && requiredMissing.length === 0;
  if (profile === 'fresh') ok = ok && extra.length === 0;        // 新建库不允许任何额外列
  else ok = ok && unknownExtra.length === 0;                     // 历史库只容忍白名单

  // 历史库若 tolerate 声明了却一个都没命中，不算错（新历史库可能没有）；但 fresh 命中即错。
  return {
    table: name, ok,
    columns: cols.length,
    missing, tolerated, unknownExtra, requiredMissing,
    expectedCount: entry.expected_columns.length,
  };
}

export function verify(dbPath, profile) {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const results = [];
  for (const group of ['ops', 'archive', 'biz', 'd02_ext']) {
    for (const [name, entry] of Object.entries(manifest.groups[group])) {
      results.push({ group, ...checkTable(db, name, entry, profile) });
    }
  }
  for (const [name, entry] of Object.entries(manifest.existing)) {
    results.push({ group: 'existing', ...checkTable(db, name, entry, profile) });
  }
  db.close();

  const failed = results.filter((r) => !r.ok);
  return {
    ok: failed.length === 0,
    profile,
    db: dbPath,
    entries: results.length,
    pass: results.length - failed.length,
    fail: failed.length,
    groupsAssert: {
      ops: Object.keys(manifest.groups.ops).length,
      archive: Object.keys(manifest.groups.archive).length,
      biz: Object.keys(manifest.groups.biz).length,
      d02_ext: Object.keys(manifest.groups.d02_ext).length,
      existing: Object.keys(manifest.existing).length,
      pendingEmpty: Object.keys(manifest.pending || {}).length === 0,
    },
    failed: failed.map((r) => ({
      table: r.table, group: r.group, error: r.error,
      missing: r.missing, unknownExtra: r.unknownExtra, tolerated: r.tolerated,
      requiredMissing: r.requiredMissing, columns: r.columns, expectedCount: r.expectedCount,
    })),
    details: results,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.db || !args.profile) {
    console.error('用法: node scripts/schema/verify-manifest.mjs --db <路径> --profile=fresh|historical');
    process.exit(2);
  }
  if (!['fresh', 'historical'].includes(args.profile)) {
    console.error('--profile 必须是 fresh 或 historical（不接受自动猜测）');
    process.exit(2);
  }
  if (!fs.existsSync(args.db)) { console.error('数据库不存在：' + args.db); process.exit(2); }

  const r = verify(args.db, args.profile);
  if (args.json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`profile=${r.profile}  entries=${r.entries}  pass=${r.pass}  fail=${r.fail}`);
    console.log(`groups: ops=${r.groupsAssert.ops} archive=${r.groupsAssert.archive} biz=${r.groupsAssert.biz} d02_ext=${r.groupsAssert.d02_ext} existing=${r.groupsAssert.existing} pending空=${r.groupsAssert.pendingEmpty}`);
    for (const f of r.failed) {
      console.log(`FAIL ${f.table} (${f.group})${f.error ? ' ' + f.error : ''}`);
      if (f.missing?.length) console.log('   missing:', f.missing.join(','));
      if (f.unknownExtra?.length) console.log('   unknownExtra:', f.unknownExtra.join(','));
      if (f.requiredMissing?.length) console.log('   requiredMissing:', f.requiredMissing.join(','));
    }
  }
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1]?.endsWith('verify-manifest.mjs')) main();
