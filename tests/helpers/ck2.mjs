// CK-2（D02-06 §9.2.1 末表）：69 条规则的**逐规则双向 diff**
//
// 左边：`RULE_DEPS[ruleId].fields`（8 列映射里的"读取字段"）
// 右边：该规则**实际读取**的 ctx 路径（深层 Proxy 采集，不是看注释、不是看映射表）
//
// 为什么必须逐规则而不是看并集：两条规则各漏一个字段、又各多一个，并集能对上 ——
// R-28 就是这么发生的（CK-1 只有并集检查）。
//
// 采集方式与它的边界（报告 §十 明确写出）：
//   · 一组"故意缺数据/故意触发分支"的上下文各跑一遍，取并集；
//   · 这是**动态覆盖**：未执行到的分支读不到。所以判据是 **extra=0**（声明的每个字段都必须被观测到）
//     —— 它反过来保证"电池足够覆盖映射"，不会出现"映射写了但代码从不读"。
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** 访问器/容器方法名：不是字段，只是读法 */
const METHOD = new Set([
  'length', 'filter', 'map', 'some', 'every', 'find', 'findIndex', 'includes', 'forEach',
  'slice', 'sort', 'join', 'reduce', 'keys', 'values', 'entries', 'push', 'split', 'trim',
  'startsWith', 'endsWith', 'concat', 'indexOf', 'toLowerCase', 'hasOwnProperty',
  'toString', 'valueOf', 'replace', 'match', 'constructor',
]);

/** 派生键：由数据算出来的，不是输入行（`level` = computeLevel 的结果） */
const DERIVED = new Set(['level']);

const isIndex = (s) => /^\d+$/.test(s);

/** 同一列的两种形状：`x_json` 是列名，`x` 是行对象展开后的旧写法（多数规则两个都读） */
const ALIAS = [
  ['actions.sync', 'actions.sync_json'],
  ['actions.speed', 'actions.speed_json'],
  ['actions.contact', 'actions.contact_json'],
  ['actions.path', 'actions.path_json'],
  ['actions.trigger', 'actions.trigger_json'],
  ['actions.result', 'actions.result_json'],
  ['actions.end_state_json', 'actions.end_state'],
];

/** 原始 Proxy 路径 → 映射口径的字段路径 */
export function normalizePath(raw) {
  let s = String(raw);
  // `assetsById.<id>` / `assetsById.<id>.<field>` → `assets` / `assets.<field>`
  s = s.replace(/^assetsById(\.[^.]+)?/, 'assets');
  const segs = s.split('.').filter((x) => x && !isIndex(x) && !METHOD.has(x) && !DERIVED.has(x));
  let joined = segs.join('.');
  for (const [from, to] of ALIAS) {
    if (joined === from) { joined = to; break; }
    if (joined.startsWith(`${from}.`)) { joined = to + joined.slice(from.length); break; }
  }
  return joined;
}

/** 深层 Proxy：任何属性读取都上报（返回的仍是可继续读的 Proxy） */
export function track(onPath) {
  const wrap = (val, p) => {
    if (val === null || typeof val !== 'object') return val;
    return new Proxy(val, {
      get(target, key, recv) {
        if (typeof key === 'symbol') return Reflect.get(target, key, recv);
        const next = p ? `${p}.${key}` : String(key);
        onPath(next);
        return wrap(Reflect.get(target, key, recv), next);
      },
    });
  };
  return wrap;
}

const strip = (decl) => String(decl).replace(/\[\*\]/g, '');

/**
 * 单规则双向 diff。
 *
 * 口径（两种方向不对称，故意的）：
 *  · **actual 被覆盖**（宽）：`a === d`、`a` 在 `d` 之下、或 `d` 在 `a` 之下
 *    —— 读容器本身不等于读它的每个字段；
 *  · **declared 被观测**（严）：`a === d` 或 `a` 在 `d` 之下
 *    —— 声明了父路径不能靠"读过子路径之一"冒充（否则漏字段永远查不出来）。
 *
 * @param {Array<string>} declared
 * @param {Array<string>} actual
 * @returns {{missing:string[], extra:string[]}}
 */
export function diffRule(declared, actual) {
  const decl = [...new Set(declared.map(strip))].sort();
  const act = [...new Set(actual.map(strip).filter(Boolean))].sort();
  const covered = (a) => decl.some((d) => a === d || a.startsWith(`${d}.`) || d.startsWith(`${a}.`));
  const observed = (d) => act.some((a) => a === d || a.startsWith(`${d}.`));
  return {
    missing: act.filter((a) => !covered(a)),
    extra: decl.filter((d) => !observed(d)),
  };
}

/**
 * 完整 CK-2：对 `RULES` 里每条规则跑电池，返回逐规则结果。
 *
 * @param {{rules:Array, deps:object, battery:Array<{name:string, ctx:object}>}} p
 * @returns {{rows:Array, total:object}}
 */
export function runCk2({ rules, deps, battery }) {
  const rows = [];
  for (const rule of rules) {
    const seen = new Set();
    const errors = [];
    for (const v of battery) {
      const raw = [];
      try {
        rule.run(track((p) => raw.push(p))(v.ctx));
      } catch (e) {
        errors.push(`${v.name}: ${e && e.message}`);
      }
      for (const p of raw) {
        const n = normalizePath(p);
        if (n) seen.add(n);
      }
    }
    const actual = [...seen].sort();
    const d = deps[rule.id];
    const declared = d ? d.fields : null;
    const diff = declared ? diffRule(declared, actual) : { missing: ['<未登记规则>'], extra: [] };
    rows.push({
      rule_id: rule.id,
      scope: d?.scope ?? '',
      declared: declared ? declared.length : 0,
      actual: actual.length,
      missing: diff.missing,
      extra: diff.extra,
      throw: errors.length,
      actualPaths: actual,
    });
  }
  const bad = rows.filter((r) => r.missing.length || r.extra.length || r.throw);
  return {
    rows,
    total: {
      rules: rows.length,
      passed: rows.length - bad.length,
      failed: bad.length,
      declaredSum: rows.reduce((s, r) => s + r.declared, 0),
      actualSum: rows.reduce((s, r) => s + r.actual, 0),
    },
  };
}

/** 打印为 markdown 表（报告 §十 直接引用） */
export function toTable(rows) {
  const head = '| 规则 | 作用域 | 映射字段数 | 实际读取数 | missing | extra | 结论 |\n|---|---|---:|---:|---|---|---|';
  const body = rows.map((r) => {
    const ok = !r.missing.length && !r.extra.length && !r.throw;
    const fmt = (xs) => (xs.length ? xs.map((x) => `\`${x}\``).join(' ') : '—');
    return `| ${r.rule_id} | ${r.scope} | ${r.declared} | ${r.actual} | ${fmt(r.missing)} | ${fmt(r.extra)} | ${ok ? 'PASS' : 'FAIL'} |`;
  });
  return [head, ...body].join('\n');
}

void require;
