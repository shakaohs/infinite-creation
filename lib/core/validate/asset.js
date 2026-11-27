// 资产引用规则（P5）—— V-03 / V-23 / V-25 / V-26
//
// 一句话边界：`shot_assets` 是"镜头用了哪些资产"的**唯一权威**；`story_shots.voice_ids`
// 是它的派生列。所以本模块做的是"引用对不对"和"派生列有没有被绕过"，不判断资产内容好不好。
//
// 纯函数：资产数据由调用方通过 `ctx.assetsById` 给（`id -> {id,category,name,parent_id}`），
// 本模块不读库，也不猜"没查到的资产可能是对的"——查不到就是悬空引用（FAIL）。
import { cmpStr } from '../hash/cmp-str.js';
import {
  FAIL, f, found, notApplicable, pass, toArr, num, isBlank,
} from './common.js';

/** 允许写进 `shot_assets` 的 role（与 `enums.ENUMS['asset.role']` 同源，D01-05 §4.6） */
export const SHOT_ASSET_ROLES = Object.freeze(['character', 'scene', 'prop', 'costume', 'age', 'voice']);

/** voice 槽位上限：编译产物只有 `Audio 1/2/3`（D01-02 V-26） */
export const VOICE_LIMIT = 3;

/** 按 role 分组（`cmpStr` 排序，保证遍历顺序确定） */
function byRole(rows) {
  const map = new Map();
  for (const r of rows) {
    const role = String(r?.role ?? '');
    if (!map.has(role)) map.set(role, []);
    map.get(role).push(r);
  }
  return new Map([...map.entries()].sort((a, b) => cmpStr(a[0], b[0])));
}

/** 资产表查询：接受 `Map` 或普通对象；查不到返回 `undefined` */
function lookup(assetsById, id) {
  if (!assetsById) return undefined;
  if (assetsById instanceof Map) return assetsById.get(id);
  return assetsById[id];
}

/**
 * V-03 资产引用存在且 category 正确（FAIL）。
 *
 * 悬空引用（`asset_id` 在 `assets` 里不存在）→ `ASSET_NOT_FOUND`；
 * `role` 与资产 `category` 不一致 → `ASSET_ROLE_MISMATCH`。
 * 两者都不降级：引用错了，下游（编译、渲染、voice 槽位）拿到的是另一件东西。
 *
 * @param {{shotAssets?:Array, assetsById?:object|Map}} ctx
 * @returns {{applicable:boolean, findings?:Array, reason?:string}}
 */
export function checkRefs(ctx = {}) {
  const rows = toArr(ctx.shotAssets).filter((r) => r && typeof r === 'object');
  if (!rows.length) return notApplicable('本镜没有 shot_assets 行');
  const hits = [];
  rows.forEach((r, i) => {
    const id = String(r.asset_id ?? '');
    const role = String(r.role ?? '');
    const asset = lookup(ctx.assetsById, id);
    if (!asset) {
      hits.push(f(FAIL, 'ASSET_NOT_FOUND', `shot_assets[${i}].asset_id`, `存在于 assets 表的资产（${id || '空 id'}）`, { asset_id: id, role }));
      return;
    }
    const category = String(asset.category ?? '');
    if (category !== role) {
      hits.push(f(FAIL, 'ASSET_ROLE_MISMATCH', `shot_assets[${i}].role`, `与资产 category 一致（资产 ${id} 是 ${category || '未分类'}）`, {
        asset_id: id, role, category,
      }));
    }
  });
  return found(hits);
}

/**
 * V-23 `voice_ids` 必须等于 `shot_assets(role='voice')` 的渲染结果（FAIL）。
 *
 * 派生口径（D01-02 §6.2）：按 `order_no` 升序取 `asset_id`。
 * 有人绕过唯一权威直接写派生列时，这里必须报——否则"改一个资产引用、voice 槽位没变"这种错永远查不出来。
 *
 * @param {{shot:object, shotAssets?:Array}} ctx
 */
export function checkVoiceIds(ctx = {}) {
  const rows = toArr(ctx.shotAssets).filter((r) => r && typeof r === 'object');
  if (!rows.length) return notApplicable('本镜没有 shot_assets 行，派生列无来源可对');
  const expected = rows
    .filter((r) => String(r.role ?? '') === 'voice')
    .slice()
    .sort((a, b) => num(a.order_no) - num(b.order_no) || cmpStr(a.asset_id, b.asset_id))
    .map((r) => String(r.asset_id ?? ''));
  const actual = toArr(ctx.shot?.voice_ids).map((x) => String(x ?? ''));
  const same = expected.length === actual.length && expected.every((x, i) => x === actual[i]);
  if (same) return pass();
  return found([
    f(FAIL, 'VOICE_IDS_MISMATCH', 'voice_ids', `按 shot_assets(role=voice).order_no 派生为 ${JSON.stringify(expected)}`, {
      expected, actual,
      hint: 'voice_ids 是派生列，不得由 LLM 或工具直接写入；改引用后必须重算',
    }),
  ]);
}

/**
 * V-25 同一 `(shot_id, role)` 的 `order_no` 必须是 `1..n` 连续（FAIL `ASSET_ORDER_GAP`）。
 *
 * 顺序是数据，不能靠 `SELECT` 的偶然顺序（D01-05 §4.6）。跳号与重号都报同一条规则，
 * 因为它们的后果相同：`Audio 1/2/3` 槽位与实际数量对不上。
 *
 * @param {{shotAssets?:Array}} ctx
 */
export function checkOrderNo(ctx = {}) {
  const rows = toArr(ctx.shotAssets).filter((r) => r && typeof r === 'object');
  if (!rows.length) return notApplicable('本镜没有 shot_assets 行');
  const hits = [];
  for (const [role, list] of byRole(rows)) {
    const nums = list.map((r) => num(r.order_no)).sort((a, b) => a - b);
    const dup = nums.filter((v, i) => i > 0 && v === nums[i - 1]);
    const gaps = [];
    for (let i = 0; i < nums.length; i += 1) {
      if (nums[i] !== i + 1) { gaps.push({ at: i + 1, got: nums[i] }); break; }
    }
    if (dup.length || gaps.length) {
      hits.push(f(FAIL, 'ASSET_ORDER_GAP', `shot_assets(role=${role}).order_no`, `1..${nums.length} 连续且不重复`, {
        role, got: nums, duplicated: dup, first_gap: gaps[0] ?? null,
      }));
    }
  }
  return found(hits);
}

/**
 * V-26 同一镜 `role='voice'` 不得超过 3 条（FAIL `VOICE_OVERFLOW`）。
 *
 * @param {{shotAssets?:Array}} ctx
 */
export function checkVoiceCount(ctx = {}) {
  const rows = toArr(ctx.shotAssets).filter((r) => r && typeof r === 'object');
  if (!rows.length) return notApplicable('本镜没有 shot_assets 行');
  const voices = rows.filter((r) => String(r.role ?? '') === 'voice');
  if (voices.length <= VOICE_LIMIT) return pass();
  return found([
    f(FAIL, 'VOICE_OVERFLOW', 'shot_assets(role=voice)', `≤ ${VOICE_LIMIT} 条（Audio 1/2/3 三个槽）`, {
      count: voices.length,
      asset_ids: voices.map((r) => String(r.asset_id ?? '')).sort(cmpStr),
    }),
  ]);
}

/** 本模块的规则注册表（`index.js` 统一执行；顺序即输出顺序，另按 rule_id 排序） */
export const RULES = [
  { id: 'V-03', level: 'FAIL', title: '资产引用存在且 category 正确', run: checkRefs },
  { id: 'V-23', level: 'FAIL', title: 'voice_ids 与 shot_assets(voice) 一致', run: checkVoiceIds },
  { id: 'V-25', level: 'FAIL', title: 'order_no 为 1..n 连续', run: checkOrderNo },
  { id: 'V-26', level: 'FAIL', title: 'role=voice 不超过 3 条', run: checkVoiceCount },
];

/** 供测试断言"role 值域与 D01 一致"用；不在规则里静默放过非法 role（那是 V-02 的活） */
export const isRoleAllowed = (role) => SHOT_ASSET_ROLES.includes(String(role ?? ''));

/** 内部小工具：`asset_id` 是否为空（导出仅为测试可读，不参与规则） */
export const hasAssetId = (r) => !isBlank(r?.asset_id);
