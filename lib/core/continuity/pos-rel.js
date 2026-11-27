// 站位可靠性判定（D01-04 §5.2.2 / §5.2.1）—— P4 从 `hash/source-spec-hash.js` **原样搬迁**
//
// 为什么单独成文件：这个判定不只服务 Hash。求解器（P6）、QC（P5/P9）、写入侧（P8）都要用同一份
// 五级优先级。放在 hash 目录下，别的模块要么反向依赖 hash（不该），要么复制一份（就会出现两个版本）。
// 搬迁只搬位置，不改逻辑——`hash/source-spec-hash.js` 从这里导入并原样再导出，旧导入路径全部继续可用。
//
// 三条不许越界：
//   ① **顺序不可调换**：`not_applicable` 先于缺失检查（D01-04 §5.2.2）。
//   ② **坐标缺失不得被显式 `known` 翻案**：`x/y/z` 任一缺失或非有限数 → `unknown`。
//   ③ **`z = 0` 是合法确定值**：只判 `== null` 与 `Number.isFinite`，不做真值判断（`!z` 会把 0 当缺失）。

/**
 * 可靠性判定（五级优先级，顺序不可调换）。
 *
 * @param {{x?:number|null, y?:number|null, z?:number|null,
 *          metaEntry?:{rel?:string}, specSource?:string}} [p]
 * @returns {'not_applicable'|'unknown'|'known'|'inferred'}
 *
 * ① 显式 `not_applicable` → 原样返回（**先于**缺失检查）
 * ② 显式 `unknown` → `unknown`
 * ③ 三分量任一缺失 / 非有限数 → `unknown`（显式 `known` 也不能翻案）
 * ④ 坐标完整时采信显式 `known` / `inferred`
 * ⑤ 无 Meta → 按来源：`manual`→`known`、`legacy`→`unknown`、其他→`inferred`
 */
export function posRel({ x, y, z, metaEntry, specSource } = {}) {
  const explicit = metaEntry?.rel;
  if (explicit === 'not_applicable') return 'not_applicable';
  if (explicit === 'unknown') return 'unknown';
  if (x == null || y == null || z == null) return 'unknown';
  if (![x, y, z].every(Number.isFinite)) return 'unknown';
  if (explicit === 'known' || explicit === 'inferred') return explicit;
  if (specSource === 'manual') return 'known';
  if (specSource === 'legacy') return 'unknown';
  return 'inferred';
}

/**
 * 同 `posRel`，额外回报矛盾告警。
 *
 * @param {{x?:number|null, y?:number|null, z?:number|null,
 *          metaEntry?:{rel?:string}, specSource?:string}} [p]
 * @returns {{rel:string, warnings:string[]}}
 *   `COORD_NA_WITH_VALUE`：Meta 标 `not_applicable`，但三维坐标完整（标了"不适用"却给了值）
 *   `META_VALUE_MISMATCH`：Meta 标 `known`，但坐标不完整（标了"确定"却没有值）
 */
export function posRelDetail({ x, y, z, metaEntry, specSource } = {}) {
  const rel = posRel({ x, y, z, metaEntry, specSource });
  const warnings = [];
  const full = x != null && y != null && z != null && [x, y, z].every(Number.isFinite);
  if (metaEntry?.rel === 'not_applicable' && full) warnings.push('COORD_NA_WITH_VALUE');
  if (metaEntry?.rel === 'known' && !full) warnings.push('META_VALUE_MISMATCH');
  return { rel, warnings };
}
