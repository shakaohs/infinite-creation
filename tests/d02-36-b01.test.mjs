// P10-A 阶段 B · B-01：场次基线写入（`scene_states`）
//
// 这一组锁四件事：
//   ① 身份 = `scene_states.id`（scene_uid）；**改 `scene_key` 不换身份**（D-30-02）；
//   ② 同一场次重写不产生第二行（幂等）；
//   ③ A1 `scene_state` 的 create/update 有审计，且 `state_rev` 自增不刷内容日志；
//   ④ 事务边界：整体在 `txProject` 内、进函数先断言持锁；审计失败必须把业务写入一起回滚。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-b01-'));
process.env.IC_DATA_DIR = TMP;

const core = await import('../lib/core/index.js');
const {
  getDb, tx, upsertSceneStates, recordChange, ENTITY_META, listChanges,
} = core;

const db = getDb();
const T = 1700000000000;
db.prepare('INSERT INTO projects (id,name,context,status,structured_spec,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
  .run('p-b01', 'B01 项目', '{}', 'idle', 1, T, T);
db.prepare('INSERT INTO chapters (id,project_id,title,novel,script,seq,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
  .run('ch-b01', 'p-b01', '第1章', '', '', 1, 'pending', T, T);
const chapter = { id: 'ch-b01', title: '第1章' };

const logsOf = (entity) => listChanges('p-b01', { entity, limit: 500 });

test('B01-01 新形态 (projectId, rows, {origin})：首建写库并返回 scene_uid', () => {
  const r = upsertSceneStates('p-b01', [{ scene_key: 'S01_病房', time_of_day: '日' }], { origin: 'test-b01' });
  assert.equal(r.created, 1);
  assert.equal(r.scenes.length, 1);
  const uid = r.scenes[0].scene_uid;
  assert.ok(uid, '必须回报 scene_uid（= scene_states.id）');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM scene_states WHERE project_id=?').get('p-b01').c, 1);
  assert.equal(uid, r.scenes[0].id);
});

test('B01-02 只给 scene_key 的老调用保持今天行为（按 (project, key) 定位）', () => {
  const r = upsertSceneStates('p-b01', chapter, [{ scene_key: 'S02_走廊', time_of_day: '夜' }]);
  assert.equal(r.created, 1);
  assert.equal(r.chapter, '第1章');
  const key = 'S02_走廊';
  const row = db.prepare('SELECT * FROM scene_states WHERE project_id=? AND scene_key=?').get('p-b01', key);
  assert.ok(row);
  // 再写一次：同一行、state_rev+1，不新建
  const r2 = upsertSceneStates('p-b01', chapter, [{ scene_key: key, time_of_day: '日' }]);
  assert.equal(r2.created, 0);
  assert.equal(r2.updated, 1);
  assert.equal(r2.scenes[0].scene_uid, row.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM scene_states WHERE project_id=?').get('p-b01').c, 2);
  assert.equal(r2.scenes[0].state_rev, 2);
});

test('B01-03 给 scene_uid + 新 scene_key：改名不换身份（本项核心）', () => {
  const created = upsertSceneStates('p-b01', [{ scene_key: 'S03_旧名', time_of_day: '日' }], {});
  const uid = created.scenes[0].scene_uid;
  const before = db.prepare('SELECT * FROM scene_states WHERE id=?').get(uid);

  const renamed = upsertSceneStates('p-b01', [{ scene_uid: uid, scene_key: 'S03_新名' }], { origin: 'rename' });
  assert.equal(renamed.created, 0, '改名不得新建场次');
  assert.equal(renamed.scenes[0].scene_uid, uid, '身份必须还是原 uid');
  const after = db.prepare('SELECT * FROM scene_states WHERE id=?').get(uid);
  assert.equal(after.scene_key, 'S03_新名');
  assert.equal(after.state_rev, Number(before.state_rev) + 1);
  // 老 key 不再有行，且没有多出一条
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM scene_states WHERE project_id=? AND scene_key='S03_旧名'").get('p-b01').c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM scene_states WHERE scene_key='S03_新名'").get().c, 1);
});

test('B01-04 改名撞上已有 scene_key：拒绝且不改库', () => {
  const a = upsertSceneStates('p-b01', [{ scene_key: 'S04_A' }], {}).scenes[0].scene_uid;
  upsertSceneStates('p-b01', [{ scene_key: 'S04_B' }], {});
  assert.throws(
    () => upsertSceneStates('p-b01', [{ scene_uid: a, scene_key: 'S04_B' }], {}),
    (e) => e.code === 'SCENE_KEY_DUPLICATED',
  );
  assert.equal(db.prepare('SELECT scene_key FROM scene_states WHERE id=?').get(a).scene_key, 'S04_A');
});

test('B01-05 不存在的 scene_uid 一律拒绝，不得静默新建', () => {
  const before = db.prepare('SELECT COUNT(*) AS c FROM scene_states WHERE project_id=?').get('p-b01').c;
  assert.throws(
    () => upsertSceneStates('p-b01', [{ scene_uid: 'sc-不存在', scene_key: 'S05_幽灵' }], {}),
    (e) => e.code === 'SCENE_UID_NOT_FOUND',
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM scene_states WHERE project_id=?').get('p-b01').c, before);
});

test('B01-06 A1 审计：create 记一条、state_rev 自增不记、改内容记一条', () => {
  const createLogs = logsOf('scene_state').length;
  const r = upsertSceneStates('p-b01', [{ scene_key: 'S06_审计', time_of_day: '日' }], { origin: 'b01' });
  const uid = r.scenes[0].scene_uid;
  const afterCreate = logsOf('scene_state');
  assert.equal(afterCreate.length, createLogs + 1, 'create 必须留一条审计');
  const log = afterCreate.find((l) => l.entity_id === uid && l.action === 'create');
  assert.ok(log, 'create 日志必须能按 entity_id 找到');
  assert.equal(log.project_id, 'p-b01', '归属必须从真实行解析');

  // 只改 time_of_day → 内容变化，记一条 update
  upsertSceneStates('p-b01', [{ scene_uid: uid, time_of_day: '夜' }], {});
  const afterContent = logsOf('scene_state').filter((l) => l.entity_id === uid);
  assert.equal(afterContent.length, 2, '内容变化必须留 update');

  // 再写一次相同内容：只有 state_rev/updated_at 变 ⇒ 不得再刷日志
  upsertSceneStates('p-b01', [{ scene_uid: uid, time_of_day: '夜' }], {});
  assert.equal(logsOf('scene_state').filter((l) => l.entity_id === uid).length, 2,
    'state_rev/updated_at 属 VOLATILE，纯自增不得产生内容日志');
});

test('B01-07 事务边界：普通 tx() 内调用被拒绝（必须在 txProject 最外层）', () => {
  assert.throws(
    () => tx(() => upsertSceneStates('p-b01', [{ scene_key: 'S07_锁' }], {})),
    (e) => e.code === 'TX_MUST_BE_IMMEDIATE',
    '在普通 tx 里再取项目锁 = 锁在事务中途才取，跨库语义不一致，必须拒',
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM scene_states WHERE scene_key='S07_锁'").get().c, 0);
});

test('B01-08 审计失败 ⇒ 业务写入同事务回滚', () => {
  const before = db.prepare('SELECT COUNT(*) AS c FROM scene_states').get().c;
  const saved = ENTITY_META.scene_state;
  delete ENTITY_META.scene_state;   // 制造 AUDIT_ENTITY_META_MISSING
  try {
    assert.throws(
      () => upsertSceneStates('p-b01', [{ scene_key: 'S08_回滚' }], {}),
      (e) => e.code === 'AUDIT_ENTITY_META_MISSING',
    );
  } finally {
    ENTITY_META.scene_state = saved;
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM scene_states').get().c, before, '场次行必须随审计失败一起回滚');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM scene_states WHERE scene_key='S08_回滚'").get().c, 0);
  // 复原后还能正常写（确认没把元数据搞坏）
  const ok = upsertSceneStates('p-b01', [{ scene_key: 'S08_回滚' }], {});
  assert.equal(ok.created, 1);
  void recordChange;
});
