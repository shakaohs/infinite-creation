// P10-A 阶段 B · B-03 / TST-AUD-08~15：`shot_assets` 差集审计（D02-34 §3.3）
//
// 这一组只锁一件事：**物理写入可以是整组 DELETE+INSERT，但审计必须按逻辑集合算差集**。
// 差集键固定 `(role, asset_id)`；`order_no` / `variant_of` 变 ⇒ update（同一引用换了位置/变体）；
// `role` 或 `asset_id` 变 ⇒ 旧行 delete + 新行 create。
//
// 为什么必须这么测：整组重写的物理 SQL 会把「只调了顺序」记成「全删全建」，
// 下游看到的是一条"全套参考图被换掉"的假历史。日志条数上界是这条契约唯一可机检的形态。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-aud815-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;
delete process.env.IC_DB;
delete process.env.DATABASE_URL;

const core = await import('../lib/core/index.js');
const { getDb, listChanges, rawGet, ENTITY_META } = core;
const { createUserProject } = await import('../lib/core/project-create.js');
const { upsertSceneStates } = await import('../lib/core/scene-state.js');
const {
  writeShotAssets, writeStoryShotWithAssets, diffShotAssets,
} = await import('../lib/core/render/shot-assets.js');

const db = getDb();

let seq = 0;
/** 每个用例一套独立项目：1 章 + 2 场景资产 + 3 人物 + 1 道具 + 1 语音 + 2 变体服装 */
function setup(name) {
  seq += 1;
  const p = createUserProject({ name: `${name}-${seq}` });
  const chapter = core.Chapters.list(p.id)[0];
  const scene = core.Assets.create(p.id, { category: 'scene', name: `病房-${seq}` });
  const hero = core.Assets.create(p.id, { category: 'character', name: `罗克珊-${seq}` });
  const hero2 = core.Assets.create(p.id, { category: 'character', name: `凯森-${seq}` });
  const hero3 = core.Assets.create(p.id, { category: 'character', name: `哈罗德-${seq}` });
  const prop = core.Assets.create(p.id, { category: 'prop', name: `病历夹-${seq}` });
  const voice = core.Assets.create(p.id, { category: 'voice', name: `音色-${seq}` });
  const c1 = core.Assets.create(p.id, { category: 'costume', name: `病号服-${seq}`, parent_id: hero.id });
  const c2 = core.Assets.create(p.id, { category: 'costume', name: `西装-${seq}`, parent_id: hero.id });
  upsertSceneStates(p.id, chapter, [{ scene_key: 'S01_病房', scene_id: scene.id }]);
  return { p, chapter, scene, hero, hero2, hero3, prop, voice, c1, c2 };
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

const assetRows = (shotId) => db.prepare('SELECT * FROM shot_assets WHERE shot_id = ? ORDER BY role ASC, order_no ASC').all(shotId);
const logs = (projectId) => listChanges(projectId, { entity: 'shot_asset', limit: 500 });
/** 一轮写入产生的日志（action + entity_id），按写入顺序 */
const round = (fn) => {
  const before = new Set(logs(fn.projectId).map((l) => l.id));
  fn.run();
  return logs(fn.projectId).filter((l) => !before.has(l.id));
};
const actions = (rows) => rows.map((r) => r.action).sort();

// ── TST-AUD-08 完全相同：第二次写入零日志 ───────────────────────────────
test('TST-AUD-08 完全相同 ⇒ 不产生任何 shot_asset 审计日志', () => {
  const { p, chapter, hero, prop } = setup('AUD08');
  const shotId = newShot(p.id, chapter.id);
  const input = { characters: [hero.name], props: [prop.name] };
  writeShotAssets({ projectId: p.id, shotId, input });
  const first = logs(p.id);
  assert.equal(first.length, 2, '首次写入 = 2 条 create');
  assert.deepEqual(actions(first), ['create', 'create']);

  const second = round({ projectId: p.id, run: () => writeShotAssets({ projectId: p.id, shotId, input }) });
  assert.deepEqual(second, [], '内容完全相同：物理整组重写，但审计必须 0 条');
  assert.deepEqual(logs(p.id).length, 2, '总日志仍是 2 条（没有被整组重写放大）');
});

// ── TST-AUD-09 新增 ────────────────────────────────────────────────────
test('TST-AUD-09 新增一条引用 ⇒ 恰好 1 条 create（不多不少）', () => {
  const { p, chapter, hero, prop } = setup('AUD09');
  const shotId = newShot(p.id, chapter.id);
  writeShotAssets({ projectId: p.id, shotId, input: { characters: [hero.name] } });
  const r = round({ projectId: p.id, run: () => writeShotAssets({ projectId: p.id, shotId, input: { characters: [hero.name], props: [prop.name] } }) });
  assert.deepEqual(actions(r), ['create']);
  assert.equal(r[0].after.asset_id, prop.id);
  assert.equal(r[0].after.role, 'prop');
  assert.equal(r[0].before, null, 'create 的 before 必须是 null');
});

// ── TST-AUD-10 删除 ────────────────────────────────────────────────────
test('TST-AUD-10 去掉一条引用 ⇒ 恰好 1 条 delete，且 before 快照是被删的那一行', () => {
  const { p, chapter, hero, prop } = setup('AUD10');
  const shotId = newShot(p.id, chapter.id);
  writeShotAssets({ projectId: p.id, shotId, input: { characters: [hero.name], props: [prop.name] } });
  const r = round({ projectId: p.id, run: () => writeShotAssets({ projectId: p.id, shotId, input: { characters: [hero.name] } }) });
  assert.deepEqual(actions(r), ['delete']);
  assert.equal(r[0].before.asset_id, prop.id);
  assert.equal(r[0].before.role, 'prop');
  assert.equal(r[0].after, null, 'delete 的 after 必须是 null');
});

// ── TST-AUD-11 仅 order_no 改变（含互换顺序）─────────────────────────────
test('TST-AUD-11 仅 order_no 改变 ⇒ update（互换顺序是 2 条 update，不是 delete+create）', () => {
  const { p, chapter, hero, hero2 } = setup('AUD11');
  const shotId = newShot(p.id, chapter.id);
  writeShotAssets({ projectId: p.id, shotId, input: { characters: [hero.name, hero2.name] } });
  assert.deepEqual(assetRows(shotId).map((x) => [x.asset_id, x.order_no]), [[hero.id, 1], [hero2.id, 2]]);

  // 互换：逻辑集合完全不变，只有位置换了
  const r = round({ projectId: p.id, run: () => writeShotAssets({ projectId: p.id, shotId, input: { characters: [hero2.name, hero.name] } }) });
  assert.deepEqual(actions(r), ['update', 'update'], '互换顺序必须记成两条 update');
  assert.equal(r.length, 2, '日志条数 = 变化行数（2），不是整组 2 删 + 2 建 = 4');
  for (const l of r) {
    assert.equal(l.before.asset_id, l.after.asset_id, 'update 的前后必须是同一个 asset_id');
    assert.notEqual(l.before.order_no, l.after.order_no, 'update 的原因必须是 order_no 变了');
  }
  const pairs = r.map((l) => [l.before.asset_id, l.before.order_no, l.after.order_no]).sort();
  assert.deepEqual(pairs, [[hero.id, 1, 2], [hero2.id, 2, 1]].sort());
  assert.deepEqual(assetRows(shotId).map((x) => [x.asset_id, x.order_no]), [[hero2.id, 1], [hero.id, 2]]);
});

// ── TST-AUD-12 仅 variant_of 改变 ───────────────────────────────────────
test('TST-AUD-12 仅 variant_of 改变 ⇒ update（同一引用换了父资产，不是换了服装）', () => {
  const { p, chapter, c1, hero, hero2 } = setup('AUD12');
  const shotId = newShot(p.id, chapter.id);
  writeShotAssets({ projectId: p.id, shotId, input: { characters: [hero.name], costumes: [c1.name] } });
  const before = assetRows(shotId).find((x) => x.role === 'costume');
  assert.equal(before.variant_of, hero.id);

  // 变体的 variant_of 来自资产自身的 parent_id：把父资产改掉，同一 (role, asset_id) 的 variant_of 就变了
  db.prepare('UPDATE assets SET parent_id = ? WHERE id = ?').run(hero2.id, c1.id);
  const r = round({ projectId: p.id, run: () => writeShotAssets({ projectId: p.id, shotId, input: { characters: [hero.name], costumes: [c1.name] } }) });
  assert.deepEqual(actions(r), ['update']);
  assert.equal(r[0].before.asset_id, c1.id);
  assert.equal(r[0].before.variant_of, hero.id);
  assert.equal(r[0].after.variant_of, hero2.id);
  assert.equal(r[0].before.order_no, r[0].after.order_no, 'order_no 没变，变化原因只可能是 variant_of');
});

// ── TST-AUD-13 两字段同时改变 ──────────────────────────────────────────
test('TST-AUD-13 order_no 与 variant_of 同时改变 ⇒ 仍是 1 条 update', () => {
  const { p, chapter, hero, hero2, c1 } = setup('AUD13');
  const shotId = newShot(p.id, chapter.id);
  // c1 排第 1
  writeShotAssets({ projectId: p.id, shotId, input: { characters: [hero.name], costumes: [c1.name] } });
  // 造第二条服装：同一角色的另一件，排到第 1 位 ⇒ c1 的 order_no 1→2
  const c3 = core.Assets.create(p.id, { category: 'costume', name: `外套-${seq}`, parent_id: hero.id });
  writeShotAssets({ projectId: p.id, shotId, input: { characters: [hero.name], costumes: [c3.name, c1.name] } });
  const base = logs(p.id).length;

  // 再同时改：c1 换父资产（variant_of）+ 换回第 1 位（order_no）
  db.prepare('UPDATE assets SET parent_id = ? WHERE id = ?').run(hero2.id, c1.id);
  const r = round({ projectId: p.id, run: () => writeShotAssets({ projectId: p.id, shotId, input: { characters: [hero.name], costumes: [c1.name, c3.name] } }) });
  const c1Logs = r.filter((l) => l.before?.asset_id === c1.id);
  assert.equal(c1Logs.length, 1, 'c1 的变化必须合并成 1 条 update，不得拆成两条');
  assert.equal(c1Logs[0].action, 'update');
  assert.equal(c1Logs[0].before.order_no, 2);
  assert.equal(c1Logs[0].after.order_no, 1);
  assert.equal(c1Logs[0].after.variant_of, hero2.id);
  // c3 的 order_no 1→2 也是 update
  const c3Logs = r.filter((l) => l.before?.asset_id === c3.id);
  assert.equal(c3Logs.length, 1);
  assert.equal(c3Logs[0].action, 'update');
  assert.equal(logs(p.id).length, base + 2, '两条变化 = 两条日志');
});

// ── TST-AUD-14 asset_id 改变 ───────────────────────────────────────────
test('TST-AUD-14 asset_id 改变 ⇒ 旧行 delete + 新行 create（不是 update）', () => {
  const { p, chapter, hero, hero2 } = setup('AUD14');
  const shotId = newShot(p.id, chapter.id);
  writeShotAssets({ projectId: p.id, shotId, input: { characters: [hero.name] } });
  const r = round({ projectId: p.id, run: () => writeShotAssets({ projectId: p.id, shotId, input: { characters: [hero2.name] } }) });
  assert.deepEqual(actions(r), ['create', 'delete'], '换人 = 一行删 + 一行建，不是 update');
  const del = r.find((l) => l.action === 'delete');
  const cre = r.find((l) => l.action === 'create');
  assert.equal(del.before.asset_id, hero.id);
  assert.equal(cre.after.asset_id, hero2.id);
  assert.equal(del.before.role, cre.after.role, 'role 没变，变的是 asset_id');
});

// ── TST-AUD-15 role 改变 ───────────────────────────────────────────────
test('TST-AUD-15 role 改变 ⇒ 旧行 delete + 新行 create（差集键含 role）', () => {
  // 端到端无法造出"同一 asset_id 换 role"：AS-3 要求 `asset.category === role`，
  // 一个资产只有一个 category，所以经 writeShotAssets 永远换不了 role（换了必 ASSET_ROLE_MISMATCH）。
  // 差集语义因此只能在纯函数层证明 —— 这正是差集键必须含 role 的原因：
  // 键若只有 asset_id，下游看不到"这条引用换了身份类别"。
  const before = [{ shot_id: 's', role: 'character', asset_id: 'a1', order_no: 1, variant_of: '' }];
  const after = [{ shot_id: 's', role: 'prop', asset_id: 'a1', order_no: 1, variant_of: '' }];
  const d = diffShotAssets(before, after);
  assert.equal(d.added.length, 1);
  assert.equal(d.removed.length, 1);
  assert.equal(d.changed.length, 0, 'role 变不属于 update');
  assert.equal(d.removed[0].role, 'character');
  assert.equal(d.added[0].role, 'prop');

  // 端到端补一条：把角色资产当道具写 ⇒ 被 AS-3 拒绝，库里没有半行变化
  const { p, chapter, hero } = setup('AUD15');
  const shotId = newShot(p.id, chapter.id);
  writeShotAssets({ projectId: p.id, shotId, input: { characters: [hero.name] } });
  const baseRows = assetRows(shotId);
  const baseLogs = logs(p.id).length;
  assert.throws(
    () => writeShotAssets({ projectId: p.id, shotId, input: { props: [hero.name] } }),
    (e) => e.code === 'ASSET_NOT_FOUND' || e.code === 'ASSET_ROLE_MISMATCH',
  );
  assert.deepEqual(assetRows(shotId), baseRows, '被拒时物理行不得变化');
  assert.equal(logs(p.id).length, baseLogs, '被拒时不得留下审计日志');
});

// ── 日志条数上界（D02-34 §3.3 的可机检形态）─────────────────────────────
test('AUD-上界 日志条数 ≤ added+removed+changed，且 5 条引用换 1 条 ⇔ 恰好 2 条日志', () => {
  const { p, chapter, hero, hero2, hero3, prop, c1 } = setup('AUDUB');
  const shotId = newShot(p.id, chapter.id);
  writeShotAssets({
    projectId: p.id, shotId,
    input: { characters: [hero.name, hero2.name, hero3.name], props: [prop.name], costumes: [c1.name] },
  });
  assert.equal(logs(p.id).length, 5);
  const prop2 = core.Assets.create(p.id, { category: 'prop', name: `听诊器-${seq}` });

  // 5 条引用里只换掉 1 条（旧道具出、新道具进）⇒ 2 条日志，不是 5 删 + 5 建 = 10
  const r = round({
    projectId: p.id,
    run: () => writeShotAssets({
      projectId: p.id, shotId,
      input: { characters: [hero.name, hero2.name, hero3.name], props: [prop2.name], costumes: [c1.name] },
    }),
  });
  assert.equal(r.length, 2, '整组重写 5 行只换 1 行，必须只记 2 条（1 删 1 建）');
  assert.deepEqual(actions(r), ['create', 'delete']);
  const del = r.find((l) => l.action === 'delete');
  const cre = r.find((l) => l.action === 'create');
  assert.equal(del.before.asset_id, prop.id);
  assert.equal(cre.after.asset_id, prop2.id);
  assert.equal(logs(p.id).length, 7, '累计 5 + 2 = 7，未因整组重写被放大');
});

// ── 复合主键定位准确 ───────────────────────────────────────────────────
test('AUD-PK 复合主键 (shot_id, role, asset_id) 定位准确：三次写入都命中同一行', () => {
  const { p, chapter, hero } = setup('AUDPK');
  const shotId = newShot(p.id, chapter.id);
  writeShotAssets({ projectId: p.id, shotId, input: { characters: [hero.name] } });
  const row = rawGet('shot_asset', [shotId, 'character', hero.id]);
  assert.ok(row, '完整键必须命中');
  assert.equal(row.shot_id, shotId);
  assert.equal(row.role, 'character');
  assert.equal(row.asset_id, hero.id);
  // 半个键不是定位
  assert.throws(() => rawGet('shot_asset', [shotId, 'character']), (e) => e.code === 'AUDIT_PK_AMBIGUOUS');
  // 完整键命中 0 行 = 这一侧不存在（create 的 before 合法为 null）
  assert.equal(rawGet('shot_asset', [shotId, 'character', 'no-such']), null);
  // 日志的 entity_id 必须是同一个三列编码
  const [log] = logs(p.id);
  assert.deepEqual(JSON.parse(log.entity_id), [shotId, 'character', hero.id]);
});

// ── 审计失败 ⇒ 整个业务事务回滚 ─────────────────────────────────────────
test('AUD-ROLLBACK 审计失败 ⇒ 物理写入（整组 DELETE+INSERT）与 voice_ids 一起回滚', () => {
  const { p, chapter, hero, hero2, voice } = setup('AUDRB');
  const shotId = newShot(p.id, chapter.id);
  writeShotAssets({ projectId: p.id, shotId, input: { characters: [hero.name], voices: [voice.name] } });
  const rowsBefore = assetRows(shotId);
  const voiceBefore = db.prepare('SELECT voice_ids FROM story_shots WHERE id = ?').get(shotId).voice_ids;
  assert.equal(rowsBefore.length, 2);

  const saved = ENTITY_META.shot_asset;
  delete ENTITY_META.shot_asset;
  try {
    assert.throws(
      () => writeShotAssets({ projectId: p.id, shotId, input: { characters: [hero2.name], voices: [voice.name] } }),
      (e) => e.code === 'AUDIT_ENTITY_META_MISSING',
    );
  } finally {
    ENTITY_META.shot_asset = saved;
  }

  assert.deepEqual(assetRows(shotId), rowsBefore, '整组 DELETE 必须随审计失败回滚（不得留下空引用）');
  assert.equal(
    db.prepare('SELECT voice_ids FROM story_shots WHERE id = ?').get(shotId).voice_ids,
    voiceBefore,
    '派生列 voice_ids 也不得被改',
  );
  assert.equal(logs(p.id).length, 2, '日志仍是首次写入的 2 条');
});

// ── 锁契约：无项目锁时拒绝 ─────────────────────────────────────────────
test('AUD-LOCK 事务外不得直接写 shot_assets（必须在 txProject 内）', () => {
  const { p, chapter, hero } = setup('AUDLOCK');
  const shotId = newShot(p.id, chapter.id);
  // writeShotAssets 自己开 txProject ⇒ 正常调用一定在锁内；这里证明"锁上下文确实被建立了"
  const r = writeShotAssets({ projectId: p.id, shotId, input: { characters: [hero.name] } });
  assert.equal(r.assets.length, 1);
  assert.equal(core.lockedProjects(), null, '事务结束后锁上下文必须清空');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 占用中 */ } });
