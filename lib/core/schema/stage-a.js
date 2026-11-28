// P10-A 阶段 A · 结构增量（A-01 / A-02 / A-03）
//
// 唯一权威：docs/D02/D02-40-P10-A正式实施任务书冻结版.md
//   A-01 → §3.1 表 A-01（D-30-01）：story_shots +segment_id，+2 索引（(project_id,segment_id)、(project_id,scene_uid)）
//   A-02 → §3.1 表 A-02（D-30-02/D-30-03）：story_shots +scene_uid；continuity_runs 的场次列 = scene_uid（8 列 2 索引，见 §7.1）
//   A-03 → §3.1 表 A-03（D-30-08）：shot_videos +input_hash
//
// 三条纪律（违反任一条就不是阶段 A 的 DDL）：
//  1. **不动 D01-05 的冻结 DDL 文本，也不动 tables.js 的 21 张表**：
//     `tests/stage1-schema.test.mjs` 逐列比对 tables.js ↔ D01-05，改一边就会红。
//     因此增量一律走「既有表补列（ensureColumn 语义）+ 独立新表」，与 D-30-01/02/03/08
//     「是否改正式规范：story_shots/shot_videos 否；continuity_runs 仅改 §8.2.4」一致。
//  2. **幂等**：补列先查表结构再 ALTER；建表/建索引全部 IF NOT EXISTS。重复执行零副作用。
//  3. **不吞异常**：查不到表、ALTER 失败、建索引失败一律抛出，不伪装成"已经建好了"。
//
// continuity_runs 的 8 列不是自创：逐字来自 D02-40 §7.1（原 D02-06 §8.2.4，经 D-30-03
// 把 scene_key 改名为 scene_uid）。真实库该表从未存在（0 行、0 DDL），因此"改名"在本轮
// 等价于"按新列名建表"，不需要 ALTER RENAME。

/**
 * 既有表补列（顺序即执行顺序；decision 用于报告逐项对账）。
 * 存**完整 ALTER 语句原文**而不是 {table,column,ddl} 三元组：manifest 生成器与巡检都要从
 * 「同一份冻结 DDL 文本」解析，拼字符串会让 DDL 变成代码里不可读、不可 diff 的片段。
 */
export const STAGE_A_COLUMNS = [
  { workItem: 'A-01', decision: 'D-30-01', sql: "ALTER TABLE story_shots ADD COLUMN segment_id TEXT DEFAULT ''" },
  { workItem: 'A-02', decision: 'D-30-02', sql: "ALTER TABLE story_shots ADD COLUMN scene_uid TEXT DEFAULT ''" },
  { workItem: 'A-03', decision: 'D-30-08', sql: "ALTER TABLE shot_videos ADD COLUMN input_hash TEXT DEFAULT ''" },
];

/** 从 ALTER 语句里取表名与列名（生成器与 initStageA 共用，避免两处各写一个正则） */
export function columnTargetOf(sql) {
  const m = String(sql).match(/ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/i);
  if (!m) throw new Error('不是合法的 ADD COLUMN 语句：' + sql);
  return { table: m[1], column: m[2] };
}

/**
 * 新表 / 索引的冻结 DDL 文本（逐字来源见文件头）。
 * 单独抽成常量而不是直接 exec：manifest 生成器与结构巡检都从**同一份文本**解析，
 * 避免"代码建了一套、manifest 登记另一套"。
 */
export const STAGE_A_DDL_TEXT = `
CREATE TABLE IF NOT EXISTS continuity_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  scene_uid TEXT NOT NULL,
  run_no INTEGER NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT DEFAULT '',
  created_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cr_run ON continuity_runs(project_id, scene_uid, run_no);
CREATE INDEX IF NOT EXISTS idx_cr_latest ON continuity_runs(project_id, scene_uid, run_no DESC);
`;

/** A-01 / A-02 要求的两条新索引（story_shots 上的段归属与场次身份） */
export const STAGE_A_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_ss_segment ON story_shots(project_id, segment_id)',
  'CREATE INDEX IF NOT EXISTS idx_ss_scene_uid ON story_shots(project_id, scene_uid)',
];

/**
 * 阶段 A 新建的表名（只有一张）。
 * 用途：回滚/降级脚本必须知道「除了阶段 1 的 21 张，还有这 1 张也不属于 legacy」——
 * 否则降级后它会留成孤儿表（tests/stage1-rollback.test.mjs R-08 就是抓这个的）。
 */
export const STAGE_A_TABLE_NAMES = ['continuity_runs'];

/** 把 STAGE_A_DDL_TEXT 拆成可逐条执行的语句（忽略空段） */
export function stageADdlStatements() {
  return STAGE_A_DDL_TEXT.split(';').map((s) => s.trim()).filter(Boolean);
}

/**
 * 建 P10-A 阶段 A 的结构增量。幂等、不吞异常。
 * @returns {{columnsAdded: string[], tables: number, indexes: number}}
 */
export function initStageA(db) {
  const columnsAdded = [];
  for (const c of STAGE_A_COLUMNS) {
    const { table, column } = columnTargetOf(c.sql);
    const cols = db.tableColumns(table);
    if (!cols || cols.length === 0) {
      // 表不存在时绝不"顺手建一张"：story_shots 属 21 张冻结表，shot_videos 属既有表，
      // 二者缺一都说明 schema 初始化顺序错了，必须当场暴露。
      throw new Error(`initStageA: 表 ${table} 不存在或不可读（${c.workItem} 无法补列 ${column}）`);
    }
    if (cols.includes(column)) continue;
    db.exec(c.sql);
    columnsAdded.push(`${table}.${column}`);
  }

  let tables = 0;
  let indexes = 0;
  for (const sql of stageADdlStatements()) {
    db.exec(sql);
    if (/^CREATE\s+TABLE/i.test(sql)) tables++;
    else if (/^CREATE\s+(UNIQUE\s+)?INDEX/i.test(sql)) indexes++;
  }
  for (const sql of STAGE_A_INDEXES) {
    db.exec(sql);
    indexes++;
  }
  return { columnsAdded, tables, indexes };
}

/**
 * 结构巡检：阶段 A 的三件事齐不齐。允许重跑补齐，但不允许带着缺失继续跑（调用方自判）。
 */
export function stageAStatus(db) {
  const missingColumns = [];
  for (const c of STAGE_A_COLUMNS) {
    const { table, column } = columnTargetOf(c.sql);
    const cols = db.tableColumns(table) || [];
    if (!cols.includes(column)) missingColumns.push(`${table}.${column}`);
  }
  const missingIndexes = [];
  const present = new Set(
    db.dialect === 'postgres'
      ? db.prepare("SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public'").all().map((r) => r.name)
      : db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name),
  );
  for (const sql of [...stageADdlStatements(), ...STAGE_A_INDEXES]) {
    const m = sql.match(/INDEX IF NOT EXISTS\s+(\w+)/i);
    if (m && !present.has(m[1])) missingIndexes.push(m[1]);
  }
  return {
    missingColumns,
    missingIndexes,
    ok: missingColumns.length === 0 && missingIndexes.length === 0,
  };
}
