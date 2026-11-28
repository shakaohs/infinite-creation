// 取锁顺序观察者 —— **内部测试入口，不是公共 API**（D42-02）。
//
// 为什么必须单独成文件、而不是留在 db.js：
//   `lib/core/index.js` 里有 `export * from './db.js'`，任何在 db.js 顶层 export 的符号
//   都会自动变成对外 API。D02-34 §4.1 / TST-LOCK-07 要求「用注入的 spy 记录真实取锁顺序」，
//   但这是**测试可观测性**需求，不是业务能力。把它放在 internal/ 且不被 index.js 转出，
//   生产代码通过 `lib/core/index.js` 就根本拿不到它；唯一的引用方式是写显式路径
//   （`internal/lock-order.js`），这种引用一眼可查（见 D02-42 的静态扫描用例）。
//
// 两道闸，缺一不可：
//   1. 结构闸：不放 db.js、不进 index.js ⇒ 不在 lib/core 的公共面里。
//   2. 运行闸：`IC_LOCK_TEST=1` 之外调用 setLockOrderSink 直接抛 LOCK_SINK_TEST_ONLY，
//      避免「顺手注入」被带进生产路径。
//
// 它不参与任何门禁、不改写任何状态、不返回值 —— 只把「正在取哪个项目的锁」报一声。
// 观察者缺席时 db.js 的行为与没有这段代码完全一致（emitLockOrder 是空操作）。
let sink = null;

/** 取锁时回调一次（db.js 取锁循环调用；生产恒为空操作） */
export function emitLockOrder(projectId) {
  if (sink) sink(String(projectId));
}

/**
 * 注入观察者（仅测试）。传非函数 = 注销。
 * 非 `IC_LOCK_TEST=1` 的进程调用一律抛错，已注入的观察者不会被外部注销。
 */
export function setLockOrderSink(fn) {
  if (process.env.IC_LOCK_TEST !== '1') {
    throw Object.assign(
      new Error('setLockOrderSink 仅供锁测试使用：需要 IC_LOCK_TEST=1；该入口不是公共 API'),
      { code: 'LOCK_SINK_TEST_ONLY' },
    );
  }
  sink = typeof fn === 'function' ? fn : null;
}

/** 当前是否已有观察者（测试里用它断言「注入确实生效」，避免 order=[] 被误读成"没取锁"） */
export function lockOrderObserving() {
  return sink !== null;
}
