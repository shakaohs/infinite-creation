#!/usr/bin/env node
// 阶段 1 回滚：清理本阶段新建的 21 张表（任务书 §12）
//
// 【V1.1 A-01 修复】原版直接 `new DatabaseSync(dbPath)` —— 只要给个路径就能删表，
// 等于把一个"能 DROP 21 张表"的脚本交给任意路径。现在**任何路径检查都在打开数据库之前**：
//
// 安全门槛（任何一条不满足就中止，不给 --force 这种口子）：
//   0. 环境：复用阶段 0 正式通过的 assertEnv()（IC_DATA_DIR 必须显式、绝对、非生产目录、可写）
//   0.1 路径：复用 assertDbIsolation()，按**真实路径**（逐段 lstat + readlink，悬空链接也解析）
//            判定 --db 落在 IC_DATA_DIR 之内；不用字符串前缀
//   0.2 --db 必须是绝对路径（相对路径的解析基准随 cwd 变，等于把"删哪个库"交给运气）
//   1. 正向白名单：manifest.groups 的表名集合必须与 STAGE1_TABLES **完全一致**
//      （少一张 / 多一张 / 换掉一张 / manifest 结构异常 → 一律拒；不再只看"数量是不是 21"）
//   2. `shots` / `projects` 等 12 张既有表**永远不在清单里**
//   3. 逐表检查：只要存在业务数据就中止（空表才允许 DROP）
//   4. `migration_items` / `migration_edges` 有任何实际数据 → 立即中止
//   5. `migration_batches` 只允许存在基线记录（name='schema-init' 且无迁移记录）
//   6. 默认干跑（**只读连接**，不执行任何 DDL/DML）；要真删必须显式 --execute
//
// 用法：
//   IC_DATA_DIR=<隔离目录> node scripts/stage1/rollback-stage1.mjs --db <绝对路径>              # 干跑
//   IC_DATA_DIR=<隔离目录> node scripts/stage1/rollback-stage1.mjs --db <绝对路径> --execute     # 真删
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { assertEnv, assertDbIsolation, resolvePathDetail } from '../../lib/core/env-guard.js';
import { STAGE1_TABLES } from '../../lib/core/schema/tables.js';
import { STAGE_A_TABLE_NAMES } from '../../lib/core/schema/stage-a.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST = path.join(ROOT, 'lib', 'core', 'schema-manifest.json');
const PROD_DATA_DIR = path.join(ROOT, 'data');

// 明确写死的不许删清单（多一道保险：即使 manifest 被人改坏也不会误删）
const NEVER_DROP = ['shots', 'projects', 'chapters', 'assets', 'shot_videos', 'change_logs', 'jobs', 'queue_items', 'messages', 'reference_images', 'skills', 'workflows'];

// 阶段 1 的 21 张表：唯一权威来自冻结模块，不从 manifest 反推
// （从 manifest 反推 = 自己证明自己，manifest 被改坏时白名单等于没有）
const EXPECTED = STAGE1_TABLES.map((t) => t.name);
const EXPECTED_GROUP = new Map(STAGE1_TABLES.map((t) => [t.name, t.group]));

// P10-A 阶段 A 新建的表（continuity_runs）。它**不属于阶段 1 的 21 张**，也不属于 12 张既有表，
// 但降级时必须一起清掉：留成孤儿表的后果是"库看起来回到了 legacy，却多出一张没人维护的表"，
// 下一次 initSchema 又会把它建回来，两边对不上。白名单同样来自冻结模块，不从 manifest 反推。
const STAGE_A_EXPECTED = STAGE_A_TABLE_NAMES;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : '';
}

/** 环境与路径隔离（**全部在打开数据库之前**）。失败直接 exit(2)，返回隔离信息。 */
function guardBeforeOpen(dbPathInput) {
  const reject = (code, message) => {
    console.error(`拒绝执行 [${code}]：${message}`);
    process.exit(2);
  };

  // ① IC_DATA_DIR：必须显式、绝对、非生产目录、可写
  let env;
  try {
    env = assertEnv({ purpose: '阶段 1 回滚脚本' });
  } catch (e) {
    reject(e.code || 'ENV_GUARD', e.message);
  }

  // ② --db 必须绝对路径
  if (!path.isAbsolute(dbPathInput)) {
    reject('DB_PATH_NOT_ABSOLUTE', `--db 必须是绝对路径，当前为 "${dbPathInput}"。\n`
      + '  相对路径会随工作目录变化，等于把"删哪个库"交给运气。');
  }

  // ③ 真实路径必须在 IC_DATA_DIR 内（符号链接 / 悬空链接 / 路径解析异常都按阶段 0 规则处理）
  let isolation;
  try {
    isolation = assertDbIsolation({
      dataDir: env.dataDir,
      dbPath: dbPathInput,
      purpose: '阶段 1 回滚脚本',
    });
  } catch (e) {
    reject(e.code || 'DB_ISOLATION', e.message);
  }

  // ④ 双保险：真实路径不得落在仓库 data/ 内（正常情况下 ①② 已拦住）
  const realDb = resolvePathDetail(dbPathInput).realPath;
  const realProd = resolvePathDetail(PROD_DATA_DIR).realPath;
  const relToProd = path.relative(realProd, realDb);
  if (relToProd === '' || (!relToProd.startsWith('..') && !path.isAbsolute(relToProd))) {
    reject('DB_IN_PRODUCTION', `数据库真实路径 ${realDb} 落在生产数据根 ${realProd} 内。`);
  }

  if (!fs.existsSync(dbPathInput)) {
    reject('DB_NOT_FOUND', '数据库不存在：' + dbPathInput);
  }

  return { isolation, realDb, followedLink: resolvePathDetail(dbPathInput).followedLink };
}

/** 正向白名单：manifest 表名集合必须与 STAGE1_TABLES 完全一致。返回 21 个表名（按建表序）。 */
function resolveTargets(manifestPath) {
  const fail = (msg) => { console.error('拒绝执行：' + msg); process.exit(2); };

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    fail(`manifest 无法解析（${manifestPath}：${e.message}）`);
  }
  const groups = manifest && manifest.groups;
  if (!groups || typeof groups !== 'object') fail('manifest.groups 缺失或不是对象');
  for (const g of ['ops', 'archive', 'biz', 'd02_ext']) {
    if (!groups[g] || typeof groups[g] !== 'object' || Array.isArray(groups[g])) fail(`manifest.groups.${g} 缺失或不是对象`);
  }

  const names = [];
  for (const g of ['ops', 'archive', 'biz', 'd02_ext']) {
    for (const name of Object.keys(groups[g])) {
      if (EXPECTED_GROUP.get(name) && EXPECTED_GROUP.get(name) !== g) {
        fail(`manifest 分组错位：${name} 属于 ${EXPECTED_GROUP.get(name)}，却登记在 ${g}`);
      }
      names.push(name);
    }
  }

  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  if (dup.length) fail(`manifest 有重复表名：${[...new Set(dup)].join(',')}`);
  if (names.length !== 21) fail(`manifest 分组应为 21 张，实际 ${names.length}`);

  const unknown = names.filter((n) => !EXPECTED.includes(n));
  if (unknown.length) fail(`manifest 出现未知表（不在阶段 1 正式清单里）：${unknown.join(',')}`);
  const missing = EXPECTED.filter((n) => !names.includes(n));
  if (missing.length) fail(`manifest 缺少阶段 1 正式表：${missing.join(',')}`);

  for (const t of names) {
    if (NEVER_DROP.includes(t)) fail(`${t} 在"永不删除"清单里`);
  }

  // 阶段 A 组：必须与冻结模块的清单**完全一致**（少一张多一张都拒）
  const stageA = groups.stage_a && typeof groups.stage_a === 'object' && !Array.isArray(groups.stage_a)
    ? Object.keys(groups.stage_a)
    : [];
  const unknownA = stageA.filter((n) => !STAGE_A_EXPECTED.includes(n));
  if (unknownA.length) fail(`manifest.groups.stage_a 出现未知表：${unknownA.join(',')}`);
  const missingA = STAGE_A_EXPECTED.filter((n) => !stageA.includes(n));
  if (missingA.length) fail(`manifest.groups.stage_a 缺少阶段 A 正式表：${missingA.join(',')}`);
  for (const t of stageA) {
    if (NEVER_DROP.includes(t)) fail(`${t} 在"永不删除"清单里`);
  }

  // 按建表顺序返回（DROP 时逆序）；阶段 A 表排在最前（建得最晚）
  // 两块分开返回：`targets` 这个数字在历史报告里恒为 21（阶段 1 的 21 张），
  // 阶段 A 的表单独计，避免"21 张"这个已被引用的口径悄悄变成 22。
  return { stage1: EXPECTED.slice(), stageA: stageA.slice(), all: [...EXPECTED, ...stageA] };
}

function main() {
  const eqArg = process.argv.find((a) => a.startsWith('--db='));
  const dbInput = arg('--db') || (eqArg ? eqArg.slice('--db='.length) : '');
  const execute = process.argv.includes('--execute');
  if (!dbInput) { console.error('用法: --db <绝对路径> [--execute]'); process.exit(2); }

  // 路径与环境检查全部在打开之前完成
  const guard = guardBeforeOpen(dbInput);
  // manifest 可换路径只为"验证白名单确实在起作用"（拿一份被改坏的 manifest 试拒绝）；
  // 换路径不降低安全性：白名单的真正依据是冻结模块 STAGE1_TABLES，不是这个文件。
  const resolved = resolveTargets(arg('--manifest') || MANIFEST);
  const targets = resolved.all;

  // 干跑：只读连接（SQLite 层面就写不进去，不靠"记得别写"）
  const db = execute
    ? new DatabaseSync(dbInput)
    : new DatabaseSync(dbInput, { readOnly: true });

  const exists = (t) => {
    const r = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    return !!r;
  };
  const count = (t) => (exists(t) ? db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n : 0);

  const report = {
    db: dbInput,
    dbRealPath: guard.realDb,
    dataDir: guard.isolation.dataDir,
    followedLink: !!guard.followedLink,
    mode: execute ? 'execute' : 'dry-run',
    connection: execute ? 'read-write' : 'read-only',
    execute,
    targets: resolved.stage1.length,
    stageATargets: resolved.stageA,
    whitelist: 'exact',
    blockers: [],
    plan: [],
  };

  // 门槛：运维表数据
  const mi = count('migration_items');
  const me = count('migration_edges');
  if (mi > 0) report.blockers.push(`migration_items 有 ${mi} 行实际迁移记录`);
  if (me > 0) report.blockers.push(`migration_edges 有 ${me} 行依赖边`);

  // 基线识别（先算清楚，后面逐表判断不再依赖"此刻 blockers 是否为空"）
  const batchRows = exists('migration_batches')
    ? db.prepare('SELECT id,name FROM migration_batches').all()
    : [];
  const baselineIds = new Set(batchRows.filter((r) => r.name === 'schema-init').map((r) => r.id));
  const nonBaseline = batchRows.filter((r) => r.name !== 'schema-init');
  if (nonBaseline.length) {
    report.blockers.push(`migration_batches 存在非基线批次：${nonBaseline.map((r) => r.id).join(',')}`);
  }

  // 逐表清点
  for (const t of targets) {
    const n = count(t);
    const onlyBaseline = t === 'migration_batches' && n === baselineIds.size && nonBaseline.length === 0;
    const allowed = n === 0 || onlyBaseline;
    report.plan.push({ table: t, rows: n, exists: exists(t), droppable: allowed });
    if (!allowed) report.blockers.push(`${t} 有 ${n} 行业务数据，不允许 DROP`);
  }

  if (report.blockers.length) {
    db.close();
    console.log(JSON.stringify({ ...report, result: 'ABORTED' }, null, 2));
    process.exit(1);
  }

  if (!execute) {
    db.close();
    console.log(JSON.stringify({ ...report, result: 'DRY_RUN_OK' }, null, 2));
    return;
  }

  // 真删：索引随表自动消失；按建表逆序 DROP
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
