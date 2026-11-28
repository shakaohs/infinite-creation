// P10-A · A-06 审计元数据与 A 类 fail-closed（D-30-15 v3 / D02-40 §6.2、§6.3、§6.6）
//
// 这一组用例只测**元数据与门禁**，不测 Stage 3 的写入器（那是阶段 B）。
// 关键边界：`recordChange` 以前对未登记实体**静默返回 null**（"写了但查不到"与"没改"事后不可
// 区分），本轮把 A 类五个实体改成抛错 + 业务事务回滚。既有 6 实体的行为必须一字不变。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-a06-'));
process.env.IC_DATA_DIR = TMP;

const core = await import('../lib/core/index.js');
const {
  getDb, tx, recordChange, rawGet, listChanges, rollbackLogs, ENTITY_META,
  entityIdOf, compositeIdOf, auditWarnCount,
} = core;

const db = getDb();
const T = 1700000000000;

function mkProject(id = 'p-a06') {
  db.prepare('INSERT INTO projects (id,name,context,status,structured_spec,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, '审计测试项目', '{}', 'idle', 1, T, T);
  db.prepare('INSERT INTO chapters (id,project_id,title,novel,script,seq,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('ch-a06', id, '第1章', '', '', 1, 'pending', T, T);
  return id;
}

function mkStoryShot(id = 'ss-a06', projectId = 'p-a06') {
  db.prepare(`INSERT INTO story_shots (id,project_id,chapter_id,scene_key,shot_no,global_no,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?)`).run(id, projectId, 'ch-a06', 'sc-a06', 1, 1, T, T);
  return id;
}

function mkShotAssetRow(shotId = 'ss-a06', role = 'char', assetId = 'as-a06') {
  db.prepare('INSERT INTO shot_assets (shot_id,asset_id,role,order_no,variant_of) VALUES (?,?,?,?,?)')
    .run(shotId, assetId, role, 1, '');
  return { shot_id: shotId, asset_id: assetId, role, order_no: 1, variant_of: '' };
}

mkProject();
mkStoryShot();

const rowOf = (entity, id) => rawGet(entity, id);

test('A06-01 五个 Stage 3 实体全部登记，两张复合主键写成数组', () => {
  for (const e of ['scene_state', 'story_shot', 'shot_asset', 'shot_blocking', 'shot_action']) {
    assert.ok(ENTITY_META[e], `未登记 ${e}`);
  }
  assert.deepEqual(ENTITY_META.shot_asset.pk, ['shot_id', 'role', 'asset_id']);
  assert.deepEqual(ENTITY_META.shot_blocking.pk, ['shot_id', 'character_id']);
  assert.equal(ENTITY_META.shot_action.pk, 'id');
  // 既有 6 实体一字未动
  assert.equal(ENTITY_META.shot.pk, 'id');
  assert.equal(ENTITY_META.render_selection.pk, 'unit_id');
});

test('A06-02 entity_id 编码：单列主键=值本身，复合主键=JSON 数组串（可逆）', () => {
  assert.equal(entityIdOf('story_shot', { id: 'ss-x' }), 'ss-x');
  const composite = entityIdOf('shot_asset', { shot_id: 'ss-x', role: 'char', asset_id: 'as-y' });
  assert.equal(composite, '["ss-x","char","as-y"]');
  assert.deepEqual(JSON.parse(composite), ['ss-x', 'char', 'as-y']);
  assert.equal(compositeIdOf(['a', 'b']), '["a","b"]');
});

test('A06-03 rawGet 复合主键：数组键与 JSON 串等价；键不完整即抛 AUDIT_PK_AMBIGUOUS', () => {
  const row = mkShotAssetRow();
  assert.deepEqual(rawGet('shot_asset', ['ss-a06', 'char', 'as-a06']), row);
  assert.deepEqual(rawGet('shot_asset', '["ss-a06","char","as-a06"]'), row);
  assert.throws(() => rawGet('shot_asset', ['ss-a06', 'char']), (e) => e.code === 'AUDIT_PK_AMBIGUOUS');
});

test('A06-04 rawGet 命中多行（声明的主键其实不唯一）必须抛，不得取第一行', () => {
  // 造一张"主键其实不唯一"的表，临时登记一个实体来打这条分支：
  // 真实表上不可能命中多行，但实现若有 bug（例如只拼第一列）就会静默取错行，这里要能抓到。
  db.exec('CREATE TABLE IF NOT EXISTS audit_probe_dup (a TEXT NOT NULL, b TEXT NOT NULL)');
  db.exec("INSERT INTO audit_probe_dup VALUES ('1','2')");
  db.exec("INSERT INTO audit_probe_dup VALUES ('1','2')");
  ENTITY_META.__probe_dup = { table: 'audit_probe_dup', pk: ['a', 'b'], projectOf: () => 'p-a06' };
  try {
    assert.throws(() => rawGet('__probe_dup', ['1', '2']), (e) => e.code === 'AUDIT_PK_AMBIGUOUS');
  } finally {
    delete ENTITY_META.__probe_dup;
  }
});

test('A06-05 归属反查：shot_asset 经 story_shots 解析出 project_id 并写成日志', () => {
  const before = listChanges('p-a06', { entity: 'shot_asset', limit: 500 }).length;
  const row = mkShotAssetRow('ss-a06', 'prop', 'as-prop-1');
  const id = recordChange({ entity: 'shot_asset', action: 'create', after: row });
  assert.ok(id, 'A 类实体必须真的写出日志（不得返回 null）');
  const logs = listChanges('p-a06', { entity: 'shot_asset', limit: 500 });
  assert.equal(logs.length, before + 1);
  const log = logs[0];
  assert.equal(log.project_id, 'p-a06');
  assert.equal(log.entity_id, '["ss-a06","prop","as-prop-1"]');
  assert.deepEqual(log.after, row, 'before/after 必须是原始行快照');
});

test('A06-06 未登记实体：A 类默认 fail-closed，抛 AUDIT_ENTITY_META_MISSING', () => {
  assert.throws(
    () => recordChange({ entity: 'no_such_entity', action: 'create', after: { id: 'x' }, projectId: 'p-a06' }),
    (e) => e.code === 'AUDIT_ENTITY_META_MISSING',
  );
});

test('A06-07 归属无法解析：抛 AUDIT_PROJECT_UNRESOLVED（不得静默丢弃审计）', () => {
  const orphan = { shot_id: 'ss-不存在', asset_id: 'as-z', role: 'char', order_no: 1, variant_of: '' };
  assert.throws(
    () => recordChange({ entity: 'shot_asset', action: 'create', after: orphan }),
    (e) => e.code === 'AUDIT_PROJECT_UNRESOLVED',
  );
});

test('A06-08 快照不可读：create 缺 after / update 缺 before 一律 AUDIT_SNAPSHOT_UNREADABLE', () => {
  assert.throws(
    () => recordChange({ entity: 'story_shot', action: 'create', after: null, projectId: 'p-a06' }),
    (e) => e.code === 'AUDIT_SNAPSHOT_UNREADABLE',
  );
  assert.throws(
    () => recordChange({ entity: 'story_shot', action: 'update', before: null, after: { id: 'ss-a06' }, projectId: 'p-a06' }),
    (e) => e.code === 'AUDIT_SNAPSHOT_UNREADABLE',
  );
});

test('A06-09 fail-closed 与业务同事务回滚：断言抛错后业务写入必须一起消失', () => {
  db.prepare('INSERT INTO scene_states (id,project_id,scene_key,state_rev) VALUES (?,?,?,?)').run('scs-a06', 'p-a06', 'sc-a06', 1);
  const before = db.prepare('SELECT COUNT(*) AS c FROM scene_states').get().c;
  assert.throws(() => tx(() => {
    db.prepare('INSERT INTO scene_states (id,project_id,scene_key,state_rev) VALUES (?,?,?,?)').run('scs-a06-new', 'p-a06', 'sc-a06-new', 1);
    // 故意让审计失败：实体未登记
    recordChange({ entity: 'not_registered_entity', action: 'create', after: { id: 'x' }, projectId: 'p-a06' });
  }), (e) => e.code === 'AUDIT_ENTITY_META_MISSING');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM scene_states').get().c, before, '业务写入必须随审计失败一起回滚');
});

test('A06-10 A3 复合主键实体：applyInverse 一律拒绝，且不写 reverted_by', () => {
  const row = mkShotAssetRow('ss-a06', 'voice', 'as-voice-1');
  const logId = recordChange({ entity: 'shot_asset', action: 'create', after: row });
  assert.ok(logId);
  assert.throws(
    () => rollbackLogs({ projectId: 'p-a06', logId }),
    (e) => e.code === 'ROLLBACK_UNSUPPORTED_ENTITY',
  );
  const r = db.prepare('SELECT reverted_by FROM change_logs WHERE id=?').get(logId);
  assert.equal(r.reverted_by, '', '拒绝回滚时不得留下"已回滚"标记');
  // 行也还在
  assert.ok(db.prepare('SELECT * FROM shot_assets WHERE shot_id=? AND role=? AND asset_id=?').get('ss-a06', 'voice', 'as-voice-1'));
});

test('A06-11 VOLATILE 生效：story_shot 只改 voice_ids / updated_at 不记日志；改内容记 1 条', () => {
  const before = rowOf('story_shot', 'ss-a06');
  const onlyVolatile = { ...before, voice_ids: '["v1"]', updated_at: T + 1 };
  assert.equal(recordChange({ entity: 'story_shot', action: 'update', before, after: onlyVolatile }), null, '纯易变字段不应产生日志');
  const contentChange = { ...onlyVolatile, dialogue: '你好' };
  assert.ok(recordChange({ entity: 'story_shot', action: 'update', before: onlyVolatile, after: contentChange }));
});

test('A06-12 scene_state 的 state_rev 属易变字段：自增不产生内容日志', () => {
  db.prepare('INSERT INTO scene_states (id,project_id,scene_key,state_rev) VALUES (?,?,?,?)').run('scs-a06-v', 'p-a06', 'sc-v', 1);
  const before = rowOf('scene_state', 'scs-a06-v');
  assert.equal(recordChange({ entity: 'scene_state', action: 'update', before, after: { ...before, state_rev: 2, updated_at: T + 5 } }), null);
  assert.ok(recordChange({ entity: 'scene_state', action: 'update', before, after: { ...before, time_of_day: '夜' } }));
});

test('A06-13 既有 6 实体行为不变：shot 的 create/update/delete 仍按老语义记录', () => {
  db.prepare('INSERT INTO shots (id,project_id,idx,chapter,scene_name,blocking,duration,status,error,video_path,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run('sh-a06', 'p-a06', 1, '第1章', '', '', 3, 'pending', '', '', T);
  const before = rowOf('shot', 'sh-a06');
  const id = recordChange({ entity: 'shot', action: 'create', after: before });
  assert.ok(id);
  // update 只动易变字段 → 不记（与历史一致）
  assert.equal(recordChange({ entity: 'shot', action: 'update', before, after: { ...before, status: 'done' } }), null);
  // 未登记实体不再静默返回 null（本轮唯一行为变化），且 B 类计数器不因它自增
  assert.equal(auditWarnCount('no_such_entity'), 0);
});
