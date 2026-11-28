// C-02：段级生成参数专用入口（D02-40 §4.2 ShotParams / §4.3 三态）
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-aud07-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;

const { getDb, Projects, Chapters } = await import('../lib/core/db.js');
const { ShotParams, UNIT_PARAM_FIELDS } = await import('../lib/core/render/unit-params.js');
const { listChanges, ENTITY_META } = await import('../lib/core/changelog.js');

const db = getDb();
let n = 0;
function mkUnit(extra = {}) {
  const p = Projects.create({ name: 'AUD07-' + (++n) });
  const ch = Chapters.list(p.id)[0];
  const id = 'seg-aud07-' + n;
  db.prepare('INSERT INTO shots (id,project_id,idx,chapter,status,error) VALUES (?,?,?,?,?,?)')
    .run(id, p.id, 1, ch.title, 'pending', '');
  for (const [k, v] of Object.entries(extra)) db.prepare(`UPDATE shots SET ${k} = ? WHERE id = ?`).run(v, id);
  return { id, projectId: p.id };
}
const logs = (pid, id) => listChanges(pid, { limit: 200 }).filter((l) => l.entity === 'shot' && l.entity_id === id);

test('AUD07-01 白名单就是 B 组 5 列', () => {
  assert.deepEqual([...UNIT_PARAM_FIELDS], ['video_prompt', 'mode', 'first_frame_path', 'last_frame_path', 'reference_image_path']);
});

test('AUD07-02 五列都能写，且只写这一行', () => {
  const { id } = mkUnit();
  const r = ShotParams.update(id, {
    video_prompt: '提示词', mode: 'reference',
    first_frame_path: '/a.png', last_frame_path: '/b.png', reference_image_path: '/c.png',
  }, { origin: 'test' });
  assert.equal(r.changed, true);
  const row = db.prepare('SELECT * FROM shots WHERE id = ?').get(id);
  assert.equal(row.video_prompt, '提示词');
  assert.equal(row.mode, 'reference');
  assert.equal(row.first_frame_path, '/a.png');
  assert.equal(row.last_frame_path, '/b.png');
  assert.equal(row.reference_image_path, '/c.png');
});

test('AUD07-03 越权字段一律拒（A/C/E 组都不行）', () => {
  const { id } = mkUnit();
  for (const f of ['visual', 'status', 'video_path', 'resolution', 'seed']) {
    assert.throws(() => ShotParams.update(id, { [f]: 'x' }), (e) => e.code === 'UNIT_PARAM_FIELD_DENIED', f);
  }
});

test('AUD07-04 单次写入只产生一条 update 审计，before/after 与库一致', () => {
  const { id, projectId } = mkUnit();
  const before = logs(projectId, id).length;
  ShotParams.update(id, { video_prompt: '第一版' }, { origin: 'test' });
  const ls = logs(projectId, id);
  assert.equal(ls.length - before, 1, '一次写入 = 一条日志');
  const last = ls[ls.length - 1];
  assert.equal(last.action, 'update');
  assert.equal(last.before.video_prompt, '');
  assert.equal(last.after.video_prompt, '第一版');
  const row = db.prepare('SELECT * FROM shots WHERE id = ?').get(id);
  assert.equal(last.after.video_prompt, row.video_prompt, 'after 必须等于落库值');
});

test('AUD07-05 三态：缺失/undefined 不写；空串与 null 显式清空', () => {
  const { id, projectId } = mkUnit({ video_prompt: '原始', mode: 'reference' });
  // 缺失 ⇒ 不动
  ShotParams.update(id, {}, { origin: 'test' });
  assert.equal(db.prepare('SELECT video_prompt FROM shots WHERE id = ?').get(id).video_prompt, '原始');
  // undefined ⇒ 不动
  ShotParams.update(id, { video_prompt: undefined, mode: 'text' }, { origin: 'test' });
  const r1 = db.prepare('SELECT video_prompt, mode FROM shots WHERE id = ?').get(id);
  assert.equal(r1.video_prompt, '原始', 'undefined 不等于清空');
  assert.equal(r1.mode, 'text');
  // 空串 ⇒ 空串
  ShotParams.update(id, { video_prompt: '' }, { origin: 'test' });
  assert.equal(db.prepare('SELECT video_prompt FROM shots WHERE id = ?').get(id).video_prompt, '');
  // null ⇒ NULL
  ShotParams.update(id, { mode: null }, { origin: 'test' });
  assert.equal(db.prepare('SELECT mode FROM shots WHERE id = ?').get(id).mode, null);
  void projectId;
});

test('AUD07-06 无实质变化不写库也不留日志（同值重写）', () => {
  const { id, projectId } = mkUnit({ video_prompt: '同值' });
  const before = logs(projectId, id).length;
  ShotParams.update(id, { video_prompt: '同值' }, { origin: 'test' });
  assert.equal(logs(projectId, id).length, before, '同值重写不应产生内容日志');
});

test('AUD07-07 审计失败 ⇒ 业务写入整体回滚', () => {
  const { id } = mkUnit({ video_prompt: '旧值' });
  const saved = ENTITY_META.shot.projectOf;
  ENTITY_META.shot.projectOf = () => { throw new Error('audit boom'); };
  try {
    assert.throws(() => ShotParams.update(id, { video_prompt: '不该留下' }, { origin: 'test' }));
  } finally {
    ENTITY_META.shot.projectOf = saved;
  }
  assert.equal(db.prepare('SELECT video_prompt FROM shots WHERE id = ?').get(id).video_prompt, '旧值', '必须回滚');
});

test('AUD07-08 段不存在 ⇒ UNIT_NOT_FOUND（不静默成功）', () => {
  assert.throws(() => ShotParams.update('seg-不存在', { mode: 'text' }), (e) => e.code === 'UNIT_NOT_FOUND');
});
