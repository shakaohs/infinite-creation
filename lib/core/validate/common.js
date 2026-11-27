// P5 共用工具：**只放被两个以上规则模块用到的搬运/比较，不放任何规则判定**
//
// 为什么单独一层：`asset.js` / `camera.js` / `action.js` / `blocking.js` / `continuity.js`
// 都要读"JSON 列可能是字符串"的行、都要判"点是否在 zone 内"、都要按 `cmpStr` 排序。
// 各写一份的后果不是代码重复，是**同一件事出现两种口径**（例如一处把 `null` 当 0、另一处当缺失）。
//
// 边界：纯函数，不读库/时钟/环境变量，不改入参。
import { cmpStr } from '../hash/cmp-str.js';
import {
  arr as arrRaw, num as numRaw, numOrNull as numOrNullRaw, canonicalStringify,
} from '../hash/canonical-stringify.js';

export const FAIL = 'fail';
export const WARN = 'warn';
export const INFO = 'info';
export const PASS = 'pass';

/** 等级强弱：`fail > warn > info > pass > ''`（`''` = 不适用，不参与聚合） */
export const LEVEL_ORDER = Object.freeze({ fail: 3, warn: 2, info: 1, pass: 0, '': -1 });

/** 时间量子（D01-06 §3.3.1）：入口量化一次，之后严格比较，**不设 EPS** */
export const TQ = 0.001;
// 用 `×1000 / 1000` 而不是 `÷TQ × TQ`：后者回乘会产生 1.4000000000000001 这类尾巴，
// 一旦进了 detail 就会让"同输入逐字一致"的断言在跨平台时变得脆（JS 浮点乘除不对称）。
export const quant = (x) => Math.round(Number(x) * 1000) / 1000;

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const isBlank = (v) => v === undefined || v === null || v === '';

/** 值的"存在性"：`0` / `false` 是存在的值，`''`/`[]`/`{}`/`null` 不是 */
export function isPresent(v) {
  if (v === undefined || v === null || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

/** 数组字段归一（`story_shots.speakers` 这类 TEXT 列可能是 `'[]'`） */
export function toArr(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return arrRaw(v);
  try {
    const x = JSON.parse(v);
    return Array.isArray(x) ? x : [];
  } catch { return []; }
}

/** 对象字段归一（`path_json` / `contact_json` 等同理） */
export function toObj(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return {};
  try {
    const x = JSON.parse(v);
    return x && typeof x === 'object' && !Array.isArray(x) ? x : {};
  } catch { return {}; }
}

export const num = numRaw;
export const numOrNull = numOrNullRaw;

/** 确定性深比较（键序无关）；用于 `power_geometry.start/end` 这类"有没有变"的判断 */
export function deepEqual(a, b) {
  return canonicalStringify(a) === canonicalStringify(b);
}

/**
 * 读 Meta 里某字段路径的可靠性（D01-04 §5.2）。
 * 缺省返回 `undefined` —— **不要在这里补 `'known'`**：缺省怎么解释取决于字段类别
 * （类 A 缺省 known / 类 B 缺省 unknown，见 D01-04 §5.2.1），那是调用方的事。
 */
export function relOf(meta, path) {
  const m = meta && typeof meta === 'object' ? meta[path] : null;
  const rel = m && typeof m === 'object' ? m.rel : undefined;
  return typeof rel === 'string' ? rel : undefined;
}

/** 坐标三元组：接受 `[x,y,z]` / `{x,y,z}`；`complete` 表示三分量都是有限数 */
export function posOf(v) {
  if (Array.isArray(v)) {
    const [x, y, z] = v;
    return { x: numOrNull(x), y: numOrNull(y), z: numOrNull(z), complete: [x, y, z].every(isNum) };
  }
  if (v && typeof v === 'object') {
    const { x, y, z } = v;
    return { x: numOrNull(x), y: numOrNull(y), z: numOrNull(z), complete: [x, y, z].every(isNum) };
  }
  return { x: null, y: null, z: null, complete: false };
}

export function dist2(a, b) {
  if (!a || !b || !isNum(a.x) || !isNum(a.y) || !isNum(b.x) || !isNum(b.y)) return null;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function dist3(a, b) {
  if (!a || !b || !a.complete || !b.complete) return null;
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
}

/** `fixtures[].zone` 是 `[x1,y1,x2,y2]`；返回规范化矩形（x1<x2、y1<y2），不合法 → null */
export function rectOf(zone) {
  if (!Array.isArray(zone) || zone.length !== 4) return null;
  if (!zone.every(isNum)) return null;
  const [x1, y1, x2, y2] = zone;
  return { x1: Math.min(x1, x2), y1: Math.min(y1, y2), x2: Math.max(x1, x2), y2: Math.max(y1, y2) };
}

export function inRect(pt, rect, pad = 0) {
  if (!pt || !rect || !isNum(pt.x) || !isNum(pt.y)) return false;
  return pt.x >= rect.x1 - pad && pt.x <= rect.x2 + pad && pt.y >= rect.y1 - pad && pt.y <= rect.y2 + pad;
}

/** 线段与轴对齐矩形是否相交（Liang–Barsky 裁剪；退化线段按点处理） */
export function segHitsRect(p, q, rect) {
  if (!rect || !p || !q) return false;
  if (!isNum(p.x) || !isNum(p.y) || !isNum(q.x) || !isNum(q.y)) return false;
  if (p.x === q.x && p.y === q.y) return inRect(p, rect);
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  let t0 = 0;
  let t1 = 1;
  const clip = (p0, d, lo, hi) => {
    if (d === 0) return p0 >= lo && p0 <= hi;
    let a = (lo - p0) / d;
    let b = (hi - p0) / d;
    if (a > b) { const t = a; a = b; b = t; }
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    return t0 <= t1;
  };
  if (!clip(p.x, dx, rect.x1, rect.x2)) return false;
  if (!clip(p.y, dy, rect.y1, rect.y2)) return false;
  return t0 <= t1;
}

/** 场次的 fixtures（数组，容错 JSON 串） */
export function fixturesOf(sceneState) {
  return toArr(sceneState?.fixtures).filter((fx) => fx && typeof fx === 'object');
}

/**
 * 场次的实际尺寸（米制 ↔ 归一化的唯一换算来源，D01-04 §3.1）。
 *
 * 两种合法写法都收：`{width_m,height_m}`（D01-04 §3.1 的对象式）与 `[w,h,d]`（D01-02 §4.6 的数组式）。
 * 缺一个都返回 `null` —— **不猜默认尺寸**：用 3.2×4.0 去换算 6×5 的场次，算出来的距离全是错的。
 */
export function activeAreaOf(sceneState) {
  const cs = toObj(sceneState?.coord_system);
  const raw = cs.active_area;
  if (Array.isArray(raw)) {
    const [w, h, d] = raw;
    if (isNum(w) && isNum(h) && w > 0 && h > 0) {
      return { width_m: w, height_m: h, depth_m: isNum(d) ? d : null, label: '' };
    }
    return null;
  }
  const aa = toObj(raw);
  const w = numOrNull(aa.width_m);
  const h = numOrNull(aa.height_m);
  if (isNum(w) && isNum(h) && w > 0 && h > 0) {
    return { width_m: w, height_m: h, depth_m: numOrNull(aa.depth_m), label: String(aa.label ?? '') };
  }
  return null;
}

/** 场次轴线（`axis_line` 两点） */
export function axisLineOf(sceneState) {
  const lock = toObj(sceneState?.axis_lock);
  const line = toArr(lock.axis_line);
  if (line.length !== 2) return null;
  const a = posOf(line[0]);
  const b = posOf(line[1]);
  if (!isNum(a.x) || !isNum(a.y) || !isNum(b.x) || !isNum(b.y)) return null;
  if (a.x === b.x && a.y === b.y) return null;
  return { a, b, lock };
}

/**
 * 点相对有向直线的侧别：`+1` / `-1` / `0`（在线上）。
 * `axis_line` 是归一化平面上的两点，叉积符号稳定（无浮点阈值，除 0 值外不判"接近"）。
 */
export function sideOf(line, pt) {
  if (!line || !pt || !isNum(pt.x) || !isNum(pt.y)) return 0;
  const cross = (line.b.x - line.a.x) * (pt.y - line.a.y) - (line.b.y - line.a.y) * (pt.x - line.a.x);
  if (cross > 0) return 1;
  if (cross < 0) return -1;
  return 0;
}

/** 命中条目（规则内部返回；聚合层再合并成"每条规则一条"） */
export function f(level, code, field, expected, detail = {}) {
  return { level, code, field: String(field ?? ''), expected: String(expected ?? ''), detail };
}

/** 规则结果：`{ applicable, findings[] }` */
export function found(findings = []) {
  return { applicable: true, findings };
}

/** 规则不适用（`level=''`，不进任何统计） */
export function notApplicable(reason) {
  return { applicable: false, reason: String(reason ?? '') };
}

/** 规则适用但无命中（= PASS） */
export function pass() {
  return { applicable: true, findings: [] };
}

/**
 * 数据不足：**适用但不可验证** —— 计入 U（分母），不是 PASS、也不是 FAIL（D02-06 §8.5.2）。
 * `code` 必须是 §8.5.2「数据不足」那张表里的码之一。
 */
export function insufficient(code, field, expected, detail = {}) {
  return found([f(INFO, code, field, expected, detail)]);
}

/** 取最严重的一条（level 优先，其次按 `field`/`code` 的 `cmpStr`，保证确定性） */
export function worstFinding(findings) {
  if (!findings || !findings.length) return null;
  return findings.slice().sort((a, b) => (
    (LEVEL_ORDER[b.level] ?? -1) - (LEVEL_ORDER[a.level] ?? -1)
    || cmpStr(a.field, b.field)
    || cmpStr(a.code, b.code)
  ))[0];
}

/** 去重 + `cmpStr` 排序（`fields[]` 的唯一合法顺序） */
export function sortedUnique(list) {
  const out = [];
  for (const x of list) {
    const s = String(x ?? '');
    if (s && !out.includes(s)) out.push(s);
  }
  return out.sort(cmpStr);
}
