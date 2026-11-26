// 实施期环境前置断言（D02-01 阶段 0 要求）。
//
// 解决的问题：`IC_DATA_DIR` 不设时，config.js 会静默回退到 `<repo>/data`——脚本一跑就
// 写真实库。迁移/演练脚本最怕这种"看起来正常、其实在动生产数据"的默认值，所以这里把它
// 从"默认"改成"必须显式声明"：没设就抛错，不让脚本有机会跑起来。
//
// 只给脚本与测试用，**不挂在应用启动路径上**（否则开发机每次启动都要设变量）。
//
// ⚠️ 本模块**故意不 import config.js**：config.js 在模块加载时就把 IC_DATA_DIR 固化成
// DATA_DIR / DB_PATH，一旦 env-guard 先被加载，后面再设 IC_DATA_DIR 也不会生效——脚本会
// 自以为在隔离目录里跑，实际连的还是 data/ic.db（阶段 0 第一版测试就踩了这个坑，误写了真库）。
// 所以这里自己算 ROOT，只在函数调用时读 process.env。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// lib/core/env-guard.js -> lib/core -> lib -> 仓库根
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

export class EnvGuardError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'EnvGuardError';
    this.code = code;
    this.detail = detail;
  }
}

function norm(p) {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

// 判断 child 是否在 parent 目录内（含自身）
function isInside(child, parent) {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/**
 * 断言当前进程处于"隔离数据目录"环境。
 *
 * 规则（任一不满足即抛 EnvGuardError，**不提供静默回退**）：
 *  1. IC_DATA_DIR 必须显式设置且非空
 *  2. 必须是绝对路径（相对路径的解析基准会随 cwd 变，无法保证隔离）
 *  3. 不得等于 `<repo>/data`（生产数据根）
 *  4. 不得位于 `<repo>/data` 之内（生产数据根的任何子目录同样受保护）
 *  5. 目录必须可创建、可写（实际写一个探针文件再删掉）
 *
 * @returns {{ dataDir: string, dbPath: string, smokeFile: string }}
 */
export function assertEnv({ purpose = '实施脚本', requireSqlite = false } = {}) {
  const raw = process.env.IC_DATA_DIR;
  if (!raw || !String(raw).trim()) {
    throw new EnvGuardError(
      'IC_DATA_DIR_NOT_SET',
      `[${purpose}] 拒绝执行：未设置 IC_DATA_DIR。\n`
      + '  本脚本只允许在隔离数据目录内运行，例如：\n'
      + '    IC_DATA_DIR=/tmp/ic-stage0 node <script>\n'
      + '  （Windows: IC_DATA_DIR=%TEMP%\\ic-stage0）\n'
      + '  不会自动回退到仓库内的 data/ 目录。',
      { env: 'IC_DATA_DIR' },
    );
  }

  const value = String(raw).trim();
  if (!path.isAbsolute(value)) {
    throw new EnvGuardError(
      'IC_DATA_DIR_NOT_ABSOLUTE',
      `[${purpose}] 拒绝执行：IC_DATA_DIR 必须是绝对路径，当前为 "${value}"。`
      + ' 相对路径会随工作目录变化，无法保证隔离。',
      { env: 'IC_DATA_DIR', value },
    );
  }

  const dataDir = path.resolve(value);
  const prodDataDir = path.join(REPO_ROOT, 'data');
  if (norm(dataDir) === norm(prodDataDir)) {
    throw new EnvGuardError(
      'IC_DATA_DIR_IS_DEFAULT',
      `[${purpose}] 拒绝执行：IC_DATA_DIR 指向生产数据目录 ${prodDataDir}。`
      + ' 请改用独立目录（如 /tmp/ic-stage0）。',
      { env: 'IC_DATA_DIR', value: dataDir, production: prodDataDir },
    );
  }
  if (isInside(dataDir, prodDataDir)) {
    throw new EnvGuardError(
      'IC_DATA_DIR_INSIDE_PRODUCTION',
      `[${purpose}] 拒绝执行：IC_DATA_DIR (${dataDir}) 位于生产数据根 ${prodDataDir} 之内。`
      + ' 生产目录下的任何子目录都不作为隔离环境使用。',
      { env: 'IC_DATA_DIR', value: dataDir, production: prodDataDir },
    );
  }

  if (requireSqlite) {
    const provider = String(process.env.IC_DB || (process.env.DATABASE_URL ? 'postgres' : 'sqlite')).toLowerCase();
    if (provider.startsWith('postgres') || provider === 'pg') {
      throw new EnvGuardError(
        'STAGE0_REQUIRES_SQLITE',
        `[${purpose}] 拒绝执行：阶段 0 的备份/恢复演练只支持 SQLite 文件库，当前 IC_DB/DATABASE_URL 指向 PostgreSQL。`
        + ' 请先 unset DATABASE_URL 与 IC_DB。',
        { provider },
      );
    }
  }

  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (e) {
    throw new EnvGuardError(
      'IC_DATA_DIR_NOT_CREATABLE',
      `[${purpose}] 拒绝执行：无法创建 IC_DATA_DIR (${dataDir})：${e.message}`,
      { value: dataDir, cause: e.message },
    );
  }

  const smokeFile = path.join(dataDir, '.ic-stage0-write-probe');
  try {
    fs.writeFileSync(smokeFile, String(Date.now()));
    fs.rmSync(smokeFile, { force: true });
  } catch (e) {
    throw new EnvGuardError(
      'IC_DATA_DIR_NOT_WRITABLE',
      `[${purpose}] 拒绝执行：IC_DATA_DIR (${dataDir}) 不可写：${e.message}`,
      { value: dataDir, cause: e.message },
    );
  }

  const dbPath = process.env.IC_DB_SQLITE_PATH
    ? path.resolve(process.env.IC_DB_SQLITE_PATH)
    : path.join(dataDir, 'ic.db');

  // 数据库文件若落在生产目录下，同样拒绝（防止 IC_DB_SQLITE_PATH 绕过 IC_DATA_DIR 检查）
  if (isInside(dbPath, prodDataDir)) {
    throw new EnvGuardError(
      'IC_DB_PATH_INSIDE_PRODUCTION',
      `[${purpose}] 拒绝执行：数据库路径 (${dbPath}) 位于生产数据根 ${prodDataDir} 之内。`,
      { dbPath, production: prodDataDir },
    );
  }

  return { dataDir, dbPath };
}

// 阶段 0 专用：在 assertEnv 基础上要求 SQLite 文件库
export function assertStage0Env(purpose = '阶段 0 脚本') {
  return assertEnv({ purpose, requireSqlite: true });
}
