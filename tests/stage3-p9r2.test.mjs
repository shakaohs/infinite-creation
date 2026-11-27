// D02-23 · P9 最终验收阻断项（R2-1 状态快照 Hash 不得回退 / R2-2 正式排序 / R2-3 资产实体边界）
//
// 三组用例都踩在**真实生产链路**上（真实 sqlite + `runSceneQuality()`）：
//  · R2-1 的失败分支只能靠"先把库里的状态行弄坏，再跑一次"来触发 —— 手搓 `shotState` 证明不了
//    落库那一行真的会被这样读；
//  · R2-2 的排序冲突只能靠"同一 `created_at`、不同 `id` 的两行"来构造 —— 靠时间先后区分不了
//    `id DESC` 与 `rowid DESC`；
//  · R2-3 是**边界核查**：证明资产实体数据源确实不存在，并把"当前实际评估结果"钉成断言，
//    防止下一轮把 `CK-2 69/69` 误读成"资产规则已在真实数据上验证过"。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-p9r2-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;
delete process.env.IC_DB;
delete process.env.DATABASE_URL;

const { getDb, Chapters } = await import('../lib/core/db.js');
const { createUserProject } = await import('../lib/core/project-create.js');
const { upsertSceneStates } = await import('../lib/core/scene-state.js');
const { insertStoryShot } = await import('../lib/core/render/global-no.js');
const { planInvalidation } = await import('../lib/core/continuity/invalidate.js');
const { buildQcDependencyContext, MISSING_ASSET } = await import('../lib/core/qc/deps/index.js');
const {
  runSceneQuality, loadSceneInput, latestReport, reportHistory,
  solverInputOf, SOLVER_INPUT_ENTRY,
} = await import('../lib/core/index.js');

const db = getDb();
const SCENE = 'S01_病房';
let seq = 0;

/**
 * 造一场戏。
 * @param {{shots?:number, blocking?:boolean, actions?:boolean, assetId?:string}} o
 *   `assetId`：给每镜插一行 `shot_assets`（role=prop）—— 用来观察"有引用、无实体"的现行结论
 */
function seedScene({ shots = 1, blocking = true, actions = false, assetId = '' } = {}) {
  seq += 1;
  const p = createUserProject({ name: `P9R2-${seq}` });
  const ch = Chapters.list(p.id)[0];
  upsertSceneStates(p.id, ch, [{
    scene_key: SCENE,
    coord_system: { active_area: [8, 5, 3] },
    axis_lock: { pair: ['c1', 'c2'], left: 'c1', right: 'c2', axis_line: [[0.5, 0], [0.5, 1]] },
    time_of_day: '夜',
  }]);
  const ids = [];
  for (let i = 1; i <= shots; i += 1) {
    const r = insertStoryShot({
      project_id: p.id, chapter_id: ch.id, scene_key: SCENE,
      shot_no: i, global_no: i, spec_source: 'ai', story_duration: 4,
      speakers: [{ id: 'c1', type: 'on_screen' }], time_slices: [{ from: 0, to: 4 }],
    });
    ids.push(r.id);
    if (blocking) {
      db.prepare(
        'INSERT INTO shot_blockings (shot_id, character_id, position_abs, norm_x, norm_y, norm_z, norm_confidence,'
        + ' position_track, anchor_object, facing, gaze_target, posture, in_frame) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(r.id, 'c1', '画面左', 0.30 + 0.02 * (i - 1), 0.70, 0, 0.95, '[]', assetId || 'fx_table', 'W', 'c2', 'standing', 1);
    }
    if (actions) {
      db.prepare(
        'INSERT INTO shot_actions (id, shot_id, actor_id, action_type, is_primary, tier, t_from, t_to, body_parts)'
        + ' VALUES (?,?,?,?,?,?,?,?,?)',
      ).run(`act_${seq}_${i}`, r.id, 'c1', 'expression', 1, 'T1', 0, 2, '[]');
    }
    if (assetId) {
      db.prepare('INSERT INTO shot_assets (shot_id, asset_id, role, order_no, variant_of) VALUES (?,?,?,?,?)')
        .run(r.id, assetId, 'prop', 1, '');
    }
  }
  return { p, ids, ch };
}

const stateRow = (shotId) => db.prepare('SELECT * FROM shot_states WHERE shot_id = ?').get(shotId);
const metaOf = (shotId) => JSON.parse(stateRow(shotId).meta);
const reportCount = (targetId) => db.prepare('SELECT COUNT(*) AS c FROM qc_reports WHERE target_id = ?').get(targetId).c;
const ruleHits = (rep) => rep.hits.filter((h) => !String(h.rule_id).startsWith('__'));

/** 直接往库里塞一份"报告"：`created_at`/`id`/输入 Hash 都可指定，用来构造排序与复用冲突 */
function insertReportRow({
  projectId, targetId, id, from, createdAt, rulesetVer, qcInputHash, qcDepHash,
}) {
  const hits = JSON.parse(JSON.stringify(from.hits));
  const meta = hits.find((h) => h.rule_id === SOLVER_INPUT_ENTRY);
  if (qcInputHash) meta.detail.qc_input_hash = qcInputHash;
  if (qcDepHash) meta.detail.qc_dependency_hash = qcDepHash;
  db.prepare(
    'INSERT INTO qc_reports (id, project_id, target_type, target_id, ruleset_ver, level, hits, created_at)'
    + ' VALUES (?,?,?,?,?,?,?,?)',
  ).run(id, projectId, 'shot', targetId, rulesetVer ?? from.ruleset_ver, from.level, JSON.stringify(hits), createdAt);
}

// ══ R2-1 状态快照 Hash 不得回退 ══════════════════════════════════════════
// 旧实现 `stateSnapshotHashOf(row) || solved.hash` 有两层危害：缺快照不报错，且 A 恒等于 B
// ⇒ `hash_relation` 永远是 `same`。也就是说"这行状态不知道是哪版输入算的"被伪装成最健康的状态。

test('S1 首次求解：状态快照取自库里 __solver.hash，三条 Hash 同值、relation=same', () => {
  const { p, ids } = seedScene({ shots: 1 });
  const out = runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  const meta = solverInputOf(latestReport(ids[0]).hits);

  assert.equal(meta.state_snapshot_hash, metaOf(ids[0]).__solver.hash, '快照必须等于库里那一行的 __solver.hash');
  assert.equal(meta.state_snapshot_hash, out.solveHash);
  assert.equal(meta.hash_relation, 'same');
  assert.equal(out.reports[0].hash_relation, 'same');
});

test('S2 输入变而状态内容不变：快照保留上一版，relation=state_older（不被新输入顶替）', () => {
  const { p, ids } = seedScene({ shots: 1 });
  const first = runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  const snapshotA = metaOf(ids[0]).__solver.hash;

  // power_level 进求解 Hash，但不改任何派生状态
  db.prepare('UPDATE shot_blockings SET power_level = ? WHERE shot_id = ?').run('high', ids[0]);
  const second = runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  const meta = solverInputOf(latestReport(ids[0]).hits);

  assert.notEqual(second.solveHash, first.solveHash, '输入 Hash 必须变，否则用例前提不成立');
  assert.equal(second.states.written.length, 0, '状态内容没变 ⇒ 不该重写状态行');
  assert.equal(meta.state_snapshot_hash, snapshotA, '快照被新输入顶替了（回退逻辑又回来了）');
  assert.notEqual(meta.state_snapshot_hash, meta.qc_input_hash);
  assert.equal(meta.hash_relation, 'state_older');
});

test('S3 状态行存在但 __solver.hash 缺失：拒绝生成报告（QC_REPORT_INVALID）', () => {
  const { p, ids } = seedScene({ shots: 1 });
  runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  const before = reportCount(ids[0]);

  // 只摘掉版本戳：业务内容逐字未变 ⇒ 状态行不会被重写 ⇒ 下一轮读到的就是"没有快照"的那一行
  const m = metaOf(ids[0]);
  delete m.__solver;
  db.prepare('UPDATE shot_states SET meta = ? WHERE shot_id = ?').run(JSON.stringify(m), ids[0]);

  assert.throws(
    () => runSceneQuality({ projectId: p.id, sceneKey: SCENE }),
    (e) => e.code === 'QC_REPORT_INVALID' && e.reason === 'STATE_SNAPSHOT_HASH_MISSING',
  );
  assert.equal(reportCount(ids[0]), before, '拒绝时不得落下任何新报告');
  assert.equal(metaOf(ids[0]).__solver, undefined, '失败必须整体回滚：状态行不该被补上 __solver');
});

test('S4 状态 meta 无法解析：拒绝生成报告（QC_REPORT_INVALID）', () => {
  // 必须是"业务内容为空"的镜（无站位、无动作）：否则坏 meta 会被判成内容变化，行被重写，缺陷反而看不到
  const { p, ids } = seedScene({ shots: 1, blocking: false });
  runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  assert.deepEqual(Object.keys(metaOf(ids[0])), ['__solver'], '用例前提：业务 meta 为空，摘掉版本戳后内容仍相等');

  db.prepare('UPDATE shot_states SET meta = ? WHERE shot_id = ?').run('{not json', ids[0]);
  assert.throws(
    () => runSceneQuality({ projectId: p.id, sceneKey: SCENE }),
    (e) => e.code === 'QC_REPORT_INVALID' && e.reason === 'STATE_SNAPSHOT_META_UNPARSEABLE',
  );
});

test('S5 缺快照绝不产生 same：拒绝后库里没有任何一份把 qc_input_hash 当快照的报告', () => {
  const { p, ids } = seedScene({ shots: 1 });
  runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  const m = metaOf(ids[0]);
  delete m.__solver;
  db.prepare('UPDATE shot_states SET meta = ? WHERE shot_id = ?').run(JSON.stringify(m), ids[0]);

  assert.throws(() => runSceneQuality({ projectId: p.id, sceneKey: SCENE }), (e) => e.code === 'QC_REPORT_INVALID');

  const history = reportHistory(ids[0]);
  assert.equal(history.length, 1, '拒绝不该留下第二份报告');
  for (const rep of history) {
    const meta = solverInputOf(rep.hits);
    // 唯一一份是"缺快照之前"那次成功运行留下的：它的快照确实等于当时的输入 Hash，属于正当的 same
    assert.equal(meta.state_snapshot_hash, meta.qc_input_hash);
    assert.equal(meta.hash_relation, 'same');
  }
  // 关键在于：这一次失败**没有**产出新的 same 报告（长度仍是 1），而不是"补一个 Hash 继续跑"
  assert.equal(reportCount(ids[0]), 1);
});

// ══ R2-2 最新报告查询统一遵守正式排序（§18.11：created_at DESC, id DESC）══════════

test('T1 同一 created_at：按 id DESC 选最新（latestReport 与 reportHistory 同序）', () => {
  const T = 1700000000000;
  const { p, ids } = seedScene({ shots: 1 });
  runSceneQuality({ projectId: p.id, sceneKey: SCENE, updatedAt: T });
  const base = latestReport(ids[0]);

  // 两份"同一毫秒"的报告：靠时间区分不出来，只能靠 id
  insertReportRow({ projectId: p.id, targetId: ids[0], id: 'aaa-decoy', from: base, createdAt: T + 5 });
  insertReportRow({ projectId: p.id, targetId: ids[0], id: 'zzz-decoy', from: base, createdAt: T + 5 });

  assert.equal(latestReport(ids[0]).id, 'zzz-decoy', '同一时间戳下没有按 id DESC 取最新');
  const history = reportHistory(ids[0]).map((r) => r.id);
  assert.deepEqual(history.slice(0, 2), ['zzz-decoy', 'aaa-decoy']);
  assert.equal(history[2], base.id);
});

test('T2 saveReport 与 latestReport 读的是同一行：id 更大的那份 Hash 不同 ⇒ 不复用', () => {
  const T = 1700000100000;
  const { p, ids } = seedScene({ shots: 1 });
  const first = runSceneQuality({ projectId: p.id, sceneKey: SCENE, updatedAt: T });
  const base = latestReport(ids[0]);
  const cur = solverInputOf(base.hits);

  // `aaa-match` 携带与本轮完全一致的输入依赖 Hash；`zzz-other` 不一致。
  // 若两处排序不一致（比如 saveReport 还在看最旧/其它行），就会去复用 `aaa-match`。
  insertReportRow({
    projectId: p.id, targetId: ids[0], id: 'aaa-match', from: base, createdAt: T + 5,
    qcInputHash: cur.qc_input_hash, qcDepHash: cur.qc_dependency_hash,
  });
  insertReportRow({
    projectId: p.id, targetId: ids[0], id: 'zzz-other', from: base, createdAt: T + 5,
    qcInputHash: `sha256:${'0'.repeat(64)}`,
  });

  const again = runSceneQuality({ projectId: p.id, sceneKey: SCENE, updatedAt: T + 5 });
  assert.equal(again.reports[0].reused, false, '复用了不是"最新"的那份报告');
  assert.notEqual(again.reports[0].report_id, 'aaa-match');
  // previous_id = saveReport 认定的"上一份"：必须就是 latestReport 指的那一行
  assert.equal(again.reports[0].carried_from, 'zzz-other', 'saveReport 与 latestReport 认定的最新行不一致');
});

test('T3 同一 created_at 重复执行：仍然幂等复用，不插新行', () => {
  const T = 1700000150000;
  const { p, ids } = seedScene({ shots: 1 });
  const a = runSceneQuality({ projectId: p.id, sceneKey: SCENE, updatedAt: T });
  const b = runSceneQuality({ projectId: p.id, sceneKey: SCENE, updatedAt: T });

  assert.equal(b.reports[0].reused, true);
  assert.equal(b.reports[0].report_id, a.reports[0].report_id);
  assert.equal(reportCount(ids[0]), 1);
});

test('T4 旧规则集报告仍先被选为候选（不回退更旧的当前版本），再由版本校验拒绝继承', () => {
  const T = 1700000200000;
  const { p, ids } = seedScene({ shots: 2 });
  runSceneQuality({ projectId: p.id, sceneKey: SCENE, updatedAt: T });
  const cur = latestReport(ids[0]);

  // 最新一份是"上一版规则集"：候选必须先选它，而不是跳过它去捡更旧的那份当前版本
  insertReportRow({
    projectId: p.id, targetId: ids[0], id: 'zzz-old-ruleset', from: cur,
    createdAt: T + 1000, rulesetVer: 'd01-v7/stage3.0',
  });
  assert.equal(latestReport(ids[0]).id, 'zzz-old-ruleset', '候选查询把旧版本预过滤掉了，或回退到了更旧报告');

  db.prepare('UPDATE story_shots SET dialogue = ? WHERE id = ?').run('换句台词', ids[0]);
  const loaded = loadSceneInput({ projectId: p.id, sceneKey: SCENE });
  const plan = planInvalidation({
    change: { shots: [{ shot_id: ids[0], fields: ['dialogue'] }] },
    shots: loaded.rows,
    sceneStates: loaded.sceneState ? [loaded.sceneState] : [],
    shotAssets: [],
  });
  const out = runSceneQuality({ projectId: p.id, sceneKey: SCENE, plan, updatedAt: T + 2000 });

  const hits = ruleHits(latestReport(ids[0]));
  assert.equal(hits.filter((h) => h.source === 'carried').length, 0, '跨规则集版本仍发生了继承');
  assert.notEqual(out.reports[0].report_id, 'zzz-old-ruleset', '把旧版本报告当成当前结论复用了');
  assert.equal(latestReport(ids[0]).ruleset_ver, 'd01-v7/stage3.1');
});

// ══ R2-3 资产实体数据源边界（情况 B：不存在）════════════════════════════════
// D02-06 V7 §9.2.1 C.4 要 `ctx.assets` = 本镜引用到的**资产实体行**（id/name/category/parent_id），
// 但本仓库只有引用表 `shot_assets`，**没有**资产实体主表（21 张表逐一核对，见 D02-23 §R2-3）。
// 因此这些规则目前的结论**不是**真实资产数据算出来的，必须显式标记，不得算作已验收能力。

test('U1 资产实体未接通：真实链路返回值显式标记 wired=false（不得静默当作已接）', () => {
  const { p, ids } = seedScene({ shots: 1 });
  const out = runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  assert.equal(out.assetEntities.wired, false);
  assert.equal(out.assetEntities.source, null);
  assert.equal(out.assetEntities.passed, 0);
  assert.equal(out.reports.length, 1);
  assert.ok(ids.length === 1);
});

test('U2 有引用、无实体：实体字段落 __missing__ 哨兵，V-03 按哨兵判 fail（fail-closed，但不是真实资产验证）', () => {
  const { p, ids } = seedScene({ shots: 1, assetId: 'a1' });
  const shotAsset = { shot_id: ids[0], asset_id: 'a1', role: 'prop', order_no: 1, variant_of: '' };

  // ① 依赖层：引用得到、实体没有 ⇒ 三个实体字段全是哨兵（AR-3），而不是被静默跳过
  const ctx = buildQcDependencyContext({
    sceneKey: SCENE, shotId: ids[0], shot: { id: ids[0] },
    shotAssets: [shotAsset], assets: [],
  });
  assert.deepEqual(ctx.assetsById.a1, {
    id: 'a1', name: MISSING_ASSET, category: MISSING_ASSET, parent_id: MISSING_ASSET,
  });

  // ② 生产链路：V-03 因此判 fail，且 expected 里写明"资产 a1 是 __missing__"——
  //    结论是"没有实体数据"，不是"category 与 role 真的不一致"。这句话必须能被看见。
  const out = runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  assert.equal(out.assetEntities.wired, false);
  const v03 = ruleHits(latestReport(ids[0])).find((h) => h.rule_id === 'V-03');
  assert.equal(v03.applicable, true);
  assert.equal(v03.level, 'fail');
  assert.equal(v03.code, 'ASSET_ROLE_MISMATCH');
  assert.match(String(v03.expected), /__missing__/);
  assert.equal(out.gate.decision, 'pause', '无实体数据时门禁必须 fail-closed（暂停），不得放行');
});
