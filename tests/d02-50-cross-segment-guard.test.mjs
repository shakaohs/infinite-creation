// D02-50 §二/§三：候选跨段归属保护（合并 / 拆分 / 迁出 / 替换 / 减少）
//
// 缺陷根因回归：D02-49 的守卫只检查「最终计划里的段」。合并 A+B 时，若候选只在 B 上，
// B 不在计划里（它只会进 stale 清理），旧实现会放行 —— A 吸收 B 的内容，B 的候选变孤儿。
// 本文件锁住「受影响段 = 范围内所有镜当前指向的段 ∪ 计划段」这条口径。
//
// 覆盖（D50-01 要求的六种 + D50-02 的归属减少 + D50-03 的完整性）：
//   D50-01 合并 A+B，候选只在 A                ⇒ 拒绝（plan 级 ownership_changed）
//   D50-02 合并 A+B，候选只在 B                ⇒ 拒绝（跨段 segment_absorbed）
//   D50-03 合并 A+B，候选同时在 A、B           ⇒ 拒绝
//   D50-04 合并 A+B+C，候选只在 B              ⇒ 拒绝
//   D50-05 合并 A+B+C，候选只在 C              ⇒ 拒绝
//   D50-06 合并但无候选                        ⇒ 正常执行
//   D50-07 拒绝后段行/候选行/segment_id/审计全不变
//   D50-08 「换段 id」不能把候选变成孤儿       ⇒ 拒绝
//   D50-09 归属变化但 A 组内容相同             ⇒ 仍能识别（ownership_changed）
//   D50-10 删镜必然改动 A 组（sub_shots）      ⇒ 证据边界说明
//   D50-11 历史归属只能从审计日志还原          ⇒ 数据模型证据边界（不造假数据）
//   D50-12 已孤儿段（0 归属 + 候选）不被误伤   ⇒ 继续 blocked，不报错
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-d50-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;

const { getDb, Projects, Chapters } = await import('../lib/core/db.js');
const { insertStoryShot, deleteStoryShot } = await import('../lib/core/render/global-no.js');
const { projectSceneUnits } = await import('../lib/core/render/project-units.js');
const { listChanges } = await import('../lib/core/changelog.js');

const db = getDb();
let n = 0;

function mkScene({ shots = 1 } = {}) {
  const p = Projects.create({ name: 'D50-' + (++n) });
  const ch = Chapters.list(p.id)[0];
  const sceneUid = 'scn-d50-' + n;
  const ids = [];
  for (let i = 1; i <= shots; i++) {
    const r = insertStoryShot({
      project_id: p.id, chapter_id: ch.id, scene_key: 'S01_病房', scene_uid: sceneUid,
      shot_no: i, global_no: i, visual_content: '画面' + i, dialogue: '台词' + i, story_duration: 4,
    });
    ids.push(r.id);
  }
  return { p, ch, sceneUid, ids };
}

/** 先把 N 镜投成一镜一段，返回段行（按 idx） */
function oneShotOneSeg(ctx) {
  projectSceneUnits({ projectId: ctx.p.id, chapterId: ctx.ch.id, sceneUid: ctx.sceneUid });
  return db.prepare('SELECT * FROM shots WHERE project_id = ? ORDER BY idx ASC').all(ctx.p.id);
}

const segRow = (id) => db.prepare('SELECT * FROM shots WHERE id = ?').get(id);
const segIdOf = (shotId) => db.prepare('SELECT segment_id FROM story_shots WHERE id = ?').get(shotId).segment_id;
const addCandidate = (pid, segId, vid) => db.prepare(
  'INSERT INTO shot_videos (id,project_id,shot_id,idx,video_path,seed,selected,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
).run(vid, pid, segId, 0, '/c-' + vid + '.mp4', 5, 1, 1, 1);
const candRow = (vid) => db.prepare('SELECT * FROM shot_videos WHERE id = ?').get(vid);

/** 拍全景：段行 / 候选行 / segment_id / 审计条数。用于「拒绝后什么都没变」。 */
function snapshot(pid, shotIds, candIds = []) {
  return {
    segs: db.prepare('SELECT * FROM shots WHERE project_id = ? ORDER BY id').all(pid).map((r) => ({ ...r })),
    cands: candIds.map((id) => ({ ...candRow(id) })),
    segIds: shotIds.map(segIdOf),
    logs: listChanges(pid, { limit: 500 }).length,
  };
}

function assertNothingChanged(pid, shotIds, snap, candIds = []) {
  const now = snapshot(pid, shotIds, candIds);
  assert.deepEqual(now.segs, snap.segs, '段行必须逐列不变');
  assert.deepEqual(now.cands, snap.cands, '候选行必须逐列不变（shot_id/selected/input_hash）');
  assert.deepEqual(now.segIds, snap.segIds, 'segment_id 不得部分回写');
  assert.equal(now.logs, snap.logs, '不得产生审计增量');
}

test('D50-01 合并 A+B，候选只在 A ⇒ 拒绝（plan 级归属变化）', () => {
  const ctx = mkScene({ shots: 2 });
  const segs = oneShotOneSeg(ctx);
  addCandidate(ctx.p.id, segs[0].id, 'c-d50-01');
  const snap = snapshot(ctx.p.id, ctx.ids, ['c-d50-01']);

  assert.throws(
    () => projectSceneUnits({
      projectId: ctx.p.id, chapterId: ctx.ch.id, sceneUid: ctx.sceneUid,
      units: [{ shot_ids: [ctx.ids[0], ctx.ids[1]] }],
    }),
    (e) => e.code === 'UNIT_SEGMENT_CANDIDATE_CONFLICT'
      && e.detail.segment_id === segs[0].id && e.detail.ownership_changed === true,
  );
  assertNothingChanged(ctx.p.id, ctx.ids, snap, ['c-d50-01']);
});

test('D50-02 合并 A+B，候选只在 B ⇒ 拒绝（跨段吸收，本轮修的缺陷）', () => {
  const ctx = mkScene({ shots: 2 });
  const segs = oneShotOneSeg(ctx);
  addCandidate(ctx.p.id, segs[1].id, 'c-d50-02');
  const snap = snapshot(ctx.p.id, ctx.ids, ['c-d50-02']);

  assert.throws(
    () => projectSceneUnits({
      projectId: ctx.p.id, chapterId: ctx.ch.id, sceneUid: ctx.sceneUid,
      units: [{ shot_ids: [ctx.ids[0], ctx.ids[1]] }],
    }),
    (e) => e.code === 'UNIT_SEGMENT_CANDIDATE_CONFLICT'
      && e.detail.segment_id === segs[1].id
      && e.detail.reason === 'segment_absorbed'
      && e.detail.ownership_changed === true,
  );
  assertNothingChanged(ctx.p.id, ctx.ids, snap, ['c-d50-02']);
  assert.ok(segRow(segs[1].id), '被吸收的段必须还在（拒绝发生在写之前）');
});

test('D50-03 合并 A+B，候选同时在 A、B ⇒ 拒绝', () => {
  const ctx = mkScene({ shots: 2 });
  const segs = oneShotOneSeg(ctx);
  addCandidate(ctx.p.id, segs[0].id, 'c-d50-03a');
  addCandidate(ctx.p.id, segs[1].id, 'c-d50-03b');
  const snap = snapshot(ctx.p.id, ctx.ids, ['c-d50-03a', 'c-d50-03b']);

  assert.throws(
    () => projectSceneUnits({
      projectId: ctx.p.id, chapterId: ctx.ch.id, sceneUid: ctx.sceneUid,
      units: [{ shot_ids: [ctx.ids[0], ctx.ids[1]] }],
    }),
    (e) => e.code === 'UNIT_SEGMENT_CANDIDATE_CONFLICT',
  );
  assertNothingChanged(ctx.p.id, ctx.ids, snap, ['c-d50-03a', 'c-d50-03b']);
});

test('D50-04 合并 A+B+C，候选只在 B（非 base）⇒ 拒绝', () => {
  const ctx = mkScene({ shots: 3 });
  const segs = oneShotOneSeg(ctx);
  addCandidate(ctx.p.id, segs[1].id, 'c-d50-04');
  const snap = snapshot(ctx.p.id, ctx.ids, ['c-d50-04']);

  assert.throws(
    () => projectSceneUnits({
      projectId: ctx.p.id, chapterId: ctx.ch.id, sceneUid: ctx.sceneUid,
      units: [{ shot_ids: [ctx.ids[0], ctx.ids[1], ctx.ids[2]] }],
    }),
    (e) => e.code === 'UNIT_SEGMENT_CANDIDATE_CONFLICT'
      && e.detail.segment_id === segs[1].id && e.detail.reason === 'segment_absorbed',
  );
  assertNothingChanged(ctx.p.id, ctx.ids, snap, ['c-d50-04']);
});

test('D50-05 合并 A+B+C，候选只在 C（非 base）⇒ 拒绝', () => {
  const ctx = mkScene({ shots: 3 });
  const segs = oneShotOneSeg(ctx);
  addCandidate(ctx.p.id, segs[2].id, 'c-d50-05');
  const snap = snapshot(ctx.p.id, ctx.ids, ['c-d50-05']);

  assert.throws(
    () => projectSceneUnits({
      projectId: ctx.p.id, chapterId: ctx.ch.id, sceneUid: ctx.sceneUid,
      units: [{ shot_ids: [ctx.ids[0], ctx.ids[1], ctx.ids[2]] }],
    }),
    (e) => e.code === 'UNIT_SEGMENT_CANDIDATE_CONFLICT' && e.detail.segment_id === segs[2].id,
  );
  assertNothingChanged(ctx.p.id, ctx.ids, snap, ['c-d50-05']);
});

test('D50-06 合并但没有任何候选 ⇒ 正常执行（2 段并 1 段）', () => {
  const ctx = mkScene({ shots: 2 });
  const segs = oneShotOneSeg(ctx);
  const r = projectSceneUnits({
    projectId: ctx.p.id, chapterId: ctx.ch.id, sceneUid: ctx.sceneUid,
    units: [{ shot_ids: [ctx.ids[0], ctx.ids[1]] }],
  });
  const merged = segRow(segs[0].id);
  assert.equal(merged.visual, '画面1\n画面2');
  assert.equal(Number(merged.duration), 8);
  assert.equal(r.units.length, 1);
  assert.deepEqual(segs.map((s) => segIdOf(s.id === segs[0].id ? ctx.ids[0] : ctx.ids[1])), [segs[0].id, segs[0].id]);
  assert.deepEqual(r.deleted, [segs[1].id], '无候选的旧段按 0 镜段规则删除');
});

test('D50-07 拒绝后：段行 / 候选行 / segment_id / 审计四者全不变', () => {
  const ctx = mkScene({ shots: 3 });
  const segs = oneShotOneSeg(ctx);
  addCandidate(ctx.p.id, segs[1].id, 'c-d50-07');
  const snap = snapshot(ctx.p.id, ctx.ids, ['c-d50-07']);

  assert.throws(
    () => projectSceneUnits({
      projectId: ctx.p.id, chapterId: ctx.ch.id, sceneUid: ctx.sceneUid,
      units: [{ shot_ids: [ctx.ids[0], ctx.ids[1], ctx.ids[2]] }],
    }),
    (e) => e.code === 'UNIT_SEGMENT_CANDIDATE_CONFLICT',
  );
  assertNothingChanged(ctx.p.id, ctx.ids, snap, ['c-d50-07']);
  assert.equal(segIdOf(ctx.ids[1]), segs[1].id, '被吸收段的归属镜头不得被改写成合并段');
});

test('D50-08 换段 id 不能把候选变成孤儿：显式新 id 迁走唯一归属镜 ⇒ 拒绝', () => {
  const ctx = mkScene({ shots: 1 });
  const segs = oneShotOneSeg(ctx);
  addCandidate(ctx.p.id, segs[0].id, 'c-d50-08');
  const b = insertStoryShot({
    project_id: ctx.p.id, chapter_id: ctx.ch.id, scene_key: 'S01_病房', scene_uid: ctx.sceneUid,
    shot_no: 2, global_no: 2, visual_content: '新镜', story_duration: 3,
  });
  const snap = snapshot(ctx.p.id, [...ctx.ids, b.id], ['c-d50-08']);

  assert.throws(
    () => projectSceneUnits({
      projectId: ctx.p.id, chapterId: ctx.ch.id, sceneUid: ctx.sceneUid,
      units: [{ segment_id: 'seg_d50_new', shot_ids: [ctx.ids[0], b.id] }],
    }),
    (e) => e.code === 'UNIT_SEGMENT_CANDIDATE_CONFLICT'
      && e.detail.segment_id === segs[0].id && e.detail.reason === 'segment_absorbed',
  );
  assertNothingChanged(ctx.p.id, [...ctx.ids, b.id], snap, ['c-d50-08']);
  assert.ok(!segRow('seg_d50_new'), '不得建出新段');
  assert.equal(segIdOf(ctx.ids[0]), segs[0].id, '原镜仍留在原段');
});

test('D50-09 归属变化但 A 组内容相同 ⇒ 仍能识别（不是只看内容）', () => {
  const ctx = mkScene({ shots: 2 });
  // 两镜合成一段（此时无候选）
  projectSceneUnits({
    projectId: ctx.p.id, chapterId: ctx.ch.id, sceneUid: ctx.sceneUid,
    units: [{ shot_ids: [ctx.ids[0], ctx.ids[1]] }],
  });
  const segId = segIdOf(ctx.ids[0]);
  addCandidate(ctx.p.id, segId, 'c-d50-09');
  // 用「内容完全相同」的新镜替换第二镜：A 组 17 列一字不差，只有归属集合变了
  deleteStoryShot(ctx.ids[1]);
  const b2 = insertStoryShot({
    project_id: ctx.p.id, chapter_id: ctx.ch.id, scene_key: 'S01_病房', scene_uid: ctx.sceneUid,
    shot_no: 2, global_no: 3, visual_content: '画面2', dialogue: '台词2', story_duration: 4,
  });
  const snap = snapshot(ctx.p.id, [ctx.ids[0], b2.id], ['c-d50-09']);

  assert.throws(
    () => projectSceneUnits({
      projectId: ctx.p.id, chapterId: ctx.ch.id, sceneUid: ctx.sceneUid,
      units: [{ segment_id: segId, shot_ids: [ctx.ids[0], b2.id] }],
    }),
    (e) => e.code === 'UNIT_SEGMENT_CANDIDATE_CONFLICT'
      && e.detail.ownership_changed === true
      && e.detail.content_changed === false,
    '内容一列都没变，仍必须被归属变化拦下',
  );
  assertNothingChanged(ctx.p.id, [ctx.ids[0], b2.id], snap, ['c-d50-09']);
});

test('D50-10 删镜必然改动 A 组：当前数据模型无法构造「归属减少但 17 列不变」', () => {
  const ctx = mkScene({ shots: 2 });
  projectSceneUnits({
    projectId: ctx.p.id, chapterId: ctx.ch.id, sceneUid: ctx.sceneUid,
    units: [{ shot_ids: [ctx.ids[0], ctx.ids[1]] }],
  });
  const segId = segIdOf(ctx.ids[0]);
  addCandidate(ctx.p.id, segId, 'c-d50-10');
  deleteStoryShot(ctx.ids[1]);

  assert.throws(
    () => projectSceneUnits({ projectId: ctx.p.id, chapterId: ctx.ch.id, sceneUid: ctx.sceneUid }),
    (e) => e.code === 'UNIT_SEGMENT_CANDIDATE_CONFLICT'
      && e.detail.ownership_changed === false
      && e.detail.content_changed === true
      && e.detail.changed_fields.includes('sub_shots'),
    '一镜一段的边界：删镜后 `sub_shots`（多镜时按行拼接）必然变化，所以内容差异一定先命中',
  );
});

test('D50-11 数据模型证据边界：被删镜的历史段归属只存在于审计日志', () => {
  const ctx = mkScene({ shots: 2 });
  const segs = oneShotOneSeg(ctx);
  const segOfB = segIdOf(ctx.ids[1]);
  deleteStoryShot(ctx.ids[1]);

  // live 表：已经没有任何行能证明 b 曾属于 segOfB
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM story_shots WHERE id = ?').get(ctx.ids[1]).n, 0);
  const liveOwners = db.prepare('SELECT id FROM story_shots WHERE segment_id = ?').all(segOfB).map((r) => r.id);
  assert.deepEqual(liveOwners, [], 'live 表无从还原被删镜的归属');

  // 审计日志：delete 的 before 快照里有 segment_id —— 这是唯一的还原路径（不据此做守卫）
  const del = listChanges(ctx.p.id, { entity: 'story_shot', action: 'delete', limit: 50 })
    .find((l) => l.entity_id === ctx.ids[1]);
  assert.ok(del, '删除必须有 A2 审计');
  assert.equal(del.before.segment_id, segOfB, '历史归属只存在于日志 before 快照');
  void segs;
});

test('D50-12 已孤儿段（0 归属 + 候选）不被误伤：继续 blocked，不报错', () => {
  const ctx = mkScene({ shots: 1 });
  const segs = oneShotOneSeg(ctx);
  addCandidate(ctx.p.id, segs[0].id, 'c-d50-12');
  deleteStoryShot(ctx.ids[0]);
  const nr = insertStoryShot({
    project_id: ctx.p.id, chapter_id: ctx.ch.id, scene_key: 'S01_病房', scene_uid: ctx.sceneUid,
    shot_no: 2, global_no: 2, visual_content: '新镜', story_duration: 6,
  });

  const r = projectSceneUnits({ projectId: ctx.p.id, chapterId: ctx.ch.id, sceneUid: ctx.sceneUid });
  assert.notEqual(segIdOf(nr.id), segs[0].id, '新镜不得复用孤儿段');
  assert.deepEqual(r.blocked.map((b) => b.segment_id), [segs[0].id]);
  assert.equal(candRow('c-d50-12').shot_id, segs[0].id, '候选仍挂原段');
  assert.equal(segRow(segs[0].id).visual, '画面1', '孤儿段内容不得被覆盖');
});

test('D50-13 拆分且两组都用显式新 id ⇒ 仍然拒绝（不能靠换 id 拆散候选段）', () => {
  const ctx = mkScene({ shots: 2 });
  projectSceneUnits({
    projectId: ctx.p.id, chapterId: ctx.ch.id, sceneUid: ctx.sceneUid,
    units: [{ shot_ids: [ctx.ids[0], ctx.ids[1]] }],
  });
  const segId = segIdOf(ctx.ids[0]);
  addCandidate(ctx.p.id, segId, 'c-d50-13');
  const snap = snapshot(ctx.p.id, ctx.ids, ['c-d50-13']);

  assert.throws(
    () => projectSceneUnits({
      projectId: ctx.p.id, chapterId: ctx.ch.id, sceneUid: ctx.sceneUid,
      units: [
        { segment_id: 'seg_d50_split_1', shot_ids: [ctx.ids[0]] },
        { segment_id: 'seg_d50_split_2', shot_ids: [ctx.ids[1]] },
      ],
    }),
    (e) => e.code === 'UNIT_SEGMENT_CANDIDATE_CONFLICT'
      && e.detail.segment_id === segId && e.detail.reason === 'segment_absorbed',
    '原段不在新计划里（两组都换了 id），但它会失去全部归属 ⇒ 必须按受影响段拦截',
  );
  assertNothingChanged(ctx.p.id, ctx.ids, snap, ['c-d50-13']);
  assert.ok(!segRow('seg_d50_split_1') && !segRow('seg_d50_split_2'), '不得建出拆分后的新段');
});
