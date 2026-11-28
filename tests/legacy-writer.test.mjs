// C-04：legacyShotWrite 兼容包装器（D02-40 §4.4 规则 6/7、§4.5 入口迁移）
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-legacyw-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;

const { getDb, Projects, Chapters, Shots } = await import('../lib/core/db.js');
const { legacyShotWrite, legacyWriterCallCount } = await import('../lib/core/shot-write.js');
const { setStructuredSpec } = await import('../lib/core/structured-spec.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = getDb();

test('LEG-01 source 必须非空（空 source = 放弃审计，拒绝）', () => {
  for (const bad of ['', '   ', null, undefined]) {
    assert.throws(() => legacyShotWrite(bad, () => 1), (e) => e.code === 'LEGACY_WRITER_SOURCE_REQUIRED', String(bad));
  }
});

test('LEG-02 第二个参数必须是函数', () => {
  assert.throws(() => legacyShotWrite('test', null), (e) => e.code === 'LEGACY_WRITER_FN_REQUIRED');
});

test('LEG-03 包装器写 A 组可用，并累计 LEGACY_WRITER_CALL', () => {
  const p = Projects.create({ name: 'LEG-03' });
  const ch = Chapters.list(p.id)[0];
  const before = legacyWriterCallCount();
  const s = legacyShotWrite('test:create', () => Shots.create(p.id, { chapter: ch.title, visual: 'v' }));
  assert.ok(s && s.id);
  assert.equal(legacyWriterCallCount(), before + 1, '计数必须 +1');
  legacyShotWrite('test:update', () => Shots.update(s.id, { visual: 'v2' }));
  assert.equal(Shots.get(s.id).visual, 'v2');
});

test('LEG-04 包装器不接受 projectId：多传一个参数不构成授权', () => {
  // 形参只有 (source, fn)
  assert.equal(legacyShotWrite.length, 2);
  const p = Projects.create({ name: 'LEG-04' });
  setStructuredSpec(p.id, true);
  const ch = Chapters.list(p.id)[0];
  // 即便硬塞一个 projectId，结构化项目的门禁照样拒（包装器不提供豁免）
  assert.throws(
    () => legacyShotWrite('test:structured', () => Shots.create(p.id, { chapter: ch.title }, { projectId: p.id })),
    (e) => e.code === 'STRUCTURED_LEGACY_WRITE_FORBIDDEN',
  );
});

test('LEG-05 项目归属由真实行解析，不看调用方声明', () => {
  const a = Projects.create({ name: 'LEG-05A' });
  const b = Projects.create({ name: 'LEG-05B' });
  const chA = Chapters.list(a.id)[0];
  const s = legacyShotWrite('test:owner', () => Shots.create(a.id, { chapter: chA.title, visual: 'v' }));
  // 试图借 patch 改归属：project_id 由服务层掌管，任何 writer 都不接受 ⇒ 必须抛，不得静默忽略
  assert.throws(
    () => legacyShotWrite('test:owner2', () => Shots.update(s.id, { visual: 'v2', project_id: b.id })),
    (e) => e.code === 'SHOT_FIELD_DENIED',
  );
  assert.equal(Shots.get(s.id).project_id, a.id, '归属永远按真实行解析，不接受外部声明');
});

test('LEG-06 静态：生产代码里不存在未包装的 Shots 四方法写调用', () => {
  const dirs = ['lib', 'app'].map((d) => path.join(ROOT, d));
  const offenders = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs|jsx)$/.test(ent.name)) continue;
      if (p.endsWith(path.join('lib', 'core', 'db.js'))) continue;   // 定义处
      const src = fs.readFileSync(p, 'utf8');
      const lines = src.split(/\r?\n/);
      for (const [i, line] of lines.entries()) {
        if (!/Shots\.(create|insertAt|update|remove)\s*\(/.test(line)) continue;
        if (/^\s*(\/\/|\*)/.test(line)) continue;                     // 注释
        const wrapped = /legacyShotWrite\(|withWriter\(|writeShotPrompt\(|writeRenderState\(|Shots\.(create|insertAt|update|remove)\s*=/;
        // 允许跨行写法：包装器在上一行、调用在续行（POST /shots 就是这种）
        const ctx = line + '\n' + (lines[i - 1] || '');
        if (!wrapped.test(ctx)) offenders.push(`${path.relative(ROOT, p)}: ${line.trim().slice(0, 100)}`);
      }
    }
  };
  dirs.forEach((d) => fs.existsSync(d) && walk(d));
  assert.deepEqual(offenders, [], '存在未包装的写调用：\n' + offenders.join('\n'));
});

test('LEG-07 迁移后的旧入口仍然可用（走包装器不改变行为）', () => {
  const p = Projects.create({ name: 'LEG-07' });
  const ch = Chapters.list(p.id)[0];
  const s = legacyShotWrite('test:7', () => Shots.create(p.id, { chapter: ch.title, visual: 'a', idx: 1 }));
  assert.equal(s.idx, 1);
  legacyShotWrite('test:7b', () => Shots.remove(s.id));
  assert.equal(Shots.get(s.id), null);
  void db;
});
