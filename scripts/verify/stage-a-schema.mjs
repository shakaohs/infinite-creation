#!/usr/bin/env node
// P10-A 阶段 A · 空库完整迁移与结构差异取证（A-01 / A-02 / A-03 + P4 的前置）
//
// 做四件事，全部只碰**临时目录里的空库**（绝不打开 data/ic.db）：
//   ① 记录"迁移前"的冻结基线列集（manifest 生成器从冻结 DDL 文本解析，不读库）；
//   ② 在空库上跑 initSchema（= 真实迁移路径），读出实际列集与索引；
//   ③ 打印逐表差异（新增列 / 新增索引 / 表从无到有）；
//   ④ 连跑两次 initSchema 证明幂等，再跑 verify-manifest --profile=fresh 作为 P4 证据。
//
// 用法：node scripts/verify/stage-a-schema.mjs [--json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initSchema } from '../../lib/core/db.js';
import { STAGE_A_COLUMNS, STAGE_A_INDEXES, columnTargetOf } from '../../lib/core/schema/stage-a.js';
import { buildManifest } from '../schema/gen-manifest.mjs';
import { verify } from '../schema/verify-manifest.mjs';

const JSON_OUT = process.argv.includes('--json');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-stage-a-'));

function makeAdapter(file) {
  const raw = new DatabaseSync(file);
  return {
    exec: (s) => raw.exec(s),
    prepare: (s) => raw.prepare(s),
    tableColumns: (t) => raw.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name),
    dialect: 'sqlite',
    raw,
    file,
  };
}

/** 冻结基线（从 DDL 文本解析，不看库）：stage A 之前这些表应该长什么样 */
function frozenBaseline() {
  const m = buildManifest();
  const delta = {};
  for (const c of STAGE_A_COLUMNS) {
    const { table, column } = columnTargetOf(c.sql);
    (delta[table] ||= []).push(column);
  }
  const base = {};
  for (const table of ['story_shots', 'shot_videos']) {
    const entry = m.groups.biz[table] || m.existing[table];
    base[table] = entry.expected_columns.filter((c) => !(delta[table] || []).includes(c));
  }
  base.continuity_runs = []; // 迁移前不存在
  return base;
}

const file = path.join(TMP, 'ic.db');
const db = makeAdapter(file);
const before = frozenBaseline();
initSchema(db);
const after = {
  story_shots: db.tableColumns('story_shots'),
  shot_videos: db.tableColumns('shot_videos'),
  continuity_runs: db.tableColumns('continuity_runs'),
};

const diff = {};
for (const table of Object.keys(after)) {
  diff[table] = {
    before: before[table].length,
    after: after[table].length,
    added: after[table].filter((c) => !before[table].includes(c)),
    removed: before[table].filter((c) => !after[table].includes(c)),
  };
}

const indexNames = (t) => db.prepare(`PRAGMA index_list(${t})`).all().map((r) => r.name).sort();
const idxAfter = {
  story_shots: indexNames('story_shots'),
  continuity_runs: indexNames('continuity_runs'),
};
const wantedIdx = [
  ...STAGE_A_INDEXES.map((s) => s.match(/INDEX IF NOT EXISTS\s+(\w+)/i)[1]),
  'uq_cr_run',
  'idx_cr_latest',
];
const idxMissing = wantedIdx.filter((n) => ![...idxAfter.story_shots, ...idxAfter.continuity_runs].includes(n));

// 幂等：连续两次 initSchema，列集合与索引集合必须一字不差
const snap = () => JSON.stringify({
  ss: db.tableColumns('story_shots'), sv: db.tableColumns('shot_videos'), cr: db.tableColumns('continuity_runs'),
});
const snapOnce = snap();
initSchema(db);
initSchema(db);
const idempotent = snap() === snapOnce;

// P4 的前置证据：fresh profile 全通过
const v = verify(file, 'fresh');

const out = {
  db: file,
  diff,
  indexes: { story_shots: idxAfter.story_shots, continuity_runs: idxAfter.continuity_runs, missing: idxMissing },
  idempotent,
  verify: {
    ok: v.ok, profile: v.profile, entries: v.entries, pass: v.pass, fail: v.fail,
    groupsAssert: v.groupsAssert, failed: v.failed,
  },
};

if (JSON_OUT) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log('临时库：' + file);
  console.log('—— 迁移前后结构差异（冻结基线 → 实际）——');
  for (const [t, d] of Object.entries(diff)) {
    console.log(`${t}: ${d.before} 列 → ${d.after} 列  added=[${d.added.join(', ')}]  removed=[${d.removed.join(', ')}]`);
  }
  console.log('—— 阶段 A 索引 ——');
  console.log('story_shots: ' + idxAfter.story_shots.join(', '));
  console.log('continuity_runs: ' + idxAfter.continuity_runs.join(', '));
  console.log('缺失: ' + (idxMissing.length ? idxMissing.join(', ') : '无'));
  console.log('—— 幂等 ——  连跑 3 次 initSchema 列集合一致: ' + (idempotent ? 'OK' : 'FAIL'));
  console.log(`—— verify-manifest（profile=fresh）——  entries=${v.entries} pass=${v.pass} fail=${v.fail} => ${v.ok ? 'OK' : 'FAIL'}`);
  if (!v.ok) for (const f of v.failed) console.log('  FAIL ' + f.table + ' ' + JSON.stringify(f));
}
db.raw.close();
process.exit(out.verify.ok && idempotent && idxMissing.length === 0 ? 0 : 1);
