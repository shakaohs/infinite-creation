// 阶段 1 新架构表 DDL（21 张 = 3 ops + 1 archive + 14 biz + 3 d02_ext）
//
// 逐字来源（唯一权威，不许在这里"顺手优化"）：
//   biz 14 张        → docs/D01/D01-05-数据库映射与历史数据兼容方案.md §4.1~§4.14
//   ops 3 + archive 1 → docs/D02/D02-01-工程实施总体方案.md §3.5 / §3.6
//   d02_ext 3 张     → docs/D02/D02-03-阶段1前置设计决策记录.md §四 / §五 / §八
//
// 三条硬规则：
//  1. 全部 CREATE TABLE IF NOT EXISTS；索引单独建（SQLite DDL 非事务性，集中建便于识别半成品）
//  2. 不加外键（D01-05 §8 全局约定），引用完整性由应用层 + 巡检保证
//  3. 这里只建结构，不写任何业务数据；阶段 1 不迁移、不解析历史
//
// 校验方式：tests/stage1-schema.test.mjs 会把本文件的列集合与冻结文档解析结果逐项比对，
// 所以"文档写了、代码忘了"或"代码多了、文档没有"都会当场红，不靠人眼看。

/** ops：迁移运维三表（最先建，迁移自身要用） */
export const OPS_DDL = [
  // D02-01 §3.5
  `CREATE TABLE IF NOT EXISTS migration_batches (
  id               TEXT PRIMARY KEY,
  name             TEXT DEFAULT '',
  script_ver       TEXT DEFAULT '',
  status           TEXT DEFAULT 'staged',
  source_counts    TEXT DEFAULT '{}',
  target_counts    TEXT DEFAULT '{}',
  backup_path      TEXT DEFAULT '',
  backup_sha256    TEXT DEFAULT '',
  rollback_preview TEXT DEFAULT '',
  rollback_counts  TEXT DEFAULT '{}',
  note             TEXT DEFAULT '',
  started_at       INTEGER,
  finished_at      INTEGER,
  rolled_back_at   INTEGER
)`,
  // D02-01 §3.5
  `CREATE TABLE IF NOT EXISTS migration_items (
  batch_id              TEXT NOT NULL,
  target_table          TEXT NOT NULL,
  target_pk             TEXT NOT NULL,
  source_table          TEXT DEFAULT '',
  source_pk             TEXT DEFAULT '',
  source_kind           TEXT DEFAULT '',
  migrated_content_hash TEXT DEFAULT '',
  migration_status      TEXT DEFAULT 'staged',
  rollback_status       TEXT DEFAULT 'none',
  rollback_reason       TEXT DEFAULT '',
  protected_at          INTEGER,
  confidence            REAL DEFAULT 1.0,
  reason                TEXT DEFAULT '',
  created_at            INTEGER,
  updated_at            INTEGER,
  PRIMARY KEY (batch_id, target_table, target_pk)
)`,
  // D02-01 §3.5.2
  `CREATE TABLE IF NOT EXISTS migration_edges (
  batch_id     TEXT NOT NULL,
  child_table  TEXT NOT NULL,
  child_pk     TEXT NOT NULL,
  parent_table TEXT NOT NULL,
  parent_pk    TEXT NOT NULL,
  edge_kind    TEXT DEFAULT 'fk',
  created_at   INTEGER,
  PRIMARY KEY (batch_id, child_table, child_pk, parent_table, parent_pk)
)`,
];

/** biz：14 张 D01 业务表（D01-05 冻结 DDL，逐字） */
export const BIZ_DDL = [
  // §4.1
  `CREATE TABLE IF NOT EXISTS scene_states (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  scene_key      TEXT NOT NULL,
  scene_id       TEXT DEFAULT '',
  coord_system   TEXT DEFAULT '{}',
  fixtures       TEXT DEFAULT '[]',
  entries        TEXT DEFAULT '{}',
  axis_lock      TEXT DEFAULT '{}',
  power_geometry TEXT DEFAULT '{}',
  crowd_switch   TEXT DEFAULT '',
  time_of_day    TEXT DEFAULT '',
  state_rev      INTEGER DEFAULT 1,
  created_at     INTEGER,
  updated_at     INTEGER
)`,
  // §4.2
  `CREATE TABLE IF NOT EXISTS story_shots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  scene_key TEXT NOT NULL,
  scene_id TEXT DEFAULT '',
  shot_no INTEGER NOT NULL,
  global_no INTEGER NOT NULL,
  beat_key TEXT DEFAULT '',
  prev_shot_id TEXT DEFAULT '',
  purpose TEXT DEFAULT 'advance',
  dramatic_value INTEGER DEFAULT 0,
  info_delta TEXT DEFAULT '',
  dialogue_function TEXT DEFAULT '',
  is_insert INTEGER DEFAULT 0,
  visual_content TEXT DEFAULT '',
  composition TEXT DEFAULT '',
  lighting TEXT DEFAULT '',
  shot_size TEXT DEFAULT '',
  cam_direction TEXT DEFAULT '',
  cam_height TEXT DEFAULT '',
  cam_roll_deg REAL DEFAULT 0,
  cam_pos TEXT DEFAULT NULL,
  cam_target TEXT DEFAULT '',
  cam_distance_m REAL DEFAULT NULL,
  lens_mm INTEGER DEFAULT 0,
  fov_deg REAL DEFAULT NULL,
  movement TEXT DEFAULT 'static',
  movement_amp TEXT DEFAULT 'none',
  cam_path TEXT DEFAULT '[]',
  composition_rule TEXT DEFAULT '',
  cam_note TEXT DEFAULT '',
  dialogue TEXT DEFAULT '',
  speakers TEXT DEFAULT '[]',
  narration TEXT DEFAULT '',
  sfx TEXT DEFAULT '',
  music_cue TEXT DEFAULT '',
  voice_ids TEXT DEFAULT '[]',
  story_duration REAL DEFAULT 0,
  time_slices TEXT DEFAULT '[]',
  speed_ramp TEXT DEFAULT 'none',
  is_cut_point INTEGER DEFAULT 1,
  time_jump INTEGER DEFAULT 0,
  spec_version INTEGER DEFAULT 2,
  spec_source TEXT DEFAULT 'ai',
  fill_confidence REAL DEFAULT 0,
  qc_status TEXT DEFAULT '',
  created_at INTEGER,
  updated_at INTEGER
)`,
  // §4.3
  `CREATE TABLE IF NOT EXISTS shot_blockings (
  shot_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  position_abs TEXT DEFAULT '',
  norm_x REAL DEFAULT NULL,
  norm_y REAL DEFAULT NULL,
  norm_z REAL DEFAULT NULL,
  norm_confidence REAL DEFAULT 0,
  position_track TEXT DEFAULT '[]',
  anchor_object TEXT DEFAULT '',
  behind_object TEXT DEFAULT '',
  facing TEXT DEFAULT '',
  gaze_target TEXT DEFAULT '',
  posture TEXT DEFAULT '',
  distance_to_camera REAL DEFAULT NULL,
  occlusion TEXT DEFAULT 'none',
  hand_state TEXT DEFAULT '',
  current_task TEXT DEFAULT '',
  in_frame INTEGER DEFAULT 1,
  power_level TEXT DEFAULT '',
  instance_anchor TEXT DEFAULT '',
  PRIMARY KEY (shot_id, character_id)
)`,
  // §4.4
  `CREATE TABLE IF NOT EXISTS shot_actions (
  id TEXT PRIMARY KEY,
  shot_id TEXT NOT NULL,
  actor_id TEXT DEFAULT '',
  action_type TEXT DEFAULT '',
  is_primary INTEGER DEFAULT 0,
  tier TEXT DEFAULT 'T1',
  init_state TEXT DEFAULT '{}',
  trigger_json TEXT DEFAULT '{}',
  path_json TEXT DEFAULT '{}',
  force_json TEXT DEFAULT '{}',
  speed_json TEXT DEFAULT '{}',
  power INTEGER DEFAULT 0,
  cog TEXT DEFAULT '',
  body_parts TEXT DEFAULT '[]',
  contact_json TEXT DEFAULT '{}',
  result_json TEXT DEFAULT '{}',
  follow_through TEXT DEFAULT '',
  recovery TEXT DEFAULT '',
  end_state TEXT DEFAULT '{}',
  sync_json TEXT DEFAULT '{}',
  t_from REAL DEFAULT 0,
  t_to REAL DEFAULT 0
)`,
  // §4.5
  `CREATE TABLE IF NOT EXISTS shot_states (
  shot_id TEXT PRIMARY KEY,
  state_in TEXT DEFAULT '{}',
  state_out TEXT DEFAULT '{}',
  meta TEXT DEFAULT '{}',
  derived_from TEXT DEFAULT '',
  state_source TEXT DEFAULT 'none',
  conflicts TEXT DEFAULT '[]',
  updated_at INTEGER
)`,
  // §4.6（唯一带 CHECK 的表：order_no 边界 + voice ≤3）
  `CREATE TABLE IF NOT EXISTS shot_assets (
  shot_id    TEXT NOT NULL,
  asset_id   TEXT NOT NULL,
  role       TEXT NOT NULL,
  order_no   INTEGER NOT NULL,
  variant_of TEXT DEFAULT '',
  PRIMARY KEY (shot_id, role, asset_id),
  UNIQUE (shot_id, role, order_no),
  CHECK (order_no >= 1),
  CHECK (role <> 'voice' OR order_no BETWEEN 1 AND 3)
)`,
  // §4.14（建在 render_units 之前）
  `CREATE TABLE IF NOT EXISTS render_adaptations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  track TEXT NOT NULL,
  profile_ver TEXT NOT NULL,
  adaptation_version INTEGER NOT NULL,
  profile_max REAL NOT NULL,
  profile_short_floor REAL NOT NULL,
  profile_min_slice REAL NOT NULL,
  profile_tail_hold_max REAL NOT NULL,
  seam_policy TEXT DEFAULT '{}',
  source_spec_hash TEXT DEFAULT '',
  shot_scope_hash TEXT DEFAULT '',
  status TEXT DEFAULT 'active',
  status_reason TEXT DEFAULT '',
  superseded_by TEXT DEFAULT '',
  created_at INTEGER,
  updated_at INTEGER
)`,
  // §4.7
  `CREATE TABLE IF NOT EXISTS render_units (
  id TEXT PRIMARY KEY,
  adaptation_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  chapter_id TEXT DEFAULT '',
  track TEXT NOT NULL,
  profile_ver TEXT DEFAULT '',
  unit_no INTEGER NOT NULL,
  unit_duration REAL DEFAULT 0,
  shot_count INTEGER DEFAULT 0,
  seam TEXT DEFAULT 'auto',
  status TEXT DEFAULT 'draft',
  created_at INTEGER,
  updated_at INTEGER
)`,
  // §4.8
  `CREATE TABLE IF NOT EXISTS render_unit_shots (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL,
  shot_id TEXT NOT NULL,
  order_no INTEGER NOT NULL,
  t_from REAL NOT NULL DEFAULT 0,
  t_to REAL NOT NULL DEFAULT 0,
  split_reason TEXT DEFAULT '',
  created_at INTEGER
)`,
  // §4.9
  `CREATE TABLE IF NOT EXISTS prompt_packages (
  id TEXT PRIMARY KEY,
  project_id TEXT DEFAULT '',
  unit_id TEXT DEFAULT '',
  track TEXT NOT NULL,
  format TEXT DEFAULT '',
  body TEXT DEFAULT '',
  ref_pack TEXT DEFAULT '[]',
  params TEXT DEFAULT '{}',
  source_spec_hash TEXT DEFAULT '',
  compiled_hash TEXT DEFAULT '',
  compiler_ver TEXT DEFAULT '',
  profile_ver TEXT DEFAULT '',
  qc_status TEXT DEFAULT '',
  created_at INTEGER,
  superseded_by TEXT DEFAULT ''
)`,
  // §4.10
  `CREATE TABLE IF NOT EXISTS render_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT DEFAULT '',
  unit_id TEXT DEFAULT '',
  package_id TEXT DEFAULT '',
  engine TEXT DEFAULT '',
  track TEXT DEFAULT '',
  params TEXT DEFAULT '{}',
  seed INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  error TEXT DEFAULT '',
  cost_amount REAL DEFAULT 0,
  cost_unit TEXT DEFAULT '',
  started_at INTEGER,
  finished_at INTEGER
)`,
  // §4.11
  `CREATE TABLE IF NOT EXISTS render_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  attempt_no INTEGER DEFAULT 1,
  seed INTEGER DEFAULT 0,
  output_path TEXT DEFAULT '',
  duration_real REAL DEFAULT 0,
  status TEXT DEFAULT '',
  error TEXT DEFAULT '',
  started_at INTEGER,
  finished_at INTEGER
)`,
  // §4.12
  `CREATE TABLE IF NOT EXISTS qc_reports (
  id TEXT PRIMARY KEY,
  project_id TEXT DEFAULT '',
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  ruleset_ver TEXT DEFAULT '',
  level TEXT DEFAULT '',
  hits TEXT DEFAULT '[]',
  created_at INTEGER
)`,
  // §4.13
  `CREATE TABLE IF NOT EXISTS timelines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  chapter_id TEXT DEFAULT '',
  name TEXT DEFAULT 'main',
  status TEXT DEFAULT 'draft',
  total_duration REAL DEFAULT 0,
  entries TEXT DEFAULT '[]',
  created_at INTEGER,
  updated_at INTEGER
)`,
];

/** archive：归档表（最后建） */
export const ARCHIVE_DDL = [
  // D02-01 §3.6
  `CREATE TABLE IF NOT EXISTS legacy_artifacts (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL,
  source_table         TEXT NOT NULL,
  source_pk            TEXT NOT NULL,
  artifact_kind        TEXT NOT NULL,
  resolved_track       TEXT,
  resolved_profile_ver TEXT,
  resolve_basis        TEXT DEFAULT '',
  body                 TEXT DEFAULT '',
  content_hash         TEXT DEFAULT '',
  note                 TEXT DEFAULT '',
  created_at           INTEGER,
  UNIQUE(source_table, source_pk, artifact_kind)
)`,
];

/** d02_ext：三张实施侧扩展表（D02-03 V3 §四/§五/§八） */
export const EXT_DDL = [
  // §八 C-2：每 adaptation 恰好 4 行，只 INSERT 不改
  `CREATE TABLE IF NOT EXISTS adaptation_locks (
  adaptation_id TEXT NOT NULL,
  lock_key      TEXT NOT NULL,
  lock_value    TEXT NOT NULL DEFAULT '',
  created_at    INTEGER,
  PRIMARY KEY (adaptation_id, lock_key)
)`,
  // §四 D-03：task_id 主键 = 一个 task 至多属于一个 job
  `CREATE TABLE IF NOT EXISTS render_task_jobs (
  task_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  created_at INTEGER
)`,
  // §五 D-04：unit_id 主键 = 一个单元至多一条当前选择
  `CREATE TABLE IF NOT EXISTS render_selections (
  unit_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  selected_at INTEGER,
  selected_by TEXT DEFAULT '',
  note TEXT DEFAULT ''
)`,
];

/**
 * 索引清单：表全部建完后再统一建。
 * 每条都带 IF NOT EXISTS，重复执行零副作用；任何一条失败必须抛出（不得吞掉当"建过了"）。
 */
export const STAGE1_INDEXES = [
  // biz
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_scene_state ON scene_states(project_id, scene_key)',
  'CREATE INDEX IF NOT EXISTS idx_ss_scene ON story_shots(project_id, scene_key, global_no)',
  'CREATE INDEX IF NOT EXISTS idx_ss_chap  ON story_shots(chapter_id, shot_no)',
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_ss_gn ON story_shots(project_id, global_no)',
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_ss_sn ON story_shots(chapter_id, shot_no)',
  'CREATE INDEX IF NOT EXISTS idx_sa_shot ON shot_actions(shot_id, t_from)',
  'CREATE INDEX IF NOT EXISTS idx_sas_asset ON shot_assets(asset_id, role)',
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_ra_ver ON render_adaptations(chapter_id, track, profile_ver, adaptation_version)',
  'CREATE INDEX IF NOT EXISTS idx_ra_active ON render_adaptations(chapter_id, track, status)',
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_ru_no ON render_units(adaptation_id, unit_no)',
  'CREATE INDEX IF NOT EXISTS idx_ru_proj ON render_units(project_id, track)',
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_rus ON render_unit_shots(unit_id, shot_id)',
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_rus_order ON render_unit_shots(unit_id, order_no)',
  'CREATE INDEX IF NOT EXISTS idx_rus_shot ON render_unit_shots(shot_id)',
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_pp ON prompt_packages(unit_id, track, compiled_hash)',
  'CREATE INDEX IF NOT EXISTS idx_rt_unit ON render_tasks(unit_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_qc_target ON qc_reports(target_type, target_id, created_at)',
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_tl ON timelines(project_id, chapter_id, name)',
  // ops
  'CREATE INDEX IF NOT EXISTS idx_mi_target ON migration_items(target_table, target_pk)',
  'CREATE INDEX IF NOT EXISTS idx_mi_source ON migration_items(source_table, source_pk)',
  'CREATE INDEX IF NOT EXISTS idx_mi_rollback ON migration_items(batch_id, rollback_status)',
  'CREATE INDEX IF NOT EXISTS idx_me_parent ON migration_edges(batch_id, parent_table, parent_pk)',
  'CREATE INDEX IF NOT EXISTS idx_me_child  ON migration_edges(batch_id, child_table, child_pk)',
  // d02_ext
  'CREATE INDEX IF NOT EXISTS idx_rtj_job ON render_task_jobs(job_id)',
  'CREATE INDEX IF NOT EXISTS idx_rs_attempt ON render_selections(attempt_id)',
];

/** 表清单元数据：建表顺序 + 分组。顺序与 D02-03 V3 §11.1 一致（0/1/…/17）。 */
export const STAGE1_TABLES = [
  { seq: 0, group: 'ops', name: 'migration_batches' },
  { seq: 1, group: 'ops', name: 'migration_items' },
  { seq: 2, group: 'biz', name: 'scene_states' },
  { seq: 3, group: 'biz', name: 'story_shots' },
  { seq: 4, group: 'biz', name: 'shot_blockings' },
  { seq: 5, group: 'biz', name: 'shot_actions' },
  { seq: 6, group: 'biz', name: 'shot_states' },
  { seq: 7, group: 'biz', name: 'shot_assets' },
  { seq: 8, group: 'biz', name: 'render_adaptations' },
  { seq: 8.1, group: 'd02_ext', name: 'adaptation_locks' },
  { seq: 9, group: 'biz', name: 'render_units' },
  { seq: 10, group: 'biz', name: 'render_unit_shots' },
  { seq: 11, group: 'biz', name: 'prompt_packages' },
  { seq: 12, group: 'biz', name: 'render_tasks' },
  { seq: 12.1, group: 'd02_ext', name: 'render_task_jobs' },
  { seq: 13, group: 'biz', name: 'render_attempts' },
  { seq: 13.1, group: 'd02_ext', name: 'render_selections' },
  { seq: 14, group: 'biz', name: 'qc_reports' },
  { seq: 15, group: 'biz', name: 'timelines' },
  { seq: 16, group: 'archive', name: 'legacy_artifacts' },
  { seq: 17, group: 'ops', name: 'migration_edges' },
];

/** 三组 DDL 按建表顺序拼成一个可执行序列（表在前，索引在后） */
export function stage1DdlInOrder() {
  const byName = new Map();
  for (const ddl of [...OPS_DDL, ...BIZ_DDL, ...ARCHIVE_DDL, ...EXT_DDL]) {
    const m = ddl.match(/CREATE TABLE IF NOT EXISTS\s+(\w+)/);
    if (m) byName.set(m[1], ddl);
  }
  const out = [];
  for (const t of STAGE1_TABLES.slice().sort((a, b) => a.seq - b.seq)) {
    const ddl = byName.get(t.name);
    if (!ddl) throw new Error(`stage1DdlInOrder: 缺少 ${t.name} 的 DDL`);
    out.push(ddl);
  }
  return out;
}
