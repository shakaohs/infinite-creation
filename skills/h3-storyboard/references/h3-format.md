# H3 格式规格：三字段 / 六段式 / 指令行 / 载荷

> 来源：`MiniMax-AI/MiniMax-H3` 官方 `skills/h3-prompt-writing`（`base-en.txt` / `ref-en.txt` / `README.zh-CN.md`）逐字核对版，2026-10-02 复核。**字段名、顺序、标记值一律照抄，不许改写。**

---

## 一、两个 checkpoint，五种输入形态

| checkpoint | 输入 | 形态 | 输出 |
|---|---|---|---|
| `H3-Base-FL2VA` | 零图 | T2VA 文生 | 三字段 |
| `H3-Base-FL2VA` | 一图 | I2VA 首帧 | 指令行 + 三字段 |
| `H3-Base-FL2VA` | 一图 | L2VA 尾帧 | 指令行 + 三字段 |
| `H3-Base-FL2VA` | 两图 | FL2VA 首尾帧 | 指令行 + 三字段 |
| `H3-Base-Ref2VA` | 多模态参考 | 全能参考 | **六段式** |

**三字段**
```
integrated_multimodal_description
overall_soundscape
non_diegetic_music
```

**六段式**（顺序固定，不可调换）
```
subject_definitions
summary
retention_analysis
detailed_description
overall_soundscape
non_diegetic_music
```

---

## 二、指令行（仅 I2VA / FL2VA / L2VA）

必须是正文**第一行**，后跟一个空行。官方固定英文模板，**保持原文不译写**。

```
I2VA:
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

FL2VA:
How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the S.SS-second mark of the target video.

L2VA:
How the reference pictures align with the target video — <Picture 1> (from [Shot N]) aligns with the S.SS-second mark of the target video.
```

- `N` = 实际末镜编号；`S.SS` = 有效时长，两位小数
- **Ref2VA 没有指令行**——官方实例也没有，别凭手感加

---

## 三、六段式逐段写法

### 3.1 `subject_definitions`

每个参考主体一条，格式：

```
<Subject 1> is the young woman in Picture 1: black shoulder-length hair, pale skin, a grey linen shirt, a thin silver hairpin.
```

- 只写**可见外观**：发式 / 肤色 / 服装 / 体型 / 显著标记 / 随身物
- 一层即可，**不要**写性格、身世、心理、声纹
- 用途要写清：锁形象 / 锁空间 / 锁道具 / 锁构图
- **定义数 ≤9**；定义了就必须在正文被引用（否则白占额度）

**Picture 编号 = 图槽序号，不是资产序号。** `<Subject 4> is ... in Picture 4` 要求第 4 个图槽真的放着那张图。分段投喂时最容易在这里翻车：某段只用到 1/2/4 三张，为了省额度只挂三张，槽位就变成 1/2/3，正文里的 `Picture 4` 指向了空槽或别人。

**铁律：全片图槽顺序一次钉死，每段全挂、一张不换、空槽留在尾部。** 图 ≤9 时永远不省图，省图省下的是额度，赔掉的是身份。跨段同理——七段的 `Picture 3` 必须永远是同一张场景图。

### 3.2 `summary`

```
reference generation — She confronts him across the desk; he denies everything; she puts the photograph down.
```

- 段首是**任务类型前缀**：`keyframe completion` / `reference generation` / `video editing` / `video continuation` / `audio reuse` / `audio reference`，多类型用 ` + ` 连接
- 前缀推导：Ref2VA → `reference generation`；首尾帧 → `keyframe completion`；段缝续写 → `video continuation`；音频复用 → `audio reuse`
- 后面 1–2 句写**本段发生了什么**，不引入新标签

### 3.3 `retention_analysis`

交代每个参考素材保留到什么程度：

```
<Subject 1> (image): fully_preserved — face, hairstyle and clothing all retained.
<Subject 2> (image): partially_preserved — face retained, clothing replaced by the uniform.
```

**保留度取值（固定英文，不许自造）**

| 类型 | 合法值 |
|---|---|
| 画面 | `fully_preserved` / `partially_preserved` / `attribute_transfer` / `weak_reference` |
| 音频 | `fully_copy` / `partially_copy` / `reference` / `weak_reference` |

- **`retention_analysis` 里不写 `(Sx)`**（说话人编号只属于对白）

### 3.4 `detailed_description`（正文主体）

- **全英文**
- 结构：`[Shot 1]` 无时间戳 → 后续 `[Shot N] At MM:SS.mmm,`
- 每镜写：景别 + 机位角度 + 运镜 + 画面事实（见 `h3-shot-grammar.md`）
- 对白写 `<d>[Chinese] 台词</d>`，说话人身份与语气写**在 `<d>` 外面**
- 体量：**按镜算，不按段算**——单镜 45–85 词为健康区（>85 词 H23 提醒，>100 词直接丢指令），4 镜的 15s 段落在 180–280 词即可。
  > 旧版此处写「15s 段 350–500 词」，与「单镜 ≤85 词」**直接打架**（4 镜最多 280 词，永远够不到 350）。2026-10-21 质检统一为按镜算。**宁细勿简，但不得注水凑字。**
- 切镜只用绑定短语（见下）
- **维持句没有独立字段**：Hailuo Web 模板的 `[HOLD]` 段在 H3 六段式里**不存在**，落地为「每镜正文末尾一句正向维持句」（见 `spatial-anchor-and-hold.md §三`）。别去字段列表里找 `[HOLD]`

**官方绑定短语**
```
the camera cuts to / the shot cuts to / the shot transitions to / the shot changes to / the shot switches to
```
cross-dissolve / fade / wipe **仅在用户明确要求时**使用。

**切或不切：四问判据（2026-10-24 吸收官方母本）**

> 官方原话：`Use a cut only when the viewpoint, space, subject state, time, or information changes significantly. If only framing or distance changes, prefer continuous camera movement instead of an unnecessary cut.`

| 问 | 变化了什么 | 结论 |
|---|---|---|
| 1 | 视角方向 / 站位（换轴、换人、换侧） | **切** |
| 2 | 空间换了（另一间屋、另一个地点） | **切** |
| 3 | 主体状态或时间跳了（坐下→站起、1 分钟后） | **切** |
| 4 | 信息变了（揭示新物体 / 新人物入画） | **切** |
| — | **只是景别或距离变**（中景→近景→特写，同一人同一句） | **不切**，改 `slides forward 15 cm over two seconds on a rail` |

**这条和「回合制换嘴切镜」不冲突**：换嘴 = 视角与主体都变 → 走第 1 条，必切；同一个人在一个情绪推进里从中景推到特写 → 走最后一行，用运镜。**两者都算「切镜点」，只是前者用 `[Shot N]`，后者用 cm**。反例：一句台词里连切三刀 中景/近景/特写，H3 会以为是三个不同时间，台词被拖成三段。

**运镜不挂在句尾当关键词**：官方明令 `Do not append disconnected camera keywords at the end of a shot`。运镜必须进主句（`..., the camera slides forward 10 cm over two seconds`），不能在镜末另起 `Push In, Slow`。

#### 跨镜锁定自检清单（写完 `detailed_description` 逐镜必过 · 机检 H2/H23/H34/H41/H42）

> 这段是 `detailed_description` 的**必过门禁**，不是建议。规则分散在 `h3-shot-grammar.md` §1.16/§四、`spatial-anchor-and-hold.md` §8，此处收拢成逐镜可对照的清单。**写完每一镜就地核对，不要指望机检重试来救**。三段连续实测证明：越轴/图槽靠规则已能锁住，但换人切镜、时间戳、词数会因模型"读过却没执行"而 FAIL——本清单就是防这个。

1. **换人必换机位或景别（H41）**：相邻两镜换了说话人/主体时，机位角度与景别**至少换一样**。两样都不换 = H3 把两人当同一位置两次置换，成片同机位原地闪现两个人。
   - 换景别档：`Medium shot` → `Medium close-up` / `Close-up`（ECU/CU/MCU/MS 分属不同档）
   - 或换机位角度：`45-degree side angle` → `over her shoulder` / `slightly high angle` / `framed from his right`
   - 两镜都写 `holds still` 且同景别 ≠ 换；必须有一项实变。
2. **换人必写入画/退场句（H42）**：H3 零跨镜记忆，新主体不会自己出现、旧主体不会自己消失。相邻两镜 `<Subject N>` 集合有增减时：
   - 新主体入画：在该镜写 `he steps into frame from the left, ...`
   - 主体退场：在退场那镜写 `she leaves the frame to the right, ...`
   - 或**人数与场景都不变时全员同框不切镜**：全员从 `[Shot 1]` 就在场，站位全程锁定，切镜只切机位/景别/看向谁，不切"谁在场"。
3. **时间戳只属于切点（H2）**：`[Shot 1]` **无时间戳**；后续 `[Shot N] At MM:SS.mmm,` 严格递增、≤ 段时长；一个 `[Shot N]` 只有一个时间戳（镜内节拍靠动作顺序，不靠秒数）；切镜只用 `the camera cuts to`。
4. **单镜词数上限（H23）**：每镜 45–85 词健康区，**>100 词直接丢指令（先丢机位）**；超了拆镜或删掉同时发生的动作，不注水凑字。
5. **图槽跨段不换（H34）**：`<Picture 1/2/3>` 在多段里始终指同一个主体（人/场景/道具不互换），跨段延续同一编号。
6. **越轴只写正向不变式**：段首写一次 `The camera stays on the same side of them throughout; she is on the left, he is on the right.`，后续镜继承；禁写 `line` / `axis` / `frame` / 轴线 / 禁越轴（会被画成一条线）。

### 3.5 `overall_soundscape`

- 环境音、物理音、非语言人声（脚步、雨声、门轴、呼吸、群杂）
- **不含台词**
- 也**不含 BGM**
- 非对白人声词（轻笑 / 抽气 / 窃语）放这里，或直接删——留在正文会打乱说话人路由

### 3.6 `non_diegetic_music`

- 只放 BGM：乐器、速度、情绪、进入与退出时机
- **不复述台词**、不描述画面
- 无 BGM 写 `N/A`（官方原话：`non_diegetic_music: N/A`），不要留空，也不要写 `None.` / `无` / `-`

---

## 四、对白与说话人（最容易崩的一块）

### 4.1 基本格式

```
The young woman with a low, flat, cool voice (S1) says at an even pace: <d>[Chinese] 你到底想怎么样。</d>
```

- **语气必须写在 `<d>` 外面**，用英文合成说话人短语
- 首次出现要给足：character type / age / gender / on-screen 与否 / **pitch / timbre / speaking rate / accent**
- `<d>` 内**只放语言标签 + 台词原文**，逐字不改（含标点）
- **语气词禁写进画面段**（"她冷笑一声说" → 冷笑会被当视觉信息渲染成夸张表情）

### 4.2 `(Sx)` 编号规则

- 按**本段实际发声顺序**从 `(S1)` 起编
- **未发声的角色不给 ID**
- 同段内保持一致；跨段各自重编（H3 每段零记忆）

### 4.2·补 音色参考文件（`<Audio N>`）引用规则（2026-11-19 用户定）

> 音色分两种：**有参考音频文件的**（用 `<Audio N>` 引用，锁死音色），**无参考音频文件的**（只能用文字描述音色）。两者不能混用，也**不许给没文件的人编造 `<Audio N>`**。

- **有音色文件 → 必须 `<Audio N>` 引用**，写在 `subject_definitions`：
  `<Audio 1> is the voice-timbre reference for <Subject 1> (S1).`
- **无音色文件 → 只用文字描述音色**（`a deep, steady male voice`），**不加 `<Audio N>` 定义、也不加对应 `(Sx)` 的音色引用**；但画外声（如父亲电话音）仍要写清声源和音质（`coming exclusively from the phone speaker`）。
- **每段 `<Audio N>` 从 Audio 1 重新编号**（与 `(Sx)` 一样，H3 每段零记忆，不跨段沿用）。
- **只定义本段实际开口者的音色**，最多 3 个；本段没开口的人不写 `<Audio N>`。
- **`<Audio N>` 与 `(Sx)` 绑定**：`<Audio 1>` 对应 `<Subject N>` 时，`(Sx)` 编号与其一致，不独立另编。

### 4.3 画外声 / 电话音 / VO（★ 分「有音色文件」两档，别混）

**先判声源有没有音色参考文件（`voice_ref`）——这决定要不要给 `(Sx)`，是本节的头道岔路：**

| 档 | 典型 | `(Sx)` 编号 | `<Audio N>` | 写法 |
|---|---|---|---|---|
| **A · 无音色文件**（电话音/画外父亲/VO 独白最常见） | 姜廷山电话音、角色心里话 VO | **不给 S 编号** | **不定义、不引用** | 用英文写清**声源 + 音质 + 位置**，台词照挂 `<d>` |
| **B · 有音色文件** | 画外角色有 `voice_ref` | 给 `(Sx)` | 在 `subject_definitions` 定义并绑定 | 官方固定公式（下） |

> **A 档是本项目默认**（无参考音频时）：给电话音/VO 硬塞 `(S2)` 会把唯一 `<Audio 1>` 错绑给画外人、还会让他张嘴。实测口径：**无音色参考的画外声，明确声源和音质即可，不加 Audio 定义、不加 S 编号**（与 §4.2补 L193 一致）。

**A 档写法（电话音示例，声源+音质写清楚，无 Sx / 无 Audio）：**
```
A man's low, warm voice comes through the phone speaker (not from the woman, who keeps her lips closed): <d>[Chinese] 那爸在庆功宴上等你。</d>
```
- `comes through the phone speaker` = 声源；`low, warm` = 音质；`not from the woman, who keeps her lips closed` = 闭口证据
- 画外人**不给 Subject 标签、不进画面、不给图槽**；台词 `<d>` 照常保留原文
- 姜知微本人开口（有 `<Audio 1>`）仍用 `(S1)` 正常绑定，别把画外声算进 S 序列

**A 档 VO（画面中角色本人画外独白，人在走但不张嘴）：**
```
<Subject 1> walks on with her lips closed while her own voiceover runs over the shot: <d>[Chinese] 程远舟，这是我给你的最后一次机会。</d>
```
- 画外独白用 `her own voiceover` 声明，`lips closed` 锁口型；这句不算她"开口"，不另起 `(Sx)`

**B 档（仅当画外角色有音色文件）官方固定公式：**
```
<Subject 1> (S2) says in an off-screen voiceover: <d>[Chinese] 别回头。</d> while her lips remain completely closed.
```
三个必需要素，缺一个口型就压不住：① 固定短语 `says in an off-screen voiceover` ② `(Sx)` ③ 闭口证据 `while … lips remain completely closed` 紧跟 `</d>` 之后。

> 实测：用中文自创措辞（"画外音响起"）+ 不给声源，画面角色照样张嘴。**关键不是"给不给 Sx"，而是"写没写清声源 + 闭口证据"**——A/B 两档都必须有这两样。

### 4.4 多说话人风险（官方 issue #17，open 未修复）

**同性别多说话人必崩**（付费闭源版同样复现）。模型按粗声学特征（音高/共振峰）分人，而不是按提示词绑定。

缓解四条：
1. **声学画像拉满对比**：音高、音质、语速**反着写**（`low gravelly slow` vs `high clear quick`）
2. **一段一开口者**（最有效）——两人对吵就**拆段**
3. **清理非对白人声词**：轻笑/抽气/窃语 → 归入群杂环境音或删除（有实测因一句未格式化的 chuckle 打乱全段路由）
4. **声音只前进不回头**：A→B→A 恢复旧声必翻车；回归的说话人换新音频槽位

### 4.5 台词跨切点延续 `<scenetrans>`

一句话没说完就切镜（短剧里极常见：声音在画外继续，画面已经换人），必须显式声明音频跨切点不断，否则 H3 会把台词在切点处强行收尾。

```
[Shot 3] At 00:06.400, the camera cuts to a close-up of the phone on the table <scenetrans> as his voice runs straight through the cut without a break.
```

三件必写：
1. 切点用绑定短语（`the camera cuts to`）
2. 切点处放 `<scenetrans>`
3. 紧跟一句**正向**的音频连续证据：`his voice runs straight through the cut without a break`

> 反向写法（`don't stop the audio at the cut`）无效——H3 会把 `stop` 渲染成静音。

### 4.6 话被段尾截断 `<cutoff>`

只有**被段尾硬切**（摔门、掐断、黑场、下一段接）才用。段内自然停顿、换气、犹豫**不用**。

```
<d>[Chinese] 你给我听清楚，这房子</d><cutoff>
```

- 标记紧贴 `</d>`，中间不留空格、不加句号
- 被截断的台词**照样写完整到断点为止**，不要补 `…`、不要自行补完
- 同段内后面不得再出现该说话人的发声——`<cutoff>` 是本段最后一个音频事件

**`<cutoff>` 与段缝的分工**：段 1 结尾被打断 → 段 1 写 `<cutoff>`；段 2 开头**不承接**那句话（H3 每段零记忆），要么重说一遍，要么让段 2 从一个完整的短句起。

---

## 五、七段式 → H3 字段映射

| 原稿 | H3 | 动作 |
|---|---|---|
| 【画幅风格】行（含 `model=`） | 请求参数 `ratio` + 正文开场句 | 画幅**不进正文**；风格转成 1–2 句具体描述（Ref2VA 在 `[Shot 1]` **之前**；T2VA 在 `[Shot 1]` **之后**）；"电影感/唯美"换成可见要素（质感/色温/光位/景深） |
| 场景 `@SCN` | `<Subject N>`（环境类） | 场景**图**当环境参考 → Subject；只有要当具体帧（首/尾/构图锚）时才另立 `<Picture N>` |
| 道具 `@PRP` | `<Subject N>`（物件类） | `@` 全删；名称/材质/尺寸/状态写进定义行；**反光道具零光效描写**（不写光斑/受光/照射/亮起），只写材质本色 |
| 人物 `@CHR` | `<Subject N>`（人物类） | 外观写进定义行；`@` 全删；音色锁转成音色短语；`（在场）` 标记**不保留**，只体现在是否被镜头带到 |
| 【站位声明】 | **无对应栏** | 转成画面句并入 `[Shot N]`；禁坐标表/ASCII/`@`；**摆位必入画照旧成立** |
| 【时间轴分镜】镜行 | `[Shot 1]` / `[Shot N] At MM:SS.mmm,` | 首镜无时间戳；切点严格递增 ≤ 段时长；切镜用绑定短语 |
| 镜行内 `声音：` | 拆三层 | 环境/物理/非语言人声 → `overall_soundscape`；BGM → `non_diegetic_music`；对白 → 留正文 `<d>` |
| 台词 `【角色（语气）："…"】` | `(Sx)` + 英文说话人短语 + `<d>` | 语气位必须继承，不许丢 |
| 台词跨镜未说完 | 切点加 `<scenetrans>` | 必配一句正向连续证据（见 §4.5） |
| 台词被段尾打断 | `</d>` 后紧贴 `<cutoff>` | 不补省略号、不自行补完、本段不再发声（见 §4.6） |
| 画外声 `（OS）`/`（VO）` | 官方画外声公式 | 见 §4.3 |
| 画内文字 / 字幕 | 双引号内保原文 | 用**英文直角双引号** `"静心"`，不用中文引号/书名号 |
| FACS 微表情（AU 配方） | 可见肌肉语言 | `眼周皮肤绷紧、眉心一蹙、下唇内抿`；**AU 编号/强度档不进正文** |
| 抽象形态形容 | 具象可见形态 | 成线/成串/如注/轻蜷 → "雨滴砸在手背上溅开" |
| 首镜单主体 | 一个具名主体统摄 | 禁「X 与 Y 同框」并列；部位以"她的/其 + 部位"从属；禁悬空代词（"那只手"→"她的手"） |
| 禁令 | 正向表述 | 否定式一律不进正文 |
| Hit-Stop / 顿挫 / 蓄力 | 可见物理描述 | "接触的一拍里短暂凝住 + 反作用力"；顿挫/阻尼/弹开/压缩蓄力不进正文 |
| 【音效】【强制禁止项】 | **不进正文** | H3 正文只写"有什么" |
| 段时长 | ≤15s | 超过 15s 必须再拆一刀 |

---

## 六、载荷

### 路径 B · 本地/自建 H3-Base（主线）

```json
POST http://<host>:30011/v1/videos
{
  "task": "ref2va",
  "prompt": "<六段式全文>",
  "conditions": [
    { "type": "image", "uri": "…", "role": "reference" },
    { "type": "video", "uri": "…", "role": "reference" },
    { "type": "audio", "uri": "…", "role": "reference" }
  ],
  "target": { "short_edge": 768, "aspect_ratio": "9:16", "duration_seconds": 12 },
  "seed": 0
}
```

`task` 取值：`t2va` / `i2va` / `l2va` / `fl2va` / `ref2va`

### 路径 A · 官方托管 H3-Context-IR

```json
POST {MINIMAX_API_BASE}/v2/h3_context_ir
{
  "model": "MiniMax-H3",
  "content": [
    { "type": "text", "text": "<自然语言指令>" },
    { "type": "image_url", "image_url": { "url": "…" }, "role": "reference_image" }
  ],
  "duration": 12,
  "ratio": "9:16"
}
```

> 走路径 A = 结构化交给官方 Context-IR，剧作质量由它决定。**本包的价值集中在路径 B 的 `prompt`。**

---

## 七、规格表（写死）

| 项 | 值 |
|---|---|
| 单段时长 | **4–15 秒** |
| 参考图 | **≤9 张** |
| 参考视频 | ≤3 段（每段 2–15s、总 ≤15s） |
| 参考音频 | ≤3 段（**必须与图或视频同用，不能单独投**；每段 2–15s、总 ≤15s） |
| 混合输入总数 | **≤12 个文件** |
| 画幅 | 官方六档 `21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16`；参考模式可用 `auto` / `adaptive`。**本包推荐 `9:16`（竖屏短剧），`16:9` 实测可用**；全片一个画幅，**不用 auto**（auto 会跨段自己改画幅，段缝必崩）。画幅只写载荷，不进正文 |
| 输出 | 24 FPS、32 kHz 立体声、默认短边 768；2K 走 `H3-Regenerate-2K` |
| 对话语言 | 官方稳定支持 11 种（含中文） |

> ⚠️ **真人脸红线：H3 官方没有这条**（只有通用内容审核：违法/色情/侵权）。不要把其他模型的真人脸素材限制照搬过来。
