# D02-20-R1 · P8 对象型 JSON 形状校验收尾实施报告

> 上一轮（D02-20）把读取层接上了真实数据，但 `parseJsonColumn()` 只做了两件事：JSON 语法坏就抛、
> **数组列**不是数组就抛。**对象列没有任何形状判据**，而且"已经是对象"的输入在
> `typeof raw === 'object'` 处直接 `return`，连数组判据也绕过去了。
> 本轮只补这一条契约，不动求解器、Hash、数据库结构与 D01 规范。
>
> **本报告中的测试数字均为本轮在本机隔离环境实际执行的结果**，不代表独立审核方已执行或认可。

## 一、缺口：改之前到底漏了什么

三处缺口，都可以用"语法完全合法"的数据复现：

| # | 改前行为 | 后果 |
|---|---|---|
| 1 | `kind === 'object'` 无判据，`'[]'` 解析成 `[]` 后直接赋给 `init_state` | 下游 `Object.entries([])` 为空 → 求解器认为"这一镜没有初始状态"，**不报错**，算出"看起来正常"的空结论 |
| 2 | 同上，`'"grab"'` / `'42'` / `'true'` 原样进入镜头对象 | 属性读取全 `undefined`；`??` 兜底把"数据坏了"伪装成"字段缺省" |
| 3 | `typeof raw === 'object'` 直接 `return raw` | 已是数组的 `[]` 冒充对象、已是对象的 `{}` 冒充数组，**完全绕过 kind 判据** |

关键点：这三类都发生在 `JSON.parse` **成功之后**。只测"坏 JSON 会抛"（D02-20 的 `W9`）永远测不到它们——
这正是本轮任务书要求的"不得只测 `JSON.parse` 失败"。

## 二、修改文件清单

| 文件 | 状态 | 行数 | 改动 |
|---|---|---:|---|
| `lib/core/continuity/load-scene.js` | 修改 | 215（原 167） | 新增 `shapeOf()` / `locatorOf()` / `invalidShape()`；`parseJsonColumn()` 加对象型判据、对象输入同校验；`toSolverAction()` 传 `shot`；函数改为具名导出 |
| `tests/stage3-p8-wiring.test.mjs` | 修改 | 451（原 309） | 新增 `seedAction()` 夹具 + `W14`~`W21` 八条；接线专项 13 → **21** |
| `docs/D02/D02-20-R1-P8对象型JSON形状校验收尾实施报告.md` | 新增 | 本文件 | — |

未修改：D01 全部、`lib/core/schema/tables.js`（DDL）、`solve-continuity.js`、`solve-hash.js` 及其 Hash 字段、
`assemble-input.js` / `solver-input.js` 的来源判据、`unknown` 跨镜传播语义、P5 `validate/`、P6 `qc/deps/`、
`lib/core/index.js`（导出面未变）。

## 三、代码

### 3.1 `parseJsonColumn()`：两条失败路径分开，形状成为契约

```js
// 改前（节选）
function parseJsonColumn(raw, { table, column, key, kind }) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'object') return raw;              // ← 形状完全不校验
  let v;
  try { v = JSON.parse(String(raw)); } catch (e) { throw ...INVALID_JSON }
  if (kind === 'array' && !Array.isArray(v)) {          // ← 只有数组列有判据
    throw ...INVALID_SHAPE
  }
  return v;
}

// 改后（`load-scene.js:77`）
export function parseJsonColumn(raw, meta) {
  const { table, column, key, kind } = meta;
  if (raw === null || raw === undefined || raw === '') return null;

  let v;
  if (typeof raw === 'object') {
    v = raw;                                            // 上游已解析 → 形状照样要校验
  } else {
    try {
      v = JSON.parse(String(raw));
    } catch (e) {
      throw solveError(
        `${table}.${column} 不是合法 JSON（${locatorOf(meta)}，前 40 字符：${String(raw).slice(0, 40)}）`,
        { reason: 'SCENE_INPUT_INVALID_JSON', table, column, key },
      );
    }
  }

  if (kind === 'object') {
    if (v === null) return null;                        // JSON `null` ＝ 没内容，不是形状错
    if (typeof v !== 'object' || Array.isArray(v)) throw invalidShape(meta, shapeOf(v));
    return v;
  }
  if (!Array.isArray(v)) throw invalidShape(meta, shapeOf(v));
  return v;
}
```

三条设计取舍，逐条写清理由：

1. **`typeof [] === 'object'` 是这轮的核心陷阱。** 对象判据必须是"`typeof v === 'object'` **且** 非数组"，
   两个条件缺一不可；只写前者，`[]` 会一路走到求解器里，且比字符串更隐蔽（`Array.isArray` 之外
   它看起来就像个对象）。
2. **"已是对象"的分支不能放行。** 数据库驱动只给字符串，但测试夹具、未来的批量导入、别的调用方都可能
   递进已解析的值。放行等于把形状契约交给调用方自觉——而 `meta` 被投影成 `[]` 正是这条路上最典型的错误。
3. **`JSON.parse` 出的 `null` 与 SQL NULL 同义。** `JSON.stringify(null)` 写进列就是 `'null'`，
   若把它判成形状错误，等于让"这列没内容"变成"这列坏了"——把缺省语义升级成故障，属于"擅自改变既定语义"。
   对象列因此按缺省处理（→ `{}`）；**数组列维持原判据**（非数组即抛），不改数组字段语义。

### 3.2 错误信息四要素

```js
function locatorOf({ key, shot }) {                     // load-scene.js:38
  const id = key === null || key === undefined || key === '' ? '(空 id)' : String(key);
  const parent = shot === null || shot === undefined || String(shot) === id ? '' : ` · 镜头 ${shot}`;
  return `记录 ${id}${parent}`;
}

function invalidShape(meta, actual) {                   // load-scene.js:45
  const want = meta.kind === 'array' ? '数组' : '对象';
  return solveError(
    `${meta.table}.${meta.column} 应为${want}，实际为 ${actual}（${locatorOf(meta)}）`,
    { reason: 'SCENE_INPUT_INVALID_SHAPE', table: meta.table, column: meta.column,
      key: meta.key, kind: meta.kind, actual, ...(meta.shot !== undefined ? { shot: meta.shot } : {}) },
  );
}
```

实际消息形如：

```
shot_actions.speed_json 应为对象，实际为 string（记录 act_r1_3 · 镜头 sh_3f2a91）
```

四要素齐备：**表名** `shot_actions`、**列名** `speed_json`、**记录标识** `act_r1_3`（并附所属**镜头** `sh_3f2a91`）、
**错误形状** `string`。动作行有自己的 id，只给动作 id 找不到它在哪一镜，所以 `toSolverAction()` 统一带上 `shot`。

形状名由 `shapeOf()` 收口（`load-scene.js:31`）：`null` / `array` / `string` / `number` / `boolean` / `object`。
统一说 `array` 而不是 `object`，否则"实际为 object"会让 `[]` 与 `{}` 无法区分——正是要修的那个坑。

### 3.3 九个对象列声明不变

`ACTION_JSON_OBJ_COLS` 仍是那 9 个（`init_state`、`trigger_json`、`path_json`、`force_json`、`speed_json`、
`contact_json`、`result_json`、`end_state`、`sync_json`），`ACTION_JSON_ARRAY_COLS` 仍是 `body_parts`；
`story_shots` 四个数组列、`shot_blockings.position_track` 也都未动。改动只是给这些既有声明
**补上"对象"这一侧的判据**，没有增删列。

### 3.4 各列的形状契约（本轮生效后的全表）

| 表 | 列 | kind | 合法 | 非法 → `SCENE_INPUT_INVALID_SHAPE` | 缺省（SQL NULL / 空串 / JSON null） |
|---|---|---|---|---|---|
| `story_shots` | `speakers` `time_slices` `cam_path` `voice_ids` | array | `[...]` | `{}`、`"x"`、`42`、`true`、`'null'` | `[]` |
| `shot_blockings` | `position_track` | array | `[...]` | 同上 | `[]` |
| `shot_actions` | `init_state` `trigger_json` `path_json` `force_json` `speed_json` `contact_json` `result_json` `end_state` `sync_json` | object | `{...}` | `[]`、`"x"`、`42`、`true` | `{}` |
| `shot_actions` | `body_parts` | array | `[...]` | `{}`、`"x"`、`42`、`true`、`'null'` | `[]` |

## 四、新增测试（`stage3-p8-wiring.test.mjs:97`~`:220`）

全部走**真实 sqlite**（`mkdtemp` 隔离库 + `createUserProject` + 直写 `shot_actions`），不是内存夹具。

| 用例 | 行 | 对应任务书要求 | 断言要点 |
|---|---:|---|---|
| `W14` 对象型 JSON 合法时逐列解析 | 97 | 合法对象正常读取；九个字段声明不变 | 9 个对象列逐个 `deepEqual`；`body_parts` 仍为数组；`result`/`contact` 别名与源列**同一引用** |
| `W15` 对象列写成 `[]` | 124 | 对象型为 `[]` 时拒绝 | `code=CONTINUITY_SOLVER_FAILED`、`reason=SCENE_INPUT_INVALID_SHAPE`、`table/column/key/shot/actual` 全对 |
| `W16` 对象列写成 JSON 字符串 | 142 | 对象型为字符串时拒绝 | `actual='string'` |
| `W17` 对象列写成数字 / 布尔值 | 151 | 对象型为数字时拒绝（并覆盖布尔） | `actual='number'` / `'boolean'`，语法均合法 |
| `W18` 对象列的 `null` 走缺省 | 163 | 对象型为 `null` 时按既定缺省语义 | SQL NULL / `'null'` / `''` 三种来源都补 `{}`，**都不抛** |
| `W19` 数组列写成对象 | 178 | 数组型被写成对象时拒绝 | `story_shots.time_slices` 与 `shot_actions.body_parts` 两处，`actual='object'` |
| `W20` 已是对象/数组同样过校验 | 196 | 数据库原值是对象时也必须校验 | 直接喂 `parseJsonColumn`：`[]`→拒绝、`{}`→拒绝、`{a:1}`/`[1]`/`null`→放行 |
| `W21` 错误信息可定位 | 207 | 表名 + 列名 + 记录标识 + 错误形状 | message 同时含 `shot_actions`/`speed_json`/动作 id/镜头 id/`string`/`对象`；且**不得**误报成"不是合法 JSON" |

`W20` 需要直接调 `parseJsonColumn`，因此该函数改为具名导出（`load-scene.js:77`）。原因写在这里：
SQLite 驱动对这一列永远只返回字符串或 NULL，"已经是对象"的分支**无法从库侧构造**，
不导出就只能靠"删掉判据也不会有测试变红"来假装覆盖。导出面只多这一个函数，
`lib/core/index.js` 未改，生产入口仍是 `solveSceneContinuity()` / `loadSceneInput()`。

## 五、测试执行结果（隔离库）

| 集合 | 文件 | 结果 | 说明 |
|---|---|---|---|
| P6 专项 | `tests/stage3-p6-*.test.mjs`（7 个） | **141 / 141** | 未变 |
| P8 契约专项 | `stage3-p8-contract` | **20 / 20** | 未变 |
| P8 边界专项 | `stage3-p8-boundary` | **30 / 30** | 未变 |
| P8 接线专项 | `stage3-p8-wiring` | **21 / 21**（原 13，新增 8） | 本轮主要交付 |
| P5 专项 | `tests/stage3-p5-*.test.mjs`（4 个） | **105 / 105** | 未变 |
| CK-2 | `stage3-p6-ck` 内的映射断言 | **69 / 69**，双向 `diff` 空（映射 327 / 实际 660） | 未变（本轮不动映射） |
| 全量 | `IC_DATA_DIR=<临时目录> npm test` | **885 / 857 / 17 / 11** | 前值 877 / 849 / 17 / 11 |

## 六、全量与历史 17 条失败基线对比

不是"看着像同一批"，而是可以算平的账：

| 项 | 本轮前 | 本轮后 | 变化 |
|---|---:|---:|---|
| tests | 877 | **885** | +8（新增 `W14`~`W21`） |
| pass | 849 | **857** | **+8** |
| fail | 17 | **17** | **0** |
| skip | 11 | **11** | 0 |

`885 = 877 + 8`、`857 = 849 + 8`、fail 与 skip 一位没动 —— 新增 8 条全过，**没有任何既有用例被本轮改动带红或转绿**。
若本轮把某条原本通过的用例改坏、同时又"意外"修好一条历史失败，fail 仍会是 17，但 pass 就对不上 +8，
所以这个恒等式本身就是"零新增失败"的判据。

17 条失败名单（`sort` 后，与既有基线同一组，仍属 legacy `shots` / 旧 `set_storyboard` / 换装兜底 / `freeComfy` 四类）：

```
freeComfy: POST /free 携带 unload_models + free_memory
narration：内置 Agent 与外部写入 API 同口径，可写旁白
set_storyboard：clear 只清本次写入的章节，别的章节（含已出片镜头）必须保留
set_storyboard：duration 必须当场校验成数字（NaN 落库会让这条分镜永远出不了片）
set_storyboard：同批「自动号在前、显式号在后」不再撞号吞内容
set_storyboard：同批重复 (chapter, idx) 只落一条，镜号归一为 ≥1 整数
set_storyboard：对不上的资产名不再静默丢弃（随结果回报）
set_storyboard：未声明字段当场拒绝（字段拼错不再被静默丢弃）
set_storyboard：章节必须存在（标题与 id 都认），不得写出孤儿分镜
update_shot：时长归一化后才落库（越界裁剪、非数字拒绝）
依赖调度：引用资产未完成的镜头被暂缓，已就绪的镜头照常提交
停止：当前分镜复位为待生成，不再留在「失败」
停止：换装/年龄兜底循环不再逐镜继续出图（每个事件都是一次真提交）
分镜业务校验：台词速度按「真正落库的时长」算，说话人超 2 个拒绝
台词速度校验：两条写入路径共用同一份默认时长（历史 duration=0 的行不许两套上限）
换装兜底：LLM 阶段（renderDisabled）不渲染，推迟到「资产图」阶段执行
自动换装：同章第二次换装事件不被首次结果误判为「已显式引用」
```

本轮改动不触及上述任何链路（读取层只在 `continuity/` 内，且没有任何 legacy `shots` 读路径调用它）。

## 七、数据库读写边界

| 项 | 结果 |
|---|---|
| 真库 `data/ic.db` SHA-256 | `b2ebdb54…d757`（**未变**） |
| 真库 `data/ic.db-wal` SHA-256 | `2711665d…f681`（**未变**） |
| 真库 `data/ic.db-shm` SHA-256 | `22d61103…f3eb`（**未变**） |
| `data/ic.db-shm` mtime | `1795760932`（**未变**，与 D02-15 起同一值） |
| 本轮 DDL / DML | **0 / 0** |
| 测试数据位置 | `IC_DATA_DIR=<mktemp -d>` 临时目录，跑完即弃（`stage3-p8-wiring` 自己再 `mkdtemp` 一层） |

读取层仍是**只读**：本轮只在 `parseJsonColumn()` 内部加了判据，`tx()` 包住的四条 SELECT、
"不读 `shot_states`"、"不产出 `rows[].meta`"三条边界一条没动（`W4`/`W5`/`W10` 仍全绿）。

## 八、明确未做（禁止范围自查）

| 任务书禁止项 | 是否触碰 | 证据 |
|---|---|---|
| 修改 D01 规范 | 否 | `docs/D01` 无 diff |
| 修改 `solve-continuity.js` | 否 | 文件无 diff |
| 修改 `solve-hash.js` 或 Hash 字段 | 否 | 文件无 diff |
| 修改 `assemble-input.js` / `solver-input.js` 来源判据 | 否 | 两文件无 diff |
| 修改 unknown 跨镜传播语义 | 否 | `U-P8-2` 现状锁定用例（`W3`）未改，仍全绿 |
| 新增 DDL / 数据表 / 扩展字段 | 否 | `schema/tables.js`、`schema-manifest.json` 无 diff；真库三 SHA 未变 |
| 提前实施 P9（状态/`carried`/QC 报告持久化） | 否 | `W10` 断言求解后 `shot_states` 仍为 0 行 |
| 借机重构读取层或求解器 | 否 | 读取层只加三个小函数与两处判据；求解器零改动 |

**一处需要审核确认的动作**：`parseJsonColumn` 由模块内私有改为具名导出（仅为让 `W20` 能构造
"已是对象"的输入）。若审核方认为导出面应收紧，替代做法是把该分支改成通过一个
`/* @internal */` 测试钩子暴露，或接受该分支"只能靠代码评审覆盖"。本轮选择导出，理由见 §四末段。

## 九、验收对照

| 任务书要求 | 结论 | 证据 |
|---|---|---|
| `kind === 'array'`：必须是数组 | 达成（原本已有，本轮统一到 `invalidShape()`） | `W19`；§3.4 表 |
| `kind === 'object'`：非 null 非数组的对象 | **达成（本轮修复）** | `W14`/`W15`/`W16`/`W17`；`load-scene.js:98`~`:102` |
| 数组 / 字符串 / 数字 / 布尔 → 抛 `SCENE_INPUT_INVALID_SHAPE` | 达成 | `W15`(array) / `W16`(string) / `W17`(number, boolean) |
| 数据库原值已是对象也要校验 | 达成 | `W20`；`load-scene.js:82`~`:86` |
| `null` / `undefined` / 空串维持既定缺省语义 | 达成 | `W18`（含 `'null'` 一并按缺省，理由见 §3.1 第 3 点） |
| 错误信息含表名 / 列名 / 记录标识 / 错误形状 | 达成 | `W21`；样例见 §3.2 |
| 九个 `shot_actions` 对象字段声明不变、数组语义不变 | 达成 | §3.3；`W14` 逐列断言 |
| 不只测 `JSON.parse` 失败 | 达成 | 8 条新用例全是"语法合法、形状错"，法定失败路径 `INVALID_JSON` 仍由既有 `W9` 覆盖 |

## 十、Git 提交

| 用途 | SHA |
|---|---|
| 代码 + 测试（`load-scene.js` / `stage3-p8-wiring.test.mjs`） | `5dd20f9` |
| 本报告 | `122f302` |

按既有约定：代码提交 → 报告写入代码 SHA → 提交报告 → 回填提交只写报告 SHA（回填自身 SHA 不记录）。

## 十一、遗留（供独立审核裁定）

- **U-P8-5（C）**：`parseJsonColumn` 具名导出使模块对外多一个函数（`lib/core/index.js` 未转发，生产面不可见）。
  若不接受，可按 §八末段的替代方案收回。
- 既有未决项**一个都没动**：`U-P8-2`（显式 `unknown` 沿链传播）、`U-P8-1/3/4`、`U-P6-1`、`U-P5-11/12`、
  `R-28`、`P8-A`（人工标注无持久化位置）。P9 未启动。
