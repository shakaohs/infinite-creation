// 用户业务项目的**唯一**创建入口（D02-06 §4.3.1 / A-02）。
//
// 为什么默认值不放在 `Projects.create()` 里翻：
//   `Projects.create` 是低层原语，被 `tests/*.test.mjs` 的 140+ 既有用例、全部测试夹具、
//   阶段 0/1 脚本直接调用。在那里默认 `structured_spec=1`，会把既有用例整体推到结构化分支，
//   让"17 条旧链路失败"这条回归标尺失效。所以默认值只落在**用户建项目必经的服务层**：
//   覆盖面 100%，且一个测试都不碰。
//
// 调用方约定：
//   · 用户建项目（API / 导入）→ `createUserProject({...})`，默认结构化模式开启；
//   · 测试夹具 / 迁移脚本 / 阶段脚本 → 继续用 `Projects.create({...})`，默认仍是旧链路（0）；
//   · 需要用户级旧模式（灰度回退、用例造数）→ `createUserProject({ structured_spec: false })`。
//
// 读取侧注意：`Projects.get()` 返回的是 `toProject()` 的结果，其中 `structured_spec` 是
// **0/1 数字**，不是布尔。判开关一律走 `isStructuredSpec(projectId)`，禁止 `=== true`。
import { Projects } from './db.js';

/** 允许透传给 `Projects.create` 的键之外的一切都原样转发，本服务只负责一个默认值 */
export function createUserProject({ structured_spec = true, ...rest } = {}) {
  // 只接受布尔：把 "1" / "yes" / 1 这类脏值静默当成"开"，会让"明明是旧链路"的项目悄悄进新分支，
  // 排查时又看不到任何报错。宁可当场拒绝。
  if (typeof structured_spec !== 'boolean') {
    const e = new Error('createUserProject 的 structured_spec 只接受布尔值，收到：' + typeof structured_spec);
    e.code = 'BAD_FLAG_VALUE';
    throw e;
  }
  // 数据库列是 INTEGER NOT NULL DEFAULT 0，这里显式转成 0/1 再交给低层原语
  return Projects.create({ ...rest, structured_spec: structured_spec ? 1 : 0 });
}
