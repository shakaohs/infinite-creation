# D01-02 ShotSpec 完整字段规范

> 上一份：`D01-01` 总体设计（实体层级 / 四层模型 / 三轨时长）
> 本文回答：**一个镜头到底由哪些字段组成，每个字段取什么值，谁校验它。**
> 状态：设计草案。所有字段名 / 枚举值为建议值，落地前须与前端控件、Skill 词表做一次对表。

---

## 一、字段总览（10 个分区 / 47 字段）

`story_shots` 主表承载 A–D、F、J 六区；E/G/H/I 四个 1:N 关系拆从表。

| 区 | 分区 | 字段数 | 载体 | 可否机检 |
|---|---|---|---|---|
| A | 标识与归属 | 9 | 主表 | 结构校验 |
| B | 剧作意图 | 4 | 主表 | 弱校验（枚举 + 非空） |
| C | 画面内容 | 3 | 主表 | 弱校验 |
| D | 摄影 | 8 | 主表 | **强校验（枚举 + 组合规则）** |
| E | 表演与动作 | （见 D01-03） | `shot_actions` | **强校验** |
| F | 声音 | 6 | 主表 | **强校验（语速/人数）** |
| G | 空间（逐人） | （见 D01-04） | `shot_blockings` | **强校验（轴/遮挡/距离）** |
| H | 首尾状态 | （见 D01-04） | `shot_states` | **强校验（状态机）** |
| I | 资产引用 | 7 类 | 主表 JSON + `shot_assets` | **强校验（引用完整性）** |
| J | 时间 | 4 | 主表 | **强校验（预算）** |

---

## 二、A 区 · 标识与归属（9 字段）

| 字段 | 类型 | 必填 | 说明 | 校验 |
|---|---|---|---|---|
| `id` | TEXT PK | ✅ | `sh_<ulid>` | — |
| `project_id` | TEXT | ✅ | 项目 | 存在性 |
| `chapter_id` | TEXT | ✅ | **章节真 id**（现有 `shots.chapter` 存标题字符串，是历史缺陷，新表必须用 id） | 存在性 + 同项目 |
| `scene_key` | TEXT | ✅ | 场次键，关联 `scene_states.scene_key` | 存在性 |
| `scene_id` | TEXT | ⭕ | 场景资产 id（与 `scene_key` 可不同：同一场景资产可用于多场） | category=scene |
| `shot_no` | INT | ✅ | 场内镜号，从 1 起 | 场内唯一 |
| `global_no` | INT | ✅ | 全集镜号（成片排序用，跨场连续） | 集内唯一 |
| `beat_key` | TEXT | ⭕ | 所属叙事节拍（来自锁档 `beats`） | 若填则须存在于锁档 |
| `prev_shot_id` | TEXT | ⭕ | 前镜指针（空 = 场/集首镜） | 存在性 + 同项目 |

**为什么 `chapter_id` 必须用 id**：现有 `shots.chapter` 存章节标题，改标题即"脱章"（审计 08 §4 已列为风险）。新表用 id，标题变更不影响归属；旧表保持不动以免破坏兼容。

**`shot_no` vs `global_no` 双编号的必要性**：分镜表习惯用「场-镜」（2-3），成片与导出需要全集连续号。两套号都在，避免每次查询都做窗口函数。

---

## 三、B 区 · 剧作意图（4 字段）

| 字段 | 类型 | 必填 | 取值 | 说明 |
|---|---|---|---|---|
| `purpose` | ENUM | ✅ | `establish` 定场 / `advance` 推进 / `react` 反应 / `reveal` 揭示 / `turn` 转折 / `close` 收束 / `insert` 插入（空镜/道具） | **这一镜为什么存在**。缺失即"废镜" |
| `dramatic_value` | INT | ⭕ | -10 ~ +10 | 情绪极性与强度，用于节奏曲线绘制（D01-03 §5） |
| `info_delta` | TEXT | ⭕ | 自由文本 ≤80 字 | 本镜给观众的新信息（"观众知道了什么"） |
| `dialogue_function` | ENUM | ⭕ | `inform` 交代 / `persuade` 说服 / `probe` 试探 / `threaten` 威胁 / `confess` 坦白 / `deflect` 回避 / `none` | 台词的功能，用于判断"这场戏的对话是否有推进" |

**校验规则**：
- `purpose` 为必填枚举——这是把"废镜"从"感觉"变成"可判定"的最低成本手段；
- 同一 `beat_key` 下 `purpose` 全为 `react` 时给 WARN（连续反应镜 = 叙事停滞）；
- `purpose=insert` 时 `dialogue` 必须为空（空镜不该有台词）。

---

## 四、C 区 · 画面内容（3 字段）

| 字段 | 类型 | 必填 | 说明 | 校验 |
|---|---|---|---|---|
| `visual_content` | TEXT | ✅ | 画面里**看得见**的东西：谁、在做什么、在哪（不含心理活动、不含"他感到"） | 非空；含角色名但该角色不在 `shot_blockings` 时 FAIL |
| `composition` | ENUM | ⭕ | 构图法，见 §5.3 | 枚举 |
| `lighting` | TEXT | ⭕ | 光影/色调/光源方向（原 SD 九字段的「光影/色调」列） | 自由文本 |

**`visual_content` 的写法约束（源自 `short-drama-camera-system.md` §景别-取景半径）**：
- 必须与 `shot_size` 相容：写"胸部以下"就必须是全景及以上，写在特写里 = FAIL；
- 不得写不可见内容（心理、回忆、"他意识到"）——这类进 `narration` 或 `purpose`；
- 不得写摄影机运动（那是 D 区）——检测到"镜头/推/拉/摇"等词且 `movement=static` 时 WARN。

---

## 五、D 区 · 摄影六要素（8 字段）

这一区是把现有 `camera` 自由文本拆开的产物。**枚举值全部来自 Skill 受控词表**，不是自创。

### 5.1 `shot_size` 景别（9 档，有序）

| 值 | 中文 | 序位 | 只能写什么（装得下的内容） |
|---|---|---|---|
| `extreme_wide` | 大远景 | 1 | 地理环境、人物为点 |
| `wide` | 远景 | 2 | 环境为主、人物全身可见 |
| `full` | 全景 | 3 | 人物全身 + 所在空间关系 |
| `medium_full` | 中全景 | 4 | 膝盖以上 + 部分环境 |
| `medium` | 中景 | 5 | 腰部以上，可双人同框 |
| `medium_close` | 中近景 | 6 | 胸部以上，单人为主 |
| `close` | 近景 | 7 | 肩部以上，表情可读 |
| `close_up` | 特写 | 8 | 面部/局部肢体，情绪锚点 |
| `extreme_close` | 大特写 | 9 | 眼/唇/手部细节 |

**来源**：`short-drama-camera-system.md` §一「可用景别：大远景 → 远景 → 全景 → 中全景 → 中景 → 中近景 → 近景 → 特写 → 大特写」。

**校验**：
- 连续 3 镜同档 → WARN（现有机检已实现）；
- 段缝两侧跨段时同档（0 级），末镜做了收束动作禁反向收紧 ≥1 级 → WARN；
- `close_up` 占比区间 25%–40%（仅人物特写计入，物件特写剔除）→ WARN；
- 室内封闭小空间出现 `extreme_wide` / `wide` / `bird_eye` → FAIL（空间不成立）。

### 5.2 `cam_direction` 方向轴（5 值）

| 值 | 中文 | 情绪 | 默认用途 |
|---|---|---|---|
| `front` | 正面 | 直接、对抗、坦白 | 摊牌/对峙 |
| `three_quarter` | 侧 45° | 张力与交流并存 | **对话默认机位（30%–40%）** |
| `profile` | 侧面 90° | 隔绝、疏离 | 回避/诀别（≤15%） |
| `over_shoulder` | 过肩 | 建立空间关系 | 双人对话/对峙 |
| `pov` | 主观视角 | 沉浸代入 | 角色视角/恐惧/发现 |

### 5.3 `cam_height` 高度轴（8 值）

| 值 | 中文 | 情绪 | 配额 |
|---|---|---|---|
| `eye` | 平视 | 中性、客观 | 常规镜头主力 |
| `slight_low` / `slight_high` | 微仰/微俯（≤15°） | 隐性强弱暗示 | 常规 |
| `low` | 仰拍 15–45° | 力量、压迫 | 常规 |
| `high` | 俯拍 15–45° | 弱小、孤独 | 常规 |
| `extreme_low` | 大仰角 >45° | 压倒性力量 | **≤3 次/集** |
| `extreme_high` | 大俯角 >45° | 宿命、彻底绝望 | **≤3 次/集** |
| `bird_eye` | 鸟瞰 | 全知、渺小 | 室内层高不足禁用 |
| `dutch` | 荷兰角 | 世界失衡 | **≤1 镜/集，倾斜 10–20°** |

**组合校验**：`cam_direction × cam_height` 组合后，全集须 ≥4 种（单场）/ ≥6 种（多场）；连续 3 镜不得全部 `front + eye`。

### 5.4 `lens_mm` 焦段（数字，可选）

| 区间 | 效果 | 典型用途 |
|---|---|---|
| 14–24 | 广角，透视畸变 | 空间压迫、大仰角威压 |
| 35–50 | 标准，接近人眼 | 常规叙事 |
| 85–135 | 中长焦，压缩空间 | 特写、情绪逼近 |
| 135+ | 长焦，背景虚化强 | 窥视、隔离 |

校验：`shot_size=close_up` 且 `lens_mm<35` → WARN（广角特写会畸变脸）。

### 5.5 `movement` 运镜（21 值，受控）

| 分类 | 值 |
|---|---|
| 静止 | `static`（固定） |
| 平移 | `pan_left` / `pan_right`（摇）、`truck_left` / `truck_right`（横移）、`pedestal_up` / `pedestal_down`（竖移） |
| 纵深 | `dolly_in`（推）、`dolly_out`（拉）、`tracking`（跟拍）、`crane`（升降）、`arc`（环绕/弧形）、`jib`（摇臂） |
| 变焦 | `zoom_in` / `zoom_out`（光学变焦）、`snap_zoom`（急速变焦）、`dolly_zoom`（滑动变焦，**全片 ≤1**） |
| 手持 | `handheld_light` / `handheld` / `handheld_shaky`（三级烈度） |
| 特殊 | `snorricam`、`long_take`（长镜头） |

**来源**：`short-drama-camera-system.md` §四 运镜表（21 行，逐项抄录）。

### 5.6 `movement_amp` 运镜幅度

| 值 | 含义 | 适用 |
|---|---|---|
| `none` | 无位移 | 与 `static` 绑定 |
| `micro` | ≤15cm（呼吸感） | 文戏缓推/缓移，防漂移 |
| `normal` | 15–100cm | 常规推拉横移 |
| `large` | >100cm 或大幅升降 | 史诗揭示/空间展开 |

**校验**：`movement` 非 `static` 且 `movement_amp=none` → FAIL（矛盾）；文戏 `movement_amp=large` → WARN（易漂移）。

### 5.7 `composition_rule` 构图法

| 值 | 说明 |
|---|---|
| `center` | 中心构图（权力、正视、压迫） |
| `rule_of_thirds` | 三分法（常规叙事） |
| `symmetry` | 对称（仪式感、对峙均衡） |
| `frame_in_frame` | 框架式（门框/窗框，窥视与禁锢） |
| `foreground_occlusion` | 前景遮挡（层次、偷窥） |
| `negative_space` | 大量留白（孤独、渺小） |
| `diagonal` | 对角线（动势、失衡） |

### 5.8 `cam_note` 原生机位描述（自由文本，兜底）

保留一句人读描述（如"机位在病床尾侧 1.5m，略高于床头，50mm"），供人工复核与提示词引用。**不作为机检依据**。

**为什么保留**：枚举无法表达"机位具体在哪"。而 `asset-spatial-ledger.md` 明确要求"机位与人物之间的物理关系"（过肩需退到背后 1.5–2m、大俯角需真实高点）。这句描述是唯一能承载物理可行性的地方。

---

## 六、E 区 · 表演与动作

**完整定义在 `D01-03`。** 此处只列与主表的关系：

- 静态表演（表情/情绪）落在 `shot_actions` 的 `acting` 类型动作里，或主表 `emotion_intensity`；
- 动态动作（起势→路径→接触→落点→反应）每个动作一行，`shot_actions.shot_id` 关联；
- 一镜内**允许多个动作并行**（A 起身 + B 后退），但**只允许一个"主动作"**（`is_primary=1`），与群戏"单主焦点"铁律一致。

---

## 七、F 区 · 声音（6 字段）

| 字段 | 类型 | 必填 | 说明 | 校验 |
|---|---|---|---|---|
| `dialogue` | TEXT | ⭕ | 台词原文，保留原语言 | 语速：中文 ≤3.5 字/秒、英文 ≤3.8 词/秒（现有机检沿用） |
| `speaker_ids` | JSON[] | ⭕ | 说话人资产 id 数组（**新增：不再从文本解析**） | ≤2 人；每人须在 `shot_blockings` 且 `in_frame=1` |
| `narration` | TEXT | ⭕ | 旁白口播稿 | 有旁白则须引 `voice_ids` |
| `sfx` | TEXT | ⭕ | 现场音效/环境声（**不得写"后期贴声"等流程词**） | 命中流程词 → FAIL |
| `music_cue` | TEXT | ⭕ | 配乐提示（进/出/情绪） | 自由文本 |
| `voice_ids` | JSON[] | ⭕ | 音色资产 id（替代现有 `audio_ids` 的部分语义） | ≤3；category ∈ voice/narration |

**关键改进——说话人结构化**：现状 `dialogueSpeakerNames(dialogue)` 从文本正则解析说话人（审计 03 §3「声音/说话人：部分」）。新模型存 `speaker_ids`，文本解析降级为"回填工具"。

校验联动：`speaker_ids` 中的角色必须在 `shot_blockings` 里 `in_frame=1`——这直接对应"对话指向律"（人物开口时听话的人必须在画内），现状只能靠提示词纪律，新模型可机检。

---

## 八、G 区 · 空间（逐人）

**完整定义在 `D01-04`。** 摘要：

`shot_blockings` 每人一行，12 个字段：`position_abs`（绝对方位）、`anchor_object`（依托物）、`behind_object`（身后背景物）、`facing`（朝向）、`gaze_target`（视线落点）、`posture`（姿态）、`distance_to_camera`（估距）、`occlusion`（遮挡程度）、`hand_state`（手位/持物）、`current_task`（手头事务）、`in_frame`（在画/画外）、`power_level`（权力位阶）。

---

## 九、H 区 · 首尾状态

**完整定义在 `D01-04`。** `shot_states` 一行两列：`state_in` / `state_out`，均为结构化差异集（JSON），不是自由文本。

---

## 十、I 区 · 资产引用（7 类）

| 字段 | 类型 | 说明 | 校验 |
|---|---|---|---|
| `character_ids` | JSON[] | 在场角色（含画外） | category=character；与 `shot_blockings` 双向一致 |
| `scene_ids` | JSON[] | 场景资产 | category=scene |
| `prop_ids` | JSON[] | 道具 | category=prop；`hand_state` 引用的道具必须在此 |
| `costume_ids` | JSON[] | 服装变体 | category=costume；**同一角色每镜只引用一件** |
| `age_ids` | JSON[] | 年龄/时期变体 | category=age；不与同角色 costume 同时引用 |
| `audio_ids` | JSON[] | 音频素材（音色/音乐/音效） | ≤3 |
| `ref_pack` | JSON | **参考包快照**（编译时固化：哪张图对应哪个 @图片N） | 编译期生成，非用户填 |

**`ref_pack` 为什么从"现算"改成"快照"**：现状 `assembleShotReferences` 每次编译现算，导致"这条片是用哪版参考图产的"无法回答（审计 03 §3「参考包：部分」）。快照进 `prompt_packages` 而非主表，这里保留指针。

---

## 十一、J 区 · 时间（4 字段）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `story_duration` | REAL | ✅ | 导演设计时长（秒），**无模型上限**，建议 1.5–12 |
| `time_slices` | JSON | ⭕ | 镜内子时间片：`[{from,to,what}]`，用于一镜多动作的节奏控制 |
| `speed_ramp` | ENUM | ⭕ | `none` / `slow_in`（先慢后快）/ `slow_out`（先快后慢）/ `hold`（短暂停顿）/ `ramp`（渐变） |
| `is_cut_point` | BOOL | ✅ | 本镜末尾是否为切点（决定 RenderUnit 能否在此断开） |

**`is_cut_point` 的作用**：这是编译层切分单元的**唯一合法断点标记**。切成 15s 单元时只能在 `is_cut_point=1` 的镜后断，避免把一镜劈成两半（现状 `mergeIntoSegments` 按累计时长硬切，有劈镜风险）。

---

## 十二、完整 JSON 示例（真实场景）

场景：病房对峙（罗克珊卧床、哈罗德站立施压、凯森门口），场次 `S02`。

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

  "visual_content": "哈罗德站在病床右侧，左手把一张纸摔在床头柜上，纸滑落一半垂在柜沿；罗克珊半坐起身，右手撑床，指尖收紧；凯森在门口未入画",
  "composition": "foreground_occlusion",
  "lighting": "顶灯冷白 5600K，从左上方打，右脸留三角阴影",

  "shot_size": "medium",
  "cam_direction": "three_quarter",
  "cam_height": "slight_low",
  "lens_mm": 50,
  "movement": "dolly_in",
  "movement_amp": "micro",
  "composition_rule": "rule_of_thirds",
  "cam_note": "机位在床尾偏左 1.8m，高度略低于哈罗德视平线，缓推 12cm",

  "dialogue": "Sign it. Or I walk out and you die in this bed.",
  "speaker_ids": ["as_char_harold"],
  "narration": "",
  "sfx": "纸张拍在柜面的闷响，监护仪规律的滴滴声",
  "music_cue": "低频弦乐进入，音量 -18dB",
  "voice_ids": ["as_voice_harold"],

  "character_ids": ["as_char_harold", "as_char_roxanne"],
  "scene_ids": ["as_scene_ward"],
  "prop_ids": ["as_prop_notice"],
  "costume_ids": ["as_costume_harold_suit"],
  "age_ids": [],
  "audio_ids": ["as_voice_harold"],

  "story_duration": 4.5,
  "time_slices": [
    { "from": 0.0, "to": 1.2, "what": "哈罗德抬手" },
    { "from": 1.2, "to": 1.6, "what": "纸拍柜面" },
    { "from": 1.6, "to": 4.5, "what": "台词，抬手后定格" }
  ],
  "speed_ramp": "hold",
  "is_cut_point": 1
}
```

配套从表（示意，详解见 D01-03 / D01-04）：

```json
// shot_blockings（2 行）
[
  {
    "shot_id": "sh_01HQ2K8X", "character_id": "as_char_harold",
    "position_abs": "病床右侧·床头柜旁 0.6m",
    "anchor_object": "as_prop_notice / 床头柜",
    "behind_object": "百叶窗",
    "facing": "向西·侧对罗克珊 45°",
    "gaze_target": "as_char_roxanne.face",
    "posture": "standing",
    "distance_to_camera": 1.8,
    "occlusion": "none",
    "hand_state": "左手刚离开纸面，右手垂在身侧",
    "current_task": "施压·等待签字",
    "in_frame": 1,
    "power_level": "high"
  },
  {
    "shot_id": "sh_01HQ2K8X", "character_id": "as_char_roxanne",
    "position_abs": "病床上·床头抬高 30°",
    "anchor_object": "as_prop_bed",
    "behind_object": "枕头与墙面",
    "facing": "向东·仰视哈罗德",
    "gaze_target": "as_char_harold.face",
    "posture": "sitting_supported",
    "distance_to_camera": 2.4,
    "occlusion": "partial（前景床头柜遮去下半身）",
    "hand_state": "右手撑床·指尖收紧，左手在被下",
    "current_task": "抵抗·不说话",
    "in_frame": 1,
    "power_level": "low"
  }
]

// shot_states（1 行）
{
  "shot_id": "sh_01HQ2K8X",
  "state_in":  { "prop:as_prop_notice": "哈罗德右手持有", "roxanne.posture": "半卧", "harold.pos": "床右侧 1.2m" },
  "state_out": { "prop:as_prop_notice": "在床头柜面（离手）", "roxanne.posture": "半坐起", "harold.pos": "床右侧 0.6m" }
}
```

---

## 十三、字段与现有实现的映射

| 新字段 | 现有字段 | 映射方式 |
|---|---|---|
| `shot_size` / `cam_direction` / `cam_height` / `lens_mm` / `movement` | `shots.camera`（文本） | 回填：正则拆（`camera` 写法较稳定，抽样 50 条验证可行性，见 03 文档 V-10）；新增：直接结构化写入 |
| `visual_content` | `shots.visual` | 直接对应（保留九字段拼接内容的原文） |
| `composition` / `lighting` | `shots.visual` 中的「光影/色调」段 | 拆出；原地保留 |
| `shot_blockings.*` | `shots.blocking`（一段话） | 回填：按"一行式六要素"解析（位置 · 依托物 · 身后物 · 朝向 · 姿态 · 手头事务）；解析失败则整段存 `blockings.raw`，不猜 |
| `shot_actions.*` | 无（混在 `visual`） | **不自动回填**（拆分叙述为结构化动作会引入臆造），标注 `action_source='none'` |
| `speaker_ids` | 从 `dialogue` 解析 | 回填：跑一次 `dialogueSpeakerNames` 得到候选，标 `speaker_source='parsed'` |
| `story_duration` | `shots.duration`（段时长） | **不可直接映射**：旧 `duration` 是段总时长，须 `Σ sub_shots` 后按镜序均分或按时间轴切分（见 D01-05 §5） |
| `is_cut_point` | 无 | 旧数据默认 1（旧段即投喂单位，段内不切） |
| `state_in/out` | 无 | 不自动生成（避免臆造），标 `state_source='none'`，首次编译时由连续性引擎求 `state_in` |

---

## 十四、必填强度分级（与 D01-04 的 S0–S4 联动）

不是所有镜头都需要 47 个字段。按空间复杂度分级：

| 级别 | 判据 | 必填 |
|---|---|---|
| **S0 单人静镜** | 1 人、无位移、无道具转手 | A、B、C、D、F、J + `shot_blockings` 的 position/facing/posture/in_frame |
| **S1 双人静态** | 2 人、无位移 | S0 + 逐人 12 要素 + `axis_lock` |
| **S2 多人静态** | 3–4 人 | S1 + `power_level` + `occlusion` 逐人 |
| **S3 多人移动** | 有人物位移 | S2 + `shot_actions` 路径段 + `state_in/out` |
| **S4 复杂战斗/群像** | 打斗、≥5 人、多机位切换 | S3 + 逐动作接触点 + 群像开关 A/B/C |

**设计意图**：让"站位声明"从"全片都要写、结果 80% 没写"变成"按级别强制、级别由数据推导"。级别推导规则见 D01-04 §7。

---

## 十五、校验器清单（供 D01-06 接口实现）

| 编号 | 校验 | 级别 | 规则 |
|---|---|---|---|
| V-01 | 字段完整性 | FAIL | 按 S 级别的必填集校验 |
| V-02 | 枚举合法性 | FAIL | 所有 ENUM 字段值在词表内 |
| V-03 | 引用完整性 | FAIL | 所有 `*_ids` 存在且 category 正确 |
| V-04 | 说话人在画 | FAIL | `speaker_ids` ⊆ `in_frame=1` 的角色 |
| V-05 | 景别-内容相容 | FAIL | 特写里写脚、全景里写唇线等 |
| V-06 | 机位配额 | WARN | 荷兰角 ≤1/集、大仰大俯各 ≤3/集、侧面 ≤15% |
| V-07 | 景别重复 | WARN | 连续 3 镜同档 |
| V-08 | 特写比例 | WARN | 25%–40%（人物特写） |
| V-09 | 语速 | FAIL | 中文 3.5 字/秒、英文 3.8 词/秒 |
| V-10 | 时长预算 | FAIL | `story_duration` 容得下 `dialogue` + 主动作耗时 |
| V-11 | 运镜-幅度一致 | FAIL | 非 static 不得 amp=none |
| V-12 | 切点合法性 | FAIL | `is_cut_point=0` 的镜不得被单元边界切断 |
| V-13 | 空间冲突 | FAIL | 见 D01-04 判定矩阵 |
| V-14 | 状态断裂 | FAIL | 见 D01-04 状态求解 |
| V-15 | 动作物理 | FAIL | 位移无路径、接触无对象、道具凭空出现 |
