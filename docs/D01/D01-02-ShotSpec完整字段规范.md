# D01-02 ShotSpec 完整字段规范（第四轮修订）

> **本文是 D01 全系列唯一的字段字典。** 其他文档只引用，不重复定义。
> 引用方式：`D01-02 §D`（分区）、`D01-02 §F.speakers`（单字段）。
> 修订轮次：V4，修订点见 `D01-10`（V3 见 `D01-09`）。V4 修正：`voice_ids` 降为派生字段、音色权威归 `shot_assets`（P1-05）；适配层表列数重数（P1-01/02）；新增 V-23/V-24。V3 的米制坐标、合法切点、废止旧时长校验保留。

---

## 〇、四类数字必须分清（V3 新增第四类）

评审要求区分「业务字段 / 持久化列 / 关联表字段」。本文所有计数按此口径：

| 口径 | 定义 | 本模型数值 |
|---|---|---|
| **业务字段** | 表达导演创作语义的字段，不含主键、外键、时间戳、版本戳 | **41** |
| **持久化列** | `story_shots` 表实际列数（业务字段 + 主键 + 工程列） | **48** |
| **关联表字段** | 从表列数（含主键与外键），不等于业务字段 | `shot_blockings` 20（2 键 + 18 业务）/ `shot_actions` 22（2 键 + 20 业务）/ `shot_states` 8（含 V3 新增 `meta`）/ `shot_assets` 6 / `scene_states` 14 |
| **适配层表**（不属于 ShotSpec） | 切分与产物，不参与任何创作字段计数 | `render_adaptations` **17** / `render_units` **13** / `render_unit_shots` 8（V4 逐列重数，见 `D01-05 §4.7/§4.14`） |

**主表业务字段 41 = A8 + B5 + C3 + D14 + F6 + J5**

上一版称"47 字段"是混算（把从表字段与主表字段相加），V2 已废止该口径。

---

## 一、A 区 · 标识与归属（8 业务字段 + 主键 `id`）

| 字段 | 类型 | 必填 | 默认 | 范围/枚举 | 写方 | 读方 | 校验 |
|---|---|---|---|---|---|---|---|
| `id` | TEXT PK | ✅ | — | `sh_<ulid>` | 创作层 | 全部 | 唯一 |
| `project_id` | TEXT | ✅ | — | — | 创作层 | 全部 | 存在性 |
| `chapter_id` | TEXT | ✅ | — | — | 创作层 | 全部 | 存在性 + 同项目 |
| `scene_key` | TEXT | ✅ | — | — | 创作层 | 连续性/编译 | 存在 `scene_states` |
| `scene_id` | TEXT | ⭕ | `''` | — | 创作层 | 编译 | category=scene |
| `shot_no` | INT | ✅ | — | ≥1 | 创作层 | UI/导出 | 场内唯一 |
| `global_no` | INT | ✅ | — | ≥1 | 创作层 | 全部 | 集内唯一 |
| `beat_key` | TEXT | ⭕ | `''` | — | 创作层 | UI | 存在则须在锁档 |
| `prev_shot_id` | TEXT | ⭕ | `''` | — | 创作层 | 连续性 | 存在 + 同项目 |

**`chapter_id` 用 id 而非标题**：实测 `shots.chapter` 存的是标题（`"第1章"`，13 条命中 `chapters.title`、0 条命中 `chapters.id`）。基线代码在章节 PATCH 中做了事务同步（`D01-05 §3.2`），当前不会脱章；新表用 id 消除这个耦合。

---

## 二、B 区 · 剧作意图（5 业务字段）

| 字段 | 类型 | 必填 | 默认 | 枚举/范围 | 写方 | 校验 |
|---|---|---|---|---|---|---|
| `purpose` | ENUM | ✅ | `advance` | `establish`/`advance`/`react`/`reveal`/`turn`/`close`/`insert` | 创作层 | 枚举；同 `beat_key` 全 `react` → WARN |
| `dramatic_value` | INT | ⭕ | `0` | -10 ~ +10 | 创作层 | 范围 |
| `info_delta` | TEXT | ⭕ | `''` | ≤80 字 | 创作层 | 长度 |
| `dialogue_function` | ENUM | ⭕ | `''` | `inform`/`persuade`/`probe`/`threaten`/`confess`/`deflect`/`none` | 创作层 | 枚举 |
| `is_insert` | BOOL | ✅ | `0` | 0/1 | 创作层 | 见 §2.1 |

### 2.1 `is_insert` 与台词的联动（修订 P1-2）

上一版规定「`purpose=insert` 时 `dialogue` 必须为空」。**该规则废止。**

真实情况：空镜/插入镜可以带台词——画外音、旁白、电话音、回忆对白、上一场声音延续。

**修正规则**：

```
is_insert = 1 时：
  ├ 允许 dialogue 非空，但 speakers 必须全部为非在场类型
  │   （off_screen / phone / narrator），且对应角色 in_frame=0
  ├ 若 speakers 含 on_screen 且该角色 in_frame=1 → FAIL（空镜里不可能有在场人开口）
  └ dialogue 与 speakers 都空 → 合法（纯空镜）

is_insert = 0 时：不限制
```

`is_insert` 由 `purpose=insert` 自动置 1，也可独立置 1（`purpose=advance` 但本镜是插入特写）。

---

## 三、C 区 · 画面内容（3 业务字段）

| 字段 | 类型 | 必填 | 默认 | 写方 | 校验 |
|---|---|---|---|---|---|
| `visual_content` | TEXT | ✅ | `''` | 创作层 | 非空；景别-内容相容（V-05） |
| `composition` | TEXT | ⭕ | `''` | 创作层 | 自由文本（本镜构图备注） |
| `lighting` | TEXT | ⭕ | `''` | 创作层 | 自由文本（光源/色温/影调） |

**与 `composition_rule` 的分工**：`composition_rule` 是枚举（可统计），`composition` 是这一镜的具体构图描述（人读）。

---

## 四、D 区 · 摄影（14 业务字段，重构）

上一版 8 字段无法支撑越轴计算（评审 P0-3）。V2 引入**摄影机空间模型**：机位必须有坐标、朝向、高度、距离、侧别、轨迹、滚转。

### 4.0 坐标与几何约定（P1-03 新增，几何计算的唯一前提）

**没有这四条约定，D 区的数值无法被任何程序正确使用。**

| # | 约定 | 内容 |
|---|---|---|
| G1 | **世界坐标系** | 右手系，`+Z` 向上（世界 up），地面为 `XY` 平面，**单位米** |
| G2 | **`cam_pos` 用米，不用归一化** | V2 写"归一化 0–1"，与 `cam_distance_m`（米）、`distance_to_camera`（米）混用会算出错误几何。V3 统一为**米制世界坐标** |
| G3 | **`cam_target` 必须可解析为坐标** | 允许写实体 id（`as_char_harold` / `fx_table`），由程序取其 `anchor_point`；不允许只写"床的方向"这类描述 |
| G4 | **侧别是派生值，不存字段** | `norm_xyz` 与 `cam_pos` 都在米制下可换算后，侧别由 `D01-04 §6.3` 的 `axisSide()` 现算。**V2 §4.6 引用的 `cam_axis_side` 字段并不存在于本表**，属悬空引用，V3 删除该引用 |

**归一化 ↔ 米的换算**（唯一换算点，其他文档只引用）：

```
P_m  = P_norm ⊙ active_area          // active_area = [width_m, depth_m, height_m]
P_norm = P_m ⊘ active_area
```

`active_area` 存于 `scene_states.coord_system`。缺它时，任何"归一化距离 → 米"的换算都不可做，`cam_distance_m` 只能人工填。

**滚转符号待校定**：`cam_roll_deg > 0` 约定为"画面顺时针倾斜（地平线左端上抬）"，但不同渲染器对 dutch 正负的约定不一致。实施第一步必须用测试图（`+10°`）校定，结论写进 `target_profiles.roll_sign_verified`。**未校定时所有含滚转的镜头只算不滚转近似，并标 `ROLL_UNVERIFIED`**（`D01-04 §11 S-22`）。

| # | 字段 | 类型 | 必填(S级) | 默认 | 单位/范围 | 说明 |
|---|---|---|---|---|---|---|
| D1 | `shot_size` | ENUM | all | — | 9 档（§4.1） | 景别 |
| D2 | `cam_direction` | ENUM | all | — | 5 值（§4.2） | 方向轴 |
| D3 | `cam_height` | ENUM | all | — | 8 值（§4.3） | 高度轴（**已移除 dutch**） |
| D4 | `cam_roll_deg` | REAL | S2+ | `0` | -20 ~ +20 | 滚转/画面倾斜（荷兰角），符号见 §4.0 |
| D5 | `cam_pos` | JSON | **S2+** | `null` | `{x,y,z}` **米制世界坐标**（§4.0 G1/G2） | 机位光学中心 |
| D6 | `cam_target` | TEXT/JSON | S1+ | `''` | 实体 id 或 `{x,y,z}`（§4.0 G3） | 机位观察目标 |
| D7 | `cam_distance_m` | REAL | S2+ | `null` | 0.3 ~ 30 | 机位到主主体距离（米） |
| D8 | `lens_mm` | INT | ⭕ | `0` | 8 ~ 300 | 焦段 |
| D9 | `fov_deg` | REAL | ⭕ | `null` | 5 ~ 120 | 水平视场角（可由 lens 推算，存冗余供校验） |
| D10 | `movement` | ENUM | ✅ | `static` | 21 值（§4.4） | 运镜方式 |
| D11 | `movement_amp` | ENUM | ✅ | `none` | `none`/`micro`/`normal`/`large` | 运镜幅度 |
| D12 | `cam_path` | JSON | S3+ | `[]` | `[{t,x,y,z}]`（米制） | 运镜轨迹采样点（`static` 时为空） |
| D13 | `composition_rule` | ENUM | ⭕ | `''` | 7 值（§4.5） | 构图法 |
| D14 | `cam_note` | TEXT | ⭕ | `''` | — | 机位原生描述（人读，不参与机检） |

### 4.1 `shot_size` 景别（9 档有序）

`extreme_wide`(1) → `wide`(2) → `full`(3) → `medium_full`(4) → `medium`(5) → `medium_close`(6) → `close`(7) → `close_up`(8) → `extreme_close`(9)

来源：`short-drama-camera-system.md` §一。序位用于"相邻档"与"段缝同档"判定。

### 4.2 `cam_direction` 方向轴（5 值）

`front` / `three_quarter` / `profile` / `over_shoulder` / `pov`

### 4.3 `cam_height` 高度轴（8 值，修订 P0-3）

`eye` / `slight_low` / `slight_high` / `low` / `high` / `extreme_low` / `extreme_high` / `bird_eye`

> **修订说明**：上一版把 `dutch`（荷兰角）列入高度轴，**归类错误**。荷兰角是摄影机绕**镜头光轴滚转**（roll），既不改变机位高度也不改变机位位置。V2 移除 `dutch`，改用 `cam_roll_deg` 表达；"荷兰角 ≤1 镜/集"的配额改为统计 `cam_roll_deg ≠ 0` 的镜数。
>
> 上一版称本枚举为"7 值"是笔误，正确为 **8 值**（`eye`、`slight_low`、`slight_high`、`low`、`high`、`extreme_low`、`extreme_high`、`bird_eye`）。

### 4.4 `movement` 运镜（21 值）

| 类 | 值 |
|---|---|
| 静止 | `static` |
| 平移 | `pan_left` `pan_right` `truck_left` `truck_right` `pedestal_up` `pedestal_down` |
| 纵深 | `dolly_in` `dolly_out` `tracking` `crane` `arc` `jib` |
| 变焦 | `zoom_in` `zoom_out` `snap_zoom` `dolly_zoom`（全片 ≤1） |
| 手持 | `handheld_light` `handheld` `handheld_shaky` |
| 特殊 | `snorricam` `long_take` |

### 4.5 `composition_rule` 构图法（7 值）

`center` / `rule_of_thirds` / `symmetry` / `frame_in_frame` / `foreground_occlusion` / `negative_space` / `diagonal`

### 4.6 摄影机数据完整度四级（越轴可信度）

机位数据不是"全有或全无"。而且**两个检测器的输入需求不同**，必须分开看（`D01-04 §6`）：

| 级别 | `AXIS_SIDE` 需要 | `SCREEN_LR` 需要 | 可出级别 |
|---|---|---|---|
| **P-A 完整** | `cam_pos` + `axis_line` + `active_area` | 再加 `cam_target` + 基向量非退化 + **`roll_sign_verified=true`** | FAIL / WARN / PASS |
| **P-B 半完整** | 同上 | 缺 `cam_target` 或滚转未校定 | **最高 WARN** |
| **P-C 仅枚举** | 只有 `cam_direction` / `cam_height` | — | `AXIS_UNVERIFIED` + `SCREEN_LR_UNVERIFIED`（INFO） |
| **P-D 缺失** | 都没有 | — | 同上（INFO） |

**V3 修正两处悬空**：

1. V2 的 P-A 条件写了 `cam_axis_side`——**这个字段不在 D 区 14 字段里**（§4 表可查）。侧别是派生值（§4.0 G4），不是要填的字段。V3 改为"`cam_pos` + `axis_line` + `active_area`"。
2. V2 的 P-B 写"可算，最高只到 WARN"，但没说 WARN 针对哪个检测器。V3 明确：`AXIS_SIDE` 在 P-B 仍可算出侧别，只是 `SCREEN_LR` 不可用——所以 P-B 下**能判"机位换侧"，不能判"画面左右翻转"**。

> 实测历史 66 条分镜的 `camera` 全是文本（如「中景 · 50mm · 侧45度 · 固定」），无任何坐标字段 → 全部处于 **P-C 或 P-D**。因此越轴检测对历史数据**一律输出"无法验证"，绝不输出 PASS**。

---

## 五、E 区 · 表演与动作（从表，见 `D01-03`）

`shot_actions` **22 列**（含 `id` / `shot_id`）。业务字段 20 个，字段表与计算规则唯一出处：`D01-03 §3`。

主表**不设**情绪/表情字段——表演属于动作，放主表会与 `shot_actions` 重复。

---

## 六、F 区 · 声音（6 业务字段，修订 P1-1）

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `dialogue` | TEXT | ⭕ | `''` | 台词原文，保留原语言 |
| `speakers` | JSON | ⭕ | `[]` | **结构化说话人**（§6.1） |
| `narration` | TEXT | ⭕ | `''` | 旁白口播稿 |
| `sfx` | TEXT | ⭕ | `''` | 现场音效/环境声 |
| `music_cue` | TEXT | ⭕ | `''` | 配乐提示 |
| `voice_ids` | JSON | ⭕ | `[]` | **派生兼容字段（只读）**：由 `shot_assets(role='voice')` 渲染，不单独维护 |

### 6.1 `speakers` 结构（修订 P1-1）

上一版只有 `speaker_ids`（id 数组），无法表达"这句话是谁、在哪说的"。V2 改为对象数组：

```json
[
  { "id": "as_char_harold", "type": "on_screen",  "line_from": 0, "line_to": 0 },
  { "id": "as_char_kaisen", "type": "off_screen", "line_from": 1, "line_to": 1 },
  { "id": "",               "type": "phone",      "source": "as_char_doctor", "line_from": 1, "line_to": 1 },
  { "id": "as_char_roxanne","type": "narrator",   "line_from": 0, "line_to": 0 }
]
```

| `type` | 含义 | 附加必填 | 校验 |
|---|---|---|---|
| `on_screen` | 画内开口 | `id` | 该角色 `shot_blockings.in_frame=1` |
| `off_screen` | 画外开口（在场但不在画内） | `id` | 该角色 `in_frame=0` 且已登记 |
| `phone` | 电话/对讲/远程 | `source` | 画内无此角色；须说明声源 |
| `narrator` | 旁白 | `id` | `narration` 非空 |
| `dub` | 配音/译制/内心替声 | `id` + `dub_of` | `dub_of` 指向被替声角色 |

`line_from` / `line_to`：该说话人对应台词的句序号区间（从 0 起），用于一句台词多人分说。

**人数上限**：`on_screen` + `off_screen` 合计 ≤2（沿用现有限制）；`narrator` / `phone` / `dub` 不计入。

**校验联动**：
- `on_screen` 但 `in_frame=0` → FAIL
- `off_screen` 但 `in_frame=1` → FAIL
- `phone` 且 `source` 角色在画内 → WARN

---

### 6.2 音色的唯一权威（P1-05）

V3 有两个地方能表达"这一镜用哪个音色"：`shot_assets(role='voice')` 和 `story_shots.voice_ids`。两个都当权威，就会出现"改一处漏另一处"，而 `sourceSpecHash` 只看得见其中一处。

**V4 定案**：

| 位置 | 角色 | 谁能写 |
|---|---|---|
| `shot_assets(role='voice')` | **唯一权威**。带 `order_no`（编译时定 `@图片N`）与资产指纹 | 创作层 |
| `story_shots.voice_ids` | **派生只读**。由权威按 `order_no` 渲染成一维 id 数组，供旧页面/旧 API 读 | 程序（读出时现算） |

**三条规则**：

1. **写入只写 `shot_assets`**。任何代码不得直接 `UPDATE story_shots SET voice_ids=...`；
2. **hash 只读 `shot_assets` + 指纹**，`voice_ids` 不进 payload（`D01-06 §4.2`）；
3. **校验 V-23**：`voice_ids` 与关联表渲染结果不一致 → FAIL，说明有人绕过了权威列。

**历史数据**：`voice_ids` 原值保留不动。首次结构化（M3/B2）时转成 `shot_assets(role='voice')` 行，此后 `voice_ids` 由程序在读出时覆盖成渲染结果——**不丢信息，但不再是事实来源**。

---

## 七、G 区 · 空间（从表，见 `D01-04`）

`shot_blockings` **20 列**（含 `shot_id` / `character_id` 两键）。业务字段 18 个，字段表唯一出处：`D01-04 §4`（含 `position_track` 镜内轨迹）。

---

## 八、H 区 · 首尾状态（从表，见 `D01-04`）

`shot_states` **7 列**。字段唯一出处：`D01-04 §5`。

---

## 九、I 区 · 资产引用（关联表，修订 P1-7）

上一版主表有 6 个 `*_ids` JSON 列 + `ref_pack`，同时又提到 `shot_assets`，两套并存。评审要求统一。V2 定案：

**唯一方案 = `shot_assets` 关联表 + 主表零 JSON 资产列。**

```sql
CREATE TABLE shot_assets (
  shot_id    TEXT NOT NULL,
  asset_id   TEXT NOT NULL,
  role       TEXT NOT NULL,      -- character/scene/prop/costume/age/voice/audio/ref
  order_no   INTEGER DEFAULT 0,  -- 参考图编号顺序（编译时定 @图片N）
  variant_of TEXT DEFAULT '',    -- 变体归属（服装/年龄变体指向基础角色）
  PRIMARY KEY (shot_id, role, asset_id)
);
```

| role | 取值来源 | 约束 |
|---|---|---|
| `character` | `category=character` | 同一 shot 内唯一 |
| `scene` | `category=scene` | — |
| `prop` | `category=prop` | 与 `hand_state` 引用一致 |
| `costume` | `category=costume` | **同一角色每镜只一件**（按 `variant_of` 校验） |
| `age` | `category=age` | 同角色每镜只一个，且不与 costume 同时引用同角色 |
| `voice` | `category ∈ {voice, narration}` | ≤3 |
| `audio` | `category ∈ {music, sfx, audio}` | — |
| `ref` | 任意 | `order_no` 定 `@图片N` 编号 |

**为什么从 JSON 列改为关联表**：

| 维度 | 6 个 JSON 列（V1） | `shot_assets`（V2） |
|---|---|---|
| 查"某角色出现在哪些镜" | 全表 `LIKE '%id%'` | 索引直查 |
| 外键约束 | 无 | 可加 FK |
| 参考图顺序 | `refs` 混存 | `order_no` 明确 |
| 变体归属 | 隐含在 id 命名 | `variant_of` 显式 |
| 编译取参考包 | 遍历 6 列合并 | 一次 JOIN 排序 |

**兼容读**：旧 `shots` 的 6 个 `*_ids` 不动；新代码读 `shot_assets`，为空时回退旧列（`D01-05 §4`）。

---

## 十、J 区 · 时间（5 业务字段，修订 P1-3）

| 字段 | 类型 | 必填 | 默认 | 单位 | 说明 |
|---|---|---|---|---|---|
| `story_duration` | REAL | ✅ | — | 秒 | 导演设计时长，**无模型上限**，建议 1.5–12 |
| `time_slices` | JSON | ⭕ | `[]` | 秒 | `[{from,to,what,kind}]`，`kind ∈ action/hold/dialogue` |
| `speed_ramp` | ENUM | ⭕ | `none` | — | `none`/`slow_in`/`slow_out`/`hold`/`ramp` |
| `is_cut_point` | BOOL | ✅ | `1` | — | **导演剪辑点**（§10.1） |
| `time_jump` | BOOL | ✅ | `0` | — | 与前镜之间有剧情时间跳跃（允许状态重设） |

### 10.1 三种"断开"必须区分（修订 P1-3）

上一版把 `is_cut_point` 当成"能不能切单元"的唯一判据，混淆了三件事。V2 拆开：

| 概念 | 归属 | 字段 | 含义 | 谁能改 |
|---|---|---|---|---|
| **导演剪辑点** | 叙事 | `story_shots.is_cut_point` | 导演认为这镜结束可以剪到下一镜 | 创作层 |
| **自然动作断点** | 表演 | `shot_actions.t_to` 边界 | 动作自然结束时，通常不是剪辑点，但技术上安全 | 动作设计 |
| **模型生成单元边界** | 适配 | `render_unit_shots.t_to` | 编译器把一镜截断在某处 | 适配层（程序） |

**规则**：

1. 单元边界**优先**落在 `is_cut_point=1` 的镜后；
2. 单镜超长必须劈开时，边界只能落在某个动作的 `t_to`（自然动作断点），并记 `split_reason='oversize'`；
3. 边界落在动作中段（`t_from < 边界 < t_to`）→ FAIL「动作被劈成两半」；
4. 三条"断开"可以重合，也可以完全不同（长镜头内部有动作断点但无剪辑点）。

**合法切点集合（切分算法的唯一输入，定义在 `D01-06 §3.3.1`）**：

```
cuts(shot) = { 0, shot.story_duration } ∪ { a.t_to | a ∈ shot.actions }
```

镜内切点**只能**取自 `shot_actions.t_to`（动作结束点）。`is_cut_point` 只作用于镜与镜之间的边界——它不产生镜内切点。切在 `t_from`（动作起手）等于把动作劈成两半，一律拒绝。

### 10.2 `time_jump` 的作用

`time_jump=1` 时连续性引擎**允许** `state_in` 与本场前镜 `state_out` 不一致（换装、换景、时间流逝），降级为 INFO。这是闪回/时间跳跃的合法出口。

---

## 十一、工程列（6 个，不计入业务字段）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `spec_version` | INT | `2` | 数据模型版本 |
| `spec_source` | ENUM | `ai` | `ai`/`import`/`manual`/`legacy` |
| `fill_confidence` | REAL | `0` | 结构化完整度 0–1 |
| `qc_status` | TEXT | `''` | 缓存态，权威在 `qc_reports` |
| `created_at` | INT | — | 时间戳 |
| `updated_at` | INT | — | 时间戳 |

**列数校验**：业务 41 + 主键 `id` 1 + 工程 6 = **48 列**。

---

## 十二、完整 JSON 示例

场景：病房对峙 `S02_病房`，镜 3。`cam_pos` 与 `cam_path` 均为**米制世界坐标**（§4.0），`active_area = [6,5,3]` 米。

> 本示例与 `D01-04 §6.6` 的越轴算例**不是同一镜**（那是 sh_11），但共用同一套场景坐标：哈罗德在 `(1.80, 3.50, 0)`。示例机位到哈罗德的距离 `|(2.45,1.75,1.60)-(1.80,3.50,1.50)| ≈ 1.87m`，与 `cam_distance_m` 一致，可用 V-21 校验。

```json
{
  "id": "sh_01HQ2K8X",
  "project_id": "p_9f3a",
  "chapter_id": "ch_ep01",
  "scene_key": "S02_病房",
  "scene_id": "as_scene_ward",
  "shot_no": 3,
  "global_no": 11,
  "beat_key": "beat_02_pressure",
  "prev_shot_id": "sh_01HQ2K7V",

  "purpose": "advance",
  "dramatic_value": -6,
  "info_delta": "哈罗德把病危通知书摔在床头，观众知道他在逼签",
  "dialogue_function": "threaten",
  "is_insert": 0,

  "visual_content": "哈罗德站在病床右侧，左手把一张纸摔在床头柜上，纸滑落一半垂在柜沿；罗克珊半坐起身，右手撑床，指尖收紧",
  "composition": "前景床头柜虚化压左下角",
  "lighting": "顶灯冷白 5600K，左上主光，右脸三角阴影",

  "shot_size": "medium",
  "cam_direction": "three_quarter",
  "cam_height": "slight_low",
  "cam_roll_deg": 0,
  "cam_pos": { "x": 2.45, "y": 1.75, "z": 1.60 },
  "cam_target": "as_char_harold",
  "cam_distance_m": 1.87,
  "lens_mm": 50,
  "fov_deg": 39.6,
  "movement": "dolly_in",
  "movement_amp": "micro",
  "cam_path": [ { "t": 0.0, "x": 2.45, "y": 1.75, "z": 1.60 }, { "t": 4.5, "x": 2.40, "y": 1.86, "z": 1.60 } ],
  "composition_rule": "foreground_occlusion",
  "cam_note": "机位在床尾偏左 1.8m，高度 0.55m，略低于哈罗德视平线，缓推 12cm",

  "dialogue": "Sign it. Or I walk out and you die in this bed.",
  "speakers": [ { "id": "as_char_harold", "type": "on_screen", "line_from": 0, "line_to": 0 } ],
  "narration": "",
  "sfx": "纸张拍在柜面的闷响，监护仪规律的滴滴声",
  "music_cue": "低频弦乐进入，-18dB",
  "voice_ids": ["as_voice_harold"],

  "story_duration": 4.5,
  "time_slices": [
    { "from": 0.0, "to": 1.2, "what": "哈罗德抬手", "kind": "action" },
    { "from": 1.2, "to": 1.6, "what": "纸拍柜面", "kind": "action" },
    { "from": 1.6, "to": 4.5, "what": "台词，抬手后定格", "kind": "dialogue" }
  ],
  "speed_ramp": "hold",
  "is_cut_point": 1,
  "time_jump": 0,

  "spec_version": 2,
  "spec_source": "ai",
  "fill_confidence": 1.0,
  "qc_status": ""
}
```

配套：空间见 `D01-04 §4`，动作见 `D01-03 §7`（含可计算最终位置），资产为 `shot_assets` 6 行。

---

## 十三、校验规则总表（V-01 ～ V-24）

| 编号 | 校验 | 级别 | 依据 |
|---|---|---|---|
| V-01 | S 级必填集完整 | FAIL | `D01-04 §7` |
| V-02 | 枚举值合法 | FAIL | §4 |
| V-03 | 资产引用存在且 category 正确 | FAIL | §9 |
| V-04 | 说话人在画一致性 | FAIL | §6.1 |
| V-05 | 景别-内容相容 | FAIL | 特写写脚/全景写唇线 |
| V-06 | 机位配额 | WARN | `cam_roll_deg≠0` ≤1/集；大仰/大俯各 ≤3；`profile` ≤15% |
| V-07 | 景别重复 | WARN | 连续 3 镜同档 |
| V-08 | 特写比例 | WARN | 25%–40%（人物特写） |
| V-09 | 语速（**按 `sync.dialogue_span` 实算，不用镜时长**） | FAIL | 基准中文 3.5 字/秒、英文 3.8 词/秒；超过 4.5 字/秒 或 4.8 词/秒 → FAIL。标点停顿按 0.15s/个从 span 中扣除（`D01-03 §5.3`） |
| ~~V-10~~ | **已废止：台词 + 动作 ≤ `story_duration`** | — | 该式把台词与动作当**串行**，与"边说边摔"直接冲突。改由 `D01-03` A-11（区间越界）+ A-12（同人部位冲突）承担。**不得复用此编号**，保留占位以防旧文档引用落空 |
| V-11 | 运镜-幅度一致 | FAIL | 非 `static` 不得 `amp=none` |
| V-12 | 剪辑点 vs 单元边界 | FAIL | 单元边界不得落在动作中段 |
| V-13 | 空镜台词规则 | FAIL | §2.1 |
| V-14 | 摄影机数据完整度标注 | INFO | §4.6 |
| V-15 | 焦段-景别相容 | WARN | `close_up` + `lens<35` |
| V-16 | 视场角与焦段一致 | WARN | `fov_deg` 与 `lens_mm` 换算偏差 >5% |
| V-17 | 空间冲突 | FAIL | `D01-04 §11` |
| V-18 | 状态断裂 | FAIL | `D01-04 §5` |
| **V-19** | **`state_in_meta` / `state_out_meta` 的键必须是可解析的字段路径**（`chars.<id>.<field>` 且实体存在） | FAIL | 防拼错 key 导致可靠性标记静默失效 |
| **V-20** | **`time_slices` 无空洞**：排序后首片 `from=0`、末片 `to=story_duration`、相邻首尾相接 | FAIL | 空洞会让"这一段时间在干什么"无答案 |
| **V-21** | **`cam_pos` 与主主体 `norm_xyz` 的换算一致**（同一坐标系下距离与 `cam_distance_m` 偏差 ≤0.05m） | WARN | 防"机位坐标按归一化填、距离按米填"的混用 |
| **V-22** | **`unknown` 字段被写入确定值但 `meta` 未更新** | WARN | 可检测"绕过修订记录偷偷改值" |
| **V-23** | **`voice_ids` ≠ `shot_assets(role='voice')` 的渲染结果** | FAIL | 有人绕过唯一权威写了派生列（§6.2） |
| **V-24** | **类 B 字段有值但 `spec_source='ai'` 且 `rel` 被写成 `known`** | WARN | AI 生成不得自称确定（`D01-04 §5.2.1`） |

---

## 十四、与现有 `shots` 表的字段映射

| 新字段 | 现有列 | 映射方式 | 可回填性 |
|---|---|---|---|
| `shot_size`/`cam_direction`/`cam_height`/`lens_mm`/`movement` | `camera`（66/66 非空） | 按 `·` 切分匹配词表 | **中**（实测含"中景""侧45度"，但格式不统一） |
| `cam_pos`/`cam_target`/`cam_distance_m`/`cam_roll_deg`/`cam_path` | 无 | **不可回填** | 无（历史 P-C/P-D 级） |
| `visual_content` | `visual` | 直接对应 | 高 |
| `composition`/`lighting` | `visual` 里的光影段 | 拆出 | 中 |
| `shot_blockings.*` | `blocking`（13/66 非空） | 按 `@名（…）；` 五段式解析 | **低**（全是"画面左/右"，无绝对方位 → `norm_xy` 不可得） |
| `shot_actions.*` | 无（混在 `visual`） | 不自动生成 | 无 |
| `speakers` | 从 `dialogue` 正则解析 | 生成候选，`type` 默认 `on_screen` | 中（type 需人工核） |
| `story_duration` | `duration`（**单元时长**） | 按 `sub_shots` 切分（`D01-05 §5.3`） | 低（16 条无分段，只能均分并标低置信） |
| `is_cut_point` | 无 | 旧数据默认 1 | — |
| `shot_assets` | 6 个 `*_ids` + `refs` | 逐元素迁移 | 高 |
| `state_in/out` | 无 | 不生成，首次编译求解 | — |

---

## 十五、修订摘要（相对 V1）

| 变更 | 内容 | 评审项 |
|---|---|---|
| 字段计数口径 | 47 → 41 业务 / 48 列，三类数字分列 | P0-4 |
| D 区 8 → 14 字段 | 引入摄影机空间模型 | P0-3 |
| `dutch` 移出 `cam_height` | 改 `cam_roll_deg` | P0-3 |
| `speaker_ids` → `speakers` | 五种发言类型 | P1-1 |
| 资产 JSON 列 → `shot_assets` | 唯一方案 | P1-7 |
| `is_insert` 台词规则 | 空镜允许画外台词 | P1-2 |
| `is_cut_point` 拆三概念 | 剪辑点/动作断点/单元边界 | P1-3 |
| 新增 `time_jump` | 合法时间跳跃出口 | P1-5 |
