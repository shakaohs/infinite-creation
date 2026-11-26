// 项目级结构化创作开关（D02-03 V3 §六 D-05）
//
// 唯一边界：**只有这个模块读写 `projects.structured_spec`**。
// 其他模块一律 import 本模块，不得内联 SQL、不得从 `project.context` 里摸值。
//
// 为什么不用 context：`Projects.update` 对 context 是整段覆盖（`JSON.stringify(m.context ?? {})`），
// 任何一次上下文写回都会把开关冲掉 → 项目"静默退回旧链路"，用户只看到"新功能突然没了"，无报错。
// 独立列 + NOT NULL DEFAULT 0 让"读不到"这件事不成立。
import { getDb, tx } from './db.js';
import { now } from './utils.js';
import { recordChange, rawGet } from './changelog.js';

/** 读取（唯一入口）。项目不存在 → false（不抛，读路径要稳） */
export function isStructuredSpec(projectId) {
  if (!projectId) return false;
  const r = getDb().prepare('SELECT structured_spec FROM projects WHERE id = ?').get(projectId);
  return !!(r && Number(r.structured_spec) === 1);
}

/** 批量列出已开启的项目 id（灰度清单用，避免每项目一次查询） */
export function listStructuredProjects() {
  return getDb().prepare('SELECT id FROM projects WHERE structured_spec = 1 ORDER BY id').all().map((r) => r.id);
}

/**
 * 设置开关。只接受布尔；内部转 0/1。变更留 change_logs 审计（entity='project'）。
 * 关闭开关**只影响行为**，不删任何新表数据（§12.5.1）。
 */
export function setStructuredSpec(projectId, on) {
  if (typeof on !== 'boolean') {
    const e = new Error('setStructuredSpec 只接受布尔值，收到：' + typeof on);
    e.code = 'BAD_FLAG_VALUE';
    throw e;
  }
  return tx(() => {
    const before = rawGet('project', projectId);
    if (!before) {
      const e = new Error('项目不存在：' + projectId);
      e.code = 'PROJECT_NOT_FOUND';
      throw e;
    }
    const cur = Number(before.structured_spec) === 1;
    if (cur === on) return { changed: false, value: on };   // 幂等：同值不写库也不刷日志
    getDb().prepare('UPDATE projects SET structured_spec = ?, updated_at = ? WHERE id = ?')
      .run(on ? 1 : 0, now(), projectId);
    const after = rawGet('project', projectId);
    const logId = recordChange({
      entity: 'project', action: 'update', before, after, entityId: projectId,
      meta: { field: 'structured_spec', from: on ? 0 : 1, to: on ? 1 : 0 },
    });
    return { changed: true, value: on, logId };
  });
}
