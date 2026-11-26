// 规范化序列化（D01-06 §4.5）：三种 hash 共用的唯一序列化
//
// 规则逐条对应 §4.5 的表：
//   键排序      对象键按 cmpStr（UTF-16 code unit）输出，禁 localeCompare
//   整数        去小数（4.0 → 4）
//   浮点        保留 6 位并去尾零（0.30000000000004 → 0.3，4.500000 → 4.5）
//   null        null / undefined 统一 null，且**保留键**（省略与 null 语义不同）
//   空集合      [] / {} 保留
//   字符串      NFC 归一 + 去首尾空白，**不去内部空白**（内部空格是台词停顿）
//   有序数组    time_slices / cam_path / position_track 保原序（由调用方直接传数组）
//   无序数组    blockings / actions / assets / scenes 由调用方排序后传入
//   缺失字段    视为 null（加字段不改变旧数据 hash）
//
// 这个函数的输出必须是**字节稳定**的：同语义两次运行、两台机器、两种 locale 都一致。
import { cmpStr } from './cmp-str.js';

/** 数值归一到字符串：整数去小数，浮点保留 6 位去尾零，非有限数当 null */
export function numStr(n) {
  const v = typeof n === 'string' ? Number(n) : n;
  if (v === null || v === undefined || !Number.isFinite(v)) return 'null';
  if (Number.isInteger(v)) return String(v);
  // 先乘再取整再除，消掉浮点尾巴（0.1+0.2 → 0.3）
  return String(Math.round(v * 1e6) / 1e6);
}

/** 字符串归一：NFC + 去首尾空白（内部空白保留） */
export function normStr(s) {
  return String(s).normalize('NFC').trim();
}

function write(v) {
  if (v === null || v === undefined) return 'null';
  const t = typeof v;
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'number') return numStr(v);
  if (t === 'string') return JSON.stringify(normStr(v));
  if (Array.isArray(v)) return '[' + v.map(write).join(',') + ']';
  if (t === 'object') {
    const keys = Object.keys(v).sort(cmpStr);
    return '{' + keys.map((k) => JSON.stringify(normStr(k)) + ':' + write(v[k])).join(',') + '}';
  }
  // 函数 / symbol 等不可序列化类型：当 null（不抛错，避免"某台机器多一个字段就崩"）
  return 'null';
}

/** 规范化序列化为字符串 */
export function canonicalStringify(v) {
  return write(v);
}

/**
 * 白名单取值：只保留 fields 里的键，缺失补 null。
 * 用于"数据库行 → payload"这一步——**永远不要直接 hash 整行**（那会把 id / created_at 带进去）。
 */
export function canonical(row, fields) {
  const out = {};
  for (const f of fields) out[f] = row?.[f] === undefined ? null : row[f];
  return out;
}

/** 数组归一：非数组 → [] */
export function arr(v) {
  return Array.isArray(v) ? v : [];
}

/** 数值归一：null / 非数 → 0（仅用于"语义上 0 与缺失等价"的字段，如时长、t_from） */
export function num(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : 0;
}

/** 可空数值：缺失保留 null（用于"缺失 ≠ 0"的字段，如 norm_z / fov_deg） */
export function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

/**
 * 状态对象规范化（canonState）。
 *
 * 边界（**必须知道**）：函数的职责是"把 undefined 变 null + 递归规范化"，
 * **不负责补齐 D01-02 的完整字段表**——那需要一张阶段 1 不引入的字段清单。
 * 因此"缺字段补 null"只对**输入里出现的键**生效；键序由 canonicalStringify 统一处理。
 * 这条边界已登记在验收报告（R-12），不得对外宣称"canonState 做了完整字段补全"。
 */
export function canonState(state) {
  if (state === null || state === undefined) return null;
  if (typeof state !== 'object') return state;
  const out = {};
  for (const k of Object.keys(state).sort(cmpStr)) {
    const v = state[k];
    out[k] = v === undefined ? null : (v && typeof v === 'object' ? canonState(v) : v);
  }
  return out;
}

/**
 * 可靠性元数据规范化（canonMeta）：按 `chars.<id>.<field>` 展开成一维键值对。
 * 展开后是扁平对象，键序由 canonicalStringify 保证，因此"嵌套写法不同、语义相同"会得到同一 hash。
 */
export function canonMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const flat = {};
  const walk = (prefix, node) => {
    if (node === null || node === undefined || typeof node !== 'object') {
      flat[prefix] = node === undefined ? null : node;
      return;
    }
    for (const k of Object.keys(node)) {
      walk(prefix ? `${prefix}.${k}` : k, node[k]);
    }
  };
  walk('', meta);
  return flat;
}
