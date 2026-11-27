// D02-18 · P8 输入契约边界（R1 来源隔离 / R2 global_no / R3 元素校验 / R4 unknown 语义）
//
// 这份文件只覆盖 D02-18 新增的边界，原有 141（P6）+ 20（P8 契约）条另在各自文件里回归。
//
// 判定口径统一为"**两种输入必须得到不同结论**"，而不是"没抛异常"：
//  · R1 的两侧是「同一批字段，标注来自人工」vs「来自 shot_states」；
//  · R2 的两侧是「合法正整数」vs「0/负/小数/串/重复」；
//  · R3 的两侧是「非法元素被拒」vs「原来会被 filter 静默丢掉」。
import test from 'node:test';
import assert from 'node:assert/strict';

import { solveContinuity } from '../lib/core/continuity/solve-continuity.js';
import {
  assembleSolverShots, buildShotAnnotations, normalizeGlobalNo, assertAnnotationSource,
  ANNOTATION_SOURCES, RESULT_SIDE_SOURCES,
} from '../lib/core/continuity/assemble-input.js';
import { assertSolverInput, isResultSrc } from '../lib/core/continuity/solver-input.js';
import * as F from './helpers/continuity-fixture.mjs';

const SCENE = 'S1_病房';

/** 三镜链：a(manual) → b(ai) → c(ai)；b 的标注由用例决定 */
function rows() {
  return [
    { ...F.shot({ id: 'a', global_no: 1, shot_no: 1, spec_source: 'manual' }) },
    { ...F.shot({ id: 'b', global_no: 2, shot_no: 2, spec_source: 'ai' }) },
    { ...F.shot({ id: 'c', global_no: 3, shot_no: 3, spec_source: 'ai' }) },
  ].map(({ meta, ...r }) => r); // 无标注的镜不应带 meta（用于断言"不凭空生 meta"）
}

/** b / c 都不给坐标的链（只能继承 → 用来观察继承链与可靠性传播） */
function inheritRows() {
  const bare = () => [{ ...F.blk(), norm_x: null, norm_y: null, norm_z: null }];
  const r = rows();
  r[1] = { ...r[1], blockings: bare() };
  r[2] = { ...r[2], blockings: bare() };
  return r;
}

const run = (shots) => solveContinuity({ projectId: 'p1', sceneKey: SCENE, shots, sceneState: F.scene() });

/** 一份"看起来正常"的 shot_states.meta（求解器产出形态） */
const STATE_META = Object.freeze({
  'chars.c1.pos': { rel: 'inferred', src: 'carried:a', conf: 0.855, ver: 3 },
  'chars.c1.posture': { rel: 'known', src: 'prev_shot:b', conf: 0.95, ver: 3 },
});

/** 模拟"从历史结果里抠字段"的投影（P8 若不设防，最可能被写成这样） */
const project = (meta, fields) => Object.fromEntries(
  Object.entries(meta).map(([k, v]) => [k, Object.fromEntries(fields.filter((f) => f in v).map((f) => [f, v[f]]))]),
);

// ══ R1 输入来源隔离（组装层）══════════════════════════════════════════════

test('R1-1 完整 shot_states.meta 回搬：来源自报 shot_states 即拒（不必等字段校验）', () => {
  assert.throws(
    () => buildShotAnnotations({ shotId: 'b', source: 'shot_states', entries: STATE_META }),
    (e) => e.code === 'CONTINUITY_SOLVER_FAILED' && e.reason === 'ANNOTATION_SOURCE_IS_RESULT',
  );
  // 换任何"结果侧"标签都一样，不是只拦一个字符串
  for (const s of RESULT_SIDE_SOURCES) {
    assert.throws(() => assertAnnotationSource(s), (e) => e.reason === 'ANNOTATION_SOURCE_IS_RESULT', s);
  }
});

test('R1-2 只提取 rel 的历史结果：扣掉 src/conf 也过不了组装层', () => {
  const relOnly = project(STATE_META, ['rel']);
  assert.deepEqual(relOnly['chars.c1.pos'], { rel: 'inferred' }); // 与人工裸标注**形状完全相同**
  // 形状相同、来源不同 —— 判据只能是来源，不是字段
  assert.throws(
    () => buildShotAnnotations({ shotId: 'b', source: 'shot_states', entries: relOnly }),
    (e) => e.reason === 'ANNOTATION_SOURCE_IS_RESULT',
  );
  // 而同样一坨字段，来源是人工 → 必须放行（否则等于把裸标注一并禁掉）
  const ok = buildShotAnnotations({ shotId: 'b', source: 'manual', entries: relOnly });
  assert.equal(ok['chars.c1.pos'].rel, 'inferred');
});

test('R1-3 只提取 conf 的历史结果：来源拒 + 即便谎报人工也被结果侧字段拦住', () => {
  const confOnly = project(STATE_META, ['conf']);
  assert.deepEqual(confOnly['chars.c1.pos'], { conf: 0.855 });
  assert.throws(
    () => buildShotAnnotations({ shotId: 'b', source: 'shot_states', entries: confOnly }),
    (e) => e.reason === 'ANNOTATION_SOURCE_IS_RESULT',
  );
  // 谎报 manual：`conf` 本身就是求解器算出来的，人工标注没有置信度可给
  assert.throws(
    () => buildShotAnnotations({ shotId: 'b', source: 'manual', entries: confOnly }),
    (e) => e.reason === 'ANNOTATION_CARRIES_RESULT_FIELDS' && e.fields.includes('conf'),
  );
  // 连 conf 都抠掉、只剩空壳 → 仍然过不了：标注必须交代可靠性
  assert.throws(
    () => buildShotAnnotations({ shotId: 'b', source: 'manual', entries: { 'chars.c1.pos': {} } }),
    (e) => e.reason === 'ANNOTATION_REL_REQUIRED',
  );
});

test('R1-4 完整状态行谎报 manual：conf/ver/src 是结果侧字段，仍被拒', () => {
  assert.throws(
    () => buildShotAnnotations({ shotId: 'b', source: 'manual', entries: STATE_META }),
    (e) => e.reason === 'ANNOTATION_CARRIES_RESULT_FIELDS' && e.fields.includes('conf'),
  );
  // 只抠 rel + conf 也拦（conf 是求解器算的，人工没有置信度可给）
  assert.throws(
    () => buildShotAnnotations({ shotId: 'b', source: 'manual', entries: { 'chars.c1.pos': { rel: 'known', conf: 0.9 } } }),
    (e) => e.reason === 'ANNOTATION_CARRIES_RESULT_FIELDS',
  );
});

test('R1-5 新的人工裸标注：组装层盖上 manual: 后缀，求解器照常认', () => {
  const { shots, annotatedShotIds } = assembleSolverShots({
    projectId: 'p1', sceneKey: SCENE, rows: rows(),
    annotations: { b: { source: 'manual', entries: { 'chars.c1.pos': { rel: 'unknown' } } } },
  });
  assert.deepEqual(annotatedShotIds, ['b']);
  assert.deepEqual(shots[1].meta['chars.c1.pos'], { rel: 'unknown', src: 'manual:manual' });
  // 盖上来源后**求解结论不变**：与"直接给裸标注"求出的 state_out 逐字段相同
  const bare = rows();
  bare[1].meta = { 'chars.c1.pos': { rel: 'unknown' } };
  assert.deepEqual(run(shots).states.b.out, run(bare).states.b.out);
  assert.equal(run(shots).states.b.meta['chars.c1.pos'].rel, 'unknown');
  // Hash 不同是**正确**的：src 是真输入（D02-17 §二），不是噪声
  assert.notEqual(run(shots).hash, run(bare).hash);
});

test('R1-6 `manual:` 标注在求解器这一层仍然可用（第二道防线不误伤正路）', () => {
  const withSrc = rows();
  withSrc[1].meta = { 'chars.c1.pos': { rel: 'unknown', src: 'manual:sh_41_panel' } };
  const withoutSrc = rows();
  withoutSrc[1].meta = { 'chars.c1.pos': { rel: 'unknown' } };
  // ① 不抛：带 manual: 的标注是正路
  assert.equal(isResultSrc('manual:sh_41_panel'), false);
  // ② 求解结论与裸标注逐字段相同（src 只是溯源串，不改判定）；只有 `__solver.hash` 会变，
  //    因为 src 是 Hash 的真输入（D02-17 §二）
  const stripSolver = (v) => JSON.parse(JSON.stringify(v, (k, val) => (k === '__solver' ? undefined : val)));
  assert.deepEqual(run(withSrc).states.b.out, run(withoutSrc).states.b.out);
  assert.deepEqual(stripSolver(run(withSrc).states), stripSolver(run(withoutSrc).states));
  // ③ 事实记录：标注的 `manual:` 前缀**不会留在 state_out.meta** —— 值没被采信时
  //    src 被改写为 `carried:<起点>`，采信时改写为 `blocking:<id>`。
  //    也就是说"这条 rel 是人标的"这层信息在求解结果里不可追溯（记为 U-P8-4，不改语义）。
  assert.equal(run(withSrc).states.b.meta['chars.c1.pos'].src, 'carried:a');
});

test('R1-7 求解器第二道防线：结果侧 src 直接塞 shots[].meta 仍被拒', () => {
  const shots = rows();
  shots[1].meta = { 'chars.c1.pos': { rel: 'known', src: 'carried:a' } };
  assert.throws(
    () => run(shots),
    (e) => e.reason === 'META_IS_RESULT_FEEDBACK' && e.shot_id === 'b',
  );
});

test('R1-8 标注挂到不存在的镜 → 拒绝（不得静默丢弃标注）', () => {
  assert.throws(
    () => assembleSolverShots({
      projectId: 'p1', sceneKey: SCENE, rows: rows(),
      annotations: { zz_shadow: { source: 'manual', entries: { 'chars.c1.pos': { rel: 'unknown' } } } },
    }),
    (e) => e.reason === 'ANNOTATION_SHOT_NOT_FOUND' && e.shot_ids.includes('zz_shadow'),
  );
});

test('R1-9 来源白名单只有 manual / adaptation，缺省与拼错都拒', () => {
  assert.deepEqual([...ANNOTATION_SOURCES], ['manual', 'adaptation']);
  assert.equal(assertAnnotationSource('adaptation'), 'adaptation');
  assert.throws(() => assertAnnotationSource(undefined), (e) => e.reason === 'ANNOTATION_SOURCE_MISSING');
  assert.throws(() => assertAnnotationSource('Manual'), (e) => e.reason === 'ANNOTATION_SOURCE_UNKNOWN');
});

test('R1-10 组装不改入参：rows 的 global_no / meta 原样保留', () => {
  const input = rows();
  input[1].global_no = '2';
  const before = JSON.stringify(input);
  const { shots } = assembleSolverShots({
    projectId: 'p1', sceneKey: SCENE, rows: input,
    annotations: { b: { source: 'manual', entries: { 'chars.c1.pos': { rel: 'unknown' } } } },
  });
  assert.equal(JSON.stringify(input), before, '入参被改写');
  assert.equal(shots[1].global_no, 2, '副本里应已规范化为 number');
  assert.equal(shots[0].meta, undefined, '没有标注的镜不凭空生 meta');
});

// ══ R2 global_no 排序契约 ═════════════════════════════════════════════════

test('R2-1 0 / 负数 / 小数 / 空值 / 非数字全部拒绝（reason 按成因分档）', () => {
  const cases = [
    [0, 'SHOT_GLOBAL_NO_INVALID'],
    [-2, 'SHOT_GLOBAL_NO_INVALID'],
    [1.5, 'SHOT_GLOBAL_NO_INVALID'],
    [null, 'SHOT_GLOBAL_NO_INVALID'],
    ['abc', 'SHOT_GLOBAL_NO_NOT_NUMBER'],
    ['3', 'SHOT_GLOBAL_NO_NOT_NUMBER'], // 数字字符串只在组装层被接受一次
    [true, 'SHOT_GLOBAL_NO_NOT_NUMBER'],
    [{}, 'SHOT_GLOBAL_NO_NOT_NUMBER'],
  ];
  for (const [bad, reason] of cases) {
    const shots = rows();
    shots[1].global_no = bad;
    assert.throws(
      () => run(shots),
      (e) => e.code === 'CONTINUITY_SOLVER_FAILED' && e.reason === reason,
      `global_no=${JSON.stringify(bad)} 应被拒为 ${reason}`,
    );
  }
});

test('R2-2 同一批次重复 global_no → 拒绝（不得靠 id 字典序兜底）', () => {
  const shots = rows();
  shots[2].global_no = 1;
  assert.throws(
    () => run(shots),
    (e) => e.reason === 'SHOT_GLOBAL_NO_DUPLICATED'
      && e.duplicated.some((d) => d.global_no === 1 && d.shot_ids.length === 2),
  );
});

test('R2-3 合法连续镜头：乱序传入也按 global_no 升序求解，结果与顺序无关', () => {
  const ordered = inheritRows();
  const shuffled = [ordered[2], ordered[0], ordered[1]].map((r) => ({ ...r }));
  const a = run(ordered);
  const b = run(shuffled);
  assert.equal(a.hash, b.hash);
  assert.deepEqual(b.states, a.states);
  // b 拿到的前镜必须是 a（global_no=2 的眼睛看到 global_no=1 的输出，而不是数组下标 1）
  assert.equal(b.states.b.meta['chars.c1.pos'].src, 'carried:a');
  assert.equal(b.states.b.meta['chars.c1.pos'].conf, 0.855);
});

test('R2-4 组装层 normalizeGlobalNo：只接受 number 或无前导零十进制串', () => {
  assert.equal(normalizeGlobalNo(3), 3);
  assert.equal(normalizeGlobalNo('3'), 3);
  assert.equal(normalizeGlobalNo('99'), 99);
  for (const bad of ['03', ' 3', '3.0', '3 ', '', 'x', 0, -1, 1.5, null, undefined]) {
    assert.throws(() => normalizeGlobalNo(bad, 'b'), (e) => e.code === 'CONTINUITY_SOLVER_FAILED', String(bad));
  }
});

// ══ R3 shots 元素校验 ═════════════════════════════════════════════════════

test('R3-1 null / 字符串 / 数组元素 → SHOT_INPUT_INVALID（不再 filter 静默丢弃）', () => {
  for (const bad of [null, 'sh_02', ['sh_02'], 42]) {
    const shots = rows();
    shots[1] = bad;
    assert.throws(
      () => run(shots),
      (e) => e.code === 'CONTINUITY_SOLVER_FAILED' && e.reason === 'SHOT_INPUT_INVALID',
      `元素 ${JSON.stringify(bad)} 应整批拒绝`,
    );
    // 组装层同样不丢
    assert.throws(
      () => assembleSolverShots({ projectId: 'p1', sceneKey: SCENE, rows: shots }),
      (e) => e.reason === 'SHOT_INPUT_INVALID',
    );
  }
});

test('R3-2 空对象 → 拒绝（SHOT_ID_MISSING）：没有 id 的镜头不能参与继承链', () => {
  const shots = rows();
  shots[1] = {};
  assert.throws(
    () => run(shots),
    (e) => e.code === 'CONTINUITY_SOLVER_FAILED' && e.reason === 'SHOT_ID_MISSING',
  );
});

test('R3-3 空数组合法（无镜可解，不报错、不出状态）；合法数组结果不受校验影响', () => {
  const empty = run([]);
  assert.deepEqual(empty.states, {});
  assert.deepEqual(empty.sceneConflicts, []);
  assert.match(empty.hash, /^sha256:[0-9a-f]{64}$/);
  // 去掉 filter 后排序仍稳定：同一批输入两次求解结果相同
  const a = run(rows());
  const b = run(rows());
  assert.equal(a.hash, b.hash);
  assert.deepEqual(a.states, b.states);
});

test('R3-4 assertSolverInput 可直接当组装层的门用（同一份判据，不复制）', () => {
  assert.throws(
    () => assertSolverInput({ shots: [null], sceneKey: SCENE }),
    (e) => e.reason === 'SHOT_INPUT_INVALID',
  );
  // 非数组时让上层（solveContinuity）先报它自己的错，此处不越权
  assert.doesNotThrow(() => assertSolverInput({ shots: undefined, sceneKey: SCENE }));
});

// ══ R4 unknown 继承语义（只核规范 + 锁定现状，不改语义）════════════════════

test('R4-1 规范已定义的一半：missing 的 unknown 只影响本镜，state_out 仍 carried+known', () => {
  // D01-04 §5.7 Step 2/3：本镜 pos 缺失 → 本镜不判跳变，state_out 沿用且 rel 保持 known
  const r = run(inheritRows());
  assert.equal(r.states.b.meta['chars.c1.pos'].rel, 'known');
  assert.equal(r.states.b.meta['chars.c1.pos'].src, 'carried:a');
  // 下一镜照常继承，且置信度按次数衰减（0.95 → 0.855 → 0.77），不会重复衰减也不会归零
  assert.equal(r.states.c.meta['chars.c1.pos'].src, 'carried:a');
  assert.equal(r.states.c.meta['chars.c1.pos'].conf, 0.77);
});

test('R4-2 规范未定义的一半：显式 `unknown` 会沿链传播 —— 本轮锁定现状，待定案', () => {
  const mk = (meta) => {
    const shots = inheritRows();
    if (meta) shots[1].meta = meta;
    return run(shots);
  };
  const plain = mk(undefined);
  const marked = mk({ 'chars.c1.pos': { rel: 'unknown' } });

  // 现状：本镜值不予采信（rel=unknown，值仍沿用 a），但这条 unknown 会**继续传给下一镜**
  assert.equal(marked.states.b.meta['chars.c1.pos'].rel, 'unknown');
  assert.deepEqual(marked.states.b.out.chars.c1.pos, plain.states.b.out.chars.c1.pos);
  assert.equal(plain.states.c.meta['chars.c1.pos'].rel, 'known');
  assert.equal(marked.states.c.meta['chars.c1.pos'].rel, 'unknown');

  // 两轮求解完全一致 → 这是**语义分歧**，不是抖动，所以不能当 bug 顺手改掉
  assert.deepEqual(mk({ 'chars.c1.pos': { rel: 'unknown' } }).states, marked.states);
});

test('R4-3 `unknown` 只影响所指字段，不牵连同镜其它字段', () => {
  const shots = rows();
  shots[1].meta = { 'chars.c1.pos': { rel: 'unknown' } };
  const r = run(shots);
  assert.equal(r.states.b.meta['chars.c1.pos'].rel, 'unknown');
  // posture 未被标注 → 仍按 spec_source 得 inferred / 继承 known，不受 pos 牵连
  assert.notEqual(r.states.b.meta['chars.c1.posture'].rel, 'unknown');
});
