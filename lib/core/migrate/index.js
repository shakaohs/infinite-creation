// 迁移登记模型：三张运维表的状态机与数据访问（D02-01 §3.5 / §3.5.1 / §3.5.2 + V9）
//
// 这个模块存在的唯一理由：**让回滚能精确到行**。
//   · 批次信息只活在 migration_batches 一行，业务表零迁移列；
//   · 每个目标行一条 migration_items（三元组主键），指纹写一次永不更新；
//   · 父子依赖存 migration_edges（五元组主键），回滚只读不删。
//
// 三条不许退让的规则（退让了就等于没有回滚）：
//   1. 四终态（protected / missing / unverifiable / rolled_back）**没有任何出边**
//   2. `migrated_content_hash` **写一次后永不更新**（它是回滚比对的基准）
//   3. 依赖读取必须 **LEFT JOIN + 显式检查未匹配**；INNER JOIN 会把"边在、记录缺"的行静默吃掉
//
// 本阶段只建模型与约束，**不写历史解析器、不跑任何迁移**（任务书 §九）。
import { now } from '../utils.js';

// ── 状态机（唯一权威，任何代码/测试不得增删边）─────────────────────────────
export const ROLLBACK_STATES = ['none', 'eligible', 'protected', 'missing', 'unverifiable', 'rolled_back'];
export const ROLLBACK_TERMINAL = ['protected', 'missing', 'unverifiable', 'rolled_back'];

export const ROLLBACK_TRANSITIONS = {
  none: ['eligible', 'protected', 'missing', 'unverifiable'],
  eligible: ['rolled_back', 'protected'],
  protected: [],
  missing: [],
  unverifiable: [],
  rolled_back: [],
};

export const BATCH_STATES = ['staged', 'committed', 'failed', 'rolled_back', 'partially_rolled_back'];
export const BATCH_TRANSITIONS = {
  staged: ['committed', 'failed'],
  committed: ['rolled_back', 'partially_rolled_back'],
  partially_rolled_back: ['rolled_back', 'partially_rolled_back'],
  rolled_back: [],
  failed: [],
};

export const MIGRATION_STATUSES = ['staged', 'committed', 'failed', 'skipped'];

function badTransition(kind, from, to) {
  const e = new Error(`${kind} 非法状态转移：${from} → ${to}`);
  e.code = 'ILLEGAL_TRANSITION';
  e.from = from;
  e.to = to;
  return e;
}

export function assertRollbackTransition(from, to) {
  if (!ROLLBACK_STATES.includes(to)) {
    const e = new Error(`未知 rollback_status：${to}`);
    e.code = 'BAD_STATE';
    throw e;
  }
  const allowed = ROLLBACK_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) throw badTransition('rollback_status', from, to);
  return true;
}

export function assertBatchTransition(from, to) {
  if (!BATCH_STATES.includes(to)) {
    const e = new Error(`未知批次状态：${to}`);
    e.code = 'BAD_STATE';
    throw e;
  }
  const allowed = BATCH_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) throw badTransition('migration_batches.status', from, to);
  return true;
}

/** 批次 id 格式：mig-YYYYMMDD-NN（NN 两位，从 00 起：00 留给基线） */
export function batchIdFor(date = new Date(), nn = 1) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `mig-${y}${m}${d}-${String(nn).padStart(2, '0')}`;
}

// ── 批次 ───────────────────────────────────────────────────────────────
export function createMigrateStore(db) {
  const Batches = {
    get(id) {
      return db.prepare('SELECT * FROM migration_batches WHERE id = ?').get(id) || null;
    },
    list() {
      return db.prepare('SELECT * FROM migration_batches ORDER BY id').all();
    },
    /** 新建批次（默认 staged）。id 冲突即拒——不覆盖既有批次。 */
    create({
      id, name = '', scriptVer = '', backupPath = '', backupSha256 = '',
      sourceCounts = {}, status = 'staged',
    } = {}) {
      if (!id) throw Object.assign(new Error('批次 id 必填（mig-YYYYMMDD-NN）'), { code: 'BAD_BATCH_ID' });
      if (!/^mig-\d{8}-\d{2}$/.test(id)) {
        throw Object.assign(new Error(`批次 id 格式必须是 mig-YYYYMMDD-NN，当前 "${id}"`), { code: 'BAD_BATCH_ID' });
      }
      if (!BATCH_STATES.includes(status)) throw Object.assign(new Error('未知批次状态：' + status), { code: 'BAD_STATE' });
      const t = now();
      db.prepare(`INSERT INTO migration_batches
        (id,name,script_ver,status,source_counts,target_counts,backup_path,backup_sha256,rollback_preview,rollback_counts,note,started_at,finished_at,rolled_back_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, name, scriptVer, status, JSON.stringify(sourceCounts), '{}', backupPath, backupSha256, '', '{}', '', t, null, null,
      );
      return this.get(id);
    },
    /** 状态转移（带前置校验 + 条件更新，并发写不会互相覆盖） */
    transition(id, to, patch = {}) {
      const cur = this.get(id);
      if (!cur) throw Object.assign(new Error('批次不存在：' + id), { code: 'NOT_FOUND' });
      assertBatchTransition(cur.status, to);
      const t = now();
      const fields = {
        status: to,
        target_counts: patch.targetCounts !== undefined ? JSON.stringify(patch.targetCounts) : cur.target_counts,
        rollback_preview: patch.rollbackPreview !== undefined ? JSON.stringify(patch.rollbackPreview) : cur.rollback_preview,
        rollback_counts: patch.rollbackCounts !== undefined ? JSON.stringify(patch.rollbackCounts) : cur.rollback_counts,
        note: patch.note !== undefined ? String(patch.note) : cur.note,
        finished_at: patch.finishedAt !== undefined ? patch.finishedAt : (to === 'committed' || to === 'failed' ? t : cur.finished_at),
        rolled_back_at: patch.rolledBackAt !== undefined ? patch.rolledBackAt : (to === 'rolled_back' ? t : cur.rolled_back_at),
      };
      const r = db.prepare(`UPDATE migration_batches SET status=?, target_counts=?, rollback_preview=?, rollback_counts=?, note=?, finished_at=?, rolled_back_at=?
        WHERE id=? AND status=?`).run(
        fields.status, fields.target_counts, fields.rollback_preview, fields.rollback_counts,
        fields.note, fields.finished_at, fields.rolled_back_at, id, cur.status,
      );
      if (!r.changes) throw Object.assign(new Error('并发冲突：批次状态已被别处修改'), { code: 'CONFLICT' });
      return this.get(id);
    },
    /**
     * 全新库基线记录（D02-01 §4.2）：id 用 mig-YYYYMMDD-00，name='schema-init'。
     * **幂等**：同一天重复初始化不会产生第二条基线（id 即幂等键）。
     */
    ensureBaseline({ date = new Date(), scriptVer = '' } = {}) {
      const id = batchIdFor(date, 0);
      const existing = this.get(id);
      if (existing) return { created: false, batch: existing };
      return {
        created: true,
        batch: this.create({ id, name: 'schema-init', scriptVer, status: 'committed' }),
      };
    },
  };

  // ── 迁移记录 ─────────────────────────────────────────────────────────
  const Items = {
    get(batchId, table, pk) {
      return db.prepare('SELECT * FROM migration_items WHERE batch_id=? AND target_table=? AND target_pk=?')
        .get(batchId, table, pk) || null;
    },
    listByBatch(batchId) {
      return db.prepare('SELECT * FROM migration_items WHERE batch_id=? ORDER BY target_table, target_pk').all(batchId);
    },
    /**
     * 登记一条目标行。
     * `migratedContentHash` 必须由调用方在**目标行写入后回读整行**算出（D02-01 §3.5 字段说明），
     * 不是"我打算写什么"的 hash。写一次后本模块**不提供任何更新它的方法**。
     */
    add({
      batchId, targetTable, targetPk, sourceTable = '', sourcePk = '', sourceKind = '',
      migratedContentHash = '', migrationStatus = 'staged', confidence = 1.0, reason = '',
    } = {}) {
      if (!batchId || !targetTable || !targetPk) {
        throw Object.assign(new Error('batchId / targetTable / targetPk 必填'), { code: 'BAD_ITEM_KEY' });
      }
      if (!MIGRATION_STATUSES.includes(migrationStatus)) {
        throw Object.assign(new Error('未知 migration_status：' + migrationStatus), { code: 'BAD_STATE' });
      }
      if (this.get(batchId, targetTable, targetPk)) {
        throw Object.assign(new Error('该目标行已在本批次登记过（三元组主键冲突）'), { code: 'DUPLICATE_ITEM' });
      }
      const t = now();
      db.prepare(`INSERT INTO migration_items
        (batch_id,target_table,target_pk,source_table,source_pk,source_kind,migrated_content_hash,migration_status,rollback_status,rollback_reason,protected_at,confidence,reason,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        batchId, targetTable, targetPk, sourceTable, sourcePk, sourceKind,
        migratedContentHash, migrationStatus, 'none', '', null, Number(confidence) || 0, reason, t, t,
      );
      return this.get(batchId, targetTable, targetPk);
    },
    setMigrationStatus(batchId, table, pk, status) {
      if (!MIGRATION_STATUSES.includes(status)) throw Object.assign(new Error('未知 migration_status：' + status), { code: 'BAD_STATE' });
      db.prepare('UPDATE migration_items SET migration_status=?, updated_at=? WHERE batch_id=? AND target_table=? AND target_pk=?')
        .run(status, now(), batchId, table, pk);
      return this.get(batchId, table, pk);
    },
    /** 回滚状态转移：唯一入口，非法转移直接抛 */
    setRollbackStatus(batchId, table, pk, to, reason = '') {
      const cur = this.get(batchId, table, pk);
      if (!cur) throw Object.assign(new Error('迁移记录不存在'), { code: 'NOT_FOUND' });
      assertRollbackTransition(cur.rollback_status, to);
      const t = now();
      const protectedAt = to === 'protected' ? t : cur.protected_at;
      const r = db.prepare(`UPDATE migration_items SET rollback_status=?, rollback_reason=?, protected_at=?, updated_at=?
        WHERE batch_id=? AND target_table=? AND target_pk=? AND rollback_status=?`)
        .run(to, reason, protectedAt, t, batchId, table, pk, cur.rollback_status);
      if (!r.changes) throw Object.assign(new Error('并发冲突：回滚状态已被别处修改'), { code: 'CONFLICT' });
      return this.get(batchId, table, pk);
    },
    counts(batchId) {
      const rows = db.prepare('SELECT rollback_status, COUNT(*) n FROM migration_items WHERE batch_id=? GROUP BY rollback_status').all(batchId);
      const out = Object.fromEntries(ROLLBACK_STATES.map((s) => [s, 0]));
      for (const r of rows) out[r.rollback_status] = r.n;
      return out;
    },
  };

  // ── 依赖边 ───────────────────────────────────────────────────────────
  const Edges = {
    /** 写边：必须在迁移写入同一事务内调用（E1）。同一五元组重复写入按幂等处理。 */
    add({ batchId, childTable, childPk, parentTable, parentPk, edgeKind = 'fk' } = {}) {
      if (!batchId || !childTable || !childPk || !parentTable || !parentPk) {
        throw Object.assign(new Error('边的五元组必填'), { code: 'BAD_EDGE_KEY' });
      }
      const exists = db.prepare(`SELECT 1 FROM migration_edges
        WHERE batch_id=? AND child_table=? AND child_pk=? AND parent_table=? AND parent_pk=?`)
        .get(batchId, childTable, childPk, parentTable, parentPk);
      if (exists) return false;
      db.prepare(`INSERT INTO migration_edges (batch_id,child_table,child_pk,parent_table,parent_pk,edge_kind,created_at)
        VALUES (?,?,?,?,?,?,?)`).run(batchId, childTable, childPk, parentTable, parentPk, edgeKind, now());
      return true;
    },
    /** 某父行的全部子边（只读；回滚不删边 E2） */
    byParent(batchId, parentTable, parentPk) {
      return db.prepare('SELECT * FROM migration_edges WHERE batch_id=? AND parent_table=? AND parent_pk=?')
        .all(batchId, parentTable, parentPk);
    },
    /**
     * 依赖快照读取（E5 + E6 + E7）：LEFT JOIN + 逐条边统计命中数 h。
     *   h = 0  → EDGE_UNMATCHED
     *   h ≥ 2  → EDGE_AMBIGUOUS
     *   同一 (child_table, child_pk) 多条边（不同 parent）→ 正常多父，不算异常
     *
     * 注意：LEFT JOIN 的结果行数 **不等于** 边数——一条边若命中 2 条迁移记录，
     * JOIN 会出 2 行。因此边必须按五元组去重后再统计，否则"关联歧义"会被算成
     * "多了一条边"，`edgeCount` 直接虚高（本机踩过：1 条边报成 2 条）。
     */
    snapshot(batchId, parentTable, parentPk) {
      const rows = db.prepare(`
        SELECT e.child_table, e.child_pk, e.parent_table, e.parent_pk, e.edge_kind,
               i.target_table AS item_table, i.target_pk AS item_pk, i.batch_id AS item_batch,
               i.rollback_status, i.migration_status
          FROM migration_edges e
          LEFT JOIN migration_items i
                 ON i.batch_id     = e.batch_id
                AND i.target_table = e.child_table
                AND i.target_pk    = e.child_pk
         WHERE e.batch_id = ? AND e.parent_table = ? AND e.parent_pk = ?
         ORDER BY e.child_table, e.child_pk, e.parent_table, e.parent_pk`).all(batchId, parentTable, parentPk);

      // 按五元组去重：一条边一行，hits 单独查（这是【每条边】的计数，不是每个子键的计数）
      const byEdge = new Map();
      for (const r of rows) {
        const k = [r.child_table, r.child_pk, r.parent_table, r.parent_pk].join('\u0000');
        if (!byEdge.has(k)) {
          const h = db.prepare('SELECT COUNT(*) n FROM migration_items WHERE batch_id=? AND target_table=? AND target_pk=?')
            .get(batchId, r.child_table, r.child_pk).n;
          byEdge.set(k, { ...r, hits: h, joinRows: 0 });
        }
        byEdge.get(k).joinRows++;
      }

      const edges = [...byEdge.values()].map((e) => ({
        ...e,
        unmatched: e.hits === 0,
        ambiguous: e.hits >= 2,
        status: e.hits === 0 ? 'EDGE_UNMATCHED' : e.hits >= 2 ? 'EDGE_AMBIGUOUS' : 'OK',
      }));
      const childKeys = new Set(edges.map((e) => `${e.child_table}\u0000${e.child_pk}`));
      return {
        edges,
        edgeCount: edges.length,                                     // 去重后的边数（= 五元组个数）
        joinRows: rows.length,                                       // LEFT JOIN 结果行数（歧义时 > edgeCount）
        childCount: childKeys.size,                                  // 去重子记录数（多父时 < edgeCount）
        unmatched: edges.filter((e) => e.unmatched).length,
        ambiguous: edges.filter((e) => e.ambiguous).length,
        ok: edges.every((e) => e.status === 'OK'),
      };
    },
  };

  return { Batches, Items, Edges, db };
}

/** 便捷：用默认连接（业务侧）。测试请显式传 adapter，别走单例。 */
export async function migrateStore() {
  const { getDb } = await import('../db.js');
  return createMigrateStore(getDb());
}

export const ROLLBACK_STATUS_MACHINE = {
  states: ROLLBACK_STATES,
  terminal: ROLLBACK_TERMINAL,
  transitions: ROLLBACK_TRANSITIONS,
  batchTransitions: BATCH_TRANSITIONS,
};
