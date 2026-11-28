#!/usr/bin/env node
// D48-05 / D49-02 / D50-01 · PostgreSQL 投影兼容性冒烟（D02-48 §六 + D02-49 §二 + D02-50 §二）
//
// 为什么是独立脚本而不是 node:test 用例：
//   `lib/core/db.js` 在测试进程里**一律拒绝** PG（`TEST_REQUIRES_SQLITE`），因为 IC_DATA_DIR
//   对 PG 没有隔离意义。这里不是测试进程，走应用真实连接路径。
//
// 十二项（逐项打印 PASS/FAIL）：D02-48 七项 + D02-49 三项 + D02-50 两项跨段守卫
//   PGPROJ-01 单镜单段投影
//   PGPROJ-02 一段多镜投影
//   PGPROJ-03 重复投影（幂等：created=0 / updated=0 / unchanged=1）
//   PGPROJ-04 `story_shots.segment_id` 回写
//   PGPROJ-05 显式分段完整性拒绝（漏镜 ⇒ UNIT_SHOT_COVERAGE_INCOMPLETE，零写入）
//   PGPROJ-06 候选保护（旧段有候选 + 同段序新镜 ⇒ 换新 id，旧段/候选不动）
//   PGPROJ-07 投影中途失败整体回滚（第二段 INSERT 注入失败 ⇒ 第一段也回滚）
//   PGPROJ-08 候选存在 + 内容变化 ⇒ UNIT_SEGMENT_CANDIDATE_CONFLICT，段/候选不变
//   PGPROJ-09 内容相同的重投影 ⇒ 允许（幂等），候选不动
//   PGPROJ-10 候选存在 + 归属增加（合并）⇒ 拒绝，segment_id 不回写
//   PGPROJ-11 合并 A+B、候选只在 B（非 base）⇒ 拒绝（segment_absorbed）
//   PGPROJ-12 换段 id 不能把候选变孤儿：显式新 id ⇒ 拒绝，且未建新段
//
// 安全前置：连到的库**必须是** `infinite_creation_test`，否则立即退出（exit 2），不执行任何写操作。
// 不以 P2 的 19/19 锁测试作为投影证据（D02-48 §六 明令）。
//
// 用法（密码只经环境变量，不进命令行文本）：
//   PGPASSWORD=$(cat /d/pg16/pw.txt) PGHOST=127.0.0.1 PGPORT=55432 PGUSER=postgres \
//   PGDATABASE=infinite_creation_test node scripts/verify/tst-proj-pg.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

const EXPECT_DB = 'infinite_creation_test';
const PG = {
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 55432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || '',
  database: process.env.PGDATABASE || EXPECT_DB,
};

const results = [];
const log = (...a) => console.log(...a);
function record(id, name, ok, detail) {
  results.push({ id, name, ok: !!ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? '  ' + detail : ''}`);
}

async function preflight() {
  const c = new pg.Client({ ...PG, connectionTimeoutMillis: 8000 });
  c.on('error', () => {});
  await c.connect();
  const { rows } = await c.query("SELECT current_setting('server_version') AS v, current_database() AS d, pg_backend_pid() AS p");
  const { v, d, p } = rows[0];
  log(`[自检] 服务端版本=${v} 库名=${d} 后端pid=${p}`);
  if (d !== EXPECT_DB) {
    log(`[安全事件] 连到的库是 ${d}，不是 ${EXPECT_DB}。立即停止，不执行任何写操作。`);
    await c.end();
    process.exit(2);
  }
  await c.end();
  return { version: v, database: d, backendPid: p };
}

const num = (v) => Number(v);

async function main() {
  log('=== PostgreSQL 投影兼容性冒烟（D02-48 / D02-49 / D02-50）===');
  const meta = await preflight();
  if (!String(meta.version).startsWith('16.')) {
    record('SELF', '服务端版本 16.x', false, meta.version);
    return finish(meta);
  }

  // 应用真实连接路径：不是 node:test 进程，IC_DB=postgres + DATABASE_URL
  const url = `postgres://${encodeURIComponent(PG.user)}:${encodeURIComponent(PG.password)}`
    + `@${PG.host}:${PG.port}/${PG.database}`;
  process.env.IC_DB = 'postgres';
  process.env.DATABASE_URL = url;
  process.env.IC_DATA_DIR = process.env.IC_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-pg-proj-'));
  delete process.env.NODE_TEST_CONTEXT;

  const core = await import('../../lib/core/index.js');
  const { getDb, Projects, Chapters } = core;
  const { insertStoryShot, deleteStoryShot } = await import('../../lib/core/render/global-no.js');
  const { projectSceneUnits } = await import('../../lib/core/render/project-units.js');

  const db = getDb();
  record('SELF-PG', '应用层连上 PostgreSQL', db.dialect === 'postgres', `dialect=${db.dialect}`);

  const p = Projects.create({ name: 'pg-d48-' + Date.now(), structured_spec: 1 });
  const chapter = Chapters.list(p.id)[0];
  const pid = p.id;
  const cid = chapter.id;
  const segIdOf = (shotId) => db.prepare('SELECT segment_id FROM story_shots WHERE id = ?').get(shotId)?.segment_id ?? '';

  try {
    // ── 01 单镜单段 ─────────────────────────────────────────────────────────
    const s1 = 'pg-d48-s1';
    const a = insertStoryShot({
      project_id: pid, chapter_id: cid, scene_key: 'S01', scene_uid: s1,
      shot_no: 1, global_no: 1, visual_content: 'A', dialogue: '甲', story_duration: 4,
    });
    const r1 = projectSceneUnits({ projectId: pid, chapterId: cid, sceneUid: s1 });
    const seg1 = r1.units[0]?.segment_id || '';
    const row1 = db.prepare('SELECT * FROM shots WHERE id = ?').get(seg1);
    record('PGPROJ-01', '单镜单段投影：1 镜 ⇒ 1 段，A 组取自镜',
      r1.created === 1 && !!row1 && num(row1.idx) === 1 && row1.visual === 'A' && num(row1.duration) === 4,
      `created=${r1.created} idx=${row1 && row1.idx} visual=${row1 && row1.visual} duration=${row1 && row1.duration}`);

    // ── 02 一段多镜 ─────────────────────────────────────────────────────────
    const b = insertStoryShot({
      project_id: pid, chapter_id: cid, scene_key: 'S01', scene_uid: s1,
      shot_no: 2, global_no: 2, visual_content: 'B', dialogue: '乙', story_duration: 5,
    });
    const r2 = projectSceneUnits({
      projectId: pid, chapterId: cid, sceneUid: s1,
      units: [{ segment_id: seg1, shot_ids: [a.id, b.id] }],
    });
    const merged = db.prepare('SELECT * FROM shots WHERE id = ?').get(seg1);
    const sceneSegCount = db.prepare(
      'SELECT COUNT(*) AS n FROM shots WHERE project_id = ? AND id IN (SELECT segment_id FROM story_shots WHERE project_id = ? AND scene_uid = ?)',
    ).get(pid, pid, s1);
    record('PGPROJ-02', '一段多镜投影：两镜合并为 1 段，内容按行拼接、时长相加',
      r2.units.length === 1 && r2.units[0].segment_id === seg1 && num(merged.duration) === 9
      && merged.visual === 'A\nB' && num(sceneSegCount.n) === 1,
      `units=${r2.units.length} duration=${merged.duration} visual=${JSON.stringify(merged.visual)} segCount=${sceneSegCount.n}`);

    // ── 03 重复投影（幂等）──────────────────────────────────────────────────
    const before = { ...db.prepare('SELECT * FROM shots WHERE id = ?').get(seg1) };
    const r3 = projectSceneUnits({
      projectId: pid, chapterId: cid, sceneUid: s1,
      units: [{ segment_id: seg1, shot_ids: [a.id, b.id] }],
    });
    const after = { ...db.prepare('SELECT * FROM shots WHERE id = ?').get(seg1) };
    record('PGPROJ-03', '重复投影幂等：created=0 / updated=0 / unchanged=1，整行不变',
      r3.created === 0 && r3.updated === 0 && r3.unchanged === 1
      && JSON.stringify(before) === JSON.stringify(after),
      `created=${r3.created} updated=${r3.updated} unchanged=${r3.unchanged}`);

    // ── 04 segment_id 回写 ──────────────────────────────────────────────────
    const w1 = segIdOf(a.id); const w2 = segIdOf(b.id);
    record('PGPROJ-04', 'segment_id 回写：两镜都指向合并后的同一段',
      w1 === seg1 && w2 === seg1, `a=${w1} b=${w2} expect=${seg1}`);

    // ── 05 显式分段完整性拒绝 ───────────────────────────────────────────────
    const c = insertStoryShot({
      project_id: pid, chapter_id: cid, scene_key: 'S01', scene_uid: s1,
      shot_no: 3, global_no: 3, visual_content: 'C', story_duration: 3,
    });
    let covErr = null;
    try {
      projectSceneUnits({
        projectId: pid, chapterId: cid, sceneUid: s1,
        units: [{ segment_id: seg1, shot_ids: [a.id, b.id] }],   // 漏了 c
      });
    } catch (e) { covErr = e; }
    const cSeg = segIdOf(c.id);
    const segCountAfterReject = db.prepare(
      'SELECT COUNT(*) AS n FROM shots WHERE project_id = ? AND id IN (SELECT segment_id FROM story_shots WHERE project_id = ? AND scene_uid = ?)',
    ).get(pid, pid, s1);
    record('PGPROJ-05', '显式分段漏镜 ⇒ UNIT_SHOT_COVERAGE_INCOMPLETE，且零写入',
      covErr && covErr.code === 'UNIT_SHOT_COVERAGE_INCOMPLETE'
      && Array.isArray(covErr.detail?.missing_shot_ids) && covErr.detail.missing_shot_ids.length === 1
      && covErr.detail.missing_shot_ids[0] === c.id
      && cSeg === '' && num(segCountAfterReject.n) === 1,
      `code=${covErr && covErr.code} missing=${covErr && covErr.detail && covErr.detail.missing_shot_ids} c.segment_id='${cSeg}' segCount=${segCountAfterReject.n}`);

    // ── 06 候选保护 ─────────────────────────────────────────────────────────
    const s2 = 'pg-d48-s2';
    const x = insertStoryShot({
      project_id: pid, chapter_id: cid, scene_key: 'S02', scene_uid: s2,
      shot_no: 4, global_no: 4, visual_content: '旧镜画面', story_duration: 4,
    });
    const rx = projectSceneUnits({ projectId: pid, chapterId: cid, sceneUid: s2 });
    const oldSeg = rx.units[0].segment_id;
    db.prepare('INSERT INTO shot_videos (id,project_id,shot_id,idx,video_path,seed,selected,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('pg-cand-d48', pid, oldSeg, 0, '/pg-cand.mp4', 11, 1, 1, 1);
    deleteStoryShot(x.id);                 // 段失去归属，但候选在 ⇒ 段必须保留
    const y = insertStoryShot({
      project_id: pid, chapter_id: cid, scene_key: 'S02', scene_uid: s2,
      shot_no: 5, global_no: 5, visual_content: '新镜画面', story_duration: 6,
    });
    const ry = projectSceneUnits({ projectId: pid, chapterId: cid, sceneUid: s2 });
    const oldAfter = db.prepare('SELECT * FROM shots WHERE id = ?').get(oldSeg);
    const cand = db.prepare('SELECT * FROM shot_videos WHERE id = ?').get('pg-cand-d48');
    const ySeg = segIdOf(y.id);
    const ySegRow = ySeg ? db.prepare('SELECT * FROM shots WHERE id = ?').get(ySeg) : null;
    record('PGPROJ-06', '候选保护：旧段有候选 + 同段序新镜 ⇒ 换新 id，旧段/候选不动',
      !!oldAfter && oldAfter.visual === '旧镜画面' && num(oldAfter.duration) === 4
      && !!cand && cand.shot_id === oldSeg
      && ySeg && ySeg !== oldSeg && ySegRow && ySegRow.visual === '新镜画面'
      && ry.conflicts.length === 1 && ry.conflicts[0].base_segment_id === oldSeg
      && ry.blocked.some((z) => z.segment_id === oldSeg),
      `oldSeg=${oldSeg} newSeg=${ySeg} oldVisual=${oldAfter && oldAfter.visual} cand.shot_id=${cand && cand.shot_id}`
      + ` conflicts=${JSON.stringify(ry.conflicts.map((z) => z.reason))} blocked=${ry.blocked.length}`);

    // ── 07 中途失败整体回滚 ─────────────────────────────────────────────────
    const s3 = 'pg-d48-s3';
    const d1 = insertStoryShot({
      project_id: pid, chapter_id: cid, scene_key: 'S03', scene_uid: s3,
      shot_no: 6, global_no: 6, visual_content: 'D1', story_duration: 2,
    });
    const d2 = insertStoryShot({
      project_id: pid, chapter_id: cid, scene_key: 'S03', scene_uid: s3,
      shot_no: 7, global_no: 7, visual_content: 'D2', story_duration: 2,
    });
    const origPrepare = db.prepare.bind(db);
    let inserts = 0;
    db.prepare = (sql) => {
      if (/INSERT INTO shots/i.test(sql)) {
        inserts += 1;
        if (inserts === 2) throw new Error('injected failure on 2nd insert');
      }
      return origPrepare(sql);
    };
    let injErr = null;
    try {
      projectSceneUnits({ projectId: pid, chapterId: cid, sceneUid: s3 });
    } catch (e) { injErr = e; } finally { db.prepare = origPrepare; }
    const leftSegs = db.prepare(
      'SELECT COUNT(*) AS n FROM shots WHERE project_id = ? AND id IN (SELECT segment_id FROM story_shots WHERE project_id = ? AND scene_uid = ?)',
    ).get(pid, pid, s3);
    record('PGPROJ-07', '投影中途失败整体回滚：第二段 INSERT 抛错 ⇒ 第一段也不留、segment_id 不回写',
      !!injErr && /injected failure/.test(String(injErr.message)) && inserts === 2
      && num(leftSegs.n) === 0 && segIdOf(d1.id) === '' && segIdOf(d2.id) === '',
      `err=${injErr && injErr.message} inserts=${inserts} segs=${leftSegs.n} d1='${segIdOf(d1.id)}' d2='${segIdOf(d2.id)}'`);

    // ── 08~10 候选有效性守卫（D02-49 §二）──────────────────────────────────
    const s4 = 'pg-d49-s4';
    const e1 = insertStoryShot({
      project_id: pid, chapter_id: cid, scene_key: 'S04', scene_uid: s4,
      shot_no: 8, global_no: 8, visual_content: 'E1', story_duration: 4,
    });
    const re1 = projectSceneUnits({ projectId: pid, chapterId: cid, sceneUid: s4 });
    const eSeg = re1.units[0].segment_id;
    db.prepare('INSERT INTO shot_videos (id,project_id,shot_id,idx,video_path,seed,selected,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('pg-cand-d49', pid, eSeg, 0, '/pg-cand-d49.mp4', 13, 1, 1, 1);

    const eSegBefore = { ...db.prepare('SELECT * FROM shots WHERE id = ?').get(eSeg) };
    const candBefore = { ...db.prepare('SELECT * FROM shot_videos WHERE id = ?').get('pg-cand-d49') };
    db.prepare('UPDATE story_shots SET visual_content = ? WHERE id = ?').run('E1-改后', e1.id);
    let guardErr = null;
    try {
      projectSceneUnits({ projectId: pid, chapterId: cid, sceneUid: s4 });
    } catch (e) { guardErr = e; }
    const eSegAfter = { ...db.prepare('SELECT * FROM shots WHERE id = ?').get(eSeg) };
    const candAfter = { ...db.prepare('SELECT * FROM shot_videos WHERE id = ?').get('pg-cand-d49') };
    record('PGPROJ-08', '候选存在 + 内容变化 ⇒ UNIT_SEGMENT_CANDIDATE_CONFLICT，段/候选逐列不变',
      guardErr && guardErr.code === 'UNIT_SEGMENT_CANDIDATE_CONFLICT'
      && guardErr.detail?.content_changed === true
      && JSON.stringify(eSegBefore) === JSON.stringify(eSegAfter)
      && JSON.stringify(candBefore) === JSON.stringify(candAfter),
      `code=${guardErr && guardErr.code} changed=${guardErr && guardErr.detail && guardErr.detail.changed_fields}`
      + ` segSame=${JSON.stringify(eSegBefore) === JSON.stringify(eSegAfter)} candSame=${JSON.stringify(candBefore) === JSON.stringify(candAfter)}`);

    // 09：内容改回原值 ⇒ 完全幂等，允许
    db.prepare('UPDATE story_shots SET visual_content = ? WHERE id = ?').run('E1', e1.id);
    const re2 = projectSceneUnits({ projectId: pid, chapterId: cid, sceneUid: s4 });
    const candAfter2 = { ...db.prepare('SELECT * FROM shot_videos WHERE id = ?').get('pg-cand-d49') };
    record('PGPROJ-09', '内容相同的重投影 ⇒ 允许（created=0 / updated=0 / unchanged=1），候选不动',
      re2.created === 0 && re2.updated === 0 && re2.unchanged === 1
      && JSON.stringify(candBefore) === JSON.stringify(candAfter2),
      `created=${re2.created} updated=${re2.updated} unchanged=${re2.unchanged} candSame=${JSON.stringify(candBefore) === JSON.stringify(candAfter2)}`);

    // 10：归属增加（合并新镜）⇒ 拒绝
    const e2 = insertStoryShot({
      project_id: pid, chapter_id: cid, scene_key: 'S04', scene_uid: s4,
      shot_no: 9, global_no: 9, visual_content: 'E2', story_duration: 3,
    });
    let mergeErr = null;
    try {
      projectSceneUnits({ projectId: pid, chapterId: cid, sceneUid: s4, units: [{ shot_ids: [e1.id, e2.id] }] });
    } catch (e) { mergeErr = e; }
    record('PGPROJ-10', '候选存在 + 归属增加（合并）⇒ 拒绝，两镜 segment_id 均未改回写',
      mergeErr && mergeErr.code === 'UNIT_SEGMENT_CANDIDATE_CONFLICT'
      && mergeErr.detail?.ownership_changed === true
      && segIdOf(e1.id) === eSeg && segIdOf(e2.id) === '',
      `code=${mergeErr && mergeErr.code} reason=${mergeErr && mergeErr.detail && mergeErr.detail.reason}`
      + ` e1='${segIdOf(e1.id)}' e2='${segIdOf(e2.id)}' expect='${eSeg}'`);

    // ── 11~12 跨段候选守卫（D02-50 §二）──────────────────────────────────
    const s5 = 'pg-d50-s5';
    const f1 = insertStoryShot({
      project_id: pid, chapter_id: cid, scene_key: 'S05', scene_uid: s5,
      shot_no: 10, global_no: 10, visual_content: 'F1', story_duration: 4,
    });
    const f2 = insertStoryShot({
      project_id: pid, chapter_id: cid, scene_key: 'S05', scene_uid: s5,
      shot_no: 11, global_no: 11, visual_content: 'F2', story_duration: 4,
    });
    const rf = projectSceneUnits({ projectId: pid, chapterId: cid, sceneUid: s5 });
    const fSegA = rf.units[0].segment_id;
    const fSegB = rf.units[1].segment_id;
    db.prepare('INSERT INTO shot_videos (id,project_id,shot_id,idx,video_path,seed,selected,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('pg-cand-d50', pid, fSegB, 0, '/pg-cand-d50.mp4', 17, 1, 1, 1);
    const fSegABefore = { ...db.prepare('SELECT * FROM shots WHERE id = ?').get(fSegA) };
    const fSegBBefore = { ...db.prepare('SELECT * FROM shots WHERE id = ?').get(fSegB) };
    const fCandBefore = { ...db.prepare('SELECT * FROM shot_videos WHERE id = ?').get('pg-cand-d50') };
    let crossErr = null;
    try {
      projectSceneUnits({ projectId: pid, chapterId: cid, sceneUid: s5, units: [{ shot_ids: [f1.id, f2.id] }] });
    } catch (e) { crossErr = e; }
    const fSegAAfter = { ...db.prepare('SELECT * FROM shots WHERE id = ?').get(fSegA) };
    const fSegBAfter = { ...db.prepare('SELECT * FROM shots WHERE id = ?').get(fSegB) };
    const fCandAfter = { ...db.prepare('SELECT * FROM shot_videos WHERE id = ?').get('pg-cand-d50') };
    record('PGPROJ-11', '合并 A+B、候选只在 B（非 base）⇒ 拒绝（segment_absorbed），两段/候选均不变',
      crossErr && crossErr.code === 'UNIT_SEGMENT_CANDIDATE_CONFLICT'
      && crossErr.detail?.reason === 'segment_absorbed'
      && crossErr.detail?.segment_id === fSegB
      && JSON.stringify(fSegABefore) === JSON.stringify(fSegAAfter)
      && JSON.stringify(fSegBBefore) === JSON.stringify(fSegBAfter)
      && JSON.stringify(fCandBefore) === JSON.stringify(fCandAfter)
      && segIdOf(f1.id) === fSegA && segIdOf(f2.id) === fSegB,
      `code=${crossErr && crossErr.code} reason=${crossErr && crossErr.detail && crossErr.detail.reason}`
      + ` segB=${fSegB} allSame=${JSON.stringify(fSegABefore) === JSON.stringify(fSegAAfter)
        && JSON.stringify(fSegBBefore) === JSON.stringify(fSegBAfter)
        && JSON.stringify(fCandBefore) === JSON.stringify(fCandAfter)}`);

    // 12：显式新段 id 把候选段的唯一归属镜迁走 ⇒ 拒绝，且不得建出新段
    const s6 = 'pg-d50-s6';
    const g1 = insertStoryShot({
      project_id: pid, chapter_id: cid, scene_key: 'S06', scene_uid: s6,
      shot_no: 12, global_no: 12, visual_content: 'G1', story_duration: 4,
    });
    const rg = projectSceneUnits({ projectId: pid, chapterId: cid, sceneUid: s6 });
    const gSeg = rg.units[0].segment_id;
    db.prepare('INSERT INTO shot_videos (id,project_id,shot_id,idx,video_path,seed,selected,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('pg-cand-d50b', pid, gSeg, 0, '/pg-cand-d50b.mp4', 19, 1, 1, 1);
    const g2 = insertStoryShot({
      project_id: pid, chapter_id: cid, scene_key: 'S06', scene_uid: s6,
      shot_no: 13, global_no: 13, visual_content: 'G2', story_duration: 3,
    });
    let bypassErr = null;
    try {
      projectSceneUnits({
        projectId: pid, chapterId: cid, sceneUid: s6,
        units: [{ segment_id: 'seg_pg_d50_new', shot_ids: [g1.id, g2.id] }],
      });
    } catch (e) { bypassErr = e; }
    const newRow = db.prepare('SELECT id FROM shots WHERE id = ?').get('seg_pg_d50_new');
    record('PGPROJ-12', '换段 id 不能把候选变孤儿：显式新 id ⇒ 拒绝（segment_absorbed），未建新段',
      bypassErr && bypassErr.code === 'UNIT_SEGMENT_CANDIDATE_CONFLICT'
      && bypassErr.detail?.reason === 'segment_absorbed'
      && bypassErr.detail?.segment_id === gSeg
      && !newRow && segIdOf(g1.id) === gSeg,
      `code=${bypassErr && bypassErr.code} reason=${bypassErr && bypassErr.detail && bypassErr.detail.reason}`
      + ` newSeg=${newRow ? newRow.id : '(none)'} g1='${segIdOf(g1.id)}' expect='${gSeg}'`);
  } finally {
    try { Projects.remove(pid); } catch (e) { log('[清理] 删除测试项目失败（不影响判定）：' + (e && e.message)); }
  }

  finish(meta);
}

function finish(meta) {
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  log('');
  log(`PROJ-PG-RESULT ${JSON.stringify({
    server_version: meta.version, database: meta.database, backend_pid: meta.backendPid,
    total: results.length, pass, fail, ok: fail === 0,
    cases: results.map((r) => ({ id: r.id, ok: r.ok, detail: r.detail })),
  })}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  log('脚本异常：' + (e && e.message ? e.message : String(e)));
  if (e && e.stack) log(e.stack.split('\n').slice(0, 6).join('\n'));
  log(`PROJ-PG-RESULT ${JSON.stringify({ ok: false, error: String(e && e.message || e), cases: results })}`);
  process.exit(1);
});
