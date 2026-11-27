// P9-C：QC 报告构建与持久化（D02-21 §四/§五；D02-21-R1 §R1-1/§R1-3/§R1-4）
//
// 报告不是"再造一套 QC"，而是把 P5 的 `validateShot()` 结果按 D02-06 V7 §8.5 的 `hits` 契约
// 补齐、按 `qcInvalidationSet` 决定哪几条真跑 / 哪几条继承历史、再落 `qc_reports`。
//
// 六件事，顺序即依赖：
//  ① 逐条规则结果（含 `pass`）保留 —— 只存布尔值就再也说不清"跑了哪些、哪条没过"；
//  ② **规则级 carried**（QL-6/QL-7/QL-8）：不在 QIS 里、且规则级 Hash 与历史相等的规则，
//     继承上一份报告的结论并标 `source='carried'` + `carried_from=<报告 id>`；
//     其余一律实跑。判据是**规则级 Hash**，不是"报告级 Hash 没变"——后者会让一条规则的变化
//     连坐整份报告（V6 的缺陷就是拿 `qc_dependency_hash` 顶替 `rule_dependency_hash`）；
//  ③ 每条条目带 `rule_dependency_hash`（QL-8）；写库前做 QL-6/7/8 自洽检查；
//  ④ `reportLevelRules` 作为**独立出口**消费（U-P6-2 #4：审计规则不得 carried）；
//  ⑤ `__solver_input` 六字段 + `hash_relation`（§9.2.1 的 A/B 关系，三态）；
//  ⑥ 幂等：**只与最新一份报告比**（R1-4）。输入 A→B→A 时不能复用最早的 A —— 那会让
//     `latestReport()` 返回 B，而调用方以为本轮结论是 A。
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

/** 承载输入版本与依赖版本的保留条目（`__` 前缀：不参与规则计数、统计与 level 聚合，QL-5） */
export const SOLVER_INPUT_ENTRY = '__solver_input';

/** `qc_reports.target_type`：阶段 3 只用 `shot`（D02-06 §8.5，冻结域） */
export const REPORT_TARGET_TYPE = 'shot';

export const SOURCE_RUN = 'run';
export const SOURCE_CARRIED = 'carried';
export const SOURCE_REPORT_LEVEL = 'report_level';

/** `hash_relation`：状态快照（A）与本轮 QC 输入（B）的关系（§9.2.1，三态） */
export const HASH_RELATION = Object.freeze({
  SAME: 'same',
  STATE_OLDER: 'state_older',
  QC_MISSING: 'qc_missing',
});

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function reportError(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

/** `reportLevelRules` 的形状契约：`string[]`、`cmpStr` 升序、元素必须是审计级规则 */
export function assertReportLevelRules(rules, auditIds) {
  if (!Array.isArray(rules)) throw reportError('QC_REPORT_INVALID', 'reportLevelRules 必须是数组（string[]）', { got: typeof rules });
  const set = new Set(auditIds);
  const seen = new Set();
  let prev = null;
  for (const id of rules) {
    if (typeof id !== 'string' || !id) throw reportError('QC_REPORT_INVALID', `reportLevelRules 元素必须是非空字符串（收到 ${String(id)}）`, { id });
    if (!set.has(id)) throw reportError('QC_REPORT_INVALID', `reportLevelRules 含非审计级规则：${id}`, { id });
    if (seen.has(id)) throw reportError('QC_REPORT_INVALID', `reportLevelRules 重复：${id}`, { id });
    if (prev !== null && cmpStr(prev, id) >= 0) throw reportError('QC_REPORT_INVALID', `reportLevelRules 必须按 cmpStr 升序（${prev} → ${id} 逆序）`, { id });
    seen.add(id);
    prev = id;
  }
  return [...rules];
}

/**
 * `hash_relation` 的计算（A=`state_snapshot_hash`，B=`qc_input_hash`）。
 *
 * 三态来自 §9.2.1：`same`（状态刚被重写）/ `state_older`（输入变了但派生内容逐字未变，
 * 行按 SH-8 不重写，所以快照仍是旧版 —— 这是**预期**，不是 bug）/ `qc_missing`（没有报告）。
 *
 * 本轮在报告内部调用，所以 A 一定存在；缺 A 属于调用方缺陷，直接抛，**不拿 B 顶替**
 * （F-4 明令禁止把状态 Hash 当 QC 输入版本）。
 */
export function hashRelationOf({ qcInputHash, stateSnapshotHash } = {}) {
  if (!qcInputHash) throw reportError('QC_REPORT_INVALID', '缺少 qcInputHash');
  if (!stateSnapshotHash) {
    throw reportError('QC_REPORT_INVALID', '缺少 stateSnapshotHash（不得用 qc_input_hash 顶替状态快照）', { qcInputHash });
  }
  return stateSnapshotHash === qcInputHash ? HASH_RELATION.SAME : HASH_RELATION.STATE_OLDER;
}

/** 历史报告里可继承的条目（按 rule_id；规则集版本不一致 ⇒ 空，等于没有历史） */
function carriedCandidates(prevReport) {
  const map = new Map();
  if (!prevReport || prevReport.ruleset_ver !== RULESET_VER) return map;
  for (const h of (Array.isArray(prevReport.hits) ? prevReport.hits : [])) {
    if (!h || typeof h !== 'object') continue;
    if (String(h.rule_id ?? '').startsWith('__')) continue;
    map.set(String(h.rule_id), h);
  }
  return map;
}

/**
 * QL-6 / QL-7 / QL-8 的自洽检查（写库前执行）。
 *
 * 三条分开报错，因为"哪里错了"决定怎么修：
 *  · `QC_CARRIED_STALE`（QR-10）：标着继承，但规则级 Hash 与本轮现算值不等 → 输入变了还在用旧结论；
 *  · `QC_CARRIED_INVALID`：继承来源缺失/指向错的报告/把 QIS 里的规则标成继承（QL-6 反例）；
 *  · `QC_RUN_COVERAGE_MISSING`：QIS 里的规则没有实跑条目（QL-7 的覆盖下界）。
 *
 * @param {Array<object>} hits 报告条目的"规则部分"（不含 `__` 元数据）
 * @param {{currentHashes:Map<string,string>|object, qis?:Set<string>|string[], prevReportId?:string}} o
 */
export function assertCarriedIntegrity(hits, { currentHashes, qis, prevReportId } = {}) {
  const list = Array.isArray(hits) ? hits : [];
  const hashOf = (id) => (currentHashes instanceof Map ? currentHashes.get(id) : currentHashes?.[id]);
  const qisSet = qis instanceof Set ? qis : new Set(Array.isArray(qis) ? qis : []);

  const seen = new Set();
  for (const h of list) {
    const id = String(h?.rule_id ?? '');
    if (!id) continue;
    if (seen.has(id)) throw reportError('QC_CARRIED_INVALID', `同一报告内规则重复：${id}（QL-1）`, { id });
    seen.add(id);

    if (h.source === SOURCE_CARRIED) {
      if (qisSet.has(id)) {
        throw reportError('QC_CARRIED_INVALID', `${id} 在 QIS 内却标为 carried（QL-6）`, { id });
      }
      if (!prevReportId || String(h.carried_from ?? '') !== String(prevReportId)) {
        throw reportError('QC_CARRIED_INVALID', `${id} 的 carried_from 未指向实际来源报告`, { id, carried_from: h.carried_from });
      }
      const cur = hashOf(id);
      if (!cur || String(h.rule_dependency_hash ?? '') !== cur) {
        throw reportError('QC_CARRIED_STALE', `${id} 标为 carried 但规则级 Hash 与本轮不一致（输入已变，必须重跑）`, {
          id, carried: h.rule_dependency_hash ?? '', current: cur ?? '',
        });
      }
    }
  }

  for (const id of qisSet) {
    const hit = list.find((x) => String(x?.rule_id ?? '') === id);
    if (!hit || hit.source !== SOURCE_RUN) {
      throw reportError('QC_RUN_COVERAGE_MISSING', `${id} 在 QIS 内但没有实跑条目（QL-7）`, { id });
    }
  }
  return true;
}

/**
 * 构建一镜的 QC 报告（纯函数，不写库）。
 *
 * @param {object} p
 *   `projectId` / `sceneKey` / `shot`（必填）/ `blockings` / `actions` / `shotAssets` / `assets`
 *   `sceneState` / `shotState`（**库里实际那一行**）/ `prevShot` / `prevShotState` /
 *   `nextShot` / `nextShotState` / `chapterShots`
 *   `reportLevelRules`（必填：`planInvalidation().reportLevelRules` 或全量重建的三条）
 *   `qcInputHash`（求解器返回的 Hash，SH-10：不另算第二套）
 *   `stateSnapshotHash`（`shot_states.meta.__solver.hash`，取自本轮 QC 实际读的行）
 *   `auditIds`（审计规则 id 正本）
 *   `prevReport`（上一份可用报告；`qisRules` 未给时不会用到它）
 *   `qisRules`（本镜 QIS；给了才允许 carried，没给=全量重建）
 * @returns {{report:object, stats:object, depCtx:object}}
 */
export function buildShotReport({
  projectId, sceneKey, shot, blockings = [], actions = [], shotAssets = [], assets = [],
  sceneState = null, shotState = null, prevShot = null, prevShotState = null,
  prevShotAssets = [], prevActions = [], nextShot = null, nextShotState = null,
  chapterShots = [], reportLevelRules, qcInputHash, stateSnapshotHash, auditIds = [],
  prevReport, qisRules, createdAt,
} = {}) {
  if (!isPlainObject(shot)) throw reportError('QC_REPORT_INVALID', 'buildShotReport：缺少 shot（story_shots 行）');
  if (!qcInputHash) throw reportError('QC_REPORT_INVALID', 'buildShotReport：缺少 qcInputHash（报告必须能追到本轮输入）');
  const levelRules = assertReportLevelRules(reportLevelRules, auditIds);
  const hashRelation = hashRelationOf({ qcInputHash, stateSnapshotHash });

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
  // QIS 没给 ⇒ 全量重建 ⇒ 不允许继承。"什么都没变"与"全都要重算"是两件事，
  // 把后者当"全都不跑"会让 carried 变成"默认不跑"。
  const qis = Array.isArray(qisRules) ? new Set(qisRules) : null;
  const prevMap = qis ? carriedCandidates(prevReport) : new Map();
  const prevId = qis && prevReport ? String(prevReport.id ?? '') : '';

  const currentHashes = new Map();
  const body = [];
  const carriedIds = [];
  for (const h of base.hits) {
    if (auditSet.has(h.rule_id)) continue;
    const id = String(h.rule_id);
    const cur = h.applicable === true ? hashOfRule(id, depCtx) : '';
    currentHashes.set(id, cur);

    const old = prevMap.get(id);
    const canCarry = !!prevId
      && !qis.has(id)                                   // QL-6：QIS 内必须实跑
      && !!old && old.applicable === true && h.applicable === true
      && !!cur && typeof old.rule_dependency_hash === 'string'
      && old.rule_dependency_hash === cur;              // CF-4：Hash 相等才允许继承

    if (canCarry) {
      carriedIds.push(id);
      body.push({
        ...old,
        rule_id: id,
        source: SOURCE_CARRIED,
        carried_from: prevId,
        rule_dependency_hash: cur,
      });
      continue;
    }
    body.push({ ...h, source: SOURCE_RUN, carried_from: '', rule_dependency_hash: cur });
  }

  // 报告级出口：只跑 `reportLevelRules` 里的规则，用**本轮全量规则命中**作 `__audit`。
  // 不得 carried（U-P6-2 #4）—— 审计对象是本轮产出，继承等于拿旧结论充当新结论。
  const auditInput = auditOfEntries(body.filter((h) => h.applicable === true));
  for (const id of levelRules) {
    const entry = validateRule(id, { ...depCtx, __audit: auditInput });
    // QL-8 要求"每条 applicable=true 的条目都有非空 rule_dependency_hash"，报告级条目也不例外。
    // 它的依赖投影是 `__audit`（不在 ctx 里 ⇒ 取 null），所以这个值对该镜是常量；
    // 由于 U-P6-2 #4 明令报告级不得 carried，它不会被用来做任何继承判定 —— 只是让字段契约完整。
    body.push({
      ...entry,
      source: SOURCE_REPORT_LEVEL,
      carried_from: '',
      rule_dependency_hash: entry.applicable === true ? hashOfRule(id, depCtx) : '',
    });
  }

  assertCarriedIntegrity(body, { currentHashes, qis: qis ? [...qis] : [], prevReportId: prevId });

  const qcDeps = qcDependencyHashDetail(depCtx);
  const hits = [...body, {
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
      state_snapshot_hash: String(stateSnapshotHash),
      qc_dependency_hash: qcDeps.hash,
      ruleset_ver: RULESET_VER,
      hash_algo_ver: qcDeps.hash_algo_ver,
      solver_version: SOLVER_VERSION,
      hash_relation: hashRelation,
    },
  }];

  const stats = countByLevel(hits, { carriedIds });
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

/** 审计规则的输入：其它规则的**字段级**命中（与 P5 `auditOf()` 同口径） */
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
    throw reportError('QC_REPORT_INVALID', `规则 ${ruleId} 没有可用的依赖 Hash：${e.message}`, { rule_id: ruleId });
  }
}

function countByLevel(hits, { carriedIds = [] } = {}) {
  const stat = {
    rules_total: 0, applicable: 0, pass: 0, warn: 0, fail: 0, info: 0,
    not_applicable: 0, report_level: 0, run_count: 0, carried_count: 0,
  };
  const carriedSet = new Set(carriedIds);
  for (const h of hits) {
    if (String(h.rule_id ?? '').startsWith('__')) continue;
    stat.rules_total += 1;
    if (h.applicable !== true) { stat.not_applicable += 1; continue; }
    stat.applicable += 1;
    if (h.source === SOURCE_REPORT_LEVEL) stat.report_level += 1;
    if (carriedSet.has(String(h.rule_id))) stat.carried_count += 1;
    else stat.run_count += 1;
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
 * **只与当前最新一份比**（R1-4）：判据是 `qc_input_hash` + `qc_dependency_hash` 都相同。
 * 早先的实现会扫全部历史，于是 A→B→A 时会复用最早那份 A，`latestReport()` 却仍是 B ——
 * "当前有效结论"和"库里最后一行"分叉，这是最危险的一种错（看着有报告，其实是旧的）。
 * 输入从 B 恢复到 A 时必须**新增**一份 A：它才是"当前"，历史里的 A 只是历史。
 *
 * @param {object} report `buildShotReport().report`
 * @returns {{id:string, reused:boolean, previous_id:string}}
 */
export function saveReport(report) {
  if (!isPlainObject(report) || !report.target_id) throw reportError('QC_REPORT_INVALID', 'saveReport：report 缺少 target_id');
  const meta = solverInputOf(report.hits);
  if (!meta.qc_input_hash) throw reportError('QC_REPORT_INVALID', 'saveReport：报告缺少 __solver_input.qc_input_hash', { target_id: report.target_id });

  return tx(() => {
    const db = getDb();
    const latest = db.prepare(
      'SELECT id, hits FROM qc_reports WHERE project_id = ? AND target_type = ? AND target_id = ?'
      + ' ORDER BY created_at DESC, rowid DESC LIMIT 1',
    ).get(report.project_id, report.target_type, report.target_id);

    if (latest) {
      const prev = solverInputOf(latest.hits);
      if (prev.qc_input_hash === meta.qc_input_hash && prev.qc_dependency_hash === meta.qc_dependency_hash) {
        return { id: String(latest.id), reused: true, previous_id: String(latest.id) };
      }
    }

    db.prepare(
      'INSERT INTO qc_reports (id, project_id, target_type, target_id, ruleset_ver, level, hits, created_at)'
      + ' VALUES (?,?,?,?,?,?,?,?)',
    ).run(
      report.id, report.project_id, report.target_type, report.target_id,
      report.ruleset_ver, report.level, JSON.stringify(report.hits), report.created_at,
    );
    return { id: report.id, reused: false, previous_id: latest ? String(latest.id) : '' };
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
