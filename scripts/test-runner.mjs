#!/usr/bin/env node
// 测试唯一入口（阶段 3 · P0 测试环境隔离）。
//
// 为什么需要它：`node --test "tests/*.test.mjs"` 这一层没有任何前置断言。
// 文件里各自 mkdtemp 的用例是安全的，但 `tests/unit.test.mjs` 这类文件自己不设
// IC_DATA_DIR，config.js 便静默回退到 `<repo>/data/ic.db` —— `npm test` 直接写真实库。
// 本脚本把"先证明隔离，再跑测试"变成入口的硬前置：
//   ① IC_DATA_DIR 必须显式、绝对、不是生产目录、不是生产目录的子目录、可写；
//   ② 实际会被打开的库文件（dbSettings().sqlitePath，含 config.json 与 IC_DB_SQLITE_PATH
//      两处覆盖）必须按**真实路径**落在 IC_DATA_DIR 内 —— 符号链接/悬空链接都按目标判定；
//   ③ 任一不满足 → 退出码 2，不启动任何测试进程，不建库。
//
// 用法：
//   IC_DATA_DIR=/tmp/ic-test npm test
//   IC_DATA_DIR=%TEMP%\ic-test npm test
//   IC_DATA_DIR=/tmp/ic-test node scripts/test-runner.mjs --check   # 只做前置校验，不跑测试
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, assertEnv, assertDbIsolation, EnvGuardError } from '../lib/core/env-guard.js';
import { dbSettings } from '../lib/core/config.js';

const CHECK_ONLY = process.argv.includes('--check');
const emit = (o) => process.stdout.write('TEST-RUNNER ' + JSON.stringify(o) + '\n');

// 与 package.json 的 test 脚本保持同一组参数：node --test 自己展开这个 glob。
const TEST_ARGS = ['--test', '--test-force-exit', 'tests/*.test.mjs'];

function preflight() {
  // 只做前置校验：不打开数据库，不建库；assertEnv 只在 IC_DATA_DIR 内写一个探针文件再删。
  const env = assertEnv({ purpose: '测试入口（P0 隔离）' });
  // dbSettings() 只读配置、不连库；sqlitePath 才是最终会被打开的文件。
  const settings = dbSettings();
  if (settings.provider === 'postgres') {
    // 测试套件默认是 SQLite 文件库；指到 PG 时隔离无意义（也没有文件可判），直接说明并拒绝。
    throw new EnvGuardError(
      'TEST_REQUIRES_SQLITE',
      `[测试入口（P0 隔离）] 拒绝执行：当前 IC_DB/DATABASE_URL 指向 PostgreSQL（${settings.provider}）。\n`
      + '  P0 的隔离判定针对 SQLite 文件路径；跑测试前请 unset DATABASE_URL 与 IC_DB。',
      { provider: settings.provider },
    );
  }
  const iso = assertDbIsolation({
    dataDir: env.dataDir,
    dbPath: settings.sqlitePath,
    purpose: '测试入口（P0 隔离）',
  });
  return { env, settings, iso };
}

try {
  const { env, settings, iso } = preflight();
  emit({
    phase: 'preflight',
    ok: true,
    dataDir: iso.dataDir,
    dbPath: iso.dbPath,
    dbPathSource: settings.sqlitePathSource,
    followedLink: !!iso.followedLink,
    checkOnly: CHECK_ONLY,
  });
  if (CHECK_ONLY) process.exit(0);

  const r = spawnSync(process.execPath, TEST_ARGS, {
    cwd: REPO_ROOT,
    env: process.env, // 子进程必须拿到同一个 IC_DATA_DIR；db.js 在测试进程里还会再判一次
    stdio: 'inherit',
  });
  if (r.error) {
    emit({ phase: 'run', ok: false, code: 'SPAWN_FAILED', message: String(r.error.message || r.error) });
    process.exit(2);
  }
  emit({ phase: 'run', ok: r.status === 0, status: r.status, signal: r.signal || '' });
  process.exit(r.status == null ? 2 : r.status);
} catch (e) {
  const code = (e && e.code) || 'TEST_PREFLIGHT_FAILED';
  emit({
    phase: 'preflight',
    ok: false,
    name: (e && e.name) || 'Error',
    code,
    message: String((e && e.message) || e).split('\n')[0],
    detail: (e && e.detail) || {},
  });
  // 把完整提示写到 stderr，方便开发者一眼看到怎么改
  process.stderr.write(String((e && e.message) || e) + '\n');
  process.exit(2);
}
