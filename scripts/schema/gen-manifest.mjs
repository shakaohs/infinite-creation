#!/usr/bin/env node
// 生成 lib/core/schema-manifest.json
//
// 唯一权威来源（任务书 §4.3，不得从数据库反推）：
//   biz 14 张            → docs/D01/D01-05-*.md 的 ```sql 块
//   ops 3 + archive 1    → docs/D02/D02-01-*.md 的 ```sql 块
//   d02_ext 3            → docs/D02/D02-03-*.md 的 ```sql 块
//   shots / projects     → lib/core/db.js 的 CREATE TABLE（既有表，含阶段 0/1 补列）
//
// 输出稳定：generatedAt 固定为空串，同输入两次生成字节完全一致（§4.6 验收 9/10）。
//
// 用法：node scripts/schema/gen-manifest.mjs [--out <path>] [--check]
//   --check  只比对，不写文件；与仓库内文件不一致则退出码 1
import fs from 'node:fs';
import path from 'node:path';
import { parseTablesFromMarkdown, parseTablesFromJs, readText, repoRoot } from './ddl-parse.mjs';

const ROOT = repoRoot();
const DOCS = path.join(ROOT, 'docs', 'D02');
const D01 = path.join(ROOT, 'docs', 'D01');
const DEFAULT_OUT = path.join(ROOT, 'lib', 'core', 'schema-manifest.json');

const SRC = {
  d01_05: 'docs/D01/D01-05-数据库映射与历史数据兼容方案.md',
  d02_01: 'docs/D02/D02-01-工程实施总体方案.md',
  d02_03: 'docs/D02/D02-03-阶段1前置设计决策记录.md',
  db_js: 'lib/core/db.js',
};

const BIZ = [
  'scene_states', 'story_shots', 'shot_blockings', 'shot_actions', 'shot_states', 'shot_assets',
  'render_adaptations', 'render_units', 'render_unit_shots', 'prompt_packages',
  'render_tasks', 'render_attempts', 'qc_reports', 'timelines',
];
const OPS = ['migration_batches', 'migration_items', 'migration_edges'];
const ARCHIVE = ['legacy_artifacts'];
const EXT = ['adaptation_locks', 'render_task_jobs', 'render_selections'];

// V3 §5.1 定的三集合：shots 是唯一同时用到三者的表
const SHOTS_TOLERATE = ['seam', 'storyboard_sheet'];
const SHOTS_REQUIRED = [
  'id', 'project_id', 'idx', 'chapter', 'scene_name', 'blocking',
  'duration', 'status', 'error', 'video_path', 'updated_at',
];
const PROJECTS_REQUIRED = ['id', 'name', 'context', 'status', 'structured_spec'];

function pick(all, names, { source, kind, tolerate = {}, required = {} }) {
  const out = {};
  for (const n of names) {
    const cols = all[n];
    if (!cols || !cols.length) throw new Error(`来源 ${source} 中找不到表 ${n} 的列定义`);
    out[n] = {
      kind,
      source,
      expected_columns: cols,
      tolerate_extra_columns: tolerate[n] || [],
      required_columns: required[n] || [],
    };
  }
  return out;
}

export function buildManifest() {
  const bizSrc = parseTablesFromMarkdown(readText(path.join(ROOT, SRC.d01_05)));
  const opsSrc = parseTablesFromMarkdown(readText(path.join(ROOT, SRC.d02_01)));
  const extSrc = parseTablesFromMarkdown(readText(path.join(ROOT, SRC.d02_03)));
  const dbSrc = parseTablesFromJs(readText(path.join(ROOT, SRC.db_js)));

  const groups = {
    ops: pick(opsSrc, OPS, { source: SRC.d02_01, kind: 'ops' }),
    archive: pick(opsSrc, ARCHIVE, { source: SRC.d02_01, kind: 'archive' }),
    biz: pick(bizSrc, BIZ, { source: SRC.d01_05, kind: 'biz' }),
    d02_ext: pick(extSrc, EXT, { source: SRC.d02_03, kind: 'd02_ext' }),
  };

  // 既有两表：结构来自 db.js（既有表唯一权威），但**不属于新建表**
  const existing = {
    shots: {
      kind: 'existing',
      source: SRC.db_js,
      expected_columns: dbSrc.shots,
      tolerate_extra_columns: SHOTS_TOLERATE,
      required_columns: SHOTS_REQUIRED,
    },
    projects: {
      kind: 'existing',
      source: SRC.db_js,
      expected_columns: dbSrc.projects,
      tolerate_extra_columns: [],
      required_columns: PROJECTS_REQUIRED,
    },
  };

  const count = (g) => Object.keys(groups[g]).length;
  const total = count('ops') + count('archive') + count('biz') + count('d02_ext');
  if (total !== 21) throw new Error(`groups 合计应为 21，实际 ${total}`);
  if (Object.keys(existing).length !== 2) throw new Error('existing 应为 2 张');

  return {
    version: 1,
    source: { ...SRC, generatedFrom: 'frozen DDL text only, never the database' },
    generatedAt: '',
    counts: {
      ops: count('ops'), archive: count('archive'), biz: count('biz'), d02_ext: count('d02_ext'),
      groups_total: total, existing: 2, entries_total: total + 2,
    },
    groups,
    existing,
    rules: [
      '比对按列名集合，不按列数、不按列位置（历史库 projects 的 video_model/seam 由 ALTER 追加，位置与新库不同）',
      '新建库：expected_columns 必须完全相等，extra 必须为 0',
      '历史库：expected 必须齐；extra 只能是 tolerate_extra_columns 的子集；出现第三项未知列即 FAIL',
      'required_columns 在两种库上都必须存在，缺失即 FAIL',
      '既有 shots / projects 不在新建表清单内，永不进入 DROP 回滚',
      'expect 列集合由生成器从冻结 DDL 文本解析，禁止手写',
    ],
    pending: {},
  };
}

function main() {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const out = outIdx >= 0 ? path.resolve(argv[outIdx + 1]) : DEFAULT_OUT;
  const check = argv.includes('--check');

  const manifest = buildManifest();
  const text = JSON.stringify(manifest, null, 2) + '\n';

  if (check) {
    if (!fs.existsSync(out)) { console.error('manifest 不存在：' + out); process.exit(1); }
    const cur = fs.readFileSync(out, 'utf8');
    if (cur !== text) { console.error('manifest 与生成结果不一致，请重跑生成器'); process.exit(1); }
    console.log('OK: manifest 与冻结 DDL 一致');
    return;
  }
  fs.writeFileSync(out, text);
  console.log(`已生成 ${path.relative(ROOT, out)}（groups=${manifest.counts.groups_total}, entries=${manifest.counts.entries_total}）`);
}

if (import.meta.url === 'file://' + process.argv[1].replace(/\\/g, '/') || process.argv[1]?.endsWith('gen-manifest.mjs')) {
  main();
}
