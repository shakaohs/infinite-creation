// P9 生产闭环：读 → 组装 → 求解 → 状态持久化 → QC → 报告持久化 → 门禁
// （D02-21 主体；D02-21-R1 §R1-1 接入规则级 carried、§R1-3 补齐元数据）
//
// 这是 P9 的**唯一生产入口**（`POST /api/projects/:id/continuity/run`）。它不重做求解器：
// 求解仍走 P8 的 `loadSceneInput() → solveLoaded()`（内部强制经 `assembleSolverShots()`），
// 本文件只负责"把结果落成事实，并按事实给出门禁结论"。
//
// 六条边界（都是前几轮踩出来的，别再放松）：
//  ① **求解输入不含 `shot_states`**：读库仍在 `loadSceneInput()` 里；本轮写进去的状态只喂 QC
//     （V-19/V-22 本来就该看状态），绝不回灌求解器；
//  ② **一个事务**：状态与报告同属一次 `tx()`。任一步抛错整体回滚；
//  ③ **幂等靠内容**：状态比业务内容 Hash（没变不写），报告只与最新一份比（R1-4）；
//  ④ **门禁只认报告级结论**；
//  ⑤ **carried 的输入是"上一份报告 + 本轮 QIS"**：没有 `plan` 就是全量重建，一条都不继承；
//  ⑥ **状态快照 Hash 取自库里实际那一行**（不是"本来打算写的那一行"）—— 内容没变时行不会被重写，
//     它的 `meta.__solver.hash` 仍是上一版，`hash_relation='state_older'` 由此而来（SH-8）。
//     取不到就抛（D02-23 §R2-1）：**不得**用 `qc_input_hash` 顶替，否则缺失会被伪装成 `same`。
import { tx } from '../db.js';
import { cmpStr } from '../hash/cmp-str.js';
import { loadSceneInput } from './load-scene.js';
import { solveLoaded } from './solve-scene.js';
import { persistSceneStates, stateSnapshotHashOf } from './persist-state.js';
import { solveError } from './solver-error.js';
import { SOLVER_VERSION } from './solve-hash.js';
import {
  buildShotReport, saveReport, latestReport, assertReportLevelRules, solverInputOf,
  REPORT_TARGET_TYPE,
} from '../qc/report.js';
import { gateOf } from '../qc/gate.js';
import { ck2Audit, ck2Summary } from '../qc/deps/ck2.js';
import { AUDIT_RULE_IDS } from '../qc/deps/rule-deps.js';

/**
 * 全量重建时的报告级规则集合。
 *
 * 依据 U-P6-2 契约①："非空 ⇔ QIS 非空"。整场重建意味着**每条规则都要跑**，QIS 自然是全集，
 * 审计级三条必在其中。增量时**只消费 `plan.reportLevelRules`**，不在这里重算 ——
 * 重算等于绕过 P6 的失效编排。任务书 §三 也明确：计划给的是空集，就按空集办。
 */
export function fullRebuildReportLevelRules() {
  return [...AUDIT_RULE_IDS].sort(cmpStr);
}

/** `nextShotState` 只取 A-06 真正读的三列（形状校验在 `normalizeNextShot` 里，拒绝整行） */
function nextStateOf(st) {
  if (!st) return null;
  return { state_in: st.in, state_out: st.out, conflicts: st.conflicts };
}

/** QC 侧契约错误：与 `qc/report.js` 同一个 `code`，调用方不必按 message 分支 */
function qcReportError(message, extra = {}) {
  const e = new Error(message);
  e.code = 'QC_REPORT_INVALID';
  Object.assign(e, extra);
  return e;
}

/**
 * 状态快照 Hash（A）：**只认库里那一行的 `meta.__solver.hash`**。
 *
 * 旧实现写的是 `stateSnapshotHashOf(row) || solved.hash`（R2-1 的缺陷）。那一行 `||` 把
 * `qc_input_hash`（B）顶替成 A，于是 `hashRelationOf()` 的缺失值保护形同虚设：
 *  - 缺快照时它本该抛，却永远拿到一个"看起来合法"的值；
 *  - 而且 A 恒等于 B ⇒ 恒判 `same`，也就是说"这行状态不知道是哪版输入算出来的"——
 *    最该被看见的那种缺陷 —— 被伪装成了最健康的状态。
 * 现在缺失/空值/不可解析一律抛 `QC_REPORT_INVALID`，宁可整场失败，也不产出一份"关系是猜的"报告。
 */
function stateSnapshotOf(stateRow, shotId) {
  if (!stateRow) {
    throw qcReportError(`镜头 ${shotId} 没有状态行，取不到状态快照 Hash（state_snapshot_hash）`, {
      shotId, reason: 'STATE_SNAPSHOT_ROW_MISSING',
    });
  }
  if (typeof stateRow.meta === 'string') {
    try {
      JSON.parse(stateRow.meta || '{}');
    } catch (e) {
      throw qcReportError(`镜头 ${shotId} 的 shot_states.meta 无法解析：${e.message}`, {
        shotId, reason: 'STATE_SNAPSHOT_META_UNPARSEABLE',
      });
    }
  }
  const h = stateSnapshotHashOf(stateRow);
  if (!h) {
    throw qcReportError(
      `镜头 ${shotId} 的 shot_states.meta.__solver.hash 缺失或非字符串，拒绝生成报告（不得以 qc_input_hash 顶替状态快照）`,
      { shotId, reason: 'STATE_SNAPSHOT_HASH_MISSING' },
    );
  }
  return h;
}

/**
 * 资产实体数据源：**当前不存在**（R2-3 情况 B）。
 *
 * D02-06 V7 §9.2.1 C.4 要求 `ctx.assets` 是"本镜引用到的资产**实体行**"（`id`/`name`/`category`/`parent_id`），
 * 但本仓库只有引用表 `shot_assets`（`shot_id`/`asset_id`/`role`/`order_no`/`variant_of`），
 * **没有**资产实体主表（全库 21 张表逐一核对，见 D02-23 §R2-3）。因此这里只能传 `[]`：
 *  · 传 `[]` ≠ 传 `undefined`（QH-16）：`[]` 表示"本镜没有可用的实体行"，依赖层按 AR-3 用
 *    `__missing__` 哨兵占位，于是引用资产的那些规则拿到的是"资产不存在"这一事实，而不是空白；
 *  · 但这批规则的结论**尚未经过真实资产数据验证**，不能算作已验收能力。
 * 真实数据源一旦获批（需 DDL），把本函数换成"按 `shotAssets.asset_id` 查实体行"即可，
 * 调用点与下游契约都不用动。
 */
export function loadShotAssetEntities() {
  return [];
}

/** 资产实体是否已接通（进入 `runSceneQuality()` 返回值，避免"看着全绿其实没接"） */
export const ASSET_ENTITY_WIRED = false;

/**
 * 跑一场戏的完整闭环。
 *
 * @param {{projectId:string, sceneKey:string, annotations?:object,
 *          plan?:{reportLevelRules:string[], qcInvalidationSet?:object},
 *          updatedAt?:number}} p
 *   `plan`：`planInvalidation()` 的返回值。给了就**只用**它的 `reportLevelRules` 与
 *   `qcInvalidationSet`（逐镜）；不给 = 全量重建 = 三条审计级 + 不允许 inherited。
 * @returns {{projectId:string, sceneKey:string, solveHash:string, solverVersion:string,
 *            shotCount:number, reportLevelRules:string[], perShotRules:object,
 *            ck2:{total:number, passed:number}, states:{written:Array, unchanged:string[]},
 *            reports:Array<object>, gate:object, entity:'scene',
 *            assetEntities:{wired:boolean, source:null, passed:number}}}
 */
export function runSceneQuality({ projectId, sceneKey, annotations, plan, updatedAt } = {}) {
  // ① 映射自检先跑：映射不全时，任何一条规则的 `rule_dependency_hash` 都不可信。
  const ck2 = ck2Audit();
  if (!ck2.ok) {
    throw solveError(
      `QC 规则映射自检未通过（${ck2.passed}/${ck2.total}）：${ck2Summary(ck2) || '见 diffs'}`,
      { reason: 'QC_MAPPING_INCONSISTENT', diffs: ck2.diffs },
    );
  }

  // ② 读 + 求解：仍是 P8 那一条链路，不新增第二条
  const loaded = loadSceneInput({ projectId, sceneKey });
  if (!loaded.shotCount) {
    throw solveError(`场次 ${sceneKey} 没有任何镜头，无法求解（不产出空报告）`, { reason: 'SCENE_INPUT_EMPTY' });
  }
  const solved = solveLoaded({
    projectId, sceneKey, rows: loaded.rows, sceneState: loaded.sceneState, annotations,
  });

  // ③ 报告级规则 & 逐镜 QIS：**只消费计划**，不自行扩成"三条都跑"
  const reportLevelRules = plan
    ? assertReportLevelRules(plan.reportLevelRules, [...AUDIT_RULE_IDS])
    : fullRebuildReportLevelRules();
  const qisMap = plan && plan.qcInvalidationSet && typeof plan.qcInvalidationSet === 'object'
    ? plan.qcInvalidationSet
    : null;

  const order = Object.keys(solved.states);
  const rowsById = new Map(loaded.rows.map((r) => [String(r.id), r]));
  const missing = order.filter((id) => !rowsById.has(String(id)));
  if (missing.length) {
    throw solveError(`求解结果含未知镜头（${missing.join(',')}），拒绝写入`, { reason: 'STATE_SHOT_UNKNOWN', shotIds: missing });
  }

  // ④ 状态 + 报告：同一事务
  const write = tx(() => {
    const states = persistSceneStates({ projectId, sceneKey, states: solved.states, updatedAt });
    // 库里实际那一行（内容没变时是旧行，`__solver.hash` 仍是上一版）
    const stateRows = new Map(states.rows.map((r) => [String(r.shot_id), r]));

    const reports = [];
    order.forEach((id, i) => {
      const shotId = String(id);
      const row = rowsById.get(shotId);
      const prevId = i > 0 ? String(order[i - 1]) : '';
      const nextId = i + 1 < order.length ? String(order[i + 1]) : '';
      const prevRow = prevId ? rowsById.get(prevId) : null;
      const shotState = stateRows.get(shotId) ?? null;

      // 上一份报告：只取"当前最新"，且规则集版本必须一致（不一致等于没有历史，全量重跑）
      const prevReport = qisMap ? latestReport(shotId) : null;
      const qisRules = qisMap ? (Array.isArray(qisMap[shotId]?.rules) ? qisMap[shotId].rules : []) : undefined;

      const { report } = buildShotReport({
        projectId,
        sceneKey,
        shot: row,
        blockings: row.blockings ?? [],
        actions: row.actions ?? [],
        shotAssets: row.shotAssets ?? [],
        assets: loadShotAssetEntities(), // 情况 B：无实体主表 ⇒ []，引用一律落 `__missing__`（见该函数注释）
        sceneState: loaded.sceneState,
        shotState,
        // 状态快照 = 库里那一行的 `meta.__solver.hash`（A）；缺失即抛，不回退到 `solved.hash`
        stateSnapshotHash: stateSnapshotOf(shotState, shotId),
        prevShot: prevRow,
        prevShotState: prevId ? (stateRows.get(prevId) ?? null) : null,
        prevShotAssets: prevRow ? (prevRow.shotAssets ?? []) : [],
        prevActions: prevRow ? (prevRow.actions ?? []) : [],
        nextShot: nextId ? rowsById.get(nextId) : null,
        nextShotState: nextId ? nextStateOf(solved.states[order[i + 1]]) : null,
        chapterShots: loaded.rows,
        reportLevelRules,
        qcInputHash: solved.hash,
        auditIds: [...AUDIT_RULE_IDS],
        prevReport,
        qisRules,
        createdAt: updatedAt,
      });

      const saved = saveReport(report);
      const meta = solverInputOf(report.hits);
      reports.push({
        shot_id: shotId,
        report_id: saved.id,
        level: report.level,
        reused: saved.reused,
        carried_from: saved.reused ? '' : (saved.previous_id || ''),
        qc_input_hash: meta.qc_input_hash,
        state_snapshot_hash: meta.state_snapshot_hash,
        qc_dependency_hash: meta.qc_dependency_hash,
        hash_relation: meta.hash_relation,
        report,
      });
    });

    return { states, reports };
  });

  // ⑤ 门禁：吃落库报告（同一份对象，不重新构建 —— 避免"门禁看的和存下的不是一份"）
  const gate = gateOf(write.reports.map((r) => ({
    target_id: r.shot_id, level: r.level, hits: r.report.hits,
  })));

  return {
    entity: 'scene',
    projectId: String(projectId),
    sceneKey: String(sceneKey),
    solveHash: solved.hash,
    solverVersion: SOLVER_VERSION,
    shotCount: order.length,
    reportLevelRules,
    perShotRules: qisMap
      ? Object.fromEntries(Object.keys(qisMap).sort(cmpStr).map((k) => [k, [...(qisMap[k].rules ?? [])]]))
      : null,
    ck2: { total: ck2.total, passed: ck2.passed },
    states: { written: write.states.written, unchanged: write.states.unchanged },
    reports: write.reports.map(({ report, ...rest }) => rest),
    gate,
    targetType: REPORT_TARGET_TYPE,
    // 资产实体数据源是否已接通：恒 false（本轮结论，见 `loadShotAssetEntities()`）。
    // 调用方与报告必须据此区分"已验收能力"与"待补数据源的能力"，不得把 69/69 当成资产规则已验证。
    assetEntities: { wired: ASSET_ENTITY_WIRED, source: null, passed: 0 },
    sceneConflicts: solved.sceneConflicts,
  };
}
