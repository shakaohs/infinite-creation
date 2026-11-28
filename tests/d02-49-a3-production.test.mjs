// D02-49 §三：A3 `writeShotAssets` 在 Stage3 生产链路上的接线核查（集成证明，不是单测）
//
// 要证明的链路（一条完整数据流，缺一环就不算接通）：
//   HTTP 复合入口 `createStructuredShot`（POST /projects/:id/shots 的 core）
//     → ① insertStoryShot            写 story_shots
//     → ② writeShotAssets            写 shot_assets（A3）+ 差集审计
//     → ③ projectSceneUnits          投影，把 shot_assets 读成段的六个 *_ids
//     → ④ ShotParams.update          写 B 组段级参数
//   四步同一项目事务：任一步失败，镜 / 资产引用 / 段 / 参数一起回滚。
//
// 另外两条边界（D02-46 纪律）：
//   · `writeShotAssets` 的**生产调用方只有 1 处**（shot-composite.js）—— 静态断言，接线变了必须同步报告；
//   · `writeStoryShotWithAssets`（AS-10 低层组合）**零生产调用方** —— 属"能力不是接线"，登记在案。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-d49a3-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;

const ROOT = path.resolve(import.meta.dirname, '..');
const core = await import('../lib/core/index.js');
const { getDb } = core;
const { listChanges } = await import('../lib/core/changelog.js');
const db = getDb();

let seq = 0;
function mk() {
  seq += 1;
  const p = core.Projects.create({ name: 'D49A3-' + seq });
  const ch = core.Chapters.list(p.id)[0];
  const hero = core.Assets.create(p.id, { category: 'character', name: '罗克珊-' + seq });
  const scene = core.Assets.create(p.id, { category: 'scene', name: '病房-' + seq });
  core.upsertSceneStates(p.id, ch, [{ scene_key: 'S01', scene_id: scene.id }]);
  return { p, ch, hero, scene };
}

const post = (p, ch, patch) => core.createStructuredShot({
  projectId: p.id, chapterId: ch.id, chapterTitle: ch.title, sceneKey: 'S01', sceneUid: 'scn-a3-' + seq, patch,
});

const assetRows = (shotId) => db.prepare('SELECT role, asset_id, order_no FROM shot_assets WHERE shot_id = ? ORDER BY role, order_no').all(shotId);
const assetLogs = (pid) => listChanges(pid, { entity: 'shot_asset', limit: 500 });
const segRow = (id) => db.prepare('SELECT * FROM shots WHERE id = ?').get(id);

test('A3-01 复合入口一次调用：story_shots → shot_assets → 投影段 *_ids → 段级参数', () => {
  const { p, ch, hero, scene } = mk();
  const r = post(p, ch, {
    visual: '病房冷光', duration: 4,
    character_ids: [hero.id], scene_ids: [scene.id],
    video_prompt: '提示词', mode: 'Ref2VA',
  });

  const ss = db.prepare('SELECT * FROM story_shots WHERE id = ?').get(r.story_shot_id);
  assert.ok(ss, '① 镜已落库');
  assert.equal(ss.visual_content, '病房冷光');

  const refs = assetRows(r.story_shot_id);
  assert.deepEqual(refs.map((x) => [x.role, x.asset_id]), [['character', hero.id], ['scene', scene.id]], '② 资产引用落 shot_assets');
  assert.equal(ss.voice_ids, '[]', '派生 voice_ids 为空数组（无 voice 引用）');

  const seg = segRow(r.segment_id);
  assert.ok(seg, '③ 投影建段');
  assert.deepEqual(JSON.parse(seg.character_ids), [hero.id], '③ 投影把 shot_assets 读成段 A 组');
  assert.deepEqual(JSON.parse(seg.scene_ids), [scene.id]);
  assert.equal(seg.video_prompt, '提示词', '④ B 组参数写进段');
  assert.equal(seg.mode, 'Ref2VA');
  assert.equal(ss.segment_id, r.segment_id, 'segment_id 已回写');
});

test('A3-02 A3 的差集审计：新增两条 create、重复写零增量', () => {
  const { p, ch, hero } = mk();
  const r = post(p, ch, { visual: 'v', character_ids: [hero.id] });
  const logs = assetLogs(p.id);
  assert.equal(logs.length, 1, '只记新增的那一条引用');
  assert.equal(logs[0].action, 'create');
  assert.deepEqual(JSON.parse(logs[0].entity_id), [r.story_shot_id, 'character', hero.id],
    'entity_id 是复合主键 (shot_id, role, asset_id)');

  // 同一组资产重写：差集为空 ⇒ 零新增审计
  core.writeShotAssets({ projectId: p.id, shotId: r.story_shot_id, sceneKey: 'S01', input: { assets: [{ role: 'character', asset_id: hero.id }] } });
  assert.equal(assetLogs(p.id).length, logs.length, '整组重写但内容相同 ⇒ 不产日志');
  assert.equal(assetRows(r.story_shot_id).length, 1);
});

test('A3-03 四步同一事务：段级参数写失败 ⇒ 镜与资产引用一起回滚', () => {
  const { p, ch, hero, scene } = mk();
  const orig = db.prepare.bind(db);
  let paramsStep = 0;
  db.prepare = (sql) => {
    if (/UPDATE shots SET/i.test(sql) && /video_prompt/.test(sql)) {
      paramsStep += 1;
      throw new Error('injected failure at ShotParams step');
    }
    return orig(sql);
  };
  try {
    assert.throws(
      () => post(p, ch, { visual: 'v', character_ids: [hero.id], scene_ids: [scene.id], video_prompt: 'x' }),
      /injected failure at ShotParams step/,
    );
  } finally {
    db.prepare = orig;
  }
  assert.equal(paramsStep, 1, '确实走到了第 ④ 步');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM story_shots WHERE project_id = ?').get(p.id).n, 0, '镜必须回滚');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shot_assets WHERE shot_id IN (SELECT id FROM story_shots WHERE project_id = ?)').get(p.id).n, 0, '资产引用必须回滚');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shots WHERE project_id = ?').get(p.id).n, 0, '段必须回滚');
});

test('A3-04 AS-8：场景资产与场次基线不一致 ⇒ 整次创建拒绝（不留半个镜）', () => {
  const { p, ch, hero, scene } = mk();
  const other = core.Assets.create(p.id, { category: 'scene', name: '走廊-' + seq });
  assert.throws(
    () => post(p, ch, { visual: 'v', character_ids: [hero.id], scene_ids: [other.id] }),
    (e) => e.code === 'SCENE_ASSET_MISMATCH',
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM story_shots WHERE project_id = ?').get(p.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shots WHERE project_id = ?').get(p.id).n, 0);
  void scene;
});

test('A3-05 静态：writeShotAssets 的生产调用方只有 shot-composite.js 一处', () => {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(fp); continue; }
      if (e.name.endsWith('.js')) files.push(fp);
    }
  };
  walk(path.join(ROOT, 'lib'));
  walk(path.join(ROOT, 'app'));
  const callers = files
    .filter((f) => !f.endsWith(path.join('render', 'shot-assets.js')))
    .filter((f) => /writeShotAssets\s*\(/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(ROOT, f).replace(/\\/g, '/'));
  assert.deepEqual(callers, ['lib/core/render/shot-composite.js'],
    'A3 的生产调用方只允许复合入口；接线变化必须同步 D02-49 报告');
});

test('A3-06 静态：writeStoryShotWithAssets 零生产调用方（能力不是接线，已登记）', () => {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(fp); continue; }
      if (e.name.endsWith('.js')) files.push(fp);
    }
  };
  walk(path.join(ROOT, 'lib'));
  walk(path.join(ROOT, 'app'));
  const callers = files
    .filter((f) => !f.endsWith(path.join('render', 'shot-assets.js')))
    .filter((f) => /writeStoryShotWithAssets\s*\(/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(ROOT, f).replace(/\\/g, '/'));
  assert.deepEqual(callers, [], '若将来接线，必须同步登记到报告与 D02-46 §八 责任表');
});

test('A3-07 静态：Agent 结构化分镜入口不写 shot_assets（源码依据，不制造空调用）', () => {
  const tools = fs.readFileSync(path.join(ROOT, 'lib', 'agent', 'tools.js'), 'utf8');
  // 该分支的边界是写死的：只写 story_shots，资产引用留给复合入口 / 资产阶段
  assert.ok(/资产引用暂不落 `shot_assets`/.test(tools), '注释必须保留该边界说明');
  assert.ok(!/writeShotAssets\s*\(/.test(tools), 'tools.js 内不得出现 writeShotAssets 调用');
  const ret = /资产引用也未写入/.test(tools);
  assert.ok(ret, '返回值必须显式回报"资产引用未写入"，不得静默丢弃');
});
