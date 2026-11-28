// C-05：结构化项目的单镜改稿（update_shot 的 story_shot_id + get_shot 读侧）
// 三个冻结错误码来自 D-31-03：STAGE3_SHOT_ID_REQUIRED / STAGE3_NOT_ENABLED / STAGE3_SHOT_NOT_IN_SEGMENT
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-c05-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;

const core = await import('../lib/core/index.js');
const { createToolRuntime, runTool } = await import('../lib/agent/tools.js');
const { setStructuredSpec } = await import('../lib/core/structured-spec.js');

const { getDb, Projects, Chapters, Shots, createStructuredShot } = core;
const db = getDb();
let n = 0;

function mk(structured = true) {
  const p = Projects.create({ name: 'C05-' + (++n) });
  if (structured) setStructuredSpec(p.id, true);
  const ch = Chapters.list(p.id)[0];
  return { p, ch };
}

/** 结构化：走 C-06 的复合入口建「镜 + 段 + 参数」 */
function mkStructuredShot(p, ch, extra = {}) {
  const r = createStructuredShot({
    projectId: p.id, chapterId: ch.id, chapterTitle: ch.title,
    sceneKey: 'S01_病房', sceneUid: 'scn-c05',
    patch: { visual: '原始画面', dialogue: '台词', duration: 4, ...extra },
  });
  return r;
}

const ctxOf = (projectId) => createToolRuntime({ projectId });
const codeOf = (fn) => { try { fn(); return null; } catch (e) { return e.code || 'NO_CODE'; } };

test('C05-01 结构化 + A 组字段但没给 story_shot_id ⇒ STAGE3_SHOT_ID_REQUIRED', async () => {
  const { p, ch } = mk();
  const r = mkStructuredShot(p, ch);
  await assert.rejects(
    () => runTool(ctxOf(p.id), 'update_shot', { shot_id: r.segment_id, visual: '新画面' }),
    (e) => (e.code || '') === 'STAGE3_SHOT_ID_REQUIRED' || /story_shot_id/.test(e.message),
  );
});

test('C05-02 legacy 项目传了 story_shot_id ⇒ STAGE3_NOT_ENABLED（不静默忽略）', async () => {
  const { p, ch } = mk(false);
  const s = Shots.create(p.id, { chapter: ch.title, visual: 'v', duration: 4 }, { writer: 'creative' });
  await assert.rejects(
    () => runTool(ctxOf(p.id), 'update_shot', { shot_id: s.id, story_shot_id: 'ss-x', visual: 'x' }),
    (e) => (e.code || '') === 'STAGE3_NOT_ENABLED' || /structured_spec=0/.test(e.message),
  );
});

test('C05-03 story_shot_id 不属于该段 ⇒ STAGE3_SHOT_NOT_IN_SEGMENT', async () => {
  const { p, ch } = mk();
  const a = mkStructuredShot(p, ch);
  const b = mkStructuredShot(p, ch, { visual: '第二镜' });
  await assert.rejects(
    () => runTool(ctxOf(p.id), 'update_shot', { shot_id: a.segment_id, story_shot_id: b.story_shot_id, visual: 'x' }),
    (e) => (e.code || '') === 'STAGE3_SHOT_NOT_IN_SEGMENT',
  );
});

test('C05-04 正确 story_shot_id ⇒ 改 Stage 3 镜 + 重投影（段行视觉跟着变）', async () => {
  const { p, ch } = mk();
  const r = mkStructuredShot(p, ch);
  await runTool(ctxOf(p.id), 'update_shot', { shot_id: r.segment_id, story_shot_id: r.story_shot_id, visual: '改过的画面' });
  const ss = db.prepare('SELECT visual_content FROM story_shots WHERE id = ?').get(r.story_shot_id);
  assert.equal(ss.visual_content, '改过的画面', 'Stage 3 是权威');
  const seg = Shots.get(r.segment_id);
  assert.equal(seg.visual, '改过的画面', '投影必须把改动带进段行');
  assert.equal(seg.video_prompt, '', 'B 组不得被创作写入动到');
});

test('C05-05 A+B 混合：同一事务里改镜 + 写段级参数', async () => {
  const { p, ch } = mk();
  const r = mkStructuredShot(p, ch);
  await runTool(ctxOf(p.id), 'update_shot', {
    shot_id: r.segment_id, story_shot_id: r.story_shot_id,
    visual: '混合改', video_prompt: '段级提示词', mode: 'reference',
  });
  assert.equal(db.prepare('SELECT visual_content FROM story_shots WHERE id = ?').get(r.story_shot_id).visual_content, '混合改');
  const seg = Shots.get(r.segment_id);
  assert.equal(seg.video_prompt, '段级提示词');
  assert.equal(seg.mode, 'reference');
});

test('C05-06 只改 B 组（无 story_shot_id）⇒ 走段级参数入口，不报 STAGE3_SHOT_ID_REQUIRED', async () => {
  const { p, ch } = mk();
  const r = mkStructuredShot(p, ch);
  await runTool(ctxOf(p.id), 'update_shot', { shot_id: r.segment_id, mode: 'text' });
  assert.equal(Shots.get(r.segment_id).mode, 'text');
});

test('C05-07 改镜失败整体回滚（story_shot 与段行都不变）', async () => {
  const { p, ch } = mk();
  const r = mkStructuredShot(p, ch);
  const before = Shots.get(r.segment_id);
  // 未映射字段（blocking 在 story_shots 没有列）⇒ 抛 STAGE3_FIELD_NOT_MAPPED，且不得留半成品
  await assert.rejects(
    () => runTool(ctxOf(p.id), 'update_shot', { shot_id: r.segment_id, story_shot_id: r.story_shot_id, blocking: '站位文本' }),
    (e) => (e.code || '') === 'STAGE3_FIELD_NOT_MAPPED',
  );
  assert.equal(Shots.get(r.segment_id).visual, before.visual);
  assert.equal(db.prepare('SELECT visual_content FROM story_shots WHERE id = ?').get(r.story_shot_id).visual_content, '原始画面');
});

test('C05-08 get_shot 读侧返回段 + 对应 story_shots[] + 映射', async () => {
  const { p, ch } = mk();
  const r = mkStructuredShot(p, ch);
  const raw = await runTool(ctxOf(p.id), 'get_shot', { shot_id: r.segment_id });
  const out = typeof raw === 'string' ? JSON.parse(raw) : raw;
  assert.equal(out.shot.id, r.segment_id);
  assert.equal(out.story_shots.length, 1);
  assert.equal(out.story_shots[0].id, r.story_shot_id);
  assert.equal(out.mapping.segment_id, r.segment_id);
  assert.equal(out.mapping.one_to_many, false);
});

test('C05-09 get_shot 不得把生成段当唯一镜头（一段多镜时返回多条）', async () => {
  const { p, ch } = mk();
  const a = mkStructuredShot(p, ch);
  const b = mkStructuredShot(p, ch, { visual: '第二镜' });
  // 把两镜并成一段（显式分段）后重投影
  core.projectSceneUnits({
    projectId: p.id, chapterId: ch.id, sceneUid: 'scn-c05',
    units: [{ segment_id: a.segment_id, shot_ids: [a.story_shot_id, b.story_shot_id] }],
  });
  const raw = await runTool(ctxOf(p.id), 'get_shot', { shot_id: a.segment_id });
  const out = typeof raw === 'string' ? JSON.parse(raw) : raw;
  assert.equal(out.story_shots.length, 2);
  assert.equal(out.mapping.one_to_many, true);
  void codeOf;
});
