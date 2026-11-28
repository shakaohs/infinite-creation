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

// ── D02-48 定向补充（D48-01 完整覆盖 / D48-02 候选隔离）──────────────────────

function addCandidate(pid, segId, vid) {
  db.prepare('INSERT INTO shot_videos (id,project_id,shot_id,idx,video_path,seed,selected,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(vid, pid, segId, 0, '/cand-' + vid + '.mp4', 7, 1, 1, 1);
}
const segRowOf = (id) => db.prepare('SELECT * FROM shots WHERE id = ?').get(id);
const segIdOf = (shotId) => db.prepare('SELECT segment_id FROM story_shots WHERE id = ?').get(shotId).segment_id;

test('C01-11 测试A：显式 units 遗漏镜头 ⇒ 拒绝且不留任何写入', () => {
  const { p, ch, sceneUid, ids } = mkScene({ shots: 3 });
  const r0 = projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid });
  const before = segRows(p.id).map((x) => ({ ...x }));
  const beforeSegIds = ids.map(segIdOf);
  const logsBefore = listChanges(p.id, { limit: 500 }).length;

  assert.throws(
    () => projectSceneUnits({
      projectId: p.id, chapterId: ch.id, sceneUid,
      units: [{ shot_ids: [ids[0], ids[1]] }],   // 少了 ids[2]
    }),
    (e) => e.code === 'UNIT_SHOT_COVERAGE_INCOMPLETE'
      && Array.isArray(e.detail?.expected_shot_ids) && e.detail.expected_shot_ids.length === 3
      && Array.isArray(e.detail?.actual_shot_ids) && e.detail.actual_shot_ids.length === 2
      && e.detail.missing_shot_ids.length === 1 && e.detail.missing_shot_ids[0] === ids[2]
      && Array.isArray(e.detail?.duplicated_shot_ids) && e.detail.duplicated_shot_ids.length === 0,
  );
  assert.equal(segRows(p.id).length, before.length, '不得新增段');
  assert.deepEqual(segRows(p.id).map((x) => ({ ...x })), before, '原有段必须逐列不变');
  assert.deepEqual(ids.map(segIdOf), beforeSegIds, 'segment_id 不得被回写');
  assert.equal(listChanges(p.id, { limit: 500 }).length, logsBefore, '失败不得产生审计日志');
  assert.equal(r0.created, 3);
});

test('C01-12 测试B：一镜出现在两个段 ⇒ 拒绝且整体回滚', () => {
  const { p, ch, sceneUid, ids } = mkScene({ shots: 2 });
  assert.throws(
    () => projectSceneUnits({
      projectId: p.id, chapterId: ch.id, sceneUid,
      units: [{ shot_ids: [ids[0], ids[1]] }, { shot_ids: [ids[0]] }],
    }),
    (e) => e.code === 'UNIT_SHOT_DUPLICATED' && e.detail.duplicated_shot_ids.includes(ids[0]),
  );
  assert.equal(segRows(p.id).length, 0, '一行段都不许留');
  assert.deepEqual(ids.map(segIdOf), ['', ''], 'segment_id 必须保持空串');
});

test('C01-13 写入中途失败（第二段 INSERT 抛错）⇒ 第一段也回滚', () => {
  const { p, ch, sceneUid, ids } = mkScene({ shots: 2 });
  const orig = db.prepare.bind(db);
  let n = 0;
  db.prepare = (sql) => {
    if (/INSERT INTO shots/i.test(sql)) {
      n += 1;
      if (n === 2) throw new Error('injected failure on 2nd insert');
    }
    return orig(sql);
  };
  try {
    assert.throws(() => projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid }), /injected failure/);
  } finally {
    db.prepare = orig;
  }
  assert.equal(n, 2, '确实执行到第二段才失败');
  assert.equal(segRows(p.id).length, 0, '第一段必须一起回滚');
  assert.deepEqual(ids.map(segIdOf), ['', '']);
});

test('C01-14 测试C：旧段仍有候选时，同段序新镜不得复用该段 id', () => {
  const { p, ch, sceneUid, ids } = mkScene({ shots: 2 });
  projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid });
  const segs = segRows(p.id);
  const old = { ...segs[1] };
  addCandidate(p.id, old.id, 'v-d48-c');

  // 旧镜被删 ⇒ 段失去归属，但候选在 ⇒ 段必须保留
  db.prepare('DELETE FROM story_shots WHERE id = ?').run(ids[1]);

  // 新镜进入同场次、同段序（global_no 最大 ⇒ idx=2）
  const nr = insertStoryShot({
    project_id: p.id, chapter_id: ch.id, scene_key: 'S01_病房', scene_uid: sceneUid,
    shot_no: 3, global_no: 3, visual_content: '新画面', story_duration: 6,
  });

  const r = projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid });
  const after = segRowOf(old.id);
  assert.deepEqual({ ...after }, old, '旧段内容必须逐列不变（不得被新镜覆盖）');
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM shot_videos WHERE shot_id = ?').get(old.id).n), 1, '旧候选必须还在');
  assert.equal(db.prepare('SELECT shot_id FROM shot_videos WHERE id = ?').get('v-d48-c').shot_id, old.id, '候选不得被改挂到新段');

  const newSegId = segIdOf(nr.id);
  assert.ok(newSegId && newSegId !== old.id, '新镜头不得指向旧段');
  const newSeg = segRowOf(newSegId);
  assert.equal(newSeg.visual, '新画面');
  assert.equal(Number(newSeg.duration), 6);
  assert.equal(r.created, 1, '必须新建一段');
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].base_segment_id, old.id);
  assert.equal(r.conflicts[0].assigned_segment_id, newSegId);
  assert.equal(r.conflicts[0].reason, 'orphaned_with_candidates');
  assert.deepEqual(r.blocked.map((b) => b.segment_id), [old.id]);
});

test('C01-15 测试D：同一逻辑镜重复投影 ⇒ 段 id 稳定、参数与候选不变、无审计', () => {
  const { p, ch, sceneUid } = mkScene({ shots: 2 });
  const r1 = projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid });
  const segIds = r1.units.map((u) => u.segment_id);
  db.prepare('UPDATE shots SET video_prompt = ?, status = ? WHERE id = ?').run('用户参数', 'done', segIds[0]);
  addCandidate(p.id, segIds[0], 'v-d48-d');
  const before = segRows(p.id).map((x) => ({ ...x }));
  const logsBefore = listChanges(p.id, { limit: 500 }).length;

  const r2 = projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid });
  assert.deepEqual(r2.units.map((u) => u.segment_id), segIds, '段 id 必须稳定');
  assert.equal(r2.created, 0);
  assert.equal(r2.updated, 0);
  assert.equal(r2.unchanged, 2);
  assert.deepEqual(segRows(p.id).map((x) => ({ ...x })), before, '生成参数/候选/内容都不得变');
  assert.equal(segRowOf(segIds[0]).video_prompt, '用户参数');
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM shot_videos WHERE shot_id = ?').get(segIds[0]).n), 1);
  assert.equal(listChanges(p.id, { limit: 500 }).length, logsBefore, '无重复内容审计');
  assert.equal(r2.reused_with_candidates.length, 1);
  assert.equal(r2.reused_with_candidates[0].content_changed, false);
});

test('C01-16 测试E：同一逻辑段内容修改 ⇒ 段 id 不变、候选关联显式保留并报告', () => {
  const { p, ch, sceneUid, ids } = mkScene({ shots: 1 });
  const r1 = projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid });
  const segId = r1.units[0].segment_id;
  addCandidate(p.id, segId, 'v-d48-e');
  db.prepare('UPDATE shots SET video_prompt = ?, status = ? WHERE id = ?').run('保留提示词', 'done', segId);
  // 候选自己的指纹（`shot_videos.input_hash` 是候选身份的一部分，投影不得碰）
  db.prepare('UPDATE shot_videos SET input_hash = ? WHERE id = ?').run('hash-e', 'v-d48-e');

  db.prepare('UPDATE story_shots SET visual_content = ? WHERE id = ?').run('改后画面', ids[0]);
  const r2 = projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid });

  assert.equal(r2.units[0].segment_id, segId, '同一逻辑段身份必须稳定');
  assert.equal(r2.updated, 1);
  const row = segRowOf(segId);
  assert.equal(row.visual, '改后画面', 'A 组应更新');
  assert.equal(row.video_prompt, '保留提示词', 'B 组不得被投影覆盖');
  assert.equal(row.status, 'done', 'C 组不得被投影重置');

  const cand = db.prepare('SELECT * FROM shot_videos WHERE id = ?').get('v-d48-e');
  assert.ok(cand, '候选行必须保留');
  assert.equal(cand.shot_id, segId, '候选与段的关联不得被改写');
  assert.equal(cand.input_hash, 'hash-e', '候选指纹不得被投影改写');
  assert.equal(Number(cand.selected), 1, '选中状态不得被投影改动');
  assert.equal(r2.reused_with_candidates.length, 1);
  assert.equal(r2.reused_with_candidates[0].segment_id, segId);
  assert.equal(r2.reused_with_candidates[0].candidates, 1);
  assert.equal(r2.reused_with_candidates[0].content_changed, true, '内容在候选存在时变化必须显式报告');
});

test('C01-17 候选冲突换名后，显式 units（不给 segment_id）不得把身份翻回旧段序', () => {
  const { p, ch, sceneUid, ids } = mkScene({ shots: 2 });
  projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid });
  const segs = segRows(p.id);
  addCandidate(p.id, segs[1].id, 'v-d48-f');
  db.prepare('DELETE FROM story_shots WHERE id = ?').run(ids[1]);
  const nr = insertStoryShot({
    project_id: p.id, chapter_id: ch.id, scene_key: 'S01_病房', scene_uid: sceneUid,
    shot_no: 3, global_no: 3, visual_content: '新画面', story_duration: 6,
  });
  const r1 = projectSceneUnits({ projectId: p.id, chapterId: ch.id, sceneUid });
  const altSeg = segIdOf(nr.id);
  assert.notEqual(altSeg, segs[1].id);

  // 显式分段但**不给** segment_id：段序 base 会再次撞上旧段 id，此时必须保持 alt 身份
  const r2 = projectSceneUnits({
    projectId: p.id, chapterId: ch.id, sceneUid,
    units: [{ shot_ids: [ids[0]] }, { shot_ids: [nr.id] }],
  });
  assert.equal(segIdOf(nr.id), altSeg, '身份不得在 alt/base 之间翻动');
  assert.equal(r2.created, 0, '不得另建一段');
  assert.ok(segRowOf(segs[1].id), '旧段（有候选）仍在');
  assert.equal(db.prepare('SELECT shot_id FROM shot_videos WHERE id = ?').get('v-d48-f').shot_id, segs[1].id);
  assert.ok(r1.conflicts.length === 1 && r2.conflicts.length === 0);
});
