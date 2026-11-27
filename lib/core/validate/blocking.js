// 站位规则（P5）—— S-01～S-04、S-16、S-17、S-24、S-25、V-04、V-24
//
// 这一层的判断对象是"人在哪、靠着什么、能不能站得住"，以及 **QC 自身不许做的事**（S-25）。
// 三条硬边界：
//   ① 坐标缺失一律按"未知"处理（`posRel` 判定），**不得补 0、不得当 known**；
//   ② `position_abs` 只有"画面左右 / 东南西北 / 上下"这类**可换算**的方位词才与 `norm_*` 比对，
//      "病床右侧·床头柜旁" 这类物体相对方位**不参与换算**（换算不了就别假装能换算）；
//   ③ 虚拟场次（`scene_id=''`）合法：它与"场次缺失"是两件事。
import { cmpStr } from '../hash/cmp-str.js';
import { posRel } from '../continuity/pos-rel.js';
import * as schema from './schema.js';
import {
  FAIL, WARN, INFO, f, found, insufficient, notApplicable, pass,
  isBlank, isNum, isPresent, num, numOrNull, posOf, rectOf, segHitsRect, toArr, toObj,
  fixturesOf, relOf, sideOf, deepEqual,
} from './common.js';

/** `position_abs` 的可换算方位词 → 归一化轴（只有这些才参与 S-03 的比对） */
const AXIS_WORDS = Object.freeze([
  { axis: 'x', dir: 'low', words: ['画面左', '偏左', '左侧', '东侧', '东边', '靠东'] },
  { axis: 'x', dir: 'high', words: ['画面右', '偏右', '右侧', '西侧', '西边', '靠西'] },
  { axis: 'y', dir: 'low', words: ['画面下', '偏下', '下方', '南侧', '南边', '靠南'] },
  { axis: 'y', dir: 'high', words: ['画面上', '偏上', '上方', '北侧', '北边', '靠北'] },
  { axis: 'z', dir: 'low', words: ['地面层', '贴近地面', '低位'] },
  { axis: 'z', dir: 'high', words: ['高位', '高处', '抬升'] },
]);

/** 方位判定的容差：`norm=0.5` 附近不判（边界上本来就两可） */
const ABS_TOL = 0.05;

/** 站位行坐标三元组（与 DB 列同源） */
function trip(b) {
  return { x: numOrNull(b?.norm_x), y: numOrNull(b?.norm_y), z: numOrNull(b?.norm_z) };
}

/** 该站位行的坐标可靠性（**唯一实现** = P4 的 `posRel`，不另写一份） */
export function blockingPosRel(b, shot, meta) {
  const t = trip(b);
  const id = String(b?.character_id ?? '');
  return posRel({
    x: t.x,
    y: t.y,
    z: t.z,
    metaEntry: meta ? meta[`chars.${id}.pos`] : undefined,
    specSource: String(shot?.spec_source ?? ''),
  });
}

/** 场次里的 fixture 集合（按 id/name 建索引，供 S-02 判断依托物是否存在） */
function fixtureIndex(sceneState) {
  const byId = new Map();
  const byName = new Map();
  for (const fx of fixturesOf(sceneState)) {
    if (fx.id) byId.set(String(fx.id), fx);
    if (fx.name) byName.set(String(fx.name), fx);
  }
  return { byId, byName };
}

/**
 * S-01 场次基线存在（FAIL）。
 *
 * 没有 `scene_states` 行 → 这一镜的空间语义无处可查（不是"场次为空"，是"根本没建基线"）。
 * 注意：虚拟场次（`scene_id=''`）**合法**，只要行存在。
 *
 * @param {{shot:object, sceneState?:object}} ctx
 */
export function checkBaseline(ctx = {}) {
  const scene = ctx.sceneState;
  const key = String(ctx.shot?.scene_key ?? '');
  if (!scene || typeof scene !== 'object' || !Object.keys(scene).length) {
    return found([f(FAIL, 'SCENE_STATE_MISSING', 'scene_key', `scene_states 中存在 scene_key=${key || '(空)'} 的基线`, { scene_key: key })]);
  }
  return pass();
}

/**
 * S-02 依托物存在（`fixtures` 或 `prop`）（FAIL）。
 *
 * S0 不适用（S0 不要求 `anchor_object`）。存在性判定接受三种写法：`fixtures.id`、`fixtures.name`、
 * 资产 id/name —— D01 只规定"`fixtures.id` 或道具 id"，接受 name 是为了兼容既有文本写法，
 * 但**编造的依托物仍然会被拒**（三种都查不到）。
 *
 * @param {{shot:object, blockings?:Array, sceneState?:object, assetsById?:object|Map, level?:string}} ctx
 */
export function checkAnchor(ctx = {}) {
  const level = String(ctx.level ?? 'S0');
  if (level === 'S0') return notApplicable('S0 不要求 anchor_object / behind_object');
  const rows = toArr(ctx.blockings).filter((b) => b && typeof b === 'object');
  if (!rows.length) return notApplicable('本镜没有站位行');
  const { byId, byName } = fixtureIndex(ctx.sceneState);
  const hasAsset = (id) => (ctx.assetsById instanceof Map ? ctx.assetsById.has(id) : !!ctx.assetsById?.[id]);
  const propIds = new Set(toArr(ctx.shotAssets).filter((a) => String(a?.role ?? '') === 'prop').map((a) => String(a.asset_id ?? '')));
  const hits = [];
  for (const b of rows) {
    const anchor = String(b.anchor_object ?? '').trim();
    if (!anchor) {
      hits.push(f(FAIL, 'BLOCKING_ANCHOR_MISSING', `shot_blockings(${String(b.character_id ?? '')}).anchor_object`, `${level} 必填：依托物（fixtures.id 或道具 id）`, {
        character_id: String(b.character_id ?? ''), level,
      }));
      continue;
    }
    const known = byId.has(anchor) || byName.has(anchor) || hasAsset(anchor) || propIds.has(anchor);
    if (!known) {
      hits.push(f(FAIL, 'BLOCKING_ANCHOR_NOT_FOUND', `shot_blockings(${String(b.character_id ?? '')}).anchor_object`, '依托物必须能落到 fixtures 或 assets', {
        character_id: String(b.character_id ?? ''), anchor_object: anchor,
        fixtures: [...byId.keys()].sort(cmpStr),
      }));
    }
  }
  return found(hits);
}

/**
 * S-03 `position_abs` 方位词与 `norm_xyz` 一致（FAIL，**仅当两者均 known**）。
 *
 * 只比对**可换算**的方位词（画面左右/东南西北/上下/高低位）；物体相对方位（"病床右侧"）不参与。
 * 坐标未知 → INFO；`position_abs` 为空 → INFO（必填缺失由 V-01 负责）。
 *
 * @param {{shot:object, blockings?:Array, shotState?:object}} ctx
 */
export function checkAbsCoord(ctx = {}) {
  const rows = toArr(ctx.blockings).filter((b) => b && typeof b === 'object');
  if (!rows.length) return notApplicable('本镜没有站位行');
  const meta = toObj(ctx.shotState?.meta);
  const hits = [];
  for (const b of rows) {
    const id = String(b.character_id ?? '');
    const t = trip(b);
    if (![t.x, t.y, t.z].every(isNum)) {
      hits.push(f(INFO, 'STATE_UNKNOWN', `shot_blockings(${id}).norm_xyz`, '坐标齐备后才可与 position_abs 比对', { character_id: id, rel: 'unknown' }));
      continue;
    }
    const text = String(b.position_abs ?? '');
    if (!text.trim()) {
      hits.push(f(INFO, 'POSITION_ABS_EMPTY', `shot_blockings(${id}).position_abs`, '写明方位后才可比对', { character_id: id, rel: 'unknown' }));
      continue;
    }
    for (const rule of AXIS_WORDS) {
      const word = rule.words.find((w) => text.includes(w));
      if (!word) continue;
      const v = rule.axis === 'x' ? t.x : rule.axis === 'y' ? t.y : t.z;
      const bad = rule.dir === 'low' ? v > 0.5 + ABS_TOL : v < 0.5 - ABS_TOL;
      if (bad) {
        hits.push(f(FAIL, 'BLOCKING_ABS_COORD_MISMATCH', `shot_blockings(${id}).position_abs`, `与 norm_${rule.axis}=${v} 一致（${word} 应在 ${rule.dir === 'low' ? '≤0.5' : '≥0.5'} 一侧）`, {
          character_id: id, position_abs: text, word, axis: rule.axis, value: v, rel: relOf(meta, `chars.${id}.pos`) ?? 'known',
        }));
      }
      break; // 一行只按第一个命中的方位词判，避免"画面上方偏左"两轴重复报
    }
  }
  return found(hits);
}

function zonesOf(sceneState) {
  return fixturesOf(sceneState).map((fx) => ({ fx, rect: rectOf(fx.zone) })).filter((z) => z.rect);
}

/**
 * S-04 位移不穿 `fixtures.zone`（FAIL）。
 *
 * 无 `position_track` → 不适用；场次没有带 zone 的 fixtures → INFO（没有障碍物信息，判不了穿模）。
 *
 * @param {{blockings?:Array, sceneState?:object}} ctx
 */
export function checkTrackZone(ctx = {}) {
  const rows = toArr(ctx.blockings).filter((b) => b && typeof b === 'object' && toArr(b.position_track).length > 1);
  if (!rows.length) return notApplicable('本镜没有 position_track');
  const zones = zonesOf(ctx.sceneState);
  if (!zones.length) return insufficient('COORD_SYSTEM_INCOMPLETE', 'scene_states.fixtures[].zone', 'fixtures 给出 zone 后才可判轨迹穿模', {});
  const hits = [];
  for (const b of rows) {
    const pts = toArr(b.position_track).map((p) => posOf(p));
    for (let i = 1; i < pts.length; i += 1) {
      for (const z of zones) {
        if (segHitsRect(pts[i - 1], pts[i], z.rect)) {
          hits.push(f(FAIL, 'BLOCKING_TRACK_THROUGH_FIXTURE', `shot_blockings(${String(b.character_id ?? '')}).position_track`, '轨迹不得穿过 fixtures.zone', {
            character_id: String(b.character_id ?? ''), fixture_id: String(z.fx.id ?? ''), segment: [i - 1, i],
          }));
        }
      }
    }
  }
  return found(hits);
}

/**
 * S-16 群像开关未裁（WARN）。
 *
 * 口径（D01 只给了 `A/B/C` 三值，未给语义，本实现取最保守读法，已登记 U-P5-4）：
 *  · `crowd_switch` 为空 → INFO `CROWD_SWITCH_UNKNOWN`（数据不足出口）；
 *  · `A`（保留群像）却用特写/近景 → WARN `CROWD_UNCUT`（群像塞进近景必糊）；
 *  · `B`/`C`（已裁）→ PASS。
 *
 * @param {{shot:object, sceneState?:object}} ctx
 */
export function checkCrowd(ctx = {}) {
  const sw = String(ctx.sceneState?.crowd_switch ?? '');
  if (!sw) return insufficient('CROWD_SWITCH_UNKNOWN', 'scene_states.crowd_switch', '声明群像开关后才可判定裁剪是否合理', {});
  const closeish = ['medium_close', 'close', 'close_up', 'extreme_close'];
  const size = String(ctx.shot?.shot_size ?? '');
  if (sw === 'A' && closeish.includes(size)) {
    return found([f(WARN, 'CROWD_UNCUT', 'scene_states.crowd_switch', 'A（保留群像）不得配特写/近景', { crowd_switch: sw, shot_size: size })]);
  }
  return pass();
}

/**
 * S-17 权力几何未变且未声明过场（WARN）。
 *
 * 口径（D01 只写"场初/场末"，未给结构，已登记 U-P5-5）：
 *  · `power_geometry` 为空 → INFO `POWER_GEOMETRY_UNKNOWN`；
 *  · `start` 与 `end` 深度相等、而本镜 `purpose='turn'`（承担转折）→ WARN `POWER_GEOMETRY_UNCHANGED`；
 *  · 其他 → PASS。
 *
 * @param {{shot:object, sceneState?:object}} ctx
 */
export function checkPower(ctx = {}) {
  const pg = toObj(ctx.sceneState?.power_geometry);
  if (!Object.keys(pg).length) {
    return insufficient('POWER_GEOMETRY_UNKNOWN', 'scene_states.power_geometry', '给出权力几何（场初/场末）后才可判定', {});
  }
  const start = pg.start ?? pg.from;
  const end = pg.end ?? pg.to;
  if (start === undefined || end === undefined) {
    return insufficient('POWER_GEOMETRY_UNKNOWN', 'scene_states.power_geometry.start', '场初/场末都必须给出', { keys: Object.keys(pg).sort(cmpStr) });
  }
  const purpose = String(ctx.shot?.purpose ?? '');
  if (purpose === 'turn' && deepEqual(start, end)) {
    return found([f(WARN, 'POWER_GEOMETRY_UNCHANGED', 'scene_states.power_geometry', 'purpose=turn 的镜必须体现权力关系变化', { purpose })]);
  }
  return pass();
}

/**
 * S-24 `norm_x/y/z` 部分为 NULL（FAIL `COORD_PARTIAL`，写入侧错误）。
 *
 * 直接复用 P4 的 `schema.checkBlockingFields`（同一份整体性判定），只取 `COORD_PARTIAL` 那一条：
 * **不在本模块重写"三缺一"的逻辑**，否则两处口径迟早分叉。
 *
 * @param {{blockings?:Array}} ctx
 */
export function checkCoordPartial(ctx = {}) {
  const rows = toArr(ctx.blockings).filter((b) => b && typeof b === 'object');
  if (!rows.length) return notApplicable('本镜没有站位行');
  const hits = [];
  rows.forEach((b, i) => {
    for (const h of schema.checkBlockingFields(b, i)) {
      if (h.code === 'COORD_PARTIAL') {
        hits.push(f(FAIL, 'COORD_PARTIAL', h.field, h.expected, h.detail ?? {}));
      }
    }
  });
  return found(hits);
}

/**
 * S-25 **坐标缺失却被当作 known**（QC 自身约束，反向断言）。
 *
 * 它不看创作数据"对不对"，只看 QC 有没有把 `unknown` 当已知去判 FAIL：
 * 扫一遍其它规则已经产出的命中，凡是 `detail.rel === 'unknown'` 却给出 `fail` 的，就是 QC 自身的 bug。
 * 正常情况下本规则恒 PASS —— 测试断言它"0 命中"。
 *
 * @param {{blockings?:Array, shot:object, shotState?:object, __audit?:Array}} ctx
 */
export function checkUnknownAsKnown(ctx = {}) {
  const audit = toArr(ctx.__audit);
  const hits = [];
  for (const item of audit) {
    if (!item || item.level !== FAIL) continue;
    if (String(item?.detail?.rel ?? '') !== 'unknown') continue;
    const field = String(item.field ?? '');
    if (!/norm_[xyz]|\.pos$|pos@|position_track/.test(field)) continue;
    hits.push(f(FAIL, 'QC_UNKNOWN_AS_KNOWN', field, '坐标缺失（unknown）不得产出 FAIL（S-25）', {
      rule_id: String(item.rule_id ?? ''), code: String(item.code ?? ''),
    }));
  }
  return found(hits);
}

/**
 * V-04 说话人在画一致性（FAIL）。
 *
 *  · `on_screen` 的说话人必须有站位行且 `in_frame=1`；
 *  · `off_screen` 的说话人若 `in_frame=1` → 矛盾；
 *  · `phone`/`narrator`/`dub` 是画外声源，不强制 `in_frame`（不猜）；
 *  · 无 speakers → 不适用。
 *
 * `shot_assets` 的存在性不在这里判（那是 V-03）。空镜的台词规则是 V-13。
 *
 * @param {{shot:object, blockings?:Array}} ctx
 */
export function checkSpeakers(ctx = {}) {
  const speakers = toArr(ctx.shot?.speakers).filter((s) => s && typeof s === 'object');
  if (!speakers.length) return notApplicable('本镜没有 speakers');
  const rows = toArr(ctx.blockings).filter((b) => b && typeof b === 'object');
  const byChar = new Map(rows.map((b) => [String(b.character_id ?? ''), b]));
  const hits = [];
  speakers.forEach((sp, i) => {
    const id = String(sp.id ?? '');
    const type = String(sp.type ?? '');
    const b = byChar.get(id);
    if (type === 'on_screen') {
      if (!b) {
        hits.push(f(FAIL, 'SPEAKER_BLOCKING_MISSING', `speakers[${i}].id`, 'on_screen 说话人必须有站位行', { speaker_id: id }));
      } else if (Number(b.in_frame) !== 1) {
        hits.push(f(FAIL, 'SPEAKER_NOT_IN_FRAME', `speakers[${i}].id`, 'on_screen 说话人必须 in_frame=1', { speaker_id: id, in_frame: num(b.in_frame) }));
      }
    } else if (type === 'off_screen') {
      if (b && Number(b.in_frame) === 1) {
        hits.push(f(FAIL, 'SPEAKER_INFRAME_CONFLICT', `speakers[${i}].type`, '声明 off_screen 的角色 in_frame 必须为 0', { speaker_id: id, in_frame: 1 }));
      }
    }
  });
  return found(hits);
}

/** 把 `chars.<id>.<field>` 解析成具体值（只用于 V-24 判断"有没有值"） */
export function resolveStatePath(state, path) {
  const parts = String(path ?? '').split('.');
  let cur = state;
  for (const p of parts) {
    if (cur === undefined || cur === null) return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * V-24 类 B 字段有值但 `spec_source='ai'` 且 `rel` 被写成 `known`（WARN）。
 *
 * "AI 生成不得自称确定"（D01-04 §5.2.1）：`ai` 来源的几何/姿态/道具状态，标记只能是
 * `inferred` 或 `unknown`。无 meta → 不适用（没有声明就没有"自称"）。
 *
 * @param {{shot:object, shotState?:object}} ctx
 */
export function checkAiKnown(ctx = {}) {
  const specSource = String(ctx.shot?.spec_source ?? '');
  const meta = toObj(ctx.shotState?.meta);
  const keys = Object.keys(meta).filter((k) => k !== '__solver').sort(cmpStr);
  if (!keys.length) return notApplicable('本镜没有 meta，未声明可靠性');
  if (specSource !== 'ai') return notApplicable(`spec_source=${specSource || '(空)'}，非 AI 生成`);
  const state = toObj(ctx.shotState?.state_out ?? ctx.shotState?.state_in);
  const hits = [];
  for (const k of keys) {
    const entry = toObj(meta[k]);
    if (String(entry.rel ?? '') !== 'known') continue;
    const v = resolveStatePath(state, k);
    if (!isPresent(v)) continue;
    hits.push(f(WARN, 'AI_CLAIMS_KNOWN', `meta.${k}.rel`, 'AI 生成的类 B 字段不得标 known（应为 inferred/unknown）', {
      path: k, rel: 'known', spec_source: 'ai', src: String(entry.src ?? ''),
    }));
  }
  return found(hits);
}

export const RULES = [
  { id: 'S-01', level: 'FAIL', title: '场次基线存在', run: checkBaseline },
  { id: 'S-02', level: 'FAIL', title: '依托物存在', run: checkAnchor },
  { id: 'S-03', level: 'FAIL', title: 'position_abs 与 norm_xyz 一致', run: checkAbsCoord },
  { id: 'S-04', level: 'FAIL', title: '轨迹不穿 fixtures.zone', run: checkTrackZone },
  { id: 'S-16', level: 'WARN', title: '群像开关未裁', run: checkCrowd },
  { id: 'S-17', level: 'WARN', title: '权力几何未变', run: checkPower },
  { id: 'S-24', level: 'FAIL', title: '坐标部分 NULL', run: checkCoordPartial },
  { id: 'S-25', level: 'FAIL', title: '坐标缺失不得当 known（QC 自身）', run: checkUnknownAsKnown },
  { id: 'V-04', level: 'FAIL', title: '说话人在画一致性', run: checkSpeakers },
  { id: 'V-24', level: 'WARN', title: 'AI 生成自称 known', run: checkAiKnown },
];

/** 侧别工具转出：S-05/S-06 与 S-03 共用同一套坐标读法 */
export const axisSideOf = sideOf;
