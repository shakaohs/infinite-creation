// P5 独立复审 · 证据脚本（只读）
//
// 用途：验证 U-P5-4 —— 纯函数设计下，"调用方少传一个输入"会不会变成**误判 FAIL**
// 或**静默 N/A**（两者都比"报错"危险：前者让创作者改对的东西，后者让缺陷消失）。
//
// 运行：node scripts/audit/p5-hidden-inputs.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-p5-hidden-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;
delete process.env.IC_DB;
delete process.env.DATABASE_URL;

const V = await import('../../lib/core/validate/index.js');
const F = await import('../../tests/helpers/qc-fixture.mjs');

const show = (id, ctx) => {
  const e = V.validateRule(id, ctx);
  if (e.applicable === false) return `N/A（${e.detail.reason}）`;
  return `${e.level}/${e.code}`;
};

console.log('## 1. A-09 跨镜 trigger：契约里没有 prevActions');
const prevAction = F.a({ id: 'ac_prev', t_from: 0, t_to: 1 });
const curAction = F.a({ id: 'ac_cur', t_from: 1.5, t_to: 2.5, trigger_json: { kind: 'action', ref: 'ac_prev' } });
const a09Base = { actions: [curAction], shot: { ...F.baseShot } };
console.log(`   合法跨镜引用（前镜动作 ac_prev 已结束）+ 传入 prevActions → ${show('A-09', { ...F.ctx(a09Base), prevActions: [prevAction] })}`);
console.log(`   同一份数据，按 validateShot 契约不传 prevActions        → ${show('A-09', F.ctx(a09Base))}`);
const full = V.validateShot({ ...F.ctx(a09Base), chapterShots: [] });
const hit = full.hits.find((h) => h.rule_id === 'A-09');
console.log(`   走 validateShot 全量入口（ctx 里没有 prevActions 这个键）→ A-09 ${hit.level}/${hit.code}`);

console.log('');
console.log('## 2. S-05 cross_allowed.after_shot 指向前镜：prevShot 缺省时');
const sceneWithAllow = F.scene({
  axis_lock: {
    ...F.scene().axis_lock,
    cross_allowed: [{ type: 'cut', reason: '反打', after_shot: 'sh_00' }],
  },
});
const crossBlockings = [F.b({ character_id: 'c1', norm_x: 0.8, norm_y: 0.6 }), F.b({ character_id: 'c2', norm_x: 0.3, norm_y: 0.25 })];
const s05ctx = (extra) => F.ctx({ sceneState: sceneWithAllow, blockings: crossBlockings, ...extra });
console.log(`   传入 prevShot={id:'sh_00'}（白名单生效） → ${show('S-05', s05ctx({ prevShot: { id: 'sh_00' } }))}`);
console.log(`   prevShot 缺省（P9 忘了传）             → ${show('S-05', s05ctx({}))}`);

console.log('');
console.log('## 3. A-06 下镜状态：末镜与取数失败不可区分');
const loco = F.a({ id: 'ac1', action_type: 'locomotion', t_from: 0, t_to: 1, path_json: { from: { x: 0.1, y: 0.5 }, to: { x: 0.9, y: 0.5 } } });
const a06 = (extra) => F.ctx({ actions: [loco], ...extra });
const nextOk = F.st({ state_in: { chars: { c1: { pos: [0.1, 0.5, 0] } } } });
console.log(`   下镜 state_in 与位移终点差 0.8m → ${show('A-06', a06({ nextShotState: nextOk }))}`);
console.log(`   nextShotState 缺省（真末镜 或 取数失败）→ ${show('A-06', a06({}))}`);

console.log('');
console.log('## 4. S-02 依托物：assetsById 只给部分资产时（P9 分批查）');
const anchorCtx = (assets) => ({ ...F.ctx({ blockings: [F.b({ anchor_object: 'p1' })], shotAssets: [{ asset_id: 'p1', role: 'prop', order_no: 1 }] }), assetsById: assets, level: 'S2' });
console.log(`   assetsById 含 p1 → ${show('S-02', anchorCtx({ ...F.ASSETS }))}`);
console.log(`   assetsById 只含角色（漏查道具）→ ${show('S-02', anchorCtx({ c1: F.ASSETS.c1 }))}`);

console.log('');
console.log('## 5. S-13 换装：prevShotAssets 缺省 = "没有上镜"还是"没查"');
const s13 = (extra) => F.ctx({ shotAssets: [{ asset_id: 'ct1', role: 'costume', order_no: 1 }], ...extra });
console.log(`   prevShotAssets 给出 ct2 → ${show('S-13', s13({ prevShotAssets: [{ asset_id: 'ct2', role: 'costume', order_no: 1 }] }))}`);
console.log(`   prevShotAssets 缺省     → ${show('S-13', s13({}))}`);
