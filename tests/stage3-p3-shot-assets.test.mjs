// 阶段 3 · P3：镜头资产引用契约（D02-06 V7 §4.4.2；AS-1~AS-10）
//
// 这一组只测"镜 ↔ 资产"这一层：谁进 `shot_assets`、以什么 role/order_no 进、`voice_ids` 怎么派生、
// 以及"校验失败时不许留下半个镜"。都用独立 IC_DATA_DIR，不碰真实项目数据。
//
// 与旧路径的关键差异（§4.4.2 末注）：旧 `set_storyboard` 命中不到资产名时只回报、照常写入；
// 新路径必须 `ASSET_NOT_FOUND` 直接拒绝 —— 否则会写出"有镜、没资产"的镜，编译期才发现参考图全缺。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-p3-assets-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;
delete process.env.IC_DB;
delete process.env.DATABASE_URL;

const { getDb, Chapters, Assets } = await import('../lib/core/db.js');
const { createUserProject } = await import('../lib/core/project-create.js');
const { upsertSceneStates } = await import('../lib/core/scene-state.js');
const sa = await import('../lib/core/render/shot-assets.js');

const db = getDb();
const {
  writeShotAssets, writeStoryShotWithAssets, resolveShotAssets, deriveVoiceIds,
  SHOT_ASSET_ROLES, MAX_VOICE_PER_SHOT,
} = sa;

let seq = 0;
/**
 * 每个用例一套独立项目：1 章 + 场景资产（带场次基线）+ 人物 + 道具 + 语音，
 * 另备第二个场景资产（AS-8 的不一致样本）。
 */
function setup(name) {
  seq += 1;
  const p = createUserProject({ name: `${name}-${seq}` });
  const chapter = Chapters.list(p.id)[0];
  const scene = Assets.create(p.id, { category: 'scene', name: `病房-${seq}` });
  const scene2 = Assets.create(p.id, { category: 'scene', name: `走廊-${seq}` });
  const hero = Assets.create(p.id, { category: 'character', name: `罗克珊-${seq}` });
  const prop = Assets.create(p.id, { category: 'prop', name: `病历夹-${seq}` });
  const voice = Assets.create(p.id, { category: 'voice', name: `罗克珊音色-${seq}` });
  const costume = Assets.create(p.id, { category: 'costume', name: `病号服-${seq}`, parent_id: hero.id });
  upsertSceneStates(p.id, chapter, [{ scene_key: 'S01_病房', scene_id: scene.id }]);
  return { p, chapter, scene, scene2, hero, prop, voice, costume };
}

let shotSeq = 0;
/** 插一镜（带号），资产留空；返回 shotId */
function newShot(projectId, chapterId, extra = {}) {
  shotSeq += 1;
  const r = writeStoryShotWithAssets({
    projectId,
    chapterId,
    shot: { shot_no: shotSeq, global_no: shotSeq, scene_key: 'S01_病房', visual_content: `镜${shotSeq}`, ...extra },
    assets: {},
  });
  return r.shot.id;
}

const assetRows = (shotId) => db.prepare('SELECT * FROM shot_assets WHERE shot_id = ? ORDER BY role ASC, order_no ASC').all(shotId);
const voiceIdsOf = (shotId) => JSON.parse(db.prepare('SELECT voice_ids FROM story_shots WHERE id = ?').get(shotId).voice_ids || '[]');

// ── 1. 名称唯一命中 ────────────────────────────────────────────────────
test('AS-1 名称唯一命中：写入正确的 role 与 order_no（同 role 按传入顺序 1..n）', () => {
  const { p, chapter, hero, prop } = setup('AS1');
  const shotId = newShot(p.id, chapter.id);
  const r = writeShotAssets({
    projectId: p.id, shotId,
    input: { characters: [hero.name], props: [prop.name], scenes: [] },
  });
  const rows = assetRows(shotId);
  assert.deepEqual(rows.map((x) => [x.role, x.asset_id, x.order_no]), [
    ['character', hero.id, 1],
    ['prop', prop.id, 1],
  ]);
  assert.deepEqual(r.assets.map((x) => x.asset_id).sort(), [hero.id, prop.id].sort());
});

test('AS-1b 名称去首尾空白后全等（不做模糊/包含匹配）', () => {
  const { p, chapter, hero } = setup('AS1b');
  const shotId = newShot(p.id, chapter.id);
  writeShotAssets({ projectId: p.id, shotId, input: { characters: [`  ${hero.name}  `] } });
  assert.deepEqual(assetRows(shotId).map((x) => x.asset_id), [hero.id]);
  // 包含匹配不算命中
  assert.throws(
    () => writeShotAssets({ projectId: p.id, shotId, input: { characters: [hero.name.slice(0, 2)] } }),
    (e) => e.code === 'ASSET_NOT_FOUND',
  );
});

// ── 2. 名称无命中 ──────────────────────────────────────────────────────
test('AS-1c 名称无命中 → ASSET_NOT_FOUND（新路径不再"缺资产照写"）', () => {
  const { p, chapter } = setup('AS2');
  const shotId = newShot(p.id, chapter.id);
  assert.throws(
    () => writeShotAssets({ projectId: p.id, shotId, input: { characters: ['不存在的人'] } }),
    (e) => e.code === 'ASSET_NOT_FOUND',
  );
  assert.equal(assetRows(shotId).length, 0, '拒绝时不得留下关联');
});

// ── 3. 同名歧义 ────────────────────────────────────────────────────────
test('AS-1d 同名资产歧义 → ASSET_NAME_AMBIGUOUS（要求改传 asset_id）', () => {
  const { p, chapter } = setup('AS3');
  Assets.create(p.id, { category: 'character', name: '同名' });
  Assets.create(p.id, { category: 'character', name: '同名' });
  const shotId = newShot(p.id, chapter.id);
  let err = null;
  try { writeShotAssets({ projectId: p.id, shotId, input: { characters: ['同名'] } }); } catch (e) { err = e; }
  assert.ok(err);
  assert.equal(err.code, 'ASSET_NAME_AMBIGUOUS');
  assert.equal(err.detail.candidates.length, 2);
  assert.equal(assetRows(shotId).length, 0);
});

// ── 4. 跨项目 asset_id ─────────────────────────────────────────────────
test('AS-2 跨项目 asset_id → ASSET_NOT_IN_PROJECT', () => {
  const a = setup('AS4a');
  const b = setup('AS4b');
  const shotId = newShot(a.p.id, a.chapter.id);
  assert.throws(
    () => writeShotAssets({ projectId: a.p.id, shotId, input: { assets: [{ asset_id: b.hero.id, role: 'character' }] } }),
    (e) => e.code === 'ASSET_NOT_IN_PROJECT',
  );
  assert.equal(assetRows(shotId).length, 0);
});

// ── 5. role 与 category 不一致 ─────────────────────────────────────────
test('AS-3 role 与 category 不一致 → ASSET_ROLE_MISMATCH', () => {
  const { p, chapter, hero } = setup('AS5');
  const shotId = newShot(p.id, chapter.id);
  assert.throws(
    () => writeShotAssets({ projectId: p.id, shotId, input: { assets: [{ asset_id: hero.id, role: 'prop' }] } }),
    (e) => e.code === 'ASSET_ROLE_MISMATCH',
  );
  assert.equal(assetRows(shotId).length, 0);
});

// ── 6. 非法 role ───────────────────────────────────────────────────────
test('AS-4 music/sfx/video/other 不得进 shot_assets → ASSET_ROLE_INVALID', () => {
  const { p, chapter } = setup('AS6');
  const music = Assets.create(p.id, { category: 'music', name: '主题曲' });
  const shotId = newShot(p.id, chapter.id);
  for (const role of ['music', 'sfx', 'video', 'other']) {
    assert.throws(
      () => writeShotAssets({ projectId: p.id, shotId, input: { assets: [{ asset_id: music.id, role }] } }),
      (e) => e.code === 'ASSET_ROLE_INVALID',
      `role=${role} 必须被拒`,
    );
  }
  assert.deepEqual(SHOT_ASSET_ROLES, ['character', 'scene', 'prop', 'costume', 'age', 'voice']);
  assert.equal(assetRows(shotId).length, 0);
});

// ── 7. order_no 连续 ───────────────────────────────────────────────────
test('AS-5 order_no 同 role 内按传入顺序 1..n；显式跳号 → ASSET_ORDER_GAP', () => {
  const { p, chapter, hero } = setup('AS7');
  const a2 = Assets.create(p.id, { category: 'character', name: '哈罗德' });
  const shotId = newShot(p.id, chapter.id);
  writeShotAssets({ projectId: p.id, shotId, input: { characters: [hero.name, a2.name] } });
  assert.deepEqual(
    assetRows(shotId).filter((x) => x.role === 'character').map((x) => [x.asset_id, x.order_no]),
    [[hero.id, 1], [a2.id, 2]],
  );
  assert.throws(
    () => writeShotAssets({ projectId: p.id, shotId, input: { assets: [{ asset_id: hero.id, role: 'character', order_no: 1 }, { asset_id: a2.id, role: 'character', order_no: 3 }] } }),
    (e) => e.code === 'ASSET_ORDER_GAP',
  );
});

test('AS-5b 整组替换而不是追加：重写后只剩本次传入的资产', () => {
  const { p, chapter, hero, prop } = setup('AS7b');
  const shotId = newShot(p.id, chapter.id);
  writeShotAssets({ projectId: p.id, shotId, input: { characters: [hero.name], props: [prop.name] } });
  assert.equal(assetRows(shotId).length, 2);
  writeShotAssets({ projectId: p.id, shotId, input: { props: [prop.name] } });
  assert.deepEqual(assetRows(shotId).map((x) => [x.role, x.asset_id]), [['prop', prop.id]]);
});

// ── 8. 第 4 个 voice ───────────────────────────────────────────────────
test('AS-6 每镜最多 3 条 voice，第 4 条 → VOICE_OVERFLOW', () => {
  const { p, chapter } = setup('AS8');
  const v = [1, 2, 3, 4].map((i) => Assets.create(p.id, { category: 'voice', name: `音色${i}` }));
  const shotId = newShot(p.id, chapter.id);
  assert.equal(MAX_VOICE_PER_SHOT, 3);
  writeShotAssets({ projectId: p.id, shotId, input: { voices: v.slice(0, 3).map((x) => x.name) } });
  assert.equal(assetRows(shotId).filter((x) => x.role === 'voice').length, 3);
  assert.throws(
    () => writeShotAssets({ projectId: p.id, shotId, input: { voices: v.map((x) => x.name) } }),
    (e) => e.code === 'VOICE_OVERFLOW',
  );
  assert.equal(assetRows(shotId).filter((x) => x.role === 'voice').length, 3, '被拒后仍是上一次的 3 条（同事务回滚）');
});

// ── 9. voice_ids 派生 ──────────────────────────────────────────────────
test('AS-9 voice_ids 由程序按 role=voice ORDER BY order_no 派生；改关联后同步更新', () => {
  const { p, chapter } = setup('AS9');
  const v1 = Assets.create(p.id, { category: 'voice', name: 'A音色' });
  const v2 = Assets.create(p.id, { category: 'voice', name: 'B音色' });
  const shotId = newShot(p.id, chapter.id);
  writeShotAssets({ projectId: p.id, shotId, input: { voices: [v1.name, v2.name] } });
  assert.deepEqual(voiceIdsOf(shotId), [v1.id, v2.id]);
  assert.deepEqual(deriveVoiceIds(shotId), [v1.id, v2.id]);

  // 换顺序（整组替换）→ 派生列跟着变
  writeShotAssets({ projectId: p.id, shotId, input: { voices: [v2.name, v1.name] } });
  assert.deepEqual(voiceIdsOf(shotId), [v2.id, v1.id], 'voice_ids 必须按 order_no 重排');

  // 删掉 voice → 派生列清空
  writeShotAssets({ projectId: p.id, shotId, input: {} });
  assert.deepEqual(voiceIdsOf(shotId), []);
});

test('AS-9b 外部传 voice_ids 被忽略，并留痕 DERIVED_FIELD_IGNORED', () => {
  const { p, chapter, hero } = setup('AS9b');
  const shotId = newShot(p.id, chapter.id);
  const r = writeShotAssets({ projectId: p.id, shotId, input: { characters: [hero.name], voice_ids: ['伪造的id'] } });
  assert.deepEqual(voiceIdsOf(shotId), [], '外部 voice_ids 不得写入');
  assert.ok(r.warnings.some((w) => w.code === 'DERIVED_FIELD_IGNORED' && w.field === 'voice_ids'));
});

// ── 10. variant_of ─────────────────────────────────────────────────────
test('AS-7 variant_of 只在 costume/age 且有 parent_id 时写；孤儿父资产 → ASSET_VARIANT_ORPHAN', () => {
  const { p, chapter, hero, costume } = setup('AS10');
  const shotId = newShot(p.id, chapter.id);
  writeShotAssets({ projectId: p.id, shotId, input: { costumes: [costume.name] } });
  assert.equal(assetRows(shotId)[0].variant_of, hero.id, 'costume 必须写父角色 id');

  // 非变体分类即使传了 variant_of 也必须是空串
  writeShotAssets({ projectId: p.id, shotId, input: { assets: [{ asset_id: hero.id, role: 'character', variant_of: costume.id }] } });
  assert.equal(assetRows(shotId)[0].variant_of, '');

  // 孤儿：父资产属于别的项目
  const other = setup('AS10b');
  const orphan = Assets.create(p.id, { category: 'costume', name: '孤儿服装', parent_id: hero.id });
  db.prepare('UPDATE assets SET parent_id = ? WHERE id = ?').run(other.hero.id, orphan.id); // 人为制造跨项目父
  assert.throws(
    () => writeShotAssets({ projectId: p.id, shotId, input: { costumes: [orphan.name] } }),
    (e) => e.code === 'ASSET_VARIANT_ORPHAN',
  );
});

// ── AS-8 场景资产一致性 ────────────────────────────────────────────────
test('AS-8 role=scene 的资产必须等于 scene_key 对应 scene_states.scene_id；虚拟场次两侧都空则跳过', () => {
  const { p, chapter, scene, scene2 } = setup('AS8-scene');
  const shotId = newShot(p.id, chapter.id, { scene_key: 'S01_病房' });
  writeShotAssets({ projectId: p.id, shotId, input: { scenes: [scene.name] } });
  assert.deepEqual(assetRows(shotId).map((x) => x.asset_id), [scene.id]);

  // 引用另一个场景资产 → 不一致
  assert.throws(
    () => writeShotAssets({ projectId: p.id, shotId, input: { scenes: [scene2.name] } }),
    (e) => e.code === 'SCENE_ASSET_MISMATCH',
  );

  // 虚拟场次（scene_states.scene_id = ''）：两侧都空才跳过
  upsertSceneStates(p.id, chapter, [{ scene_key: 'S09_虚拟', scene_id: '' }]);
  const s2 = newShot(p.id, chapter.id, { scene_key: 'S09_虚拟' });
  writeShotAssets({ projectId: p.id, shotId: s2, input: { props: [] } }); // 不带 scene → 不比对
  assert.throws(
    () => writeShotAssets({ projectId: p.id, shotId: s2, input: { scenes: [scene.name] } }),
    (e) => e.code === 'SCENE_ASSET_MISMATCH',
  );

  // 场次没有基线行 → 无从比对，判 SCENE_STATE_MISSING（不把"无法验证"当"验证通过"）
  const s3 = newShot(p.id, chapter.id, { scene_key: 'S99_无基线' });
  assert.throws(
    () => writeShotAssets({ projectId: p.id, shotId: s3, input: { scenes: [scene.name] } }),
    (e) => e.code === 'SCENE_STATE_MISSING',
  );
});

// ── AS-10 事务一致性 ──────────────────────────────────────────────────
test('AS-10 资产校验失败 → story_shots 与 shot_assets 一起回滚（不留半个镜）', () => {
  const { p, chapter, hero } = setup('AS10-tx');
  const before = db.prepare('SELECT COUNT(*) AS n FROM story_shots WHERE project_id = ?').get(p.id).n;
  assert.throws(
    () => writeStoryShotWithAssets({
      projectId: p.id, chapterId: chapter.id,
      shot: { shot_no: 99, global_no: 99, scene_key: 'S01_病房', visual_content: '半个镜' },
      assets: { characters: ['不存在的人'] },
    }),
    (e) => e.code === 'ASSET_NOT_FOUND',
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM story_shots WHERE project_id = ?').get(p.id).n, before, '镜不得留下');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM shot_assets WHERE asset_id = ?').get(hero.id).n, 0,
    '关联也不得留下（镜都没进去，关联更不许存在）',
  );

  // 反向对照：资产合法时，镜与关联同时落库
  const ok = writeStoryShotWithAssets({
    projectId: p.id, chapterId: chapter.id,
    shot: { shot_no: 1, global_no: 1, scene_key: 'S01_病房', visual_content: '完整镜' },
    assets: { characters: [hero.name] },
  });
  assert.equal(assetRows(ok.shot.id).length, 1);
});

// ── 输入形态 ─────────────────────────────────────────────────────────
test('AS-EXT 同一镜内混用两种输入形态 → ASSET_INPUT_MIXED；空输入允许（本镜暂不引用资产）', () => {
  const { p, chapter, hero } = setup('AS-mixed');
  const shotId = newShot(p.id, chapter.id);
  assert.throws(
    () => resolveShotAssets({ projectId: p.id, sceneKey: 'S01_病房', input: { characters: [hero.name], assets: [{ asset_id: hero.id, role: 'character' }] } }),
    (e) => e.code === 'ASSET_INPUT_MIXED',
  );
  const empty = resolveShotAssets({ projectId: p.id, sceneKey: 'S01_病房', input: {} });
  assert.deepEqual(empty.rows, []);
  assert.deepEqual(empty.derived.voice_ids, []);
});
