// D02-49 §二：候选有效性守卫（有候选的段只允许完全幂等的重投影）
//
// 八种必须覆盖的情形（D02-49 §二）+ 三项边界：
//   D49-01 单镜内容修改 + 候选            ⇒ 拒绝
//   D49-02 多镜段中单镜内容修改 + 候选    ⇒ 拒绝
//   D49-03 两段合并 + 候选                ⇒ 拒绝
//   D49-04 一段拆分 + 候选                ⇒ 拒绝
//   D49-05 原段归属镜头增加 + 候选        ⇒ 拒绝
//   D49-06 原段归属镜头减少 + 候选        ⇒ 拒绝
//   D49-07 内容完全相同的幂等重投影        ⇒ 允许
//   D49-08 候选不存在时的正常更新          ⇒ 允许
//   D49-09 守卫不误伤 D02-48 场景（旧段失去归属 + 候选 ⇒ 换 id）
//   D49-10 拒绝后候选三字段（shot_id/selected/input_hash）与段行逐列不变
//   D49-11 守卫在写之前：前一段即使可写也不得落库
//
// 「候选有效性」不只查"行还在"：每条拒绝用例都同时断言
//   ① 段 A 组逐列未变　② 候选行未被改写（关联/选中/指纹）　③ segment_id 未回写　④ 审计零增量。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-d49-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;

const { getDb, Projects, Chapters } = await import('../lib/core/db.js');
const { insertStoryShot } = await import('../lib/core/render/global-no.js');
const { projectSceneUnits } = await import('../lib/core/render/project-units.js');
const { listChanges } = await import('../lib/core/changelog.js');

const db = getDb();
let n = 0;

function mkScene({ shots = 1 } = {}) {
  const p = Projects.create({ name: 'D49-' + (++n) });
  const ch = Chapters.list(p.id)[0];
  const sceneUid = 'scn-d49-' + n;
  const ids = [];
  for (let i = 1; i <= shots; i++) {
    const r = insertStoryShot({
      project_id: p.id, chapter_id: ch.id, scene_key: 'S01_病房', scene_uid: sceneUid,
      shot_no: i, global_no: i, visual_content: '画面' + i, story_duration: 4,
    });
    ids.push(r.id);
  }
  return { p, ch, sceneUid, ids };
}

const segRows = (pid) => db.prepare('SELECT * FROM shots WHERE project_id = ? ORDER BY idx ASC').all(pid);
const segRow = (id) => db.prepare('SELECT * FROM shots WHERE id = ?').get(id);
const segIdOf = (shotId) => db.prepare('SELECT segment_id FROM story_shots WHERE id = ?').get(shotId).segment_id;
const addCandidate = (pid, segId, vid) => db.prepare(
  'INSERT INTO shot_videos (id,project_id,shot_id,idx,video_path,seed,selected,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
).run(vid, pid, segId, 0, '/c-' + vid + '.mp4', 3, 1, 1, 1);
const candRow = (vid) => db.prepare('SELECT * FROM shot_videos WHERE id = ?').get(vid);

/** 一次「必须被拒绝」的投影：断言错误码 + 拒绝后世界完全没变。 */
function assertRejected({ p, ch, sceneUid, fn, candId, segId, shotIds }) {
  const before = { ...segRow(segId) };
  const candBefore = candId ? { ...candRow(candId) } : null;
  const segIdsBefore = shotIds.map(segIdOf);
  const logsBefore = listChanges(p.id, { limit: 1000 }).length;

  assert.throws(fn, (e) => e.code === 'UNIT_SEGMENT_CANDIDATE_CONFLICT', '必须 fail-closed');
  assert.deepEqual({ ...segRow(segId) }, before, '段行必须逐列不变（不得覆盖内容）');
  if (candId) assert.deepEqual({ ...candRow(candId) }, candBefore, '候选行不得被改写（关联/选中/指纹全不许动）');
  assert.deepEqual(shotIds.map(segIdOf), segIdsBefore, 'segment_id 不得回写');
  assert.equal(listChanges(p.id, { limit: 1000 }).length, logsBefore, '拒绝不得产生审计日志');
  void ch; void sceneUid;
}

test('D49-01 单镜内容修改 + 候选 ⇒ 拒绝（UNIT_SEGMENT_CANDIDATE_CONFLICT）', () => {
  const { p, ch, sceneUid, ids } = mkScene({ shots: 1 });
  const r = projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid });
  const segId = r.units[0].segment_id;
  addCandidate(p.id, segId, 'c-d49-01');
  db.prepare('UPDATE story_shots SET visual_content = ? WHERE id = ?').run('改后', ids[0]);

  assertRejected({
    p, ch, sceneUid, segId, candId: 'c-d49-01', shotIds: ids,
    fn: () => projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid }),
  });
  assert.throws(
    () => projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid }),
    (e) => e.detail.changed_fields.includes('visual') && e.detail.reason === 'content_changed',
  );
});

test('D49-02 多镜段中单镜内容修改 + 候选 ⇒ 拒绝', () => {
  const { p, ch, sceneUid, ids } = mkScene({ shots: 2 });
  const r = projectSceneUnits({
    projectId: p.id, chapterId: ch.id, sceneUid, units: [{ shot_ids: [ids[0], ids[1]] }],
  });
  const segId = r.units[0].segment_id;
  addCandidate(p.id, segId, 'c-d49-02');
  db.prepare('UPDATE story_shots SET dialogue = ? WHERE id = ?').run('改后的台词', ids[1]);

  assertRejected({
    p, ch, sceneUid, segId, candId: 'c-d49-02', shotIds: ids,
    fn: () => projectSceneUnits({
      projectId: p.id, chapterId: ch.id, sceneUid, units: [{ shot_ids: [ids[0], ids[1]] }],
    }),
  });
});

test('D49-03 两段合并 + 候选 ⇒ 拒绝', () => {
  const { p, ch, sceneUid, ids } = mkScene({ shots: 2 });
  projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid });
  const segs = segRows(p.id);
  addCandidate(p.id, segs[0].id, 'c-d49-03');

  assertRejected({
    p, ch, sceneUid, segId: segs[0].id, candId: 'c-d49-03', shotIds: ids,
    fn: () => projectSceneUnits({
      projectId: p.id, chapterId: ch.id, sceneUid, units: [{ shot_ids: [ids[0], ids[1]] }],
    }),
  });
  assert.ok(segRow(segs[1].id), '第二段不得被顺手清掉（拒绝发生在写之前）');
});

test('D49-04 一段拆分 + 候选 ⇒ 拒绝', () => {
  const { p, ch, sceneUid, ids } = mkScene({ shots: 2 });
  const r = projectSceneUnits({
    projectId: p.id, chapterId: ch.id, sceneUid, units: [{ shot_ids: [ids[0], ids[1]] }],
  });
  const segId = r.units[0].segment_id;
  addCandidate(p.id, segId, 'c-d49-04');

  assertRejected({
    p, ch, sceneUid, segId, candId: 'c-d49-04', shotIds: ids,
    fn: () => projectSceneUnits({
      projectId: p.id, chapterId: ch.id, sceneUid,
      units: [{ shot_ids: [ids[0]] }, { shot_ids: [ids[1]] }],
    }),
  });
  assert.throws(
    () => projectSceneUnits({
      projectId: p.id, chapterId: ch.id, sceneUid,
      units: [{ shot_ids: [ids[0]] }, { shot_ids: [ids[1]] }],
    }),
    (e) => e.detail.ownership_changed === true && e.detail.reason === 'segment_split',
  );
});

test('D49-05 原段归属镜头增加 + 候选 ⇒ 拒绝', () => {
  const { p, ch, sceneUid, ids } = mkScene({ shots: 1 });
  const r = projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid });
  const segId = r.units[0].segment_id;
  addCandidate(p.id, segId, 'c-d49-05');
  const b = insertStoryShot({
    project_id: p.id, chapter_id: ch.id, scene_key: 'S01_病房', scene_uid: sceneUid,
    shot_no: 2, global_no: 2, visual_content: '新增镜', story_duration: 3,
  });

  assertRejected({
    p, ch, sceneUid, segId, candId: 'c-d49-05', shotIds: [ids[0], b.id],
    fn: () => projectSceneUnits({
      projectId: p.id, chapterId: ch.id, sceneUid, units: [{ shot_ids: [ids[0], b.id] }],
    }),
  });
});

test('D49-06 原段归属镜头减少 + 候选 ⇒ 拒绝', () => {
  const { p, ch, sceneUid, ids } = mkScene({ shots: 2 });
  const r = projectSceneUnits({
    projectId: p.id, chapterId: ch.id, sceneUid, units: [{ shot_ids: [ids[0], ids[1]] }],
  });
  const segId = r.units[0].segment_id;
  addCandidate(p.id, segId, 'c-d49-06');
  // 删掉第二镜：段的内容随之变短，候选对应的生成输入已不成立
  db.prepare('DELETE FROM story_shots WHERE id = ?').run(ids[1]);

  assertRejected({
    p, ch, sceneUid, segId, candId: 'c-d49-06', shotIds: [ids[0]],
    fn: () => projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid }),
  });
});

test('D49-07 内容完全相同的幂等重投影 ⇒ 允许，候选与段都不动', () => {
  const { p, ch, sceneUid } = mkScene({ shots: 1 });
  const r1 = projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid });
  const segId = r1.units[0].segment_id;
  addCandidate(p.id, segId, 'c-d49-07');
  const before = { ...segRow(segId) };
  const candBefore = { ...candRow('c-d49-07') };
  const logsBefore = listChanges(p.id, { limit: 1000 }).length;

  const r2 = projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid });
  assert.equal(r2.created, 0);
  assert.equal(r2.updated, 0);
  assert.equal(r2.unchanged, 1);
  assert.deepEqual({ ...segRow(segId) }, before);
  assert.deepEqual({ ...candRow('c-d49-07') }, candBefore);
  assert.equal(listChanges(p.id, { limit: 1000 }).length, logsBefore, '幂等重投影零审计');
  assert.deepEqual(r2.reused_with_candidates, [{ segment_id: segId, candidates: 1, content_changed: false }]);
});

test('D49-08 候选不存在时按冻结规则正常更新', () => {
  const { p, ch, sceneUid, ids } = mkScene({ shots: 1 });
  const r1 = projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid });
  const segId = r1.units[0].segment_id;
  db.prepare('UPDATE story_shots SET visual_content = ?, story_duration = ? WHERE id = ?').run('新内容', 7, ids[0]);
  const r2 = projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid });
  assert.equal(r2.updated, 1);
  assert.equal(segRow(segId).visual, '新内容');
  assert.equal(Number(segRow(segId).duration), 7);
});

test('D49-09 旧段失去全部归属 + 候选 ⇒ 仍走换 id（不报冲突，不误伤 D02-48）', () => {
  const { p, ch, sceneUid, ids } = mkScene({ shots: 1 });
  const r1 = projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid });
  const oldSeg = r1.units[0].segment_id;
  addCandidate(p.id, oldSeg, 'c-d49-09');
  db.prepare('DELETE FROM story_shots WHERE id = ?').run(ids[0]);
  const nr = insertStoryShot({
    project_id: p.id, chapter_id: ch.id, scene_key: 'S01_病房', scene_uid: sceneUid,
    shot_no: 2, global_no: 2, visual_content: '新镜', story_duration: 5,
  });

  const r2 = projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid });
  const newSeg = segIdOf(nr.id);
  assert.ok(newSeg && newSeg !== oldSeg);
  assert.equal(r2.conflicts.length, 1);
  assert.equal(r2.conflicts[0].reason, 'orphaned_with_candidates');
  assert.equal(segRow(oldSeg).visual, '画面1', '旧段内容不得被覆盖');
  assert.equal(candRow('c-d49-09').shot_id, oldSeg, '候选仍挂在旧段');
});

test('D49-10 拒绝后候选三字段与段行逐列不变（shot_id / selected / input_hash）', () => {
  const { p, ch, sceneUid, ids } = mkScene({ shots: 1 });
  const r = projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid });
  const segId = r.units[0].segment_id;
  addCandidate(p.id, segId, 'c-d49-10');
  db.prepare('UPDATE shot_videos SET selected = 0, input_hash = ? WHERE id = ?').run('hash-d49-10', 'c-d49-10');
  db.prepare('UPDATE shots SET video_prompt = ?, status = ? WHERE id = ?').run('提示词保留', 'done', segId);
  db.prepare('UPDATE story_shots SET visual_content = ? WHERE id = ?').run('改后', ids[0]);

  assertRejected({
    p, ch, sceneUid, segId, candId: 'c-d49-10', shotIds: ids,
    fn: () => projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid }),
  });
  const cand = candRow('c-d49-10');
  assert.equal(cand.shot_id, segId);
  assert.equal(Number(cand.selected), 0, 'selected 不得被改动（哪怕是 0）');
  assert.equal(cand.input_hash, 'hash-d49-10');
  assert.equal(segRow(segId).video_prompt, '提示词保留', 'B 组不得被投影碰');
  assert.equal(segRow(segId).status, 'done', 'C 组不得被投影重置');
});

test('D49-11 守卫在写之前：前一段可写也不得落库（整次投影零写入）', () => {
  const { p, ch, sceneUid, ids } = mkScene({ shots: 2 });
  projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid });
  const segs = segRows(p.id);
  addCandidate(p.id, segs[1].id, 'c-d49-11');
  // 两段内容都改：第 1 段无候选（本可更新），第 2 段有候选（必须拒绝）
  db.prepare('UPDATE story_shots SET visual_content = ? WHERE id = ?').run('改后1', ids[0]);
  db.prepare('UPDATE story_shots SET visual_content = ? WHERE id = ?').run('改后2', ids[1]);
  const before1 = { ...segRow(segs[0].id) };
  const before2 = { ...segRow(segs[1].id) };
  const logsBefore = listChanges(p.id, { limit: 1000 }).length;

  assert.throws(
    () => projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid }),
    (e) => e.code === 'UNIT_SEGMENT_CANDIDATE_CONFLICT',
  );
  assert.deepEqual({ ...segRow(segs[0].id) }, before1, '第 1 段不得被部分写入');
  assert.deepEqual({ ...segRow(segs[1].id) }, before2);
  assert.equal(listChanges(p.id, { limit: 1000 }).length, logsBefore);
});
