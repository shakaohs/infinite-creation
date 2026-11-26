// 阶段 0 · 任务 5：Schema Manifest 准备
//
// 按 D02-01 §4.5 的原则：**不比列数，比列名集合**。
// 阶段 0 只覆盖"当前代码真实建出来的表"，并把 D01 的 18 张目标表标记为 NOT_READY，
// 绝不伪装成阶段 1 已完成。
//
// 产物：scripts/stage0/schema-manifest.stage0.json（随代码入库）
//
// 用法：
//   IC_DATA_DIR=/tmp/ic-stage0 node scripts/stage0/gen-manifest.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertStage0Env } from '../../lib/core/env-guard.js';
import { ensureDir, stamp, schemaDump, writeJson } from './lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const base = assertStage0Env('Schema Manifest 生成');
const dir = ensureDir(path.join(base.dataDir, `manifest-${stamp()}`));

const savedSqlitePath = process.env.IC_DB_SQLITE_PATH;
delete process.env.IC_DB_SQLITE_PATH;
process.env.IC_DATA_DIR = dir;

const dbMod = await import('../../lib/core/db.js');
const db = dbMod.getDb();
const schema = schemaDump(db);

// D01 的 18 张目标表（14 业务 + 3 运维 + 1 归档）——阶段 0 一概未建
const D01_TABLES = {
  biz: ['scene_states', 'story_shots', 'shot_blockings', 'shot_actions', 'shot_states', 'shot_assets',
    'render_adaptations', 'render_units', 'render_unit_shots', 'prompt_packages', 'render_tasks',
    'render_attempts', 'qc_reports', 'timelines'],
  ops: ['migration_batches', 'migration_items', 'migration_edges'],
  archive: ['legacy_artifacts'],
};

// 历史库允许存在、但新库不建、且不参与任何读写的列（D02-01 §4.2）
const TOLERATE_EXTRA = { shots: ['seam', 'storyboard_sheet'] };

const tables = {};
for (const [name, cols] of Object.entries(schema)) {
  tables[name] = {
    kind: name === 'shots' ? 'legacy' : 'existing',
    expect: cols,
    tolerate_extra: TOLERATE_EXTRA[name] || [],
  };
}

const pending = {};
for (const [kind, list] of Object.entries(D01_TABLES)) {
  for (const name of list) {
    pending[name] = { kind, status: 'NOT_READY', stage: 1, note: '阶段 1 建表后才可写入 expect 列清单' };
  }
}

const manifest = {
  version: 1,
  scope: 'stage0',
  generatedAt: new Date().toISOString(),
  generatedFrom: 'scripts/stage0/gen-manifest.mjs（空库执行 initSchema 后导出）',
  rules: [
    '校验按列名集合比对：missing = expect - actual 必须为空；extra - tolerate_extra 必须为空；',
    'extra ∩ tolerate_extra 只记 INFO（历史遗留列，允许存在但不参与读写）；',
    '禁止用列数相等作为通过判据。',
  ],
  tables,
  pending,
  summary: {
    existingTables: Object.keys(tables).length,
    shotsColumns: (schema.shots || []).length,
    pendingD01Tables: Object.keys(pending).length,
  },
};

const out = path.join(__dirname, 'schema-manifest.stage0.json');
writeJson(out, manifest);

if (savedSqlitePath !== undefined) process.env.IC_DB_SQLITE_PATH = savedSqlitePath;

console.log('── 阶段 0 · Schema Manifest ─────────────────────────');
console.log('现有表      ', Object.keys(tables).length, '张');
console.log('shots 列数  ', (schema.shots || []).length, '（expect 已写死列名，不是列数）');
console.log('D01 待建    ', Object.keys(pending).length, '张 → 全部 NOT_READY');
console.log('manifest    ', out);
