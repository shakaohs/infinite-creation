// P9-C：QC 报告构建与持久化（D02-21 §四/§五）
//
// 报告不是"再造一套 QC"，而是把 P5 的 `validateShot()` 结果按 D02-06 §8.5 的 `hits` 契约
// 补齐、按报告级规则重算一次审计结论、再落 `qc_reports`。四件事：
//  ① 逐条规则结果（含 `pass`）原样保留 —— 只存最终布尔值的话，"跑了哪些规则、哪条没过"就没了；
//  ② 每条适用规则挂 `rule_dependency_hash`（P6 的 C.2，QL-8 要求 applicable=true 必填）；
//  ③ `reportLevelRules` 在这里**被真实消费**：只有列进这个数组的审计规则才在报告级跑一次，
//     不在其中的不跑（P5 的 `validateShot` 会顺手跑掉，所以这里要替换而不是追加）；
//  ④ 一条 `__solver_input` 元数据条目承载 `qc_input_hash`（SH-4：与 `shot_states.meta.__solver.hash`
//     同一个值，绝不另算一份，否则 A/B 两侧永远对不上）。
//
// 幂等策略（§4.3）：**不靠主键**（`id` 是 uuid）。写入前先看同目标的最新报告，
// 若 `qc_input_hash` 与"规则依赖全集摘要"都相同，就复用那一份、不插新行；
// 输入变了才插新行 —— 旧报告因此天然保留成历史（没有 UPDATE、没有覆盖）。
import { getDb, tx } from '../db.js';
import { uid, now } from '../utils.js';
import { cmpStr } from '../hash/cmp-str.js';
import {
  validateShot, validateRule, aggregateLevel, RULESET_VER,
} from '../validate/index.js';
import {
  buildQcDependencyContext, qcRuleDependencyHash, qcDependencyHashDetail,
} from './deps/index.js';
import { SOLVER_VERSION } from '../continuity/solve-hash.js';

/** 承载 `qc_input_hash` 的保留条目（`__` 前缀：不参与规则计数、统计与 level 聚合，QL-5） */
export const SOLVER_INPUT_ENTRY = '__solver_input';

/** `qc_reports.target_type`：阶段 3 只用 `shot`（D02-06 §8.5，冻结域） */
export const REPORT_TARGET_TYPE = 'shot';

/** 报告级条目来源标记：把"这条是报告级重算"与"这条是逐镜实跑"分开，事后可查 */
export const SOURCE_RUN = 'run';
export const SOURCE_REPORT_LEVEL = 'report_level';

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function reportError(message, extra = {}) {
  const e = new Error(message);
  e.code = 'QC_REPORT_INVALID';
  Object.assign(e, extra);
  return e;
}

/** `reportLevelRules` 的形状契约：`string[]`、`cmpStr` 升序、元素必须是审计级规则 */
export function assertReportLevelRules(rules, auditIds) {
  if (!Array.isArray(rules)) throw reportError('reportLevelRules 必须是数组（string[]）', { got: typeof rules });
  const set = new Set(auditIds);
  const seen = new Set();
  let prev = null;
  for (const id of rules) {
    if (typeof id !== 'string' || !id) throw reportError(`reportLevelRules 元素必须是非空字符串（收到 ${String(id)}）`, { id });
    if (!set.has(id)) throw reportError(`reportLevelRules 含非审计级规则：${id}`, { id });
    if (seen.has(id)) throw reportError(`reportLevelRules 重复：${id}`, { id });
    if (prev !== null && cmpStr(prev, id) >= 0) throw reportError(`reportLevelRules 必须按 cmpStr 升序（${prev} → ${id} 逆序）`, { id });
    seen.add(id);
    prev = id;
  }
  return [...rules];
}

/**
 * 构建一镜的 QC 报告（纯函数，不写库）。
 *
 * @param {object} p
 *   `projectId` / `sceneKey` / `shot`（必填）/ `blockings` / `actions` / `shotAssets` / `assets`
 *   `sceneState` / `shotState`（P9 刚写入的状态行）/ `prevShot` / `prevShotState` /
 *   `nextShot` / `nextShotState` / `chapterShots`
 *   `reportLevelRules`（**必须显式给**：`planInvalidation().reportLevelRules` 或全量重建的三条）
 *   `qcInputHash`（求解输入 Hash；与 `shot_states.meta.__solver.hash` 同一个值）
 *   `auditIds`（审计级规则 id，正本来自 `qc/deps/rule-deps.js` 的 `AUDIT_RULE_IDS`）
 * @returns {{report:object, stats:object}}
 */
export function buildShotReport({
  projectId, sceneKey, shot, blockings = [], actions = [], shotAssets = [], assets = [],
  sceneState = null, shotState = null, prevShot = null, prevShotState = null,
  prevShotAssets = [], prevActions = [], nextShot = null, nextShotState = null,
  chapterShots = [], reportLevelRules, qcInputHash, auditIds = [], createdAt,
} = {}) {
  if (!isPlainObject(shot)) throw reportError('buildShotReport：缺少 shot（story_shots 行）');
  if (!qcInputHash) throw reportError('buildShotReport：缺少 qcInputHash（报告必须能追到本轮输入）');
  const levelRules = assertReportLevelRules(reportLevelRules, auditIds);

  // 依赖上下文：`assets` 只含本镜引用（SIG-2/AR-1），引用不到的用 `__missing__` 占位；
  // 它同时给"规则读的 ctx"和"规则级 Hash 的 ctx"用，保证两者看到的是同一份投影。
  const depCtx = buildQcDependencyContext({
    sceneKey, shotId: String(shot.id ?? ''), shot, blockings, actions, shotAssets, assets,
    states: shotState, sceneState, chapterShots, prevShot, prevShotState, prevShotAssets, prevActions,
    nextShot, nextShotState, rulesetVer: RULESET_VER,
  });

  const base = validateShot({
    shot, blockings, actions, shotAssets, assets, assetsById: depCtx.assetsById,
    sceneState, shotState, prevShot, prevShotState, prevShotAssets, prevActions,
    nextShot, nextShotState, chapterShots,
  });

  const auditSet = new Set(auditIds);
  // P5 的 validateShot 会顺手把审计级规则跑一遍（那是它的语义）。但报告级规则的执行**由
  // `reportLevelRules` 决定**：没进这个数组的不得出现在报告里，进了的按"用全量 hits 跑一次"重算。
  // 所以这里先摘掉 P5 跑的那些，再用本报告全量 hits 作 `__audit` 重跑指定条目 —— 追加会造成
  // 同一 rule_id 两条（QL-1 违规），这正是"看起来接了、其实双计"的典型。
  const runEntries = base.hits.filter((h) => !auditSet.has(h.rule_id));

  // 审计规则的输入是**其它规则的字段级命中**（P5 `auditOf()` 同口径）。用审计条目自己的
  // `items` 当输入是错的：那等于拿上一轮的审计结论去审自己。
  const auditInput = auditOfEntries(runEntries);

  const reportLevelEntries = levelRules.map((id) => {
    const entry = validateRule(id, { ...depCtx, __audit: auditInput });
    return { ...entry, source: SOURCE_REPORT_LEVEL };
  });

  const qcDeps = qcDependencyHashDetail(depCtx);
  const withHashes = [...runEntries, ...reportLevelEntries].map((h) => ({
    ...h,
    // QL-8：applicable=true 必须带非空 `rule_dependency_hash`；不适用（`level:''`）写空串
    rule_dependency_hash: h.applicable === true ? hashOfRule(h.rule_id, depCtx) : '',
  }));

  const hits = [...withHashes, {
    rule_id: SOLVER_INPUT_ENTRY,
    code: 'META',
    level: '',
    applicable: false,
    source: SOURCE_RUN,
    carried_from: '',
    field: '',
    fields: [],
    expected: '',
    detail: {
      qc_input_hash: String(qcInputHash),
      solver_version: SOLVER_VERSION,
      ruleset_ver: RULESET_VER,
      rule_dependency_set: qcDeps.hash,
      hash_algo_ver: qcDeps.hash_algo_ver,
    },
  }];

  const stats = countByLevel(hits);
  const report = {
    id: uid(),
    project_id: String(projectId ?? ''),
    target_type: REPORT_TARGET_TYPE,
    target_id: String(shot.id ?? ''),
    ruleset_ver: RULESET_VER,
    level: aggregateLevel(hits),
    hits,
    created_at: Number(createdAt ?? now()),
  };
  return { report, stats, depCtx };
}

/** 审计规则的输入：其它规则的**字段级**命中（不取合并后的条目，否则一条规则只算一次） */
function auditOfEntries(entries) {
  const out = [];
  for (const e of entries) {
    if (!e || !e.detail || !Array.isArray(e.detail.items)) continue;
    for (const item of e.detail.items) {
      out.push({ rule_id: e.rule_id, code: item.code, level: item.level, field: item.field, detail: item.detail ?? {} });
    }
  }
  return out;
}

function hashOfRule(ruleId, depCtx) {
  try {
    return qcRuleDependencyHash(ruleId, depCtx);
  } catch (e) {
    // 未登记的规则不得静默跳过（§六.5）：宁可整份报告失败，也不要一条"没有版本"的结论
    throw reportError(`规则 ${ruleId} 没有可用的依赖 Hash：${e.message}`, { rule_id: ruleId });
  }
}

function countByLevel(hits) {
  const stat = { rules_total: 0, applicable: 0, pass: 0, warn: 0, fail: 0, info: 0, not_applicable: 0, report_level: 0 };
  for (const h of hits) {
    if (String(h.rule_id ?? '').startsWith('__')) continue;
    stat.rules_total += 1;
    if (h.applicable !== true) { stat.not_applicable += 1; continue; }
    stat.applicable += 1;
    if (h.source === SOURCE_REPORT_LEVEL) stat.report_level += 1;
    if (h.level === 'pass' || h.level === 'warn' || h.level === 'fail' || h.level === 'info') stat[h.level] += 1;
  }
  return stat;
}

function parseHits(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** 从一条报告的 hits 里取出 `__solver_input` 的 detail（没有就返回空对象） */
export function solverInputOf(hits) {
  const list = Array.isArray(hits) ? hits : parseHits(hits);
  const entry = list.find((h) => h && h.rule_id === SOLVER_INPUT_ENTRY);
  return entry && isPlainObject(entry.detail) ? entry.detail : {};
}

/**
 * 保存一份报告（幂等）。
 *
 * 判据不是"有没有同 id"，而是"同目标 + 同输入 Hash + 同规则依赖全集"。三者都相同说明
 * **这一轮什么都没变**，那就没有新事实可写；只要有一项不同就必须落新行，旧行保持原样。
 *
 * @param {object} report `buildShotReport().report`
 * @returns {{id:string, reused:boolean, previous_id:string}}
 */
export function saveReport(report) {
  if (!isPlainObject(report) || !report.target_id) throw reportError('saveReport：report 缺少 target_id');
  const meta = solverInputOf(report.hits);
  if (!meta.qc_input_hash) throw reportError('saveReport：报告缺少 __solver_input.qc_input_hash', { target_id: report.target_id });

  return tx(() => {
    const db = getDb();
    const rows = db.prepare(
      'SELECT id, hits FROM qc_reports WHERE project_id = ? AND target_type = ? AND target_id = ?'
      + ' ORDER BY created_at DESC, rowid DESC',
    ).all(report.project_id, report.target_type, report.target_id);

    for (const r of rows) {
      const prev = solverInputOf(r.hits);
      if (prev.qc_input_hash === meta.qc_input_hash && prev.rule_dependency_set === meta.rule_dependency_set) {
        return { id: String(r.id), reused: true, previous_id: String(r.id) };
      }
    }

    db.prepare(
      'INSERT INTO qc_reports (id, project_id, target_type, target_id, ruleset_ver, level, hits, created_at)'
      + ' VALUES (?,?,?,?,?,?,?,?)',
    ).run(
      report.id, report.project_id, report.target_type, report.target_id,
      report.ruleset_ver, report.level, JSON.stringify(report.hits), report.created_at,
    );
    return { id: report.id, reused: false, previous_id: rows.length ? String(rows[0].id) : '' };
  });
}

/** 报告行 → 解析后的对象 */
function hydrate(row) {
  if (!row) return null;
  return { ...row, hits: parseHits(row.hits), solver_input: solverInputOf(row.hits) };
}

/** 某镜当前有效报告（最新一条） */
export function latestReport(targetId) {
  return hydrate(getDb().prepare(
    'SELECT * FROM qc_reports WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
  ).get(REPORT_TARGET_TYPE, String(targetId)));
}

/** 某镜全部历史报告（新 → 旧）：旧报告只读保留，不会被当成本轮结论 */
export function reportHistory(targetId) {
  return getDb().prepare(
    'SELECT * FROM qc_reports WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC, rowid DESC',
  ).all(REPORT_TARGET_TYPE, String(targetId)).map(hydrate);
}

/** 按 id 取一份报告 */
export function readReport(id) {
  return hydrate(getDb().prepare('SELECT * FROM qc_reports WHERE id = ?').get(String(id)));
}
