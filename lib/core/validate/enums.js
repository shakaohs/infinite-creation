// D01 冻结枚举表（P4）—— D01-02 §4 / §6.1 / §10、D01-03 §3.5 §3.7、D01-04 §3.3 §4 §5.2 §10
//
// 三条不许越界：
//   ① **逐字来自 D01**。不新增、不改名、不删减、不"顺手补一个看起来该有的值"。
//      `cam_height` 里没有 `dutch`（V2 已把它移到 `cam_roll_deg`），不要因为"荷兰角也是机位"又加回来。
//   ② **结构化字段不能当字符串枚举**。`facing` 是"四方位 + 角度"、`occlusion` 是
//      `none|half|full|partial(部位)` —— 用字符串集合去卡它们，会把合法值判死、把非法值放行。
//   ③ **纯函数**：不读库、不读时钟、不看 `process.env`、不改入参；输出顺序确定（`cmpStr` 排序）。
//
// 结果约定（与 D02-06 §8.2 的 hit 结构一致）：`{ level, code, field, expected }`
//   `ENUM_INVALID`           值不在 D01 表里
//   `ENUM_REQUIRED_MISSING`  必填枚举缺失（可选枚举缺失不算）
//   `ENUM_TYPE_INVALID`      类型不对（对象/数组塞进了字符串枚举）
//   `ENUM_FIELD_UNKNOWN`     调用方问了一个本表没有的字段（调用方 bug，不是数据 bug）
import { cmpStr } from '../hash/cmp-str.js';

/** 结果级别：枚举非法是 FAIL（D01-02 §十三 V-02） */
const FAIL = 'fail';

/**
 * 扁平枚举表：`field -> { values, allowEmpty, source }`
 * `allowEmpty` = D01 允许该字段为空（默认 `''`）或未给。
 */
export const ENUMS = Object.freeze({
  // ── D01-02 §二 B 区 ───────────────────────────────────────────────────
  purpose: {
    values: ['establish', 'advance', 'react', 'reveal', 'turn', 'close', 'insert'],
    allowEmpty: false,
    source: 'D01-02 §二',
  },
  dialogue_function: {
    values: ['inform', 'persuade', 'probe', 'threaten', 'confess', 'deflect', 'none'],
    allowEmpty: true, // D01-02 §二：默认 `''`
    source: 'D01-02 §二',
  },
  // ── D01-02 §4 摄影四轴 ────────────────────────────────────────────────
  shot_size: {
    values: ['extreme_wide', 'wide', 'full', 'medium_full', 'medium', 'medium_close', 'close', 'close_up', 'extreme_close'],
    allowEmpty: false,
    ordered: true, // 9 档有序（相邻档判定要用序位）
    source: 'D01-02 §4.1',
  },
  cam_direction: {
    values: ['front', 'three_quarter', 'profile', 'over_shoulder', 'pov'],
    allowEmpty: false,
    source: 'D01-02 §4.2',
  },
  cam_height: {
    // 8 值。**没有 dutch**：荷兰角是绕光轴的 roll，用 cam_roll_deg 表达（D01-02 §4.3 修订说明）
    values: ['eye', 'slight_low', 'slight_high', 'low', 'high', 'extreme_low', 'extreme_high', 'bird_eye'],
    allowEmpty: false,
    forbidden: ['dutch'],
    source: 'D01-02 §4.3',
  },
  movement: {
    // D01-02 §4.4 标题写"21 值"，但该表逐个点数是 **22**：静止 1 + 平移 6 + 纵深 6 + 变焦 4 + 手持 3 + 特殊 2。
    // 这里**按逐项列出的值走**（22 个）：少写一个就是"合法运镜被拒"，比标题笔误严重得多。
    values: [
      'static',
      'pan_left', 'pan_right', 'truck_left', 'truck_right', 'pedestal_up', 'pedestal_down',
      'dolly_in', 'dolly_out', 'tracking', 'crane', 'arc', 'jib',
      'zoom_in', 'zoom_out', 'snap_zoom', 'dolly_zoom',
      'handheld_light', 'handheld', 'handheld_shaky',
      'snorricam', 'long_take',
    ],
    allowEmpty: false, // 默认 static
    source: 'D01-02 §4.4',
  },
  movement_amp: {
    values: ['none', 'micro', 'normal', 'large'],
    allowEmpty: false,
    source: 'D01-02 §四 D11',
  },
  composition_rule: {
    values: ['center', 'rule_of_thirds', 'symmetry', 'frame_in_frame', 'foreground_occlusion', 'negative_space', 'diagonal'],
    allowEmpty: true, // D01-02 §四 D13：默认 `''`
    source: 'D01-02 §4.5',
  },
  // ── D01-02 §6.1 说话人 ───────────────────────────────────────────────
  'speakers.type': {
    values: ['on_screen', 'off_screen', 'phone', 'narrator', 'dub'],
    allowEmpty: false,
    source: 'D01-02 §6.1',
  },
  // ── D01-02 §10 时间 ──────────────────────────────────────────────────
  speed_ramp: {
    values: ['none', 'slow_in', 'slow_out', 'hold', 'ramp'],
    allowEmpty: true, // 默认 none；未给按默认
    source: 'D01-02 §十',
  },
  'time_slices.kind': {
    values: ['action', 'hold', 'dialogue'],
    allowEmpty: false,
    source: 'D01-02 §十',
  },
  // ── D01-03 动作 ──────────────────────────────────────────────────────
  action_type: {
    values: ['locomotion', 'manipulation', 'combat', 'expression', 'reaction', 'environment'],
    allowEmpty: false,
    source: 'D01-03 §三',
  },
  tier: {
    values: ['T1', 'T2', 'T3'],
    allowEmpty: false,
    source: 'D01-03 §三',
  },
  cog: {
    values: ['stable', 'forward', 'backward', 'lower', 'rise', 'shift_left', 'shift_right'],
    allowEmpty: false,
    source: 'D01-03 §三',
  },
  'speed.profile': {
    values: ['constant', 'accelerate', 'decelerate', 'sudden', 'hold'],
    allowEmpty: false,
    source: 'D01-03 §3.5',
  },
  'contact.impulse': {
    values: ['light', 'medium', 'heavy'],
    allowEmpty: false,
    source: 'D01-03 §3.7',
  },
  // ── D01-04 §四 站位 ──────────────────────────────────────────────────
  posture: {
    values: ['standing', 'sitting', 'sitting_supported', 'crouch', 'kneel', 'lying', 'lean', 'walking'],
    allowEmpty: false,
    source: 'D01-04 §四',
  },
  power_level: {
    values: ['high', 'mid', 'low'],
    allowEmpty: false,
    source: 'D01-04 §四',
  },
  // ── D01-04 §3.3 / §5.2 / §10 ─────────────────────────────────────────
  'cross_allowed.type': {
    values: ['neutral_insert', 'character_cross', 'pov_switch', 'scene_turn', 'deliberate'],
    allowEmpty: false,
    source: 'D01-04 §3.3',
  },
  crowd_switch: {
    values: ['A', 'B', 'C'],
    allowEmpty: true, // 场次级可选；空 = 未声明群像
    source: 'D01-04 §三',
  },
  'prop.state': {
    // `absent` 是"键不存在"，不是可取的值（D01-04 §十）
    values: ['held', 'placed', 'dropped', 'consumed', 'broken', 'fixed'],
    allowEmpty: false,
    source: 'D01-04 §十',
  },
  'state.rel': {
    values: ['known', 'inferred', 'unknown', 'not_applicable'],
    allowEmpty: false,
    source: 'D01-04 §5.2',
  },
  // ── shot_assets（D01-05 §4.6，与 P3 的 SHOT_ASSET_ROLES 同源）────────
  'asset.role': {
    values: ['character', 'scene', 'prop', 'costume', 'age', 'voice'],
    allowEmpty: false,
    source: 'D01-05 §4.6',
  },
});

/** 结构化的两项（不能当字符串集合）：`facing` 四方位 + 角度、`occlusion` 含 `partial(部位)` */
export const STRUCTURED = Object.freeze({
  facing: {
    code: 'FACING',
    directions: ['N', 'S', 'E', 'W'],
    source: 'D01-04 §四（`N`/`S`/`E`/`W` + 角度）',
  },
  occlusion: {
    code: 'OCCLUSION',
    kinds: ['none', 'half', 'full'],
    partial: 'partial',
    source: 'D01-04 §四（`none`/`partial(部位)`/`half`/`full`）',
  },
});

/** 全部可检查字段名（`cmpStr` 排序，含结构化两项） */
export function fieldNames() {
  return [...Object.keys(ENUMS), ...Object.keys(STRUCTURED)].sort(cmpStr);
}

function hit(level, code, field, expected, detail = {}) {
  return { level, code, field, expected, ...detail };
}

/** 是否为空值（`undefined` / `null` / `''`）。数组、对象不算空——它们会走类型检查。 */
function isEmpty(v) {
  return v === undefined || v === null || v === '';
}

/**
 * `facing` 校验：四方位 + 可选角度。
 *
 * D01 只规定"`N`/`S`/`E`/`W` + 角度"，没规定分隔符。本实现接受三种等价写法（都表达同一件事）：
 *   `'N'`、`'N+30'` / `'N-45'`、`{ dir: 'N', deg: 30 }`
 * 角度限定 `-180 ~ +180`（超过一个平角就不是"朝向偏差"而是另一个方位了）。
 */
function checkFacing(value) {
  const dirs = STRUCTURED.facing.directions;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    if (!dirs.includes(value.dir)) return { ok: false, got: value.dir };
    if (value.deg === undefined || value.deg === null) return { ok: true };
    if (typeof value.deg !== 'number' || !Number.isFinite(value.deg) || Math.abs(value.deg) > 180) {
      return { ok: false, got: value.deg };
    }
    return { ok: true };
  }
  if (typeof value !== 'string') return { ok: false, got: value };
  const m = /^([NSEW])(?:([+-])(\d{1,3}))?$/.exec(value.trim());
  if (!m) return { ok: false, got: value };
  if (!m[2]) return { ok: true };
  const deg = Number(m[3]);
  if (!(deg <= 180)) return { ok: false, got: value };
  return { ok: true };
}

/**
 * `occlusion` 校验：`none` / `half` / `full` / `partial(部位)`。
 * 部位写法接受 `'partial:arm'`、`'partial(arm)'`、`{ type:'partial', part:'arm' }`。
 * 裸 `'partial'` 不合法——"部分遮挡"必须说清哪一部分，否则 S-15 取景半径无法算。
 */
function checkOcclusion(value) {
  const { kinds, partial } = STRUCTURED.occlusion;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    if (value.type === partial) return { ok: !!String(value.part ?? '').trim(), got: value };
    return { ok: kinds.includes(value.type), got: value.type };
  }
  if (typeof value !== 'string') return { ok: false, got: value };
  const s = value.trim();
  if (kinds.includes(s)) return { ok: true };
  const m = /^partial\s*[:：(（]\s*(.+?)\s*[)）]?$/.exec(s);
  if (m && m[1] && m[1] !== partial) return { ok: true };
  return { ok: false, got: value };
}

/**
 * 检查单个枚举字段（V-02 的唯一入口）。
 *
 * @param {string} field 字段名，如 `shot_size`、`speed.profile`、`speakers.type`
 * @param {*} value 待检值（`''`/`null`/`undefined` 按该字段是否允许为空处理）
 * @returns {Array<{level:string, code:string, field:string, expected:string, got?:*}>}
 *   0 条 = 通过；1 条 = 不通过。顺序确定（单条，无需排序）。
 *
 * 边界：
 *  · 字段不在表内 → `ENUM_FIELD_UNKNOWN`（调用方 bug，不静默通过）
 *  · 允许为空的字段收到 `''`/`null`/`undefined` → 通过
 *  · 必填字段收到空值 → `ENUM_REQUIRED_MISSING`
 *  · 字符串枚举收到数组/对象 → `ENUM_TYPE_INVALID`（不是"值不合法"，避免误导调用方去改数据）
 */
export function check(field, value) {
  const key = String(field ?? '');
  if (Object.prototype.hasOwnProperty.call(STRUCTURED, key)) {
    const isFacing = key === 'facing';
    const r = isFacing ? checkFacing(value) : checkOcclusion(value);
    if (r.ok) return [];
    const expected = isFacing
      ? 'N|S|E|W 或 N+30 / N-45 / {dir,deg}（deg 在 -180~180）'
      : 'none|half|full|partial(部位) 或 partial:部位 / {type:"partial",part}';
    return [hit(FAIL, 'ENUM_INVALID', key, expected, { got: r.got })];
  }

  const spec = ENUMS[key];
  if (!spec) {
    return [hit(FAIL, 'ENUM_FIELD_UNKNOWN', key, fieldNames().join('|'), { got: value })];
  }
  if (isEmpty(value)) {
    return spec.allowEmpty ? [] : [hit(FAIL, 'ENUM_REQUIRED_MISSING', key, spec.values.join('|'))];
  }
  if (typeof value !== 'string') {
    return [hit(FAIL, 'ENUM_TYPE_INVALID', key, spec.values.join('|'), { got: value })];
  }
  const v = value.trim();
  if (!spec.values.includes(v)) {
    return [hit(FAIL, 'ENUM_INVALID', key, spec.values.join('|'), { got: value })];
  }
  return [];
}

/** 布尔便捷入口：只关心"合不合法"时用它 */
export function isValid(field, value) {
  return check(field, value).length === 0;
}

/**
 * 批量检查一个对象上的枚举字段（按 `fieldNames()` 顺序，结果顺序稳定）。
 * 只检查对象上**出现过**的字段：没给的可选字段不该被报"缺失"（必填由 schema.js 的 S 级管）。
 *
 * @param {object} obj 形如 `{ shot_size:'close', movement:'static' }`；嵌套字段用扁平键（`'speed.profile'`）
 * @returns {Array<object>} hits（0 条 = 全通过）
 */
export function checkObject(obj) {
  if (!obj || typeof obj !== 'object') return [];
  const out = [];
  for (const field of fieldNames()) {
    if (!Object.prototype.hasOwnProperty.call(obj, field)) continue;
    out.push(...check(field, obj[field]));
  }
  return out;
}
