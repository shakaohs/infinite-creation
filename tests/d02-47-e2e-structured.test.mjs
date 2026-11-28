// 阶段 C · 隔离结构化项目端到端（D02-47 §十一）
//
// 这不是单元测试：它从**生产入口**出发，走完 A1（set_scene_state）→ A2/投影/参数（POST /shots 的 core）
// 一整条链，用独立临时数据目录，不碰 data/ic.db，也不改任何既有项目。
//
// 与前几轮的关系：D02-46 登记的缺口是「A1/A2 链路可达但真库 14 个项目 structured_spec 全 0，
// 从未被真实项目走过」。这里补的就是"走过一次"，但仍**不代表**阶段 F 的生产接管。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-e2e-c-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;

const core = await import('../lib/core/index.js');
const { createToolRuntime, runTool } = await import('../lib/agent/tools.js');
const { setStructuredSpec } = await import('../lib/core/structured-spec.js');

const { getDb, Projects, Chapters, Shots, createStructuredShot } = core;
const db = getDb();

test('E2E-C-01 隔离结构化项目：场次基线 → 镜头 → 段 → 参数，全链路走生产入口', async () => {
  // ① 隔离项目（独立数据目录），开结构化开关 —— 相当于用户在项目设置里打开
  const p = Projects.create({ name: 'E2E 结构化隔离项目' });
  setStructuredSpec(p.id, true);
  const ch = Chapters.list(p.id)[0];

  // ② A1：场次基线（Agent 工具 set_scene_state → upsertSceneStates，须 toolSet=script）
  const ctx = createToolRuntime({ projectId: p.id, toolSet: 'script' });
  const sceneOut = await runTool(ctx, 'set_scene_state', {
    chapter: ch.title,
    scenes: [{ scene_key: 'S01_病房', coord_system: { x: 'm' }, entries: { door: '画左' }, axis_lock: { axis: 'A-B' } }],
  });
  const scenes = db.prepare('SELECT * FROM scene_states WHERE project_id = ?').all(p.id);
  assert.equal(scenes.length, 1, 'A1 必须真的落库');
  assert.ok(sceneOut !== undefined);

  // ③ A2 + 投影 + 参数：走 POST /shots 的 core（三步同事务）
  const shot = createStructuredShot({
    projectId: p.id, chapterId: ch.id, chapterTitle: ch.title,
    sceneKey: 'S01_病房', sceneUid: scenes[0].id === undefined ? '' : '',
    patch: { visual: '病房里两人对峙', dialogue: '甲：你来了。', duration: 5, video_prompt: 'H3 六段式提示词', mode: 'reference' },
  });
  assert.ok(shot.story_shot_id && shot.segment_id);

  // ④ 映射：story_shots.segment_id ↔ shots.id
  const ss = db.prepare('SELECT * FROM story_shots WHERE id = ?').get(shot.story_shot_id);
  assert.equal(ss.segment_id, shot.segment_id);
  const seg = Shots.get(shot.segment_id);
  assert.equal(seg.chapter, ch.title);
  assert.equal(seg.idx, 1);
  assert.equal(seg.video_prompt, 'H3 六段式提示词');

  // ⑤ 段级参数：只经参数入口改，产物字段不可经创作入口写
  core.ShotParams.update(shot.segment_id, { mode: 'text' }, { origin: 'e2e' });
  assert.equal(Shots.get(shot.segment_id).mode, 'text');

  // ⑥ 失败整体回滚：撞镜号 → 不留孤立镜、不留无归属段
  const before = {
    ss: db.prepare('SELECT COUNT(*) n FROM story_shots WHERE project_id = ?').get(p.id).n,
    seg: db.prepare('SELECT COUNT(*) n FROM shots WHERE project_id = ?').get(p.id).n,
  };
  assert.throws(() => createStructuredShot({
    projectId: p.id, chapterId: ch.id, chapterTitle: ch.title, sceneKey: 'S01_病房',
    patch: { idx: 1, visual: '重复镜号' },
  }));
  assert.deepEqual({
    ss: db.prepare('SELECT COUNT(*) n FROM story_shots WHERE project_id = ?').get(p.id).n,
    seg: db.prepare('SELECT COUNT(*) n FROM shots WHERE project_id = ?').get(p.id).n,
  }, before, '失败必须整体回滚');
});

test('E2E-C-02 legacy 项目路径仍然正常（同一数据目录内互不干扰）', async () => {
  const p = Projects.create({ name: 'E2E legacy 项目' });
  const ch = Chapters.list(p.id)[0];
  const s = Shots.create(p.id, { chapter: ch.title, visual: '旧链路画面', duration: 3 }, { writer: 'creative' });
  assert.ok(s.id);
  assert.equal(Shots.get(s.id).visual, '旧链路画面');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM story_shots WHERE project_id = ?').get(p.id).n, 0, 'legacy 项目不得有 story_shots');
  // 旧链路不能传 story_shot_id（不得静默忽略）
  const ctx = createToolRuntime({ projectId: p.id });
  await assert.rejects(
    () => runTool(ctx, 'update_shot', { shot_id: s.id, story_shot_id: 'x', visual: 'v' }),
    (e) => /structured_spec=0/.test(e.message) || e.code === 'STAGE3_NOT_ENABLED',
  );
});

test('E2E-C-03 隔离验证不碰真实库', () => {
  assert.ok(String(core.DB_PATH).startsWith(TMP), `DB 应落在临时目录：${core.DB_PATH}`);
});
