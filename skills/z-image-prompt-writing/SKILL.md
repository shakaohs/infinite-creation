---
name: z-image-prompt-writing
description: 为 Z-Image Turbo 超写实文生图（t2i）编写英文为主的正向提示词，只产 prompt、不产 negative_prompt（负向通道物理死亡）。使用时机：为漫剧项目生成人物四视图设定板、场景环境图、道具白底图等文生图资产生图。触发词：Z-Image、z-image、文生图、人物设定板、四格板、场景图、道具图、资产生图、生图提示词。
---

# Z-Image 文生图提示词写作

把一句需求或一条资产设定，写成可直接投喂 Z-Image Turbo（ComfyUI 本机通道，cfg=1.0）的英文提示词。**本 Skill 只负责「写提示词」，不连 ComfyUI、不出图、不跑脚本**——实际出图走 `zimage-local-gen`，本 Skill 产出的是它要吃的 `prompt` 字段。

---

## 〇、根本特性（3 条铁律，写任何提示词前先记住）

这三条决定了 Z-Image 文生图与 SD-WebUI / Midjourney 的写法**彻底不同**，违反其中任一条都会直接翻车。

### 铁律 1 · 负向通道物理死亡

本机工作流用 `ConditioningZeroOut` + `cfg=1`，**`negative_prompt` 在数学上等于没写**——CFG 1.0 不做负向排斥，空负向不产生任何「推离」力。

- 后果：一切「不要 / 禁止 / 排除」类写法，要么无效，要么被当正向读。
- 正确做法：**只写正向**，把「不想要什么」改写成「想要什么」。
- 权威技术依据：ComfyUI 官方 Z-Image-Turbo 模板即「`ConditioningZeroOut` → 负向喂零串」，采样为 8 步 / `res_multistep` + `simple` / `ModelSamplingAuraFlow shift=3` / 默认 16:9 @ 1MP（1368×768）。Diffusers 侧官方口径 `guidance_scale=0.0`（「turbo 模型不需要 CFG」）。多源一致结论：**CFG 一旦 >1 会「烤焦 / 过对比」**，负向词失去意义。

### 铁律 2 · 英文优先

写实模型先验是英文分布，**中文压不住**。实测：中文「无斑」压不住雀斑，英文才压得住。

- 提示词正文**一律英文**；中文只允许出现在「要真实渲染出来的文字」里（见 §四）。
- 皮肤无斑、材质、构图三处**必须英文**（见 §五）。
- 边界澄清：Z-Image 的 Qwen3-4B 编码器**中英双语语义都能读懂**（官方明示 bilingual，中文理解强）；但**皮肤瑕疵压制、材质质感、构图分布**这三处依赖写实训练的英文先验分布，中文压不住——所以「语义层可双语，精细控制层必须英文」。

### 铁律 3 · 否定词根必被渲染

写「不要边框」= 画黑框（实测 16px）；写「无字幕」= 画乱码字幕条。

- 根因：否定词本身携带了「边框 / 字幕」这个词根，模型把词根当画面内容画了出来。
- **适用范围限定**：这条针对的是**视觉载体类**否定（`no text / no border / no watermark / no subtitles / no logo` 等），这类词会反向渲染出实体。
- **例外**：皮肤瑕疵类否定（`no freckles / no blemishes`）实测**安全且有效**——瑕疵不是模型主动要画的载体，英文先验能压住。这与铁律 3 不冲突，二者适用对象不同（详见 §一）。

---

## 一、人物资产（四格设定板）

### 1.1 权威版式契约（流水线测试可用，只能用它，禁止另起炉灶）

人物四格板的版式、背景、光位、皮肤、颜值气质，由流水线代码层（`composeCharacterT2IPrompt` → `CHARACTER_T2I_LAYOUT_CONSTRAINT`）**强制注入**，以下契约已经过测试可用。**本 Skill 描述必须与它逐字一致，禁止改成其它版式**（尤其禁止「单一面部锚点 + 无脸三视」这类变体）。

```
【人物设定板｜强制版式，优先级最高】
一张横向四格角色设定板，四格等宽并排，铺满整张画面宽度，每格占满画面高度。
从左至右：
第一格：正面大脸特写，头肩完整入画。
第二格：正面全身，从头到脚，正面朝镜头。
第三格：90°侧面全身，从头到脚。
第四格：背面全身，从头到脚。
四格是同一人物、同一服装、同一发型、同一光位、同一身体比例。
背景为纯白无缝背景（#FFFFFF），均匀一致，一直延伸到画面四边；四格共用这一整片连续纯白。
单一柔光自左上方打入，四格光位与色温完全一致，电影级质感。
皮肤要求（2026-11-21 实测定版，分男女两档）：女性用 flawless, smooth, even, clear, radiant skin, no freckles, no blemishes, no spots, no dullness（可做到彻底无斑）；男性（中年）接受自然皮肤质感、年龄感优先，只用 clean-shaven, well-groomed, fresh clear skin, smooth even complexion 兜住「不邋遢、不满脸斑」的底，不写 no age spots/no sun spots/no wrinkles 这类无效否定词。皮肤干净通透、均匀、有自然光泽，不过度磨皮、不塑料感。
颜值气质：五官精致立体、轮廓分明、眉眼有神、妆面干净，好看、有辨识度、有高级气质；不刻意模仿任何现实明星或网红，是「长得好看的普通人」而非「某明星既视感」。
画面里只有这一位人物与纯白背景。
```

### 1.2 LLM 的职责（只写纯外观，版式交给代码）

代码层已经锁死四格版式、纯白背景、光位与皮肤契约，**LLM 只需写「这个人长什么样」的纯外观**：

- 内容三段式：面部 → 发型 → 服装 → 气质（不夹版式 / 背景 / 光位 / 视图数量 / 画质参数描述）。
- 面部：脸型、眉眼、鼻、唇、妆容（裸妆/眼妆/唇妆色号）、皮肤质感。
- 发型：发色、长度、卷度、分线、配饰（墨镜/发饰）。
- 服装：款式、面料、颜色、剪裁、鞋。
- 气质：把气质落成**可见事实**（眼神、嘴角、站姿、肩颈、轮廓），不堆「温柔/知性」空词。
- 否定式改正向：「不要浓妆」→「妆容清透淡雅」（`light, fresh makeup`）。

### 1.3 皮肤分男女两档（与代码契约一致，别混）

| 档位 | 写法 | 铁律 |
|---|---|---|
| 女 | `flawless, smooth, even, clear, radiant skin, no freckles, no blemishes, no spots, no dullness` | 英文正向词 + 瑕疵否定（`no freckles/blemishes/spots` 实测有效，可彻底无斑） |
| 男（中年） | `clean-shaven, well-groomed, fresh clear skin, smooth even complexion` | **不写年龄数字**（写「40岁 / 成熟」必出老年斑）；**不写 `no age spots / no sun spots / no wrinkles`**（无效） |

- 男档关键：中年男性「年龄感」是深层先验，`no age spots` 压不住；用 `clean-shaven, well-groomed`（刮净胡须、打理得体）引导年轻感。
- 女档的 `no freckles / no blemishes` 有效，是因为「雀斑」是可压制的表层瑕疵；「年龄感」是压不住的深层先验——两条不同现象，别混为一谈。
- 肤色具体词（白皙 / 小麦 / 古铜）按角色设定插在皮肤基线句之前。

### 1.4 颜值气质基线（电影级，落成骨相而非空洞形容词）

男帅女美 + 大气是底线，成品拉到电影级颜值——不是「像某明星」（触发肖像先验，不可控），而是把「漂亮」用具体骨相与气场做实：

- **五官骨相**：`high cheekbones`（高颧骨）+ `defined jawline`（清晰下颌线）+ `refined symmetrical features`（精致对称五官）——与代码契约的「轮廓分明、五官精致立体」同一口径，落到英文具体词。
- **气场气质**：`striking / luminous / magnetic presence / composed elegance`，不用空洞的 `beautiful`。
- **打光保持单一柔光左上**：电影感体现在「人」的骨相与气场，不靠多灯轮廓光堆——多灯会破坏纯白底、污染 H3 取脸。

### 1.5 权威设定存档

用户给出的角色设定**一字不改**存入 `context/NN-角色名-anchor.md`（NN 为角色编号），作为该角色锚定文档；后续每张人物图都从 anchor 文档取设定，不凭记忆重写。

---

## 二、场景资产（16:9）

### 2.1 宏大电影感硬基线

场景要**宏大、有电影体量感**，不是「明亮的房间照」。三层纵深是骨架（前景遮挡 + 中景主体 + 远景纵深），叠加**电影感四件套**：

- **体量词**：`epic scale / vast expanse / monumental / towering / grand`——把空间写「大」。
- **电影镜头**：`sweeping wide establishing shot`（大广角定场镜）+ 低机位仰拍或高机位俯拍（`low-angle / aerial view`）+ 强烈透视纵深。
- **戏剧性光线**：`volumetric light / god rays / atmospheric haze / dramatic rim light`（体光、丁达尔、空气透视、轮廓光）。
- **电影调色**：`cinematic color grade / teal-and-orange`——影调往「电影」靠，不往「生活照」靠。

### 2.2 风格只进场景图，不写进人物图

- 画风 / 影调 / 色调 / 质感的**风格词只写进场景提示词**。
- 人物图写风格 → 白底染色，污染下游 H3 参考图。人物图保持纯白底、无风格词。

### 2.3 空间 / 边缘词绑具体名词

实测：`neon spill at frame edge` 被画成**实体灯管**。凡是「画面边缘 / 框边 / 溅出 / 溢出」这类空间词，必须**绑到具体名词**上（如 `soft neon glow spilling across the far wall`），否则会被实体化。

---

## 三、道具资产（1:1）

- 纯白背景，**只出道具本身**（无手、无人物、无手持）。
- **保留道具自带的文字 / 标签 / 品牌 logo**（道具图不受人物板「零文字」约束）。
- 依据：文字渲染是 Z-Image 的**核心强项**——官方宣称「首个准确渲染复杂中英文字符的开源模型」，道具标签 / 招牌 / 品牌字直接写清原文即可稳定出字（要出可读文字时，绝不与 §四禁文字档混用）。

---

## 四、文字处理（两档）

| 档位 | 触发 | 写法 |
|---|---|---|
| 未限制 | 场景需要真实文字（招牌 / 菜单 / 标题） | 写清字句原文、语种、印字部位，**绝不挂 `no text` 全局禁字词** |
| 禁文字 | 画面不得出现任何文字 | **一律回避**：用「无字载体」替换有字载体，**绝不写 `no text` 否定句** |

### 4.1 禁文字档的执行细则（实测）

- **消灭载体，不要求模糊**：写「墙上贴着褪色的菜单板但字迹已模糊不可辨」→ 照样画满伪汉字。**正解换成空白载体**：「墙上只有一块发黄的空白塑料板，板面均匀米白色、无图案」。
- **门外 / 窗外街景是文字污染源**：路牌、店招、遮阳棚上的字会渗进来。要全画面零文字，把门外景压成过曝或虚化暗部，或不给「临街门面」设定；短剧里更稳的是**别拍带街景的角度**。
- **服装 / 旗帜类**：写 `plain unmarked fabric banner`（素面无标织物横幅）这类「无字载体」正向词，不用 `no text`。
- 任何 `no text / no captions / no subtitles / no watermark / no on-screen text` 均删除，**不替换成等价正向句**（替换句仍自带 lettering / signage 词根，照样出字）。

---

## 五、prompt 语言与结构

### 5.1 语言

- **英文为主**（铁律 2）。
- **皮肤无斑 / 材质 / 构图三处必须英文**（中文压不住的实测重灾区）。
- **自然语言整段，非标签流**：Qwen3-4B 是 LLM 编码器，读提示词像读指令——「长自然语言整段」远优于 danbooru 标签堆砌（`1girl, solo, upper body` 会出碎片画面）。官方示例即「短段落散文」式描述。
- **长提示词是优势，不是负担**：`max_sequence_length=1024`，主体写得越具体、可控性越强；抽象形容词（`beautiful / mysterious / nice clothes`）没有视觉信息，一律替换成具体特征。

### 5.2 顺序（固定）

```
[媒介锚定] + 主体特征 → 服装妆发 → 构图/背景/光位 → 无斑强压句
```

- **媒介锚定句开头**：主体特征段以 `A photograph of…` / `A studio portrait of…` / `A digital painting of…` 起手，先把媒介 / 画种 / 风格定死（官方「Lead with the medium」口径）。
- 「无斑强压句」是**独立结尾句**，任何写实人物图都要落在这一句收尾（女档用 §1.3 皮肤句，男档用 clean-shaven 句）。
- 顺序固定不可调换——把无斑句提前会稀释主体，把主体拆散会出碎片画面。

---

## 六、雷区清单（禁止写法对照表）

| 错 | 后果 | 对 |
|---|---|---|
| `不要边框 / no border` | 画黑框（实测 16px） | 删 |
| `无字幕 / no text` | 画乱码字幕条 | 删（禁文字档改换无字载体） |
| 中文「无斑」 | 压不住雀斑 | 英文 `flawless, smooth, even, clear, radiant skin, no freckles, no blemishes, no spots, no dullness` |
| 男档写「40岁 / 成熟」 | 必出老年斑 | `clean-shaven, well-groomed`，不写年龄数字 |
| `at frame edge`（空间边缘词不绑名词） | 实体化灯管 | 绑具体名词（`glow spilling across the far wall`） |
| 人物图写风格 | 白底染色，污染 H3 参考图 | 风格词只进场景图 |
| 中文提示词压皮肤 / 材质 / 构图 | 压不住 | 这三处必须英文 |
| danbooru 标签流（`1girl, solo, upper body`） | 碎片画面 | 改写自然语言整段 |
| 「X as Y」融合概念（`A 作为 B`） | 画成两个东西并排 | 一个名词 + 用姿态/服装/场景属性承载第二概念 |
| 抽象形容词（`beautiful / mysterious / good lighting`） | 无视觉信息，出图漂 | 换成具体特征（眼型/光源方向/镜头焦段） |
| 「像某明星 / 网红」 | 触发肖像先验，身份不可控 | 描述具体五官特征 |

---

## 七、输出格式

- **只出** `{"prompt": "..."}`，**不出 `negative_prompt`**（负向通道已物理死亡，写了也是空转）。
- 回复用户时必须回显最终 `prompt` 全文，供其复核。

---

## 八、调用方式

```
update_asset(id, {prompt}) → generate_assets_batch
```

- 逐条产出后经 `update_asset(id, {prompt})` 写入资产，**批量优先**——攒够一批再 `generate_assets_batch` 统一出图，不要逐张触发。
- 人物换装 / 年龄变体是图生图（i2i，Qwen-Image-Edit），走 `change_outfit` / `change_age`，**不适用本 Skill 的文生图口径**。

---

## 附 · 四个完整正例（英文 prompt）

> 注意：正例里的「人物四格板」为了可独立使用写了完整版式；挂进流水线时，代码层会剥离版式、注入 §1.1 的权威契约，纯外观部分照常保留。

### 人物四格板（女）

```
A studio portrait of a young woman, strikingly beautiful with high cheekbones, a defined jawline, luminous almond eyes, natural dark eyebrows, refined symmetrical features; long straight black hair; elegant off-white blouse and dark grey trousers; composed elegant bearing. flawless, smooth, even, clear, radiant skin, no freckles, no blemishes, no spots, no dullness.
```

### 人物四格板（中年男）

```
A studio portrait of a middle-aged man, handsome with a strong defined jawline, chiseled refined features, deep-set striking eyes, short dark hair; well-pressed dark suit with a plain white shirt; composed magnetic presence. clean-shaven, well-groomed, fresh clear skin, smooth even complexion.
```

### 场景空镜（16:9）

```
A vast sweeping wide establishing shot of an immense grand hall, epic scale with a towering vaulted ceiling, monumental stone columns receding into the far distance, a blurred foreground balustrade on the lower left, deep atmospheric perspective with layered depth from near to far. Volumetric god rays slanting through tall arched windows, drifting haze in the air, dramatic cinematic rim light along the columns. Cinematic teal-and-orange color grade, low-angle wide lens emphasizing the height. Uninhabited empty interior with blank unmarked stone surfaces, clean open floor.
```

### 道具（1:1）

```
Product shot of a single vintage brass pocket watch, centered alone on a pure white seamless background, 1:1 square framing. Detailed engraving on the case, readable brand lettering and a small logo on the dial, a worn leather strap with visible stitching. Even soft studio light, the watch as the only subject in frame.
```

<!-- 出处索引：
     〇/一/二/三/五/六 来自 .workbuddy/memory/2026-11-21.md 实测铁律 + image-prompt-writing 已改口径 + 流水线代码契约 CHARACTER_T2I_LAYOUT_CONSTRAINT；
     踩坑细节（16px 黑框 / 乱码字幕 / 灯管实体化 / 无字载体 / 街景文字污染）来自 zimage-local-gen/SKILL.md 本机实测；
     字迹两档与正例结构参照 short-drama-image-prompts/references/sheet-prompt-guide.md；
     网络权威来源（2026-11-23 检索）：
       - ComfyUI 官方 Z-Image-Turbo 模板解析（syntheticlabs.xyz）——8 步 / CFG1 / res_multistep+simple / shift3 / 16:9@1MP / ConditioningZeroOut / lumina2；
       - Z-Image Turbo 指南与 Prompt Engineering（z-image.vip、zimage.run、zimageomni.app）——guidance_scale=0、无负向、自然语言优于标签流、Lead with the medium、具体>抽象、反模式（beautiful/like celebrity/X as Y）；
       - HF 社区文档（jc-builds/Z-Image-Turbo-iOS prompting guide）——Qwen3-4B-Instruct 编码器偏好长自然语言、融合概念陷阱与解法。 -->
