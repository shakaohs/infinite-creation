// 阶段 3 · P2：场次基线与剧本抽取权限（D02-06 §4.8 / §4.8.3 SC-01~SC-07、§4.8.5 PS-01~PS-06）
//
// 这一组测的是两件事：
//   ① 「行存在 ≠ 空间已定义」—— 允许建行、禁止编造几何（SC 系列）
//   ② 「描述不拦人」—— 写权限必须由**工具池 + 运行时 ctx.toolSet + schema 无 stage 字段**三层落地（PS 系列）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-p2-scene-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;

const { getDb, Projects, Assets, Chapters } = await import('../lib/core/db.js');
const { createUserProject } = await import('../lib/core/project-create.js');
const { upsertSceneStates, assertSceneKeysExist, listSceneStates } = await import('../lib/core/scene-state.js');
const { runTool, createToolRuntime, TOOL_DEFINITIONS } = await import('../lib/agent/tools.js');
const { buildMcpTools } = await import('../lib/agent/openclaude-agent.js');

const db = getDb();
const rowsOf = (projectId) => db.prepare('SELECT * FROM scene_states WHERE project_id = ? ORDER BY scene_key').all(projectId);
const countOf = (projectId) => rowsOf(projectId).length;
const toolNames = (defs) => defs.map((t) => (t.name || t.function?.name));

let seq = 0;
/** 建一个用户项目（默认结构化开启）+ 一个场景资产，返回常用句柄 */
function setup(name = '场次') {
  seq += 1;
  const p = createUserProject({ name: `${name}-${seq}` });
  const chapter = Chapters.list(p.id)[0];
  const scene = Assets.create(p.id, { category: 'scene', name: '病房-' + seq });
  return { p, chapter, scene, projectId: p.id };
}
const scriptCtx = (projectId) => createToolRuntime({ projectId, jobId: 'job-' + seq, toolSet: 'script' });
const boardCtx = (projectId, toolSet) => createToolRuntime({ projectId, jobId: 'job-' + seq, toolSet });

// ── SC-01 ───────────────────────────────────────────────────────────────
test('SC-01 同一 scene_id 两个不同 scene_key → 两条独立场次，axis_lock 各自独立', () => {
  const { p, chapter, scene } = setup('SC01');
  const r = upsertSceneStates(p.id, chapter, [
    { scene_key: 'S02_病房', scene_id: scene.id, axis_lock: { pair: '罗克珊/哈罗德', axis_line: '病床-窗' } },
    { scene_key: 'S05_病房', scene_id: scene.id, axis_lock: { pair: '凯森/哈罗德' } },
  ]);
  assert.equal(r.created, 2);
  const rows = rowsOf(p.id);
  assert.equal(rows.length, 2, '同一场景资产可以承载多个场次实例');
  assert.deepEqual(rows.map((x) => x.scene_id), [scene.id, scene.id]);
  assert.deepEqual(rows.map((x) => x.scene_key), ['S02_病房', 'S05_病房']);
  const axis = rows.map((x) => JSON.parse(x.axis_lock));
  assert.equal(axis[0].axis_line, '病床-窗');
  assert.equal(axis[1].axis_line, undefined, '两个场次的轴线必须各自独立，不得互相继承');
  assert.deepEqual(rows.map((x) => x.state_rev), [1, 1]);
});

// ── SC-02 ───────────────────────────────────────────────────────────────
test('SC-02 scene_id 指向其他项目的场景资产 → SCENE_ASSET_NOT_FOUND，且一行不写', () => {
  const a = setup('SC02-A');
  const b = setup('SC02-B');
  const before = countOf(a.projectId);
  assert.throws(
    () => upsertSceneStates(a.projectId, a.chapter, [{ scene_key: 'S01_借用', scene_id: b.scene.id }]),
    (e) => e.code === 'SCENE_ASSET_NOT_FOUND',
  );
  assert.equal(countOf(a.projectId), before, '被拒后本项目不得留下任何场次行');
  assert.equal(countOf(b.projectId), 0);
});

// ── SC-03 ───────────────────────────────────────────────────────────────
test('SC-03 重写同一 scene_key → 仍只有一行，state_rev 逐次 +1', () => {
  const { p, chapter, scene } = setup('SC03');
  upsertSceneStates(p.id, chapter, [{ scene_key: 'S02_病房', scene_id: scene.id, time_of_day: '日' }]);
  assert.equal(countOf(p.id), 1);
  assert.equal(rowsOf(p.id)[0].state_rev, 1);

  const r2 = upsertSceneStates(p.id, chapter, [{ scene_key: 'S02_病房', axis_lock: { pair: 'A/B' } }]);
  assert.equal(r2.updated, 1);
  let rows = rowsOf(p.id);
  assert.equal(rows.length, 1, '幂等键是 (project_id, scene_key)，不得产生第二行');
  assert.equal(rows[0].state_rev, 2);
  assert.equal(rows[0].time_of_day, '日', '本次没给的字段必须保留（局部重写不误删）');

  upsertSceneStates(p.id, chapter, [{ scene_key: 'S02_病房', time_of_day: '夜' }]);
  rows = rowsOf(p.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state_rev, 3);
  assert.equal(rows[0].time_of_day, '夜');
});

// ── SC-04 ───────────────────────────────────────────────────────────────
test('SC-04 fixtures[].zone 非法 → FIXTURE_ZONE_INVALID（三个数 / 越界 / x1>=x2 都拒）', () => {
  const { p, chapter } = setup('SC04');
  const cases = [
    { name: '三个数', fixtures: [{ name: '门', zone: [0.1, 0.2, 0.3] }] },
    { name: 'x1>x2', fixtures: [{ name: '门', zone: [0.6, 0.1, 0.2, 0.5] }] },
    { name: 'y1>y2', fixtures: [{ name: '门', zone: [0.1, 0.8, 0.4, 0.2] }] },
    { name: '超界', fixtures: [{ name: '门', zone: [0.1, 0.2, 1.4, 0.5] }] },
    { name: '非数字', fixtures: [{ name: '门', zone: [0.1, 0.2, 'x', 0.5] }] },
  ];
  for (const c of cases) {
    assert.throws(
      () => upsertSceneStates(p.id, chapter, [{ scene_key: 'S01_' + c.name, fixtures: c.fixtures }]),
      (e) => e.code === 'FIXTURE_ZONE_INVALID',
      c.name + ' 必须被拒',
    );
  }
  assert.equal(countOf(p.id), 0, '任一非法 zone 都应让整批回滚');

  // 正向：合法 zone 可写；缺 zone 也允许（固定物知道、位置不知道 → 不编造）
  upsertSceneStates(p.id, chapter, [{ scene_key: 'S01_合法', fixtures: [{ name: '门', zone: [0.1, 0.2, 0.4, 0.6] }, { name: '窗' }] }]);
  assert.equal(countOf(p.id), 1);
});

// ── SC-05 ───────────────────────────────────────────────────────────────
test('SC-05 缺 axis_line → 允许落库，但必须标记不完整（AXIS_LOCK_INCOMPLETE / S-05、S-06 不可验证）', () => {
  const { p, chapter } = setup('SC05');
  const r = upsertSceneStates(p.id, chapter, [{ scene_key: 'S02_病房', axis_lock: { pair: 'A/B', left: 'A', right: 'B' } }]);
  const notes = r.scenes[0].qc_notes;
  const codes = notes.map((n) => n.code);
  assert.ok(codes.includes('AXIS_LOCK_INCOMPLETE'), '缺 axis_line 必须记 AXIS_LOCK_INCOMPLETE：' + codes.join(','));
  assert.equal(notes.find((n) => n.code === 'AXIS_LOCK_INCOMPLETE').level, 'warn');
  const unver = notes.find((n) => n.code === 'AXIS_UNVERIFIED');
  assert.ok(unver, '缺 axis_line 时 S-05/S-06 必须标记为不可验证');
  assert.deepEqual(unver.rules, ['S-05', 'S-06']);
  assert.equal(unver.level, 'info');

  const row = rowsOf(p.id)[0];
  assert.equal(row.state_rev, 1, '不完整的轴线仍然要落库（存在事实成立）');
  const axis = JSON.parse(row.axis_lock);
  assert.equal(axis.axis_line, undefined, '绝不能凭空补一个 axis_line');
  assert.equal(axis.pair, 'A/B', '已确定的字段要保留');

  // 反向：给了 axis_line 就不该报不完整
  const r2 = upsertSceneStates(p.id, chapter, [{ scene_key: 'S03_有轴', axis_lock: { axis_line: '门-窗' } }]);
  assert.equal(r2.scenes[0].qc_notes.some((n) => n.code === 'AXIS_LOCK_INCOMPLETE'), false);
});

// ── SC-06 ───────────────────────────────────────────────────────────────
test('SC-06 镜引用不存在的 scene_key → SCENE_STATE_MISSING，且不得自动建空行', () => {
  const { p, chapter } = setup('SC06');
  upsertSceneStates(p.id, chapter, [{ scene_key: 'S02_病房' }]);
  const before = countOf(p.id);

  assert.throws(
    () => assertSceneKeysExist(p.id, ['S02_病房', 'S99_不存在']),
    (e) => e.code === 'SCENE_STATE_MISSING' && e.detail.missing.join() === 'S99_不存在',
  );
  assert.equal(countOf(p.id), before, '"为了满足外键而自动建空场次"是明确禁止的：行数不得变化');
  assert.equal(listSceneStates(p.id).find((s) => s.scene_key === 'S99_不存在'), undefined);
  assert.deepEqual(assertSceneKeysExist(p.id, ['S02_病房']), { ok: true, missing: [] });

  // 边界说明（不伪造通过）：把 SCENE_STATE_MISSING 接到 set_storyboard（只拒该镜、同批其余镜照常写）
  // 属 P8 的分镜写入工具；P8 未落地前这里只验证"基线前置判定"本身。
});

// ── SC-07 ───────────────────────────────────────────────────────────────
test('SC-07 虚拟场次（scene_id 为空）+ 自包含 fixtures → 允许建立', () => {
  const { p, chapter } = setup('SC07');
  const r = upsertSceneStates(p.id, chapter, [{
    scene_key: 'S07_回忆里的走廊',
    scene_id: '',
    fixtures: [{ name: '走廊尽头的光', zone: [0.4, 0.4, 0.6, 0.6] }],
  }]);
  assert.equal(r.created, 1);
  const row = rowsOf(p.id)[0];
  assert.equal(row.scene_id, '', '虚拟场次的 scene_id 就是空串，不要假装有场景资产');
  assert.equal(JSON.parse(row.fixtures).length, 1);
});

// ── PS-01 ───────────────────────────────────────────────────────────────
test('PS-01 toolSet=script 的工具池包含 set_scene_state', () => {
  const names = toolNames(buildMcpTools({ projectId: 'p', jobId: 'j', toolSet: 'script', report: () => {}, logAppend: () => {} }));
  assert.ok(names.includes('set_scene_state'), '剧本抽取池必须能写场次基线');
  // 反面：这个池里不能有分镜写入工具（否则剧本抽取阶段能越界写镜）
  for (const n of ['set_storyboard', 'set_storyboard_plan', 'update_shot']) {
    assert.equal(names.includes(n), false, n + ' 不得出现在剧本抽取池');
  }
});

// ── PS-02 ───────────────────────────────────────────────────────────────
test('PS-02 opuscar / novel / 缺省（分镜创作）工具池都不含 set_scene_state', () => {
  const pools = {
    opuscar: toolNames(buildMcpTools({ projectId: 'p', jobId: 'j', toolSet: 'opuscar', report: () => {}, logAppend: () => {} })),
    novel: toolNames(buildMcpTools({ projectId: 'p', jobId: 'j', toolSet: 'novel', report: () => {}, logAppend: () => {} })),
    default: toolNames(buildMcpTools({ projectId: 'p', jobId: 'j', report: () => {}, logAppend: () => {} })),
  };
  for (const [k, names] of Object.entries(pools)) {
    assert.ok(names.length > 0, k + ' 池不应为空');
    assert.equal(names.includes('set_scene_state'), false, k + ' 池不得包含 set_scene_state');
  }
});

// ── PS-03 ───────────────────────────────────────────────────────────────
test('PS-03 不设 ctx.toolSet 直接调工具 → SCENE_STATE_WRITE_FORBIDDEN，库不变', async () => {
  const { p, chapter } = setup('PS03');
  const ctx = createToolRuntime({ projectId: p.id, jobId: 'job-ps03' });   // 故意不传 toolSet
  const before = countOf(p.id);
  await assert.rejects(
    () => runTool(ctx, 'set_scene_state', { chapter: chapter.title, scenes: [{ scene_key: 'S01_偷写' }] }),
    (e) => e.code === 'SCENE_STATE_WRITE_FORBIDDEN',
  );
  assert.equal(countOf(p.id), before, '被拒时一行都不许写');
});

// ── PS-04 ───────────────────────────────────────────────────────────────
test('PS-04 ctx.toolSet=storyboard 调同一工具 → 被拒，行数与 state_rev 逐字不变', async () => {
  const { p, chapter } = setup('PS04');
  // 先合法写一条，确认被拒时连原有行的 state_rev 都不动
  upsertSceneStates(p.id, chapter, [{ scene_key: 'S02_病房', time_of_day: '日' }]);
  const before = rowsOf(p.id);
  const ctx = boardCtx(p.id, 'storyboard');
  await assert.rejects(
    () => runTool(ctx, 'set_scene_state', { chapter: chapter.title, scenes: [{ scene_key: 'S02_病房', time_of_day: '夜' }] }),
    (e) => e.code === 'SCENE_STATE_WRITE_FORBIDDEN',
  );
  assert.deepEqual(rowsOf(p.id), before, '分镜创作阶段写 scene_states 必须完全无效');
});

// ── PS-05 ───────────────────────────────────────────────────────────────
test('PS-05 分镜创作权限下夹带 stage 参数 → unknown-args 拦截，库不变', async () => {
  const { p, chapter } = setup('PS05');
  const ctx = boardCtx(p.id, 'storyboard');
  const before = countOf(p.id);
  const raw = await runTool(ctx, 'set_scene_state', {
    chapter: chapter.title,
    scenes: [{ scene_key: 'S01_自报阶段' }],
    stage: 'script_extraction',          // 模型自报阶段：必须无效
  });
  const r = JSON.parse(raw);
  assert.equal(r.blocked, true);
  assert.equal(r.rule, 'unknown-args', 'schema 里没有 stage，这一层就必须先把它拦掉');
  assert.match(r.message, /stage/);
  assert.equal(countOf(p.id), before, 'unknown-args 拦截后不得有任何写入');

  // L3 的结构性前提：set_scene_state 的 schema 里确实没有 stage（防止有人"顺手加个便利参数"）
  const def = TOOL_DEFINITIONS.find((t) => t.function.name === 'set_scene_state');
  assert.ok(def, 'set_scene_state 必须在 TOOL_DEFINITIONS 里');
  assert.equal('stage' in (def.function.parameters.properties || {}), false, 'schema 不得声明 stage');
  assert.deepEqual(def.function.parameters.required, ['chapter', 'scenes']);
});

// ── PS-06 ───────────────────────────────────────────────────────────────
test('PS-06 合法 toolSet=script 调用成功：首次 state_rev=1，幂等重写递增', async () => {
  const { p, chapter, scene } = setup('PS06');
  const ctx = scriptCtx(p.id);
  const out1 = JSON.parse(await runTool(ctx, 'set_scene_state', {
    chapter: chapter.title,
    scenes: [{ scene_key: 'S02_病房', scene_id: scene.id, axis_lock: { axis_line: '病床-窗' } }],
  }));
  assert.equal(out1.created, 1);
  assert.equal(out1.scenes[0].state_rev, 1);
  assert.equal(out1.scenes[0].incomplete.axis_lock, false);

  const out2 = JSON.parse(await runTool(ctx, 'set_scene_state', {
    chapter: chapter.title,
    scenes: [{ scene_key: 'S02_病房', time_of_day: '夜' }],
  }));
  assert.equal(out2.updated, 1);
  assert.equal(out2.scenes[0].state_rev, 2);
  assert.equal(countOf(p.id), 1, '重写不得产生第二行');
});

// ── 附加：不得越界写别的表（PS-D 的边界）──
test('P2 边界：set_scene_state 只写 scene_states，不碰 story_shots / shot_actions / 资产', async () => {
  const { p, chapter, scene } = setup('BOUND');
  const before = {
    shots: db.prepare('SELECT COUNT(*) n FROM story_shots WHERE project_id = ?').get(p.id).n,
    actions: db.prepare('SELECT COUNT(*) n FROM shot_actions a JOIN story_shots s ON s.id=a.shot_id WHERE s.project_id = ?').get(p.id).n,
    assets: db.prepare('SELECT COUNT(*) n FROM assets WHERE project_id = ?').get(p.id).n,
  };
  await runTool(scriptCtx(p.id), 'set_scene_state', { chapter: chapter.title, scenes: [{ scene_key: 'S01_边界', scene_id: scene.id }] });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM story_shots WHERE project_id = ?').get(p.id).n, before.shots);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM shot_actions a JOIN story_shots s ON s.id=a.shot_id WHERE s.project_id = ?').get(p.id).n, before.actions);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM assets WHERE project_id = ?').get(p.id).n, before.assets);
});

// ── PS-C 入口：只验证"起任务前的参数校验"，不触发真实 LLM 调用 ──
// 说明（不伪造通过）：剧本抽取任务的端到端（真的让模型读完正文再落库）需要可用的 LLM 凭据与一次真实调用，
// 测试里不跑。工具池与写权限已由 PS-01~PS-06 覆盖；这里只钉住"入口不会拿空参数起任务"。
test('PS-C-1 startScriptExtractJob 参数校验：项目不存在 / 缺章节都在建任务之前抛', async () => {
  const { startScriptExtractJob } = await import('../lib/agent/job-runner.js');
  assert.throws(() => startScriptExtractJob({ projectId: 'no-such-project', chapter: '第1章' }), /项目不存在/);
  const { p } = setup('PSC');
  assert.throws(
    () => startScriptExtractJob({ projectId: p.id, chapter: '' }),
    (e) => e.code === 'CHAPTER_REQUIRED',
  );
  // 两次拒绝都不应留下任务行
  const { Jobs } = await import('../lib/core/db.js');
  assert.equal(Jobs.list(p.id).length, 0, '参数不合法时不得建 job');
});

// ── FLAG-01：§4.2 D-4「每个新写入口自己判一次 flag」──
test('FLAG-01 项目未开启结构化（structured_spec=0）→ STRUCTURED_SPEC_DISABLED，库不变', async () => {
  const { setStructuredSpec } = await import('../lib/core/structured-spec.js');
  const p = createUserProject({ name: 'FLAG-01', structured_spec: false });
  const chapter = Chapters.list(p.id)[0];
  const ctx = createToolRuntime({ projectId: p.id, jobId: 'job-flag', toolSet: 'script' });
  const before = countOf(p.id);
  await assert.rejects(
    () => runTool(ctx, 'set_scene_state', { chapter: chapter.title, scenes: [{ scene_key: 'S01_关着开关' }] }),
    (e) => e.code === 'STRUCTURED_SPEC_DISABLED',
  );
  assert.equal(countOf(p.id), before, 'flag 关闭时不得写任何场次行');

  // 打开后同一个调用即可成功（权限与 flag 是两道独立的闸）
  setStructuredSpec(p.id, true);
  const out = JSON.parse(await runTool(ctx, 'set_scene_state', { chapter: chapter.title, scenes: [{ scene_key: 'S01_关着开关' }] }));
  assert.equal(out.created, 1);
});
