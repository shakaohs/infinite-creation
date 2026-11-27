// 阶段 3 · P3：镜号分配与两阶段重排（D02-06 V7 §4.4.1；N-T1~N-T12）
//
// 这一组只测"号"：`shot_no`（章内 1..n）与 `global_no`（项目内唯一、随权威序严格递增、允许不连续）。
// 三个容易假通过的点，都单独钉住：
//   ① 纯追加必须**没有调用** `renumberTwoPhase`（N-T3 用调用计数，结果正确 ≠ 路径正确）
//   ② 两阶段中途失败必须**整体回滚**且**不留负号**（N-T5 / N-T11 用故障注入）
//   ③ `assertGlobalOrder` 必须能在**没有唯一索引**时也发现问题（N-T6 先证明索引拦得住，再拆掉索引证明自检拦得住）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// P0 隔离：先钉住数据目录，再导入任何 lib（config.js 在模块加载时就把路径固化了）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-p3-no-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;
delete process.env.IC_DB;
delete process.env.DATABASE_URL;

const { getDb, Chapters } = await import('../lib/core/db.js');
const { createUserProject } = await import('../lib/core/project-create.js');
const no = await import('../lib/core/render/global-no.js');

const db = getDb();
const {
  appendStoryShots, applyTargetOrder, insertStoryShot, assertGlobalOrder,
  listAuthoritativeShots, renumberCallCount, resetRenumberCallCount, isPureAppend,
} = no;

// ── 工具 ────────────────────────────────────────────────────────────────
let seq = 0;
/** 建项目（自带「第1章」）+ 若干附加章，返回 { p, chapters: [ch1, ch2, ...] } */
function newProject(chapterCount = 1) {
  seq += 1;
  const p = createUserProject({ name: `P3-镜号-${seq}` });
  const chapters = Chapters.list(p.id);
  for (let i = chapters.length; i < chapterCount; i += 1) chapters.push(Chapters.create(p.id, { title: `第${i + 1}章` }));
  return { p, chapters };
}

/** 按顺序给某章种 n 镜（走纯追加；调用方负责"这章是最后一章"） */
function seedChapter(projectId, chapterId, count, offset = 0) {
  const shots = Array.from({ length: count }, (_, i) => ({
    shot_no: offset + i + 1,
    scene_key: 'S01_房',
    visual_content: `镜${offset + i + 1}`,
  }));
  return appendStoryShots({ projectId, chapterId, shots });
}

const rows = (pid) => db.prepare('SELECT * FROM story_shots WHERE project_id = ? ORDER BY global_no ASC').all(pid);
const snapshot = (pid) => rows(pid).map((r) => ({ id: r.id, shot_no: r.shot_no, global_no: r.global_no }));
const negativeCount = (pid) => db.prepare('SELECT COUNT(*) AS n FROM story_shots WHERE project_id = ? AND (shot_no < 1 OR global_no < 1)').get(pid).n;
const idOfContent = (pid, text) => rows(pid).find((r) => r.visual_content === text)?.id;

// ── N-T1 跨章中间插入 ───────────────────────────────────────────────────
test('N-T1 跨章中间插入：ch1 第 2 位插 1 镜，全局顺序仍严格递增，ch2 号不漂移', () => {
  // 章要"边建边种"：第 2 章一旦存在，ch1 就不再是末章（纯追加前提）
  const { p, chapters } = newProject(1);
  const ch1 = chapters[0];
  seedChapter(p.id, ch1.id, 3);
  const ch2 = Chapters.create(p.id, { title: '第2章' });
  seedChapter(p.id, ch2.id, 2);
  const before = rows(p.id);
  const ch2Before = before.filter((r) => r.chapter_id === ch2.id).map((r) => r.shot_no);

  // 插入镜先落在"物理末尾"（shot_no=4 / global_no=MAX+1），再由目标序把它挪到第 2 位
  const inserted = insertStoryShot({
    project_id: p.id, chapter_id: ch1.id, scene_key: 'S01_房',
    shot_no: 4, global_no: 6, visual_content: '插进来的镜',
  });
  applyTargetOrder(p.id, [before[0].id, inserted.id, before[1].id, before[2].id, before[3].id, before[4].id]);

  assertGlobalOrder(p.id);
  const ch1Rows = rows(p.id).filter((r) => r.chapter_id === ch1.id);
  assert.deepEqual(ch1Rows.map((r) => r.shot_no), [1, 2, 3, 4], 'ch1 章内必须 1..n 连续');
  assert.deepEqual(ch1Rows.map((r) => r.visual_content), ['镜1', '插进来的镜', '镜2', '镜3'], '内容跟着 id 走，按目标序排列');
  // ① ch1 按 shot_no 排列时 global_no 严格递增
  for (let i = 1; i < ch1Rows.length; i += 1) assert.ok(ch1Rows[i].global_no > ch1Rows[i - 1].global_no);
  // ② ch2 全部镜的 global_no 大于 ch1 末镜
  const ch2Rows = rows(p.id).filter((r) => r.chapter_id === ch2.id);
  assert.ok(Math.min(...ch2Rows.map((r) => r.global_no)) > ch1Rows[ch1Rows.length - 1].global_no);
  // ③ ch2 的 shot_no 不变；④ 相对次序保持
  assert.deepEqual(ch2Rows.map((r) => r.shot_no), ch2Before);
  assert.deepEqual(ch2Rows.map((r) => r.visual_content), ['镜1', '镜2']);
});

// ── N-T2 章内重排 ───────────────────────────────────────────────────────
test('N-T2 章内重排：把第 3 镜提到第 1 位，shot_no 重排为 1..n，三个 id 一个都没变', () => {
  const { p, chapters } = newProject(1);
  seedChapter(p.id, chapters[0].id, 3);
  const before = rows(p.id);
  const idsBefore = before.map((r) => r.id).sort();

  applyTargetOrder(p.id, [before[2].id, before[0].id, before[1].id]);

  assertGlobalOrder(p.id);
  const after = rows(p.id);
  assert.deepEqual(after.map((r) => r.id).sort(), idsBefore, '重编不得改变镜的 id');
  assert.deepEqual(after.map((r) => r.shot_no), [1, 2, 3]);
  assert.deepEqual(after.map((r) => r.visual_content), ['镜3', '镜1', '镜2']);
  for (let i = 1; i < after.length; i += 1) assert.ok(after[i].global_no > after[i - 1].global_no);
});

// ── N-T3 末章批量追加 10 镜（纯追加，不得触发两阶段）────────────────────
test('N-T3 末章批量追加 10 镜：走纯追加，未调用 renumberTwoPhase', () => {
  const { p, chapters } = newProject(1);
  seedChapter(p.id, chapters[0].id, 5);
  const maxBefore = Math.max(...rows(p.id).map((r) => r.global_no));

  resetRenumberCallCount();
  const r = seedChapter(p.id, chapters[0].id, 10, 5); // shot_no 6..15
  assert.equal(r.created, 10);
  assert.equal(renumberCallCount(), 0, '纯追加路径不得调用 renumberTwoPhase（结果对不代表路径对）');
  assert.equal(isPureAppend(p.id, chapters[0].id, [16]).pure, true, '仍应判定为可纯追加');

  assertGlobalOrder(p.id);
  const after = rows(p.id);
  assert.deepEqual(after.map((r) => r.global_no), Array.from({ length: 15 }, (_, i) => i + 1), 'global_no 连续无重复');
  assert.ok(Math.max(...after.map((r) => r.global_no)) > maxBefore);
});

// ── N-T4 同一请求重放两次 ───────────────────────────────────────────────
test('N-T4 同一目标序重放两次：镜数与编号不漂移，第二次是恒等操作', () => {
  const { p, chapters } = newProject(1);
  seedChapter(p.id, chapters[0].id, 4);
  const before = rows(p.id);
  const target = [before[2].id, before[0].id, before[3].id, before[1].id];

  const first = applyTargetOrder(p.id, target);
  assert.equal(first.changed, true);
  const afterFirst = snapshot(p.id);

  resetRenumberCallCount();
  const second = applyTargetOrder(p.id, target);
  assert.equal(second.changed, false, '第二次应为恒等操作');
  assert.equal(renumberCallCount(), 0, '恒等操作不得重编');
  assert.deepEqual(snapshot(p.id), afterFirst, '编号不得漂移');
  assert.equal(rows(p.id).length, 4, '镜数不变');
});

// ── N-T5 global_no 两阶段中途异常 ───────────────────────────────────────
test('N-T5 global_no 两阶段中途抛错：整体回滚（含 shot_no），库里没有任何负值', () => {
  const { p, chapters } = newProject(1);
  seedChapter(p.id, chapters[0].id, 4);
  const before = snapshot(p.id);
  const ids = rows(p.id).map((r) => r.id);

  assert.throws(
    () => applyTargetOrder(p.id, [ids[3], ids[2], ids[1], ids[0]], {
      onPhase: (phase, field) => { if (field === 'global_no' && phase === 1) throw new Error('模拟：负值已写、正值未写时崩了'); },
    }),
    /模拟/,
  );

  assert.deepEqual(snapshot(p.id), before, '两个字段都必须回滚到原值');
  assert.equal(negativeCount(p.id), 0, '不得留下负编号');
  assertGlobalOrder(p.id);
});

// ── N-T6 手工制造重复 global_no ─────────────────────────────────────────
test('N-T6 重复 global_no：唯一索引拦得住；拆掉索引后 assertGlobalOrder 也能发现', () => {
  const { p, chapters } = newProject(1);
  seedChapter(p.id, chapters[0].id, 3);
  const before = snapshot(p.id);
  const [a, b] = rows(p.id);

  // ① 索引本身拦得住
  assert.throws(() => db.prepare('UPDATE story_shots SET global_no = ? WHERE id = ?').run(a.global_no, b.id), /UNIQUE|constraint/i);

  // ② 拆掉索引后，自检仍然必须发现（N-7：不能只靠唯一索引）
  db.exec('DROP INDEX uq_ss_gn');
  try {
    db.prepare('UPDATE story_shots SET global_no = ? WHERE id = ?').run(a.global_no, b.id);
    assert.throws(() => assertGlobalOrder(p.id), (e) => e.code === 'GLOBAL_ORDER_BROKEN');
  } finally {
    for (const s of before) db.prepare('UPDATE story_shots SET global_no = ? WHERE id = ?').run(s.global_no, s.id);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_ss_gn ON story_shots(project_id, global_no)');
  }
  assertGlobalOrder(p.id);
});

// ── N-T7 章内中间插入 ───────────────────────────────────────────────────
test('N-T7 章内中间插入：shot_no 恰为 1..n，两阶段全程未撞 uq_ss_sn', () => {
  const { p, chapters } = newProject(1);
  seedChapter(p.id, chapters[0].id, 3);
  const before = rows(p.id);
  const inserted = insertStoryShot({
    project_id: p.id, chapter_id: chapters[0].id, scene_key: 'S01_房',
    shot_no: 4, global_no: 4, visual_content: '中间插的',
  });
  // 没有抛 UNIQUE 即证明"先负值腾空、再写正值"有效（直接写 2 会撞上 s2 的 2）
  applyTargetOrder(p.id, [before[0].id, inserted.id, before[1].id, before[2].id]);
  assertGlobalOrder(p.id);
  assert.deepEqual(rows(p.id).map((r) => r.shot_no), [1, 2, 3, 4]);
  assert.deepEqual(rows(p.id).map((r) => r.visual_content), ['镜1', '中间插的', '镜2', '镜3']);
});

// ── N-T8 章内两镜调换 ───────────────────────────────────────────────────
test('N-T8 章内两镜调换：两个 id 的编号互换，内容跟着 id 走', () => {
  const { p, chapters } = newProject(1);
  seedChapter(p.id, chapters[0].id, 3);
  const before = rows(p.id);
  const [s1, s2] = before;

  applyTargetOrder(p.id, [s2.id, s1.id, before[2].id]);

  const after = rows(p.id);
  assert.equal(after[0].id, s2.id);
  assert.equal(after[1].id, s1.id);
  assert.equal(after.find((r) => r.id === s2.id).shot_no, 1, '编号跟着位置走');
  assert.equal(after.find((r) => r.id === s1.id).shot_no, 2);
  assert.equal(after.find((r) => r.id === s2.id).visual_content, '镜2', '内容跟着 id 走，不是内容互换');
  assert.equal(after.find((r) => r.id === s1.id).visual_content, '镜1');
});

// ── N-T9 删除中间镜头 ───────────────────────────────────────────────────
test('N-T9 删除中间一镜后重编：后续 shot_no 补齐为 1..n，global_no 仍严格递增', () => {
  const { p, chapters } = newProject(1);
  seedChapter(p.id, chapters[0].id, 4);
  const all = rows(p.id);
  const victim = all[1];
  db.prepare('DELETE FROM shot_assets WHERE shot_id = ?').run(victim.id);
  db.prepare('DELETE FROM story_shots WHERE id = ?').run(victim.id);

  applyTargetOrder(p.id, [all[0].id, all[2].id, all[3].id]);

  assertGlobalOrder(p.id);
  assert.deepEqual(rows(p.id).map((r) => r.shot_no), [1, 2, 3], '补位后仍 1..n');
  assert.deepEqual(rows(p.id).map((r) => r.visual_content), ['镜1', '镜3', '镜4']);
});

// ── N-T10 整章倒序 ─────────────────────────────────────────────────────
test('N-T10 整章倒序提交：目标序成立，id 集合不变', () => {
  const { p, chapters } = newProject(1);
  seedChapter(p.id, chapters[0].id, 3);
  const before = rows(p.id);
  const idsBefore = before.map((r) => r.id).sort();

  applyTargetOrder(p.id, [before[2].id, before[1].id, before[0].id]);

  assertGlobalOrder(p.id);
  const after = rows(p.id);
  assert.deepEqual(after.map((r) => r.id).sort(), idsBefore);
  assert.deepEqual(after.map((r) => r.visual_content), ['镜3', '镜2', '镜1']);
  assert.deepEqual(after.map((r) => r.shot_no), [1, 2, 3]);
});

// ── N-T11 shot_no 两阶段中途异常 ───────────────────────────────────────
test('N-T11 shot_no 两阶段中途抛错：回滚到原值，无负值', () => {
  const { p, chapters } = newProject(1);
  seedChapter(p.id, chapters[0].id, 3);
  const before = snapshot(p.id);
  const ids = rows(p.id).map((r) => r.id);

  assert.throws(
    () => applyTargetOrder(p.id, [ids[1], ids[0], ids[2]], {
      onPhase: (phase, field) => { if (field === 'shot_no' && phase === 1) throw new Error('模拟：shot_no 负值阶段后崩了'); },
    }),
    /模拟/,
  );

  assert.deepEqual(snapshot(p.id), before);
  assert.equal(negativeCount(p.id), 0);
  assertGlobalOrder(p.id);
});

// ── N-T12 并发双写同一章 ───────────────────────────────────────────────
test('N-T12 并发双写同一章：一方失败并回滚，最终编号仍然合法', () => {
  const { p, chapters } = newProject(1);
  seedChapter(p.id, chapters[0].id, 2);
  const before = rows(p.id);

  const childFile = path.join(TMP, 'concurrent-writer.mjs');
  const globalNoUrl = pathToFileURL(path.resolve('lib/core/render/global-no.js')).href;
  const dbUrl = pathToFileURL(path.resolve('lib/core/db.js')).href;
  fs.writeFileSync(childFile, [
    `const { getDb } = await import(${JSON.stringify(dbUrl)});`,
    `const { appendStoryShots } = await import(${JSON.stringify(globalNoUrl)});`,
    'const [projectId, chapterId] = process.argv.slice(2);',
    'getDb();',
    'try {',
    // 纯追加：真的 INSERT，因此必须先拿到写锁（持锁期间只能 BUSY）
    "  appendStoryShots({ projectId, chapterId, shots: [{ shot_no: 3, scene_key: 'S01_房', visual_content: '子进程追加' }] });",
    "  console.log('CHILD OK');",
    '} catch (e) {',
    "  console.log('CHILD FAIL ' + (e.code || e.message));",
    '}',
    '',
  ].join('\n'));

  // 父进程先在事务里持写锁（WAL 下同一时刻只有一个写者），子进程此刻写入只能 BUSY → 失败并回滚
  const childEnv = { ...process.env, IC_DATA_DIR: TMP };
  delete childEnv.NODE_TEST_CONTEXT; // 子进程是普通进程，不该被测试守卫拒（它要真的写库）
  let childOut = '';
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE story_shots SET visual_content = ? WHERE id = ?').run('父进程持锁期间改的', before[0].id);
    const r = spawnSync(process.execPath, [childFile, p.id, chapters[0].id], { env: childEnv, encoding: 'utf8', timeout: 30000 });
    childOut = String(r.stdout || '') + String(r.stderr || '');
  } finally {
    db.exec('COMMIT');
  }

  assert.match(childOut, /CHILD FAIL/, '持锁期间的另一写者必须失败：' + childOut.slice(0, 300));
  assert.ok(!/CHILD OK/.test(childOut), '不得出现"两个都写成功"');
  assert.equal(rows(p.id).length, 2, '失败方不得留下任何行');
  assertGlobalOrder(p.id);
  const after = rows(p.id);
  assert.deepEqual(after.map((r) => r.shot_no), [1, 2]);
  for (let i = 1; i < after.length; i += 1) assert.ok(after[i].global_no > after[i - 1].global_no);
});

// ── 章级提交限制（§4.4.1.4）────────────────────────────────────────────
test('N-EXT1 中间插入但未提交本章全部镜 → CHAPTER_SUBMIT_INCOMPLETE（章级四要素，0 写入）', () => {
  const { p, chapters } = newProject(1);
  seedChapter(p.id, chapters[0].id, 3);
  const before = snapshot(p.id);
  let err = null;
  try {
    no.assertChapterSubmitComplete({
      projectId: p.id, chapterId: chapters[0].id,
      submitted: [{ shot_no: 1 }, { shot_no: 2 }, { shot_no: 4 }], // 缺 3，且在 4 处插入
    });
  } catch (e) { err = e; }
  assert.ok(err, '必须拒绝');
  assert.equal(err.code, 'CHAPTER_SUBMIT_INCOMPLETE');
  assert.equal(err.level, 'fail');
  assert.equal(err.scope, 'chapter');
  assert.deepEqual(err.detail.missing_shots, [3]);
  assert.equal(err.detail.field, 'shots[]');
  assert.deepEqual(snapshot(p.id), before, '拒绝时不得写任何东西');
});

test('N-EXT2 重复 shot_no → SHOT_NO_DUPLICATED（章级）', () => {
  const { p, chapters } = newProject(1);
  seedChapter(p.id, chapters[0].id, 2);
  assert.throws(
    () => no.assertChapterSubmitComplete({ projectId: p.id, chapterId: chapters[0].id, submitted: [{ shot_no: 1 }, { shot_no: 1 }] }),
    (e) => e.code === 'SHOT_NO_DUPLICATED' && e.scope === 'chapter',
  );
});

test('N-EXT3 整章提交 / 尾部追加 / 就地更新 三种形态都放行', () => {
  const { p, chapters } = newProject(1);
  seedChapter(p.id, chapters[0].id, 2);
  const ch = chapters[0].id;
  assert.equal(no.assertChapterSubmitComplete({ projectId: p.id, chapterId: ch, submitted: [{ shot_no: 1 }, { shot_no: 2 }] }).mode, 'in_place');
  assert.equal(no.assertChapterSubmitComplete({ projectId: p.id, chapterId: ch, submitted: [{ shot_no: 1 }, { shot_no: 2 }, { shot_no: 3 }] }).mode, 'append');
  // 调换：带 id 且未提交全部 → 拒绝；提交全部 → 放行
  const all = rows(p.id);
  assert.throws(
    () => no.assertChapterSubmitComplete({ projectId: p.id, chapterId: ch, submitted: [{ id: all[0].id, shot_no: 2 }] }),
    (e) => e.code === 'CHAPTER_SUBMIT_INCOMPLETE',
  );
  assert.equal(
    no.assertChapterSubmitComplete({
      projectId: p.id, chapterId: ch,
      submitted: [{ id: all[0].id, shot_no: 2 }, { id: all[1].id, shot_no: 1 }],
    }).mode,
    'full',
  );
});

test('N-EXT4 目标序不是项目全集的置换 → TARGET_ORDER_INVALID（不改库）', () => {
  const { p, chapters } = newProject(1);
  seedChapter(p.id, chapters[0].id, 2);
  const before = snapshot(p.id);
  const ids = rows(p.id).map((r) => r.id);
  assert.throws(() => applyTargetOrder(p.id, [ids[0]]), (e) => e.code === 'TARGET_ORDER_INVALID');
  assert.throws(() => applyTargetOrder(p.id, [ids[0], ids[0]]), (e) => e.code === 'TARGET_ORDER_INVALID');
  assert.deepEqual(snapshot(p.id), before);
});

test('N-EXT5 章节 seq 改变 → 把新权威序原样传入也必须重编 global_no（B 排到 A 前）', () => {
  const { p, chapters } = newProject(1);
  const A = chapters[0];
  seedChapter(p.id, A.id, 1);
  const B = Chapters.create(p.id, { title: '第2章' });
  seedChapter(p.id, B.id, 1);

  const before = rows(p.id); // ORDER BY global_no
  const shotA = before.find((r) => r.chapter_id === A.id);
  const shotB = before.find((r) => r.chapter_id === B.id);
  assert.ok(shotA.global_no < shotB.global_no, '初始全局顺序必须是 A、B');

  // 只改 chapters.seq，不动任何镜：权威序变成 B、A
  db.prepare('UPDATE chapters SET seq = 2 WHERE id = ?').run(A.id);
  db.prepare('UPDATE chapters SET seq = 1 WHERE id = ?').run(B.id);
  const newOrder = listAuthoritativeShots(p.id).map((r) => r.id);
  assert.deepEqual(newOrder, [shotB.id, shotA.id], '权威序应变成 B、A');

  // 这正是审核指出的场景：传入的 orderedIds 与"当前权威序"逐位相同，
  // 旧实现因此判定"没变化"→ 不重编；修复后必须与"既有 global_no 顺序"比较
  const r = applyTargetOrder(p.id, newOrder);
  assert.equal(r.changed, true, '章节顺序变化必须触发重编');
  assert.ok(r.global_no_rows >= 2, 'global_no 必须重编');

  const after = rows(p.id);
  const a2 = after.find((x) => x.id === shotA.id);
  const b2 = after.find((x) => x.id === shotB.id);
  assert.ok(b2.global_no < a2.global_no, 'B 的 global_no 必须小于 A');
  assert.equal(b2.global_no, 1);
  assert.equal(a2.global_no, 2);
  assert.equal(a2.visual_content, shotA.visual_content, '镜头内容不得变化');
  assert.equal(b2.visual_content, shotB.visual_content);
  assert.deepEqual(after.map((x) => x.id).sort(), [shotA.id, shotB.id].sort(), '镜头 ID 不得变化');
  assert.equal(negativeCount(p.id), 0, '不得留下负编号');
  assertGlobalOrder(p.id);

  // 幂等：同一份新顺序再来一次是恒等操作（此时既有号序已经等于目标序）
  assert.equal(applyTargetOrder(p.id, newOrder).changed, false);
});

test('N-EXT6 同 seq 时权威序按 chapter_id 稳定（只读断言，不依赖数据库返回顺序）', () => {
  const { p, chapters } = newProject(1);
  seedChapter(p.id, chapters[0].id, 1);
  const ch2 = Chapters.create(p.id, { title: '第2章' });
  seedChapter(p.id, ch2.id, 1);
  db.prepare('UPDATE chapters SET seq = 1 WHERE project_id = ?').run(p.id);
  const first = listAuthoritativeShots(p.id).map((r) => r.chapter_id);
  const second = listAuthoritativeShots(p.id).map((r) => r.chapter_id);
  assert.deepEqual(first, second, '同一 seq 下顺序必须确定');
  assert.deepEqual(first, [...first].sort(), '同 seq 时按 chapter_id 升序');
});
