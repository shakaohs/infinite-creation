// 阶段 0 · Manifest 校验器（可被测试 import，也可命令行跑）
//
// 用法：
//   IC_DATA_DIR=/tmp/ic-stage0 node scripts/stage0/verify-manifest.mjs [--db <file>] [--manifest <file>]
//
// 判据来自 D02-01 §4.5：
//   missing = expect - actual          必须为空（该有的没建）
//   extra   = actual - expect          必须 ⊆ tolerate_extra（多了未知列 → FAIL）
//   tolerated = extra ∩ tolerate_extra  只记 INFO（历史遗留列，允许但不参与读写）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function verifyManifest(dbFile, manifest) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const out = [];
  let ok = true;
  try {
    for (const [table, spec] of Object.entries(manifest.tables || {})) {
      const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (!exists) {
        out.push({ table, status: 'MISSING_TABLE', missing: spec.expect || [], unknownExtra: [], tolerated: [] });
        ok = false;
        continue;
      }
      const actual = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      const expect = spec.expect || [];
      const tolerate = spec.tolerate_extra || [];
      const missing = expect.filter((c) => !actual.includes(c));
      const extra = actual.filter((c) => !expect.includes(c));
      const tolerated = extra.filter((c) => tolerate.includes(c));
      const unknownExtra = extra.filter((c) => !tolerate.includes(c));
      const status = missing.length || unknownExtra.length ? 'FAIL' : 'PASS';
      if (status === 'FAIL') ok = false;
      out.push({ table, status, columnCount: actual.length, missing, unknownExtra, tolerated });
    }
  } finally {
    db.close();
  }
  return { ok, tables: out };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isCli) {
  const args = process.argv.slice(2);
  const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const dbFile = getArg('--db', '');
  const manifestFile = getArg('--manifest', path.join(__dirname, 'schema-manifest.stage0.json'));
  if (!dbFile || !fs.existsSync(dbFile)) {
    console.error('需要 --db <sqlite 文件>（且文件必须存在）');
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const r = verifyManifest(dbFile, manifest);
  console.log('── Manifest 校验 ──', dbFile);
  for (const t of r.tables) {
    const tail = [
      t.missing.length ? 'missing=' + t.missing.join(',') : '',
      t.unknownExtra.length ? 'unknownExtra=' + t.unknownExtra.join(',') : '',
      t.tolerated.length ? 'tolerated=' + t.tolerated.join(',') : '',
    ].filter(Boolean).join('  ');
    console.log(`  ${t.status.padEnd(14)} ${String(t.table).padEnd(18)} cols=${t.columnCount ?? '-'} ${tail}`);
  }
  console.log(r.ok ? '\nMANIFEST PASS' : '\nMANIFEST FAIL');
  process.exit(r.ok ? 0 : 1);
}
