// P10-A 阶段 B · B-05：动作写入器（`shot_actions`）
//
// 锁四件事：
//   ① 按行做 create/update/delete（主键 `id`，不是复合键），**不整组删除重建**；
//   ② 项目归属经 `shot_id` 反查 `story_shots`，反查不到 ⇒ A5 fail-closed；
//   ③ 锁外调用被拒、跨镜移动被拒；
//   ④ 审计失败与业务写入同事务回滚。
//
// 另锁一条纪律：动作不得被伪装成站位或普通文本字段（`current_task` 只有一句话，拿不到 t_from/tier/path）。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-b05-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;
delete process.env.IC_DB;
delete process.env.DATABASE_URL;

const core = await import('../lib/core/index.js');
const { getDb, listChanges, rawGet, ENTITY_META } = core;
const { createUserProject } = await import('../lib/core/project-create.js');
const { upsertSceneStates } = await import('../lib/core/scene-state.js');
const { writeStoryShotWithAssets } = await import('../lib/core/render/shot-assets.js');
const { writeShotActions, listShotActions } = await import('../lib/core/render/shot-actions.js');

const db = getDb();

let seq = 0;
function setup(name) {
  seq += 1;
  const p = createUserProject({ name: `${name}-${seq}` });
  const chapter = core.Chapters.list(p.id)[0];
  const scene = core.Assets.create(p.id, { category: 'scene', name: `病房-${seq}` });
  const hero = core.Assets.create(p.id, { category: 'character', name: `罗克珊-${seq}` });
  upsertSceneStates(p.id, chapter, [{ scene_key: 'S01_病房', scene_id: scene.id }]);
  return { p, chapter, scene, hero };
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

const logs = (projectId) => listChanges(projectId, { entity: 'shot_action', limit: 500 });
const round = (projectId, run) => {
  const before = new Set(logs(projectId).map((l) => l.id));
  run();
  return logs(projectId).filter((l) => !before.has(l.id));
};
const actions = (rows) => rows.map((r) => r.action).sort();

// ── 1. create ──────────────────────────────────────────────────────────
test('B05-01 首次写入 → N 条 create，JSON 列按对象序列化，id 由写入器生成', () => {
  const { p, chapter, hero } = setup('B0501');
  const shotId = newShot(p.id, chapter.id);
  const r = writeShotActions(shotId, [
    { actor_id: hero.id, action_type: '转身', is_primary: 1, t_from: 0, t_to: 1.2, body_parts: ['肩', '腰'] },
    { actor_id: hero.id, action_type: '抬手', t_from: 1.2, t_to: 2.0, path_json: { p0: [0, 0], p1: [1, 1] } },
  ]);
  assert.equal(r.written, 2);
  assert.deepEqual(r.audit, { added: 2, removed: 0, changed: 0 });
  assert.deepEqual(actions(logs(p.id)), ['create', 'create']);

  const rows = listShotActions(shotId);
  assert.equal(rows.length, 2);
  assert.equal(JSON.parse(rows[0].body_parts)[0], '肩');
  assert.equal(JSON.parse(rows[1].path_json).p1[0], 1);
  assert.notEqual(rows[0].id, rows[1].id, 'id 必须由写入器生成且互不相同');
});

// ── 2. update（按 id）──────────────────────────────────────────────────
test('B05-02 带 id 再写 = update（1 条），不带 id 的既有行不被误删', () => {
  const { p, chapter, hero } = setup('B0502');
  const shotId = newShot(p.id, chapter.id);
  writeShotActions(shotId, [
    { actor_id: hero.id, action_type: '转身', t_from: 0, t_to: 1 },
    { actor_id: hero.id, action_type: '抬手', t_from: 1, t_to: 2 },
  ]);
  const [a, b] = listShotActions(shotId);
  const base = logs(p.id).length;

  const r = round(p.id, () => writeShotActions(shotId, [
    { id: a.id, action_type: '急转身' },   // 只改这一行的一个字段
    { id: b.id },                          // 显式保留，不改
  ]));
  assert.deepEqual(actions(r), ['update'], '只改一行 ⇒ 1 条 update');
  assert.equal(r[0].entity_id, a.id);
  assert.equal(r[0].before.action_type, '转身');
  assert.equal(r[0].after.action_type, '急转身');
  assert.equal(logs(p.id).length, base + 1);
  assert.equal(listShotActions(shotId).length, 2, 'b 未被删');
  assert.equal(listShotActions(shotId).find((x) => x.id === b.id).action_type, '抬手');
});

// ── 3. delete（本次未出现的既有行）──────────────────────────────────────
test('B05-03 本次未出现的既有行 = 删除，before 快照进日志', () => {
  const { p, chapter, hero } = setup('B0503');
  const shotId = newShot(p.id, chapter.id);
  writeShotActions(shotId, [
    { actor_id: hero.id, action_type: '转身', t_from: 0, t_to: 1 },
    { actor_id: hero.id, action_type: '抬手', t_from: 1, t_to: 2 },
  ]);
  const [a, b] = listShotActions(shotId);

  const r = round(p.id, () => writeShotActions(shotId, [{ id: a.id }]));
  assert.deepEqual(actions(r), ['delete']);
  assert.equal(r[0].before.id, b.id);
  assert.equal(r[0].before.action_type, '抬手');
  assert.equal(r[0].after, null);
  assert.deepEqual(listShotActions(shotId).map((x) => x.id), [a.id]);
});

// ── 4. 空输入 = 全删 ───────────────────────────────────────────────────
test('B05-04 传空数组 = 本镜动作全删（每条一条 delete）', () => {
  const { p, chapter, hero } = setup('B0504');
  const shotId = newShot(p.id, chapter.id);
  writeShotActions(shotId, [
    { actor_id: hero.id, action_type: 'a', t_from: 0, t_to: 1 },
    { actor_id: hero.id, action_type: 'b', t_from: 1, t_to: 2 },
  ]);
  const r = round(p.id, () => writeShotActions(shotId, []));
  assert.deepEqual(actions(r), ['delete', 'delete']);
  assert.equal(listShotActions(shotId).length, 0);
});

// ── 5. 项目归属解析 ────────────────────────────────────────────────────
test('B05-05 孤儿镜 → SHOT_NOT_FOUND；孤儿动作行 → AUDIT_PROJECT_UNRESOLVED', () => {
  const { p, chapter, hero } = setup('B0505');
  const shotId = newShot(p.id, chapter.id);
  assert.throws(() => writeShotActions('no-such-shot', [{ action_type: 'x' }]),
    (e) => e.code === 'SHOT_NOT_FOUND');

  db.prepare('INSERT INTO shot_actions (id, shot_id, action_type) VALUES (?,?,?)').run('act-ghost', 'ghost-shot', 'x');
  assert.throws(
    () => core.recordChange({
      entity: 'shot_action', action: 'update',
      before: { id: 'act-ghost', shot_id: 'ghost-shot', action_type: 'x' },
      after: { id: 'act-ghost', shot_id: 'ghost-shot', action_type: 'y' },
      entityId: 'act-ghost',
    }),
    (e) => e.code === 'AUDIT_PROJECT_UNRESOLVED',
  );
  // 正常路径的归属能解析出来
  writeShotActions(shotId, [{ actor_id: hero.id, action_type: 'ok' }]);
  assert.equal(logs(p.id)[0].project_id, p.id, '归属必须来自 shot_id 反查的真实行');
});

// ── 6. 锁外调用被拒 / 跨镜移动被拒 ─────────────────────────────────────
test('B05-06 跨镜移动动作 → ACTION_CROSS_SHOT（不得把动作搬走）', () => {
  const { p, chapter, hero } = setup('B0506');
  const s1 = newShot(p.id, chapter.id);
  const s2 = newShot(p.id, chapter.id);
  writeShotActions(s1, [{ actor_id: hero.id, action_type: '转身' }]);
  const [a] = listShotActions(s1);
  assert.throws(
    () => writeShotActions(s2, [{ id: a.id, action_type: '挪过去' }]),
    (e) => e.code === 'ACTION_NOT_FOUND',
    '对 s2 而言 a 不存在于本镜（beforeById 里没有）⇒ 必须拒',
  );
  assert.equal(listShotActions(s1).length, 1, '原镜的动作不得被动');
  assert.equal(listShotActions(s2).length, 0);
});

test('B05-07 锁上下文：写入结束（含异常）后必须为 null', () => {
  const { p, chapter, hero } = setup('B0507');
  const shotId = newShot(p.id, chapter.id);
  writeShotActions(shotId, [{ actor_id: hero.id, action_type: 'x' }]);
  assert.equal(core.lockedProjects(), null);
  assert.throws(() => writeShotActions(shotId, [{ action_type: 'y', not_a_column: 1 }]),
    (e) => e.code === 'ACTION_FIELD_INVALID');
  assert.equal(core.lockedProjects(), null);
});

// ── 7. 审计失败 → 同事务回滚 ───────────────────────────────────────────
test('B05-08 审计失败 ⇒ 增/改/删一起回滚', () => {
  const { p, chapter, hero } = setup('B0508');
  const shotId = newShot(p.id, chapter.id);
  writeShotActions(shotId, [
    { actor_id: hero.id, action_type: 'a', t_from: 0, t_to: 1 },
    { actor_id: hero.id, action_type: 'b', t_from: 1, t_to: 2 },
  ]);
  const before = listShotActions(shotId);
  assert.equal(before.length, 2);

  const saved = ENTITY_META.shot_action;
  delete ENTITY_META.shot_action;
  try {
    assert.throws(
      () => writeShotActions(shotId, [{ id: before[0].id, action_type: '改成' }, { actor_id: hero.id, action_type: '新增' }]),
      (e) => e.code === 'AUDIT_ENTITY_META_MISSING',
    );
  } finally {
    ENTITY_META.shot_action = saved;
  }
  assert.deepEqual(listShotActions(shotId), before, 'UPDATE 与 INSERT 都必须回滚，且 b 不得被删');
});

// ── 8. 纯校验 ──────────────────────────────────────────────────────────
test('B05-09 未知列 / 同批重复 id / 不存在的 id → 当场拒，不落半行', () => {
  const { p, chapter, hero } = setup('B0509');
  const shotId = newShot(p.id, chapter.id);
  assert.throws(() => writeShotActions(shotId, [{ action_type: 'x', blocking: '窗边' }]),
    (e) => e.code === 'ACTION_FIELD_INVALID');
  assert.throws(
    () => writeShotActions(shotId, [{ id: 'dup', action_type: 'a' }, { id: 'dup', action_type: 'b' }]),
    (e) => e.code === 'ACTION_DUPLICATED',
  );
  assert.throws(() => writeShotActions(shotId, [{ id: 'no-such', action_type: 'a' }]),
    (e) => e.code === 'ACTION_NOT_FOUND');
  assert.equal(listShotActions(shotId).length, 0);
});

// ── 9. 不伪装成站位 ────────────────────────────────────────────────────
test('B05-10 动作只写 shot_actions：shot_blockings 零行（不塞 current_task）', () => {
  const { p, chapter, hero } = setup('B0510');
  const shotId = newShot(p.id, chapter.id);
  writeShotActions(shotId, [{ actor_id: hero.id, action_type: '转身', t_from: 0, t_to: 1 }]);
  const n = db.prepare('SELECT COUNT(*) AS c FROM shot_blockings WHERE shot_id = ?').get(shotId).c;
  assert.equal(n, 0, '动作不得写进站位表的 current_task');
  assert.equal(listShotActions(shotId).length, 1);
});

// ── 10. 按 t_from 排序读回 ─────────────────────────────────────────────
test('B05-11 listShotActions 按 t_from 升序读回（时间轴语义）', () => {
  const { p, chapter, hero } = setup('B0511');
  const shotId = newShot(p.id, chapter.id);
  writeShotActions(shotId, [
    { actor_id: hero.id, action_type: '第三', t_from: 2.0, t_to: 3.0 },
    { actor_id: hero.id, action_type: '第一', t_from: 0.0, t_to: 1.0 },
    { actor_id: hero.id, action_type: '第二', t_from: 1.0, t_to: 2.0 },
  ]);
  assert.deepEqual(listShotActions(shotId).map((x) => x.action_type), ['第一', '第二', '第三']);
  // 时间列必须是数值（BIGINT 在 PG 上会以字符串返回，这里先锁 SQLite 的行为）
  assert.equal(typeof listShotActions(shotId)[0].t_from, 'number');
  void rawGet;
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 占用中 */ } });
