// 求解器错误工厂（唯一一份）：所有求解器侧失败共用同一个 `code`，
// 具体原因放 `reason`，避免调用方按 error message 做分支判断。
//
// 为什么不用多个 code：P6 起 `CONTINUITY_SOLVER_FAILED` 已是上游（任务层 / 测试）
// 识别"求解失败"的唯一锚点；再拆多个 code 会让已有的 catch 分支漏掉新错误。
// 需要细分时读 `reason`（`SHOT_SCENE_MISMATCH` / `META_IS_RESULT_FEEDBACK` …）。

/** 创建求解器错误 */
export function solveError(message, extra = {}) {
  const e = new Error(message);
  e.code = 'CONTINUITY_SOLVER_FAILED';
  Object.assign(e, extra);
  return e;
}
