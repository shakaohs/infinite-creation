// 从冻结 DDL 文本解析出每张表的列名集合（manifest 与测试共用）
//
// 只做一件事：把 markdown 里的 ```sql 代码块 / JS 模板字符串里的 CREATE TABLE 语句，
// 解析成 { tableName: [col, ...] }。
//
// 为什么不用数据库反推：数据库只能证明"我们建了什么"，不能证明"冻结文档要求什么"。
// 建错了，反推会把错误固化成"规范"。（D02-03 V3 §九 N5 / 任务书 §4.3）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 解析一条 CREATE TABLE 语句里的列名（排除表级约束行） */
export function parseColumnsFromCreate(sql) {
  const open = sql.indexOf('(');
  const close = sql.lastIndexOf(')');
  if (open < 0 || close < 0) return [];
  // 必须先剔注释再切分：注释里可能带逗号（"（两条路径必须都能得到同一列，否则…）"），
  // 先切分后剔会把一行切成两半，列名直接少一个。本机实测漏过 column。
  const body = sql.slice(open + 1, close).replace(/--[^\n]*/g, '');
  // 按顶层的逗号切分（括号内的逗号不切）
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);

  const cols = [];
  for (const raw of parts) {
    const line = raw.split('\n').map((s) => s.replace(/--.*$/, '').trim()).filter(Boolean).join(' ').trim();
    if (!line) continue;
    // 表级约束：不是列
    if (/^(PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|CONSTRAINT)\b/i.test(line)) continue;
    const name = line.split(/\s+/)[0];
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) cols.push(name);
  }
  return cols;
}

/** 从 markdown 里抽取所有 CREATE TABLE IF NOT EXISTS 块 → { table: [cols] } */
export function parseTablesFromMarkdown(md) {
  const out = {};
  const blocks = [...md.matchAll(/```sql\s*([\s\S]*?)```/g)].map((m) => m[1]);
  for (const b of blocks) {
    const re = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(/g;
    let m;
    while ((m = re.exec(b))) {
      const name = m[1];
      const start = m.index;
      // 找到与之配对的右括号（从 name 后的 '(' 开始计深度）
      const parenIdx = b.indexOf('(', start + m[0].length - 1);
      let depth = 0;
      let end = -1;
      for (let i = parenIdx; i < b.length; i++) {
        if (b[i] === '(') depth++;
        else if (b[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end < 0) continue;
      out[name] = parseColumnsFromCreate(b.slice(start, end + 1));
    }
  }
  return out;
}

/** 从 JS 源码（db.js 的模板字符串）里抽取 CREATE TABLE 块 → { table: [cols] } */
export function parseTablesFromJs(src) {
  const out = {};
  const re = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1];
    const parenIdx = src.indexOf('(', m.index + m[0].length - 1);
    let depth = 0;
    let end = -1;
    for (let i = parenIdx; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) continue;
    out[name] = parseColumnsFromCreate(src.slice(m.index, end + 1));
  }
  return out;
}

/** 从 markdown / JS 文本里抽取所有 `ALTER TABLE x ADD COLUMN y` → { table: [col, ...] } */
export function parseAlterAddColumns(src) {
  const out = {};
  const re = /ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/gi;
  let m;
  while ((m = re.exec(src))) {
    const [, table, col] = m;
    (out[table] ||= []).push(col);
  }
  return out;
}

export function readText(absPath) {
  return fs.readFileSync(absPath, 'utf8');
}

/** 仓库根（从 scripts/schema/ 往上两级） */
export function repoRoot() {
  // 必须用 fileURLToPath：URL.pathname 是百分号编码的，仓库路径含中文会被编码成
  // %E6%97%A0… 直接拿去 fs 读就 ENOENT（本机实测踩过，不是理论问题）。
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}
