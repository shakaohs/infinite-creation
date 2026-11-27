// P8 输入边界专项（D02-17）
//
// 这一组测的不是"功能"，而是**来源边界**：什么能进 `solveContinuity`，什么必须被挡。
//
// 实测结论（决定了下面每条断言的方向）：
//  · `rel` 是真输入，而且能**改写状态**：把 `rel:'known'` 回搬进来，carried 会变成写入
//    （posture 从"沿用 standing"变成"sitting"）；
//  · `src` 是真输入：`carried:sh_99` 会让 `originOf()` 认一个**不存在的起点镜**，并沿链传播；
//  · `conf` 是真输入：它是 `conf × 0.9` 的衰减基数，回搬会把它换基（0.855 → 0.45）。
// 所以"只留 rel"是错的（会漏掉两个真输入）；真正的问题是**同一个 JSON 在两个位置含义不同**。
// 本轮的处置：结构校验（id/global_no/scene_key）+ 来源校验（src 前缀），两者都在 Hash 之前。
import test from 'node:test';
import assert from 'node:assert/strict';

import { solveContinuity, CARRY_DECAY, REL_CONF } from '../lib/core/continuity/solve-continuity.js';
import { solverInputHash, SOLVE_META_FIELDS } from '../lib/core/continuity/solve-hash.js';
import {
  assertSolverInput, assertAnnotationOnly, isResultSrc, ANNOTATION_SRC_PREFIX, RESULT_SRC_PREFIXES,
} from '../lib/core/continuity/solver-input.js';
import * as F from './helpers/continuity-fixture.mjs';

const SCENE = 'S1_病房';

/** 三镜：a(manual, standing) → b(ai, sitting) → c(ai, walking)，b/c 都会走 carried 分支 */
const chain = (metaB) => [
  F.shot({ id: 'a', global_no: 1, spec_source: 'manual', blockings: [F.blk({ posture: 'standing' })] }),
  F.shot({ id: 'b', global_no: 2, spec_source: 'ai', blockings: [F.blk({ posture: 'sitting' })], meta: metaB }),
  F.shot({ id: 'c', global_no: 3, spec_source: 'ai', blockings: [F.blk({ posture: 'walking' })] }),
];
const runChain = (metaB, shots) => solveContinuity({
  projectId: 'p1', sceneKey: SCENE, shots: shots ?? chain(metaB), sceneState: F.scene(),
});
const postureMeta = (r, id) => r.states[id].meta['chars.c1.posture'];

// ══ 一、首轮 / 次轮关系 ════════════════════════════════════════════════════

test('P8-C1 首次求解与第二次求解决定于同一份输入：Hash 与状态完全一致', () => {
  const r1 = runChain(undefined);
  const r2 = runChain(undefined);
  assert.equal(r1.hash, r2.hash);
  assert.deepEqual(r2.states, r1.states);
  // 同一批对象再解一次也不得漂移（纯函数）
  const shots = chain(undefined);
  assert.equal(
    solveContinuity({ projectId: 'p1', sceneKey: SCENE, shots, sceneState: F.scene() }).hash,
    solveContinuity({ projectId: 'p1', sceneKey: SCENE, shots, sceneState: F.scene() }).hash,
  );
});

test('P8-C2 `result.hash` 必须等于同一次组装算出的 `solverInputHash`（同一次组装）', () => {
  const shots = chain({ 'chars.c1.posture': { rel: 'unknown' } });
  const p = { projectId: 'p1', sceneKey: SCENE, shots, sceneState: F.scene() };
  const r = solveContinuity(p);
  assert.equal(r.hash, solverInputHash(p));
  // 换一个内容相同的对象（不同引用）也不得改变 Hash
  assert.equal(solverInputHash({ ...p, shots: shots.map((s) => ({ ...s })) }), r.hash);
});

test('P8-C3 求解结果中的 `__solver.hash` 与本轮 Hash 一致（不是上一次的残留）', () => {
  const r = runChain(undefined);
  for (const id of ['a', 'b', 'c']) {
    assert.equal(r.states[id].meta.__solver.hash, r.hash);
  }
});

// ══ 二、人工标注三类字段各自是输入 ════════════════════════════════════════

test('P8-C4 只改人工 `rel` → Hash 变，且**状态真的变**（不是只改指纹）', () => {
  const base = runChain(undefined);
  const marked = runChain({ 'chars.c1.posture': { rel: 'known' } });
  assert.notEqual(marked.hash, base.hash);
  // 真输入的判据：值被改写（carried → 写入），而不只是 Hash 变
  assert.equal(base.states.b.out.chars.c1.posture, 'standing');
  assert.equal(marked.states.b.out.chars.c1.posture, 'sitting');
});

test('P8-C5 只改人工来源（`manual:` 前缀）→ Hash 变', () => {
  const a = runChain({ 'chars.c1.posture': { rel: 'known', src: 'manual:sh_40' } });
  const b = runChain({ 'chars.c1.posture': { rel: 'known', src: 'manual:sh_41' } });
  assert.notEqual(a.hash, b.hash);
  // 人工来源不得污染继承链：输出仍记求解器产出的 src
  assert.equal(a.states.b.meta['chars.c1.posture'].src, 'blocking:c1');
});

test('P8-C6 只改人工置信度 → Hash 变，且 carried 分支的衰减基数随之变', () => {
  const base = runChain(undefined);
  const low = runChain({ 'chars.c1.posture': { conf: 0.5 } });
  assert.notEqual(low.hash, base.hash);
  assert.equal(base.states.b.meta['chars.c1.posture'].conf, 0.855);  // 0.95 × 0.9
  assert.equal(low.states.b.meta['chars.c1.posture'].conf, 0.45);    // 0.5 × 0.9
});

test('P8-C7 Hash 覆盖的是求解器**实际读**的三样，且不多不少', () => {
  assert.deepEqual([...SOLVE_META_FIELDS].sort(), ['conf', 'rel', 'src']);
  const base = runChain(undefined);
  for (const [field, v] of [
    ['rel', { rel: 'known' }],
    ['src', { src: 'manual:x' }],
    ['conf', { conf: 0.6 }],
  ]) {
    assert.notEqual(runChain({ 'chars.c1.posture': v }).hash, base.hash, `${field} 必须进 Hash`);
  }
  // 不参与求解的键（`ver` / `__solver`）不得影响 Hash，否则每次求解都会自己变一次
  assert.equal(runChain({ 'chars.c1.posture': { rel: 'known', ver: 9 } }).hash,
    runChain({ 'chars.c1.posture': { rel: 'known' } }).hash);
  assert.equal(runChain({ 'chars.c1.posture': { rel: 'known', __solver: { hash: 'x' } } }).hash,
    runChain({ 'chars.c1.posture': { rel: 'known' } }).hash);
});

// ══ 三、求解结果不得未经筛选回搬 ══════════════════════════════════════════

test('P8-C8 把 `shot_states.meta` 整体回搬 → 抛 META_IS_RESULT_FEEDBACK（六种产出前缀全覆盖）', () => {
  for (const prefix of RESULT_SRC_PREFIXES) {
    const src = prefix.endsWith(':') ? `${prefix}sh_01` : prefix;
    assert.equal(isResultSrc(src), true, `${src} 应识别为求解结果`);
    assert.throws(
      () => runChain({ 'chars.c1.posture': { rel: 'known', src, conf: 0.855, ver: 2 } }),
      (e) => e.code === 'CONTINUITY_SOLVER_FAILED' && e.reason === 'META_IS_RESULT_FEEDBACK',
      `${src} 未被拦`,
    );
  }
});

test('P8-C9 未经筛选的回搬会改写状态：这正是必须拦的理由（先证危害，再证已拦）', () => {
  // 不拦的话，一份状态行（rel=known）会把 carried 变成写入 —— 用「绕开校验」的方式复现危害
  const dirty = chain({ 'chars.c1.posture': { rel: 'known' } });
  const r = solveContinuity({ projectId: 'p1', sceneKey: SCENE, shots: dirty, sceneState: F.scene() });
  assert.equal(r.states.b.out.chars.c1.posture, 'sitting', '回搬 rel 会改写值');
  assert.equal(runChain(undefined).states.b.out.chars.c1.posture, 'standing', '不回搬时是沿用');
});

test('P8-C10 求解器产出的 `carried:` 会沿链传播 → 一旦回搬即伪造起点（故一律拒收）', () => {
  // 直接给 b 塞一个 carried:sh_99（不存在的镜）→ 会传到 c
  const shots = chain({ 'chars.c1.posture': { src: 'carried:sh_99' } });
  assert.throws(
    () => solveContinuity({ projectId: 'p1', sceneKey: SCENE, shots, sceneState: F.scene() }),
    (e) => e.reason === 'META_IS_RESULT_FEEDBACK',
  );
  // 而不带任何标注时，c 的起点必须回到真正的 a
  assert.equal(postureMeta(runChain(undefined), 'c').src, 'carried:a');
});

test('P8-C11 `src` 不是 `manual:` 也不是已知产出 → 抛 META_SRC_UNKNOWN（来源必须显式）', () => {
  assert.throws(
    () => runChain({ 'chars.c1.posture': { src: 'whatever:sh_01' } }),
    (e) => e.reason === 'META_SRC_UNKNOWN',
  );
  assert.equal(ANNOTATION_SRC_PREFIX, 'manual:');
});

test('P8-C12 裸标注（只有 rel/conf、无 src）合法：那是人工标注，不是结果回搬', () => {
  const r = runChain({ 'chars.c1.posture': { rel: 'unknown' } });
  // 值不动（沿用上镜），但可靠性如实记成 unknown —— 这是"本镜该字段不可信"的正确表达
  assert.equal(r.states.b.out.chars.c1.posture, 'standing');
  assert.equal(postureMeta(r, 'b').rel, 'unknown');
  assert.equal(postureMeta(r, 'b').src, 'carried:a');
  // 连带效果：b 的 rel 变 unknown 后，c 无法"沿用已知值"，只能取自己的观测（inferred）
  assert.equal(r.states.c.out.chars.c1.posture, 'walking');
  assert.equal(postureMeta(r, 'c').rel, 'inferred');
});

// ══ 四、跨镜 / 跨轮次的继承与衰减 ═════════════════════════════════════════

test('P8-C13 `carried` 跨多镜保持同一起点（a → b → c 都是 carried:a）', () => {
  const r = runChain(undefined);
  assert.equal(postureMeta(r, 'b').src, 'carried:a');
  assert.equal(postureMeta(r, 'c').src, 'carried:a');
  // 值逐镜沿用，不因多跳而改写
  assert.equal(r.states.c.out.chars.c1.posture, 'standing');
});

test('P8-C14 `conf` 逐次衰减、不重复衰减也不归零（0.95 → 0.855 → 0.7695）', () => {
  const r = runChain(undefined);
  const c0 = REL_CONF.known;                       // 0.95
  const c1 = Math.round(c0 * CARRY_DECAY * 1000) / 1000;
  const c2 = Math.round(c1 * CARRY_DECAY * 1000) / 1000;
  assert.equal(postureMeta(r, 'a').conf, c0);
  assert.equal(postureMeta(r, 'b').conf, c1);
  assert.equal(postureMeta(r, 'c').conf, c2);
  assert.ok(c2 > 0, '不得归零');
  assert.equal(CARRY_DECAY, 0.9);
});

test('P8-C15 同一输入连解三轮：Hash 与状态都不漂移（回搬禁令让它可重复）', () => {
  const h = [];
  const s = [];
  for (let i = 0; i < 3; i++) {
    const r = runChain({ 'chars.c1.posture': { rel: 'unknown' } });
    h.push(r.hash);
    s.push(JSON.stringify(r.states));
  }
  assert.equal(new Set(h).size, 1);
  assert.equal(new Set(s).size, 1);
});

test('P8-C16 显式 `unknown` 不丢失：连续两轮都如实记录，且它确实改变了后续判定', () => {
  const marked = runChain({ 'chars.c1.posture': { rel: 'unknown' } });
  const plain = runChain(undefined);
  // ① 标注被如实写进结果（不是被当成"没标注"）
  assert.equal(postureMeta(marked, 'b').rel, 'unknown');
  assert.equal(postureMeta(plain, 'b').rel, 'known');
  // ② 它确实起作用：c 从"沿用 standing"变成"取自己的观测 walking"
  assert.equal(marked.states.c.out.chars.c1.posture, 'walking');
  assert.equal(plain.states.c.out.chars.c1.posture, 'standing');
  // ③ 连续两轮完全一致（不会因回写/重组而漂移）
  const again = runChain({ 'chars.c1.posture': { rel: 'unknown' } });
  assert.equal(again.hash, marked.hash);
  assert.deepEqual(again.states, marked.states);
  // ④ pos 的 unknown 会落到"无值占位"，也两轮一致
  const two = () => solveContinuity({
    projectId: 'p1', sceneKey: SCENE,
    shots: [
      F.shot({ id: 'a', global_no: 1, spec_source: 'manual' }),
      F.shot({ id: 'b', global_no: 2, meta: { 'chars.c1.pos': { rel: 'unknown' } } }),
    ],
    sceneState: F.scene(),
  });
  assert.equal(two().states.b.meta['chars.c1.pos'].rel, 'unknown');
  assert.deepEqual(two().states, two().states);
});

// ══ 五、结构校验：跑错输入必须当场失败 ═════════════════════════════════════

test('P8-C17 `global_no` 缺失 → 抛 SHOT_GLOBAL_NO_INVALID（不再静默按 0 排最前）', () => {
  const shots = chain(undefined);
  delete shots[1].global_no;
  assert.throws(
    () => solveContinuity({ projectId: 'p1', sceneKey: SCENE, shots, sceneState: F.scene() }),
    (e) => e.code === 'CONTINUITY_SOLVER_FAILED' && e.reason === 'SHOT_GLOBAL_NO_INVALID',
  );
  // 0 / 负数 / null 同样拒绝（**值无效**，仍是 SHOT_GLOBAL_NO_INVALID）
  for (const bad of [0, -1, null]) {
    const s = chain(undefined);
    s[1].global_no = bad;
    assert.throws(
      () => solveContinuity({ projectId: 'p1', sceneKey: SCENE, shots: s, sceneState: F.scene() }),
      (e) => e.reason === 'SHOT_GLOBAL_NO_INVALID', `global_no=${JSON.stringify(bad)} 未被拦`,
    );
  }
  // 类型不对（字符串 / 布尔）另立一档：D02-18 R2 的契约是"求解器只要 number"，
  // 数字字符串由组装层 normalizeGlobalNo() 规范化后才会进来。拒绝的是同一件事，理由更准。
  for (const bad of ['abc', '3', true]) {
    const s = chain(undefined);
    s[1].global_no = bad;
    assert.throws(
      () => solveContinuity({ projectId: 'p1', sceneKey: SCENE, shots: s, sceneState: F.scene() }),
      (e) => e.reason === 'SHOT_GLOBAL_NO_NOT_NUMBER', `global_no=${JSON.stringify(bad)} 未被拦`,
    );
  }
});

test('P8-C18 跨场混传 → 抛 SHOT_SCENE_MISMATCH（不再静默跨场串链）', () => {
  const shots = chain(undefined);
  shots[2].scene_key = 'S2_走廊';
  assert.throws(
    () => solveContinuity({ projectId: 'p1', sceneKey: SCENE, shots, sceneState: F.scene() }),
    (e) => e.code === 'CONTINUITY_SOLVER_FAILED'
      && e.reason === 'SHOT_SCENE_MISMATCH'
      && e.shot_ids.includes('c'),
  );
  // 缺 scene_key 同样算不符
  const noKey = chain(undefined);
  delete noKey[1].scene_key;
  assert.throws(() => solveContinuity({ projectId: 'p1', sceneKey: SCENE, shots: noKey, sceneState: F.scene() }),
    (e) => e.reason === 'SHOT_SCENE_MISMATCH');
});

test('P8-C19 `assertSolverInput` 可被组装层直接调用（同一套判据，不必先调求解器）', () => {
  assert.doesNotThrow(() => assertSolverInput({ shots: chain(undefined), sceneKey: SCENE }));
  const missingId = [{ global_no: 1, scene_key: SCENE }];
  assert.throws(() => assertSolverInput({ shots: missingId, sceneKey: SCENE }), (e) => e.reason === 'SHOT_ID_MISSING');
  // 报错要指向最根本的缺失：只填了号 → 先报缺 id，而不是先报场次不符
  const wrongBoth = [{ global_no: 1 }];
  assert.throws(() => assertSolverInput({ shots: wrongBoth, sceneKey: SCENE }), (e) => e.reason === 'SHOT_ID_MISSING');
});

test('P8-C20 `assertAnnotationOnly` 与求解器内校验同源（导出即用，口径不分叉）', () => {
  assert.doesNotThrow(() => assertAnnotationOnly('sh_01', { 'chars.c1.pos': { rel: 'unknown', src: null, conf: null } }));
  assert.doesNotThrow(() => assertAnnotationOnly('sh_01', { 'chars.c1.pos': { rel: 'known', src: 'manual:sh_40', conf: 0.9 } }));
  assert.throws(() => assertAnnotationOnly('sh_01', { 'chars.c1.pos': { rel: 'known', src: 'blocking:c1', conf: null } }),
    (e) => e.reason === 'META_IS_RESULT_FEEDBACK');
});
