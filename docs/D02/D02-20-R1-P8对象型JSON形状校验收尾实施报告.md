# D02-20-R1 · P8 对象型 JSON 形状校验收尾实施报告

> 对象：`lib/core/continuity/load-scene.js` 的 `parseJsonColumn()`。
> 缺陷：`kind === 'array'` 有形状判据，`kind === 'object'` **没有**；且 `typeof raw === 'object'` 直接
> `return raw`，把"已是对象/数组"的输入整段绕过判据。
>
> 本文件为 **v2**（按重发任务书 §三.1「对象必须是**非 null** 非数组的对象、不允许 null」收紧）；
> v1 曾把 JSON 文本 `'null'` 当作缺省处理，差异与理由见 §十一。两轮的提交 SHA 都记在 §十。
>
> **本报告中的测试数字均为本轮在本机隔离环境实际执行的结果**，不代表独立审核方已执行或认可。

## 一、缺陷原因

三处缺口，都能用"语法完全合法"的数据复现：

| # | 改前行为 | 后果 |
|---|---|---|
| 1 | `kind === 'object'` 无判据，`'[]'` 解析成 `[]` 后直接赋给 `init_state` | 下游 `Object.entries([])` 为空 → 求解器认为"这一镜没有初始状态"，**不报错**，静默算出空结论 |
| 2 | 同上，`'"grab"'` / `'42'` / `'true'` / `'null'` 原样进入镜头对象 | 属性读取全 `undefined`；`??` 兜底把"数据坏了"伪装成"字段缺省" |
| 3 | `typeof raw === 'object'` 直接 `return raw` | 已是数组的 `[]` 冒充对象、已是对象的 `{}` 冒充数组，**连数组判据一起绕过** |

还有一处**更难发现**的：`typeof null === 'object'` 且 `Array.isArray(null) === false`。
只写 `typeof v !== 'object' || Array.isArray(v)` 这一句，JSON 文本 `'null'` 会被判成合法对象放行——
"看起来写了 null 判断、实际没挡住"，属于典型的"校验存在 ≠ 校验有效"。

共同点：四类都发生在 `JSON.parse` **成功之后**。只测"坏 JSON 会抛"（D02-20 的 `W9`）永远测不到它们，
所以本轮新增用例全部构造"语法合法、形状错"的数据。

## 二、修改文件清单

| 文件 | 状态 | 行数 | 改动 |
|---|---|---:|---|
| `lib/core/continuity/load-scene.js` | 修改 | 217（原 167） | 新增 `shapeOf()` / `locatorOf()` / `invalidShape()`；`parseJsonColumn()` 两类型分别判据、两条输入路径都校验；`toSolverAction()` 传 `shot`；函数改为具名导出 |
| `tests/stage3-p8-wiring.test.mjs` | 修改 | 462（原 309） | 新增 `seedAction()` 夹具 + `W14`~`W22` 九条（接线专项 13 → **22**） |
| `docs/D02/D02-20-R1-P8对象型JSON形状校验收尾实施报告.md` | 重写 | 本文件 | — |

未修改：D01 全部、`lib/core/schema/tables.js`（DDL）与 `schema-manifest.json`、`solve-continuity.js`、
`solve-hash.js` 及其 Hash 字段、`assemble-input.js` / `solver-input.js` 的来源判据、`unknown` 跨镜传播语义、
`lib/core/index.js`（导出面未变）、P5 `validate/`、P6 `qc/deps/`。

## 三、实现

### 3.1 一个入口，两条路径都校验（`load-scene.js:77`）

```js
export function parseJsonColumn(raw, meta) {
  const { table, column, key, kind } = meta;
  if (raw === null || raw === undefined || raw === '') return null;   // 缺省语义：只对原始值生效

  let v;
  if (typeof raw === 'object') {
    v = raw;                          // 路径 B：调用方/驱动已给对象 —— 不 return，往下走同一套判据
  } else {
    try {
      v = JSON.parse(String(raw));    // 路径 A：TEXT 列
    } catch (e) {
      throw solveError(               // 语法坏 → INVALID_JSON
        `${table}.${column} 不是合法 JSON（${locatorOf(meta)}，前 40 字符：${String(raw).slice(0, 40)}）`,
        { reason: 'SCENE_INPUT_INVALID_JSON', table, column, key },
      );
    }
  }

  if (kind === 'object') {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw invalidShape(meta, shapeOf(v));
    return v;
  }
  if (!Array.isArray(v)) throw invalidShape(meta, shapeOf(v));
  return v;
}
```

要点：

1. **路径 B 不再提前返回**。改前是 `if (typeof raw === 'object') return raw;`，这行让"已是对象"的输入
   完全不受判据约束；现在两条路径汇合到同一个 `if (kind === ...)` 出口，判据只有一份。
2. **对象判据三个条件缺一不可**：`v === null`（挡住 `'null'`）、`typeof v !== 'object'`（挡住字符串/数字/布尔）、
   `Array.isArray(v)`（挡住 `[]`）。`typeof [] === 'object'` 是这个函数里最容易踩的陷阱。
3. **数组判据保持原样**：`!Array.isArray(v)` 即抛。对象输入走同一行，所以"数组列被写成对象"也一并覆盖。

### 3.2 对象型 / 数组型字段的校验逻辑

| kind | 合法 | 拒绝 → `SCENE_INPUT_INVALID_SHAPE` | 缺省（原始值 `null` / `undefined` / `''`） |
|---|---|---|---|
| `object` | 普通对象 `{...}` | `[]`、`"x"`、`42`、`true`、`null`（列里存文本 `'null'` 时解析出来同样是 `null`，一并拒） | `{}` |
| `array` | 数组 `[...]` | `{}`、`"x"`、`42`、`true`、`null` | `[]` |

本轮生效后的全表（列名一个没改，只是补上"对象"这一侧判据）：

| 表 | 列 | kind | 缺省 |
|---|---|---|---|
| `story_shots` | `speakers` `time_slices` `cam_path` `voice_ids` | array | `[]` |
| `shot_blockings` | `position_track` | array | `[]` |
| `shot_actions` | `init_state` `trigger_json` `path_json` `force_json` `speed_json` `contact_json` `result_json` `end_state` `sync_json` | object | `{}` |
| `shot_actions` | `body_parts` | array | `[]` |

### 3.3 错误信息四要素

```js
function locatorOf({ key, shot }) {          // load-scene.js:38
  const id = key === null || key === undefined || key === '' ? '(空 id)' : String(key);
  const parent = shot === null || shot === undefined || String(shot) === id ? '' : ` · 镜头 ${shot}`;
  return `记录 ${id}${parent}`;
}

function invalidShape(meta, actual) {        // load-scene.js:45
  const want = meta.kind === 'array' ? '数组' : '对象';
  return solveError(
    `${meta.table}.${meta.column} 应为${want}，实际为 ${actual}（${locatorOf(meta)}）`,
    { reason: 'SCENE_INPUT_INVALID_SHAPE', table: meta.table, column: meta.column,
      key: meta.key, kind: meta.kind, actual, ...(meta.shot !== undefined ? { shot: meta.shot } : {}) },
  );
}
```

实际消息：

```
shot_actions.speed_json 应为对象，实际为 string（记录 act_r1_3 · 镜头 sh_3f2a91）
```

四要素：表名 `shot_actions`、列名 `speed_json`、记录标识 `act_r1_3`（附所属镜头 `sh_3f2a91`）、
实际形状 `string`。动作行有自己的 id，只给动作 id 定位不到镜头，所以 `toSolverAction()` 统一带 `shot`。

形状名由 `shapeOf()`（`load-scene.js:31`）收口为 `null` / `array` / `string` / `number` / `boolean` / `object`。
必须把 `array` 与 `object` 分开报——否则"实际为 object"这句话对 `[]` 和 `{}` 同样成立，等于什么也没说。

### 3.4 九个对象字段声明不变

`ACTION_JSON_OBJ_COLS` 仍是原来那 9 个，`ACTION_JSON_ARRAY_COLS` 仍是 `body_parts`；
`story_shots` 四个数组列、`shot_blockings.position_track` 未动。改动只是给既有声明**补上对象侧判据**，
没有增删列、没有改字段名、没有改数组语义。

## 四、新增测试（`stage3-p8-wiring.test.mjs:97`~`:231`）

全部走**真实 sqlite**（`mkdtemp` 隔离库 + `createUserProject` + 直写 `shot_actions`），不是内存夹具。
任务书 §四 的 10 条要求逐条对应：

| 任务书要求 | 用例 | 行 | 断言要点 |
|---|---|---:|---|
| 1 合法 JSON 对象通过 | `W14` | 97 | 9 个对象列逐个 `deepEqual`；`body_parts` 仍为数组；`result`/`contact` 别名与源列**同一引用** |
| 2 JSON 数组拒绝 | `W15` | 124 | `reason=SCENE_INPUT_INVALID_SHAPE`、`table/column/key/shot/actual` 五项全对 |
| 3 JSON 字符串拒绝 | `W16` | 142 | `actual='string'` |
| 4 JSON 数字拒绝 | `W17` | 151 | `actual='number'` |
| 5 JSON 布尔值拒绝 | `W17` | 151 | 同一循环第二例，`actual='boolean'` |
| 6 **直接传数组对象**拒绝 | `W20` | 194 | `parseJsonColumn([], {kind:'object'})` → 抛，`actual='array'` |
| 7 **直接传普通对象**通过 | `W20` | 194 | `parseJsonColumn({a:1}, {kind:'object'})` → 原样返回 |
| 8 `null` / `undefined` / 空串维持缺省 | `W18` | 163 | SQL NULL → `{}`、`''` → `{}`、`undefined` → `null`（不被当成形状错误） |
| 9 数组型字段传对象拒绝 | `W19` | 176 | `story_shots.time_slices='{}'` 与 `shot_actions.body_parts='{"a":1}'` 两处 |
| 10 错误信息可定位 | `W21` | 205 | message 同时含表名/列名/动作 id/镜头 id/`string`/`对象`，且**不**误报 `INVALID_JSON` |
| 补充：JSON 文本 `'null'` | `W22` | 218 | 被拒且 `actual='null'`；对照原始值 `null` 仍走缺省 |

说明两点：

- `W20` 需要直接喂"已是对象"的输入，因此 `parseJsonColumn` 改为具名导出（`load-scene.js:77`）。
  SQLite 驱动对这一列永远只返回字符串或 NULL，该分支**无法从库侧构造**；不导出就只能靠
  "删掉判据也不会有测试变红"来假装覆盖。`lib/core/index.js` 未转发，生产面仍只有
  `solveSceneContinuity()` / `loadSceneInput()`。
- `W22` 与 `W18` 是**成对**的：前者证明"解析出的 null 是形状错误"，后者证明"原始值 null 是缺省"。
  两者混在一起写，就会出现 v1 那种"改了一行判据就悄悄改了语义"的情况。

## 五、测试执行结果（隔离库）

| 测试组 | 基线 | 本轮 | 结论 |
|---|---:|---:|---|
| P6 专项（7 文件） | 141 | **141 / 141** | 无变化 |
| P8 契约专项 | 20 | **20 / 20** | 无变化 |
| P8 边界专项 | 30 | **30 / 30** | 无变化 |
| P8 接线专项 | 13 | **22 / 22**（+9） | 本轮新增 `W14`~`W22` 全过 |
| P5 专项（4 文件） | 105 | **105 / 105** | 无变化 |
| CK-2 | 69 条规则 | **69 / 69**，双向 `diff` 空（映射 327 / 实际 660） | 无变化（本轮不动映射） |

## 六、全量测试与历史 17 条失败

```
IC_DATA_DIR=C:\Users\Administrator\AppData\Local\Temp\tmp.GLAaOEi2j3 npm test
# tests 886   # pass 858   # fail 17   # skipped 11
```

| 项 | D02-20 基线 | 本轮 | 变化 |
|---|---:|---:|---|
| tests | 877 | **886** | +9（`W14`~`W22`） |
| pass | 849 | **858** | **+9** |
| fail | 17 | **17** | **0** |
| skip | 11 | **11** | 0 |

`877+9=886`、`849+9=858`、fail 与 skip 一位没动 —— 新增 9 条全过，**没有任何既有用例被带红或转绿**。
这个恒等式本身就是"零新增失败"的判据：若本轮改坏一条通过用例、又"意外"修好一条历史失败，
fail 仍是 17，但 pass 就对不上 +9。

此外做了**逐条名单 diff**：把 v2 全量跑出的 `not ok` 名单与 v1 全量跑出的名单各自 `sort` 后
`diff`，结果**为空**——17 条完全同名，不是"数量碰巧一样"：

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

17 条仍属 legacy `shots` 读路径 / 旧 `set_storyboard` / 换装兜底 / `freeComfy` 四类。
本轮改动位于 `continuity/` 读取层，上述链路没有任何一处调用它（`loadSceneInput` 只被
`solve-scene.js`、路由与测试引用）。

## 七、数据库读写边界

| 项 | 结果 |
|---|---|
| `data/ic.db` SHA-256 | `b2ebdb54…d757`（**未变**） |
| `data/ic.db-wal` SHA-256 | `2711665d…f681`（**未变**） |
| `data/ic.db-shm` SHA-256 | `22d61103…f3eb`（**未变**） |
| `data/ic.db-shm` mtime | `1795760932`（**未变**，与 D02-15 起同一值） |
| 本轮 DDL / DML | **0 / 0** |
| 测试数据位置 | `IC_DATA_DIR=<mktemp -d>` 临时目录；`stage3-p8-wiring` 内部再 `mkdtemp` 一层 |

读取层仍然**只读**：`tx()` 包住的四条 SELECT、"不读 `shot_states`"、"不产出 `rows[].meta`"三条边界没动，
`W4` / `W5` / `W10` 全绿。

## 八、禁止范围自查

| 禁止项 | 是否触碰 | 证据 |
|---|---|---|
| 修改 D01 正式规范 | 否 | `docs/D01` 无 diff |
| 修改 `solve-continuity.js` | 否 | 无 diff |
| 修改 `solve-hash.js` 或 Hash 字段范围 | 否 | 无 diff |
| 修改 `assemble-input.js` / `solver-input.js` 来源判据 | 否 | 两文件无 diff |
| 修改 `unknown` 跨镜传播语义 | 否 | `U-P8-2` 现状锁定用例（`W3`）未改，仍全绿 |
| 修改 DDL / 扩展表或字段 | 否 | `schema/tables.js`、`schema-manifest.json` 无 diff；真库三 SHA 未变 |
| 提前实施 P9（状态 / `carried` / QC 报告持久化） | 否 | `W10` 断言求解后 `shot_states` 仍为 0 行 |
| 重构 P8 真实数据流接线 | 否 | 读取层只加三个小函数与两处判据；调用链未动 |
| 新增外围规则 / Skill / 无关测试体系 | 否 | 仅 `stage3-p8-wiring` 增 9 条 |

`git diff --stat` 只有两个文件：`load-scene.js`、`stage3-p8-wiring.test.mjs`。

## 九、验收对照（任务书 §八）

| 验收标准 | 结论 | 证据 |
|---|---|---|
| 对象型字段不再接受数组和基本类型 | 达成 | `W15`/`W16`/`W17`/`W20`；`load-scene.js:102` |
| 原始对象与 JSON 字符串两条路径均执行形状校验 | 达成 | `W20`（路径 B）+ `W15`~`W17`（路径 A）；`load-scene.js:82`~`:86` 不再提前返回 |
| 数组型字段原有校验不退化 | 达成 | `W19`；坏 JSON 用例 `W9` 仍绿 |
| 缺省语义保持不变 | 达成（仅原始值） | `W18`：NULL / `undefined` / `''` → `{}`；`W22`：解析出的 `null` 属形状错误 |
| 错误信息可定位具体数据来源 | 达成 | `W21`；样例见 §3.3 |
| 新增测试全部通过 | 达成 | 22 / 22 |
| P6 / P8 / P5 / CK-2 回归无新增失败 | 达成 | 141 / 72 / 105 / 69，全绿 |
| 全量历史失败没有新增或恶化 | 达成 | 886 / 858 / 17 / 11；17 条名单 `diff` 为空 |
| 未越界规范 / Hash / 求解器 / DDL / P9 | 达成 | §八 九项逐条「否」 |

## 十、Git 提交

| 版本 | 用途 | SHA |
|---|---|---|
| v1 | 代码 + 测试（`W14`~`W21`，`'null'` 按缺省） | `5dd20f9` |
| v1 | 报告 | `122f302` |
| v1 | 回填 | `1cc710f` |
| v2 | 代码 + 测试（新增 `W22`，`'null'` 收紧为形状错误） | `ba1c6d7` |
| v2 | 本报告 | `1b32798` |

规则：代码提交 → 报告写入代码 SHA → 提交报告 → 回填提交只写报告 SHA（回填自身 SHA 不记录）。

## 十一、与 v1 的差异（供审核确认）

| 输入 | v1 行为 | v2 行为 | 依据 |
|---|---|---|---|
| 列里存文本 `'null'`（对象型列） | 当作缺省 → `{}` | **抛 `SCENE_INPUT_INVALID_SHAPE`，`actual='null'`** | 重发任务书 §三.1：「对象必须是**非 null**、非数组的对象」「不允许 null」 |
| 原始值 `null`（SQL NULL） | `{}` | `{}`（不变） | 任务书 §三.4 缺省语义 |
| `undefined` / `''` | `{}`（由调用方补） | 不变 | 同上 |

为什么这样切：缺省语义的对象是**列里没有内容**（原始值 NULL / 空串），而文本 `'null'` 是**有内容、
内容是空值**——把它当缺省，等于允许写入侧用 `JSON.stringify(null)` 绕过形状契约。反过来说，
若审核方认为 `'null'` 也应视作缺省，需把 `load-scene.js:102` 的 `v === null` 条件撤掉并删除 `W22`，
但那样 `typeof null === 'object'` 的漏网会重新出现，必须另补显式判据。

影响面：`shot_actions` 在 `lib/` 内**没有任何生产写入路径**（只有 `db.js` 的级联删除），DDL 默认值是
`'{}'`，因此"库里已有 `'null'` 文本"在当前代码中不会产生；本轮收紧不改变任何现存数据。

## 十二、遗留（不动，等审核）

- **U-P8-5（C）**：`parseJsonColumn` 具名导出使模块对外多一个函数（`core/index.js` 未转发）。
  若不接受，可改为测试钩子，或接受该分支只能靠代码评审覆盖。
- 既有未决项一个都没动：`U-P8-2`（显式 `unknown` 沿链传播）、`U-P8-1/3/4`、`U-P6-1`、`U-P5-11/12`、
  `R-28`、`P8-A`（人工标注无持久化位置）。**P9 未启动。**
