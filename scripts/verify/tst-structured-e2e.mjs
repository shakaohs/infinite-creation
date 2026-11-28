#!/usr/bin/env node
// D51-04 · 真实结构化项目端到端验证（隔离项目 · 可重复 · 可清理 · 不碰生产库）
//
// 为什么是独立脚本而不是 node:test：
//   ① 同一份流程要能在 SQLite 与 PostgreSQL 两个真库上各跑一遍（node:test 进程被禁止连 PG）；
//   ② 它验证的是「一组生产函数串起来的数据流」，不是单个断言点。
//
// 用法：
//   SQLite：      IC_DATA_DIR=$(mktemp -d) node scripts/verify/tst-structured-e2e.mjs
//   PostgreSQL：  PGHOST=127.0.0.1 PGPORT=55433 PGUSER=postgres PGUSER_PW=... \
//                 IC_DB=postgres DATABASE_URL=postgres://... node scripts/verify/tst-structured-e2e.mjs
//
// 十四步（对应 D02-51 §五）：
//   E2E-01 隔离项目 + structured_spec=1
//   E2E-02 场次基线 + 六类资产
//   E2E-03 写 3 镜（insertStoryShot）
//   E2E-04 writeShotAssets 写六类绑定
//   E2E-05 projectSceneUnits 投影
//   E2E-06 ShotParams.update 写 B 组
//   E2E-07 段与镜身份映射（1:N + idx 连续 + segment_id 回写）
//   E2E-08 投影字段白名单（只写 A 组；B/C/E 不被覆盖）
//   E2E-09 候选保护（内容变化 ⇒ 拒绝；候选零改写）
//   E2E-10 审计（A3 差集有日志；投影不产 shot 日志）
//   E2E-11 事务失败整体回滚（复合入口第 4 步注入失败）
//   E2E-12 项目锁契约（同项目嵌套复用 / 跨项目嵌套拒绝；真并发归 P2 双进程脚本）
//   E2E-13 legacy 项目不受影响（structured_spec=0 仍写 shots、不写 story_shots）
//   E2E-14 重复投影幂等（created=0 / updated=0 / unchanged=1）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXPECT_PG_DB = 'infinite_creation_test';
const isPg = String(process.env.IC_DB || '').toLowerCase() === 'postgres' || !!process.env.DATABASE_URL;
if (isPg) {
  const dbName = (() => { try { return new URL(process.env.DATABASE_URL).pathname.replace(/^\//, ''); } catch { return ''; } })();
  if (dbName !== EXPECT_PG_DB) {
    console.log(`[安全事件] 连到的库是 ${dbName || '(未知)'}，不是 ${EXPECT_PG_DB}。立即停止。`);
    process.exit(2);
  }
  delete process.env.NODE_TEST_CONTEXT;
}
if (!process.env.IC_DATA_DIR) process.env.IC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-e2e-'));

const results = [];
const log = (...a) => console.log(...a);
function record(id, name, ok, detail) {
  results.push({ id, name, ok: !!ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? '  ' + detail : ''}`);
}

const core = await import('../../lib/core/index.js');
const { getDb, Projects, Chapters, Assets, Shots } = core;
const { insertStoryShot } = await import('../../lib/core/render/global-no.js');
const { projectSceneUnits } = await import('../../lib/core/render/project-units.js');
const { ShotParams } = await import('../../lib/core/render/unit-params.js');
const { writeShotAssets } = await import('../../lib/core/render/shot-assets.js');
const { createStructuredShot } = await import('../../lib/core/render/shot-composite.js');
const { listChanges } = await import('../../lib/core/changelog.js');
const { txProject } = await import('../../lib/core/db.js');
const { setStructuredSpec } = await import('../../lib/core/structured-spec.js');

const db = getDb();
const num = (v) => Number(v);

async function main() {
  log(`=== 结构化项目端到端验证（${db.dialect}）===`);
  let pid = '';
  try {
    // ── 01 隔离项目 + 开关 ────────────────────────────────────────────────
    const p = Projects.create({ name: 'd51-e2e-' + Date.now(), video_resolution: '1080P', video_aspect_ratio: '9:16' });
    pid = p.id;
    setStructuredSpec(pid, true);
    const ch = Chapters.list(pid)[0];
    record('E2E-01', '隔离项目创建并启用 structured_spec=1', core.isStructuredSpec(pid) === true, `pid=${pid}`);

    // ── 02 场次基线 + 六类资产 ───────────────────────────────────────────
    const sceneAsset = Assets.create(pid, { category: 'scene', name: '病房' });
    const hero = Assets.create(pid, { category: 'character', name: '罗克珊' });
    const prop = Assets.create(pid, { category: 'prop', name: '输液架' });
    const costume = Assets.create(pid, { category: 'costume', name: '病号服', parent_id: hero.id });
    const age = Assets.create(pid, { category: 'age', name: '病中', parent_id: hero.id });
    const voice = Assets.create(pid, { category: 'voice', name: '低沉女声' });
    core.upsertSceneStates(pid, ch, [{ scene_key: 'S01', scene_id: sceneAsset.id }]);
    const st = db.prepare('SELECT * FROM scene_states WHERE project_id = ? AND scene_key = ?').get(pid, 'S01');
    record('E2E-02', '场次基线 + 六类资产就绪', !!st && st.scene_id === sceneAsset.id, `scene_state=${st && st.id}`);

    // ── 03 写 3 镜 ────────────────────────────────────────────────────────
    const shots = [];
    for (let i = 1; i <= 3; i++) {
      shots.push(insertStoryShot({
        project_id: pid, chapter_id: ch.id, scene_key: 'S01', scene_uid: st.id,
        shot_no: i, global_no: i, visual_content: '画面' + i, dialogue: '台词' + i, story_duration: 4,
      }));
    }
    const ssCount = db.prepare('SELECT COUNT(*) AS n FROM story_shots WHERE project_id = ?').get(pid).n;
    record('E2E-03', '写 3 镜到 story_shots', num(ssCount) === 3 && shots.length === 3, `count=${ssCount}`);

    // ── 04 writeShotAssets 六类绑定 ───────────────────────────────────────
    const wa = writeShotAssets({
      projectId: pid, shotId: shots[0].id, sceneKey: 'S01',
      input: {
        assets: [
          { role: 'character', asset_id: hero.id },
          { role: 'scene', asset_id: sceneAsset.id },
          { role: 'prop', asset_id: prop.id },
          { role: 'costume', asset_id: costume.id },
          { role: 'age', asset_id: age.id },
          { role: 'voice', asset_id: voice.id },
        ],
      },
    });
    const roles = db.prepare('SELECT role FROM shot_assets WHERE shot_id = ? ORDER BY role').all(shots[0].id).map((r) => r.role);
    record('E2E-04', 'A3 写六类资产绑定', roles.length === 6 && wa.audit.added === 6, `roles=${roles.join(',')} audit=${JSON.stringify(wa.audit)}`);

    // ── 05 投影 ───────────────────────────────────────────────────────────
    const pr = projectSceneUnits({ projectId: pid, chapterId: ch.id, sceneUid: st.id });
    record('E2E-05', '投影生成段（一镜一段）', pr.created === 3 && pr.units.length === 3, `created=${pr.created}`);

    // ── 06 段级参数（B 组）────────────────────────────────────────────────
    const seg1 = pr.units[0].segment_id;
    ShotParams.update(seg1, { video_prompt: '段级提示词', mode: 'Ref2VA' }, { origin: 'd51-e2e' });
    const seg1Row = db.prepare('SELECT * FROM shots WHERE id = ?').get(seg1);
    record('E2E-06', 'ShotParams 写 B 组', seg1Row.video_prompt === '段级提示词' && seg1Row.mode === 'Ref2VA',
      `mode=${seg1Row.mode}`);

    // ── 07 身份映射 ───────────────────────────────────────────────────────
    const segIds = shots.map((s) => db.prepare('SELECT segment_id FROM story_shots WHERE id = ?').get(s.id).segment_id);
    const idxs = db.prepare('SELECT idx FROM shots WHERE project_id = ? ORDER BY idx').all(pid).map((r) => num(r.idx));
    record('E2E-07', '段与镜身份映射（回写 + idx 连续）',
      segIds.every(Boolean) && new Set(segIds).size === 3 && JSON.stringify(idxs) === '[1,2,3]',
      `segIds=${segIds.length} idx=${idxs.join(',')}`);

    // ── 08 投影字段白名单 ─────────────────────────────────────────────────
    const segRow = db.prepare('SELECT * FROM shots WHERE id = ?').get(seg1);
    const aOk = segRow.visual === '画面1' && num(segRow.duration) === 4 && segRow.chapter === ch.title
      && JSON.parse(segRow.character_ids).includes(hero.id) && JSON.parse(segRow.scene_ids).includes(sceneAsset.id)
      && JSON.parse(segRow.prop_ids).includes(prop.id) && JSON.parse(segRow.costume_ids).includes(costume.id)
      && JSON.parse(segRow.age_ids).includes(age.id) && JSON.parse(segRow.audio_ids).includes(voice.id);
    // E 组：项目改成 1080P / 9:16，段行仍应是 DDL 默认（480P / 16:9）—— 证明投影没写 E 组
    record('E2E-08', '投影只写 A 组（六类 id 从 shot_assets 读出，B 组保留，E 组不被投影覆盖）',
      aOk && segRow.video_prompt === '段级提示词' && segRow.status === 'pending'
      && segRow.resolution === '480P' && segRow.aspect_ratio === '16:9',
      `visual=${segRow.visual} status=${segRow.status} resolution=${segRow.resolution} aspect=${segRow.aspect_ratio}`);

    // ── 09 候选保护 ───────────────────────────────────────────────────────
    db.prepare('INSERT INTO shot_videos (id,project_id,shot_id,idx,video_path,seed,selected,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('d51-cand', pid, seg1, 0, '/d51.mp4', 3, 1, 1, 1);
    db.prepare('UPDATE story_shots SET visual_content = ? WHERE id = ?').run('改后画面', shots[0].id);
    let candErr = null;
    try { projectSceneUnits({ projectId: pid, chapterId: ch.id, sceneUid: st.id }); } catch (e) { candErr = e; }
    const candRow = db.prepare('SELECT * FROM shot_videos WHERE id = ?').get('d51-cand');
    const seg1After = db.prepare('SELECT * FROM shots WHERE id = ?').get(seg1);
    record('E2E-09', '候选保护：内容变化 ⇒ 拒绝，候选与段零改写',
      candErr && candErr.code === 'UNIT_SEGMENT_CANDIDATE_CONFLICT'
      && candRow.shot_id === seg1 && num(candRow.selected) === 1 && seg1After.visual === '画面1',
      `code=${candErr && candErr.code}`);

    // 复原内容并删除候选（为了后续幂等与审计检查）
    db.prepare('UPDATE story_shots SET visual_content = ? WHERE id = ?').run('画面1', shots[0].id);
    db.prepare('DELETE FROM shot_videos WHERE id = ?').run('d51-cand');

    // ── 10 审计 ───────────────────────────────────────────────────────────
    // 审计核对：先直查（不依赖排序），再单独验证 listChanges 这个读接口本身是否可用。
    // 直查是判据，listChanges 的可用性单独作为一项证据 —— 把"数据对不对"和"API 通不通"分开。
    const rawLogs = db.prepare("SELECT entity, action, entity_id, source FROM change_logs WHERE project_id = ?").all(pid);
    const count = (fn) => rawLogs.filter(fn).length;
    const assetCreates = count((l) => l.entity === 'shot_asset' && l.action === 'create');
    const ssCreates = count((l) => l.entity === 'story_shot' && l.action === 'create');
    const shotLogs = rawLogs.filter((l) => l.entity === 'shot');
    // `shot` 日志唯一的一条必须来自 ShotParams（A7 要求记），投影本身零增量（A6）
    const onlyFromParams = shotLogs.length === 1 && shotLogs[0].action === 'update' && shotLogs[0].entity_id === seg1;
    let lcErr = null;
    try { listChanges(pid, { entity: 'shot', limit: 200 }); } catch (e) { lcErr = { code: e.code || '', message: e.message }; }
    record('E2E-10', '审计：A3 差集 6 条、A2 建镜 3 条、投影零 shot 日志；listChanges 读接口可用',
      assetCreates === 6 && ssCreates === 3 && onlyFromParams && !lcErr,
      `shot_asset=${assetCreates} story_shot.create=${ssCreates} shot=${shotLogs.length}`
      + (lcErr ? ` listChanges 失败=${lcErr.code}:${lcErr.message}` : ' listChanges=ok'));

    // ── 11 事务失败整体回滚 ───────────────────────────────────────────────
    const before = {
      ss: num(db.prepare('SELECT COUNT(*) AS n FROM story_shots WHERE project_id = ?').get(pid).n),
      seg: num(db.prepare('SELECT COUNT(*) AS n FROM shots WHERE project_id = ?').get(pid).n),
      sa: num(db.prepare('SELECT COUNT(*) AS n FROM shot_assets WHERE shot_id IN (SELECT id FROM story_shots WHERE project_id = ?)').get(pid).n),
    };
    const orig = db.prepare.bind(db);
    let injected = 0;
    db.prepare = (sql) => {
      if (/UPDATE shots SET/i.test(sql) && /video_prompt/.test(sql)) { injected += 1; throw new Error('injected at ShotParams'); }
      return orig(sql);
    };
    let injErr = null;
    try {
      createStructuredShot({
        projectId: pid, chapterId: ch.id, chapterTitle: ch.title, sceneKey: 'S01', sceneUid: st.id,
        patch: { visual: '第4镜', character_ids: [hero.id], video_prompt: 'x' },
      });
    } catch (e) { injErr = e; } finally { db.prepare = orig; }
    const after = {
      ss: num(db.prepare('SELECT COUNT(*) AS n FROM story_shots WHERE project_id = ?').get(pid).n),
      seg: num(db.prepare('SELECT COUNT(*) AS n FROM shots WHERE project_id = ?').get(pid).n),
      sa: num(db.prepare('SELECT COUNT(*) AS n FROM shot_assets WHERE shot_id IN (SELECT id FROM story_shots WHERE project_id = ?)').get(pid).n),
    };
    record('E2E-11', '复合入口第 4 步失败 ⇒ 镜/段/资产引用一起回滚',
      !!injErr && injected === 1 && JSON.stringify(before) === JSON.stringify(after),
      `err=${injErr && injErr.message} before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);

    // ── 12 项目锁契约（真并发归 P2）───────────────────────────────────────
    let nestedReuse = false;
    txProject(pid, () => { txProject(pid, () => { nestedReuse = true; }); });
    const p2 = Projects.create({ name: 'd51-e2e-other-' + Date.now() });
    let crossErr = null;
    try {
      txProject(pid, () => { txProject(p2.id, () => {}); });
    } catch (e) { crossErr = e; }
    record('E2E-12', '锁契约：同项目嵌套复用 / 跨项目嵌套拒绝（真并发见 P2 19/19）',
      nestedReuse && crossErr && crossErr.code === 'TX_CROSS_PROJECT_NESTED',
      `nestedReuse=${nestedReuse} cross=${crossErr && crossErr.code}`);
    Projects.remove(p2.id);

    // ── 13 legacy 项目不受影响 ────────────────────────────────────────────
    const lp = Projects.create({ name: 'd51-e2e-legacy-' + Date.now() });
    const lch = Chapters.list(lp.id)[0];
    const legacyShot = Shots.create(lp.id, { chapter: lch.title, visual: 'legacy', duration: 4 }, { writer: 'creative' });
    const lpSs = num(db.prepare('SELECT COUNT(*) AS n FROM story_shots WHERE project_id = ?').get(lp.id).n);
    const lpShots = num(db.prepare('SELECT COUNT(*) AS n FROM shots WHERE project_id = ?').get(lp.id).n);
    record('E2E-13', 'legacy 项目仍走 shots，不写 story_shots',
      !!legacyShot.id && lpSs === 0 && lpShots === 1, `shots=${lpShots} story_shots=${lpSs}`);
    Projects.remove(lp.id);

    // ── 14 重复投影幂等 ───────────────────────────────────────────────────
    const again = projectSceneUnits({ projectId: pid, chapterId: ch.id, sceneUid: st.id });
    record('E2E-14', '重复投影幂等（created=0 / updated=0 / unchanged=3）',
      again.created === 0 && again.updated === 0 && again.unchanged === 3,
      `created=${again.created} updated=${again.updated} unchanged=${again.unchanged}`);
  } finally {
    if (pid) { try { Projects.remove(pid); } catch (e) { log('[清理] 删除测试项目失败（不影响判定）：' + (e && e.message)); } }
  }

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  log('');
  log(`E2E-RESULT ${JSON.stringify({ dialect: db.dialect, total: results.length, pass, fail, ok: fail === 0, cases: results.map((r) => ({ id: r.id, ok: r.ok })) })}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  log('脚本异常：' + (e && e.message ? e.message : String(e)));
  if (e && e.stack) log(e.stack.split('\n').slice(0, 8).join('\n'));
  log(`E2E-RESULT ${JSON.stringify({ ok: false, error: String(e && e.message || e), cases: results })}`);
  process.exit(1);
});
