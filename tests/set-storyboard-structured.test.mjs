// P10-A 阶段 B · B-06：`set_storyboard` 的结构化分支
//
// 锁五件事：
//   ① `structured_spec=1` 的项目写 `story_shots`，**不产生 legacy `shots` 行**；
//   ② `structured_spec=0` 的项目行为完全不变（照旧写 `shots`）；
//   ③ 开关只经 `isStructuredSpec()` 判定（`=== true` 会把 0/1 数字判成 false，静默走旧链）；
//   ④ 项目行读不到 ⇒ fail-closed（不猜模式）；
//   ⑤ 整批写入在一个 `txProject` 里，任一镜失败全批回滚。
//
// 另锁两条边界：不建生成段（`segment_id` 恒空）、资产引用不落 `shot_assets`（B-03 是独立入口）。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-b06-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;
delete process.env.IC_DB;
delete process.env.DATABASE_URL;

const core = await import('../lib/core/index.js');
const { createToolRuntime, runTool } = await import('../lib/agent/tools.js');
const { setStructuredSpec, isStructuredSpec } = await import('../lib/core/structured-spec.js');
const { upsertSceneStates } = await import('../lib/core/scene-state.js');

const { getDb } = core;
const db = getDb();

let seq = 0;
/** 锁档（G0 六项锁 + 节拍）——`set_storyboard` 的硬前置，两种模式都要先写 */
const plan = (chapter) => ({
  chapter,
  mode: 'Ref2VA',
  aspect: '16:9',
  base: 'BASE_LIVE',
  assetMode: 'M2',
  seam: 'hard_cut',
  anchors: { positions: ['罗克珊：病床右侧，面向左'], directions: ['窗在画左'] },
  beats: [{ emotion: '紧张', type: '紧张上升', intensity: 6, durationSec: 8, shotRange: '1-2', beatFunction: '钩子' }],
});

function mkProject(name, { structured }) {
  seq += 1;
  const p = core.Projects.create({ name: `${name}-${seq}` });
  if (structured) setStructuredSpec(p.id, true);
  const chapter = core.Chapters.list(p.id)[0];
  const scene = core.Assets.create(p.id, { category: 'scene', name: `病房-${seq}` });
  upsertSceneStates(p.id, chapter, [{ scene_key: 'S01_病房', scene_id: scene.id }]);
  return { p, chapter, scene };
}

const storyShots = (pid) => db.prepare('SELECT * FROM story_shots WHERE project_id = ? ORDER BY global_no').all(pid);
const legacyShots = (pid) => db.prepare('SELECT * FROM shots WHERE project_id = ?').all(pid);

// `set_storyboard` 的另一道硬门禁是「必读 reference 已加载」。这里直接把它标成已加载，
// 因为本文件测的是**写入链路走向**（story_shots vs shots），不是技能加载门禁本身 ——
// 那道门禁有它自己的用例（未加载时拒绝），本轮不动它。
const H3_REFS = ['00-framework-adapter.md', 'pipeline.md', 'camera-four-axis-h3.md', 'h3-shot-grammar.md',
  'spatial-anchor-and-hold.md', 'dialogue-density.md', 'checklist.md', 'h3-constraints-qc.md'];
function mkCtx(runtime) {
  const ctx = runtime;
  for (const r of H3_REFS) ctx.loadedRefs.add('forest-laoli-h3/' + r);
  return ctx;
}

// ── 1. 结构化项目写 story_shots，不写 legacy shots ─────────────────────
test('B06-01 结构化项目 set_storyboard → 只写 story_shots，legacy shots 零行', async () => {
  const { p, scene } = mkProject('B0601', { structured: true });
  const ctx = mkCtx(createToolRuntime({ projectId: p.id }));
  assert.equal(isStructuredSpec(p.id), true, '开关必须是 1（数字），不是布尔 true');
  await runTool(ctx, 'set_storyboard_plan', plan('第1章'));
  const out = await runTool(ctx, 'set_storyboard', { chapter: '第1章',
    shots: [
      { idx: 1, scene_name: 'S01_病房', visual: '病房冷光，罗克珊侧卧', camera: '中景，正面平视', characters: ['无'], duration: 4, sub_shots: '一镜' },
      { idx: 2, scene_name: 'S01_病房', visual: '她盯着门', camera: '近景，侧面 45°', characters: ['无'], duration: 4, sub_shots: '一镜' },
    ],
  });
  assert.match(out, /Stage 3/);
  assert.match(out, /不可出片/, '返回值必须显式声明结构化项目暂不可出片');

  const rows = storyShots(p.id);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.shot_no), [1, 2]);
  assert.deepEqual(rows.map((r) => r.global_no), [1, 2]);
  assert.deepEqual(legacyShots(p.id), [], '结构化项目不得产生 legacy shots 行');

  // scene_uid 必须来自真实场次基线行（不是题目里的 scene_key 猜出来的）
  const st = db.prepare('SELECT id FROM scene_states WHERE project_id = ? AND scene_key = ?').get(p.id, 'S01_病房');
  assert.equal(rows[0].scene_uid, st.id);
  assert.equal(rows[1].scene_uid, st.id);

  // 不建生成段：segment_id 必须是空串（C 阶段投影时才分配）
  assert.deepEqual(rows.map((r) => r.segment_id), ['', '']);

  // 资产引用不落 shot_assets（B-03 是独立入口，这里不越权）
  const sa = db.prepare('SELECT COUNT(*) AS c FROM shot_assets WHERE shot_id IN (?,?)').get(rows[0].id, rows[1].id).c;
  assert.equal(sa, 0, '结构化分支不写 shot_assets（返回值已回报）');

  // A2 审计：两条 create，归属来自真实行
  const logs = core.listChanges(p.id, { entity: 'story_shot', limit: 50 });
  assert.equal(logs.length, 2);
  assert.deepEqual(logs.map((l) => l.action), ['create', 'create']);
  assert.ok(logs.every((l) => l.project_id === p.id));
});

// ── 2. 内容落进对的列 ──────────────────────────────────────────────────
test('B06-02 camera 落 cam_note、duration 落 story_duration（不得静默丢字段）', async () => {
  const { p } = mkProject('B0602', { structured: true });
  const ctx = mkCtx(createToolRuntime({ projectId: p.id }));
  await runTool(ctx, 'set_storyboard_plan', plan('第1章'));
  await runTool(ctx, 'set_storyboard', { chapter: '第1章',
    shots: [{ idx: 1, scene_name: 'S01_病房', visual: '画面A', camera: '中景，正面平视', dialogue: '你来了。', narration: '旁白A', characters: ['无'], duration: 5, sub_shots: '一镜' }],
  });
  const [r] = storyShots(p.id);
  assert.equal(r.cam_note, '中景，正面平视', 'camera 必须落 cam_note（不在写白名单里就会被静默丢弃）');
  assert.equal(r.story_duration, 5);
  assert.equal(r.visual_content, '画面A');
  assert.equal(r.dialogue, '你来了。');
  assert.equal(r.narration, '旁白A');
  assert.equal(r.spec_source, 'ai');
});

// ── 3. legacy 项目行为不变 ─────────────────────────────────────────────
test('B06-03 legacy 项目（structured_spec=0）行为不变：写 shots、不写 story_shots', async () => {
  const { p } = mkProject('B0603', { structured: false });
  const ctx = mkCtx(createToolRuntime({ projectId: p.id }));
  assert.equal(isStructuredSpec(p.id), false);
  await runTool(ctx, 'set_storyboard_plan', plan('第1章'));
  await runTool(ctx, 'set_storyboard', { chapter: '第1章',
    shots: [
      { idx: 1, visual: 'cold ward, she lies on her side', camera: 'medium shot, eye level', characters: ['无'], duration: 4, sub_shots: 'one take' },
      { idx: 2, visual: 'she stares at the door', camera: 'close-up, 45 degree side', characters: ['无'], duration: 4, sub_shots: 'one take' },
    ],
  });
  const legacy = legacyShots(p.id);
  assert.equal(legacy.length, 2, 'legacy 项目必须照旧写 shots');
  assert.deepEqual(legacy.map((s) => s.idx), [1, 2]);
  assert.equal(storyShots(p.id).length, 0, 'legacy 项目不得写 story_shots');
});

// ── 4. 整批回滚 ────────────────────────────────────────────────────────
test('B06-04 第二镜的场次没有基线 ⇒ 整批拒绝（第一镜也不得落库）', async () => {
  const { p } = mkProject('B0604', { structured: true });
  const ctx = mkCtx(createToolRuntime({ projectId: p.id }));
  await runTool(ctx, 'set_storyboard_plan', plan('第1章'));
  await assert.rejects(
    () => runTool(ctx, 'set_storyboard', { chapter: '第1章',
      shots: [
        { idx: 1, scene_name: 'S01_病房', visual: 'A', camera: '中景，正面平视', characters: ['无'], duration: 4, sub_shots: '一镜' },
        { idx: 2, scene_name: 'S99_不存在的场次', visual: 'B', camera: '近景，侧面', characters: ['无'], duration: 4, sub_shots: '一镜' },
      ],
    }),
    /还没有空间基线/,
  );
  assert.equal(storyShots(p.id).length, 0, '第一镜必须随第二镜的失败一起回滚');
});

// ── 5. 场次无法确定 ⇒ 拒绝（不拼串猜）─────────────────────────────────
test('B06-05 没给 scene_name 且 scenes 有两个 ⇒ 拒绝，不得拼成一个假场次', async () => {
  const { p } = mkProject('B0605', { structured: true });
  const ctx = mkCtx(createToolRuntime({ projectId: p.id }));
  await runTool(ctx, 'set_storyboard_plan', plan('第1章'));
  await assert.rejects(
    () => runTool(ctx, 'set_storyboard', { chapter: '第1章',
      shots: [{ idx: 1, scenes: ['S01_病房', 'S02_走廊'], visual: 'A', camera: '中景', characters: ['无'], duration: 4, sub_shots: '一镜' }],
    }),
    /无法确定场次/,
  );
  assert.equal(storyShots(p.id).length, 0);
});

// ── 6. 项目行读不到 ⇒ fail-closed ─────────────────────────────────────
test('B06-06 项目不存在 / 模式不可读 ⇒ 拒绝写入（不猜 structured_spec）', async () => {
  const fakeCtx = { projectId: 'no-such-project', project: null, report() {}, isAborted: () => false };
  await assert.rejects(
    () => runTool(fakeCtx, 'set_storyboard', { shots: [{ idx: 1, visual: 'x' }] }),
    /项目不存在或不可读/,
  );
});

// ── 7. 省略 idx 时按 story_shots 续号（不覆盖已有镜）────────────────────
test('B06-07 省略 idx 时按 story_shots 的最大镜号续号，不覆盖第 1 镜', async () => {
  const { p } = mkProject('B0607', { structured: true });
  const ctx = mkCtx(createToolRuntime({ projectId: p.id }));
  await runTool(ctx, 'set_storyboard_plan', plan('第1章'));
  await runTool(ctx, 'set_storyboard', { chapter: '第1章',
    shots: [
      { idx: 1, scene_name: 'S01_病房', visual: '第一镜', camera: '中景，正面平视', characters: ['无'], duration: 4, sub_shots: '一镜' },
      { idx: 2, scene_name: 'S01_病房', visual: '第二镜', camera: '近景，侧面', characters: ['无'], duration: 4, sub_shots: '一镜' },
    ],
  });
  await runTool(ctx, 'set_storyboard', { chapter: '第1章',
    shots: [{ scene_name: 'S01_病房', visual: '自动续号', camera: '全景，俯拍', characters: ['无'], duration: 4, sub_shots: '一镜' }],
  });
  const rows = storyShots(p.id);
  assert.deepEqual(rows.map((r) => r.shot_no), [1, 2, 3], '省略 idx 必须续到 3，而不是回到 1 覆盖');
  assert.deepEqual(rows.map((r) => r.global_no), [1, 2, 3]);
  assert.equal(rows[0].visual_content, '第一镜', '第 1 镜不得被覆盖');
});

// ── 8. clear 只清本章的 story_shots ────────────────────────────────────
test('B06-08 clear 清空本章 story_shots，且不碰 legacy shots', async () => {
  const { p } = mkProject('B0608', { structured: true });
  const ctx = mkCtx(createToolRuntime({ projectId: p.id }));
  await runTool(ctx, 'set_storyboard_plan', plan('第1章'));
  await runTool(ctx, 'set_storyboard', { chapter: '第1章',
    shots: [
      { idx: 1, scene_name: 'S01_病房', visual: '旧1', camera: '中景', characters: ['无'], duration: 4, sub_shots: '一镜' },
      { idx: 2, scene_name: 'S01_病房', visual: '旧2', camera: '近景', characters: ['无'], duration: 4, sub_shots: '一镜' },
    ],
  });
  assert.equal(storyShots(p.id).length, 2);
  const out = await runTool(ctx, 'set_storyboard', { chapter: '第1章',
    clear: true,
    shots: [{ idx: 1, scene_name: 'S01_病房', visual: '新1', camera: '中景', characters: ['无'], duration: 4, sub_shots: '一镜' }],
  });
  assert.match(out, /清空本章旧镜 2 条/);
  const rows = storyShots(p.id);
  assert.deepEqual(rows.map((r) => r.visual_content), ['新1']);
  assert.deepEqual(legacyShots(p.id), [], 'clear 不得触碰 legacy shots');
  // 删除也留审计（A2 delete）
  const del = core.listChanges(p.id, { entity: 'story_shot', action: 'delete', limit: 50 });
  assert.equal(del.length, 2);
});

// ── 9. 模块层不接线 C 阶段 ─────────────────────────────────────────────
test('B06-09 结构化写入后 render_units / render_unit_shots 仍为零行（未提前实现投影）', async () => {
  const { p } = mkProject('B0609', { structured: true });
  const ctx = mkCtx(createToolRuntime({ projectId: p.id }));
  await runTool(ctx, 'set_storyboard_plan', plan('第1章'));
  await runTool(ctx, 'set_storyboard', { chapter: '第1章',
    shots: [{ idx: 1, scene_name: 'S01_病房', visual: 'A', camera: '中景', characters: ['无'], duration: 4, sub_shots: '一镜' }],
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM render_units WHERE project_id = ?').get(p.id).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM render_adaptations WHERE project_id = ?').get(p.id).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM render_unit_shots').get().c, 0);
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 占用中 */ } });
