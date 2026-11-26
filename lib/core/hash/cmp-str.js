// 字符串比较：按 UTF-16 code unit 逐位比较（ECMA-262 定义的字符串关系运算）
//
// 为什么不能用 localeCompare（D01-06 §4.5.0）：
//   localeCompare 在不传 locale 时用宿主默认区域，同一份数据两台机器可能排出两种顺序：
//     "i" vs "I"、ä vs z（sv-SE 把 ä 排第 27 位）、ı vs i（tr-TR）
//   只要有一个非 ASCII 字符（scene_key 可能是 "S02_病房"），hash 就可能两边不同，
//   而 sourceSpecHash 的全部意义就是"在任何机器上算出同一个值"。
//
// 本文件是 hash 路径上唯一的字符串比较入口；`git grep localeCompare lib/core/hash/` 必须为 0。
export function cmpStr(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  return x < y ? -1 : x > y ? 1 : 0;
}

/** 稳定排序辅助：按 cmpStr 比较某个取键函数 */
export function sortBy(list, keyOf) {
  return list.slice().sort((p, q) => cmpStr(keyOf(p), keyOf(q)));
}
