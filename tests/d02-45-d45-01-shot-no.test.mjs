// D45-01 · 结构化镜号分配安全性（`writeStructuredStoryboard`）
//
// 修的是三处真实的号分配缺陷：
//   ① `MAX(shot_no)` 在 `txProject` **外面**读 —— 两个并发追加读到同一个 MAX，分配出同一个号；
//   ② 只按「本批显式 idx」当上限 —— 「已有 1~3，本次显式更新 1，同时自动追加一镜」会算出 2，
//      **覆盖既有的第 2 镜**。显式 idx 表达的是"更新谁"，不是"现在最大到几"；
//   ③ `clear` 改变章内既有镜集合，MAX 必须在 clear **之后**读。
//
// 并发用例走独立子进程：SQLite 是同步驱动，同进程两个事务天然串行，做不出真正的交错。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-d4501-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;
delete process.env.IC_DB;
delete process.env.DATABASE_URL;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'tests', 'helpers', 'storyboard-worker.mjs');

const core = await import('../lib/core/index.js');
const { createToolRuntime, runTool } = await import('../lib/agent/tools.js');
const { setStructuredSpec } = await import('../lib/core/structured-spec.js');
const { upsertSceneStates } = await import('../lib/core/scene-state.js');
const { getDb } = core;

const db = getDb();
const H3_REFS = ['00-framework-adapter.md', 'pipeline.md', 'camera-four-axis-h3.md', 'h3-shot-grammar.md',
  'spatial-anchor-and-hold.md', 'dialogue-density.md', 'checklist.md', 'h3-constraints-qc.md'];

let seq = 0;
const plan = () => ({
  chapter: '第1章', mode: 'Ref2VA', aspect: '16:9', base: 'BASE_LIVE', assetMode: 'M2', seam: 'hard_cut',
  anchors: { positions: ['罗克珊：病床右侧，面向左'], directions: ['窗在画左'] },
  beats: [{ emotion: '紧张', type: '紧张上升', intensity: 6, durationSec: 8, shotRange: '1-9', beatFunction: '钩子' }],
});

function mkProject(name) {
  seq += 1;
  const p = core.Projects.create({ name: `${name}-${seq}` });
  setStructuredSpec(p.id, true);
  const chapter = core.Chapters.list(p.id)[0];
  const scene = core.Assets.create(p.id, { category: 'scene', name: `病房-${seq}` });
  upsertSceneStates(p.id, chapter, [{ scene_key: 'S01_病房', scene_id: scene.id }]);
  return { p, chapter, scene };
}
function mkCtx(projectId) {
  const ctx = createToolRuntime({ projectId });
  for (const r of H3_REFS) ctx.loadedRefs.add('forest-laoli-h3/' + r);
  return ctx;
}
// 分镜结构机检（P1-2）要求相邻两镜不得同景别同机位，所以机位按序号轮转。
// 这跟本项要测的东西无关，只是让夹具能通过一道早于本轮就存在的门禁。
const CAMS = ['中景，正面平视', '近景，侧面 45 度', '全景，俯拍', '中近景，仰拍 30 度', '特写，正面',
  '中景，侧后方 60 度', '近景，俯拍', '全景，平视', '中近景，侧面 90 度', '特写，仰拍'];
const cam = (n) => CAMS[(Number(n) - 1) % CAMS.length];
const shot = (extra = {}) => ({
  scene_name: 'S01_病房', visual: '画面', camera: cam(extra.idx || 1), characters: ['无'], duration: 4, sub_shots: '一镜', ...extra,
});
const rows = (pid) => db.prepare('SELECT id, shot_no, global_no, visual_content FROM story_shots WHERE project_id = ? ORDER BY shot_no').all(pid);
const shotNos = (pid) => rows(pid).map((r) => Number(r.shot_no));

/** 预置 1..n 镜（走真实工具，不直接插库） */
async function seed(ctx, n) {
  await runTool(ctx, 'set_storyboard_plan', plan());
  const shots = [];
  for (let i = 1; i <= n; i += 1) {
    shots.push(shot({ idx: i, visual: `已有${i}` }));
  }
  await runTool(ctx, 'set_storyboard', { chapter: '第1章', shots });
  return shots;
}

// ── 1. 核心用例：已有 1~3，显式更新 1 + 自动追加 ⇒ 4 ────────────────────
test('D45-01-A 已有镜 1~3，显式更新 1 同时自动追加一镜 ⇒ 新镜得到 4，第 2/3 镜不被覆盖', async () => {
  const { p } = mkProject('D4501A');
  const ctx = mkCtx(p.id);
  await seed(ctx, 3);
  assert.deepEqual(shotNos(p.id), [1, 2, 3]);
  const before = rows(p.id);

  await runTool(ctx, 'set_storyboard', {
    chapter: '第1章',
    shots: [
      shot({ idx: 1, visual: '第1镜改过' }),                                  // 显式更新（机位保持 cam(1)）
      shot({ visual: '自动追加', camera: cam(4) }),                            // 自动号，机位换一档
    ],
  });

  const after = rows(p.id);
  assert.deepEqual(after.map((r) => Number(r.shot_no)), [1, 2, 3, 4], '自动号必须是 4（库内 3 之后），不是 2');
  assert.equal(after[0].visual_content, '第1镜改过');
  assert.equal(after[1].visual_content, before[1].visual_content, '第 2 镜不得被覆盖');
  assert.equal(after[2].visual_content, before[2].visual_content, '第 3 镜不得被覆盖');
  assert.equal(after[3].visual_content, '自动追加');
  assert.equal(after[3].id !== before[0].id, true, '第 4 镜必须是新行');
});

// ── 2. 已有 1~5，混合显式与自动 ────────────────────────────────────────
test('D45-01-B 已有镜 1~5，混合显式与自动 ⇒ 自动号排在 5 之后，既有镜一格不动', async () => {
  const { p } = mkProject('D4501B');
  const ctx = mkCtx(p.id);
  await seed(ctx, 5);
  const before = rows(p.id);

  await runTool(ctx, 'set_storyboard', {
    chapter: '第1章',
    shots: [
      shot({ idx: 2, visual: '第2镜改过' }),
      shot({ visual: '自动1', camera: cam(6) }),
      shot({ visual: '自动2', camera: cam(7) }),
    ],
  });

  const after = rows(p.id);
  assert.deepEqual(after.map((r) => Number(r.shot_no)), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(after[1].visual_content, '第2镜改过');
  for (const i of [0, 2, 3, 4]) {
    assert.equal(after[i].visual_content, before[i].visual_content, `第 ${i + 1} 镜不得被自动号覆盖`);
    assert.equal(after[i].id, before[i].id, `第 ${i + 1} 镜必须还是同一行`);
  }
  assert.deepEqual(after.slice(5).map((r) => r.visual_content), ['自动1', '自动2']);
});

// ── 3. 显式号大于库内 MAX：自动号必须排在它之后 ─────────────────────────
test('D45-01-C 显式追加到 9 号，同批自动号必须排在 9 之后（不是 4）', async () => {
  const { p } = mkProject('D4501C');
  const ctx = mkCtx(p.id);
  await seed(ctx, 3);

  await runTool(ctx, 'set_storyboard', {
    chapter: '第1章',
    shots: [
      shot({ idx: 9, visual: '显式九号' }),
      shot({ visual: '自动', camera: cam(10) }),
    ],
  });
  const list = shotNos(p.id);
  assert.deepEqual(list, [1, 2, 3, 9, 10], '自动号必须并进"本批显式 idx"后的上限，得 10');
});

// ── 4. 并发：两个追加请求不得拿到同一个 shot_no ────────────────────────
function runWorker(job) {
  return new Promise((resolve) => {
    const env = { ...process.env, IC_DATA_DIR: TMP, IC_SB_JOB: JSON.stringify(job) };
    delete env.NODE_TEST_CONTEXT;
    delete env.IC_DB; delete env.DATABASE_URL; delete env.PGHOST; delete env.PGPORT;
    delete env.PGUSER; delete env.PGDATABASE; delete env.PGPASSWORD;
    const child = spawn(process.execPath, [WORKER], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', () => {
      const line = out.split('\n').filter((l) => l.trim().startsWith('{')).pop();
      if (!line) { resolve({ ok: false, error: { code: 'NO_OUTPUT', message: err.slice(0, 400) } }); return; }
      try { resolve(JSON.parse(line)); } catch (e) { resolve({ ok: false, error: { code: 'BAD_JSON', message: String(e) } }); }
    });
  });
}

test('D45-01-D 两个独立进程并发追加：shot_no 不撞号、不重复、不覆盖', async () => {
  const { p } = mkProject('D4501D');
  const ctx = mkCtx(p.id);
  await seed(ctx, 3);
  const before = rows(p.id);

  const [a, b] = await Promise.all([
    runWorker({ projectId: p.id, chapter: '第1章', shots: [shot({ visual: '并发A', camera: cam(1) })], tag: 'A' }),
    runWorker({ projectId: p.id, chapter: '第1章', shots: [shot({ visual: '并发B', camera: cam(5) })], tag: 'B' }),
  ]);
  assert.equal(a.ok, true, JSON.stringify(a.error));
  assert.equal(b.ok, true, JSON.stringify(b.error));

  const after = rows(p.id);
  const nums = after.map((r) => Number(r.shot_no));
  assert.equal(nums.length, 5, '3 个既有 + 2 个并发追加');
  assert.deepEqual(nums, [1, 2, 3, 4, 5], '号必须连续且唯一');
  assert.equal(new Set(nums).size, nums.length, '不得有重复 shot_no');
  // 两个并发请求各自新增 1、更新 0（不得因为撞号走进 update 分支去改对方刚建的镜）
  assert.equal(a.added, 1, JSON.stringify(a));
  assert.equal(b.added, 1, JSON.stringify(b));
  assert.equal(a.updated, 0, '并发追加不得变成 update');
  assert.equal(b.updated, 0, '并发追加不得变成 update');
  // 既有 3 镜一格不动
  for (let i = 0; i < 3; i += 1) assert.equal(after[i].id, before[i].id, `第 ${i + 1} 镜不得被动`);
  assert.deepEqual(after.slice(3).map((r) => r.visual_content).sort(), ['并发A', '并发B']);
});

// ── 5. clear 语义 ──────────────────────────────────────────────────────
test('D45-01-E clear 之后自动号从 1 起（MAX 必须在 clear 之后读）', async () => {
  const { p } = mkProject('D4501E');
  const ctx = mkCtx(p.id);
  await seed(ctx, 3);
  assert.deepEqual(shotNos(p.id), [1, 2, 3]);

  const out = await runTool(ctx, 'set_storyboard', {
    chapter: '第1章', clear: true,
    shots: [shot({ visual: '清后自动', camera: cam(1) })],
  });
  assert.match(out, /清空本章旧镜 3 条/);
  const after = rows(p.id);
  assert.deepEqual(after.map((r) => Number(r.shot_no)), [1], 'clear 之后 MAX 是 0，自动号必须是 1');
  assert.equal(after[0].visual_content, '清后自动');
});

test('D45-01-F clear 与显式 idx 混用：先清空，再按本批显式号建', async () => {
  const { p } = mkProject('D4501F');
  const ctx = mkCtx(p.id);
  await seed(ctx, 2);
  await runTool(ctx, 'set_storyboard', {
    chapter: '第1章', clear: true,
    shots: [
      shot({ idx: 3, visual: '显式三' }),
      shot({ visual: '自动', camera: cam(4) }),
    ],
  });
  assert.deepEqual(shotNos(p.id), [3, 4], '清空后显式 3 + 自动 4');
});

// ── 6. global_no 仍在锁内分配且严格递增 ────────────────────────────────
test('D45-01-G global_no 在锁内分配：追加后仍严格递增、无重复', async () => {
  const { p } = mkProject('D4501G');
  const ctx = mkCtx(p.id);
  await seed(ctx, 3);
  await runTool(ctx, 'set_storyboard', {
    chapter: '第1章',
    shots: [shot({ visual: 'a', camera: cam(4) }), shot({ visual: 'b', camera: cam(5) })],
  });
  const g = rows(p.id).sort((x, y) => Number(x.global_no) - Number(y.global_no)).map((r) => Number(r.global_no));
  assert.deepEqual(g, [1, 2, 3, 4, 5]);
  assert.equal(new Set(g).size, g.length);
});

// ── 7. legacy 行为不变 ─────────────────────────────────────────────────
test('D45-01-H legacy 项目（structured_spec=0）的镜号语义不变：仍写 shots', async () => {
  const p = core.Projects.create({ name: 'D4501H-' + (seq += 1) });
  const ctx = mkCtx(p.id);
  await runTool(ctx, 'set_storyboard_plan', plan());
  await runTool(ctx, 'set_storyboard', {
    chapter: '第1章',
    shots: [
      { idx: 1, visual: 'legacy one', camera: 'medium shot, eye level', characters: ['无'], duration: 4, sub_shots: 'one take' },
      { visual: 'legacy auto', camera: 'close-up, 45 degree side', characters: ['无'], duration: 4, sub_shots: 'one take' },
    ],
  });
  const legacy = db.prepare('SELECT idx FROM shots WHERE project_id = ? ORDER BY idx').all(p.id).map((r) => Number(r.idx));
  assert.deepEqual(legacy, [1, 2], 'legacy 仍是"显式 1 + 自动 2"');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM story_shots WHERE project_id = ?').get(p.id).c, 0);
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 占用中 */ } });
