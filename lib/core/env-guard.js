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

// 取"最接近该路径的已存在祖先"——目标文件还没建时，realpath 会抛 ENOENT，
// 但它的父目录可能已经是个符号链接（`iso/link -> /prod`），这时必须按真实父目录判。
function nearestExisting(target) {
  let cur = path.resolve(target);
  for (;;) {
    if (fs.existsSync(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
}

/**
 * 真实路径（解析符号链接 / junction）。
 * 已存在的部分走 realpath，不存在的尾部按字符串接回去，保证"未创建的文件"也能比。
 */
export function realPathOf(target) {
  const abs = path.resolve(target);
  const base = nearestExisting(abs);
  let real;
  try {
    real = fs.realpathSync.native ? fs.realpathSync.native(base) : fs.realpathSync(base);
  } catch {
    real = base;
  }
  const rest = path.relative(base, abs);
  return rest ? path.join(real, rest) : real;
}

/**
 * 数据库文件隔离校验（A-01 的核心）。
 *
 * 与 assertEnv 的分工：
 *   - assertEnv 看的是**环境变量字符串**（IC_DATA_DIR 本身合不合法）；
 *   - 本函数看的是**最终真正会被打开的 SQLite 文件路径**（dbSettings().sqlitePath），
 *     因此 `IC_DB_SQLITE_PATH` 与 `config.json` 的 `db.sqlite.path` 都绕不过去。
 *
 * 生产模式（未设 IC_DATA_DIR）不做隔离约束——生产库本来就在 `<repo>/data`；
 * 一旦设置了 IC_DATA_DIR，就要求实际库文件在它里面（按真实路径比，防符号链接逃逸）。
 */
export function assertDbIsolation({ dataDir, dbPath, purpose = '数据库隔离检查' } = {}) {
  if (!dataDir || !String(dataDir).trim()) {
    return { enforced: false, dbPath: dbPath ? path.resolve(dbPath) : '' };
  }
  if (!dbPath || !String(dbPath).trim()) {
    throw new EnvGuardError('DB_PATH_EMPTY', `[${purpose}] 拒绝执行：数据库路径为空。`, { dataDir });
  }

  const realData = realPathOf(dataDir);
  const realDb = realPathOf(dbPath);

  if (!isInside(realDb, realData)) {
    throw new EnvGuardError(
      'IC_DB_PATH_OUTSIDE_DATA_DIR',
      `[${purpose}] 拒绝执行：实际数据库路径不在隔离目录内。\n`
      + `  数据库路径（真实）: ${realDb}\n`
      + `  隔离目录（真实）  : ${realData}\n`
      + '  常见原因：IC_DB_SQLITE_PATH 指向别处、config.json 的 db.sqlite.path 指到别处、'
      + '或隔离目录里有指向外部的符号链接。本断言在打开数据库之前执行，不会产生任何写入。',
      { dbPath: realDb, dataDir: realData },
    );
  }

  return { enforced: true, dataDir: realData, dbPath: realDb };
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

  // 符号链接逃逸：IC_DATA_DIR 本身可能是指向生产目录的软链 / junction。
  // 上面的字符串比较看不出这一层，必须按真实路径再判一次（A-01 第 4 条）。
  // 注意这一步必须在 mkdir / 写探针之前——否则"隔离目录"其实指向生产目录时，
  // 探针文件就写进生产目录了（写一个删一个也算写）。
  const realDataDir = realPathOf(dataDir);
  const realProdDir = realPathOf(prodDataDir);
  if (isInside(realDataDir, realProdDir)) {
    throw new EnvGuardError(
      'IC_DATA_DIR_SYMLINK_TO_PRODUCTION',
      `[${purpose}] 拒绝执行：IC_DATA_DIR (${dataDir}) 的真实路径 ${realDataDir} 落在生产数据根 ${realProdDir} 之内`
      + '（大概率是软链 / junction 指过来的）。请用真实目录。',
      { value: dataDir, real: realDataDir, production: realProdDir },
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

  // 环境变量这一层只做"粗筛"；真正生效的库文件路径由 assertDbIsolation 用
  // dbSettings().sqlitePath 再判一次（config.json 的 db.sqlite.path 只有那里才知道）。
  return { dataDir, dbPath, realDataDir };
}

// 阶段 0 专用：在 assertEnv 基础上要求 SQLite 文件库
export function assertStage0Env(purpose = '阶段 0 脚本') {
  return assertEnv({ purpose, requireSqlite: true });
}
