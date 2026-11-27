// 动作时间分析（P6 · D02-06 §7.12 / D01-03 §5.6）
//
// **唯一实现仍在 `validate/action.js`**：P5 已按 §7.12 的口径写完，P6 只把它转出给连续性侧使用，
// 不复制第二份。复制一份的后果是"同一条时间口径两处实现"，改一处忘一处必然分叉
// （P4 的 `posRel` 就是这么处理的：`hash/pos-rel.js` 转出 `continuity/pos-rel.js`）。
//
// 口径复述（改实现前先读这一条）：
//   · `spanRequired` = 所有动作 `t_to` 的最大值 —— **不是**并集长度，它回答"这镜至少要多长"；
//   · `unionMax` = **按人分组、组内区间并集**后的最大长度 —— 回答"谁最忙"；跨人**不相加**；
//   · 左右手可并行，同部位重叠才算冲突（`ACTION_PART_CONFLICT`）；
//   · 入口量化到 0.001，严格比较，**不设 EPS**（浮点容差会让边界算例两边都对）。
export {
  analyzeActionTime,
  speechMetrics,
  dialogueSpans,
} from '../validate/action.js';
