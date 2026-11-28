// C-03：Shots 四个方法的 writer 门禁（D02-40 §4.2/§4.3/§4.4）
//
// 这组测的是**拒绝**，不是"能写"：门禁的价值全部在"不该写的时候写不进去"。
// 每条用例都断言错误码，而不只看抛没抛 —— 抛错的理由不对，等于门禁也没对上。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-aud01-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;

const { getDb, Projects, Chapters, Shots } = await import('../lib/core/db.js');
const { setStructuredSpec } = await import('../lib/core/structured-spec.js');

const db = getDb();
let seq = 0;
const uniq = (p) => `${p}-${++seq}`;

function mkProject(structured = false, name = 'C03') {
  const p = Projects.create({ name: uniq(name) });
  if (structured) setStructuredSpec(p.id, true);
  return p;
}
function mkShot(projectId, fields = {}) {
  const ch = Chapters.list(projectId)[0];
  return Shots.create(projectId, { chapter: ch.title, visual: '画面', duration: 4, ...fields }, { writer: 'creative' });
}
const codeOf = (fn) => { try { fn(); return null; } catch (e) { return e.code || 'NO_CODE'; } };

test('AUD01-01 缺少 writer ⇒ WRITER_REQUIRED（不默认 creative、不写库）', () => {
  const p = mkProject();
  const ch = Chapters.list(p.id)[0];
  const before = db.prepare('SELECT COUNT(*) AS n FROM shots').get().n;
  assert.equal(codeOf(() => Shots.create(p.id, { chapter: ch.title, visual: 'x' })), 'WRITER_REQUIRED');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shots').get().n, before, '被拒时不得落库');
  const s = mkShot(p.id);
  assert.equal(codeOf(() => Shots.update(s.id, { visual: 'y' })), 'WRITER_REQUIRED');
  assert.equal(codeOf(() => Shots.remove(s.id)), 'WRITER_REQUIRED');
});

test('AUD01-02 非法 writer ⇒ WRITER_INVALID', () => {
  const p = mkProject();
  const ch = Chapters.list(p.id)[0];
  assert.equal(codeOf(() => Shots.create(p.id, { chapter: ch.title }, { writer: 'admin' })), 'WRITER_INVALID');
});

test('AUD01-03 creative（=0）可写 A/B 组', () => {
  const p = mkProject();
  const s = mkShot(p.id, { visual: 'v1', video_prompt: 'p1' });
  assert.equal(s.visual, 'v1');
  assert.equal(s.video_prompt, 'p1');
  Shots.update(s.id, { visual: 'v2', narration: '旁白' }, { writer: 'creative' });
  assert.equal(Shots.get(s.id).visual, 'v2');
});

test('AUD01-04 creative 写 C 组（status/video_path/seed）⇒ SHOT_FIELD_DENIED', () => {
  const p = mkProject();
  const s = mkShot(p.id);
  for (const f of ['status', 'video_path', 'seed', 'prompt_id', 'error']) {
    assert.equal(codeOf(() => Shots.update(s.id, { [f]: f === 'seed' ? 7 : 'x' }, { writer: 'creative' })), 'SHOT_FIELD_DENIED', f);
  }
});

test('AUD01-05 creative 写 E 组（resolution/aspect_ratio）⇒ SHOT_FIELD_DENIED', () => {
  const p = mkProject();
  const s = mkShot(p.id);
  assert.equal(codeOf(() => Shots.update(s.id, { resolution: '1080P' }, { writer: 'creative' })), 'SHOT_FIELD_DENIED');
  assert.equal(codeOf(() => Shots.update(s.id, { aspect_ratio: '9:16' }, { writer: 'creative' })), 'SHOT_FIELD_DENIED');
});

test('AUD01-06 render 只能写 C 组，写 A/B 一律拒', () => {
  const p = mkProject();
  const s = mkShot(p.id);
  Shots.update(s.id, { status: 'generating', seed: 3 }, { writer: 'render' });
  assert.equal(Shots.get(s.id).status, 'generating');
  assert.equal(codeOf(() => Shots.update(s.id, { visual: 'v' }, { writer: 'render' })), 'SHOT_FIELD_DENIED');
  assert.equal(codeOf(() => Shots.update(s.id, { video_prompt: 'p' }, { writer: 'render' })), 'SHOT_FIELD_DENIED');
});

test('AUD01-07 system 只能写 E 组，写 A/C 一律拒', () => {
  const p = mkProject();
  const s = mkShot(p.id);
  Shots.update(s.id, { resolution: '1080P', aspect_ratio: '9:16' }, { writer: 'system' });
  assert.equal(Shots.get(s.id).resolution, '1080P');
  assert.equal(codeOf(() => Shots.update(s.id, { visual: 'v' }, { writer: 'system' })), 'SHOT_FIELD_DENIED');
  assert.equal(codeOf(() => Shots.update(s.id, { status: 'done' }, { writer: 'system' })), 'SHOT_FIELD_DENIED');
});

test('AUD01-08 未知字段 ⇒ SHOT_FIELD_UNKNOWN（不静默丢）', () => {
  const p = mkProject();
  const s = mkShot(p.id);
  assert.equal(codeOf(() => Shots.update(s.id, { not_a_column: 1 }, { writer: 'creative' })), 'SHOT_FIELD_UNKNOWN');
});

test('AUD01-09 部分列更新：键缺失与 undefined 都不动库，且不覆盖并发写入', () => {
  const p = mkProject();
  const s = mkShot(p.id, { visual: '原画面', dialogue: '原台词', narration: '原旁白' });
  // 只提交 visual，其余列必须原样保留
  Shots.update(s.id, { visual: '新画面' }, { writer: 'creative' });
  const after = Shots.get(s.id);
  assert.equal(after.visual, '新画面');
  assert.equal(after.dialogue, '原台词');
  assert.equal(after.narration, '原旁白');
  // undefined ⇒ 不写（显式传 undefined 与"键缺失"同义）
  Shots.update(s.id, { visual: undefined, dialogue: '改台词' }, { writer: 'creative' });
  assert.equal(Shots.get(s.id).visual, '新画面');
  assert.equal(Shots.get(s.id).dialogue, '改台词');
});

test('AUD01-10 三态：空串与 null 都显式清空（null 落 SQL NULL）', () => {
  const p = mkProject();
  const s = mkShot(p.id, { visual: '画面', narration: '旁白' });
  Shots.update(s.id, { visual: '' }, { writer: 'creative' });
  assert.equal(Shots.get(s.id).visual, '', '空串 ⇒ 空串');
  Shots.update(s.id, { narration: null }, { writer: 'creative' });
  const raw = db.prepare('SELECT narration FROM shots WHERE id = ?').get(s.id);
  assert.equal(raw.narration, null, 'null ⇒ SQL NULL（不是空串、也不是默认值）');
});

test('AUD01-11 结构化项目（=1）：create / insertAt / remove 一律拒', () => {
  const p = mkProject(true, 'C03S');
  const ch = Chapters.list(p.id)[0];
  assert.equal(codeOf(() => Shots.create(p.id, { chapter: ch.title }, { writer: 'creative' })), 'STRUCTURED_LEGACY_WRITE_FORBIDDEN');
  assert.equal(codeOf(() => Shots.insertAt(p.id, ch.title, 1, {}, { writer: 'creative' })), 'STRUCTURED_LEGACY_WRITE_FORBIDDEN');
  // 造一条段行再删（结构化项目下应由投影建立，这里直接插库模拟）
  const sid = 'seg-c03-x';
  db.prepare('INSERT INTO shots (id,project_id,idx,chapter,status,error) VALUES (?,?,?,?,?,?)').run(sid, p.id, 1, ch.title, 'pending', '');
  assert.equal(codeOf(() => Shots.remove(sid, { writer: 'creative' })), 'STRUCTURED_LEGACY_WRITE_FORBIDDEN');
  assert.ok(db.prepare('SELECT id FROM shots WHERE id = ?').get(sid), '被拒时不得删行');
});

test('AUD01-12 结构化项目（=1）：A 组拒（转 Stage 3）、B 组拒（转参数入口）', () => {
  const p = mkProject(true, 'C03S2');
  const ch = Chapters.list(p.id)[0];
  const sid = 'seg-c03-y';
  db.prepare('INSERT INTO shots (id,project_id,idx,chapter,status,error) VALUES (?,?,?,?,?,?)').run(sid, p.id, 1, ch.title, 'pending', '');
  assert.equal(codeOf(() => Shots.update(sid, { visual: 'v' }, { writer: 'creative' })), 'STRUCTURED_LEGACY_WRITE_FORBIDDEN');
  assert.equal(codeOf(() => Shots.update(sid, { video_prompt: 'p' }, { writer: 'creative' })), 'STRUCTURED_PARAM_WRITE_REQUIRED');
});

test('AUD01-13 结构化项目（=0）行为不退化：A/B 照常可写', () => {
  const p = mkProject(false, 'C03L');
  const s = mkShot(p.id, { visual: 'legacy' });
  Shots.update(s.id, { visual: 'legacy2' }, { writer: 'creative' });
  assert.equal(Shots.get(s.id).visual, 'legacy2');
});
