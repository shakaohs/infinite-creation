# D01-02 ShotSpec 完整字段规范（第二轮修订）

> **本文是 D01 全系列唯一的字段字典。** 其他文档只引用，不重复定义。
> 引用方式：`D01-02 §D`（分区）、`D01-02 §F.speakers`（单字段）。
> 修订轮次：V2，修订点见 `D01-08`。

---

## 〇、三类数字必须分清

评审要求区分「业务字段 / 持久化列 / 关联表字段」。本文所有计数按此口径：

| 口径 | 定义 | 本模型数值 |
|---|---|---|
| **业务字段** | 表达导演创作语义的字段，不含主键、外键、时间戳、版本戳 | **41** |
| **持久化列** | `story_shots` 表实际列数（业务字段 + 主键 + 工程列） | **48** |
| **关联表字段** | 从表列数（含主键与外键），不等于业务字段 | `shot_blockings` 20（2 键 + 18 业务）/ `shot_actions` 22（2 键 + 20 业务）/ `shot_states` 7 / `shot_assets` 6 / `scene_states` 14 |

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

| # | 字段 | 类型 | 必填(S级) | 默认 | 单位/范围 | 说明 |
|---|---|---|---|---|---|---|
| D1 | `shot_size` | ENUM | all | — | 9 档（§4.1） | 景别 |
| D2 | `cam_direction` | ENUM | all | — | 5 值（§4.2） | 方向轴 |
| D3 | `cam_height` | ENUM | all | — | 8 值（§4.3） | 高度轴（**已移除 dutch**） |
| D4 | `cam_roll_deg` | REAL | S2+ | `0` | -20 ~ +20 | 滚转/画面倾斜（荷兰角） |
| D5 | `cam_pos` | JSON | **S2+** | `null` | `{x,y,z}` 归一化 0–1 | 机位在场坐标系中的位置 |
| D6 | `cam_target` | TEXT | S1+ | `''` | 资产/角色 id 或坐标点 | 机位观察目标 |
| D7 | `cam_distance_m` | REAL | S2+ | `null` | 0.3 ~ 30 | 机位到主主体距离（米） |
| D8 | `lens_mm` | INT | ⭕ | `0` | 8 ~ 300 | 焦段 |
| D9 | `fov_deg` | REAL | ⭕ | `null` | 5 ~ 120 | 水平视场角（可由 lens 推算，存冗余供校验） |
| D10 | `movement` | ENUM | ✅ | `static` | 21 值（§4.4） | 运镜方式 |
| D11 | `movement_amp` | ENUM | ✅ | `none` | `none`/`micro`/`normal`/`large` | 运镜幅度 |
| D12 | `cam_path` | JSON | S3+ | `[]` | `[{t,x,y,z}]` | 运镜轨迹采样点（`static` 时为空） |
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

机位数据不是"全有或全无"。按可用精度分四级，**越轴算法只在前两级可信**（详见 `D01-04 §6`）：

| 级别 | 具备字段 | 越轴判定 |
|---|---|---|
| **P-A 完整** | `cam_pos` + `cam_target` + `cam_distance_m` + `cam_axis_side` | 可算，FAIL/WARN 有效 |
| **P-B 半完整** | `cam_pos` + `cam_direction`（无 target） | 可算，最高只到 WARN |
| **P-C 仅枚举** | 只有 `cam_direction` + `cam_height` | **不可算 → `AXIS_UNVERIFIED`** |
| **P-D 缺失** | 都没有 | **不可算 → `AXIS_UNVERIFIED`** |

> 实测历史 66 条分镜的 `camera` 全是文本（如「中景 · 50mm · 侧45度 · 固定」），无任何坐标字段 → 全部处于 **P-C 或 P-D**。因此越轴检测对历史数据**一律输出"无法验证"，绝不输出 PASS**。这是评审 P0-3 的硬要求。

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
| `voice_ids` | JSON | ⭕ | `[]` | 音色资产 id |

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

场景：病房对峙 `S02_病房`，镜 3。注意 `cam_pos` 与 `cam_axis_side` 让越轴判定有据。

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
  "cam_pos": { "x": 0.42, "y": 0.30, "z": 0.55 },
  "cam_target": "as_char_harold",
  "cam_distance_m": 1.8,
  "lens_mm": 50,
  "fov_deg": 39.6,
  "movement": "dolly_in",
  "movement_amp": "micro",
  "cam_path": [ { "t": 0.0, "x": 0.42, "y": 0.30 }, { "t": 4.5, "x": 0.44, "y": 0.34 } ],
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

## 十三、校验规则总表（V-01 ～ V-18）

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
| V-09 | 语速 | FAIL | 中文 3.5 字/秒；英文 3.8 词/秒 |
| V-10 | 时长预算 | FAIL | 台词 + 动作 ≤ `story_duration` |
| V-11 | 运镜-幅度一致 | FAIL | 非 `static` 不得 `amp=none` |
| V-12 | 剪辑点 vs 单元边界 | FAIL | 单元边界不得落在动作中段 |
| V-13 | 空镜台词规则 | FAIL | §2.1 |
| V-14 | 摄影机数据完整度标注 | INFO | §4.6 |
| V-15 | 焦段-景别相容 | WARN | `close_up` + `lens<35` |
| V-16 | 视场角与焦段一致 | WARN | `fov_deg` 与 `lens_mm` 换算偏差 >5% |
| V-17 | 空间冲突 | FAIL | `D01-04 §11` |
| V-18 | 状态断裂 | FAIL | `D01-04 §5` |

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
