// P10-A 阶段 B · B-04：站位写入器（`shot_blockings`）
//
// 锁四件事：
//   ① 差集按 `(shot_id, character_id)` 算：改一个字段 = 1 条 update，不是整组重来；
//   ② 复合主键定位准确（`rawGet('shot_blocking', [shotId, characterId])`）；
//   ③ 归属经 `story_shots` 反查，孤儿行 / 孤儿镜一律 fail-closed；
//   ④ 审计失败与物理写入同事务回滚。
//
// 另锁一条纪律：不得把站位写回 legacy `shots.blocking` 文本（两个权威 = 谁也不知道哪个对）。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-b04-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;
delete process.env.IC_DB;
delete process.env.DATABASE_URL;

const core = await import('../lib/core/index.js');
const { getDb, listChanges, rawGet, ENTITY_META } = core;
const { createUserProject } = await import('../lib/core/project-create.js');
const { upsertSceneStates } = await import('../lib/core/scene-state.js');
const { writeStoryShotWithAssets } = await import('../lib/core/render/shot-assets.js');
const {
  writeShotBlockings, listShotBlockings, diffShotBlockings,
} = await import('../lib/core/render/shot-blockings.js');

const db = getDb();

let seq = 0;
function setup(name) {
  seq += 1;
  const p = createUserProject({ name: `${name}-${seq}` });
  const chapter = core.Chapters.list(p.id)[0];
  const scene = core.Assets.create(p.id, { category: 'scene', name: `病房-${seq}` });
  const hero = core.Assets.create(p.id, { category: 'character', name: `罗克珊-${seq}` });
  const hero2 = core.Assets.create(p.id, { category: 'character', name: `凯森-${seq}` });
  upsertSceneStates(p.id, chapter, [{ scene_key: 'S01_病房', scene_id: scene.id }]);
  return { p, chapter, scene, hero, hero2 };
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

const blockingRows = (shotId) => db.prepare('SELECT * FROM shot_blockings WHERE shot_id = ? ORDER BY character_id ASC').all(shotId);
const logs = (projectId) => listChanges(projectId, { entity: 'shot_blocking', limit: 500 });
const round = (projectId, run) => {
  const before = new Set(logs(projectId).map((l) => l.id));
  run();
  return logs(projectId).filter((l) => !before.has(l.id));
};
const actions = (rows) => rows.map((r) => r.action).sort();

// ── 1. create：首次写入 ────────────────────────────────────────────────
test('B04-01 首次写入 → N 条 create，缺省列吃 DDL 默认值（不是 null）', () => {
  const { p, chapter, hero, hero2 } = setup('B0401');
  const shotId = newShot(p.id, chapter.id);
  const r = writeShotBlockings(shotId, [
    { character_id: hero.id, facing: 'front', position_abs: '窗边' },
    { character_id: hero2.id, facing: 'left' },
  ]);
  assert.equal(r.written, 2);
  assert.deepEqual(r.audit, { added: 2, removed: 0, changed: 0 });
  assert.deepEqual(actions(logs(p.id)), ['create', 'create']);

  const rows = blockingRows(shotId);
  assert.equal(rows.length, 2);
  // 没给的列必须落 DDL 默认值：in_frame 默认 1、occlusion 默认 'none'、position_track 默认 '[]'
  const h = rows.find((x) => x.character_id === hero2.id);
  assert.equal(h.in_frame, 1, 'in_frame 默认必须是 1（不是 null）');
  assert.equal(h.occlusion, 'none');
  assert.equal(h.position_track, '[]');
  assert.equal(h.facing, 'left');
});

// ── 2. update：只改一个字段 ────────────────────────────────────────────
test('B04-02 只改一个字段 → 恰好 1 条 update（不是整组删建）', () => {
  const { p, chapter, hero, hero2 } = setup('B0402');
  const shotId = newShot(p.id, chapter.id);
  writeShotBlockings(shotId, [
    { character_id: hero.id, facing: 'front', posture: '坐' },
    { character_id: hero2.id, facing: 'left' },
  ]);
  const base = logs(p.id).length;

  const r = round(p.id, () => writeShotBlockings(shotId, [
    { character_id: hero.id, facing: 'right', posture: '坐' },   // 只改 facing
    { character_id: hero2.id, facing: 'left' },                  // 没变
  ]));
  assert.deepEqual(actions(r), ['update'], '只改一个角色的一列 ⇒ 1 条 update');
  assert.equal(r[0].entity_id, JSON.stringify([shotId, hero.id]));
  assert.equal(r[0].before.facing, 'front');
  assert.equal(r[0].after.facing, 'right');
  assert.equal(logs(p.id).length, base + 1, '另一个角色没变 ⇒ 不得有日志');

  const after = blockingRows(shotId);
  assert.equal(after.length, 2, '整组替换后仍是 2 行');
  assert.equal(after.find((x) => x.character_id === hero.id).facing, 'right');
});

// ── 3. delete：本镜没出现的角色 = 删除 ─────────────────────────────────
test('B04-03 角色从本镜移除 → 恰好 1 条 delete，before 是那一行', () => {
  const { p, chapter, hero, hero2 } = setup('B0403');
  const shotId = newShot(p.id, chapter.id);
  writeShotBlockings(shotId, [
    { character_id: hero.id, facing: 'front' },
    { character_id: hero2.id, facing: 'left' },
  ]);
  const r = round(p.id, () => writeShotBlockings(shotId, [{ character_id: hero.id, facing: 'front' }]));
  assert.deepEqual(actions(r), ['delete']);
  assert.equal(r[0].before.character_id, hero2.id);
  assert.equal(r[0].after, null);
  assert.equal(blockingRows(shotId).length, 1);
});

// ── 4. 完全相同 → 零日志 ───────────────────────────────────────────────
test('B04-04 内容完全相同 → 0 条日志（物理整组重写，审计不动）', () => {
  const { p, chapter, hero } = setup('B0404');
  const shotId = newShot(p.id, chapter.id);
  writeShotBlockings(shotId, [{ character_id: hero.id, facing: 'front', norm_x: 0.5 }]);
  const r = round(p.id, () => writeShotBlockings(shotId, [{ character_id: hero.id, facing: 'front', norm_x: 0.5 }]));
  assert.deepEqual(r, []);
  assert.equal(logs(p.id).length, 1);
});

// ── 5. 复合主键定位准确 ────────────────────────────────────────────────
test('B04-05 复合主键 (shot_id, character_id) 定位准确；半个键即 AUDIT_PK_AMBIGUOUS', () => {
  const { p, chapter, hero, hero2 } = setup('B0405');
  const shotId = newShot(p.id, chapter.id);
  writeShotBlockings(shotId, [
    { character_id: hero.id, facing: 'front' },
    { character_id: hero2.id, facing: 'left' },
  ]);
  const row = rawGet('shot_blocking', [shotId, hero.id]);
  assert.equal(row.character_id, hero.id);
  assert.equal(row.facing, 'front');
  assert.throws(() => rawGet('shot_blocking', [shotId]), (e) => e.code === 'AUDIT_PK_AMBIGUOUS');
  assert.equal(rawGet('shot_blocking', [shotId, 'no-such-char']), null);

  // listShotBlockings 的 JSON 列解析回对象
  const list = listShotBlockings(shotId);
  assert.equal(list.length, 2);
  assert.ok(Array.isArray(list[0].position_track));
});

// ── 6. 孤儿镜 / 孤儿行 fail-closed ─────────────────────────────────────
test('B04-06 孤儿镜 → SHOT_NOT_FOUND；孤儿站位行 → AUDIT_PROJECT_UNRESOLVED', () => {
  const { p, chapter, hero } = setup('B0406');
  const shotId = newShot(p.id, chapter.id);
  assert.throws(() => writeShotBlockings('no-such-shot', [{ character_id: hero.id }]),
    (e) => e.code === 'SHOT_NOT_FOUND');

  // 直接塞一条指向不存在镜的站位行（模拟历史脏数据），再改它 ⇒ 归属反查失败必须抛
  writeShotBlockings(shotId, [{ character_id: hero.id, facing: 'front' }]);
  db.prepare('INSERT INTO shot_blockings (shot_id, character_id, facing) VALUES (?,?,?)').run('ghost-shot', hero.id, 'x');
  assert.throws(
    () => core.recordChange({
      entity: 'shot_blocking', action: 'update',
      before: { shot_id: 'ghost-shot', character_id: hero.id, facing: 'x' },
      after: { shot_id: 'ghost-shot', character_id: hero.id, facing: 'y' },
      entityId: JSON.stringify(['ghost-shot', hero.id]),
    }),
    (e) => e.code === 'AUDIT_PROJECT_UNRESOLVED',
  );
});

// ── 7. 审计失败 → 同事务回滚 ───────────────────────────────────────────
test('B04-07 审计失败 ⇒ 物理整组替换一起回滚（不留半组站位）', () => {
  const { p, chapter, hero, hero2 } = setup('B0407');
  const shotId = newShot(p.id, chapter.id);
  writeShotBlockings(shotId, [
    { character_id: hero.id, facing: 'front' },
    { character_id: hero2.id, facing: 'left' },
  ]);
  const rowsBefore = blockingRows(shotId);
  assert.equal(rowsBefore.length, 2);

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
  assert.deepEqual(blockingRows(shotId), rowsBefore, 'DELETE 必须随审计失败回滚');
});

// ── 8. 纯校验 ──────────────────────────────────────────────────────────
test('B04-08 缺 character_id / 同批重复 / 未知列 → 当场拒，且不落半行', () => {
  const { p, chapter, hero } = setup('B0408');
  const shotId = newShot(p.id, chapter.id);
  assert.throws(() => writeShotBlockings(shotId, [{ facing: 'front' }]), (e) => e.code === 'CHARACTER_REQUIRED');
  assert.throws(
    () => writeShotBlockings(shotId, [{ character_id: hero.id }, { character_id: hero.id }]),
    (e) => e.code === 'BLOCKING_DUPLICATED',
  );
  assert.throws(
    () => writeShotBlockings(shotId, [{ character_id: hero.id, blocking: '窗边' }]),
    (e) => e.code === 'BLOCKING_FIELD_INVALID',
  );
  assert.equal(blockingRows(shotId).length, 0, '校验失败不得留下任何行');
});

// ── 9. 不得写回 legacy shots.blocking ──────────────────────────────────
test('B04-09 站位只写 Stage 3：legacy shots 表零行、零写入', () => {
  const { p, chapter, hero } = setup('B0409');
  const shotId = newShot(p.id, chapter.id);
  const legacyBefore = db.prepare('SELECT COUNT(*) AS c FROM shots WHERE project_id = ?').get(p.id).c;
  writeShotBlockings(shotId, [{ character_id: hero.id, facing: 'front', position_abs: '窗边' }]);
  const legacyAfter = db.prepare('SELECT COUNT(*) AS c FROM shots WHERE project_id = ?').get(p.id).c;
  assert.equal(legacyAfter, legacyBefore, '站位写入不得创建/修改 legacy shots 行');
  assert.equal(blockingRows(shotId).length, 1);
});

// ── 10. 差集纯函数：只比显式给出的列 ────────────────────────────────────
test('B04-10 diffShotBlockings 只比调用方显式给出的列（缺省列不制造假 update）', () => {
  const before = [{ shot_id: 's', character_id: 'c1', facing: 'front', posture: '坐', norm_x: 0.5 }];
  // after 只给 facing（与原值相同）⇒ 不该因为"没给 posture"而判成变化
  const d = diffShotBlockings(before, [{ shot_id: 's', character_id: 'c1', facing: 'front' }]);
  assert.deepEqual(d.changed, []);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
});

// ── 11. 锁上下文清理 ───────────────────────────────────────────────────
test('B04-11 写入结束后锁上下文必须清空（异常路径也要清）', () => {
  const { p, chapter, hero } = setup('B0411');
  const shotId = newShot(p.id, chapter.id);
  writeShotBlockings(shotId, [{ character_id: hero.id }]);
  assert.equal(core.lockedProjects(), null);

  assert.throws(() => writeShotBlockings(shotId, [{ character_id: '' }]), (e) => e.code === 'CHARACTER_REQUIRED');
  assert.equal(core.lockedProjects(), null, '校验失败路径不得留下锁上下文');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 占用中 */ } });
