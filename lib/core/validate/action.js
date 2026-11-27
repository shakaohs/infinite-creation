// 动作规则（P5）—— V-09、A-01～A-19
//
// 这一层的核心不是"动作写得对不对"，而是**时间与部位的位置算术**：
//   · 区间模型（D01-03 §5）：按人分组、组内取并集，**跨人不相加**；
//   · `spanRequired`（时间轴需求）与 `unionLen`（占用时长）是两个量，永远不能互相替代；
//   · 部位按独占组比较（左手 + 右手合法），不按"整体身体"比较。
// 把这三件事搞错，表现都是"把合法镜头判死"，而创作者只能靠删动作来消红灯。
import { cmpStr } from '../hash/cmp-str.js';
import {
  FAIL, WARN, INFO, TQ, quant, f, found, insufficient, notApplicable, pass,
  activeAreaOf, deepEqual, isBlank, isNum, num, numOrNull, posOf, relOf, segHitsRect, rectOf,
  toArr, toObj, fixturesOf, dist2,
} from './common.js';

/** 部位独占组（D01-03 §8 A-12）：同组的两动作不能同时发生；左右臂各自一组 */
export const GROUP_OF = Object.freeze({
  head: 'headface', neck: 'headface', face: 'headface', gaze: 'headface',
  torso: 'trunk', hips: 'trunk', spine: 'trunk',
  right_shoulder: 'arm_r', right_arm: 'arm_r', right_hand: 'arm_r', right_fingers: 'arm_r',
  left_shoulder: 'arm_l', left_arm: 'arm_l', left_hand: 'arm_l', left_fingers: 'arm_l',
  left_leg: 'lower', left_foot: 'lower', right_leg: 'lower', right_foot: 'lower', cog: 'lower',
});

/** 动作覆盖率上限（A-13）：超过就没有起势/收势的呼吸空间 */
export const COVERAGE_MAX = 0.9;
/** 位移终点与下镜 `state_in` 的容差（A-06，归一化） */
export const CROSS_SHOT_TOL = 0.15;
/** `end_state.pos` 与 `path.to` 的容差（A-04） */
export const END_STATE_TOL = 0.02;
/** `time_slices` 总和的容差（A-15，秒） */
export const SLICES_TOL = 0.1;
/** 台词语速上限（V-09）：中文 4.5 字/秒、英文 4.8 词/秒 */
export const SPEECH_MAX_CJK = 4.5;
export const SPEECH_MAX_EN = 4.8;
/** 标点停顿（V-09 从 span 中扣除，D01-03 §5.3） */
export const PAUSE_PER_PUNCT = 0.15;
/** T3 的 force.chain 环数下限（A-19） */
export const FORCE_CHAIN_MIN = 8;

const round3 = (x) => Math.round(x * 1000) / 1000;

/** 动作行的区间（量化到 TQ；`t_to` 缺省当 `t_from`） */
function intervalOf(a) {
  const from = quant(num(a?.t_from));
  const to = quant(num(a?.t_to));
  return { from, to };
}

/** 某动作声明的并行对象（`sync.parallel_with`） */
function parallelOf(a) {
  return toArr(toObj(a?.sync_json).parallel_with ?? a?.sync?.parallel_with).map((x) => String(x ?? ''));
}

/** 动作占用的部位组（去重、`cmpStr` 排序） */
export function groupsOf(a) {
  const parts = toArr(a?.body_parts);
  const out = [];
  for (const p of parts) {
    const key = typeof p === 'string' ? p : String(p?.part ?? '');
    const g = GROUP_OF[key];
    if (g && !out.includes(g)) out.push(g);
  }
  return out.sort(cmpStr);
}

/**
 * 动作时间分析（D02-06 §7.12，唯一实现）。
 *
 * 口径：
 *  · 按 `actor_id` 分组，**组内**区间并集 → `unionLen`；`coverage = unionLen / story_duration`；
 *  · `spanRequired` = 所有动作 `t_to` 的最大值（**不是并集**：镜头至少要这么久才放得下）；
 *  · 同人两动作区间重叠、部位组相交、且未互相声明 `parallel_with` → 冲突；
 *  · 入口量化到 `TQ=0.001`，严格比较，不设 EPS。
 *
 * @param {{actions?:Array, storyDuration?:number}} input
 * @returns {{spanRequired:number, unionMax:number, perActor:Object, conflicts:Array}}
 */
export function analyzeActionTime({ actions, storyDuration } = {}) {
  const D = Math.max(quant(num(storyDuration)), 0);
  const list = toArr(actions)
    .filter((a) => a && typeof a === 'object')
    .map((a) => ({ a, id: String(a.id ?? ''), actor: String(a.actor_id ?? ''), ...intervalOf(a) }))
    .sort((p, q) => p.from - q.from || p.to - q.to || cmpStr(p.id, q.id));

  const spanRequired = list.length ? Math.max(...list.map((x) => x.to)) : 0;

  const perActor = {};
  for (const actor of [...new Set(list.map((x) => x.actor))].sort(cmpStr)) {
    const items = list.filter((x) => x.actor === actor);
    const merged = [];
    for (const it of items) {
      const last = merged[merged.length - 1];
      if (last && it.from <= last.to) last.to = Math.max(last.to, it.to);
      else merged.push({ from: it.from, to: it.to });
    }
    const unionLen = quant(merged.reduce((s, m) => s + (m.to - m.from), 0));
    const gaps = [];
    for (let i = 1; i < merged.length; i += 1) gaps.push([merged[i - 1].to, merged[i].from]);
    perActor[actor] = {
      unionLen,
      coverage: D > 0 ? round3(unionLen / D) : 0,
      count: items.length,
      lastEnd: merged.length ? merged[merged.length - 1].to : 0,
      gaps,
    };
  }

  // `unionMax` = **各人并集长度**的最大值（不是单个动作的时长）：
  // D01-03 §5.6.1 的算例里 ac_1 只有 1.6s，但同人并集 2.6s —— 前者是"一个动作多久"，
  // 后者才是"这个人动了多久"。用单动作时长会低估占用，进而漏掉 A-13 的覆盖率。
  const unionMax = Object.keys(perActor).length
    ? Math.max(...Object.keys(perActor).map((k) => perActor[k].unionLen))
    : 0;

  // 同人 + 区间重叠 + 部位组相交 + 未声明 parallel_with
  const conflicts = [];
  for (const actor of Object.keys(perActor).sort(cmpStr)) {
    const items = list.filter((x) => x.actor === actor);
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const A = items[i];
        const B = items[j];
        const overlapFrom = Math.max(A.from, B.from);
        const overlapTo = Math.min(A.to, B.to);
        if (!(overlapTo > overlapFrom)) continue;
        const ga = groupsOf(A.a);
        const shared = ga.filter((g) => groupsOf(B.a).includes(g));
        if (!shared.length) continue;
        const declared = parallelOf(A.a).includes(B.id) || parallelOf(B.a).includes(A.id);
        if (declared) continue;
        conflicts.push({
          code: 'ACTION_PART_CONFLICT',
          actor,
          a: A.id,
          b: B.id,
          parts: shared.sort(cmpStr),
          overlap: [overlapFrom, overlapTo],
        });
      }
    }
  }
  conflicts.sort((p, q) => cmpStr(p.actor, q.actor) || cmpStr(p.a, q.a) || cmpStr(p.b, q.b));
  return { spanRequired, unionMax, perActor, conflicts };
}

// ── V-09 语速 ───────────────────────────────────────────────────────────

/** 中文按"字"计数（去标点与空白），英文按"词"计数 */
export function speechMetrics(text) {
  const s = String(text ?? '');
  const punct = (s.match(/[，。！？、；：""''（）《》…—,.!?;:'"()[\]<>-]/g) || []).length;
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const en = (s.match(/[A-Za-z][A-Za-z'-]*/g) || []).length;
  return { cjk, en, punct, unit: cjk >= en ? 'cjk' : 'en' };
}

/** 台词区间（本镜所有动作 `sync.dialogue_span` 的并集；无则 null） */
export function dialogueSpans(actions) {
  const spans = [];
  for (const a of toArr(actions)) {
    const sp = toArr(toObj(a?.sync_json).dialogue_span ?? a?.sync?.dialogue_span);
    if (sp.length === 2 && sp.every(isNum)) spans.push([quant(sp[0]), quant(sp[1])]);
  }
  if (!spans.length) return null;
  spans.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const merged = [spans[0].slice()];
  for (const s of spans.slice(1)) {
    const last = merged[merged.length - 1];
    if (s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push(s.slice());
  }
  return merged;
}

/**
 * V-09 语速（FAIL）：按 `sync.dialogue_span` 实算，**不用镜时长**。
 *
 * `(字数) / (span - 0.15×标点数)`；中文字/秒 > 4.5 或英文词/秒 > 4.8 → FAIL。
 * 无 `dialogue_span` 或台词为空 → INFO（数据不足）。
 *
 * @param {{shot:object, actions?:Array}} ctx
 */
export function checkDialogueSpeed(ctx = {}) {
  const text = String(ctx.shot?.dialogue ?? '');
  if (!text.trim()) return insufficient('DIALOGUE_EMPTY', 'dialogue', '本镜无台词，语速不可判定', {});
  const spans = dialogueSpans(ctx.actions);
  if (!spans) return insufficient('DIALOGUE_SPAN_MISSING', 'sync.dialogue_span', '动作行给出 dialogue_span 后才可实算语速', {});
  const { cjk, en, punct, unit } = speechMetrics(text);
  const span = quant(spans.reduce((s, [a, b]) => s + (b - a), 0));
  const speak = quant(Math.max(span - PAUSE_PER_PUNCT * punct, 0));
  if (speak <= 0) return insufficient('DIALOGUE_SPAN_MISSING', 'sync.dialogue_span', 'span 扣除停顿后必须 > 0', { span, punct });
  const units = unit === 'cjk' ? cjk : en;
  const rate = units / speak;
  const limit = unit === 'cjk' ? SPEECH_MAX_CJK : SPEECH_MAX_EN;
  if (rate > limit) {
    return found([
      f(FAIL, 'DIALOGUE_TOO_FAST', 'dialogue', `${unit === 'cjk' ? '字' : '词'}/秒 ≤ ${limit}`, {
        rate: round3(rate), limit, units, unit, span, speakable_span: speak, punct,
      }),
    ]);
  }
  return pass();
}

// ── A-01～A-19 ──────────────────────────────────────────────────────────

const isPrimary = (a) => Number(a?.is_primary) === 1;

/** 纯空镜：`is_insert=1` 或 `purpose='insert'`（A-01 唯一允许 0 个 primary 的情形） */
function isPureInsert(shot) {
  return Number(shot?.is_insert) === 1 || String(shot?.purpose ?? '') === 'insert';
}

/**
 * A-01 每镜 ≥1 个 `is_primary`（FAIL）：**纯空镜可 0**。
 *
 * @param {{shot:object, actions?:Array}} ctx
 */
export function checkPrimary(ctx = {}) {
  const actions = toArr(ctx.actions).filter((a) => a && typeof a === 'object');
  if (!actions.length) {
    if (isPureInsert(ctx.shot)) return notApplicable('纯空镜（is_insert=1 / purpose=insert）允许 0 个主动作');
    return found([f(FAIL, 'ACTION_PRIMARY_MISSING', 'shot_actions.is_primary', '每镜至少 1 个 is_primary=1 的动作（纯空镜除外）', {})]);
  }
  if (!actions.some(isPrimary)) {
    return found([f(FAIL, 'ACTION_PRIMARY_MISSING', 'shot_actions.is_primary', '每镜至少 1 个 is_primary=1 的动作（纯空镜除外）', {
      actions: actions.length,
    })]);
  }
  return pass();
}

/**
 * A-02 同角色同时间片不得有 2 个 `is_primary`（FAIL）：一个人不能同时做两个大动作。
 *
 * @param {{actions?:Array}} ctx
 */
export function checkPrimaryOverlap(ctx = {}) {
  const list = toArr(ctx.actions).filter((a) => a && typeof a === 'object' && isPrimary(a));
  if (list.length < 2) return notApplicable('本镜 primary 动作少于 2 个');
  const hits = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const A = list[i];
      const B = list[j];
      if (String(A.actor_id ?? '') !== String(B.actor_id ?? '')) continue;
      const a = intervalOf(A);
      const b = intervalOf(B);
      if (quant(Math.min(a.to, b.to) - Math.max(a.from, b.from)) > 0) {
        hits.push(f(FAIL, 'ACTION_PRIMARY_OVERLAP', 'shot_actions.is_primary', '同一角色同一时间片只允许 1 个 primary', {
          actor_id: String(A.actor_id ?? ''), a: String(A.id ?? ''), b: String(B.id ?? ''),
          overlap: [Math.max(a.from, b.from), Math.min(a.to, b.to)],
        }));
      }
    }
  }
  return found(hits);
}

/**
 * A-03 位移必有 `path.from/to` 坐标（FAIL）。只对 `action_type='locomotion'` 生效。
 *
 * @param {{actions?:Array}} ctx
 */
export function checkPath(ctx = {}) {
  const loco = toArr(ctx.actions).filter((a) => a && String(a.action_type ?? '') === 'locomotion');
  if (!loco.length) return notApplicable('本镜没有 locomotion 动作');
  const hits = [];
  for (const a of loco) {
    const path = toObj(a.path_json ?? a.path);
    const from = posOf(path.from);
    const to = posOf(path.to);
    if (!(isNum(from.x) && isNum(from.y))) {
      hits.push(f(FAIL, 'ACTION_PATH_MISSING', `path_json.from@${a.id}`, 'locomotion 必须给 path.from{x,y}', { action_id: String(a.id ?? '') }));
    }
    if (!(isNum(to.x) && isNum(to.y))) {
      hits.push(f(FAIL, 'ACTION_PATH_MISSING', `path_json.to@${a.id}`, 'locomotion 必须给 path.to{x,y}', { action_id: String(a.id ?? '') }));
    }
  }
  return found(hits);
}

/**
 * A-04 `end_state.pos` 必须等于 `path.to`（FAIL，容差 0.02）。
 *
 * 任一端不可知 → INFO（`STATE_UNKNOWN`）：没有 `end_state` 不是"写错了位置"，是"还没有位置"。
 *
 * @param {{actions?:Array}} ctx
 */
export function checkEndState(ctx = {}) {
  const list = toArr(ctx.actions).filter((a) => a && typeof a === 'object');
  if (!list.length) return notApplicable('本镜没有动作');
  const hits = [];
  for (const a of list) {
    const path = toObj(a.path_json ?? a.path);
    const to = posOf(path.to);
    if (!to.complete) continue;
    const end = posOf(toObj(a.end_state ?? a.end_state_json).pos);
    if (!end.complete) {
      hits.push(f(INFO, 'STATE_UNKNOWN', `end_state.pos@${a.id}`, 'end_state.pos 给出后才可与 path.to 比对', { action_id: String(a.id ?? ''), rel: 'unknown' }));
      continue;
    }
    const d = Math.max(Math.abs(end.x - to.x), Math.abs(end.y - to.y), Math.abs((end.z ?? 0) - (to.z ?? 0)));
    if (quant(d) > END_STATE_TOL) {
      hits.push(f(FAIL, 'ACTION_END_STATE_MISMATCH', `end_state.pos@${a.id}`, `等于 path.to（容差 ${END_STATE_TOL}）`, {
        action_id: String(a.id ?? ''), path_to: [to.x, to.y, to.z], end_state_pos: [end.x, end.y, end.z],
      }));
    }
  }
  return found(hits);
}

/** 折线（from → via[] → to）逐段与 zone 求交 */
function polylineHitsZone(path, zones) {
  const pts = [];
  const from = posOf(path.from);
  const to = posOf(path.to);
  if (isNum(from.x) && isNum(from.y)) pts.push(from);
  for (const v of toArr(path.via)) {
    const p = posOf(v);
    if (isNum(p.x) && isNum(p.y)) pts.push(p);
  }
  if (isNum(to.x) && isNum(to.y)) pts.push(to);
  for (let i = 1; i < pts.length; i += 1) {
    for (const z of zones) {
      if (segHitsRect(pts[i - 1], pts[i], z.rect)) return { zone: z, seg: [i - 1, i] };
    }
  }
  return null;
}

/** 场次里带 zone 的 fixtures（`rectOf` 规范化；非法 zone 直接跳过——那是 scene 层的数据问题） */
function zonesOf(sceneState) {
  return fixturesOf(sceneState)
    .map((fx) => ({ fx, rect: rectOf(fx.zone) }))
    .filter((z) => z.rect);
}

/**
 * A-05 位移不穿 `fixtures.zone`（FAIL）。
 *
 * 无 locomotion / 无路径 → 不适用；场次没有带 zone 的 fixtures → INFO（没有障碍物信息，判不了穿模）。
 *
 * @param {{actions?:Array, sceneState?:object}} ctx
 */
export function checkPathZone(ctx = {}) {
  const loco = toArr(ctx.actions).filter((a) => a && String(a.action_type ?? '') === 'locomotion');
  if (!loco.length) return notApplicable('本镜没有 locomotion 动作');
  const zones = zonesOf(ctx.sceneState);
  if (!zones.length) return insufficient('COORD_SYSTEM_INCOMPLETE', 'scene_states.fixtures[].zone', 'fixtures 给出 zone 后才可判穿模', {});
  const hits = [];
  for (const a of loco) {
    const path = toObj(a.path_json ?? a.path);
    const hitZone = polylineHitsZone(path, zones);
    if (hitZone) {
      hits.push(f(FAIL, 'ACTION_PATH_THROUGH_FIXTURE', `path_json@${a.id}`, `不与任何 fixtures.zone 相交（穿过 ${hitZone.zone.fx.id ?? '?'}）`, {
        action_id: String(a.id ?? ''), fixture_id: String(hitZone.zone.fx.id ?? ''), fixture_name: String(hitZone.zone.fx.name ?? ''),
        segment: hitZone.seg,
      }));
    }
  }
  return found(hits);
}

/**
 * A-06 位移终点与下镜 `state_in` 位置偏差 ≤0.15（FAIL，章级）。
 *
 * 没有下镜 → 不适用；下镜状态未知 → INFO（`STATE_UNKNOWN`）。
 *
 * @param {{actions?:Array, nextShotState?:object}} ctx
 */
export function checkCrossShot(ctx = {}) {
  const loco = toArr(ctx.actions).filter((a) => a && String(a.action_type ?? '') === 'locomotion');
  if (!loco.length) return notApplicable('本镜没有 locomotion 动作');
  const nextState = ctx.nextShotState && typeof ctx.nextShotState === 'object' ? ctx.nextShotState : null;
  if (!nextState) return notApplicable('本镜是章内末镜（无下镜可衔接）');
  const chars = toObj(toObj(nextState.state_in).chars);
  const hits = [];
  for (const a of loco) {
    const to = posOf(toObj(a.path_json ?? a.path).to);
    if (!to.complete) continue;
    const actor = String(a.actor_id ?? '');
    const nextPos = posOf(toObj(chars[actor]).pos);
    if (!nextPos.complete) {
      hits.push(f(INFO, 'STATE_UNKNOWN', `next.state_in.chars.${actor}.pos`, '下镜该角色位置可知后才可判衔接', { action_id: String(a.id ?? ''), rel: 'unknown' }));
      continue;
    }
    const d = Math.max(Math.abs(to.x - nextPos.x), Math.abs(to.y - nextPos.y));
    if (quant(d) > CROSS_SHOT_TOL) {
      hits.push(f(FAIL, 'ACTION_CROSS_SHOT_MISMATCH', `next.state_in.chars.${actor}.pos`, `与位移终点偏差 ≤${CROSS_SHOT_TOL}`, {
        action_id: String(a.id ?? ''), path_to: [to.x, to.y, to.z], next_pos: [nextPos.x, nextPos.y, nextPos.z], delta: round3(d),
      }));
    }
  }
  return found(hits);
}

/** `contact.target_type` → `assets.category`（同一套词，避免两套映射） */
const CONTACT_KIND = Object.freeze({ character: 'character', prop: 'prop', scene: 'scene', costume: 'costume' });

/**
 * A-07 `contact.target_id` 存在且 category 匹配（FAIL）。
 *
 * 无 contact → 不适用。`target_type='env'`（环境接触）不查资产表。
 *
 * @param {{actions?:Array, assetsById?:object|Map}} ctx
 */
export function checkContact(ctx = {}) {
  const withContact = toArr(ctx.actions).filter((a) => a && Object.keys(toObj(a.contact_json ?? a.contact)).length);
  if (!withContact.length) return notApplicable('本镜没有 contact');
  const hits = [];
  const lookup = (id) => (ctx.assetsById instanceof Map ? ctx.assetsById.get(id) : ctx.assetsById?.[id]);
  for (const a of withContact) {
    const c = toObj(a.contact_json ?? a.contact);
    const type = String(c.target_type ?? '');
    const id = String(c.target_id ?? '');
    if (type === 'env') continue; // 环境接触不指向资产
    const expectCategory = CONTACT_KIND[type];
    if (!expectCategory) {
      hits.push(f(FAIL, 'ACTION_CONTACT_TARGET_INVALID', `contact_json.target_type@${a.id}`, 'character/prop/scene/costume/env 之一', { action_id: String(a.id ?? ''), target_type: type }));
      continue;
    }
    const asset = lookup(id);
    if (!asset) {
      hits.push(f(FAIL, 'ACTION_CONTACT_TARGET_INVALID', `contact_json.target_id@${a.id}`, `存在于 assets 的 ${expectCategory} 资产（${id || '空 id'}）`, {
        action_id: String(a.id ?? ''), target_id: id, target_type: type,
      }));
      continue;
    }
    if (String(asset.category ?? '') !== expectCategory) {
      hits.push(f(FAIL, 'ACTION_CONTACT_CATEGORY_MISMATCH', `contact_json.target_id@${a.id}`, `资产 category=${expectCategory}`, {
        action_id: String(a.id ?? ''), target_id: id, category: String(asset.category ?? ''), target_type: type,
      }));
    }
  }
  return found(hits);
}

/**
 * A-08 有 `contact` 到角色时，该角色须有 `reaction` 动作（WARN）。
 *
 * WARN 不需要确定值：被打的人没反应，本身就是"表演缺失"，不是"数据缺失"。
 *
 * @param {{actions?:Array}} ctx
 */
export function checkReaction(ctx = {}) {
  const list = toArr(ctx.actions).filter((a) => a && typeof a === 'object');
  const toChar = list.filter((a) => String(toObj(a.contact_json ?? a.contact).target_type ?? '') === 'character');
  if (!toChar.length) return notApplicable('本镜没有指向角色的 contact');
  const hits = [];
  for (const a of toChar) {
    const target = String(toObj(a.contact_json ?? a.contact).target_id ?? '');
    const hasReaction = list.some((b) => String(b.actor_id ?? '') === target && String(b.action_type ?? '') === 'reaction');
    if (!hasReaction) {
      hits.push(f(WARN, 'ACTION_REACTION_MISSING', `shot_actions(actor=${target}).action_type`, `被接触角色需要有 reaction 动作`, {
        contact_action: String(a.id ?? ''), target_id: target,
      }));
    }
  }
  return found(hits);
}

/**
 * A-09 `trigger.kind='action'` 的 `ref` 必须存在，且不得因果倒置。
 *
 * 级别取 D01 原文的细分：`ref` 不存在 → FAIL；`ref` 指向的动作 `t_to > 本动作 t_from` → WARN（因果倒置）。
 * （D02-06 矩阵把两者都写在 FAIL 行；D01 §3.2 明确倒置是 WARN。冲突已登记 U-P5-2，按 D01 细分执行。）
 *
 * @param {{actions?:Array, prevActions?:Array}} ctx
 */
export function checkTrigger(ctx = {}) {
  const list = toArr(ctx.actions).filter((a) => a && typeof a === 'object');
  const pool = [...list, ...toArr(ctx.prevActions)];
  const withTrigger = list.filter((a) => String(toObj(a.trigger_json ?? a.trigger).kind ?? '') === 'action');
  if (!withTrigger.length) return notApplicable('本镜没有 kind=action 的 trigger');
  const byId = new Map(pool.map((a) => [String(a.id ?? ''), a]));
  const hits = [];
  for (const a of withTrigger) {
    const ref = String(toObj(a.trigger_json ?? a.trigger).ref ?? '');
    const src = byId.get(ref);
    if (!ref || !src) {
      hits.push(f(FAIL, 'ACTION_TRIGGER_REF_MISSING', `trigger_json.ref@${a.id}`, '指向同镜或前镜已存在的动作 id', { action_id: String(a.id ?? ''), ref }));
      continue;
    }
    const srcEnd = intervalOf(src).to;
    const mine = intervalOf(a).from;
    if (srcEnd > mine) {
      hits.push(f(WARN, 'ACTION_TRIGGER_CAUSALITY_REVERSED', `trigger_json.ref@${a.id}`, '触发动作必须在本动作开始前结束（不得因果倒置）', {
        action_id: String(a.id ?? ''), ref, ref_t_to: srcEnd, t_from: mine,
      }));
    }
  }
  return found(hits);
}

/**
 * A-10 `result.prop_delta[].from` 必须等于当前道具状态（FAIL）。
 *
 * 以 `state_in.props[id]` 为"当前状态"；`state_in` 里没有该道具 → INFO（`STATE_UNKNOWN`）。
 * 只比 `state` 与 `owner` 两个可判定字段：`condition` 是自由文本，不比。
 *
 * @param {{actions?:Array, shotState?:object}} ctx
 */
export function checkPropDelta(ctx = {}) {
  const list = toArr(ctx.actions).filter((a) => a && typeof a === 'object');
  const deltas = [];
  for (const a of list) {
    for (const d of toArr(toObj(a.result_json ?? a.result).prop_delta)) {
      if (d && typeof d === 'object') deltas.push({ a, d });
    }
  }
  if (!deltas.length) return notApplicable('本镜没有 prop_delta');
  const props = toObj(toObj(ctx.shotState?.state_in).props);
  const hits = [];
  for (const { a, d } of deltas) {
    const id = String(d.prop_id ?? '');
    const cur = props[id];
    if (!cur || typeof cur !== 'object') {
      hits.push(f(INFO, 'STATE_UNKNOWN', `state_in.props.${id}`, 'state_in 里有该道具状态后才可判 from 是否一致', {
        action_id: String(a.id ?? ''), prop_id: id, rel: 'unknown',
      }));
      continue;
    }
    const from = toObj(d.from);
    for (const key of ['state', 'owner']) {
      const want = String(from[key] ?? '');
      const got = String(cur[key] ?? '');
      if (want && got && want !== got) {
        hits.push(f(FAIL, 'ACTION_PROP_DELTA_MISMATCH', `result_json.prop_delta.${id}.from.${key}`, `等于当前状态 ${got}`, {
          action_id: String(a.id ?? ''), prop_id: id, key, from: want, current: got,
        }));
      }
    }
  }
  return found(hits);
}

/**
 * A-11 动作区间必须落在 `[0, story_duration]` 且 `t_to > t_from`（FAIL）。
 *
 * @param {{actions?:Array, shot:object}} ctx
 */
export function checkRange(ctx = {}) {
  const list = toArr(ctx.actions).filter((a) => a && typeof a === 'object');
  if (!list.length) return notApplicable('本镜没有动作');
  const D = quant(num(ctx.shot?.story_duration));
  const hits = [];
  for (const a of list) {
    const { from, to } = intervalOf(a);
    if (!(to > from)) {
      hits.push(f(FAIL, 'ACTION_INTERVAL_INVALID', `shot_actions.t_to@${a.id}`, 't_to 必须大于 t_from', { action_id: String(a.id ?? ''), t_from: from, t_to: to }));
      continue;
    }
    if (from < 0 || (D > 0 && to > D)) {
      hits.push(f(FAIL, 'ACTION_OUT_OF_RANGE', `shot_actions.t_to@${a.id}`, `落在 [0, ${D}] 内`, {
        action_id: String(a.id ?? ''), t_from: from, t_to: to, story_duration: D,
      }));
    }
  }
  return found(hits);
}

/**
 * A-12 同 actor 两动作区间重叠、共享独占部位组、且未声明 `parallel_with`（FAIL）。
 *
 * 判定复用 `analyzeActionTime`（同一套组划分与区间合并，不另写一份）。
 *
 * @param {{actions?:Array, shot:object}} ctx
 */
export function checkPartConflict(ctx = {}) {
  const list = toArr(ctx.actions).filter((a) => a && typeof a === 'object');
  if (list.length < 2) return notApplicable('本镜动作少于 2 个，同人重叠不可能');
  const res = analyzeActionTime({ actions: list, storyDuration: ctx.shot?.story_duration });
  if (!res.conflicts.length) return pass();
  return found(res.conflicts.map((c) => f(FAIL, 'ACTION_PART_CONFLICT', `shot_actions(${c.actor}).body_parts`, '同人重叠动作不得共享独占部位组（或必须声明 parallel_with）', c)));
}

/**
 * A-13 同一 actor 动作覆盖率 > 0.9（WARN）。
 *
 * 覆盖率高说明"这个人从头动到尾"，没有起势/收势间隙。`coverage = unionLen / story_duration`。
 *
 * @param {{actions?:Array, shot:object}} ctx
 */
export function checkCoverage(ctx = {}) {
  const list = toArr(ctx.actions).filter((a) => a && typeof a === 'object');
  if (!list.length) return notApplicable('本镜没有动作');
  const D = quant(num(ctx.shot?.story_duration));
  if (!(D > 0)) return insufficient('STORY_DURATION_UNKNOWN', 'story_duration', '镜长 > 0 后才可算覆盖率', {});
  const res = analyzeActionTime({ actions: list, storyDuration: D });
  const hits = [];
  for (const actor of Object.keys(res.perActor).sort(cmpStr)) {
    const p = res.perActor[actor];
    if (p.coverage > COVERAGE_MAX) {
      hits.push(f(WARN, 'ACTION_NO_BREATH', `shot_actions(${actor}).coverage`, `动作覆盖率 ≤ ${COVERAGE_MAX}`, {
        actor, coverage: p.coverage, unionLen: p.unionLen, story_duration: D,
      }));
    }
  }
  return found(hits);
}

/**
 * A-14 台词区间内说话人有 `head`/`face` 且 `power ≥ 8` 的动作（WARN，口型冲突）。
 *
 * @param {{shot:object, actions?:Array}} ctx
 */
export function checkLipsync(ctx = {}) {
  const spans = dialogueSpans(ctx.actions);
  if (!spans) return notApplicable('本镜没有 dialogue_span，口型区间不可知');
  const speakers = toArr(ctx.shot?.speakers).map((s) => String(s?.id ?? ''));
  const hits = [];
  for (const a of toArr(ctx.actions)) {
    if (!a || typeof a !== 'object') continue;
    const actor = String(a.actor_id ?? '');
    if (speakers.length && !speakers.includes(actor)) continue;
    if (num(a.power) < 8) continue;
    const parts = groupsOf(a);
    if (!parts.includes('headface')) continue;
    const iv = intervalOf(a);
    const inSpan = spans.some(([s, e]) => Math.min(iv.to, e) > Math.max(iv.from, s));
    if (inSpan) {
      hits.push(f(WARN, 'ACTION_MOUTH_CONFLICT', `shot_actions(${actor}).body_parts`, '说话期间头部/面部动作不得与口型冲突（power ≥ 8）', {
        action_id: String(a.id ?? ''), actor, power: num(a.power), interval: [iv.from, iv.to], spans,
      }));
    }
  }
  return found(hits);
}

/**
 * A-15 `time_slices` 总和必须等于 `story_duration`（FAIL，±0.1）。
 *
 * `time_slices=[]` → INFO（数据不足）。与 V-20 分工：V-20 判"有没有空洞/首尾对齐"，
 * A-15 判"总量对不对"——两条都会在有洞时报，但判据不同，不能互相替代。
 *
 * @param {{shot:object}} ctx
 */
export function checkSlicesSum(ctx = {}) {
  const shots = toArr(ctx.shot?.time_slices);
  if (!shots.length) return insufficient('TIME_SLICES_EMPTY', 'time_slices', '给出时间切片后才可核对总量', {});
  const D = quant(num(ctx.shot?.story_duration));
  const sum = quant(shots.reduce((s, x) => s + Math.max(quant(num(x?.to)) - quant(num(x?.from)), 0), 0));
  if (Math.abs(sum - D) > SLICES_TOL) {
    return found([
      f(FAIL, 'SLICES_SUM_MISMATCH', 'time_slices', `总和 = story_duration（${D}s，±${SLICES_TOL}）`, {
        sum, story_duration: D, delta: round3(sum - D),
      }),
    ]);
  }
  return pass();
}

/**
 * A-16 `speed.profile=sudden` 必须有前置 `hold` 时间片（WARN）。
 *
 * 无 `time_slices`（hold 不可知）→ 不适用。
 *
 * @param {{shot:object, actions?:Array}} ctx
 */
export function checkSudden(ctx = {}) {
  const slices = toArr(ctx.shot?.time_slices).filter((s) => s && typeof s === 'object');
  const sudden = toArr(ctx.actions).filter((a) => a && String(toObj(a.speed_json ?? a.speed).profile ?? '') === 'sudden');
  if (!sudden.length) return notApplicable('本镜没有 speed.profile=sudden 的动作');
  if (!slices.length) return notApplicable('没有 time_slices，前置 hold 不可知');
  const hits = [];
  for (const a of sudden) {
    const from = intervalOf(a).from;
    const hasHold = slices.some((s) => String(s.kind ?? '') === 'hold' && quant(num(s.to)) <= from);
    if (!hasHold) {
      hits.push(f(WARN, 'ACTION_SUDDEN_WITHOUT_HOLD', `shot_actions(${String(a.actor_id ?? '')}).speed.profile`, 'sudden 之前必须有 hold 时间片（蓄力）', {
        action_id: String(a.id ?? ''), t_from: from,
      }));
    }
  }
  return found(hits);
}

/** 自动判档（D01-03 §2）：`combat && is_key_blow` → T3；有 path.to 或 contact → T2；否则 T1 */
export function autoTierOf(a) {
  const path = toObj(a?.path_json ?? a?.path);
  const contact = toObj(a?.contact_json ?? a?.contact);
  const sync = toObj(a?.sync_json ?? a?.sync);
  const isKeyBlow = sync.is_key_blow === true || sync.is_key_blow === 1;
  if (String(a?.action_type ?? '') === 'combat' && isKeyBlow) return 'T3';
  if (posOf(path.to).complete || String(contact.target_id ?? '')) return 'T2';
  return 'T1';
}

const TIER_RANK = { T1: 1, T2: 2, T3: 3 };

/**
 * A-17 档位与内容相符（WARN）：由字段集自动判档，模型自选档位不得低于所需档。
 *
 * 低报（T1 却带 path/contact）比高报更危险（会漏掉必填检查），因此两个方向都报。
 *
 * @param {{actions?:Array}} ctx
 */
export function checkTierMatch(ctx = {}) {
  const list = toArr(ctx.actions).filter((a) => a && typeof a === 'object');
  if (!list.length) return notApplicable('本镜没有动作');
  const hits = [];
  for (const a of list) {
    const declared = String(a.tier ?? '');
    const auto = autoTierOf(a);
    if (!declared || !TIER_RANK[declared]) continue;
    if (declared !== auto) {
      hits.push(f(WARN, 'ACTION_TIER_MISMATCH', `shot_actions.tier@${a.id}`, `按字段集应为 ${auto}`, {
        action_id: String(a.id ?? ''), declared, auto,
      }));
    }
  }
  return found(hits);
}

/**
 * A-18 `parallel_with` 双向一致（INFO，程序补齐）。
 *
 * 单边声明不算错：补齐即可。这里**只报告缺哪一边**，不改入参（P5 是纯函数，落库在 P9）。
 *
 * @param {{actions?:Array}} ctx
 */
export function normalizeParallel(ctx = {}) {
  const list = toArr(ctx.actions).filter((a) => a && typeof a === 'object');
  if (!list.length) return notApplicable('本镜没有动作');
  const byId = new Map(list.map((a) => [String(a.id ?? ''), a]));
  const hits = [];
  for (const a of list) {
    const id = String(a.id ?? '');
    for (const other of parallelOf(a)) {
      const b = byId.get(other);
      if (!b) continue; // 指向不存在/跨镜的动作 → 由 A-09/A-18 之外的挂载点处理，这里不猜
      if (!parallelOf(b).includes(id)) {
        hits.push(f(INFO, 'PARALLEL_ONE_SIDED', `sync_json.parallel_with@${id}`, `${other} 也应声明 parallel_with: [${id}]`, {
          declared_by: id, missing_on: other,
          normalized: { [id]: parallelOf(a).slice().sort(cmpStr), [other]: [...parallelOf(b), id].sort(cmpStr) },
        }));
      }
    }
  }
  return found(hits);
}

/**
 * A-19 T3 的 `force.chain` 至少 8 环（FAIL）。非 T3 → 不适用。
 *
 * @param {{actions?:Array}} ctx
 */
export function checkForceChain(ctx = {}) {
  const t3 = toArr(ctx.actions).filter((a) => a && String(a.tier ?? '') === 'T3');
  if (!t3.length) return notApplicable('本镜没有 T3 动作');
  const hits = [];
  for (const a of t3) {
    const chain = toArr(toObj(a.force_json ?? a.force).chain);
    if (chain.length < FORCE_CHAIN_MIN) {
      hits.push(f(FAIL, 'ACTION_FORCE_CHAIN_SHORT', `force_json.chain@${a.id}`, `T3 至少 ${FORCE_CHAIN_MIN} 环（当前 ${chain.length}）`, {
        action_id: String(a.id ?? ''), chain_length: chain.length,
      }));
    }
  }
  return found(hits);
}

export const RULES = [
  { id: 'V-09', level: 'FAIL', title: '语速（按 dialogue_span 实算）', run: checkDialogueSpeed },
  { id: 'A-01', level: 'FAIL', title: '每镜 ≥1 个 is_primary', run: checkPrimary },
  { id: 'A-02', level: 'FAIL', title: '同角色同时间片 2 个 primary', run: checkPrimaryOverlap },
  { id: 'A-03', level: 'FAIL', title: '位移必有 path.from/to', run: checkPath },
  { id: 'A-04', level: 'FAIL', title: 'end_state.pos = path.to（±0.02）', run: checkEndState },
  { id: 'A-05', level: 'FAIL', title: '位移不穿 fixtures.zone', run: checkPathZone },
  { id: 'A-06', level: 'FAIL', title: '位移终点与下镜 state_in 一致（≤0.15）', run: checkCrossShot },
  { id: 'A-07', level: 'FAIL', title: 'contact.target_id 存在且 category 匹配', run: checkContact },
  { id: 'A-08', level: 'WARN', title: 'contact 到角色须有 reaction', run: checkReaction },
  { id: 'A-09', level: 'FAIL', title: 'trigger 引用存在且非因果倒置', run: checkTrigger },
  { id: 'A-10', level: 'FAIL', title: 'prop_delta.from = 当前道具状态', run: checkPropDelta },
  { id: 'A-11', level: 'FAIL', title: '动作区间越界 / t_to ≤ t_from', run: checkRange },
  { id: 'A-12', level: 'FAIL', title: '同人重叠动作共享部位组', run: checkPartConflict },
  { id: 'A-13', level: 'WARN', title: '同人动作覆盖率 >0.9', run: checkCoverage },
  { id: 'A-14', level: 'WARN', title: '台词区间内 head/face 高 power 动作', run: checkLipsync },
  { id: 'A-15', level: 'FAIL', title: 'time_slices 总和 = story_duration', run: checkSlicesSum },
  { id: 'A-16', level: 'WARN', title: 'sudden 缺前置 hold', run: checkSudden },
  { id: 'A-17', level: 'WARN', title: '档位与内容相符', run: checkTierMatch },
  { id: 'A-18', level: 'INFO', title: 'parallel_with 双向一致', run: normalizeParallel },
  { id: 'A-19', level: 'FAIL', title: 'T3 的 force.chain ≥8', run: checkForceChain },
];

/** 导出给测试与后续 P6 用：区间量化后的读法（避免测试自己再写一份） */
export const actionInterval = intervalOf;
