// P10-A · 阶段 A 第一批（A-01~A-03）+ 第二批（A-04）
//
// A-01/A-02/A-03 测"空库迁移出来的结构就是冻结结构"；A-04 测"manifest 登记了这三处变化，
// 且生成器产出与仓库内文件逐字节一致"。全部在临时库里跑，绕开单例与真实库。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initSchema } from '../lib/core/db.js';
import {
  STAGE_A_COLUMNS, STAGE_A_INDEXES, STAGE_A_DDL_TEXT, initStageA, stageAStatus, stageADdlStatements,
} from '../lib/core/schema/stage-a.js';
import { buildManifest } from '../scripts/schema/gen-manifest.mjs';
import { verify } from '../scripts/schema/verify-manifest.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-stage-a-test-'));

function makeDb(name = 'fresh') {
  const dir = path.join(TMP, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'ic.db');
  const raw = new DatabaseSync(file);
  return {
    exec: (s) => raw.exec(s),
    prepare: (s) => raw.prepare(s),
    tableColumns: (t) => raw.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name),
    dialect: 'sqlite',
    raw,
    file,
  };
}

const fresh = makeDb('fresh');
initSchema(fresh);

const colInfo = (db, table, col) => db.prepare(`PRAGMA table_info(${table})`).all().find((c) => c.name === col);

test('A-01 story_shots 增加 segment_id / scene_uid 两列，默认空串（存量行不需要回填）', () => {
  for (const col of ['segment_id', 'scene_uid']) {
    const c = colInfo(fresh, 'story_shots', col);
    assert.ok(c, `缺列 ${col}`);
    assert.equal(String(c.dflt_value), "''");
    assert.equal(c.notnull, 0, `${col} 必须可空/有默认，不得 NOT NULL（存量 0 行也要能升级）`);
  }
  // 原有列一个都没少
  const cols = fresh.tableColumns('story_shots');
  for (const c of ['id', 'project_id', 'chapter_id', 'scene_key', 'shot_no', 'global_no', 'updated_at']) {
    assert.ok(cols.includes(c), `原有列丢失：${c}`);
  }
  assert.equal(cols.length, 50, 'D01-05 的 48 列 + 阶段 A 的 2 列');
});

test('A-01/A-02 两条新索引存在且指向正确的列', () => {
  const sqlOf = (name) => fresh.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').get('index', name);
  assert.ok(sqlOf('idx_ss_segment'), '缺 idx_ss_segment');
  assert.ok(sqlOf('idx_ss_scene_uid'), '缺 idx_ss_scene_uid');
  assert.match(sqlOf('idx_ss_segment').sql, /story_shots\s*\(\s*project_id\s*,\s*segment_id\s*\)/i);
  assert.match(sqlOf('idx_ss_scene_uid').sql, /story_shots\s*\(\s*project_id\s*,\s*scene_uid\s*\)/i);
});

test('A-02 continuity_runs 8 列，场次列是 scene_uid（不是 scene_key）', () => {
  assert.deepEqual(fresh.tableColumns('continuity_runs'),
    ['id', 'project_id', 'scene_uid', 'run_no', 'input_hash', 'status', 'error_code', 'created_at']);
  assert.equal(fresh.tableColumns('continuity_runs').includes('scene_key'), false,
    'D-30-03 之后不得再有 scene_key：否则代码按 uid 查、规范按 key 查');
  const info = fresh.prepare('PRAGMA table_info(continuity_runs)').all();
  const byName = Object.fromEntries(info.map((c) => [c.name, c]));
  // id 是 TEXT PRIMARY KEY：SQLite 的 PK 隐含非空，但 PRAGMA 的 notnull 标志为 0，
  // 所以只在这里断言它是主键，其余 5 列按 NOT NULL 断言。
  assert.equal(byName.id.pk, 1, 'id 必须是主键');
  for (const c of ['project_id', 'scene_uid', 'run_no', 'input_hash', 'status']) {
    assert.equal(byName[c].notnull, 1, `${c} 必须 NOT NULL`);
  }
  assert.equal(byName.error_code.notnull, 0);
});

test('A-02 continuity_runs 的两条索引：唯一约束 + run_no DESC 取最新', () => {
  const uq = fresh.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='uq_cr_run'").get();
  assert.ok(uq, '缺 uq_cr_run');
  assert.match(uq.sql, /UNIQUE INDEX.*continuity_runs\s*\(\s*project_id\s*,\s*scene_uid\s*,\s*run_no\s*\)/i);
  const latest = fresh.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_cr_latest'").get();
  assert.ok(latest, '缺 idx_cr_latest');
  assert.match(latest.sql, /run_no\s+DESC/i);
});

test('A-02 唯一约束真的生效：同 (project, scene_uid, run_no) 第二行被数据库拒绝', () => {
  fresh.exec("INSERT INTO continuity_runs (id,project_id,scene_uid,run_no,input_hash,status) VALUES ('cr1','p1','sc1',1,'sha256:a','ok')");
  assert.throws(
    () => fresh.exec("INSERT INTO continuity_runs (id,project_id,scene_uid,run_no,input_hash,status) VALUES ('cr2','p1','sc1',1,'sha256:b','failed')"),
    /UNIQUE|PRIMARY/i,
  );
  // 不同场次/不同轮次不受影响
  fresh.exec("INSERT INTO continuity_runs (id,project_id,scene_uid,run_no,input_hash,status) VALUES ('cr3','p1','sc1',2,'sha256:b','failed')");
  fresh.exec("INSERT INTO continuity_runs (id,project_id,scene_uid,run_no,input_hash,status) VALUES ('cr4','p1','sc2',1,'sha256:c','ok')");
  assert.equal(fresh.prepare('SELECT COUNT(*) AS c FROM continuity_runs').get().c, 3);
});

test('A-03 shot_videos 增加 input_hash，默认空串（历史候选行 = 来源未知）', () => {
  const c = colInfo(fresh, 'shot_videos', 'input_hash');
  assert.ok(c, '缺 input_hash');
  assert.equal(String(c.dflt_value), "''");
  assert.deepEqual(fresh.tableColumns('shot_videos'),
    ['id', 'project_id', 'shot_id', 'idx', 'video_path', 'seed', 'selected', 'created_at', 'updated_at', 'input_hash']);
});

test('A-01~A-03 幂等：再跑 initStageA 不补列、不报错、结构不变', () => {
  const before = {
    ss: fresh.tableColumns('story_shots').join(','),
    sv: fresh.tableColumns('shot_videos').join(','),
    cr: fresh.tableColumns('continuity_runs').join(','),
  };
  const r = initStageA(fresh);
  assert.deepEqual(r.columnsAdded, []);
  assert.deepEqual(fresh.tableColumns('story_shots').join(','), before.ss);
  assert.deepEqual(fresh.tableColumns('shot_videos').join(','), before.sv);
  assert.deepEqual(fresh.tableColumns('continuity_runs').join(','), before.cr);
  assert.deepEqual(stageAStatus(fresh), { missingColumns: [], missingIndexes: [], ok: true });
});

test('A-01~A-03 结构巡检能识别缺失（不吞异常、不伪装齐了）', () => {
  const db = makeDb('partial');
  // 只建连续性表（模拟"表建了、列还没补"的半成品），不建 story_shots / shot_videos
  for (const sql of stageADdlStatements()) db.exec(sql);
  const st = stageAStatus(db);
  assert.equal(st.ok, false);
  assert.ok(st.missingColumns.includes('story_shots.segment_id'));
  assert.ok(st.missingColumns.includes('shot_videos.input_hash'));
  // 补列时若表不存在必须抛，不得"顺手建一张"
  assert.throws(() => initStageA(db), (e) => /不存在或不可读/.test(e.message));
});

test('A-04 manifest：三处变化全部登记，条目 25 / stage_a 1 / existing 3', () => {
  const m = buildManifest();
  assert.equal(m.counts.groups_total, 21);
  assert.equal(m.counts.stage_a, 1);
  assert.equal(m.counts.existing, 3);
  assert.equal(m.counts.entries_total, 25);
  assert.deepEqual(m.groups.stage_a.continuity_runs.expected_columns,
    ['id', 'project_id', 'scene_uid', 'run_no', 'input_hash', 'status', 'error_code', 'created_at']);
  assert.ok(m.groups.biz.story_shots.expected_columns.includes('segment_id'));
  assert.ok(m.groups.biz.story_shots.expected_columns.includes('scene_uid'));
  assert.deepEqual(m.existing.shot_videos.expected_columns,
    ['id', 'project_id', 'shot_id', 'idx', 'video_path', 'seed', 'selected', 'created_at', 'updated_at', 'input_hash']);
  assert.deepEqual(Object.keys(m.pending), []);
});

test('A-04 生成器不读数据库：改 IC_DB_SQLITE_PATH 不影响产出', () => {
  const before = JSON.stringify(buildManifest());
  const old = process.env.IC_DB_SQLITE_PATH;
  process.env.IC_DB_SQLITE_PATH = path.join(TMP, 'no-such', 'x.db');
  try { assert.equal(JSON.stringify(buildManifest()), before); } finally {
    if (old === undefined) delete process.env.IC_DB_SQLITE_PATH; else process.env.IC_DB_SQLITE_PATH = old;
  }
});

test('A-04 仓库内 manifest 与生成器逐字节一致（P4 的"重新生成"而不是手改）', () => {
  const onDisk = fs.readFileSync(new URL('../lib/core/schema-manifest.json', import.meta.url), 'utf8');
  assert.equal(onDisk, JSON.stringify(buildManifest(), null, 2) + '\n');
});

test('A-04 verify-manifest（profile=fresh）25/25 通过', () => {
  const r = verify(fresh.file, 'fresh');
  assert.equal(r.ok, true, JSON.stringify(r.failed));
  assert.equal(r.entries, 25);
  assert.equal(r.fail, 0);
  assert.equal(r.groupsAssert.stage_a, 1);
});

test('A-04 verify 能抓到"加了列但没登记"（fresh 不允许任何 extra）', () => {
  const db = makeDb('extra');
  initSchema(db);
  db.exec("ALTER TABLE shot_videos ADD COLUMN sneaky TEXT DEFAULT ''");
  const r = verify(db.file, 'fresh');
  assert.equal(r.ok, false);
  const f = r.failed.find((x) => x.table === 'shot_videos');
  assert.deepEqual(f.unknownExtra, ['sneaky']);
});

test('A-02b DDL 文本本身是冻结口径：8 个列名、2 条索引，逐字可核对', () => {
  const text = STAGE_A_DDL_TEXT + '\n' + STAGE_A_INDEXES.join(';\n');
  for (const col of ['id', 'project_id', 'scene_uid', 'run_no', 'input_hash', 'status', 'error_code', 'created_at']) {
    assert.ok(text.includes(col), `DDL 缺列 ${col}`);
  }
  for (const idx of ['uq_cr_run', 'idx_cr_latest', 'idx_ss_segment', 'idx_ss_scene_uid']) {
    assert.ok(text.includes(idx), `DDL 缺索引 ${idx}`);
  }
  assert.equal(text.includes('scene_key'), false, 'DDL 里不得再出现 scene_key');
  assert.equal(stageADdlStatements().length, 3, 'continuity_runs 建表 + 2 条索引');
  assert.equal(STAGE_A_COLUMNS.length, 3);
});
