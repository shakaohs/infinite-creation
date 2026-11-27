// P9-D：自动门禁（D02-21 §八）
//
// 口径只有一条：**默认放行，`fail` 才暂停**。
//  · `warn` / `info` / `pass` 都不阻断 —— 把警告当阻断，等于让人习惯性点"继续"，门禁就废了；
//  · `fail` 必须暂停，且暂停理由要能指到"哪一镜、哪条规则、哪个字段"，否则修不了；
//  · 判据是**报告级 level 与报告内 fail 条目**，不是某一条规则的结果 ——
//    "只看单条规则"会漏掉别的规则 fail，也会把不适用（`applicable:false`）当成失败。
//
// 不落库：`qc_reports` 没有门禁列（D02-21 §十一 U-P9-3），门禁结论随返回值与报告 `hits` 一起
// 可追溯。新增门禁表属于结构变更，未经批准不做。
import { LEVEL_ORDER } from '../validate/common.js';
import { cmpStr } from '../hash/cmp-str.js';

export const GATE_PASS = 'pass';
export const GATE_PAUSE = 'pause';

/** 阻断档位：只有 `fail`（D01-04 §8 已冻结的档位，不得改动） */
export const BLOCKING_LEVEL = 'fail';

function worstLevel(levels) {
  let worst = '';
  for (const lv of levels) {
    if ((LEVEL_ORDER[lv] ?? -1) > (LEVEL_ORDER[worst] ?? -1)) worst = lv;
  }
  return worst;
}

/**
 * 由一组报告得出门禁结论。
 *
 * @param {Array<{target_id:string, level:string, hits:Array}>} reports 本场全部镜的报告（已落库或待落库均可）
 * @returns {{decision:'pass'|'pause', level:string, blocking:Array<object>,
 *            counts:{reports:number, fail:number, warn:number, pass:number, info:number}, reasons:string[]}}
 */
export function gateOf(reports = []) {
  const list = (Array.isArray(reports) ? reports : []).filter((r) => r && typeof r === 'object');
  if (!list.length) {
    // 没有报告就没有结论。**不能**默认放行：那等于"什么都没检查"记成"检查通过"。
    return {
      decision: GATE_PAUSE,
      level: '',
      blocking: [],
      counts: { reports: 0, fail: 0, warn: 0, pass: 0, info: 0 },
      reasons: ['QC_REPORT_MISSING：本场没有任何报告，无法判定（不得默认放行）'],
    };
  }

  const blocking = [];
  const counts = { reports: list.length, fail: 0, warn: 0, pass: 0, info: 0 };
  for (const r of list) {
    const hits = Array.isArray(r.hits) ? r.hits : [];
    for (const h of hits) {
      // `applicable:false` 是"判不了"，不是"没过"；`__` 前缀是元数据，不是规则结论
      if (!h || h.applicable !== true) continue;
      if (String(h.rule_id ?? '').startsWith('__')) continue;
      if (h.level === BLOCKING_LEVEL) {
        blocking.push({
          shot_id: String(r.target_id ?? ''),
          rule_id: String(h.rule_id ?? ''),
          code: String(h.code ?? ''),
          field: String(h.field ?? ''),
          fields: Array.isArray(h.fields) ? h.fields : [],
          expected: String(h.expected ?? ''),
          source: String(h.source ?? ''),
        });
      }
    }
    const lv = String(r.level ?? '');
    if (lv === 'fail' || lv === 'warn' || lv === 'pass' || lv === 'info') counts[lv] += 1;
  }

  blocking.sort((a, b) => cmpStr(a.shot_id, b.shot_id) || cmpStr(a.rule_id, b.rule_id) || cmpStr(a.field, b.field));
  const level = worstLevel(list.map((r) => String(r.level ?? '')));
  const decision = blocking.length || level === BLOCKING_LEVEL ? GATE_PAUSE : GATE_PASS;

  const reasons = [];
  if (decision === GATE_PAUSE) {
    for (const b of blocking) {
      reasons.push(`${b.rule_id} 在镜头 ${b.shot_id}（字段 ${b.field || '-'}，码 ${b.code}）判为 fail`);
    }
    if (!blocking.length) reasons.push(`报告级 level=fail 但未定位到具体条目（异常状态，需人工核对）`);
  } else {
    reasons.push(`报告级最高档位 ${level || '(空)'}，未达阻断条件 ${BLOCKING_LEVEL}`);
  }

  return { decision, level, blocking, counts, reasons };
}
