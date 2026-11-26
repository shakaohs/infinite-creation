// 数据库隔离探针：在**独立进程**里解析配置 → 过守卫 → 真打开库，把结果打成一行 JSON。
//
// 为什么必须独立进程：config.js 在模块加载时就把 IC_DATA_DIR/DB_PATH 固化，
// 同一进程里换环境变量再 import 是不会生效的。隔离矩阵的每一条场景都得新起一个进程，
// 否则测的是"上一场景留下的模块缓存"，不是这条场景。
//
// 用法：node tests/helpers/db-guard-probe.mjs
// 输出：PROBE {...}
import fs from 'node:fs';

const out = (o) => process.stdout.write('PROBE ' + JSON.stringify(o) + '\n');

try {
  const cfg = await import('../../lib/core/config.js');
  const dbMod = await import('../../lib/core/db.js');
  const settings = cfg.dbSettings();
  dbMod.getDb(); // 触发 assertDbIsolation + 真正建库/建表
  out({
    ok: true,
    provider: settings.provider,
    sqlitePath: settings.sqlitePath,
    sqlitePathSource: settings.sqlitePathSource,
    dataDir: cfg.DATA_DIR,
    dbExists: fs.existsSync(settings.sqlitePath),
  });
} catch (e) {
  out({
    ok: false,
    name: e.name || 'Error',
    code: e.code || '',
    message: String(e.message || e).split('\n')[0],
  });
  process.exitCode = 3;
}
