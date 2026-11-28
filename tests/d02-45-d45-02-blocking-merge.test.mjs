// D45-02 · 站位字段保留与审计一致性（`writeShotBlockings`）
//
// 修的是一个真实的字段丢失缺陷：上一版把「只含显式列的行」直接 INSERT，
// 整组 DELETE 之后，没提交的列全部回落成 DDL 默认值 ——
// 调用方只想改 `facing`，结果 `posture` / `norm_x` / `position_track` 全被清掉，
// 而返回值还写着"写入成功"。审计也看不出来：差集是基于 normalized 算的，
// 未提交字段根本不在比较范围内。
//
// 现在的语义（与"整组替换"一致的唯一正确形态）：
//   · 本镜**未提交的既有角色** = 删除（语义不变）
//   · 已有角色的**未提交字段** = 保留（before 打底 + 显式覆盖）
//   · 新角色的未提交字段 = DDL 默认值（新行没有"原有值"可保）
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-d4502-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;
delete process.env.IC_DB;
delete process.env.DATABASE_URL;

const core = await import('../lib/core/index.js');
const { getDb, listChanges, rawGet, ENTITY_META } = core;
const { createUserProject } = await import('../lib/core/project-create.js');
const { upsertSceneStates } = await import('../lib/core/scene-state.js');
const { writeStoryShotWithAssets } = await import('../lib/core/render/shot-assets.js');
const { writeShotBlockings, listShotBlockings } = await import('../lib/core/render/shot-blockings.js');

const db = getDb();

let seq = 0;
function setup(name) {
  seq += 1;
  const p = createUserProject({ name: `${name}-${seq}` });
  const chapter = core.Chapters.list(p.id)[0];
  const scene = core.Assets.create(p.id, { category: 'scene', name: `病房-${seq}` });
  const hero = core.Assets.create(p.id, { category: 'character', name: `罗克珊-${seq}` });
  const hero2 = core.Assets.create(p.id, { category: 'character', name: `凯森-${seq}` });
  const hero3 = core.Assets.create(p.id, { category: 'character', name: `哈罗德-${seq}` });
  upsertSceneStates(p.id, chapter, [{ scene_key: 'S01_病房', scene_id: scene.id }]);
  return { p, chapter, scene, hero, hero2, hero3 };
}

let shotSeq = 0;
function newShot(projectId, chapterId) {
  shotSeq += 1;
  return writeStoryShotWithAssets({
    projectId, chapterId,
    shot: { shot_no: shotSeq, global_no: shotSeq, scene_key: 'S01_病房', visual_content: `镜${shotSeq}` },
    assets: {},
  }).shot.id;
}

const row = (shotId, charId) => db.prepare('SELECT * FROM shot_blockings WHERE shot_id = ? AND character_id = ?').get(shotId, charId);
const logs = (pid) => listChanges(pid, { entity: 'shot_blocking', limit: 500 });
const round = (pid, run) => {
  const before = new Set(logs(pid).map((l) => l.id));
  run();
  return logs(pid).filter((l) => !before.has(l.id));
};

// ── 1. 核心：只提交 character_id，原字段全部保留 ────────────────────────
test('D45-02-A 已有 facing/posture/norm_x，只提交 character_id ⇒ 三个字段全部保留', () => {
  const { p, chapter, hero } = setup('D4502A');
  const shotId = newShot(p.id, chapter.id);
  writeShotBlockings(shotId, [{
    character_id: hero.id, facing: 'front', posture: '坐姿', norm_x: 0.42,
    position_abs: '病床右侧', gaze_target: '门口', position_track: [{ t: 0, x: 0.4 }],
  }]);
  const first = row(shotId, hero.id);
  assert.equal(first.posture, '坐姿');

  // 只给 character_id：语义是"这一镜里还有这个角色，别的东西不变"
  writeShotBlockings(shotId, [{ character_id: hero.id }]);
  const after = row(shotId, hero.id);
  assert.equal(after.facing, 'front', 'facing 不得被清成默认值');
  assert.equal(after.posture, '坐姿', 'posture 不得被清成默认值');
  assert.equal(after.norm_x, 0.42, 'norm_x 不得被清成 null');
  assert.equal(after.position_abs, '病床右侧');
  assert.equal(after.gaze_target, '门口');
  assert.deepEqual(JSON.parse(after.position_track), [{ t: 0, x: 0.4 }]);
});

// ── 2. 只提交一个字段，其他不丢 ────────────────────────────────────────
test('D45-02-B 只提交 facing ⇒ 其他列一个都不丢，且只产生一条 update', () => {
  const { p, chapter, hero } = setup('D4502B');
  const shotId = newShot(p.id, chapter.id);
  writeShotBlockings(shotId, [{ character_id: hero.id, facing: 'front', posture: '坐姿', norm_x: 0.42, in_frame: 1 }]);
  const before = row(shotId, hero.id);

  const r = round(p.id, () => writeShotBlockings(shotId, [{ character_id: hero.id, facing: 'right' }]));
  assert.equal(r.length, 1, '只改一列 ⇒ 一条 update');
  assert.equal(r[0].action, 'update');
  assert.equal(r[0].before.facing, 'front');
  assert.equal(r[0].after.facing, 'right');

  const after = row(shotId, hero.id);
  assert.equal(after.facing, 'right');
  assert.equal(after.posture, before.posture, 'posture 不得丢');
  assert.equal(after.norm_x, before.norm_x, 'norm_x 不得丢');
  assert.equal(after.position_abs, before.position_abs);
  assert.equal(after.occlusion, before.occlusion);
  // 审计快照必须反映真实落库内容：after 里的 posture 与原值一致，而不是默认值
  assert.equal(r[0].after.posture, before.posture, 'after 快照必须是落库后的真实行');
});

// ── 3. 完全相同 ⇒ 零日志 ───────────────────────────────────────────────
test('D45-02-C 完全相同的写入 ⇒ 0 条日志（合并后与 before 逐列相等）', () => {
  const { p, chapter, hero, hero2 } = setup('D4502C');
  const shotId = newShot(p.id, chapter.id);
  const input = [
    { character_id: hero.id, facing: 'front', posture: '坐姿', norm_x: 0.42 },
    { character_id: hero2.id, facing: 'left' },
  ];
  writeShotBlockings(shotId, input);
  assert.equal(logs(p.id).length, 2);

  const r = round(p.id, () => writeShotBlockings(shotId, input));
  assert.deepEqual(r, [], '内容完全相同：物理整组重写，但不得产生审计');
  assert.equal(logs(p.id).length, 2);
});

// ── 4. 新角色仍用 DDL 默认值 ───────────────────────────────────────────
test('D45-02-D 新角色行未提交字段仍用 DDL 默认值（不是 null、不是上一个角色的值）', () => {
  const { p, chapter, hero, hero2 } = setup('D4502D');
  const shotId = newShot(p.id, chapter.id);
  writeShotBlockings(shotId, [{ character_id: hero.id, facing: 'front', posture: '坐姿', norm_x: 0.9 }]);
  writeShotBlockings(shotId, [
    { character_id: hero.id, facing: 'front', posture: '坐姿', norm_x: 0.9 },
    { character_id: hero2.id, facing: 'left' },   // 新角色，只给 facing
  ]);
  const h2 = row(shotId, hero2.id);
  assert.equal(h2.facing, 'left');
  assert.equal(h2.in_frame, 1, 'in_frame 默认 1');
  assert.equal(h2.occlusion, 'none', 'occlusion 默认 none');
  assert.equal(h2.position_track, '[]', 'position_track 默认空数组');
  assert.equal(h2.posture, '', 'posture 默认空串（不得继承 hero 的「坐姿」）');
  assert.equal(h2.norm_x, null, 'norm_x 默认 null（不得继承 hero 的 0.9）');
});

// ── 5. 删除未提交角色仍产生 delete ─────────────────────────────────────
test('D45-02-E 本镜未提交的既有角色 ⇒ 1 条 delete（删除语义不变）', () => {
  const { p, chapter, hero, hero2 } = setup('D4502E');
  const shotId = newShot(p.id, chapter.id);
  writeShotBlockings(shotId, [
    { character_id: hero.id, facing: 'front', posture: '坐姿' },
    { character_id: hero2.id, facing: 'left', posture: '站立' },
  ]);
  const r = round(p.id, () => writeShotBlockings(shotId, [{ character_id: hero.id }]));
  assert.deepEqual(r.map((l) => l.action), ['delete']);
  assert.equal(r[0].before.character_id, hero2.id);
  assert.equal(r[0].before.posture, '站立', 'delete 的 before 必须是被删那一行的真实内容');
  assert.equal(row(shotId, hero2.id), undefined, '该行必须真的没了');
  // 保留的那个角色字段不丢
  assert.equal(row(shotId, hero.id).posture, '坐姿');
});

// ── 6. 混合：改一个 / 保留一个 / 删一个 / 加一个 ────────────────────────
test('D45-02-F 一次写入同时改+留+删+加：日志恰好 3 条，且各自的快照对得上', () => {
  const { p, chapter, hero, hero2, hero3 } = setup('D4502F');
  const shotId = newShot(p.id, chapter.id);
  writeShotBlockings(shotId, [
    { character_id: hero.id, facing: 'front', posture: '坐姿' },
    { character_id: hero2.id, facing: 'left', posture: '站立' },
  ]);
  const r = round(p.id, () => writeShotBlockings(shotId, [
    { character_id: hero.id, facing: 'right' },          // update（posture 保留）
    { character_id: hero3.id, facing: 'back' },          // create
    // hero2 不提交 → delete
  ]));
  assert.deepEqual(r.map((l) => l.action).sort(), ['create', 'delete', 'update']);
  const upd = r.find((l) => l.action === 'update');
  assert.equal(upd.before.posture, '坐姿');
  assert.equal(upd.after.posture, '坐姿', 'update 的 after 里 posture 必须保留');
  assert.equal(upd.after.facing, 'right');
  assert.equal(row(shotId, hero.id).posture, '坐姿');
  assert.equal(row(shotId, hero3.id).occlusion, 'none');
  assert.equal(row(shotId, hero2.id), undefined);
});

// ── 7. 审计失败 ⇒ 完整回滚（含被保留的字段）─────────────────────────────
test('D45-02-G 审计失败 ⇒ 物理整组替换一起回滚，被保留的字段也回到原样', () => {
  const { p, chapter, hero, hero2 } = setup('D4502G');
  const shotId = newShot(p.id, chapter.id);
  writeShotBlockings(shotId, [
    { character_id: hero.id, facing: 'front', posture: '坐姿', norm_x: 0.3 },
    { character_id: hero2.id, facing: 'left' },
  ]);
  const beforeRows = listShotBlockings(shotId).map((r) => JSON.stringify(r)).sort();

  const saved = ENTITY_META.shot_blocking;
  delete ENTITY_META.shot_blocking;
  try {
    assert.throws(
      () => writeShotBlockings(shotId, [{ character_id: hero.id, facing: 'changed' }]),
      (e) => e.code === 'AUDIT_ENTITY_META_MISSING',
    );
  } finally {
    ENTITY_META.shot_blocking = saved;
  }
  const afterRows = listShotBlockings(shotId).map((r) => JSON.stringify(r)).sort();
  assert.deepEqual(afterRows, beforeRows, '整组 DELETE 必须随审计失败回滚，两行原样都在');
});

// ── 8. 不写 legacy shots.blocking ──────────────────────────────────────
test('D45-02-H 站位只写 Stage 3：legacy shots 零行、零字段写入', () => {
  const { p, chapter, hero } = setup('D4502H');
  const shotId = newShot(p.id, chapter.id);
  const n0 = db.prepare('SELECT COUNT(*) AS c FROM shots WHERE project_id = ?').get(p.id).c;
  writeShotBlockings(shotId, [{ character_id: hero.id, facing: 'front', position_abs: '窗边' }]);
  const n1 = db.prepare('SELECT COUNT(*) AS c FROM shots WHERE project_id = ?').get(p.id).c;
  assert.equal(n1, n0);
  assert.equal(row(shotId, hero.id).position_abs, '窗边');
});

// ── 9. 复合主键与锁接口未变 ────────────────────────────────────────────
test('D45-02-I 复合主键仍是 (shot_id, character_id)，四个锁接口签名未变', () => {
  const { p, chapter, hero } = setup('D4502I');
  const shotId = newShot(p.id, chapter.id);
  writeShotBlockings(shotId, [{ character_id: hero.id, facing: 'front' }]);
  const r = rawGet('shot_blocking', [shotId, hero.id]);
  assert.ok(r, '完整键必须命中');
  assert.throws(() => rawGet('shot_blocking', [shotId]), (e) => e.code === 'AUDIT_PK_AMBIGUOUS');
  assert.equal(core.txProject.length, 2);
  assert.equal(core.txProjects.length, 2);
  assert.equal(core.lockedProjects.length, 0);
  assert.equal(core.assertProjectLocked.length, 1);
  assert.equal(core.lockedProjects(), null);
});

// ── 10. 差集必须反映真实落库内容（不是入参）────────────────────────────
test('D45-02-J 差集 based on 落库后的行：after 快照与库里的行逐列相等', () => {
  const { p, chapter, hero } = setup('D4502J');
  const shotId = newShot(p.id, chapter.id);
  writeShotBlockings(shotId, [{ character_id: hero.id, facing: 'front', posture: '坐姿' }]);
  const r = round(p.id, () => writeShotBlockings(shotId, [{ character_id: hero.id, facing: 'left' }]));
  assert.equal(r.length, 1);
  const dbRow = db.prepare('SELECT * FROM shot_blockings WHERE shot_id = ? AND character_id = ?').get(shotId, hero.id);
  for (const [k, v] of Object.entries(r[0].after)) {
    assert.deepEqual(v, dbRow[k], `after 快照的 ${k} 必须等于库里的值`);
  }
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 占用中 */ } });
