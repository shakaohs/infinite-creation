// G0 四项锁（D02-03 V3 §八 C-2）
//
// 模型：`adaptation_locks(adaptation_id, lock_key, lock_value)`，每方案**恰好 4 行**，
// 写完就不可变；改锁 = 新建 adaptation 版本，旧行原样保留。
//
// 为什么不做 UPDATE：`adaptationHash` 的 payload 里**没有**锁值（只有版本号），
// 所以"锁被就地改了"这件事 hash 一个字节都不会变。唯一能保证"锁与方案对得上"的机制就是
// "锁不可变 + 变更即新版本"——允许 UPDATE 等于把这唯一的保证拆掉。
//
// 谁也别指望 hash 能证明锁一致：它在设计上就不包含锁值（§八 R-06）。
import { getDb } from '../db.js';
import { now } from '../utils.js';

export const LOCK_KEYS = ['mode', 'aspect', 'base', 'assetMode'];

/** 读某方案的锁（返回 { mode, aspect, base, assetMode } 对象；缺的键不出现） */
export function getLocks(adaptationId) {
  const rows = getDb().prepare('SELECT lock_key, lock_value FROM adaptation_locks WHERE adaptation_id = ? ORDER BY lock_key')
    .all(adaptationId);
  const out = {};
  for (const r of rows) out[r.lock_key] = r.lock_value;
  return out;
}

/**
 * 写 4 行锁。**必须与 render_adaptations 的 INSERT 在同一事务内**（G3）。
 * 只 INSERT：已存在任何一行就抛 `G0_LOCKS_EXIST`（改锁请建新版本）。
 */
export function addLocks(adaptationId, locks = {}) {
  if (!adaptationId) throw Object.assign(new Error('adaptationId 必填'), { code: 'BAD_ARG' });
  const keys = Object.keys(locks).filter((k) => LOCK_KEYS.includes(k));
  const missing = LOCK_KEYS.filter((k) => !keys.includes(k));
  if (missing.length) {
    throw Object.assign(new Error('G0 四项锁不全，缺：' + missing.join(',')), { code: 'G0_LOCKS_INCOMPLETE', missing });
  }
  const extra = Object.keys(locks).filter((k) => !LOCK_KEYS.includes(k));
  if (extra.length) {
    throw Object.assign(new Error('出现非 G0 锁键：' + extra.join(',')), { code: 'G0_LOCKS_UNKNOWN_KEY', extra });
  }
  const exists = getDb().prepare('SELECT COUNT(*) n FROM adaptation_locks WHERE adaptation_id = ?').get(adaptationId).n;
  if (exists > 0) {
    throw Object.assign(new Error('该方案已有锁记录（锁不可变，改锁请新建 adaptation 版本）'), { code: 'G0_LOCKS_EXIST' });
  }
  const t = now();
  const ins = getDb().prepare('INSERT INTO adaptation_locks (adaptation_id, lock_key, lock_value, created_at) VALUES (?,?,?,?)');
  for (const k of LOCK_KEYS) ins.run(adaptationId, k, String(locks[k] ?? ''), t);
  return getLocks(adaptationId);
}

/** 完整性断言：恰好 4 行且四个 key 齐全（编译入口必过，缺一即抛） */
export function assertLocksComplete(adaptationId) {
  const rows = getDb().prepare('SELECT lock_key FROM adaptation_locks WHERE adaptation_id = ?').all(adaptationId);
  const have = rows.map((r) => r.lock_key);
  const missing = LOCK_KEYS.filter((k) => !have.includes(k));
  const extra = have.filter((k) => !LOCK_KEYS.includes(k));
  if (rows.length !== 4 || missing.length || extra.length) {
    throw Object.assign(
      new Error(`G0 锁不完整：${rows.length} 行，缺 [${missing.join(',')}]，多 [${extra.join(',')}]`),
      { code: 'G0_LOCKS_INCOMPLETE', rows: rows.length, missing, extra },
    );
  }
  return true;
}

/**
 * 巡检：一次扫全库，返回三类异常。
 * 这是"外部篡改 / 错误关联"唯一能发现的地方——hash 查不出来。
 */
export function inspectLocks() {
  const db = getDb();
  const bad = db.prepare(`
    SELECT adaptation_id, COUNT(*) n FROM adaptation_locks
     GROUP BY adaptation_id HAVING COUNT(*) <> 4`).all();
  const unknownKey = db.prepare(`
    SELECT adaptation_id, lock_key FROM adaptation_locks
     WHERE lock_key NOT IN ('mode','aspect','base','assetMode')`).all();
  const orphan = db.prepare(`
    SELECT l.adaptation_id FROM adaptation_locks l
      LEFT JOIN render_adaptations a ON a.id = l.adaptation_id
     WHERE a.id IS NULL GROUP BY l.adaptation_id`).all();
  const emptyValue = db.prepare("SELECT adaptation_id, lock_key FROM adaptation_locks WHERE lock_value = ''").all();
  return {
    wrongCount: bad,
    unknownKey,
    orphanAdaptation: orphan,
    emptyValue,
    ok: bad.length === 0 && unknownKey.length === 0 && orphan.length === 0 && emptyValue.length === 0,
  };
}
