// posRel 13 行判定矩阵（D01-04 §5.2.2）—— R-44 与 P4 搬迁回归**共用同一份数据**
//
// 为什么要抽成 fixture：搬迁前后各写一份 13 行，将来必然只改一边。数据只有一份，
// 任何一处改了另一边立刻见红 —— 这才是"搬迁不改行为"的证明方式。
//
// 每行：`n` 序号、`args` 传给 posRel 的参数、`expected` 期望结论、`why` 依据（评审/文档条目）。
export const POS_REL_MATRIX = Object.freeze([
  { n: 1, args: { x: 1.2, y: 3.4, z: 0, specSource: 'manual' }, expected: 'known', why: 'z=0 是合法确定值；manual 来源' },
  { n: 2, args: { x: 1.2, y: 3.4, z: 0, specSource: 'ai' }, expected: 'inferred', why: '坐标完整但来源是 AI' },
  { n: 3, args: { x: 1.2, y: 3.4, z: null, specSource: 'manual' }, expected: 'unknown', why: '第③级：z 缺失，manual 也不能翻案' },
  { n: 4, args: { x: 1.2, y: null, z: 0, specSource: 'manual' }, expected: 'unknown', why: '第③级：y 缺失' },
  { n: 5, args: { x: null, y: null, z: null, specSource: 'manual' }, expected: 'unknown', why: '第③级：三分量全缺' },
  { n: 6, args: { x: 1.2, y: 3.4, z: NaN, specSource: 'manual' }, expected: 'unknown', why: '第③级：非有限数' },
  { n: 7, args: { x: 1.2, y: 3.4, z: 0, metaEntry: { rel: 'known' }, specSource: 'ai' }, expected: 'known', why: '第④级：显式 known 且坐标完整' },
  { n: 8, args: { x: 1.2, y: 3.4, z: null, metaEntry: { rel: 'known' }, specSource: 'manual' }, expected: 'unknown', why: '显式 known 不能覆盖坐标缺失' },
  { n: 9, args: { x: 1.2, y: 3.4, z: 0, metaEntry: { rel: 'inferred' }, specSource: 'manual' }, expected: 'inferred', why: '第④级：显式 inferred 优先于 manual' },
  { n: 10, args: { x: 1.2, y: 3.4, z: 0, metaEntry: { rel: 'unknown' }, specSource: 'manual' }, expected: 'unknown', why: '第②级：显式 unknown 最高优先' },
  { n: 11, args: { x: null, y: null, z: null, metaEntry: { rel: 'not_applicable' }, specSource: 'ai' }, expected: 'not_applicable', why: '第①级：not_applicable 先于缺失检查' },
  { n: 12, args: { x: 1.2, y: 3.4, z: 0, metaEntry: { rel: 'not_applicable' }, specSource: 'manual' }, expected: 'not_applicable', why: '第①级：即使有值也返回 not_applicable' },
  { n: 13, args: { x: 1.2, y: 3.4, z: 0, specSource: 'legacy' }, expected: 'unknown', why: '第⑤级：legacy 来源按 unknown' },
]);

/** `posRelDetail` 的两种矛盾告警（R-44 末两行） */
export const POS_REL_WARNING_CASES = Object.freeze([
  {
    args: { x: 1.2, y: 3.4, z: 0, metaEntry: { rel: 'not_applicable' } },
    expectedWarnings: ['COORD_NA_WITH_VALUE'],
    why: '标了"不适用"却给了完整坐标',
  },
  {
    args: { x: 1.2, y: 3.4, z: null, metaEntry: { rel: 'known' } },
    expectedWarnings: ['META_VALUE_MISMATCH'],
    why: '标了"确定"却没有 z',
  },
]);
