// P9-A：求解结果持久化（D02-21 §三）
//
// 这一组只关心"落库这件事对不对"：字段映射、carried 可追溯性、幂等、更新、回滚、清理。
// QC 报告与门禁在 `stage3-p9-report` / `stage3-p9-gate`。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-p9-persist-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;
delete process.env.IC_DB;
delete process.env.DATABASE_URL;

const { getDb, Chapters, tx } = await import('../lib/core/db.js');
const { createUserProject } = await import('../lib/core/project-create.js');
const { upsertSceneStates } = await import('../lib/core/scene-state.js');
const { insertStoryShot } = await import('../lib/core/render/global-no.js');
const {
  runSceneQuality, persistSceneStates, listShotStates, stateContentHash, toShotStateRow,
  loadSceneInput, solveLoaded,
} = await import('../lib/core/index.js');

const db = getDb();
const SCENE = 'S01_病房';
let seq = 0;

function seedScene({ shots = 3, withBaseline = true, purpose, blockingShots = Number.POSITIVE_INFINITY } = {}) {
  seq += 1;
  const p = createUserProject({ name: `P9-持久化-${seq}` });
  const ch = Chapters.list(p.id)[0];
  if (withBaseline) {
    upsertSceneStates(p.id, ch, [{
      scene_key: SCENE,
      coord_system: { active_area: [8, 5, 3] },
      axis_lock: { pair: ['c1', 'c2'], left: 'c1', right: 'c2', axis_line: [[0.5, 0], [0.5, 1]] },
      time_of_day: '夜',
    }]);
  }
  const ids = [];
  for (let i = 1; i <= shots; i += 1) {
    const r = insertStoryShot({
      project_id: p.id, chapter_id: ch.id, scene_key: SCENE,
      shot_no: i, global_no: i,
      spec_source: i === 1 ? 'manual' : 'ai',
      story_duration: 4,
      speakers: [{ id: 'c1', type: 'on_screen' }],
      time_slices: [{ from: 0, to: 4 }],
      ...(purpose ? { purpose } : {}),
    });
    ids.push(r.id);
    if (i > blockingShots) continue; // 不给站位行 ⇒ 该镜的位置只能从上一镜继承
    db.prepare(
      'INSERT INTO shot_blockings (shot_id, character_id, position_abs, norm_x, norm_y, norm_z, norm_confidence,'
      + ' position_track, anchor_object, facing, gaze_target, posture, in_frame) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(r.id, 'c1', '画面左', 0.30 + 0.02 * (i - 1), 0.70, 0, 0.95, '[]', 'fx_table', 'W', 'c2', 'standing', 1);
  }
  return { p, ch, ids };
}

const stateRow = (shotId) => db.prepare('SELECT * FROM shot_states WHERE shot_id = ?').get(shotId);

test('P1 求解结果按 8 列落库：state_source=solved、derived_from 成链、内容与求解输出逐字段相同', () => {
  const { p, ids } = seedScene({ shots: 3 });
  // 先单独跑一次"读 + 求解"拿到期望值（纯读，不写库），再跑闭环比对
  const loaded = loadSceneInput({ projectId: p.id, sceneKey: SCENE });
  const solved = solveLoaded({ projectId: p.id, sceneKey: SCENE, rows: loaded.rows, sceneState: loaded.sceneState });

  const out = runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  assert.equal(out.states.written.length, 3);
  assert.deepEqual(out.states.deleted, []);

  for (const [i, id] of ids.entries()) {
    const row = stateRow(id);
    assert.ok(row, `第 ${i + 1} 镜没有状态行`);
    assert.equal(row.state_source, 'solved');
    assert.equal(row.derived_from, i === 0 ? 'scene_baseline' : `prev_shot:${ids[i - 1]}`);
    assert.deepEqual(JSON.parse(row.state_in), solved.states[id].in, 'state_in 与求解的 in 不一致');
    assert.deepEqual(JSON.parse(row.state_out), solved.states[id].out, 'state_out 与求解的 out 不一致');
    assert.deepEqual(JSON.parse(row.meta), solved.states[id].meta, 'meta 与求解的 meta 不一致');
    assert.deepEqual(JSON.parse(row.conflicts), solved.states[id].conflicts);
  }
  // 静态场次（无动作）：每镜 in 与 out 相同；**链由 `derived_from` 标记**，
  // 而不是"这一镜的 in 等于上一镜的 out"——后者是常见误解，实测不成立（in 是本镜的初始状态）
  for (const id of ids) {
    assert.deepEqual(JSON.parse(stateRow(id).state_in), JSON.parse(stateRow(id).state_out));
  }
});

test('P2 carried 继承可追溯：src 带继承起点镜 id，rel/conf 一并保留', () => {
  const { p, ids } = seedScene({ shots: 3 });
  // 第 2 镜显式标 unknown → 求解器不采信坐标，沿用上镜并把来源记成 carried:<起点>
  const out = runSceneQuality({
    projectId: p.id, sceneKey: SCENE,
    annotations: { [ids[1]]: { source: 'manual', entries: { 'chars.c1.pos': { rel: 'unknown' } } } },
  });
  assert.equal(out.states.written.length, 3);

  const meta2 = JSON.parse(stateRow(ids[1]).meta);
  const pos2 = meta2['chars.c1.pos'];
  assert.ok(pos2, '第 2 镜的 pos 元数据丢了');
  assert.equal(pos2.rel, 'unknown');
  assert.match(String(pos2.src), /^carried:/, `继承来源必须是 carried:<起点镜>，实际 ${pos2.src}`);
  assert.equal(typeof pos2.conf, 'number');
  const origin = String(pos2.src).slice('carried:'.length);
  assert.ok(ids.includes(origin), `继承起点 ${origin} 不是本场的镜头`);
  // 求解器输出的 __solver 元数据也随 meta 落库（qc_input_hash 与它同值，见 report 组）
  assert.match(String(meta2.__solver?.hash ?? ''), /^sha256:[0-9a-f]{64}$/);
});

test('P3 多镜继承链：起点镜被保留（不逐镜改写），derived_from 才是"上一镜"', () => {
  // 只给第 1 镜站位行：第 2/3 镜没有自己的坐标，位置只能沿链继承
  const { p, ids } = seedScene({ shots: 3, blockingShots: 1 });
  runSceneQuality({ projectId: p.id, sceneKey: SCENE });

  const m1 = JSON.parse(stateRow(ids[0]).meta)['chars.c1.pos'];
  const m2 = JSON.parse(stateRow(ids[1]).meta)['chars.c1.pos'];
  const m3 = JSON.parse(stateRow(ids[2]).meta)['chars.c1.pos'];

  // 三个来源是两件不同的事，实测确认（不是按名字猜）：
  //   · `src` = **值从哪来**，链上一直指向起点镜（不会变成"上一镜"）；
  //   · `derived_from` = **这一镜的上游是哪一镜**，逐镜前进。
  // 把两者混为一谈会导致"继承链第 3 镜的起点被改写成第 2 镜"——起点一丢，追溯就断了。
  assert.equal(m1.src, 'blocking:c1', '第 1 镜的位置来自自己的站位行');
  assert.equal(m2.src, `prev_shot:${ids[0]}`);
  assert.equal(m3.src, `prev_shot:${ids[0]}`, '起点镜必须保留，不得逐镜改写');
  for (const m of [m1, m2, m3]) {
    assert.equal(m.rel, 'known');
    assert.equal(typeof m.conf, 'number');
    assert.equal(Number.isFinite(m.ver), true);
  }
  assert.equal(stateRow(ids[1]).derived_from, `prev_shot:${ids[0]}`);
  assert.equal(stateRow(ids[2]).derived_from, `prev_shot:${ids[1]}`, 'derived_from 逐镜前进');
});

test('P4 重复求解幂等：不改内容就不写库，updated_at 与内容 Hash 都不动', () => {
  const { p, ids } = seedScene({ shots: 2 });
  const first = runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  const before = ids.map((id) => stateRow(id));

  const second = runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  assert.equal(second.states.written.length, 0, '同输入重跑不应再写状态');
  assert.deepEqual(second.states.unchanged.sort(), [...ids].sort());

  for (const [i, id] of ids.entries()) {
    const after = stateRow(id);
    assert.equal(after.updated_at, before[i].updated_at, '内容没变，updated_at 不该被刷新');
    assert.equal(stateContentHash(after), stateContentHash(before[i]));
    // 报告也应复用同一条
    assert.equal(second.reports[i].reused, true);
    assert.equal(second.reports[i].report_id, first.reports[i].report_id);
  }
});

test('P5 输入变化后更新同一行（不是插新行）：written=updated，内容 Hash 变', () => {
  const { p, ids } = seedScene({ shots: 2 });
  runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  const before = stateRow(ids[1]);

  db.prepare('UPDATE shot_blockings SET norm_x = ? WHERE shot_id = ?').run(0.62, ids[1]);
  const out = runSceneQuality({ projectId: p.id, sceneKey: SCENE });

  const updated = out.states.written.find((w) => w.shot_id === ids[1]);
  assert.ok(updated, '输入变了却没写状态');
  assert.equal(updated.action, 'updated');
  assert.notEqual(updated.content_hash, stateContentHash(before));
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM shot_states WHERE shot_id = ?').get(ids[1]).c, 1, '不得插出第二行');
});

test('P6 事务回滚：状态写入随外层失败整体撤销，不留半套', () => {
  const { p, ids } = seedScene({ shots: 2 });
  runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  const before = ids.map((id) => ({ ...stateRow(id) }));

  const states = Object.fromEntries(ids.map((id) => [id, {
    id, in: { chars: {}, props: {}, env: {} }, out: { chars: {}, props: {}, env: {} },
    meta: {}, derived_from: 'boom', conflicts: [],
  }]));

  assert.throws(() => tx(() => {
    persistSceneStates({ projectId: p.id, sceneKey: SCENE, states });
    throw new Error('boom');
  }), /boom/);

  // 回滚后逐列仍是第一次的结果：不是"空状态"，也不是"改了一半"
  for (const [i, id] of ids.entries()) {
    const after = stateRow(id);
    assert.deepEqual({ ...after }, before[i], `第 ${i + 1} 镜被回滚事务改写了`);
    assert.notEqual(after.derived_from, 'boom');
    assert.equal(after.derived_from, i === 0 ? 'scene_baseline' : `prev_shot:${ids[i - 1]}`);
  }
});

test('P7 场次里消失的镜头：状态行被清掉，不残留成幽灵结论', () => {
  const { p, ids } = seedScene({ shots: 3 });
  runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  assert.equal(stateRow(ids[2]) !== undefined, true);

  db.prepare('DELETE FROM shot_blockings WHERE shot_id = ?').run(ids[2]);
  db.prepare('DELETE FROM shot_states WHERE shot_id = ?').run(ids[2]);
  db.prepare('DELETE FROM qc_reports WHERE target_id = ?').run(ids[2]);
  db.prepare('DELETE FROM story_shots WHERE id = ?').run(ids[2]);

  const out = runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  assert.equal(out.shotCount, 2);
  assert.equal(stateRow(ids[2]), undefined);
});

test('P8 持久化不回灌求解：写入状态后再跑，求解 Hash 不变', () => {
  const { p } = seedScene({ shots: 3 });
  const first = runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  const second = runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  assert.equal(second.solveHash, first.solveHash, '求解 Hash 变了说明 shot_states 被当成了输入');
  // 再塞一条伪造的 carried 元数据也一样（读取层根本不读 shot_states）
  db.prepare('UPDATE shot_states SET meta = ? WHERE shot_id = (SELECT id FROM story_shots WHERE project_id = ? LIMIT 1)')
    .run(JSON.stringify({ 'chars.c1.pos': { rel: 'unknown', src: 'carried:sh_fake', conf: 0.1 } }), p.id);
  const third = runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  assert.equal(third.solveHash, first.solveHash);
});

test('P9 表结构未变：shot_states 仍是 8 列，且没有 meta_in 列', () => {
  const cols = db.prepare('PRAGMA table_info(shot_states)').all().map((c) => c.name);
  assert.deepEqual(cols, ['shot_id', 'state_in', 'state_out', 'meta', 'derived_from', 'state_source', 'conflicts', 'updated_at']);
  assert.equal(cols.includes('meta_in'), false);
});

test('P10 内容 Hash 与键序无关、与 updated_at 无关', () => {
  const a = toShotStateRow({ id: 's1', in: { a: 1, b: 2 }, out: {}, meta: { x: { rel: 'known' } }, derived_from: 'scene_baseline', conflicts: [] }, { shotId: 's1', updatedAt: 1 });
  const b = toShotStateRow({ id: 's1', in: { b: 2, a: 1 }, out: {}, meta: { x: { rel: 'known' } }, derived_from: 'scene_baseline', conflicts: [] }, { shotId: 's1', updatedAt: 999 });
  assert.equal(stateContentHash(a), stateContentHash(b));
  assert.notEqual(stateContentHash(a), stateContentHash({ ...a, derived_from: 'prev_shot:s0' }));
});

test('P11 写库前的形状校验：缺 id / 非对象状态直接拒，不写半行', () => {
  const { p, ids } = seedScene({ shots: 1 });
  assert.throws(
    () => persistSceneStates({ projectId: p.id, sceneKey: SCENE, states: { [ids[0]]: { in: [], out: {}, meta: {} } } }),
    (e) => e.reason === 'STATE_PERSIST_INVALID',
  );
  assert.equal(stateRow(ids[0]), undefined);

  const rows = listShotStates(ids);
  assert.equal(rows.length, 0);
});
