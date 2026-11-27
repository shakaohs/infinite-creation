// QC 依赖 Hash（P6 · D02-06 §9.2.1 C.1/C.2/C.4）
//
// 两层，两件事，**不得互相替代**（X-1/X-2/X-3）：
//   · `qcRuleDependencyHash(ruleId, ctx)`   —— 这一条规则的历史结论还对得上当前输入吗？
//   · `qcDependencyHash(ctx)`               —— 这份完整报告还对得上当前完整依赖吗？
//
// 报告级**只能**由"逐规则 Hash 的规范化集合"生成（QH-14、SIG-1）：
// 若两者各写一套字段拼装，"报告级变化 = 某条规则变化"这个等式立刻失效，而这种不一致最难查
// —— 两个值都"看起来对"。
//
// 纯函数：不读库、不读时钟、不读 `process.env`、不依赖对象键序与物理行序（QH-7/QH-8）。
import { createHash } from 'node:crypto';
import { cmpStr } from '../../hash/cmp-str.js';
import { canonicalStringify } from '../../hash/canonical-stringify.js';
import { RULESET_VER } from '../../validate/index.js';
import { parseShotMeta } from '../../continuity/solve-hash.js';
import { RULE_DEPS, RULE_IDS, CHAPTER_RULE_IDS } from './rule-deps.js';

/** 本模块自身算法版本：升版本 = 旧报告一律不匹配（QH-5/QH-15，V6 为 `qcdep-1`） */
export const HASH_ALGO_VER = 'qcdep-2';

/** 引用不到的资产用哨兵占位（AR-3）：**不得静默跳过** —— 跳过会与"该行不存在"算出同一个值 */
export const MISSING_ASSET = '__missing__';
/** 场次末镜的邻镜哨兵（QH-3）：省掉这一段会让"末镜 vs 非末镜"算出同一个 Hash */
export const LAST_SHOT = '__last__';

function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

const arr = (v) => (Array.isArray(v) ? v : []);

/**
 * `__solver` 是求解器元数据，不是字段可靠性条目（SH-2：**显式**跳过）。
 *
 * `meta` 在库里是 TEXT 列（`shot_states.meta TEXT DEFAULT '{}'`），`SELECT *` 读回来是字符串。
 * 这里与求解器共用同一个边界解析（`parseShotMeta`）：P5 的 V-22 用 `toObj()` 读同一列，
 * 若 Hash 侧对字符串返回 `{}`，就会出现"规则读到了内容、Hash 却认为没有依赖"——
 * 两边都"看着正常"，但 Hash 已经不再覆盖真实输入（P6-R1 同一类缺陷）。
 */
function stripSolver(meta) {
  const src = parseShotMeta(meta);
  const out = {};
  for (const k of Object.keys(src).sort(cmpStr)) {
    if (k === '__solver') continue;
    out[k] = src[k];
  }
  return out;
}

/**
 * `nextShot` 的数据契约（P6-R4 收紧）：它必须是**状态行**（`shot_states` 形状），
 * 且**必须自带 `state_in` 属性**，不是创作行。
 *
 * 为什么"自带 `state_in`"是硬条件，而不是"有 state_out/conflicts 也算状态行"：
 * `A-06` 唯一读的就是 `nextShotState.state_in`。一行只带 `state_out` 或只带 `conflicts`
 * 时，A-06 投影出的 `state_in` 依然是 `null` —— 与末镜哨兵算出同一个值，等于这个契约没生效：
 *   · A-06 的规则级 Hash 恒定不变 → 下镜状态怎么改都能"合法继承"；
 *   · 末镜的 `__last__` 哨兵也失去意义（两者都投影成 null）。
 * 这类错误的特征是"不报错、Hash 也对得上"，只能靠形状校验拦住。
 *
 * `state_in: null` 是**合法值**：列可空、语义是"状态未知"，与"字段缺失"不是一回事。
 *
 * @param {*} nextShot
 * @returns {object|null}
 * @throws {Error} `QC_DEPS_NEXT_SHOT_INVALID` / `QC_DEPS_NEXT_SHOT_NOT_STATE`
 */
function normalizeNextShot(nextShot) {
  if (nextShot === null || nextShot === undefined) return null;
  if (typeof nextShot !== 'object' || Array.isArray(nextShot)) {
    throw dependencyError('QC_DEPS_NEXT_SHOT_INVALID', 'nextShot 必须是状态行对象（无下镜时传 null）');
  }
  const hasStateIn = Object.prototype.hasOwnProperty.call(nextShot, 'state_in');
  if (!hasStateIn) {
    throw dependencyError(
      'QC_DEPS_NEXT_SHOT_NOT_STATE',
      'nextShot 必须是 shot_states 形状且自带 state_in（A-06 只读这一项；无下镜时传 null，'
      + '状态未知时传 {state_in: null}）。不得传入 story_shots 行，也不得只给 state_out / conflicts'
      + `（收到的键：${Object.keys(nextShot).slice(0, 5).join(',') || '(空)'}）`,
    );
  }
  return nextShot;
}

/**
 * 构造依赖上下文（C.4 签名）：一份快照，供两个入口共用。
 *
 * 三条实现约束：
 *  · `assets` 只含**本镜引用到**的资产（SIG-2/AR-1），引用不到的行用 `__missing__` 占位；
 *  · `shotAssets` 按 `(role, order_no, asset_id)` 排序（AR-2），不依赖物理行序；
 *  · `undefined` 与 `[]` 必须可区分（QH-16）：传 `undefined` 表示调用方缺陷，直接抛。
 *
 * @param {{sceneKey?:string, chapterId?:string, shotId?:string, rulesetVer?:string,
 *          shot:object, states?:object, blockings?:Array, actions?:Array,
 *          shotAssets:Array, assets:Array, sceneState?:object, chapterShots?:Array,
 *          nextShot?:{state_in?:object,state_out?:object,conflicts?:Array}|null,
 *          prevShot?:object, prevShotAssets?:Array, prevActions?:Array,
 *          targetProfile?:object, costumeChangeAllowed?:boolean}} p
 * @returns {object} ctx
 */
export function buildQcDependencyContext(p = {}) {
  if (p.shotAssets === undefined) throw dependencyError('QC_DEPS_SHOT_ASSETS_UNDEFINED', 'shotAssets 不得为 undefined（本镜无引用时传 []）');
  if (p.assets === undefined) throw dependencyError('QC_DEPS_ASSETS_UNDEFINED', 'assets 不得为 undefined（本镜无引用时传 []）');

  // `nextShot` / `nextShotState` 是**同一行状态的两个键名**（P6-R4）。
  // P5 的 A-06 读 `ctx.nextShotState`，而本模块早期只产出 `ctx.nextShot` ——
  // 于是"规则读的那一行"与"Hash 投影的那一行"根本不是同一个键，
  // 只要调用方只填了一个，另一侧就恒为 null：A-06 永远算出同一个 Hash，怎么改都能"合法继承"。
  // 现在两个键指向同一个对象，并统一做形状校验（`story_shots` 行会被拒）。
  const nextState = normalizeNextShot(p.nextShotState ?? p.nextShot ?? null);

  const shotAssets = arr(p.shotAssets)
    .filter((r) => r && typeof r === 'object')
    .slice()
    .sort((a, b) => cmpStr(a.role, b.role) || (Number(a.order_no) - Number(b.order_no)) || cmpStr(a.asset_id, b.asset_id));

  // 只保留本镜引用到的资产（AR-1/SIG-2）：全表传进来会让"改一个无关资产"失效全项目
  const byId = new Map();
  for (const a of arr(p.assets)) {
    if (a && typeof a === 'object') byId.set(String(a.id ?? ''), a);
  }
  const seen = new Set();
  const assets = [];
  for (const r of shotAssets) {
    const id = String(r.asset_id ?? '');
    if (seen.has(id)) continue;
    seen.add(id);
    const row = byId.get(id);
    assets.push(row
      ? { id, name: row.name ?? null, category: row.category ?? null, parent_id: row.parent_id ?? null }
      : { id, name: MISSING_ASSET, category: MISSING_ASSET, parent_id: MISSING_ASSET });
  }
  assets.sort((a, b) => cmpStr(a.id, b.id));

  const assetsById = {};
  for (const a of assets) assetsById[a.id] = a;

  return {
    sceneKey: p.sceneKey ?? null,
    chapterId: p.chapterId ?? null,
    shotId: p.shotId ?? String(p.shot?.id ?? ''),
    rulesetVer: String(p.rulesetVer ?? RULESET_VER),
    hashAlgoVer: HASH_ALGO_VER,
    shot: p.shot ?? {},
    states: p.states ?? null,
    shotState: p.states ?? p.shotState ?? null,
    blockings: arr(p.blockings),
    actions: arr(p.actions),
    shotAssets,
    assets,
    assetsById,
    sceneState: p.sceneState ?? null,
    // 章级：按 `shot_no` 稳定排序（同号退化到 id），禁 localeCompare
    chapterShots: arr(p.chapterShots)
      .filter((s) => s && typeof s === 'object')
      .slice()
      .sort((a, b) => (Number(a.shot_no) - Number(b.shot_no)) || cmpStr(a.id, b.id)),
    nextShot: nextState,
    // 同一行状态的第二个键名：P5 的 A-06 读这个（契约见 `normalizeNextShot`）
    nextShotState: nextState,
    prevShot: p.prevShot ?? null,
    prevShotAssets: arr(p.prevShotAssets),
    prevActions: arr(p.prevActions)
      .filter((a) => a && typeof a === 'object')
      .slice()
      .sort((a, b) => cmpStr(a.id, b.id)),
    targetProfile: p.targetProfile ?? null,
    costumeChangeAllowed: p.costumeChangeAllowed === true,
  };
}

function dependencyError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** 解析一条声明路径：`blockings[*].norm_x` → `{ root:'blockings', container:true, rest:['norm_x'] }` */
function parsePath(decl) {
  const m = /^([A-Za-z0-9_]+)(?:\[\*\])?(?:\.(.+))?$/.exec(String(decl));
  if (!m) return null;
  return { root: m[1], container: /\[\*\]/.test(decl), rest: m[2] ? m[2].split('.') : [] };
}

/** 深取值（缺失 → null，与 canonicalStringify 的"缺失即 null"一致） */
function pickPath(row, rest) {
  let cur = row;
  for (const seg of rest) {
    if (cur === null || cur === undefined) return null;
    cur = cur[seg];
  }
  return cur === undefined ? null : cur;
}

/** 某些容器必须先做语义归一，再投影（`__solver` 跳过、meta 只取键与值） */
function normalizeContainer(root, row) {
  if (root === 'shotState' && row && typeof row === 'object') {
    const out = { ...row };
    for (const k of ['meta', 'meta_in', 'meta_out', 'state_in_meta', 'state_out_meta']) {
      if (out[k] !== undefined) out[k] = stripSolver(out[k]);
    }
    return out;
  }
  return row;
}

/**
 * 按声明路径做投影：**只读映射里写了的字段**（LR-3）。
 *
 * 语义（CK-2 的比对口径，报告 §十 有说明）：
 *  · `X[*].a` → `X` 每行取 `a`，行按投影内容排序（内容一致即等价，不依赖行序）；
 *  · `X` （无 `[*]`）→ 整块取（用于 `sceneState.fixtures`、`shotState.meta` 这类"整体即依赖"的字段）；
 *  · `nextShotState` → `nextShot.state_in`，缺下镜时写 `__last__`（QH-3）。
 */
function project(ctx, decls) {
  const out = {};
  const groups = new Map();
  for (const decl of decls) {
    const p = parsePath(decl);
    if (!p) continue;
    if (p.container) {
      if (!groups.has(p.root)) groups.set(p.root, []);
      groups.get(p.root).push(p.rest);
    } else {
      out[decl] = readScalar(ctx, p);
    }
  }
  for (const [root, rests] of groups) {
    const rows = rowsOf(ctx, root).map((r) => normalizeContainer(root, r));
    const projected = rows.map((r) => {
      const one = {};
      for (const rest of rests) one[rest.join('.') || '_'] = pickPath(r, rest);
      return one;
    });
    projected.sort((a, b) => cmpStr(canonicalStringify(a), canonicalStringify(b)));
    out[`${root}[*]`] = projected;
  }
  return out;
}

/** 取某容器的行集合 */
function rowsOf(ctx, root) {
  if (root === 'shotState') return ctx.shotState ? [ctx.shotState] : [];
  if (root === 'nextShotState') {
    // 邻镜：末镜用哨兵占位（QH-3），不得省略这一段；两个键名等价（P6-R4）
    const st = ctx.nextShotState ?? ctx.nextShot ?? null;
    return st ? [st] : [{ state_in: LAST_SHOT }];
  }
  if (root === 'assets') return arr(ctx.assets);
  const v = ctx[root];
  if (Array.isArray(v)) return v.filter((x) => x && typeof x === 'object');
  if (v && typeof v === 'object') return [v];
  return v === null || v === undefined ? [] : [{ value: v }];
}

/** 取非容器（整块）字段 */
function readScalar(ctx, p) {
  if (p.root === 'sceneState') {
    // **只投影映射声明的那一条**（P6-R2）。这里原先整块返回 `sceneState`，
    // 后果是"声明 `sceneState.axis_lock` 的规则"其实依赖了整行场次 ——
    // 改 `crowd_switch` 会让 S-07 的 Hash 变，于是它明明没读这个字段却被判"必须重跑"。
    // 假失效比漏失效安全，但它会让"改一处只重跑一条"退化成"改一处全跑"，
    // 而 R-28 的意义正是后者。
    // 未写子路径（映射显式声明整个 `sceneState`，如 S-01 的基线完整性）才整块返回。
    if (ctx.sceneState === undefined) return null;
    if (!p.rest.length) return ctx.sceneState;
    return pickPath(ctx.sceneState, p.rest);
  }
  if (p.root === 'nextShotState') {
    // 两个键名等价（P6-R4）；缺下镜时写哨兵，不省略这一段（QH-3）
    const st = ctx.nextShotState ?? ctx.nextShot ?? null;
    if (!st) return LAST_SHOT;
    return p.rest.length ? pickPath(st, p.rest) : st;
  }
  if (p.root === 'shotState') {
    const st = ctx.shotState;
    if (!st) return null;
    if (!p.rest.length) return normalizeContainer('shotState', st);
    return pickPath(normalizeContainer('shotState', st), p.rest);
  }
  const v = ctx[p.root];
  if (v === undefined) return null;
  return p.rest.length ? pickPath(v, p.rest) : v;
}

/** 该镜期望的规则集合（C.1 第一步；RH-2 的比对基准） */
export function expectedRuleSet() {
  return [...RULE_IDS];
}

/**
 * 规则级依赖 Hash（C.2）。
 *
 * @param {string} ruleId
 * @param {object} ctx `buildQcDependencyContext()` 的产物
 * @returns {string} `sha256:<hex>`
 * @throws {Error} `code='QC_RULE_DEPS_UNKNOWN'` —— 未登记的规则（**不得**回退到全景清单）
 */
export function qcRuleDependencyHash(ruleId, ctx) {
  const deps = RULE_DEPS[ruleId];
  if (!deps) throw dependencyError('QC_RULE_DEPS_UNKNOWN', `未登记的规则：${ruleId}（不得回退到全景字段清单）`);

  const payload = {
    hash_algo_ver: HASH_ALGO_VER,
    ruleset_ver: String(ctx?.rulesetVer ?? RULESET_VER),
    rule_id: ruleId,
    // 作用域进 Hash：章级规则的输入集与镜级不同，换作用域必须换 Hash
    scope: deps.scope,
    deps: project(ctx ?? {}, deps.fields),
  };
  return 'sha256:' + sha256(canonicalStringify(payload));
}

/**
 * 报告级依赖 Hash（C.1 两步算法）。
 *
 * 第一步：逐规则算（**必须**调 `qcRuleDependencyHash`，不得另写字段拼装 —— SIG-1）；
 * 第二步：规范化集合摘要（规则集合本身进摘要，RH-3；排序用 `cmpStr`，RH-5）。
 *
 * **不纳入**：`source`（RH-6）、`carried_from`（RH-7）、时间戳、`created_at`。
 *
 * @param {object} ctx
 * @returns {{hash:string, ruleHashes:Array<{rule_id:string, rule_dependency_hash:string}>, ruleset_ver:string, hash_algo_ver:string}}
 */
export function qcDependencyHashDetail(ctx) {
  const rules = expectedRuleSet();
  // RH-1：同一 rule_id 只能出现一次
  const seen = new Set();
  for (const id of rules) {
    if (seen.has(id)) throw dependencyError('QC_DEPS_DUPLICATE_RULE', `规则集合出现重复：${id}`);
    seen.add(id);
  }
  const ruleHashes = rules.map((id) => ({ rule_id: id, rule_dependency_hash: qcRuleDependencyHash(id, ctx) }));
  ruleHashes.sort((a, b) => cmpStr(a.rule_id, b.rule_id));

  const payload = {
    ruleset_ver: String(ctx?.rulesetVer ?? RULESET_VER),
    hash_algo_ver: HASH_ALGO_VER,
    rules: ruleHashes,
  };
  return {
    hash: 'sha256:' + sha256(canonicalStringify(payload)),
    ruleHashes,
    ruleset_ver: payload.ruleset_ver,
    hash_algo_ver: HASH_ALGO_VER,
  };
}

/** 报告级 Hash（只要值） */
export function qcDependencyHash(ctx) {
  return qcDependencyHashDetail(ctx).hash;
}

/** 章级三条的规则级 Hash（供 F-9：改一镜即令全章这三条变） */
export function chapterRuleHashes(ctx) {
  const out = {};
  for (const id of CHAPTER_RULE_IDS) out[id] = qcRuleDependencyHash(id, ctx);
  return out;
}
