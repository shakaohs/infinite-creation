// 阶段 3 · P1 · A-02：新项目默认开启结构化模式（D02-06 §4.3.3 O-01~O-07）
//
// 这一组测的不是"新功能能跑"，而是**默认值落点**：
//   用户建项目 → 1；低层 Projects.create → 0（这是 140+ 既有用例与全部测试夹具的基线，故意不翻）。
// 一旦有人把默认值挪进 Projects.create，O-03 会立刻红 —— 那正是要防的事故。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-p1-create-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { getDb, Projects, Shots, initSchema } = await import('../lib/core/db.js');
const { groupOfShotField } = await import('../lib/core/writer.js');
const { isStructuredSpec } = await import('../lib/core/structured-spec.js');
const { createUserProject } = await import('../lib/core/project-create.js');
const { TOOL_DEFINITIONS } = await import('../lib/agent/tools.js');

// ── P10-A C-03：Shots 四个方法现在要求显式 writer ──────────────────────────────
// 历史用例按"创作写者"直接写 shots，与生产侧 legacyShotWrite 同一条路径；
// 混组写入按矩阵拆成多次，不在测试里放宽矩阵。门禁的拒绝由 tests/tst-aud-01~06 验证。
{
  const raw = {
    create: Shots.create.bind(Shots), insertAt: Shots.insertAt.bind(Shots),
    update: Shots.update.bind(Shots), remove: Shots.remove.bind(Shots),
  };
  const buckets = (fields) => {
    const b = { A: {}, B: {}, C: {}, E: {} };
    for (const [k, v] of Object.entries(fields)) { const g = groupOfShotField(k) || 'A'; (b[g] || b.A)[k] = v; }
    return b;
  };
  Shots.update = (id, fields = {}, o) => {
    if (o && o.writer) return raw.update(id, fields, o);
    const b = buckets(fields);
    let out = null;
    if (Object.keys(b.C).length) out = raw.update(id, b.C, { writer: 'render' });
    if (Object.keys(b.E).length) out = raw.update(id, b.E, { writer: 'system' });
    const ab = { ...b.A, ...b.B };
    if (Object.keys(ab).length) out = raw.update(id, ab, { writer: 'creative' });
    return out || Shots.get(id);
  };
  Shots.create = (p, s = {}, o) => {
    if (o && o.writer) return raw.create(p, s, o);
    const b = buckets(s);
    const w = Object.keys(b.C).length ? 'render' : (Object.keys(b.E).length ? 'system' : 'creative');
    return raw.create(p, { ...b.A, ...b.B, ...b.C, ...b.E }, { writer: w });
  };
  Shots.insertAt = (p, c, i, s, o) => raw.insertAt(p, c, i, s || {}, o || { writer: 'creative' });
  Shots.remove = (id, o) => raw.remove(id, o || { writer: 'creative' });
}

const db = getDb();
const flagOf = (id) => db.prepare('SELECT structured_spec FROM projects WHERE id = ?').get(id)?.structured_spec;

// P2 才落地的四个结构化写工具：O-05~O-07 依赖它们，没落地就显式 skip（不假通过、不假失败）
const STRUCTURED_TOOLS = ['set_shot_detail', 'set_shot_actions', 'set_shot_blockings', 'set_scene_state'];
const toolNames = new Set((TOOL_DEFINITIONS || []).map((t) => t?.function?.name).filter(Boolean));
const missingTools = STRUCTURED_TOOLS.filter((n) => !toolNames.has(n));
const P2_PENDING = missingTools.length ? `依赖 P2：${missingTools.join(' / ')} 尚未实现` : false;

// ── O-01 ────────────────────────────────────────────────────────────────
test('O-01 createUserProject({name}) → 库里 structured_spec=1，isStructuredSpec 为 true', () => {
  const p = createUserProject({ name: 'O-01 新项目' });
  assert.ok(p && p.id, '应返回项目行');
  assert.equal(p.name, 'O-01 新项目');
  assert.equal(flagOf(p.id), 1, '用户建项目默认开启结构化模式');
  assert.equal(isStructuredSpec(p.id), true);

  // P-6：toProject() 给的是 0/1 数字，不是布尔 —— 把"别写 === true"钉在断言里
  assert.equal(typeof p.structured_spec, 'number');
  assert.equal(p.structured_spec === true, false, 'structured_spec 是数字，不是布尔（禁止 === true 判断）');
  assert.equal(p.structured_spec === 1, true);

  // 返回结构不变：仍然自动建了「第1章」
  assert.equal(db.prepare('SELECT COUNT(*) n FROM chapters WHERE project_id = ?').get(p.id).n, 1);

  // 脏值不静默：非布尔一律拒绝，且不留下半个项目
  const before = db.prepare('SELECT COUNT(*) n FROM projects').get().n;
  for (const bad of [1, 0, 'true', '1', null]) {
    assert.throws(
      () => createUserProject({ name: 'O-01 脏值', structured_spec: bad }),
      (e) => e.code === 'BAD_FLAG_VALUE',
      `structured_spec=${JSON.stringify(bad)} 必须被拒`,
    );
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM projects').get().n, before, '被拒的创建不得落库');
});

// ── O-02 ────────────────────────────────────────────────────────────────
test('O-02 createUserProject({structured_spec:false}) → 0，旧链路可写', () => {
  const p = createUserProject({ name: 'O-02 旧链路', structured_spec: false });
  assert.equal(flagOf(p.id), 0);
  assert.equal(isStructuredSpec(p.id), false);

  // 旧链路写入（legacy shots）必须照常可用：关着开关的项目不许被新路径接管
  const ch = db.prepare('SELECT * FROM chapters WHERE project_id = ? ORDER BY seq ASC').get(p.id);
  assert.ok(ch, '旧链路仍应自动建「第1章」');
  const s = Shots.create(p.id, { chapter: ch.title, idx: 1, visual: 'legacy shot', duration: 3 });
  assert.ok(s && s.id, 'legacy Shots.create 必须可写');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM shots WHERE project_id = ?').get(p.id).n, 1);

  // 新表一行都不该有：开关关着就不走结构化写入
  // （shot_actions 没有 project_id，只能经 story_shots 反查 —— 写错列名会让"没行"变成假通过）
  for (const t of ['story_shots', 'scene_states']) {
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE project_id = ?`).get(p.id).n, 0, `${t} 不应有行`);
  }
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM shot_actions a JOIN story_shots s ON s.id = a.shot_id WHERE s.project_id = ?').get(p.id).n,
    0,
    'shot_actions 不应有行',
  );
});

// ── O-03 ────────────────────────────────────────────────────────────────
test('O-03 Projects.create({name})（低层原语）→ 仍为 0（既有用例的基线，故意不翻）', () => {
  const p = Projects.create({ name: 'O-03 低层原语' });
  assert.equal(flagOf(p.id), 0);
  assert.equal(isStructuredSpec(p.id), false);
  // 显式传 1 时低层仍然认（灰度/迁移脚本需要），但默认绝不为 1
  const p2 = Projects.create({ name: 'O-03 显式 1', structured_spec: 1 });
  assert.equal(flagOf(p2.id), 1);
});

// ── O-04 ────────────────────────────────────────────────────────────────
test('O-04 三个 structured_spec=0 的历史项目 → initSchema 反复跑后仍为 0（不 backfill）', () => {
  const ids = ['甲', '乙', '丙'].map((n) => Projects.create({ name: 'O-04 历史-' + n }).id);
  const before = ids.map(flagOf);
  assert.deepEqual(before, [0, 0, 0], '前提：三个历史项目都是 0');

  // "迁移"= 现有的 initSchema 路径（建表 + ensureColumn + 基线登记）；跑两遍模拟重复执行
  initSchema(getDb());
  initSchema(getDb());

  assert.deepEqual(ids.map(flagOf), [0, 0, 0], '历史项目不得被 backfill 成 1');

  // 反向对照：同一库里的新项目仍是 1 —— 证明上面"三个 0 没变"不是因为整列都没人动
  const fresh = createUserProject({ name: 'O-04 新项目' });
  assert.equal(flagOf(fresh.id), 1);
  assert.deepEqual(ids.map(flagOf), [0, 0, 0], '插入新项目也不得连带改历史行');
});

// ── O-05 ────────────────────────────────────────────────────────────────
test('O-05 关 flag 后调 4 个新工具 → 全部 STRUCTURED_SPEC_DISABLED，各表行数不变', { skip: P2_PENDING }, async () => {
  const { runTool } = await import('../lib/core/index.js');
  const p = createUserProject({ name: 'O-05 flag 关', structured_spec: false });
  const ch = db.prepare('SELECT * FROM chapters WHERE project_id = ? ORDER BY seq ASC').get(p.id);
  const counts = () => [
    db.prepare('SELECT COUNT(*) n FROM story_shots WHERE project_id = ?').get(p.id).n,
    db.prepare('SELECT COUNT(*) n FROM scene_states WHERE project_id = ?').get(p.id).n,
    db.prepare('SELECT COUNT(*) n FROM shot_actions a JOIN story_shots s ON s.id = a.shot_id WHERE s.project_id = ?').get(p.id).n,
  ];
  const before = counts();

  const calls = [
    ['set_shot_detail', { chapter: ch.title, shot_no: 1, shot_size: 'close-up' }],
    ['set_shot_actions', { chapter: ch.title, shot_no: 1, actions: [] }],
    ['set_shot_blockings', { chapter: ch.title, shot_no: 1, blockings: [] }],
    ['set_scene_state', { scene_key: 'scene-1', state: {} }],
  ];
  for (const [name, args] of calls) {
    await assert.rejects(
      () => Promise.resolve(runTool(name, args, { projectId: p.id })),
      (e) => e.code === 'STRUCTURED_SPEC_DISABLED',
      `${name} 在开关关闭时必须拒绝`,
    );
  }
  assert.deepEqual(counts(), before, '被拒的调用不得写入任何结构化行');
});

// ── O-06 ────────────────────────────────────────────────────────────────
// O-06 测的是"开关只改行为、不删数据"这条库级不变量，不依赖工具：
// 结构化行直接用 SQL 种进去（写工具要 P2 才有），因此本用例**不需要 skip**。
test('O-06 关 flag 再开 flag → 所有结构化行仍在，内容一致', async () => {
  const { setStructuredSpec } = await import('../lib/core/structured-spec.js');
  const p = createUserProject({ name: 'O-06 来回切' });
  db.prepare("INSERT INTO story_shots (id, project_id, chapter_id, shot_no, global_no, scene_key, visual_content, story_duration, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run('ss_o06', p.id, 'ch_o06', 1, 1, 'scene-1', '内容不变', 3, Date.now(), Date.now());
  const snap = () => db.prepare('SELECT * FROM story_shots WHERE project_id = ?').all(p.id);

  const a = snap();
  setStructuredSpec(p.id, false);
  assert.deepEqual(snap(), a, '关开关不得删行/改行');
  setStructuredSpec(p.id, true);
  assert.deepEqual(snap(), a, '重新打开后内容必须一致');
});

// ── O-07 ────────────────────────────────────────────────────────────────
test('O-07 A 项目 flag=true，传 B 项目的 shot_id / chapter_id / asset_id → 各自抛 NOT_IN_PROJECT', { skip: P2_PENDING }, async () => {
  const { runTool } = await import('../lib/core/index.js');
  const { Assets } = await import('../lib/core/db.js');
  const a = createUserProject({ name: 'O-07 A 项目' });
  const b = createUserProject({ name: 'O-07 B 项目' });
  const bAsset = Assets.create(b.id, { category: 'scene', name: 'B 的场景' });

  const cases = [
    ['set_shot_detail', { shot_id: 'shot-of-b' }, 'SHOT_NOT_IN_PROJECT'],
    ['set_shot_actions', { shot_id: 'shot-of-b', actions: [] }, 'SHOT_NOT_IN_PROJECT'],
    ['set_shot_detail', { chapter_id: 'chapter-of-b' }, 'CHAPTER_NOT_IN_PROJECT'],
    ['set_scene_state', { scene_key: 's', asset_id: bAsset.id, state: {} }, 'ASSET_NOT_IN_PROJECT'],
  ];
  for (const [name, args, code] of cases) {
    await assert.rejects(
      () => Promise.resolve(runTool(name, args, { projectId: a.id })),
      (e) => e.code === code,
      `${name} 传 B 项目 id 必须抛 ${code}`,
    );
  }
});

// ── P-3：默认值来源唯一性（静态检查，防"顺手在两个入口各写一个字面量"）───
test('P-3 默认值来源唯一性：app/ 内不出现 structured_spec，两个入口只调 createUserProject', () => {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (/\.(js|jsx|mjs)$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(ROOT, 'app'));

  const withFlag = [];
  const withCreate = [];
  const withUserCreate = [];
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    if (s.includes('structured_spec')) withFlag.push(rel);
    // 只看**调用**：UI 里有一句注释提到这个名字（解释重复建项目），不算入口
    if (/Projects\.create\s*\(/.test(s)) withCreate.push(rel);
    if (s.includes('createUserProject')) withUserCreate.push(rel);
  }

  assert.deepEqual(withFlag, [], 'app/ 内不得出现 structured_spec 字面量（默认值只能由服务层给）');
  assert.deepEqual(withCreate, [], 'app/ 内不得再直接调 Projects.create（必须走 createUserProject）');
  assert.deepEqual(withUserCreate.sort(), [
    'app/api/projects/[id]/novel/import/route.js',
    'app/api/projects/route.js',
  ], '用户建项目只有这两个入口，且都走统一服务');
});
