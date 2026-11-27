// P6 · CK-2 取证脚本（只读）
//
// 打印 69 条规则的逐规则双向 diff（映射 vs 实际读取）。任一条非空即 R-28 不能闭合。
// 用法：node scripts/audit/p6-ck2.mjs [--json] [--verbose]
//
// 电池在 `tests/helpers/ck2-battery.mjs`（与 `tests/stage3-p6-ck.test.mjs` 共用一份）：
// 两处若各写一套，最坏情况是"脚本绿、测试红"，而 R-28 是硬验收项，不能有两种结论。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-p6-ck2-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;
delete process.env.IC_DB;
delete process.env.DATABASE_URL;

const V = await import('../../lib/core/validate/index.js');
const { RULE_DEPS } = await import('../../lib/core/qc/deps/rule-deps.js');
const { runCk2, toTable } = await import('../../tests/helpers/ck2.mjs');
const { BATTERY } = await import('../../tests/helpers/ck2-battery.mjs');

const res = runCk2({ rules: V.RULES, deps: RULE_DEPS, battery: BATTERY });

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
} else {
  if (process.argv.includes('--verbose')) console.log(toTable(res.rows));
  else {
    for (const r of res.rows) {
      const bad = r.missing.length || r.extra.length || r.throw;
      if (!bad) continue;
      console.log(`${r.rule_id}  missing=[${r.missing.join(', ')}]  extra=[${r.extra.join(', ')}]  throw=${r.throw}`);
    }
  }
  console.log('');
  console.log(`规则 ${res.total.rules}；通过 ${res.total.passed}；不通过 ${res.total.failed}；映射字段合计 ${res.total.declaredSum}；实际读取合计 ${res.total.actualSum}`);
}
process.exitCode = res.total.failed === 0 ? 0 : 1;
