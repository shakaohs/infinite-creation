// 阶段 1 schema 初始化入口
//
// 设计要点（都是阶段 0 踩过的坑，别退回旧写法）：
//  1. **不吞异常**：建表/建索引失败一律抛出。`try { ... } catch {}` 会把"表没建成"
//     伪装成"已经建好了"，等到第一次写入才炸，且现场已经过去很久。
//  2. **表全部建完再建索引**：SQLite 的 DDL 不在事务里，中途失败会留下半成品；
//     集中建索引让"表齐了、索引缺几条"这种状态可被重新执行补齐，也便于识别。
//  3. **幂等**：全部 IF NOT EXISTS，重复执行零副作用（§11.2 第 1/2 条）。
//  4. **不动既有表**：本模块只创建 21 张新表；`projects.structured_spec` 与
//     `shots.blocking` 由 db.js 的 ensureColumn 负责（既有表补列只有那两处）。
import { stage1DdlInOrder, STAGE1_INDEXES, STAGE1_TABLES } from './tables.js';

export { STAGE1_TABLES, STAGE1_INDEXES };

/** 21 张新建表的表名（不含既有 shots / projects） */
export function stage1TableNames() {
  return STAGE1_TABLES.map((t) => t.name);
}

/** 按分组取表名，用于 manifest / 巡检 */
export function stage1TablesByGroup() {
  const out = { ops: [], archive: [], biz: [], d02_ext: [] };
  for (const t of STAGE1_TABLES) out[t.group].push(t.name);
  return out;
}

/**
 * 建 21 张新表 + 全部索引。幂等、不吞异常。
 * @returns {{tables:number, indexes:number}}
 */
export function initStage1Schema(db) {
  const tables = stage1DdlInOrder();
  for (const ddl of tables) db.exec(ddl);
  for (const sql of STAGE1_INDEXES) db.exec(sql);
  return { tables: tables.length, indexes: STAGE1_INDEXES.length };
}

/**
 * 半成品识别：表齐不齐、索引齐不齐，分开报告。
 * 用途是"允许重跑补齐"，不是"允许带着缺失继续跑"——调用方要自己判。
 */
export function stage1Status(db) {
  const missingTables = [];
  for (const name of stage1TableNames()) {
    const cols = db.tableColumns(name);
    if (!cols || cols.length === 0) missingTables.push(name);
  }
  const presentIndexes = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name),
  );
  const missingIndexes = [];
  for (const sql of STAGE1_INDEXES) {
    const m = sql.match(/INDEX IF NOT EXISTS\s+(\w+)/);
    if (m && !presentIndexes.has(m[1])) missingIndexes.push(m[1]);
  }
  return { missingTables, missingIndexes, ok: missingTables.length === 0 && missingIndexes.length === 0 };
}
