// P9-E：R-28 / CK-2 双向一致性（D02-21 §六/§七）
//
// CK-2 的两条方向必须分开算，因为它们能抓到的缺陷完全不同：
//  · **方向 A（规则清单 → 映射）**：某条正式规则根本没有映射 → 它的依赖 Hash 会退化成"一条
//    没人认领的规则"，写报告时才发现，或者更糟：被静默跳过；
//  · **方向 B（映射 → 规则清单）**：映射里有清单里不存在的规则（改名/删除后的残留）→
//    一个永远不会被读到的死条目，检查数目还"对得上"。
//
// 所以本模块**不比较数量**，只比较集合与逐条可执行性：
//  · 每条清单规则必须有映射，且 `fields` 非空、字段根必须是依赖上下文里真实存在的键
//    （否则 `project()` 只会取到 `null`，Hash 恒等 → 假新鲜）；
//  · 映射里的每条规则必须在清单里；审计级集合必须与 `AUDIT_RULE_IDS` 逐字相等；
//  · 任何一项不符 → `ok=false` 并给出可定位的 `problems[]`（不静默归空、不过滤异常）。
//
// 默认参数直接引用 `RULE_DEPS` / `ruleCatalog()` —— 与 `qcRuleDependencyHash()` 读的是**同一个
// 对象**（引用同一性由 `stage3-p9-ck2` 断言）。若另建一份"测试副本"，本模块绿了而生产红的
// 情况就永远发现不了，那正是任务书禁止的。
import { RULE_DEPS, RULE_IDS, AUDIT_RULE_IDS, SCOPE_OF } from './rule-deps.js';
import { ruleCatalog } from '../../validate/index.js';
import { buildQcDependencyContext } from './index.js';
import { cmpStr } from '../../hash/cmp-str.js';

/** 允许的规则作用域（与 RULE_DEPS 的 `scope` 取值同源） */
export const CK2_SCOPES = Object.freeze(['shot', 'chapter', 'neighbor', 'state', 'stage4', 'audit']);

/**
 * 显式声明"没有任何依赖字段"的规则。
 *
 * 这张表**不是**给空映射开的后门：`V-12`（剪辑点 vs 单元边界）在阶段 4 之前恒
 * `applicable=false`，正文注释写明"不伪造可执行依赖"。它为空是**设计**，不是漏填；
 * 所以允许为空、但必须在这里逐条登记理由。任何**新**出现的空 `fields` 仍然会失败 ——
 * 这条区别就是"显式声明"与"静默归空"的分界（任务书 §六.5）。
 */
export const NO_DEPENDENCY_RULES = Object.freeze({
  'V-12': '阶段 4 前恒 applicable=false，不读任何字段（D02-13 / RULE_DEPS 原文）',
});

/** 依赖上下文的真实键集合 —— 字段根的合法域必须由它决定，不能手抄一份 */
export function dependencyRoots() {
  const ctx = buildQcDependencyContext({ shot: { id: '__ck2__' }, shotAssets: [], assets: [] });
  return new Set([...Object.keys(ctx), '__audit']);
}

function rootOf(field) {
  const m = /^([A-Za-z0-9_]+)/.exec(String(field ?? ''));
  return m ? m[1] : '';
}

/**
 * 双向一致性检查。
 *
 * @param {{catalog?:Array<{rule_id:string}>, mapping?:object, auditIds?:string[],
 *          roots?:Set<string>|string[]}} o 默认取生产正本
 * @returns {{ok:boolean, total:number, passed:number, rows:Array<object>,
 *            diffs:{missingMapping:string[], orphanMapping:string[], emptyFields:string[],
 *                   unknownRoot:Array<{rule_id:string, field:string}>, badScope:Array<{rule_id:string, scope:string}>,
 *                   auditMismatch:{declared:string[], mapped:string[]}, duplicateCatalog:string[]}}}
 */
export function ck2Audit({ catalog = ruleCatalog(), mapping = RULE_DEPS, auditIds = AUDIT_RULE_IDS, roots } = {}) {
  const declared = (Array.isArray(catalog) ? catalog : []).map((r) => String(r?.rule_id ?? '')).filter(Boolean).sort(cmpStr);
  const mappedIds = Object.keys(mapping ?? {}).sort(cmpStr);
  const rootSet = roots instanceof Set ? roots : new Set(Array.isArray(roots) ? roots : [...dependencyRoots()]);
  const allowedScopes = new Set(CK2_SCOPES);

  const diffs = {
    missingMapping: [],
    orphanMapping: [],
    emptyFields: [],
    unknownRoot: [],
    badScope: [],
    auditMismatch: { declared: [], mapped: [] },
    duplicateCatalog: [],
  };

  // 重复声明（同一 rule_id 出现两次）：`ruleIds()` 与 `RULES` 长度不一致时最先炸的就是这里
  const seen = new Set();
  for (const id of declared) {
    if (seen.has(id)) diffs.duplicateCatalog.push(id);
    seen.add(id);
  }
  diffs.duplicateCatalog = [...new Set(diffs.duplicateCatalog)];

  const declaredSet = new Set(declared);
  const mappedSet = new Set(mappedIds);
  diffs.missingMapping = declared.filter((id) => !mappedSet.has(id));
  diffs.orphanMapping = mappedIds.filter((id) => !declaredSet.has(id));

  const rows = [];
  for (const id of declared) {
    const problems = [];
    const deps = mapping?.[id];
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) {
      rows.push({ rule_id: id, ok: false, scope: '', fields: [], problems: ['MAPPING_MISSING'] });
      continue;
    }
    const fields = Array.isArray(deps.fields) ? deps.fields : [];
    const declaredNoDependency = Object.prototype.hasOwnProperty.call(NO_DEPENDENCY_RULES, id);
    if (!fields.length && !declaredNoDependency) {
      diffs.emptyFields.push(id);
      problems.push('FIELDS_EMPTY');
    }
    for (const fld of fields) {
      if (typeof fld !== 'string' || !fld.trim()) {
        problems.push('FIELD_INVALID');
        continue;
      }
      const root = rootOf(fld);
      if (!rootSet.has(root)) {
        diffs.unknownRoot.push({ rule_id: id, field: fld });
        problems.push('FIELD_ROOT_UNKNOWN');
      }
    }
    const scope = String(deps.scope ?? '');
    if (!allowedScopes.has(scope)) {
      diffs.badScope.push({ rule_id: id, scope });
      problems.push('SCOPE_INVALID');
    }
    rows.push({ rule_id: id, ok: problems.length === 0, scope, fields, declared_no_dependency: declaredNoDependency, problems });
  }

  // 审计级集合必须逐字相等：`reportLevelRules` 的下游判据就是这个集合
  const mappedAudit = mappedIds.filter((id) => SCOPE_OF[id] === 'audit').sort(cmpStr);
  const declaredAudit = [...auditIds].sort(cmpStr);
  if (mappedAudit.join('|') !== declaredAudit.join('|')) {
    diffs.auditMismatch = { declared: declaredAudit, mapped: mappedAudit };
  }

  const hasDiff = diffs.missingMapping.length || diffs.orphanMapping.length || diffs.emptyFields.length
    || diffs.unknownRoot.length || diffs.badScope.length || diffs.duplicateCatalog.length
    || diffs.auditMismatch.declared.length || diffs.auditMismatch.mapped.length;

  return {
    ok: !hasDiff && rows.every((r) => r.ok),
    total: rows.length,
    passed: rows.filter((r) => r.ok).length,
    rows,
    diffs,
  };
}

/** 一眼可读的失败摘要（抛错时用；不替代 `diffs`） */
export function ck2Summary(res) {
  const d = res?.diffs ?? {};
  const parts = [];
  if (d.missingMapping?.length) parts.push(`缺映射 ${d.missingMapping.join(',')}`);
  if (d.orphanMapping?.length) parts.push(`孤儿映射 ${d.orphanMapping.join(',')}`);
  if (d.emptyFields?.length) parts.push(`空 fields ${d.emptyFields.join(',')}`);
  if (d.unknownRoot?.length) parts.push(`未知字段根 ${d.unknownRoot.map((x) => `${x.rule_id}:${x.field}`).join(',')}`);
  if (d.badScope?.length) parts.push(`非法作用域 ${d.badScope.map((x) => `${x.rule_id}:${x.scope}`).join(',')}`);
  if (d.duplicateCatalog?.length) parts.push(`重复规则 ${d.duplicateCatalog.join(',')}`);
  if (d.auditMismatch?.declared?.length || d.auditMismatch?.mapped?.length) {
    parts.push(`审计集合不一致（声明 ${(d.auditMismatch.declared ?? []).join(',')} / 映射 ${(d.auditMismatch.mapped ?? []).join(',')}）`);
  }
  return parts.length ? parts.join('；') : '';
}

/** 生产正本映射的 id 列表（测试用来证明"检查的就是生产那份"） */
export const CK2_MAPPING_IDS = RULE_IDS;
