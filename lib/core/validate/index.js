// 统一校验入口（P5）—— `validateShot(ctx)` → `{ level, hits[], stats }`
//
// 69 条规则（V 25 + A 19 + S 25）在这一层汇合。**V-10 已废止**（D01-02 §十三 划掉）——
// 它把台词与动作当串行，与"边说边摔"直接冲突，职责已由 A-11（区间越界）+ A-12（部位冲突）承担，
// 因此本目录里没有它的任何实现，编号也不得复用。
// 三条口径必须写死在这里，因为它们跨模块：
//   ① **一条规则一条结果**（D02-06 §8.5.2 QL-1）：同一规则多字段命中合并进 `fields[]`，
//      该条 `level` 取最高档。否则"这一镜跑了几条规则、几条过了"永远算不出来。
//   ② **`applicable=false` 不进统计**（QL-3）：不适用写 `level:''`，不能算成"通过"。
//   ③ **规则异常必须暴露**：某条规则抛错 → 该条 `fail` + `QC_RULE_EXEC_FAILED`，其它规则照跑。
//      把异常吞成 PASS 是这类系统最贵的 bug：报告全绿，数据全错。
//
// 本文件只做编排 + 映射 + 聚合，**不含任何具体规则的判定逻辑**。
import { cmpStr } from '../hash/cmp-str.js';
import * as enums from './enums.js';
import * as schema from './schema.js';
import * as asset from './asset.js';
import * as camera from './camera.js';
import * as action from './action.js';
import * as blocking from './blocking.js';
import * as continuity from './continuity.js';
import {
  FAIL, WARN, INFO, PASS, LEVEL_ORDER, f, found, insufficient, notApplicable, pass,
  isBlank, sortedUnique, toArr, toObj, worstFinding,
} from './common.js';

/** 规则集版本：只增不改（与 `qc_reports.ruleset_ver` 同源，D02-06 §8.5） */
export const RULESET_VER = 'd01-v7/stage3.1';

/** 无 `shot` 的上下文不是"某条规则不适用"，是调用方 bug —— 直接抛，不产出半份报告 */
export const CTX_ERROR = 'QC_CTX_INVALID';

// ── P4 已有的五条（V-01 / V-13 / V-19 / V-20 / V-22）与枚举（V-02） ─────────

/**
 * V-01 S 级必填集完整（FAIL）。
 *
 * S 级由 `computeLevel` 按本镜数据推导，**调用方传入的 `level` 只留痕不生效**（D01-04 §7）。
 *
 * @param {{shot:object, blockings?:Array, actions?:Array, sceneState?:object, shotState?:object, level:string}} ctx
 */
export function runRequired(ctx = {}) {
  return found(schema.checkRequired({
    level: ctx.level,
    blockings: toArr(ctx.blockings),
    sceneState: ctx.sceneState,
    shotState: ctx.shotState,
    actions: toArr(ctx.actions),
  }));
}

/** 枚举字段取值点：`{field, path, value}`；**空值不在这里判**（必填由 V-01 负责） */
function enumSamples(ctx) {
  const shot = ctx.shot ?? {};
  const out = [];
  const add = (field, path, value) => out.push({ field, path, value });
  for (const k of ['purpose', 'dialogue_function', 'shot_size', 'cam_direction', 'cam_height', 'movement', 'movement_amp', 'composition_rule', 'speed_ramp', 'spec_source']) {
    add(k, `shot.${k}`, shot[k]);
  }
  toArr(shot.speakers).forEach((s, i) => add('speakers.type', `shot.speakers[${i}].type`, s && typeof s === 'object' ? s.type : undefined));
  toArr(shot.time_slices).forEach((s, i) => add('time_slices.kind', `shot.time_slices[${i}].kind`, s && typeof s === 'object' ? s.kind : undefined));
  toArr(ctx.actions).forEach((a, i) => {
    if (!a || typeof a !== 'object') return;
    add('action_type', `shot_actions[${i}].action_type`, a.action_type);
    add('tier', `shot_actions[${i}].tier`, a.tier);
    add('cog', `shot_actions[${i}].cog`, a.cog);
    add('speed.profile', `shot_actions[${i}].speed_json.profile`, toObj(a.speed_json ?? a.speed).profile);
    add('contact.impulse', `shot_actions[${i}].contact_json.impulse`, toObj(a.contact_json ?? a.contact).impulse);
  });
  toArr(ctx.blockings).forEach((b, i) => {
    if (!b || typeof b !== 'object') return;
    add('posture', `shot_blockings[${i}].posture`, b.posture);
    add('facing', `shot_blockings[${i}].facing`, b.facing);
    add('occlusion', `shot_blockings[${i}].occlusion`, b.occlusion);
    add('power_level', `shot_blockings[${i}].power_level`, b.power_level);
  });
  toArr(ctx.shotAssets).forEach((a, i) => add('asset.role', `shot_assets[${i}].role`, a && typeof a === 'object' ? a.role : undefined));
  if (ctx.sceneState && typeof ctx.sceneState === 'object') {
    add('crowd_switch', 'scene_states.crowd_switch', ctx.sceneState.crowd_switch);
    toArr(toObj(ctx.sceneState.axis_lock).cross_allowed).forEach((c, i) => {
      add('cross_allowed.type', `scene_states.axis_lock.cross_allowed[${i}].type`, c && typeof c === 'object' ? c.type : undefined);
    });
  }
  if (ctx.shotState && typeof ctx.shotState === 'object') {
    add('state_source', 'shot_states.state_source', ctx.shotState.state_source);
    const meta = toObj(ctx.shotState.meta);
    for (const k of Object.keys(meta).filter((x) => x !== '__solver').sort(cmpStr)) {
      const e = meta[k];
      add('state.rel', `shot_states.meta.${k}.rel`, e && typeof e === 'object' ? e.rel : undefined);
    }
    for (const side of ['state_in', 'state_out']) {
      const props = toObj(toObj(ctx.shotState[side]).props);
      for (const id of Object.keys(props).sort(cmpStr)) {
        add('prop.state', `shot_states.${side}.props.${id}.state`, toObj(props[id]).state);
      }
    }
  }
  return out;
}

/**
 * V-02 枚举值合法（FAIL）。
 *
 * 逐字段调 `enums.check`（**P4 唯一枚举表**，不另建一套）。空值跳过：
 * "这个字段该不该有值"是 V-01 的职责，两条规则各管一件事，否则同一个空值会被报两次。
 *
 * @param {object} ctx
 */
export function runEnums(ctx = {}) {
  const hits = [];
  for (const { field, path, value } of enumSamples(ctx)) {
    if (isBlank(value)) continue;
    for (const h of enums.check(field, value)) {
      // 枚举非法与类型错都是 FAIL（D01-02 §十三 V-02）；两者用不同 code 区分，便于 LLM 分别修
      hits.push(f(FAIL, h.code, path, h.expected, { got: h.got, enum_field: field }));
    }
  }
  return found(hits);
}

/**
 * V-12 剪辑点 vs 单元边界 —— **阶段 4 才判**。
 *
 * 本阶段恒 `NOT_APPLICABLE`（`applicable=false` + `level:''`），**不得伪造成 PASS**：
 * 假装通过会让"未验证"看起来像"已验证"。
 */
export function runCutPoint() {
  return notApplicable('阶段 4（render_unit_shots）尚未实现，本阶段不判（V-12）');
}

/**
 * V-13 空镜台词规则（FAIL）：`is_insert=1` 时画内人物不得开口。
 * @param {{shot:object, blockings?:Array, shotAssets?:Array}} ctx
 */
export function runEmptyShot(ctx = {}) {
  return found(schema.checkEmptyShot({
    is_insert: ctx.shot?.is_insert,
    dialogue: ctx.shot?.dialogue,
    speakers: ctx.shot?.speakers,
    blockings: toArr(ctx.blockings),
    shot_assets: toArr(ctx.shotAssets),
  }));
}

/**
 * V-19 `state_in_meta` / `state_out_meta` 的键必须是可解析且真实存在的字段路径（FAIL）。
 *
 * 两份 meta 各判一次（它们对应两份不同的状态），命中合并进同一条规则结果。
 * @param {{shotState?:object}} ctx
 */
export function runMetaKeys(ctx = {}) {
  const st = ctx.shotState && typeof ctx.shotState === 'object' ? ctx.shotState : null;
  if (!st) return notApplicable('本镜没有 shot_states 行，meta 不存在');
  const metaIn = st.meta_in ?? st.state_in_meta;
  const metaOut = st.meta_out ?? st.state_out_meta ?? st.meta;
  const hits = [
    ...schema.checkMetaKeys(metaIn, st.state_in),
    ...schema.checkMetaKeys(metaOut, st.state_out ?? st.state_in),
  ];
  return found(hits);
}

/**
 * V-20 `time_slices` 无空洞（FAIL，零容差）。
 * @param {{shot:object}} ctx
 */
export function runTimeSlices(ctx = {}) {
  return found(schema.checkTimeSlices(ctx.shot?.time_slices, ctx.shot?.story_duration));
}

/**
 * V-22 `unknown` 字段被写入确定值但 `meta` 未更新（WARN）。
 * @param {{shotState?:object}} ctx
 */
export function runSilentChange(ctx = {}) {
  const st = ctx.shotState && typeof ctx.shotState === 'object' ? ctx.shotState : null;
  if (!st) return notApplicable('本镜没有 shot_states 行，meta 不存在');
  const meta = st.meta_out ?? st.state_out_meta ?? st.meta;
  return found(schema.checkSilentChange({ state: st.state_out ?? st.state_in, meta }));
}

/** 本文件承接的 7 条（其余 62 条由五个模块提供） */
const INDEX_RULES = [
  { id: 'V-01', level: 'FAIL', title: 'S 级必填集完整', run: runRequired },
  { id: 'V-02', level: 'FAIL', title: '枚举值合法', run: runEnums },
  { id: 'V-12', level: 'FAIL', title: '剪辑点 vs 单元边界（阶段4）', run: runCutPoint },
  { id: 'V-13', level: 'FAIL', title: '空镜台词规则', run: runEmptyShot },
  { id: 'V-19', level: 'FAIL', title: 'meta 键可解析', run: runMetaKeys },
  { id: 'V-20', level: 'FAIL', title: 'time_slices 无空洞', run: runTimeSlices },
  { id: 'V-22', level: 'WARN', title: 'unknown 写确定值但 meta 未更新', run: runSilentChange },
];

/**
 * 全部规则（69 条）。顺序 = 执行顺序：审计类（S-20/S-21/S-25）**最后**跑，
 * 因为它们要看其它规则的产出（`ctx.__audit`）。
 */
export const RULES = Object.freeze([
  ...INDEX_RULES,
  ...asset.RULES,
  ...camera.RULES,
  ...action.RULES,
  ...blocking.RULES.filter((r) => r.id !== 'S-25'),
  ...continuity.RULES.filter((r) => r.id !== 'S-20' && r.id !== 'S-21'),
  blocking.RULES.find((r) => r.id === 'S-25'),
  continuity.RULES.find((r) => r.id === 'S-20'),
  continuity.RULES.find((r) => r.id === 'S-21'),
].filter(Boolean));

/** 69 个规则编号（`cmpStr` 排序）；测试用它断言"不重不漏" */
export function ruleIds() {
  return RULES.map((r) => r.id).slice().sort(cmpStr);
}

/** 审计类规则：只能在其它规则跑完之后执行 */
export const AUDIT_RULE_IDS = Object.freeze(['S-20', 'S-21', 'S-25']);

// ── 聚合 ────────────────────────────────────────────────────────────────

/** 单条规则结果 → `hits` 里的一条（QL-1：同一规则只出一条） */
function toEntry(rule, res) {
  const base = { rule_id: rule.id, source: 'run', carried_from: '' };
  if (!res || typeof res !== 'object' || typeof res.applicable !== 'boolean') {
    return {
      ...base,
      code: 'QC_RULE_EXEC_FAILED',
      level: FAIL,
      applicable: true,
      field: rule.id,
      fields: [rule.id],
      expected: '规则函数返回 { applicable, findings[] }',
      detail: { reason: 'invalid-rule-result' },
    };
  }
  if (res.applicable === false) {
    return {
      ...base, code: 'NOT_APPLICABLE', level: '', applicable: false, field: '', fields: [], expected: '', detail: { reason: String(res.reason ?? '') },
    };
  }
  const findings = toArr(res.findings).filter((x) => x && typeof x === 'object');
  if (!findings.length) {
    // `code` 是「结果码」，`level` 是「档位」：D02-06 §8.5.2 要求 pass 的 code 统一写 `PASS`（大写），
    // level 写 `pass`（小写）。两者不是同一个东西，不能共用一个常量。
    return { ...base, code: 'PASS', level: PASS, applicable: true, field: '', fields: [], expected: '', detail: {} };
  }
  const worst = worstFinding(findings);
  const fields = sortedUnique([worst.field, ...findings.map((x) => x.field)]);
  return {
    ...base,
    code: String(worst.code ?? ''),
    level: String(worst.level ?? FAIL),
    applicable: true,
    field: String(worst.field ?? ''),
    fields,
    expected: String(worst.expected ?? ''),
    detail: {
      count: findings.length,
      items: findings.map((x) => ({ code: x.code, level: x.level, field: x.field, expected: x.expected, detail: x.detail ?? {} })),
    },
  };
}

/** 报告级等级：`fail > warn > info > pass`；一条适用规则都没有 → `info`（QL-4） */
export function aggregateLevel(entries) {
  let level = '';
  for (const e of entries) {
    if (!e || e.applicable !== true) continue;
    if (e.rule_id && String(e.rule_id).startsWith('__')) continue;
    if ((LEVEL_ORDER[e.level] ?? -1) > (LEVEL_ORDER[level] ?? -1)) level = e.level;
  }
  return level === '' ? INFO : level;
}

/** 审计类规则要看的"其它规则产出"（只取字段级命中，不取合并后的条目） */
function auditOf(entries) {
  const out = [];
  for (const e of entries) {
    if (!e || !e.detail || !Array.isArray(e.detail.items)) continue;
    for (const item of e.detail.items) {
      out.push({
        rule_id: e.rule_id, code: item.code, level: item.level, field: item.field, detail: item.detail ?? {},
      });
    }
  }
  return out;
}

/**
 * 统一入口：校验一镜的全部确定性规则。
 *
 * **不读数据库**：`ctx` 里的每一行都由调用方取好传进来（P9 才做落库）。
 * **纯函数**：不改 `ctx`（内部只用 `__audit` 这一个临时键，且不写回调用方对象）。
 *
 * @param {object} ctx
 *   `shot`（**必填**，`story_shots` 行）
 *   `blockings` / `actions` / `shotAssets`（本镜从表行）
 *   `assetsById`（`id -> {id,category,name,parent_id}`，供 V-03/A-07/S-02 查资产）
 *   `sceneState`（`scene_states` 行）、`shotState`（`shot_states` 行）
 *   `prevShot` / `prevShotState` / `prevShotAssets` / `nextShot` / `nextShotState`
 *   `chapterShots`（同章全部镜，含本镜，供 V-06~V-08）
 *   `targetProfile`（`{roll_sign_verified}`，供 S-22）
 *   `declaredLevel`（调用方/LLM 声明值，**只留痕**）
 *   `costumeChangeAllowed`（剧情内换装放行，供 S-13）
 * @returns {{level:string, hits:Array<object>, stats:object, levelBasis:object}}
 * @throws {Error} `code='QC_CTX_INVALID'` —— 缺 `shot` 时抛错（不产出半份报告）
 */
export function validateShot(ctx = {}) {
  if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) {
    const e = new Error('validateShot(ctx)：ctx 必须是对象');
    e.code = CTX_ERROR;
    throw e;
  }
  if (!ctx.shot || typeof ctx.shot !== 'object' || Array.isArray(ctx.shot)) {
    const e = new Error('validateShot(ctx)：缺少 ctx.shot（story_shots 行）');
    e.code = CTX_ERROR;
    throw e;
  }

  // S 级由数据推导（声明值只留痕），后续规则统一读 ctx.level
  const lv = schema.computeLevel({
    blockings: toArr(ctx.blockings),
    actions: toArr(ctx.actions),
    sceneState: ctx.sceneState,
    level: ctx.declaredLevel,
  });
  const runCtx = { ...ctx, level: lv.level };

  const entries = [];
  for (const rule of RULES) {
    if (AUDIT_RULE_IDS.includes(rule.id)) continue;
    try {
      entries.push(toEntry(rule, rule.run(runCtx)));
    } catch (err) {
      entries.push({
        rule_id: rule.id,
        code: 'QC_RULE_EXEC_FAILED',
        level: FAIL,
        applicable: true,
        source: 'run',
        carried_from: '',
        field: rule.id,
        fields: [rule.id],
        expected: '规则不得抛异常（抛错即缺陷，不降级为 PASS）',
        detail: { error: String(err && err.message ? err.message : err) },
      });
    }
  }

  // 审计类规则最后跑：它们看的是前面所有规则的字段级命中
  const audit = auditOf(entries);
  for (const rule of RULES) {
    if (!AUDIT_RULE_IDS.includes(rule.id)) continue;
    try {
      entries.push(toEntry(rule, rule.run({ ...runCtx, __audit: audit })));
    } catch (err) {
      entries.push({
        rule_id: rule.id,
        code: 'QC_RULE_EXEC_FAILED',
        level: FAIL,
        applicable: true,
        source: 'run',
        carried_from: '',
        field: rule.id,
        fields: [rule.id],
        expected: '规则不得抛异常',
        detail: { error: String(err && err.message ? err.message : err) },
      });
    }
  }

  const hits = entries.slice().sort((a, b) => cmpStr(a.rule_id, b.rule_id));
  const stats = {
    rules_total: hits.length,
    applicable: hits.filter((h) => h.applicable === true).length,
    pass: hits.filter((h) => h.applicable === true && h.level === PASS).length,
    warn: hits.filter((h) => h.applicable === true && h.level === WARN).length,
    fail: hits.filter((h) => h.applicable === true && h.level === FAIL).length,
    info: hits.filter((h) => h.applicable === true && h.level === INFO).length,
    not_applicable: hits.filter((h) => h.applicable === false).length,
    failed_rules: hits.filter((h) => h.applicable === true && h.level === FAIL).map((h) => h.rule_id),
    not_applicable_rules: hits.filter((h) => h.applicable === false).map((h) => h.rule_id),
  };

  return {
    level: aggregateLevel(hits),
    hits,
    stats,
    levelBasis: { level: lv.level, basis: lv.basis, declared_ignored: lv.declared_ignored },
  };
}

/** 单规则调用（测试与排障用）：跑一条规则并返回合并后的那一条 */
export function validateRule(ruleId, ctx = {}) {
  const rule = RULES.find((r) => r.id === ruleId);
  if (!rule) {
    const e = new Error(`未知规则：${ruleId}`);
    e.code = 'QC_RULE_UNKNOWN';
    throw e;
  }
  const lv = schema.computeLevel({ blockings: toArr(ctx.blockings), actions: toArr(ctx.actions), sceneState: ctx.sceneState });
  const runCtx = { ...ctx, level: ctx.level ?? lv.level };
  const res = rule.run(AUDIT_RULE_IDS.includes(rule.id) ? { ...runCtx, __audit: toArr(ctx.__audit) } : runCtx);
  return toEntry(rule, res);
}

/** 规则元数据（不含函数），供报告与 P9 的规则级映射使用 */
export function ruleCatalog() {
  return RULES.map((r) => ({ rule_id: r.id, level: r.level, title: r.title })).sort((a, b) => cmpStr(a.rule_id, b.rule_id));
}

export { insufficient, pass, notApplicable };
