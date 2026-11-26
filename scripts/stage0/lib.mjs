// 阶段 0 脚本共用工具：指纹、只读打开、行数、结构导出、JSON 落盘。
//
// 全部产物都写在 IC_DATA_DIR 内（仓库外或 gitignore 的子目录），避免把演练库/备份误提交。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const STAGE0_TABLES = [
  'projects', 'assets', 'shots', 'chapters', 'jobs', 'queue_items',
  'skills', 'workflows', 'messages', 'reference_images', 'shot_videos', 'change_logs',
];

export function sha256File(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  return file;
}

// 表清单：排除 sqlite 内部表
export function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map((r) => r.name);
}

export function rowCounts(db, tables = STAGE0_TABLES) {
  const out = {};
  const existing = new Set(tableNames(db));
  for (const t of tables) {
    out[t] = existing.has(t) ? db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n : null;
  }
  return out;
}

export function integrityCheck(db) {
  const r = db.prepare('PRAGMA integrity_check').get();
  return r ? r.integrity_check : 'unknown';
}

// 结构快照：{ 表名: [列名...] }，用于"不丢历史列"的比对
export function schemaDump(db) {
  const out = {};
  for (const t of tableNames(db)) {
    out[t] = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  }
  return out;
}

export function blockingStats(db) {
  const cols = db.prepare('PRAGMA table_info(shots)').all().map((c) => c.name);
  if (!cols.includes('blocking')) return { hasColumn: false, nonEmpty: null, total: null };
  const nonEmpty = db.prepare("SELECT COUNT(*) AS n FROM shots WHERE blocking IS NOT NULL AND blocking <> ''").get().n;
  const total = db.prepare('SELECT COUNT(*) AS n FROM shots').get().n;
  return { hasColumn: true, nonEmpty, total };
}

export function pct(a, b) {
  if (!b) return 'n/a';
  return ((a / b) * 100).toFixed(1) + '%';
}
