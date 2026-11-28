// C-01：生成段投影器（D02-40 §4.2 投影行 / §4.6 复合入口）
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-c01-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;

const { getDb, Projects, Chapters } = await import('../lib/core/db.js');
const { insertStoryShot } = await import('../lib/core/render/global-no.js');
const { projectSceneUnits, projectRenderUnits } = await import('../lib/core/render/project-units.js');
const { listChanges } = await import('../lib/core/changelog.js');

const db = getDb();
let n = 0;

function mkScene({ shots = 2, assets = false } = {}) {
  const p = Projects.create({ name: 'C01-' + (++n) });
  const ch = Chapters.list(p.id)[0];
  const sceneUid = 'scn-' + n;
  const ids = [];
  for (let i = 1; i <= shots; i++) {
    const r = insertStoryShot({
      project_id: p.id, chapter_id: ch.id, scene_key: 'S01_病房', scene_uid: sceneUid,
      shot_no: i, global_no: i,
      visual_content: '画面' + i, dialogue: '台词' + i, narration: '',
      cam_note: '中景', story_duration: 4,
    });
    ids.push(r.id);
    if (assets) {
      db.prepare('INSERT INTO shot_assets (shot_id, asset_id, role, order_no) VALUES (?,?,?,?)').run(r.id, 'as-char-1', 'character', 1);
      db.prepare('INSERT INTO shot_assets (shot_id, asset_id, role, order_no) VALUES (?,?,?,?)').run(r.id, 'as-scene-1', 'scene', 1);
    }
  }
  return { p, ch, sceneUid, ids };
}

const segRows = (pid) => db.prepare('SELECT * FROM shots WHERE project_id = ? ORDER BY idx ASC').all(pid);

test('C01-01 一镜一段：N 镜 ⇒ N 段，idx 从 1 连续，段内字段取自镜', () => {
  const { p, ch, sceneUid } = mkScene({ shots: 3, assets: true });
  const r = projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid });
  assert.equal(r.created, 3);
  const rows = segRows(p.id);
  assert.deepEqual(rows.map((x) => x.idx), [1, 2, 3]);
  assert.equal(rows[0].chapter, ch.title);
  assert.equal(rows[0].visual, '画面1');
  assert.equal(rows[0].duration, 4);
  assert.deepEqual(JSON.parse(rows[0].character_ids), ['as-char-1']);
  assert.deepEqual(JSON.parse(rows[0].scene_ids), ['as-scene-1']);
});

test('C01-02 一段多镜：显式 units ⇒ 只建 1 段，时长相加、内容按行拼接', () => {
  const { p, ch, sceneUid, ids } = mkScene({ shots: 2 });
  const r = projectSceneUnits({
    projectId: p.id, chapterId: ch.id, sceneUid,
    units: [{ shot_ids: [ids[0], ids[1]] }],
  });
  assert.equal(r.created, 1);
  const rows = segRows(p.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].duration, 8);
  assert.equal(rows[0].visual, '画面1\n画面2');
  assert.ok(rows[0].sub_shots.includes('[]') || rows[0].sub_shots === '');
});

test('C01-03 按 global_no 稳定排序（与插入顺序无关）', () => {
  const p = Projects.create({ name: 'C01-排序' });
  const ch = Chapters.list(p.id)[0];
  // 故意乱序写：global_no 3 → 1 → 2
  for (const g of [3, 1, 2]) {
    insertStoryShot({
      project_id: p.id, chapter_id: ch.id, scene_key: 'S', scene_uid: 'scn-sort',
      shot_no: g, global_no: g, visual_content: 'v' + g, story_duration: 1,
    });
  }
  const r = projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid: 'scn-sort' });
  const rows = segRows(p.id);
  assert.equal(r.created, 3);
  assert.deepEqual(rows.map((x) => x.visual), ['v1', 'v2', 'v3'], '必须按 global_no 排');
});

test('C01-04 segment_id 回写：每镜都指向自己那一段', () => {
  const { p, ch, sceneUid, ids } = mkScene({ shots: 2 });
  const r = projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid });
  const got = ids.map((id) => db.prepare('SELECT segment_id FROM story_shots WHERE id = ?').get(id).segment_id);
  assert.deepEqual(got, r.units.map((u) => u.segment_id));
  assert.equal(new Set(got).size, 2, '两镜两段，不得指向同一段');
});

test('C01-05 幂等：重复投影不新增段、不改内容、不产生审计日志', () => {
  const { p, ch, sceneUid } = mkScene({ shots: 2 });
  projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid });
  const before = segRows(p.id).map((x) => ({ ...x }));
  const logsBefore = listChanges(p.id, { limit: 500 }).length;

  const r2 = projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid });
  assert.equal(r2.created, 0, '第二次不得新建');
  assert.equal(r2.updated, 0, '内容没变不得更新');
  assert.equal(r2.unchanged, 2);
  assert.deepEqual(segRows(p.id).map((x) => ({ ...x })), before, '整行必须逐列不变');
  assert.equal(listChanges(p.id, { limit: 500 }).length, logsBefore, '投影不得产生内容日志');
});

test('C01-06 A 组内容变了才更新，且不动 B/C/E 组', () => {
  const { p, ch, sceneUid, ids } = mkScene({ shots: 1 });
  projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid });
  const segId = segRows(p.id)[0].id;
  // 段级参数与产物先写上（模拟用户已调参、已出片）
  db.prepare('UPDATE shots SET video_prompt = ?, status = ?, video_path = ?, resolution = ? WHERE id = ?')
    .run('用户提示词', 'done', '/v.mp4', '1080P', segId);

  db.prepare('UPDATE story_shots SET visual_content = ? WHERE id = ?').run('改过的画面', ids[0]);
  const r = projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid });
  assert.equal(r.updated, 1);
  const row = db.prepare('SELECT * FROM shots WHERE id = ?').get(segId);
  assert.equal(row.visual, '改过的画面', 'A 组应更新');
  assert.equal(row.video_prompt, '用户提示词', 'B 组不得被投影覆盖');
  assert.equal(row.video_path, '/v.mp4', 'C 组不得被投影覆盖');
  assert.equal(row.resolution, '1080P', 'E 组不得被投影覆盖');
});

test('C01-07 0 镜段走专用删除路径；有候选时拒绝删除并报告', () => {
  const { p, ch, sceneUid, ids } = mkScene({ shots: 2 });
  projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid });
  const segs = segRows(p.id);
  assert.equal(segs.length, 2);

  // 段 2 上挂一个生成候选 ⇒ 它不能被静默删掉
  db.prepare('INSERT INTO shot_videos (id,project_id,shot_id,idx,video_path,seed,selected,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('v-c01', p.id, segs[1].id, 0, '/cand.mp4', 1, 1, 1, 1);

  // 删除第 2 镜 ⇒ 它的段成为 0 镜段
  db.prepare('DELETE FROM story_shots WHERE id = ?').run(ids[1]);
  const r = projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid });
  assert.deepEqual(r.deleted, [], '有候选的段不得删除');
  assert.equal(r.blocked.length, 1);
  assert.equal(r.blocked[0].segment_id, segs[1].id);
  assert.equal(r.blocked[0].candidates, 1);
  assert.ok(db.prepare('SELECT id FROM shots WHERE id = ?').get(segs[1].id), '段行必须还在');
  assert.ok(db.prepare('SELECT id FROM shot_videos WHERE id = ?').get('v-c01'), '候选必须还在');

  // 再删第 1 镜（无候选）⇒ 它的段可被删除
  db.prepare('DELETE FROM story_shots WHERE id = ?').run(ids[0]);
  const r2 = projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid });
  assert.deepEqual(r2.deleted, [segs[0].id]);
  assert.ok(!db.prepare('SELECT id FROM shots WHERE id = ?').get(segs[0].id));
});

test('C01-08 投影失败整体回滚：units 引用范围外的镜 ⇒ 一行都不写', () => {
  const { p, ch, sceneUid, ids } = mkScene({ shots: 1 });
  assert.throws(
    () => projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid, units: [{ shot_ids: [ids[0], 'no-such-shot'] }] }),
    (e) => e.code === 'UNIT_SHOT_NOT_IN_SCOPE',
  );
  assert.equal(segRows(p.id).length, 0, '失败不得留下半成品段');
  assert.equal(db.prepare('SELECT segment_id FROM story_shots WHERE id = ?').get(ids[0]).segment_id, '', 'segment_id 也不得被回写');
});

test('C01-09 结构化遗留字段 refs 必须拒绝（不静默忽略）', () => {
  const { p, ch, sceneUid, ids } = mkScene({ shots: 1 });
  assert.throws(
    () => projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid, units: [{ shot_ids: [ids[0]], refs: [] }] }),
    (e) => e.code === 'PROJECTION_LEGACY_FIELD_REJECTED',
  );
});

test('C01-10 投影不得借 system writer；对外名 projectRenderUnits 与 projectSceneUnits 同实现', () => {
  const { p, ch, sceneUid } = mkScene({ shots: 1 });
  assert.throws(
    () => projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid, writer: 'system' }),
    (e) => e.code === 'PROJECTION_WRITER_FORBIDDEN',
  );
  assert.equal(projectRenderUnits, projectSceneUnits);
});
