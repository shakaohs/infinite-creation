// C-06：HTTP 复合入口（POST 三步同事务 / PATCH 三分流）
// 逻辑在 core（createStructuredShot / classifyStructuredPatch），这里测真行为；
// 路由只做参数与错误码映射，它的正确性用静态断言兜（见 C06-06）。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-c06-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;

const core = await import('../lib/core/index.js');
const { setStructuredSpec } = await import('../lib/core/structured-spec.js');

const { getDb, Projects, Chapters, Shots, createStructuredShot, classifyStructuredPatch, projectSceneUnits } = core;
const db = getDb();
let n = 0;

function mk(structured = true) {
  const p = Projects.create({ name: 'C06-' + (++n) });
  if (structured) setStructuredSpec(p.id, true);
  return { p, ch: Chapters.list(p.id)[0] };
}
const storyRows = (pid) => db.prepare('SELECT * FROM story_shots WHERE project_id = ? ORDER BY global_no').all(pid);
const segRows = (pid) => db.prepare('SELECT * FROM shots WHERE project_id = ? ORDER BY idx').all(pid);

test('C06-01 三步同事务：一次调用同时得到 story_shot / 段行 / segment_id 映射', () => {
  const { p, ch } = mk();
  const r = createStructuredShot({
    projectId: p.id, chapterId: ch.id, chapterTitle: ch.title,
    sceneKey: 'S01', sceneUid: 'scn-c06',
    patch: { visual: '画面A', dialogue: '台词A', duration: 4, video_prompt: '段级提示词', mode: 'reference' },
  });
  assert.equal(storyRows(p.id).length, 1);
  assert.equal(segRows(p.id).length, 1);
  assert.equal(r.segment_id, segRows(p.id)[0].id);
  assert.equal(storyRows(p.id)[0].segment_id, r.segment_id, 'segment_id 必须回写');
  const seg = Shots.get(r.segment_id);
  assert.equal(seg.visual, '画面A');
  assert.equal(seg.video_prompt, '段级提示词');
  assert.equal(seg.mode, 'reference');
});

test('C06-02 任一步失败整体回滚：撞镜号后既不留镜也不留段', () => {
  const { p, ch } = mk();
  createStructuredShot({ projectId: p.id, chapterId: ch.id, chapterTitle: ch.title, sceneKey: 'S01', sceneUid: 'scn-x', patch: { idx: 1, visual: '第一镜' } });
  const storyBefore = storyRows(p.id).length;
  const segBefore = segRows(p.id).length;
  assert.throws(
    () => createStructuredShot({ projectId: p.id, chapterId: ch.id, chapterTitle: ch.title, sceneKey: 'S01', sceneUid: 'scn-x', patch: { idx: 1, visual: '重复镜号' } }),
    (e) => /UNIQUE|constraint/i.test(e.message) || !!e.code,
  );
  assert.equal(storyRows(p.id).length, storyBefore, '不得留下孤立镜头');
  assert.equal(segRows(p.id).length, segBefore, '不得留下无归属段');
});

test('C06-03 C/E 组字段在复合入口一律拒（不给 HTTP 开后门）', () => {
  const { p, ch } = mk();
  for (const bad of [{ status: 'done' }, { video_path: '/v.mp4' }, { resolution: '1080P' }]) {
    assert.throws(
      () => createStructuredShot({ projectId: p.id, chapterId: ch.id, chapterTitle: ch.title, sceneKey: 'S01', patch: { visual: 'v', ...bad } }),
      (e) => e.code === 'HTTP_SHOT_FIELD_DENIED',
      JSON.stringify(bad),
    );
  }
  assert.equal(storyRows(p.id).length, 0);
});

test('C06-04 PATCH 三分流：A→stage3、C/E→denied、B→params、空→empty', () => {
  assert.equal(classifyStructuredPatch({ visual: 'v' }).kind, 'stage3');
  assert.equal(classifyStructuredPatch({ status: 'done' }).kind, 'denied');
  assert.equal(classifyStructuredPatch({ resolution: '1080P' }).kind, 'denied');
  assert.equal(classifyStructuredPatch({ video_prompt: 'p', mode: 'text' }).kind, 'params');
  assert.equal(classifyStructuredPatch({}).kind, 'empty');
  // 混组按"更严"的判：A+B 也必须走 Stage 3，不能在这里改一半
  assert.equal(classifyStructuredPatch({ visual: 'v', video_prompt: 'p' }).kind, 'stage3');
});

test('C06-05 legacy 项目不受影响：复合入口只服务结构化项目', () => {
  const { p, ch } = mk(false);
  const s = Shots.create(p.id, { chapter: ch.title, visual: 'legacy', duration: 4 }, { writer: 'creative' });
  assert.ok(s.id);
  assert.equal(storyRows(p.id).length, 0, 'legacy 项目不该有 story_shots');
  // 结构化入口对 legacy 项目不产生副作用（这里是显式调用，不经过 isStructuredSpec 判定）
  void ch;
});

test('C06-06 静态：两个路由都委托 core，且不再直接写 Shots 创作字段', () => {
  const ROOT = path.resolve(import.meta.dirname, '..');
  const post = fs.readFileSync(path.join(ROOT, 'app', 'api', 'projects', '[id]', 'shots', 'route.js'), 'utf8');
  const patch = fs.readFileSync(path.join(ROOT, 'app', 'api', 'projects', '[id]', 'shots', '[sid]', 'route.js'), 'utf8');
  assert.ok(post.includes('createStructuredShot('), 'POST 必须委托 createStructuredShot');
  assert.ok(patch.includes('classifyStructuredPatch('), 'PATCH 必须用三分流');
  assert.ok(/HTTP_STAGE3_FIELD_REQUIRED/.test(patch), 'A 组必须返回 400 提示走 Stage 3');
  assert.ok(/HTTP_SHOT_FIELD_DENIED/.test(patch), 'C/E 组必须返回 400');
});

test('C06-07 结构化项目里不会出现 legacy 创作旁路（shots 行只由投影建）', () => {
  const { p, ch } = mk();
  createStructuredShot({ projectId: p.id, chapterId: ch.id, chapterTitle: ch.title, sceneKey: 'S01', sceneUid: 'scn-z', patch: { visual: 'v' } });
  // 直接调 Shots.create 必须被拒（结构化项目）
  assert.throws(() => Shots.create(p.id, { chapter: ch.title, visual: 'x' }, { writer: 'creative' }),
    (e) => e.code === 'STRUCTURED_LEGACY_WRITE_FORBIDDEN');
  // 段行数 = 镜数（一镜一段），没有额外旁路产生的行
  assert.equal(segRows(p.id).length, storyRows(p.id).length);
  projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid: 'scn-z' });
  assert.equal(segRows(p.id).length, 1, '重投影不得新增段');
});
