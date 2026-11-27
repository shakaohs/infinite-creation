// 阶段 1 · Hash 回归（D01-06 §4.6 的 R-01 ~ R-49）
//
// 一条不删、不合并。凡依赖阶段 4 适配层（pickLegalCut / planAdaptation / 切点量化）
// 的用例，用 t.skip 显式标注原因——skip 是"本阶段不适用"，不是"通过"。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cmpStr, canonicalStringify, sourceSpecHash, buildSourcePayload,
  adaptationHash, compiledHash, bodyOf, canonicalActions,
  stripRefTrigger, stripRefSync, posRel, posRelDetail,
} from '../lib/core/hash/index.js';

// fixture 见 tests/helpers/hash-fixture.mjs —— 跨 locale 探针共用同一份，否则两边比的是不同数据。
import { fx, hashes, clone, block, action, shot, AD_SD, AD_H3, COMP } from './helpers/hash-fixture.mjs';

// posRel 矩阵与 P4 共用一份数据（搬迁不改行为的唯一证据源）
import { POS_REL_MATRIX, POS_REL_WARNING_CASES } from './fixtures/pos-rel-matrix.mjs';


// ── R-01 ~ R-04 稳定性与规范化 ───────────────────────────────────────────
test('R-01 同输入算两次 → 三者均相同', () => {
  assert.deepEqual(hashes(fx()), hashes(fx()));
});

test('R-02 打乱对象键顺序 → 三者均相同', () => {
  const a = fx();
  const b = fx();
  // 重排每行的键顺序（值不变）
  b.shots = b.shots.map((s) => Object.fromEntries(Object.entries(s).reverse()));
  assert.equal(hashes(a).source, hashes(b).source);
  assert.equal(hashes(a).adaptation, hashes(b).adaptation);
});

test('R-03 story_duration 4.0 → 4.00 → 三者均相同', () => {
  const a = fx(); const b = fx();
  b.shots[0].story_duration = 4.00;
  assert.equal(hashes(a).source, hashes(b).source);
});

test('R-04 台词前后加空格 → 三者均相同（内部空格保留，首尾剥离）', () => {
  const a = fx(); const b = fx();
  b.shots[0].dialogue = '  你来了。  ';
  assert.equal(hashes(a).source, hashes(b).source);
  // 内部空格不同必须变（证明不是"删所有空白"）
  const c = fx(); c.shots[0].dialogue = '你 来 了。';
  assert.notEqual(hashes(a).source, hashes(c).source);
});

// ── R-05 ~ R-16 语义变化必须反映 ────────────────────────────────────────
test('R-05 改 visual_content → source 变', () => {
  const a = fx(); const b = fx(); b.shots[0].visual_content = '罗克珊坐直';
  assert.notEqual(hashes(a).source, hashes(b).source);
});

test('R-06 改 dialogue → source 变', () => {
  const a = fx(); const b = fx(); b.shots[0].dialogue = '你终于来了。';
  assert.notEqual(hashes(a).source, hashes(b).source);
});

test('R-07 改 sfx / music_cue → source 变', () => {
  const a = fx();
  const b = fx(); b.shots[0].sfx = '监护仪报警';
  const c = fx(); c.shots[0].music_cue = '低弦';
  assert.notEqual(hashes(a).source, hashes(b).source);
  assert.notEqual(hashes(a).source, hashes(c).source);
});

test('R-08 改 purpose → source 变', () => {
  const a = fx(); const b = fx(); b.shots[0].purpose = 'reveal';
  assert.notEqual(hashes(a).source, hashes(b).source);
});

test('R-09 cam_pos.x 0.42 → 0.43 → source 变', () => {
  const a = fx(); const b = fx(); b.shots[0].cam_pos = '[0.43,0.5,1.2]';
  assert.notEqual(hashes(a).source, hashes(b).source);
});

test('R-10 cam_roll_deg 0 → 5 → source 变', () => {
  const a = fx(); const b = fx(); b.shots[0].cam_roll_deg = 5;
  assert.notEqual(hashes(a).source, hashes(b).source);
});

test('R-11 改动作 t_to → source 变', () => {
  const a = fx(); const b = fx(); b.shots[0].actions[0].t_to = 2.0;
  assert.notEqual(hashes(a).source, hashes(b).source);
});

test('R-12 增删一条 shot_blockings → source 变', () => {
  const a = fx();
  const b = fx(); b.shots[0].blockings.push(block({ character_id: 'harold', norm_x: 0.2 }));
  const c = fx(); c.shots[0].blockings = [];
  assert.notEqual(hashes(a).source, hashes(b).source);
  assert.notEqual(hashes(a).source, hashes(c).source);
});

test('R-13 道具 state held → placed → source 变', () => {
  const a = fx();
  const b = fx(); b.shots[0].state_out = { chars: { roxanne: { posture: '靠坐' } }, props: { cup: { state: 'placed' } } };
  assert.notEqual(hashes(a).source, hashes(b).source);
});

test('R-14 换 costume 资产 → source 变', () => {
  const a = fx();
  const b = fx(); b.shots[0].assets = [{ asset_id: 'as_costume_b', role: 'costume', order_no: 1, variant_of: '' }];
  assert.notEqual(hashes(a).source, hashes(b).source);
});

test('R-15 换素材版本（指纹变）→ source 变', () => {
  const a = fx();
  const b = fx(); b.assets.as_roxanne = { fingerprint: 'fp-rox-2', fpLevel: 'content' };
  assert.notEqual(hashes(a).source, hashes(b).source);
});

test('R-16 story_duration 6.0 → 6.5 → source 变', () => {
  const a = fx(); const b = fx();
  a.shots[0].story_duration = 6.0; b.shots[0].story_duration = 6.5;
  assert.notEqual(hashes(a).source, hashes(b).source);
});

// ── R-17 ~ R-19 排除项与排序 ────────────────────────────────────────────
test('R-17 改 id / created_at / qc_status → source 不变', () => {
  const a = fx(); const b = fx();
  b.shots[0].id = 'sh_999';
  b.shots[0].created_at = 1800000000000;
  b.shots[0].qc_status = 'pass';
  b.shots[0].actions[0].id = 'ac_999';
  assert.equal(hashes(a).source, hashes(b).source);
});

test('R-18 打乱 blockings 插入顺序 → source 不变', () => {
  const a = fx();
  a.shots[0].blockings = [block({ character_id: 'harold', norm_x: 0.2 }), block()];
  const b = fx();
  b.shots[0].blockings = [block(), block({ character_id: 'harold', norm_x: 0.2 })];
  assert.equal(hashes(a).source, hashes(b).source);
});

test('R-19 打乱 voice_ids 顺序 → source 不变（voice_ids 不进 hash）', () => {
  const a = fx(); const b = fx();
  b.shots[0].voice_ids = '["as_voice_b","as_voice_a"]';
  assert.equal(hashes(a).source, hashes(b).source);
  // 且 voice_ids 确实不在 payload 里（不是"碰巧没影响"）
  assert.ok(!canonicalStringify(buildSourcePayload(a)).includes('voice_ids'));
});

// ── R-20 ~ R-25 分层与同源证明 ──────────────────────────────────────────
test('R-20 track seedance → h3 → source 不变；adaptation 变', () => {
  const f = fx();
  assert.equal(hashes(f, AD_SD).source, hashes(f, AD_H3).source);
  assert.notEqual(hashes(f, AD_SD).adaptation, hashes(f, AD_H3).adaptation);
});

test('R-21 profile_ver sd25 → sd20 → source 不变；adaptation 变', () => {
  const f = fx();
  const sd20 = clone(AD_SD);
  sd20.adaptation.profile_ver = 'seedance20.v1';
  sd20.adaptation.profile_max = 20;
  assert.equal(hashes(f, AD_SD).source, hashes(f, sd20).source);
  assert.notEqual(hashes(f, AD_SD).adaptation, hashes(f, sd20).adaptation);
});

test('R-22 同 profile 重切（片段 t_to 变）→ source 不变；adaptation 变', () => {
  const f = fx();
  const recut = clone(AD_SD);
  recut.fragments[1].t_to = 12.5;
  assert.equal(hashes(f, AD_SD).source, hashes(f, recut).source);
  assert.notEqual(hashes(f, AD_SD).adaptation, hashes(f, recut).adaptation);
});

test('R-23 改 seam 策略 → source 不变；adaptation 变', () => {
  const f = fx();
  const s2 = clone(AD_SD);
  s2.adaptation.seam_policy_json = '{"seam":"hard_cut"}';
  assert.equal(hashes(f, AD_SD).source, hashes(f, s2).source);
  assert.notEqual(hashes(f, AD_SD).adaptation, hashes(f, s2).adaptation);
});

test('R-24 只升 compilerVer → source/adaptation 不变；compiled 变', () => {
  const f = fx();
  const c2 = { ver: '1.0.1', params: clone(COMP.params) };
  assert.equal(hashes(f).source, hashes(f, AD_SD, c2).source);
  assert.equal(hashes(f).adaptation, hashes(f, AD_SD, c2).adaptation);
  assert.notEqual(hashes(f).compiled, hashes(f, AD_SD, c2).compiled);
});

test('R-25 双编译器（同分镜、不同 track）→ source 逐字相同；adaptation 与 compiled 均不同（CI 断言）', () => {
  const f = fx();
  const sd = hashes(f, AD_SD);
  const h3 = hashes(f, AD_H3);
  assert.equal(sd.source, h3.source);
  assert.notEqual(sd.adaptation, h3.adaptation);
  assert.notEqual(sd.compiled, h3.compiled);
});

// ── R-26 ~ R-35 动作顺序与引用映射 ──────────────────────────────────────
const TWO_ACTIONS = () => [
  action({ id: 'ac_1', t_from: 0, t_to: 1.2, action_type: 'gesture' }),
  action({ id: 'ac_2', t_from: 1.2, t_to: 2.4, action_type: 'speak', trigger_json: '{"kind":"action","ref":"ac_1","text":"接话"}' }),
];

test('R-26 仅打乱动作返回顺序（正序/逆序/随机）→ source 不变', () => {
  const base = fx(); base.shots[0].actions = TWO_ACTIONS();
  const rev = fx(); rev.shots[0].actions = TWO_ACTIONS().reverse();
  const rnd = fx(); const a = TWO_ACTIONS(); rnd.shots[0].actions = [a[1], a[0]];
  const h = hashes(base).source;
  assert.equal(hashes(rev).source, h);
  assert.equal(hashes(rnd).source, h);
});

test('R-27 复制一个动作、只换新 id（内容全等）→ source 不变', () => {
  const base = fx(); base.shots[0].actions = [action({ id: 'ac_1' })];
  const dup = fx(); dup.shots[0].actions = [action({ id: 'ac_1' }), action({ id: 'ac_2' })];
  assert.notEqual(hashes(base).source, hashes(dup).source);  // 真的多了一条动作
  // 但"同一批动作只换 id"必须不变：
  const renamed = fx(); renamed.shots[0].actions = [action({ id: 'ac_zzz' })];
  assert.equal(hashes(base).source, hashes(renamed).source);
});

test('R-28 换音色资产（asset_id 变）→ source 变', () => {
  const a = fx();
  a.shots[0].assets = [{ asset_id: 'as_voice_a', role: 'voice', order_no: 1, variant_of: '' }];
  const b = fx();
  b.shots[0].assets = [{ asset_id: 'as_voice_b', role: 'voice', order_no: 1, variant_of: '' }];
  assert.notEqual(hashes(a).source, hashes(b).source);
});

test('R-29 同一音色资产换版本（fp 变，asset_id 不变）→ source 变', () => {
  const a = fx();
  a.shots[0].assets = [{ asset_id: 'as_voice_a', role: 'voice', order_no: 1, variant_of: '' }];
  const b = clone(a);
  b.assets.as_voice_a = { fingerprint: 'fp-voice-a-v2', fpLevel: 'content' };
  assert.notEqual(hashes(a).source, hashes(b).source);
});

test('R-30 blockings.rel 从 known 改成 unknown（坐标值不变）→ source 变', () => {
  const a = fx();
  const b = fx();
  b.shots[0].blockings = [block({ meta: { rel: 'unknown' } })];
  assert.notEqual(hashes(a).source, hashes(b).source);
});

test('R-31 无引用动作换 id（谁都不引用它）→ source 不变', () => {
  const a = fx(); a.shots[0].actions = [action({ id: 'ac_a' })];
  const b = fx(); b.shots[0].actions = [action({ id: 'ac_b' })];
  assert.equal(hashes(a).source, hashes(b).source);
});

test('R-32 被 trigger.ref 引用的动作换 id，并同步更新引用 → source 不变', () => {
  const a = fx();
  a.shots[0].actions = [
    action({ id: 'ac_1', trigger_json: '{"kind":"self","text":"抬手"}' }),
    action({ id: 'ac_2', t_from: 1.2, trigger_json: '{"kind":"action","ref":"ac_1","text":"接话"}' }),
  ];
  const b = fx();
  b.shots[0].actions = [
    action({ id: 'ac_X', trigger_json: '{"kind":"self","text":"抬手"}' }),
    action({ id: 'ac_Y', t_from: 1.2, trigger_json: '{"kind":"action","ref":"ac_X","text":"接话"}' }),
  ];
  assert.equal(hashes(a).source, hashes(b).source);
});

test('R-33 被 parallel_with 引用的动作换 id，并同步更新引用 → source 不变', () => {
  const a = fx();
  a.shots[0].actions = [
    action({ id: 'ac_1', trigger_json: '{"kind":"self","text":"抬手"}' }),
    action({ id: 'ac_2', t_from: 1.2, sync_json: '{"parallel_with":["ac_1"]}' }),
  ];
  const b = fx();
  b.shots[0].actions = [
    action({ id: 'ac_X', trigger_json: '{"kind":"self","text":"抬手"}' }),
    action({ id: 'ac_Y', t_from: 1.2, sync_json: '{"parallel_with":["ac_X"]}' }),
  ];
  assert.equal(hashes(a).source, hashes(b).source);
});

test('R-34 只改引用目标的实际内容（抬手→转身）→ source 变', () => {
  const a = fx();
  a.shots[0].actions = [
    action({ id: 'ac_1', trigger_json: '{"kind":"self","text":"抬手"}' }),
    action({ id: 'ac_2', t_from: 1.2, trigger_json: '{"kind":"action","ref":"ac_1","text":"接话"}' }),
  ];
  const b = clone(a);
  b.shots[0].actions[0].trigger_json = '{"kind":"self","text":"转身"}';
  assert.notEqual(hashes(a).source, hashes(b).source);
});

test('R-35 打乱动作输入顺序（含引用关系不变）→ source 不变', () => {
  const mk = (rev) => {
    const f = fx();
    const list = [
      action({ id: 'ac_1', trigger_json: '{"kind":"self","text":"抬手"}' }),
      action({ id: 'ac_2', t_from: 1.2, sync_json: '{"parallel_with":["ac_1"]}' }),
      action({ id: 'ac_3', t_from: 2.4, action_type: 'move' }),
    ];
    f.shots[0].actions = rev ? list.reverse() : list;
    return hashes(f).source;
  };
  assert.equal(mk(false), mk(true));
});

// ── R-36 ~ R-37 切点边界（依赖阶段 4 的切分器） ─────────────────────────
test('R-36 动作 t_from 恰等于切点 / t_to 恰等于镜尾 → 切分结果确定；动作只归属一个片段', (t) => {
  t.skip('依赖阶段 4 的 pickLegalCut / assertAttribution（阶段 1 不实现适配算法，任务书 §九）');
});

test('R-37 动作 A 的 t_to 与动作 B 的 t_from 重合，切在该点 → 两者分属左右片段各播一次', (t) => {
  t.skip('依赖阶段 4 的半开区间归属判定（assertAttribution），阶段 1 不实现');
});

// ── R-38 三维坐标整体性 ─────────────────────────────────────────────────
test('R-38 norm_xyz 四形态：仅全有值可 known；z=0 与 z 缺的 source 不同', () => {
  const full = fx();   // x/y/z 全有，manual
  const noZ = fx(); noZ.shots[0].blockings = [block({ norm_z: null, meta: undefined })];
  const none = fx(); none.shots[0].blockings = [block({ norm_x: null, norm_y: null, norm_z: null, meta: undefined })];
  const zero = fx(); zero.shots[0].blockings = [block({ norm_z: 0, meta: undefined })];

  assert.equal(full.shots[0].blockings[0].meta.rel, 'known');
  const p = (f) => buildSourcePayload(f).shots[0].blockings[0];
  assert.equal(p(full).rel, 'known');
  assert.equal(p(noZ).rel, 'unknown');
  assert.equal(p(none).rel, 'unknown');
  assert.equal(p(zero).rel, 'known');           // z=0 是确定值
  assert.notEqual(p(noZ).xy[2], p(zero).xy[2]); // null ≠ 0
  assert.notEqual(hashes(noZ).source, hashes(zero).source);
});

// ── R-39（D01-06 明确列为"负向，代码评审项"）──────────────────────────────
test('R-39 负向：source payload 不得出现 track / fragments / 任何下划线开头键', () => {
  const payload = buildSourcePayload(fx());
  const keys = new Set();
  (function walk(v) {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); }
  })(payload);
  for (const k of keys) assert.ok(!k.startsWith('_'), `payload 出现临时键 ${k}`);
  for (const banned of ['track', 'profile_ver', 'unit_duration', 'unit_no', 'seam', 'fragments', 't_from', 't_to']) {
    assert.equal(keys.has(banned), false, `payload 不应包含适配字段 ${banned}`);
  }
});

// ── R-40 / R-41 音色顺序 ────────────────────────────────────────────────
test('R-40 交换同一镜两条 voice 资产的 order_no（1↔2）→ source 变', () => {
  const a = fx();
  a.shots[0].assets = [
    { asset_id: 'as_voice_a', role: 'voice', order_no: 1, variant_of: '' },
    { asset_id: 'as_voice_b', role: 'voice', order_no: 2, variant_of: '' },
  ];
  const b = clone(a);
  b.shots[0].assets[0].order_no = 2;
  b.shots[0].assets[1].order_no = 1;
  assert.notEqual(hashes(a).source, hashes(b).source);
});

test('R-41 同一 (shot, role) 两条资产写同一个 order_no → 由 DB UNIQUE 拒绝，不入 hash', async (t) => {
  // 真正的约束测试在 tests/stage1-schema.test.mjs（需真实建表）；这里只断言"hash 不负责这件事"
  const { STAGE1_TABLES } = await import('../lib/core/schema/tables.js');
  assert.ok(STAGE1_TABLES.some((x) => x.name === 'shot_assets'));
  t.diagnostic('UNIQUE/RANGE 由 shot_assets 的 DDL 承担，hash 侧不重复校验');
});

// ── R-42 locale 无关 ────────────────────────────────────────────────────
test('R-42 同一 fixture 在不同 LANG 下 source 逐字相同（cmpStr 不依赖 locale）', async () => {
  const { spawnSync } = await import('node:child_process');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const probe = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'hash-locale-probe.mjs');
  const here = sourceSpecHash(fx());
  for (const lang of ['en_US.UTF-8', 'tr_TR.UTF-8', 'sv_SE.UTF-8']) {
    const r = spawnSync(process.execPath, [probe], { env: { ...process.env, LANG: lang, LC_ALL: lang }, encoding: 'utf8' });
    assert.equal(r.status, 0, `probe 失败(${lang}): ${r.stderr}`);
    assert.equal(r.stdout.trim(), here, `LANG=${lang} 结果不同`);
  }
  // 反证：localeCompare 确实会随 locale 变（这就是禁用它的原因）。
  // 用大小写这组：en 下 'a' < 'A'，而 cmpStr 按 code unit 判 'A'(65) < 'a'(97) —— 结论相反。
  assert.notEqual('a'.localeCompare('A', 'en'), cmpStr('a', 'A'));
});

// ── R-43 引用剥离八算例 ─────────────────────────────────────────────────
test('R-43 stripRefTrigger / stripRefSync 八个算例 + 未知字段必须保留', () => {
  assert.deepEqual(stripRefTrigger({ kind: 'action', ref: 'ac_1', text: '纸被摔在柜上' }), { kind: 'action', text: '纸被摔在柜上' });
  assert.deepEqual(stripRefTrigger({ kind: 'self', ref: '', text: '自主' }), { kind: 'self', text: '自主' });
  assert.deepEqual(stripRefTrigger({ kind: 'ambient', ref: 'sfx:monitor', text: '监护仪报警' }), { kind: 'ambient', text: '监护仪报警' });
  assert.deepEqual(stripRefTrigger(null), {});
  assert.deepEqual(stripRefTrigger({ kind: 'action', ref: 'ac_1', text: '…', strength: 0.8 }), { kind: 'action', text: '…', strength: 0.8 });
  const sync = { with_dialogue: 'after', dialogue_span: [1.6, 4.5], emotion: 'cold_pressure', relation: 'reinforce', parallel_with: ['ac_2'], focus_rank: 1 };
  assert.deepEqual(stripRefSync(sync), { with_dialogue: 'after', dialogue_span: [1.6, 4.5], emotion: 'cold_pressure', relation: 'reinforce', focus_rank: 1 });
  assert.deepEqual(stripRefSync({ with_dialogue: 'before', parallel_with: [] }), { with_dialogue: 'before' });
  assert.deepEqual(stripRefSync({ with_dialogue: 'after', parallel_with: ['ac_2'], tempo: 'staccato' }), { with_dialogue: 'after', tempo: 'staccato' });
  // 未知字段进 hash：新增语义字段必须改变 source
  const a = fx();
  const b = fx();
  b.shots[0].actions[0].trigger_json = '{"kind":"action","text":"抬头","strength":0.8}';
  assert.notEqual(hashes(a).source, hashes(b).source);
});

// ── R-44 posRel 13 行矩阵（数据在 tests/fixtures/pos-rel-matrix.mjs，与 P4 新路径共用）──
test('R-44 posRel 13 行矩阵逐行核对', () => {
  for (const row of POS_REL_MATRIX) {
    assert.equal(posRel(row.args), row.expected, `第 ${row.n} 行：${row.why}`);
  }
  // 两条矛盾告警
  for (const c of POS_REL_WARNING_CASES) {
    assert.deepEqual(posRelDetail(c.args).warnings, c.expectedWarnings, c.why);
  }
});

// ── R-45 / R-47 / R-48 / R-49 属阶段 4 ─────────────────────────────────
test('R-45 算例 G 七个量化边界（G-1~G-7）', (t) => {
  t.skip('依赖阶段 4 的 pickLegalCut 量化逻辑（阶段 1 不实现适配算法）');
});
test('R-47 把 pickLegalCut 改成返回窗口上界 → 必须返回 ADAPT_ACTION_LOST', (t) => {
  t.skip('依赖阶段 4 的 pickLegalCut + assertAttribution');
});
test('R-48 ACTION_EDGE_SNAPPED 四形态（精确命中不产生，后三种各 1 条）', (t) => {
  t.skip('依赖阶段 4 的切点吸附实现');
});
test('R-49 planAdaptation 返回值结构（成功 + 两种失败，均含 warnings）', (t) => {
  t.skip('依赖阶段 4 的 planAdaptation');
});

// ── R-46 静态检查 ──────────────────────────────────────────────────────
test('R-46 静态检查：hash 模块内无未定义标识符、localeCompare 零命中', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'core', 'hash');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  // 先剥注释再检查：注释里"不要用 localeCompare"这类说明本身含该词，
  // 直接扫全文会把正确的代码判成违规（本机踩过一次）。
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  for (const f of files) {
    const src = stripComments(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.equal(/localeCompare/.test(src), false, `${f} 代码中出现 localeCompare`);
    // 裸 stripRef( 调用必须为零（V6 遗留的未定义调用）
    assert.equal(/(?<!Trigger)(?<!Sync)\bstripRef\s*\(/.test(src), false, `${f} 出现裸 stripRef(`);
  }
  // bodyOf 真的调用了两个正式定义
  const ss = fs.readFileSync(path.join(dir, 'source-spec-hash.js'), 'utf8');
  assert.ok(ss.includes('stripRefTrigger('), 'bodyOf 未调用 stripRefTrigger');
  assert.ok(ss.includes('stripRefSync('), 'bodyOf 未调用 stripRefSync');
});

// ── 额外：canonicalStringify 稳定性（任务书 §5.5 要求 ≥10 种顺序） ──────
test('canonicalStringify 十种输入顺序稳定', () => {
  const base = { a: 1, b: [1, 2, { y: 2, x: 1 }], c: { n: null, s: '中 文' }, d: 0.1 + 0.2 };
  const keys = Object.keys(base);
  const perms = [
    keys, keys.slice().reverse(),
    ['b', 'a', 'c', 'd'], ['b', 'c', 'a', 'd'], ['c', 'a', 'b', 'd'],
    ['c', 'b', 'd', 'a'], ['d', 'a', 'b', 'c'], ['d', 'c', 'b', 'a'],
    ['a', 'd', 'c', 'b'], ['b', 'd', 'a', 'c'],
  ];
  const outs = perms.map((order) => canonicalStringify(Object.fromEntries(order.map((k) => [k, base[k]]))));
  for (const o of outs) assert.equal(o, outs[0]);
  assert.ok(outs[0].includes('"d":0.3'), '0.1+0.2 应归一为 0.3');
});

// ── 额外：cmpStr 三语言环境 ─────────────────────────────────────────────
test('cmpStr 在 en / tr / sv 三种 collation 下结论一致（且与 localeCompare 不同）', () => {
  const words = ['ä', 'z', 'I', 'i', 'ı', 'A'];
  const sorted = words.slice().sort(cmpStr);
  // cmpStr 是纯 code unit 序：'A'(65) < 'I'(73) < 'i'(105) < 'z'(122) < 'ä'(228) < 'ı'(305)
  assert.deepEqual(sorted, ['A', 'I', 'i', 'z', 'ä', 'ı']);
  // 同一组词用 localeCompare 在 sv 下会把 z 排到 ä 前面（证明 locale 真的会改变结果）
  const sv = words.slice().sort((a, b) => a.localeCompare(b, 'sv'));
  assert.notDeepEqual(sv, sorted);
});
