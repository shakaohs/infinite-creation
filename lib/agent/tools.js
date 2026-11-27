import path from 'node:path';
import fs from 'node:fs';
import sharp from 'sharp';
import { spawn } from 'node:child_process';
import {
  loadConfig, Projects, Assets, Shots, ShotVideos, Chapters, Workflows, ReferenceImages,
  logger, uid, slugify, randomSeed, chapterStats, Queue,
  SKILLS_DIR, ensureProjectDirs, projectDir, resolveProjectPath,
  assembleShotReferences, fallbackVideoPrompt, validateSubShots,
  dialogueSpeakerNames, MAX_SPEAKERS_PER_SHOT, MAX_IMAGE_REFS,
  SHOT_DIALOGUE_MAX_RATE, SHOT_DIALOGUE_MAX_RATE_EN, SHOT_DURATION_MIN, SHOT_DURATION_MAX, SHOT_DURATION_DEFAULT, dialogueSpeed,
  shotDurationMax, durationProfile, durationHint, ensureScriptAssets,
  fallbackAssetPrompt, llmChat, extractJson, composeCharacterT2IPrompt, composeCharacterNegativePrompt,
  imageToDataUrl, buildVisionUserMessage,
  runWorkflow, pickOutput, downloadToFile, getSpecForKind, getR2vSpecForResolution, uploadTaskInput,
  mergeVideos, withWriteContext, resolveSubtitles, renderConcurrencyLimit, inferVideoMode,
  probeImageSize, resizeImageFile,
  listNovelFiles, readNovelFile, writeNovelFile, loadNovelState, saveNovelState,
  upsertSceneStates, assertSceneKeysExist, listSceneStates, sceneStateError, isStructuredSpec,
} from '../core/index.js';
import { PROJECT_ASSET_SUBDIRS, ASSET_CATEGORY_IDS, imageSizeFor, IMAGE_RESOLUTIONS, RATIO_LIST, inferVoiceBaseline, filterReferenceImages, CONTEXT_KEYS, textMentions, isVariantAssetCategory, VIDEO_MODES } from '../shared/index.js';
import { loadSkillWithResources, renderSkillContent } from './skill-engine.js';
import { isOfficialMinimaxPrompt, hasRef2vaInstructionLine } from '../core/h3-native-prompt.js';
import { checkVideoPrompt } from '../core/skill-check.js';
import { guardToolCall } from './guard.js';
import { searchWeb, searchImages, downloadImageSafe } from './search.js';

// ================= H3 Ref2VA 六段式通用格式规范（内联常量，不动态加载 skill） =================
// 来源：forest-laoli-h3 skill 的 references/h3-format.md + 用户定稿规范（11-h3-work-spec-v1.md）通用部分。
// 只保留「写一条 H3 六段式提示词」真正需要的格式与铁律，剔除剧目专属内容与全流程说明。
// 目的：写单镜提示词时不再每次全量加载 28KB 的 SKILL.md（慢、耗 tokens、会把轻量模型撑爆返回空）。
const H3_REF2VA_FORMAT_RULES = `<h3_ref2va_format>

你是 MiniMax H3 视频提示词撰写助手。严格输出官方 Ref2VA 六段式，字段名、顺序固定不可调换：

subject_definitions
summary
retention_analysis
detailed_description
overall_soundscape
non_diegetic_music

正文一律英文；只有台词保留中文（见下）。只输出六段式正文，不要任何解释、标题、Markdown 围栏。六段必须齐全。

【subject_definitions】
- 每个参考主体一条，写清「是谁 + 对应哪张图 + 可见外貌」：发式、肤色、服装、体型、显著标记、随身物。只写可见外观，不写性格/心理/身世。
- 人物：<Subject 1> is the woman in <Picture 1>: 四十出头，黑色低马尾，鹅蛋脸杏眼，米白针织衫配浅灰长裤……
- 场景（环境参考图）：<Subject 3> is the dockside in <Picture 6>: ……（场景图当环境参考 → 用 Subject 锁空间，写清关键固定物，供后续「stay in place」锚定）
- 音色（有参考音频文件时）：<Audio 1> is the voice-timbre reference for <Subject 1> (S1). 每段 <Audio N> 从 Audio 1 重新编号，只定义本段实际开口者的音色，最多 3 个；没有音色参考文件的人不写 <Audio N>，只用文字描述音色（a deep, steady male voice）。
- 禁止写空壳「is the subject shown in <Picture N>」，必须写具体外貌。
- 定义数 ≤9；定义了就必须在正文被引用。只列出本段真正出场/用到的参考主体，不要为凑数塞入不相关的资产。参考图总量尽量控制在 7 张以内（H3 参考最优），优先保留人物与场景，道具图可省则省。

【summary】
- 任务类型前缀开头（裸前缀 + 破折号，不用方括号）：reference generation — 本段发生了什么。前缀：keyframe completion / reference generation / video editing / video continuation / audio reuse / audio reference；Ref2VA 默认 reference generation。

【retention_analysis】
- 用官方状态词，视觉：fully_preserved / partially_preserved / attribute_transfer / weak_reference；音频：fully_copy / partially_copy / reference / weak_reference。
- 例：<Subject 1> (image): fully_preserved — face, hairstyle and clothing retained.
- retention_analysis 里不写 (Sx)（说话人编号只属于对白）。

【detailed_description】
- 先写整体风格（质感/色温/光位/景深），再按镜头顺序描述。
- 第一镜 [Shot 1] 不写时间戳；第二镜起 [Shot N] At 00:SS.mmm（严格递增、不超过段时长）。
- 切镜只用官方五短语：the camera cuts to / the shot cuts to / the shot transitions to / the shot changes to / the shot switches to。只改景别不切镜（用连续运镜，如 slides forward 15 cm over two seconds on a rail）。
- 每镜写：景别 + 机位角度 + 运镜 + 画面事实。
- 单镜正文 ≤70 词；一镜最多两个 <Subject>，且只给其中一个写动作，同框第二人只写静态维持（stands still ...）。

【站位与越轴 · 硬锁】
- 人数不变、场景不变的段落：所有人从 [Shot 1] 就全在场，站位/朝向从第一镜到末镜 100% 锁定不变；切镜只切三样——机位、景别、看向谁，不切「谁在场」。
- 每镜明确写清谁在哪（left / right / behind the table / at the frame edge）、面朝哪（facing left / facing right）、看向谁。
- 越轴铁律：双人对话必须写 the camera stays on the same side of the axis（机位停在轴线同一侧）；两人视线朝向成对呼应（A 朝右看、B 朝左看回来）。只有剧情明确需要才越轴，且必须显式声明。
- 段尾每镜末尾补一句正向维持句锁站位：Every person keeps the position and facing set in [Shot 1] for the whole segment.（或具体物 stay in place / stays fixed）。

【动作自然度 · 硬锁】
- 每个动作必须有起点、过程、终点，三者都写；只写结果（she stands at the cart）模型会瞬移。
- 不许跳过动作过程（放下手机→手落身侧→转身→握把手→起步，缺一环就补错位）；不许重复已完成动作。
- 单镜动作 1–2 个；两个动作同时发生会被演成一前一后，用时间点分开写（At 00:02.000 ...）。
- 禁止突然手势、多余动作、人物位置跳变、凭空出现/消失。

【物理真实 · 写实类强制】
- 不写受力就退化成「站着」。写动作前先答：谁托着他 / 谁在拉他 / 什么挡着他 / 什么拽着他，至少写两样进正文。
- 手扶/手抓/手撑的东西必须在臂长内；写接触的物理结果（推门→门被推开的重量跟过来），不写抽象结果。
- 人物镜要能回答「他背后三米内是什么」，特写近景必须带背景实体（甲板/栏杆/墙/车座），否则人物像抠图贴背景。
- 持物一致性：哪只手 + 握在哪 + 手的高度 + 道具朝向，全片只用同一种拿法，段首段末复述。

【表情与表演】
- 禁写心理词/结论词（she is nervous / looks sad / coldly），拆成可见肌肉动作（brows pull together / the inner ends of her brows lift / her lips press into a thin line）。
- 禁夸张表情：不写「夸张的悲伤/愤怒」，写克制的可见微动；程度用可见计数（her lips part by a finger's width），不用 very/slightly。
- 语气词禁写进画面段（「冷笑一声」会被渲染成夸张表情）。

【台词与口型】
- 格式：<Subject 1> (S1) says: <d>[Chinese] 原始台词</d>。语气写在 <d> 外面（英文，含 pitch/timbre/speaking rate），<d> 内只放语言标签 + 台词原文，逐字不改（含标点）。
- (Sx) 按本段实际发声顺序从 (S1) 起编；未发声角色不给 ID。
- 画外音固定公式：<Subject 1> (S1) says in an off-screen voiceover: <d>[Chinese]……</d> while her lips remain completely closed.
- 每个说话人开口时，保证脸嘴清晰、口型与中文台词自然同步（优先近景/特写/中近景）；听者保持闭唇。
- 中文口播约 3.3 字/秒：8 秒镜头台词约 8–11 字为宜；一镜一句，台词放镜末（动作描述之后）。
- 同性别多说话人容易串音：音高/音质/语速反着写（low gravelly slow vs high clear quick）。

【overall_soundscape】
- 只写现场环境音/动作音/非语言人声（风声、脚步、纸张摩擦、呼吸）。不含台词、不含 BGM。

【non_diegetic_music】
- 只写背景配乐（乐器/速度/情绪）。无 BGM 写 N/A。

【通用铁律】
- 词根零容忍：否定词/抽象词禁写（写「不要X」会被画成 X），用正向事实描述。
- 只优化不创作：不擅自改剧情、台词、动作、分镜顺序。
- 每段自包含：重新交代场景/人物外貌/服装/站位/朝向/动作/道具，不写 same as previous。
- 字幕关的项目：提示词里不提任何与字幕/文字有关的句子（不写否定句、不写替换句），中文台词照常说出。

</h3_ref2va_format>`;

// 写视频提示词的「技能后半段」权威规范：按 video_model 走对应的全流程技能，加载其权威规则全文。
// 用户口径（2026-11-23 / 2026-11-24）：让流水线「真正基于全流程」出稿——H3 线用 forest-laoli-h3，
// Seedance 线用 short-drama-director（漫剧老李）。之前只注入 h3-format.md + h3-lexicon-cleanup.md 两个文件，
// 铁律二十条、物理真实、空间锚点、镜语法、表演、台词密度、氛围、H1-H38 对照全没进 system，模型自然想怎么写怎么写。
// 全文不裁剪（DeepSeek 自动前缀缓存实测 97.5% 命中，重复 system 不重复计费；体积由换更大模型解决）。
// 顺序 = 出稿顺序：先适配层/总纲 → 格式 → 语法 → 空间 → 物理 → 表演 → 台词 → 氛围 → 机位 → 清洗 → 机检对照。
// 读不到时回退到内联精简常量 H3_REF2VA_FORMAT_RULES，保证流水线不阻断。
const VIDEO_PROMPT_SPEC_REFS = {
  // H3 线：forest-laoli-h3（唯一权威）
  'forest-laoli-h3': [
    '00-framework-adapter.md',  // ★ 框架适配层：阶段映射/覆盖声明/字段对应（先读，避免照抄上游交互门）
    'SKILL.md',                 // 全流程总纲：G0 锁 + 七阶段 + 铁律二十条 + 规则库索引
    'h3-format.md',             // 三字段/六段式规格 + 跨镜锁定自检清单 + 画外声 §4.3
    'h3-shot-grammar.md',       // 运镜·越轴·站位三件套 + 八档四轴镜行语法
    'spatial-anchor-and-hold.md', // 空间锚点/维持句/门窗分身/段间尾帧续接(H50-H58)
    'physics-realism.md',       // 物理真实律：介质判定表/支撑面/力成对（P0）
    'acting-facs.md',           // 四区肌肉总表
    'acting-recipes.md',        // 30 种情绪英文配方
    'acting-listen.md',         // 听戏五步反应链
    'dialogue-density.md',      // 台词密度 3.3 字/秒 + 声槽绑定
    'atmosphere-and-light.md',  // 氛围六件套 + 三层分工
    'camera-four-axis-h3.md',   // 八档四轴转化表
    'h3-lexicon-cleanup.md',    // 词根黑名单 + 五遍清洗
    'h3-constraints-qc.md',     // 硬约束 H1-H38 对照（机检判读）
  ],
  // Seedance 线：short-drama-director（漫剧老李全流程）。七段式语法唯一权威 = model-adapters.md。
  'short-drama-director': [
    'SKILL.md',                    // 框架内执行入口：锁位取值/阶段映射/覆盖声明/必读清单
    'model-adapters.md',           // ★ 七段式投喂语法唯一权威（2.5 / 2.0 分开取章）
    'seedance-render-engine.md',   // 三层解耦 + 时长预算
    'aspect-ratio-adaptation.md',  // 画幅回填
    'camera-specs-15rules.md',     // 镜头五要素 + 景别阶梯
    'dialogue-speed-check.md',     // 台词语速自检
    'vo-os-weaving.md',            // OS/VO 声画分离与配额
    'segment-splicing.md',         // 段缝衔接（【站位声明】承接口径）
    'blocking-direction.md',       // 站位/权力几何/依托物
    'prompt-feeding-checklist.md', // 投喂前必过清单
  ],
  // 历史派生技能（保留兼容：老项目 config 里可能还指向它们）
  'h3-storyboard': [
    'SKILL.md',
    'h3-format.md',
    'h3-shot-grammar.md',
    'spatial-anchor-and-hold.md',
    'physics-realism.md',
    'acting-facs.md',
    'acting-recipes.md',
    'acting-listen.md',
    'dialogue-density.md',
    'atmosphere-and-light.md',
    'camera-four-axis-h3.md',
    'h3-lexicon-cleanup.md',
    'h3-constraints-qc.md',
  ],
  'storyboard-director': ['model-adapters.md'],
  'combat-storyboard': ['shared/model-adapters.md'],
};
// 按视频模型决定读哪个技能的「提示词书写」reference 全文：
// - h3 → forest-laoli-h3（H3 全流程，六段式）
// - seedance25/seedance20 → short-drama-director（老李全流程，七段式）
// config 的 video_prompt 节点若显式指向别的已知技能，仍尊重该配置（兼容老项目）。
function loadVideoPromptSkillSpec(cfg, videoModel) {
  const m = String(videoModel || 'h3');
  const nodes = cfg?.skillPipeline?.nodes || {};
  const names = Array.isArray(nodes.video_prompt?.skills) ? nodes.video_prompt.skills : [];
  const preferred = names.find((n) => VIDEO_PROMPT_SPEC_REFS[n]);
  let skillName;
  if (m.startsWith('seedance')) {
    // 七段式语法只有老李一套；config 里若指向老李/派生技能就沿用，否则强制走老李全流程。
    skillName = preferred && /short-drama-director|storyboard-director/.test(preferred) ? preferred : 'short-drama-director';
  } else {
    skillName = preferred && /forest-laoli-h3|h3-storyboard/.test(preferred) ? preferred : 'forest-laoli-h3';
  }
  const refs = VIDEO_PROMPT_SPEC_REFS[skillName] || [];
  const parts = [];
  for (const ref of refs) {
    try {
      // SKILL.md 在技能根目录，其余在 references/ 下。
      const fp = ref === 'SKILL.md'
        ? path.join(SKILLS_DIR, skillName, 'SKILL.md')
        : path.join(SKILLS_DIR, skillName, 'references', ref);
      const text = fs.readFileSync(fp, 'utf8');
      // 标注出处：让模型明确「这是 h3 全流程 skill 的权威条款」，逐条对照执行而非凭印象。
      if (text && text.trim()) parts.push('===== 权威规则来源：' + skillName + '/' + ref + ' =====\n' + text.trim());
    } catch { /* 单个 reference 读不到不影响其余；全部读不到则由调用方回退内联常量 */ }
  }
  return parts.length ? parts.join('\n\n') : null;
}

// Seedance 无人值守锁卡：model-adapters.md 原生要求「A/B/C 锁未指定=停下询问」，
// 但流水线无人值守——锁已由前端创建页/项目设置确定，这里前置声明覆盖，禁止 LLM 反问。
function buildSeedanceLockCard(cfg, project) {
  const vm = String(project?.video_model || 'h3');
  const version = vm === 'seedance20' ? 'Seedance 2.0' : 'Seedance 2.5';
  const ratio = project?.video_aspect_ratio || cfg?.projectDefaults?.aspectRatio || '16:9';
  const ratioCN = ratio === '9:16' ? '9:16 竖屏' : ratio === '21:9' ? '21:9 宽幕' : ratio === '1:1' ? '1:1' : '16:9 横屏';
  const seamMap = { auto: '由镜头节拍自动判断', tail: '末帧定格承接（尾帧锚定法）', cut: '换机位硬切', blank: '空镜过渡' };
  const seam = seamMap[project?.seam] || '由镜头节拍自动判断';
  return [
    '【无人值守锁 · 已由前端确定，禁止反问、禁止自行改锁】',
    '- A 模型版本：' + version + '（video_model=' + vm + '）。2.5 与 2.0 语法彻底分开，严格按此版本的对照表执行；规范里「未指定版本=停下询问」的条款不适用，版本已锁定。',
    '- B 画幅：' + ratioCN + '（宽高比=' + ratio + '）。每条提示词【画幅风格】行与 API 载荷都回填此值；规范里「未指定画幅=停下询问」条款不适用。',
    '- C 交付形态：流水线固定「七段式 md 投喂稿 + 成片」，不出离线看板；规范里 C 锁询问条款不适用。',
    '- D 段缝衔接：' + seam + '。',
    '- I 画风锁：以项目「画面风格」为准（见用户信息）；影像基底据此确定。',
    '- 参考模式：按本镜实际参考素材决定（全能参考优先）；2.0 无首尾帧，禁写 first_frame/last_frame。',
    '以上锁位已全部落定，直接执行，不得在提示词里写任何询问或默认声明。',
  ].join('\n');
}

// ================= 工具定义（OpenAI function-calling） =================
export const TOOL_DEFINITIONS = [
  { type: 'function', function: { name: 'skill', description: '加载一个可用技能的完整说明与参考文件索引，返回技能正文后严格遵循。执行某类任务前，必须先加载系统提示词「技能→任务映射」中该环节指定的技能（顺序即优先级；标注「必须使用」时不得换用其它技能，标注「优先」时仅在指定技能不存在或不适用时才从技能目录里另选，并在 report 说明原因）。需要某个参考文件全文时再用 skill_reference。', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'skill_reference', description: '加载某技能 references 目录下的单个参考文件全文（例如 skill_reference(name="script-master", ref="framework.md")；子目录文件用相对路径，如 ref="style-bible/style-lock-protocol.md"）。先用 skill() 查看该技能的参考文件索引，再按需加载单个文件。', parameters: { type: 'object', properties: { name: { type: 'string' }, ref: { type: 'string' } }, required: ['name', 'ref'] } } },
  { type: 'function', function: { name: 'get_project', description: '读取当前项目信息与上下文摘要（人物圣经/风格指南/连续性记录），含章节列表。', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'list_chapters', description: '列出项目章节（每章的标题/序号/状态/该章分镜数/是否有剧本）。', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'get_chapter', description: '读取某章的完整内容：小说原文 novel 与剧本 script。拆分镜前先读本章剧本；剧本为空且项目开启自动生成时，先写剧本再拆分镜。', parameters: { type: 'object', properties: { chapter: { type: 'string', description: '章节标题或 id（先用 list_chapters 查看本项目章节）' } }, required: ['chapter'] } } },
  { type: 'function', function: { name: 'set_chapter_script', description: '写入本章剧本（拆分镜的唯一剧情蓝本）。已有非空剧本时默认拒绝覆盖，仅当用户明确要求重写剧本时才传 overwrite:true。', parameters: { type: 'object', properties: { chapter: { type: 'string', description: '章节标题或 id' }, script: { type: 'string', description: '完整剧本文本：场次【第N场｜时间｜地点】+ 出场人物 + 场景/动作描述 + 台词（人物名：台词）+ 必要旁白' }, overwrite: { type: 'boolean', description: 'true=允许覆盖已有剧本（仅当用户明确要求重写剧本时）' } }, required: ['chapter', 'script'] } } },
  { type: 'function', function: { name: 'save_context', description: '写入项目上下文文件：bible（人物圣经）/ style（风格指南）/ continuity（连续性记录，追加）。', parameters: { type: 'object', properties: { key: { type: 'string', enum: ['bible', 'style', 'continuity'] }, content: { type: 'string' } }, required: ['key', 'content'] } } },
  { type: 'function', function: { name: 'report', description: '向任务进度汇报一条状态（阶段/详情）。', parameters: { type: 'object', properties: { phase: { type: 'string' }, detail: { type: 'string' } }, required: ['detail'] } } },
  { type: 'function', function: { name: 'list_assets', description: '列出项目资产，可按分类过滤。返回含 prompt/prompt_used/prompt_locked（prompt_locked=1 表示这是用户手动保存的提示词，权威，不要覆盖）。', parameters: { type: 'object', properties: { category: { type: 'string', enum: ASSET_CATEGORY_IDS } } } } },
  { type: 'function', function: { name: 'create_asset', description: '创建资产（人物/场景/道具/语音/其他）。category=costume（服装）/age（年龄）是「挂在角色下的变体」，必须用 parent_id 指向本项目的角色资产；否则该变体在生成阶段会被静默忽略（refs.js 只按 parent_id 把它映射到角色）。更推荐直接用 change_outfit/design_outfits（服装）或 change_age/design_ages（年龄）生成变体。', parameters: { type: 'object', properties: { category: { type: 'string', enum: ASSET_CATEGORY_IDS }, name: { type: 'string' }, description: { type: 'string' }, voice_desc: { type: 'string', description: '人物声音特征描述（仅人物）：性别+年龄段+音色质感，如「青年男性，嗓音低沉」。后续 design_voice 会优先用它作为音色描述。' }, parent_id: { type: 'string', description: '仅服装（costume）/年龄（age）变体需要：所挂角色（character）资产的 id。缺了会被拒绝。' } }, required: ['category', 'name'] } } },
  { type: 'function', function: { name: 'update_asset', description: '更新资产字段（描述/提示词/参考语音/一致性锚点）。注意：用户若在素材库手动保存过该资产的提示词（prompt_locked=1），本工具不会覆盖它，只会更新其他字段——不要试图用本工具改写用户手写的提示词。', parameters: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, voice_desc: { type: 'string', description: '人物声音特征描述：性别+年龄段+音色质感，如「青年男性，嗓音低沉」。' }, prompt: { type: 'string' }, negative_prompt: { type: 'string' }, voice_ref: { type: 'string' }, consistency_key: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'generate_asset_image', description: '文生图生成资产图片（Qwen-Image-2512）。prompt 为空时用资产描述兜底。', parameters: { type: 'object', properties: { asset_id: { type: 'string' }, prompt: { type: 'string' }, negative_prompt: { type: 'string' }, ratio: { type: 'string' }, resolution: { type: 'string', enum: IMAGE_RESOLUTIONS, description: '图片分辨率档位；缺省用项目设置' } }, required: ['asset_id'] } } },
  { type: 'function', function: { name: 'edit_asset_image', description: '图生图/图像编辑（Qwen-Image-Edit-2511）：以参考图 + 指令生成新图，用于一致性变体。reference_asset_id 传资产 id、reference_image_path 传参考图相对路径（二者选一，缺省用资产自身图）。', parameters: { type: 'object', properties: { asset_id: { type: 'string' }, prompt: { type: 'string' }, reference_asset_id: { type: 'string' }, reference_image_path: { type: 'string' }, ratio: { type: 'string', description: '输出宽高比；缺省跟随参考图' }, resolution: { type: 'string', enum: IMAGE_RESOLUTIONS, description: '图片分辨率档位；缺省用项目设置' } }, required: ['asset_id', 'prompt'] } } },
  { type: 'function', function: { name: 'change_outfit', description: '人物换装：以角色 canonical 参考图为参考，用图生图（Qwen-Image-Edit）生成该角色的一套新服装资产（category=costume，parent_id 指向角色），供分镜按章引用。label 为服装短名（如「进城旧衣」），用于资产命名与分镜引用；outfit 为服装外观描述。仅当剧情「确实发生换装事件」（沐浴/洗澡/更衣/换衣/换装/换上新衣）时才调用；不同场景、不同镜头、不同机位都不算换装，没有换装事件的角色一律直接用 canonical 图，禁止生成服装变体。剧情出现换装事件后，为对应角色生成一套新服装，并在换装事件之后的镜头用 set_storyboard 的 costumes 字段引用。同一个角色在一个分镜里只引用一件服装。', parameters: { type: 'object', properties: { character_id: { type: 'string' }, outfit: { type: 'string' }, label: { type: 'string' }, prompt: { type: 'string' } }, required: ['character_id', 'outfit'] } } },
  { type: 'function', function: { name: 'design_outfits', description: '仅当剧情确有换装事件（沐浴/更衣/换上新衣、时间跳跃后换装）时才调用。给角色一次性设计并生成多套服装资产（衣橱）：以角色 canonical 参考图为参考，用图生图为每套服装生成一张服装图（category=costume，parent_id 指向角色），供分镜按服装名引用对应那套。不同场景、不同镜头、不同机位都不算换装；没有换装事件的角色不要调用（直接用 canonical 图，避免素材冗余）。同一角色的整套素材通常只需要 1 套服装，不要按场景给同一角色生成多套。outfits 传该角色真正需要的服装清单，每套含 name（服装短名，如「进城旧衣」「沐浴后家居服」）与 description（服装外观描述）。', parameters: { type: 'object', properties: { character_id: { type: 'string' }, outfits: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } }, required: ['name', 'description'] } } }, required: ['character_id', 'outfits'] } } },
  { type: 'function', function: { name: 'change_age', description: '人物年龄变体：以角色 canonical 参考图为参考，用图生图（Qwen-Image-Edit）生成该角色某一时期/年龄的样貌（category=age，parent_id 指向角色），保持脸/五官/发型/画风一致、只改年龄，供回忆/时间跳跃镜头按章引用。label 为年龄短名（如「年轻」「中年」「老年」），用于资产命名与分镜引用；age 为年龄/时期外观描述。仅当剧情「明确发生时间跳跃或年龄变化」（回忆/闪回、小时候、多年前、多年后、步入中老年等）时才调用；「年轻」「少年」这类普通外貌描写不算。同一个角色只需生成剧情真正需要的那一个时期变体，不要为同一角色生成多个年龄段。', parameters: { type: 'object', properties: { character_id: { type: 'string' }, age: { type: 'string' }, label: { type: 'string' }, prompt: { type: 'string' } }, required: ['character_id', 'age'] } } },
  { type: 'function', function: { name: 'design_ages', description: '仅当剧情明确展示角色不同年龄段/时期（回忆/闪回/时间跳跃/年龄变化）时才调用。给角色生成对应时期的年龄变体：以角色 canonical 参考图为参考，用图生图为每个时期生成一张年龄变体图（category=age，parent_id 指向角色），供分镜按变体名引用。剧情没有年龄变化、或只有「年轻/少年」这类普通外貌描写的角色不要调用（直接用 canonical 图，避免素材冗余）；同一个角色只需一个真正需要的时期变体时，不要生成多个。ages 传该角色的时期清单，每项含 name（年龄短名，如「年轻」「中年」「老年」）与 description（年龄/时期外观描述）。', parameters: { type: 'object', properties: { character_id: { type: 'string' }, ages: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } }, required: ['name', 'description'] } } }, required: ['character_id', 'ages'] } } },
  { type: 'function', function: { name: 'view_asset', description: '查看某资产的参考图（视觉模型）：返回资产元数据与图片块；模型不支持图片输入时仅返回文本。', parameters: { type: 'object', properties: { asset_id: { type: 'string' } }, required: ['asset_id'] } } },
  { type: 'function', function: { name: 'view_shot_references', description: '查看某分镜的参考素材图（角色/场景/道具/服装，视觉模型）：返回清单与 ≤7 张参考图；模型不支持图片输入时仅返回文本。', parameters: { type: 'object', properties: { shot_id: { type: 'string' } }, required: ['shot_id'] } } },
  { type: 'function', function: { name: 'view_project_references', description: '查看用户上传的参考图片素材（视觉模型）：返回参考图清单与图片块，据此分析其内容/画风/元素并生成风格与设定一致的新素材；模型不支持图片输入时仅返回文本清单。', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'register_voice', description: '登记资产（人物）的参考音色文件名（相对项目 assets/voice/）。', parameters: { type: 'object', properties: { asset_id: { type: 'string' }, voice_ref: { type: 'string' } }, required: ['asset_id', 'voice_ref'] } } },
  { type: 'function', function: { name: 'design_voice', description: '用 Qwen3 TTS 音色设计工作流为人物设计音色：text 是人物朗读的简短自我介绍文案（20~30 字，约 5 秒，禁止长篇大论），voice_description 是音色描述（不限制字数，可详细写；必须包含性别与年龄段，如「青年男性，嗓音低沉」，缺失会导致音色性别/年龄错乱）。生成语音样本并存为该项目 voice_ref。', parameters: { type: 'object', properties: { asset_id: { type: 'string' }, text: { type: 'string', description: '人物朗读的简短自我介绍，20~30 字，约 5 秒' }, voice_description: { type: 'string', description: '音色描述，不限制字数，必须包含性别与年龄段' } }, required: ['asset_id'] } } },
  { type: 'function', function: { name: 'generate_assets_batch', description: '按工作流类型分批统一生成项目素材：先文生图全部图片类资产（人物/场景/道具），再设计全部人物音色（Qwen3-TTS）。批次会一次性排入渲染槽位并发提交，实际并发上限由渲染槽位决定（RunningHub 按 runninghubConcurrency，本地 ComfyUI 恒为 1）。已生成成功的资产自动跳过（幂等）。only 可传 ["image"] 或 ["tts"] 只跑其中一类（用于把两类分到不同的 ComfyUI 实例）。', parameters: { type: 'object', properties: { only: { type: 'array', items: { type: 'string', enum: ['image', 'tts'] } } } } } },
  { type: 'function', function: { name: 'generate_asset_from_reference', description: '以某张用户上传的参考图为输入，用图生图（Qwen-Image-Edit）生成一个新素材资产（category/name 指定）。用于「参考生成新素材」：先分析参考图内容/风格，再据此派生新素材。category=costume/age 属「挂在角色下的变体」，必须用 parent_id 指向本项目的角色资产。', parameters: { type: 'object', properties: { reference_id: { type: 'string' }, category: { type: 'string', enum: ASSET_CATEGORY_IDS }, name: { type: 'string' }, prompt: { type: 'string' }, description: { type: 'string' }, parent_id: { type: 'string', description: '仅服装（costume）/年龄（age）变体需要：所挂角色（character）资产的 id。' } }, required: ['reference_id', 'category', 'name'] } } },
  { type: 'function', function: { name: 'set_storyboard_plan', description: '写入本章分镜锁档（G0 六项锁 + 情绪节拍曲线 + 拆段表）。必须在 set_storyboard 之前调用——没有锁档时 set_storyboard 会被直接拒绝。依据全流程技能（h3→forest-laoli-h3 pipeline.md；seedance→short-drama-director 老李五道锁）：动笔前先定完六项锁，再画情绪节拍（强度 1-10 + 持续镜数），再排拆段表；节拍曲线是后面运镜速度、留白镜头、段缝方案的唯一依据，跳过就只能凭感觉、运镜必然平。mode 模式锁（有角色/场景/道具参考图选 Ref2VA，短剧默认；纯文字 T2VA；首帧 I2VA；尾帧 L2VA；首尾帧 FL2VA）；aspect 画幅（9:16 或 16:9，全片唯一，禁 auto/adaptive，段间换画幅段缝必崩）；base 画风基底（真人 BASE_LIVE / 3D半写实 BASE_ANIME / 手绘 BASE_2D / 水墨 BASE_INK，决定特写能不能正面平视）；assetMode 资产形态（M1 只有文字档 / M2 已出图回传）；seam 段缝方案（tail_frame 尾帧锚定 / hard_cut 换机位硬切 / empty_shot 空镜过渡，接缝两侧强制换机位或换景别）；anchors 空间锚点卡（furniture 家具清单、positions 站位表必填、directions 统一方位词、doors 门窗初始开闭态）；beats 情绪节拍与拆段表，每段给 emotion/type/intensity(1-10)/durationSec(整数秒，按视频模型：h3 与 seedance20 为 4-15；seedance25 为 4-30 且默认 25-30 吃满上限)/shotRange(如 "1-3")/beatFunction(钩子/递进/反转/收束)，shotRange 必须从镜 1 连续覆盖、一段里不许塞两个反转。', parameters: { type: 'object', properties: { chapter: { type: 'string', description: '章节标题或 id' }, mode: { type: 'string', enum: ['T2VA', 'I2VA', 'L2VA', 'FL2VA', 'Ref2VA'] }, aspect: { type: 'string', enum: ['9:16', '16:9'] }, base: { type: 'string', enum: ['BASE_LIVE', 'BASE_ANIME', 'BASE_2D', 'BASE_INK'] }, assetMode: { type: 'string', enum: ['M1', 'M2'] }, seam: { type: 'string', enum: ['tail_frame', 'hard_cut', 'empty_shot'] }, anchors: { type: 'object', properties: { furniture: { type: 'array', items: { type: 'string' } }, positions: { type: 'array', items: { type: 'string' }, description: '每个在场人物在本段的位置与朝向，如「姜知微：推车左侧，面向右」' }, directions: { type: 'array', items: { type: 'string' }, description: '统一方位词，如「海在画左，登船大厅在画右」' }, doors: { type: 'string', description: '门窗初始开闭态，如「玻璃门全程关闭」' } }, required: ['positions'] }, beats: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, emotion: { type: 'string' }, type: { type: 'string', description: '紧张上升/爆发/留白/凝固' }, intensity: { type: 'number', description: '1-10' }, durationSec: { type: 'number', description: '整数秒。h3 与 seedance20 为 4-15；seedance25 为 4-30，且主体段应为 25-30（吃满上限、减少段数与段缝）' }, shotRange: { type: 'string', description: '该段覆盖的分镜号区间，如 "1-3"' }, beatFunction: { type: 'string', enum: ['钩子', '递进', '反转', '收束'] }, seam: { type: 'string' } }, required: ['emotion', 'type', 'intensity', 'durationSec', 'shotRange', 'beatFunction'] } } }, required: ['chapter', 'mode', 'aspect', 'base', 'assetMode', 'seam', 'anchors', 'beats'] } } },
  { type: 'function', function: { name: 'set_storyboard', description: '写入/追加分镜列表（按章内 idx upsert，非破坏：已生成的分镜保留 status/video，新增章节按更高 idx 追加；每章分镜编号 idx 独立从 1 开始，不要跨章连续编号）。**前置硬门禁：必须先调 set_storyboard_plan 写本章锁档（G0 六项锁 + 情绪节拍 + 拆段表），且必读 reference 已加载，否则拒绝写入。**写入时还会做结构机检：单段时长按视频模型分档（h3 / seedance20 为 4-15 秒；seedance25 为 4-30 秒，主体段应为 25-30 秒）、每镜必须有 characters、连续两镜不许同景别同机位、每镜必须归属某个节拍的 shotRange、镜数与时长密度匹配（P1-1：段内镜头按「每镜 2.5–7.5 秒」核，25-30s 段写 4–13 行都合规）。characters/scenes/props/costumes/ages/audios 传资产名数组（costumes 为换装后的服装资产名，沐浴/更衣/换装事件之后的镜头必须引用对应服装，事件之前的镜头不引用；同一角色每个分镜只引用一件服装。ages 为年龄/时期变体资产名，回忆/时间跳跃镜头引用对应时期；同一角色每个分镜只引用一个年龄变体，且不要与服装同时引用同一角色的两张图；audios 为独立音频素材名——旁白音色/背景音乐/音效，作为 H3 音色参考输入，有旁白的分镜引用旁白音色）；chapter 传章节标题或章节 id（先用 list_chapters 看本项目章节）；narration 传该镜旁白口播稿（没有旁白留空）。Seedance 线的 visual 必须按老李九字段写全（画面：…／状态：进镜→出镜／光影：…／色调：名，高光#，阴影#，色温NK／重音：字／人声：…／音效：…，无内容写 —）——投喂阶段的【画幅风格】【音效】栏要靠它取源，省了就只能让模型自选光色。硬约束：dialogue 字数必须 ≤ duration×3.5（中文口播实测 3.2–3.5 字/秒，超了成片会被压成听不清的模糊声），超长会被拒绝，需缩短台词或拆镜；此外，拆分镜前必须先 skill_reference 加载本模型分镜技能的必读规则文件（未加载会被拒绝写入）；每个分镜最多 2 个说话人，≥3 人对话会被拒绝，需拆成多个分镜（参考音频只提交有台词角色，单分镜 ≤3 段）。', parameters: { type: 'object', properties: { shots: { type: 'array', items: { type: 'object', properties: { idx: { type: 'number' }, chapter: { type: 'string' }, scene_name: { type: 'string' }, duration: { type: 'number' }, characters: { type: 'array', items: { type: 'string' } }, scenes: { type: 'array', items: { type: 'string' } }, props: { type: 'array', items: { type: 'string' } }, costumes: { type: 'array', items: { type: 'string' } }, ages: { type: 'array', items: { type: 'string' } }, audios: { type: 'array', items: { type: 'string' } }, sub_shots: { type: 'string' }, dialogue: { type: 'string' }, narration: { type: 'string' }, camera: { type: 'string' }, visual: { type: 'string' }, blocking: { type: 'string', description: '段首站位声明（老李 model-adapters.md §5.0 的「方位唯一权威」）：一行式写法，每人一段括号写六要素（位置 · 依托物 · 身后背景物 · 朝向 · 姿态 · 手头事务），收尾写「轴线锁定：A 在左、B 在右，机位恒定在…一侧，全段禁越轴；位移仅限：…」。一个生成段（一个分镜）只写一次，镜行（sub_shots）里禁止再复述绝对左右。不写这一栏，投喂阶段只能让模型从画面自己猜左右，必然漂移。' } } } }, clear: { type: 'boolean', description: '只清空本次写入涉及章节的现有分镜（按 idx 重写本章），其他章节的分镜一律保留；省略=追加/更新' }, chapter: { type: 'string', description: '本章所有分镜的默认章节（章节标题或 id）；若每条分镜已自带 chapter 可省略，省略时未单独指定 chapter 的分镜都归入此章' } }, required: ['shots'] } } },
  { type: 'function', function: { name: 'list_shots', description: '列出项目分镜及其状态。', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'update_shot', description: '更新某分镜字段（video_prompt 为按 forest-laoli-h3 技能写好的 H3 视频提示词，生成视频前必须先写入）。', parameters: { type: 'object', properties: { shot_id: { type: 'string' }, sub_shots: { type: 'string' }, dialogue: { type: 'string' }, narration: { type: 'string' }, camera: { type: 'string' }, visual: { type: 'string' }, blocking: { type: 'string', description: '段首站位声明（一行式六要素 + 轴线锁定 + 位移仅限）；一个生成段只写一次' }, duration: { type: 'number' }, video_prompt: { type: 'string' }, mode: { type: 'string', description: '生成模式（缺省 auto=按参考素材自动推断）：reference=全能参考（多图+音视频）；image=图生视频（1 张图）；text=文生视频（不连接任何媒体节点）；digital_human=数字人（预留，暂不对接业务）。首尾帧不在本工具内使用，只能由用户在「插入自定义分镜」里手动选择' } }, required: ['shot_id'] } } },
  { type: 'function', function: { name: 'generate_shot_video', description: '为某分镜生成视频（MiniMax H3 Ref2VA）。', parameters: { type: 'object', properties: { shot_id: { type: 'string' } }, required: ['shot_id'] } } },
  { type: 'function', function: { name: 'regenerate_shot', description: '重新生成某分镜视频，可带反馈文字（如「镜头拉近/让人物微笑」）。render=false 时只用 LLM 按反馈改写 video_prompt，不提交 ComfyUI 渲染。append=true 时把新视频追加为该分镜的新候选（保留旧候选），默认 false 为替换整批候选。', parameters: { type: 'object', properties: { shot_id: { type: 'string' }, feedback: { type: 'string' }, render: { type: 'boolean', description: 'false=只做 LLM 改写提示词，不渲染视频；默认 true' }, append: { type: 'boolean', description: 'true=追加为新候选（保留旧候选），false=替换整批候选（默认）' } }, required: ['shot_id'] } } },
  { type: 'function', function: { name: 'write_shot_video_prompt', description: '为【单个】分镜撰写视频提示词：本工具会自动读取该分镜的参考素材真实顺序并生成正确的编号映射，再按当前视频模型对应的全流程技能写提示词（h3→forest-laoli-h3 的六段式；seedance→short-drama-director 的七段式），规范全文由工具注入（subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music），写回 shot.video_prompt，不渲染。批量写整章时优先用 write_video_prompts_batch（连续性好）；本工具仅用于单镜重生成/微调。禁止用 update_shot 手写 video_prompt（手写会拿不到参考素材真实编号、必然错位）。', parameters: { type: 'object', properties: { shot_id: { type: 'string' } }, required: ['shot_id'] } } },
  { type: 'function', function: { name: 'write_video_prompts_batch', description: '【批量写整章视频提示词 · 连续性最优】在 llm 阶段为整章分镜批量写 video_prompt：自动按「同场景 + idx 连续」分组，每批最多 3 镜用一次 LLM 连续产出（上下文连贯、不会逐镜换手/瞬移），批间用滚动状态卡传递站位/朝向/手部道具/机位侧/动作落幅，转场自动重置。自动跳过已有提示词的镜（幂等）；单镜机检 FAIL 会降级走逐镜重试。传 chapter 只处理该章，留空处理全部。禁止改用逐镜 write_shot_video_prompt 逐条写整章（会因每镜独立无参照导致站位漂移）。', parameters: { type: 'object', properties: { chapter: { type: 'string' } }, required: [] } } },
  { type: 'function', function: { name: 'generate_chapter_videos', description: '为指定章节一次性生成/补齐全部镜头视频（确定性批量循环，不省略任何镜头）；无依赖关系的镜头会并发提交，引用资产尚未生成完成的镜头会暂缓（deferred）且不提交渲染；force=true 时强制重生成本章全部视频（含已 done）。失败的镜头标记为 failed 并继续，直到该章所有可跑镜头有结果。不受步数/时长限制。', parameters: { type: 'object', properties: { chapter: { type: 'string' }, force: { type: 'boolean' } }, required: ['chapter'] } } },
  { type: 'function', function: { name: 'assemble_video', description: '用 ffmpeg 合并本章分镜视频为成片，并垫入该章背景音乐（若有）。chapter 缺省时合并全部分镜（不混背景音乐）。', parameters: { type: 'object', properties: { chapter: { type: 'string' } } } } },
  { type: 'function', function: { name: 'set_chapter_music', description: '为指定章节撰写背景音乐：caption 为结构化音乐风格描述（先加载 skill(ai-music-studio) 与 skill(music-caption-rewriter)，按其规范产出贴合本章剧情的 Global Metadata / Vocal Details / Arrangement），lyrics 为歌词（用适合本章剧情的语言：华语普通话/粤语/英语等），duration 为合适时长秒数。写入章节记录，后续 generate_music 据此生成。', parameters: { type: 'object', properties: { chapter: { type: 'string' }, caption: { type: 'string' }, lyrics: { type: 'string' }, duration: { type: 'number' } }, required: ['chapter', 'caption', 'lyrics'] } } },
  { type: 'function', function: { name: 'generate_music', description: '为指定章节生成带歌词的背景音乐（MiniMax Music3）。读取该章已写好的 caption/lyrics/duration（未写则用项目风格兜底、无歌词）。', parameters: { type: 'object', properties: { chapter: { type: 'string' } }, required: ['chapter'] } } },
  { type: 'function', function: { name: 'generate_music_asset', description: '为一条已创建的背景音乐资产（asset_id）生成音频。资产的 prompt（caption）/lyrics/max_duration 已写好；生成完成后写入音频并置 done，失败置 failed。', parameters: { type: 'object', properties: { asset_id: { type: 'string' } }, required: ['asset_id'] } } },
  { type: 'function', function: { name: 'apply_chapter_music', description: '把音乐库中选定的背景音乐（music_id）应用到多个章节（chapters 数组，仅已全部生成完成的章节会应用），并重新合成各章成片。', parameters: { type: 'object', properties: { music_id: { type: 'string' }, chapters: { type: 'array', items: { type: 'string' } } }, required: ['music_id', 'chapters'] } } },
  { type: 'function', function: { name: 'list_workflows', description: '列出已注册的 ComfyUI 工作流。', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'web_search', description: '联网搜索。type=web 查资料/确认事实；type=image 搜参考图片（返回图片 URL 数组）。遇到你不知道或不确凿的事实——品牌名、产品型号、年代物品的真实外观、专业术语、历史/地理/科技细节、真实存在的服饰/道具样式等——必须先查证再写，禁止凭空臆造年代/品牌/型号错误。需要某物品/服饰的参考图时用 type=image 搜图，再配 download_reference_image 下载为参考图。若设置里关闭了联网搜索，本工具会返回 disabled（此时改用既有知识继续，不要重试）。', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词' }, type: { type: 'string', enum: ['web', 'image'], description: 'web=文字资料搜索（默认），image=图片搜索' }, engine: { type: 'string', description: 'type=web 时指定引擎 id 逗号分隔（如 bing-cn,baidu）；省略用国内引擎组合' }, limit: { type: 'number', description: '返回条数上限，默认 8' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'download_reference_image', description: '把一张图片 URL 下载到本项目参考图（references/），登记为参考素材（origin=downloaded），供「资产图」阶段用图生图（generate_asset_from_reference）派生新素材。常用于把 web_search(type=image) 搜到的参考图（老电话/手机型号/服装等）落地。仅 http/https，下载会被 SSRF/大小/类型校验拦截。', parameters: { type: 'object', properties: { url: { type: 'string', description: '图片 URL（http/https）' }, name: { type: 'string', description: '参考图名称，如「诺基亚3310老手机」；缺省取 URL 文件名' }, category: { type: 'string', enum: ASSET_CATEGORY_IDS, description: '素材分类，默认 prop' }, description: { type: 'string', description: '参考图用途/内容描述' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'opuscar_init', description: '初始化 lemo-opuscar 代码电影库：确认库根存在、创建影片工作区目录，返回 { lib_root, film_dir } 两个绝对路径（后续 opuscar_shell 的 cwd 与命令里的路径都要以这两个目录为界）。', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'opuscar_shell', description: '在 lemo-opuscar 库根或影片工作区执行一条受控 shell 命令（渲染/合成/TTS 等）。cwd 只能 lib（库根，默认）或 film（影片工作区）。命令里的绝对路径必须落在 lib_root / film_dir 之内；危险命令（rm -rf / sudo / curl|sh 等）会被拦截。返回 { code, stdout, stderr }。可用 $LEMO_FILM 与 $LEMO_LIB 引用两个目录。', parameters: { type: 'object', properties: { command: { type: 'string', description: '要执行的命令，如 node core/render/video.mjs "$LEMO_FILM" --out "$LEMO_FILM/out/video.mp4"' }, cwd: { type: 'string', enum: ['lib', 'film'], description: '工作目录：lib=库根（默认），film=影片工作区' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'opuscar_write_file', description: '向影片工作区写一个文本文件（TREATMENT.md / index.html / build.sh / content.json / lines.json 等）。path 为相对 film_dir 的路径。', parameters: { type: 'object', properties: { path: { type: 'string', description: '相对影片工作区(film_dir)的文件路径' }, content: { type: 'string', description: '文件完整内容' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'opuscar_read_file', description: '读取 lemo-opuscar 库内或影片工作区内的文本文件（如 AGENTS.md、styles/<slug>/STYLE.md、DIRECTOR.md、TECHNIQUE.md、core/README.md、TREATMENT.md、index.html）。path 为相对路径：优先在库根下解析，其次在影片工作区下解析。', parameters: { type: 'object', properties: { path: { type: 'string', description: '相对库根或影片工作区的文件路径' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'opuscar_save_film', description: '把影片工作区产出的成片（默认查找 film_dir/out/final.mp4、film_dir/out/video.mp4 等）复制为项目视频资产并置 done，供前端预览/下载。', parameters: { type: 'object', properties: { name: { type: 'string', description: '可选，成片显示名（缺省用资产名）' } }, required: [] } } },
  // —— 无限・卷轴：小说大纲规划工具 ——
  { type: 'function', function: { name: 'novel_init', description: '初始化小说工作台（无限・卷轴）：确认项目存在、确保 novel/ 目录与 memory/ 子目录已创建，返回当前小说目录下的结构概览（已存在的总纲/卷纲/章纲、角色数量、记忆文件列表）。调用 novel_* 工具前应先调用一次。', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'novel_write_file', description: '向小说工作台写一个文本文件。path 为相对 novel/ 的路径（如 总纲.md、memory/设定.md）；路径禁止绝对路径与 "../"。', parameters: { type: 'object', properties: { path: { type: 'string', description: '相对 novel/ 目录的路径，如 总纲.md、memory/设定.md' }, content: { type: 'string', description: '文件完整内容' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'novel_read_file', description: '读取小说工作台下的文本文件。path 为相对 novel/ 的路径（如 总纲.md、卷纲.md、章纲.md、memory/设定.md）。不存在返回空字符串。', parameters: { type: 'object', properties: { path: { type: 'string', description: '相对 novel/ 目录的路径' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'novel_list_files', description: '递归列出 novel/ 目录下所有已存在文件（用于检查哪些层已经生成、哪些层还是空的）。返回形如 ["总纲.md","卷纲.md","memory/设定.md"]。', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'novel_save_characters', description: '把角色列表写入 characters.json。characters 必须是数组，每项形如 { id, name, role, description, notes }。id 可省（空字符串即可）；name / role / description 建议填。', parameters: { type: 'object', properties: { characters: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' }, description: { type: 'string' }, notes: { type: 'string' } } } } }, required: ['characters'] } } },
  { type: 'function', function: { name: 'novel_get_characters', description: '读取当前小说的角色列表（从 characters.json）。返回数组；不存在或解析失败返回空数组。', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'novel_list_chapters', description: '列出当前小说已建立的章节（含标题、卷号、序号、本章章纲、正文字数、是否已有正文）。用于判断哪些章节还没写正文、从哪里开始续写。返回 [{ title, seq, volume, outline, wordCount, hasContent }] 数组。', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'novel_save_chapter', description: '保存/更新某一章（标题、所属卷号、本章章纲、正文）。title 为章节标题；volume 为该章所属卷号（从 1 开始）；outline 为本章章纲（这一章要写什么）；content 为本章正文。只更新章纲/卷号时请省略 content（省略＝不改正文，避免把已写正文清空）；传非空 content 才覆盖正文。标题已存在则更新，不存在则新建。', parameters: { type: 'object', properties: { title: { type: 'string', description: '章节标题，如「第1章 意外穿越」' }, volume: { type: 'integer', description: '所属卷号，从 1 开始' }, outline: { type: 'string', description: '本章章纲（这一章要写什么）' }, content: { type: 'string', description: '本章完整正文；只更新章纲/卷号时省略该参数' } }, required: ['title'] } } },
  { type: 'function', function: { name: 'novel_save_volumes', description: '保存结构化的分卷列表（覆盖写入 volumes.json）。每卷含：seq(卷号,从1开始)、title(卷名)、outline(本卷卷纲:这一卷要写什么/核心目标/卷末变化)、chapterFrom(起始章序号)、chapterTo(结束章序号)。用于把「第几章到第几章为一卷」以及每卷的卷纲绑定到卷上。', parameters: { type: 'object', properties: { volumes: { type: 'array', items: { type: 'object', properties: { seq: { type: 'integer', description: '卷号，从 1 开始' }, title: { type: 'string', description: '卷名，如「第一卷 山门」' }, outline: { type: 'string', description: '本卷卷纲：这一卷要写什么、核心目标、主要冲突、卷末变化' }, chapterFrom: { type: 'integer', description: '本卷起始章序号' }, chapterTo: { type: 'integer', description: '本卷结束章序号' } }, required: ['seq'] } } }, required: ['volumes'] } } },
  { type: 'function', function: { name: 'novel_get_volumes', description: '读取当前小说的结构化分卷列表（从 volumes.json）。返回 [{ seq, title, outline, chapterFrom, chapterTo }]；不存在返回空数组。', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'novel_get_memory', description: '读取当前小说的全部上下文记忆（memory/ 目录下所有文件），返回 [{ name, content }]。写每一章前用它读最新记忆，保证人物状态/伏笔/剧情进展不前后矛盾。', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'novel_save_memory', description: '写入/覆盖一个记忆文件。name 为记忆名（如 设定、伏笔、剧情进展；可带 .md 后缀或 memory/ 前缀，会自动规范到 memory/ 目录）；content 为该记忆的完整最新内容。写每章后用它更新剧情进展/伏笔/人物状态。', parameters: { type: 'object', properties: { name: { type: 'string', description: '记忆名，如 设定、伏笔、剧情进展' }, content: { type: 'string', description: '该记忆的完整最新内容' } }, required: ['name', 'content'] } } },
  // —— 阶段 3 · P2：场次基线（**只进剧本抽取阶段工具池**，见 D02-06 §4.8.4）——
  // 注意：schema 里**故意没有** `stage` 字段。权限只认服务端传入的 ctx.toolSet，
  // 模型自报阶段必须被 ALLOWED_ARG_KEYS 以 unknown-args 拦掉（PS-05）。
  { type: 'function', function: { name: 'set_scene_state', description: '剧本抽取阶段专用：建立/更新场次实例的空间基线（scene_states）。一章一次提交，scenes[] 每个元素 = 一个场次实例，scene_key 项目内唯一（重写则 state_rev +1）。规则：只写"能确定"的几何——coord_system 缺 basis/active_area 就留空（不得编造尺寸）、axis_lock 缺 axis_line 允许保存但视为不完整、fixtures[].zone 必须是 4 个 0..1 数字且 x1<x2/y1<y2。不得从画面左右反推物理左右。不写镜、不写资产。', parameters: { type: 'object', properties: { chapter: { type: 'string', description: '章节标题或 id（本批场次所属章）' }, scenes: { type: 'array', description: '场次实例数组，至少一个', items: { type: 'object', properties: { scene_key: { type: 'string', description: '场次键，如 S02_病房；项目内唯一' }, scene_id: { type: 'string', description: '场景资产 id；纯虚拟场次留空。非空时必须属于本项目且 category=scene' }, coord_system: { type: 'object', description: '坐标系（basis / active_area 等）。不知道就别填，禁止编造 active_area 尺寸' }, fixtures: { type: 'array', description: '固定物列表；每项 zone 为 [x1,y1,x2,y2]（0..1，x1<x2、y1<y2）', items: { type: 'object' } }, entries: { type: 'object', description: '出入口等' }, axis_lock: { type: 'object', description: '轴线锁；缺 axis_line 允许保存但 QC 会记 AXIS_LOCK_INCOMPLETE' }, power_geometry: { type: 'object', description: '权力几何；可空' }, crowd_switch: { type: 'string', description: '群像切换说明；可空' }, time_of_day: { type: 'string', description: '时间（如 日/夜/黄昏）' } }, required: ['scene_key'] } } }, required: ['chapter', 'scenes'] } } },
];

// 封闭参数白名单：从 TOOL_DEFINITIONS 的 parameters.properties 派生每个工具的顶层参数键。
// 对齐「未知字段=硬错误」原则：模型幻觉出多余字段时直接拒绝，避免「看似成功实则写错字段」。
// 工具 schema 是唯一权威来源，不另维护一份清单，防止漂移。
const ALLOWED_ARG_KEYS = new Map(
  TOOL_DEFINITIONS.map((t) => [t.function.name, new Set(Object.keys(t.function.parameters?.properties || {}))])
);

// ================= 运行时上下文 =================
// 需要拉起外部进程（ComfyUI / ffmpeg）的渲染类工具。
// 本机 LLM 与 ComfyUI 无法同时常驻（27B GGUF 15.66GB 与 H3 出图峰值叠加会爆显存），
// 故「只跑 LLM 文本」的阶段靠这张表在 runTool 层硬拦，见 runTool 的 renderDisabled 分支。
export const RENDER_TOOLS = new Set([
  'generate_asset_image', 'edit_asset_image', 'change_outfit', 'design_outfits',
  'change_age', 'design_ages',
  'generate_assets_batch', 'design_voice', 'generate_shot_video',
  'generate_asset_from_reference',
  'regenerate_shot', 'generate_chapter_videos', 'assemble_video',
  'generate_music', 'generate_music_asset', 'apply_chapter_music',
  'generate_video_asset', 'clone_voice', 'generate_digital_human',
]);

// 走 generate_assets_batch 文生图的资产类别。服装走 change_outfit/design_outfits（图生图），
// 不在此列 —— stages.pendingByStage 复用本常量，保证「待办数」与「实际会做什么」永远一致。
export const IMAGE_ASSET_CATEGORIES = ['character', 'scene', 'prop', 'other'];

export function createToolRuntime({ projectId, jobId, onProgress, isAborted, chapter, renderDisabled, llmDisabled, assetId, toolSet }) {
  const cfg = loadConfig();
  const project = Projects.get(projectId);
  if (!project) throw new Error('项目不存在：' + projectId);
  ensureProjectDirs(projectId);
  return {
    cfg, project, projectId, jobId,
    chapter: chapter || '',
    assetId: assetId || '',
    renderDisabled: !!renderDisabled,
    // 阶段权限标记（D02-06 §4.8.4 L2）：**只能**由服务端构造工具池时传入（buildMcpTools），
    // 绝不可从 args 读、也不可从 ctx.project 里任何用户可写字段推导。
    // 分镜创作（storyboard）与未标注的空串一律不含写 scene_states 的资格。
    toolSet: toolSet || '',
    // 与 renderDisabled 对称：渲染阶段 / 纯渲染任务置 true → 禁止调用 LLM。
    // LLM 与 ComfyUI 单卡不能同时常驻（见 stages.js 设计说明），故换装/年龄的视觉精修、
    // 视频提示词 LLM 改写等可选 LLM 步骤在此下跳过或直接拒绝。
    llmDisabled: !!llmDisabled,
    // 本次会话已加载过的技能正文与 reference（skill / skill_reference 工具写入）。
    // 用途：分镜写入前硬门禁——按 video_model 要求的必读 reference 没加载就不许 set_storyboard，
    // 避免「分镜阶段只加载 1 个 reference 就自由发挥」（旧版软提示实测模型只执行 1/4）。
    // ctx 在 MCP 进程内是单例（getCtx() 缓存），整个 job 生命周期共享，可跨工具调用累积。
    loadedSkills: new Set(),
    loadedRefs: new Set(),
    onProgress: onProgress || (() => {}),
    isAborted: isAborted || (() => false),
    report(patch) {
      if (this.onProgress) this.onProgress(patch);
      logger.info('agent: ' + (patch.phase || '') + ' ' + (patch.detail || ''), patch);
    },
  };
}

// ================= 内部辅助 =================
function saveToProject(ctx, relPath, buf) {
  const abs = resolveProjectPath(ctx.projectId, relPath);
  if (!abs) throw new Error('非法保存路径：' + relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  return relPath;
}

async function downloadOutputTo(ctx, out, relPath) {
  const abs = resolveProjectPath(ctx.projectId, relPath);
  if (!abs) throw new Error('非法输出路径：' + relPath);
  return downloadToFile(ctx.cfg, out, abs);
}

// ZImage 在「四格设定板」上会自作主张画粗黑分格条和外黑框，即使提示词写了不要。
// 这里识别「贯穿上下、宽度很窄」的近黑竖条，用画面中性灰背景色填掉；顶部/底部通栏黑边也填掉。
// 只处理黑条，不重排画面，避免误伤黑西装、黑头发或人物本身。
async function cleanCharacterSheetBorders(ctx, relPath) {
  try {
    const abs = resolveProjectPath(ctx.projectId, relPath);
    if (!abs) return;
    const { data, info } = await sharp(abs).raw().toBuffer({ resolveWithObject: true });
    const w = info.width;
    const h = info.height;
    const c = info.channels;
    if (!w || !h || c < 3) return;

    const isBlack = new Uint8Array(w);
    const topEnd = Math.floor(h * 0.12);
    const bottomStart = Math.floor(h * 0.88);
    for (let x = 0; x < w; x++) {
      let count = 0, top = 0, bottom = 0, topTotal = 0, bottomTotal = 0;
      for (let y = 0; y < h; y += 2) {
        const i = (y * w + x) * c;
        const black = data[i] < 32 && data[i + 1] < 32 && data[i + 2] < 32;
        if (black) count++;
        if (y < topEnd) { topTotal++; if (black) top++; }
        if (y > bottomStart) { bottomTotal++; if (black) bottom++; }
      }
      // 分格黑条必须贯穿上下：上缘、下缘也几乎全黑。
      // 这样不会把黑西装（中段黑、上端是脸/下端是鞋）或黑头发（只在顶部）误判成竖条。
      if (count / Math.ceil(h / 2) > 0.7 && top / topTotal > 0.8 && bottom / bottomTotal > 0.8) isBlack[x] = 1;
    }

    const runs = [];
    let start = -1;
    for (let x = 0; x <= w; x++) {
      if (x < w && isBlack[x]) { if (start < 0) start = x; }
      else if (start >= 0) { runs.push([start, x - 1]); start = -1; }
    }

    // 背景灰：取低饱和、中等亮度的像素做中位数，避开白衬衫、黑西装和皮肤。
    const histR = new Uint32Array(256);
    const histG = new Uint32Array(256);
    const histB = new Uint32Array(256);
    let total = 0;
    for (let i = 0; i < data.length; i += c * 5) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx - mn < 12 && mx > 60 && mx < 210) {
        histR[r]++; histG[g]++; histB[b]++; total++;
      }
    }
    if (!total) return;
    const medianBin = (hist) => {
      let acc = 0;
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total / 2) return v; }
      return 128;
    };
    const fill = [medianBin(histR), medianBin(histG), medianBin(histB)];

    const maxWidth = Math.max(24, w * 0.06);
    let changed = false;
    for (const [a, b] of runs) {
      if (b - a + 1 > maxWidth) continue;
      for (let x = a; x <= b; x++) {
        for (let y = 0; y < h; y++) {
          const i = (y * w + x) * c;
          data[i] = fill[0]; data[i + 1] = fill[1]; data[i + 2] = fill[2];
        }
      }
      changed = true;
    }

    // 横向黑边：模型有时会在画面顶部/底部压一条通栏黑边，同样填成背景灰。
    // 只在上下 10% 内处理，避免把横穿画面的黑色西装/道具误判成边框。
    for (let y = 0; y < h; y++) {
      if (y > h * 0.1 && y < h * 0.9) continue;
      let count = 0;
      for (let x = Math.floor(w * 0.1); x < Math.floor(w * 0.9); x += 2) {
        const i = (y * w + x) * c;
        if (data[i] < 32 && data[i + 1] < 32 && data[i + 2] < 32) count++;
      }
      if (count / Math.floor(w * 0.8 / 2) > 0.65) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * c;
          data[i] = fill[0]; data[i + 1] = fill[1]; data[i + 2] = fill[2];
        }
        changed = true;
      }
    }
    if (!changed) return;

    const ext = path.extname(abs).toLowerCase();
    const encoded = ext === '.jpg' || ext === '.jpeg'
      ? await sharp(Buffer.from(data), { raw: { width: w, height: h, channels: c } }).jpeg({ quality: 95 }).toBuffer()
      : await sharp(Buffer.from(data), { raw: { width: w, height: h, channels: c } }).png().toBuffer();
    fs.writeFileSync(abs, encoded);
    logger.info('人物设定板黑边已清理', { path: relPath, runs: runs.length });
  } catch (e) {
    logger.warn('人物设定板黑边清理失败，保留原图', { path: relPath, error: e.message });
  }
}

// 图生图输出尺寸归一化：工作流对输出尺寸的控制不一致（部分保留参考图、部分内部缩放），
// 所以按项目/页面选择的档位在落盘后统一缩放一次。
// 1K + 未显式指定比例时直接跳过，保持原有产物与性能；ffmpeg 失败只告警，不阻断生图。
async function normalizeGeneratedImage(ctx, relPath, resolution, ratio = '') {
  if (!resolution || (resolution === '1K' && !ratio)) return;
  try {
    const abs = resolveProjectPath(ctx.projectId, relPath);
    if (!abs) return;
    const { width, height } = await probeImageSize(abs);
    if (!width || !height) return;
    const [w, h] = imageSizeFor(ratio || (width + ':' + height), resolution);
    if (w === width && h === height) return;
    await resizeImageFile(abs, w, h, { fit: ratio ? 'cover' : 'contain', isAborted: ctx.isAborted });
  } catch (e) {
    logger.warn('图片分辨率归一化失败，保留原图', { path: relPath, error: e.message });
  }
}

function assetFallback(asset, project) {
  return fallbackAssetPrompt({ type: asset.category, name: asset.name, description: asset.description, style: project.style });
}

// 新文字策略：素材允许保留与主体相关的真实文字（包装/标签/招牌/书名/品牌 logo 等）。
// 历史资产里由旧模板写下的负向词条（text / letters / logo …）会继续把字擦掉，而负向提示词
// 没有前端编辑入口，所以在提交渲染前统一剔除这些词条；其余负向词条原样保留。
const LEGACY_TEXT_NEG_TOKENS = new Set(['text', 'subtitles', 'subtitle', 'caption', 'captions', 'letter', 'letters', 'word', 'words', 'text overlay', 'signature', 'logo']);
function sanitizeNegativePrompt(neg) {
  if (!neg) return '';
  return String(neg)
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => !LEGACY_TEXT_NEG_TOKENS.has(t.toLowerCase()))
    .join(', ');
}

export function visionEnabled(ctx) { return !!(ctx.cfg?.llm?.vision); }

// 把本地图片绝对路径列表转成 { data, mimeType } 图片块（视觉模型投喂），跳过不可读/超大文件
// 视觉投喂的参考图做限流：默认最多 6 张、单张 ≤2.5MB，避免大量超大图把对话上下文撑爆，
// 进而触发 openclaude 的 active-message 安全上限（自动压缩压不动时直接停跑）。
function imagesFromPaths(absPaths, max = 6) {
  const out = [];
  for (const p of (absPaths || [])) {
    if (out.length >= max) break;
    if (!p) continue;
    const img = imageToDataUrl(p, { maxBytes: 2.5 * 1024 * 1024 });
    if (img) out.push(img);
  }
  return out;
}

// 超时预算按本机实测吞吐给：视频单条 15-30 分钟，且 ComfyUI 队列串行，
// 超时必须覆盖排队等待，否则产物已生成却无人回收。
// 关闭「多用户排队调度」（单人自用）时不设生成超时：渲染再慢也一直等，
// 只能由「停止」或 ComfyUI 任务丢失检测结束，避免正常出片被固定时长误杀。
const QUEUE_SCHEDULING_OFF = (cfg) => cfg?.generation?.queue?.enabled === false;
const IMG_TIMEOUT = (cfg) => (QUEUE_SCHEDULING_OFF(cfg) ? 0 : (Number(cfg?.generation?.imageTimeoutMinutes) || 30) * 60 * 1000);
const VID_TIMEOUT = (cfg) => (QUEUE_SCHEDULING_OFF(cfg) ? 0 : (Number(cfg?.generation?.videoTimeoutMinutes) || 120) * 60 * 1000);

// ================= 工具处理函数 =================
// 章节进度摘要（列表里带 shotCount/doneCount/genStatus）统一走 lib/core 的 chapterStats：
// 界面路由 GET /api/projects/:id/chapters 用的是同一份，避免「生成中」判定这种口径再各写一遍。
// 章节收敛：ctx.chapter 可能是标题或 id；无目标（全部章节）返回 null。
// 用于 get_project / list_chapters / list_shots 按目标章过滤，避免「每章一个会话」里仍返回
// 全项目的章节正文与全部分镜，导致上下文随总章节数无界膨胀（15 集左右写视频提示词开始空/截断的根因）。
function targetChapterTitle(ctx) {
  const want = String(ctx.chapter || '').trim();
  if (!want) return '';
  const c = Chapters.list(ctx.projectId).find((c) => c.title === want || c.id === want);
  return c ? c.title : want;
}

// 章节正文长度上限：与 buildTaskPrompt 的 .slice(0, 6000) 对齐，避免超长小说正文反复整段进上下文。
const NOVEL_CAP = 6000;

async function hGetProject(ctx) {
  const assets = Assets.list(ctx.projectId);
  const shots = Shots.list(ctx.projectId);
  const target = targetChapterTitle(ctx);
  const chapters = Chapters.list(ctx.projectId)
    .filter((c) => !target || c.title === target)
    .map((c) => { const st = chapterStats(ctx.projectId, c.title); return { id: c.id, title: c.title, seq: c.seq, status: c.status, novel: String(c.novel || '').slice(0, NOVEL_CAP), hasScript: !!String(c.script || '').trim(), scriptChars: String(c.script || '').length, shotCount: st.total, doneCount: st.done, genStatus: st.status }; });
  const shotList = target ? shots.filter((s) => s.chapter === target) : shots;
  return JSON.stringify({
    project: { id: ctx.project.id, name: ctx.project.name, style: ctx.project.style, video_resolution: ctx.project.video_resolution, video_aspect_ratio: ctx.project.video_aspect_ratio, enable_bgm: ctx.project.enable_bgm !== false },
    context: ctx.project.context || {},
    chapters,
    assets: assets.map((a) => ({ id: a.id, category: a.category, name: a.name, image_path: a.image_path, voice_ref: a.voice_ref, voice_desc: a.voice_desc, parent_id: a.parent_id || '', source: a.source || '', status: a.status })),
    shots: shotList.map((s) => ({ id: s.id, idx: s.idx, chapter: s.chapter || '', scene_name: s.scene_name, status: s.status, has_prompt: !!(s.video_prompt && String(s.video_prompt).trim()), video_path: s.video_path })),
  });
}
async function hListChapters(ctx) {
  const target = targetChapterTitle(ctx);
  return JSON.stringify(Chapters.list(ctx.projectId)
    .filter((c) => !target || c.title === target)
    .map((c) => { const st = chapterStats(ctx.projectId, c.title); return { id: c.id, title: c.title, seq: c.seq, status: c.status, novel: String(c.novel || '').slice(0, NOVEL_CAP), hasScript: !!String(c.script || '').trim(), scriptChars: String(c.script || '').length, shotCount: st.total, doneCount: st.done, genStatus: st.status }; }));
}

// 章节解析：标题或 id 都认（get_chapter / set_chapter_script 共用；与 set_storyboard 同口径）。
function resolveChapterRef(ctx, raw) {
  const chs = Chapters.list(ctx.projectId);
  const want = String(raw == null ? '' : raw).trim() || String(ctx.chapter || '').trim();
  if (!want) throw new Error('缺少 chapter：请传章节标题或 id（可用 list_chapters 查看本项目章节）');
  const hit = chs.find((c) => c.title === want || c.id === want);
  if (!hit) throw new Error('章节不存在：' + want + '（本项目现有章节：' + chs.map((c) => c.title).join('、') + '）');
  return hit;
}

async function hGetChapter(ctx, args) {
  const c = resolveChapterRef(ctx, args.chapter);
  return JSON.stringify({ id: c.id, title: c.title, seq: c.seq, novel: c.novel || '', script: c.script || '' });
}

async function hSetChapterScript(ctx, args) {
  const c = resolveChapterRef(ctx, args.chapter);
  const script = String(args.script == null ? '' : args.script).trim();
  if (!script) throw new Error('剧本不能为空');
  const existing = String(c.script || '').trim();
  // 已有剧本是用户/AI 已确认的剧情蓝本：默认拒绝覆盖，避免流水线重跑把用户手改稿吞掉。
  if (existing && args.overwrite !== true) {
    throw new Error('本章已有剧本（' + existing.length + ' 字），请直接按现有剧本拆分镜；仅当用户明确要求重写剧本时才传 overwrite:true');
  }
  Chapters.update(c.id, { script });
  // 剧本一进来就把资产建好（原文层面建资产）：
  // 场次头写着地点（`1-1 日景 外 赛车场 / 赛道`），动作行写着同场次内的其它景
  // （「切到室内发布会现场」「走廊的公共垃圾桶旁」），人物行写着谁在场。
  // 此时建好 scene/character/prop，后面导入分镜表才能按名字匹配上、投喂阶段才有【场景资产】可引用。
  // 等导入时再靠画面去猜，猜出来的名字往往和资产库对不上。
  let autoAssets = null;
  try { autoAssets = ensureScriptAssets(ctx.projectId, script); } catch (e) { autoAssets = { error: String((e && e.message) || e) }; }
  if (ctx.report && autoAssets && (autoAssets.created || []).length) {
    const byCat = autoAssets.created.reduce((m, x) => { m[x.category] = (m[x.category] || 0) + 1; return m; }, {});
    ctx.report({ phase: '资产', detail: '按剧本自动建资产：' + Object.entries(byCat).map(([k, v]) => k + ' ' + v + ' 个').join('、') });
  }
  if (ctx.report) ctx.report({ phase: '剧本', detail: '已写入「' + c.title + '」剧本（' + script.length + ' 字）' });
  return JSON.stringify({
    chapter: c.title, chars: script.length, overwritten: !!existing,
    autoAssets: autoAssets ? {
      created: (autoAssets.created || []).length,
      scenes: (autoAssets.scenes || []).map((x) => x.place),
      characters: autoAssets.characters || [],
      props: autoAssets.props || [],
      error: autoAssets.error,
    } : null,
  });
}

// —— 阶段 3 · P2：场次基线写入（剧本抽取阶段专用）——
// 权限三层中的 L2（写不进）：**首行**断言 ctx.toolSet，且必须早于任何校验与落库，
// 拒绝时一行都不写（PS-B）。注意 ctx.toolSet 只来自服务端 buildMcpTools 的构造参数，
// 不是 args、也不是 ctx.project 里任何用户可写字段（PS-A）。
async function hSetSceneState(ctx, args) {
  if (ctx.toolSet !== 'script') {
    throw sceneStateError(
      'SCENE_STATE_WRITE_FORBIDDEN',
      'set_scene_state 只在剧本抽取阶段（toolSet=script）可用；分镜创作阶段严禁写 scene_states'
      + '（D01-06 §1.1）。当前 toolSet=' + (ctx.toolSet || '(未设置)') + '。',
      { toolSet: ctx.toolSet || '', projectId: ctx.projectId },
    );
  }
  // §4.2 D-4：每个新路径写入口都要自己判一次 flag（不靠"上游判过了"）。
  // 剧本抽取阶段本来就是结构化链路的前置：flag 关掉的项目不该被写进 scene_states。
  if (!isStructuredSpec(ctx.projectId)) {
    throw sceneStateError(
      'STRUCTURED_SPEC_DISABLED',
      '项目未开启结构化创作（structured_spec=0），拒绝写入场次基线。'
      + '请在项目设置里开启结构化模式，或继续使用旧链路。',
      { projectId: ctx.projectId },
    );
  }
  const c = resolveChapterRef(ctx, args.chapter);
  const out = upsertSceneStates(ctx.projectId, c, args.scenes);
  const notes = out.scenes.flatMap((s) => s.qc_notes || []);
  if (ctx.report) {
    ctx.report({
      phase: '场次基线',
      detail: '「' + c.title + '」场次 ' + out.scenes.length + ' 个（新增 ' + out.created + ' / 重写 ' + out.updated + '）',
    });
  }
  return JSON.stringify({
    chapter: out.chapter,
    created: out.created,
    updated: out.updated,
    scenes: out.scenes.map((s) => ({
      scene_key: s.scene_key, scene_id: s.scene_id, state_rev: s.state_rev,
      created: s.created, incomplete: s.incomplete,
    })),
    // 说明：这是**写入侧**的不完整提示（谁缺什么）。权威 QC 判定属 P5，不在此处冒充。
    qc_notes: notes,
  });
}

async function hSaveContext(ctx, args) {
  // key 值域与工具 schema 的 enum、以及 PUT /api/projects/:id/context 的 400 口径一致。
  // 不校验的话：key='bible2' 之类会当 style.md 落盘（写坏风格指南文件），DB 里却多出一个野键。
  if (!CONTEXT_KEYS.includes(args.key)) {
    throw new Error('key 只能是 ' + CONTEXT_KEYS.join('/') + '（当前：' + args.key + '）');
  }
  const dir = path.join(projectDir(ctx.projectId), 'context');
  fs.mkdirSync(dir, { recursive: true });
  if (args.key === 'continuity') {
    const f = path.join(dir, 'continuity.json');
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    // 文件可能是被手改坏的非数组 JSON：直接 push 会抛 TypeError，整次写入失败。
    // 与路由侧（context/route.js）一致，非数组一律当空列表重来。
    if (!Array.isArray(arr)) arr = [];
    arr.push({ t: Date.now(), content: args.content });
    fs.writeFileSync(f, JSON.stringify(arr, null, 2));
  } else {
    const f = path.join(dir, args.key === 'bible' ? 'bible.md' : 'style.md');
    fs.writeFileSync(f, args.content);
  }
  // 多章节并行时，各 Agent 手里的 ctx.project.context 可能是旧快照。
  // 只合并本次写入的 key，避免整段覆盖掉另一章刚写的 bible/style/continuity。
  const fresh = Projects.setContextKey(ctx.projectId, args.key, args.content);
  if (fresh) ctx.project.context = fresh;
  return '已保存上下文：' + args.key;
}

async function hLoadSkill(ctx, args) {
  const name = args.name;
  const skill = loadSkillWithResources(name);
  if (!skill) throw new Error('技能不存在：' + name);
  if (ctx.loadedSkills) ctx.loadedSkills.add(String(name));
  const NL = String.fromCharCode(10);
  const parts = [renderSkillContent(skill)];
  if (skill.references && skill.references.length) {
    parts.push('【技能参考文件索引】需要某个文件全文时，调用 skill_reference(name="' + name + '", ref="<文件名>")：');
    for (const r of skill.references) {
      const preview = String(r.content || '').slice(0, 160).replace(/\s+/g, ' ');
      parts.push('- ' + r.name + '（约 ' + r.content.length + ' 字）' + (preview ? '：' + preview : ''));
    }
  }
  const content = parts.join(NL + NL);
  return content.length > 120000 ? content.slice(0, 120000) + '…（截断）' : content;
}

async function hSkillReference(ctx, args) {
  const skill = loadSkillWithResources(args.name);
  if (!skill) throw new Error('技能不存在：' + args.name);
  const refs = skill.references || [];
  const ref = refs.find((r) => r.name === args.ref);
  if (!ref) throw new Error('参考文件不存在：' + args.ref + '。可用：' + refs.map((r) => r.name).join(', '));
  // 记录「哪个技能的哪个 reference 已真正读过」，供分镜写入硬门禁核对（分镜必读规则不能被跳过）。
  // 内存 + 磁盘双写：内存供同一 ctx 内快速判定，磁盘兜住 ctx 重建/进程重启。
  if (ctx.loadedRefs) ctx.loadedRefs.add(String(args.name) + '/' + String(args.ref));
  addLoadedRefToDisk(ctx.projectId, ctx.jobId, String(args.name) + '/' + String(args.ref));
  const content = String(ref.content || '');
  return content.length > 120000 ? content.slice(0, 120000) + '…（截断）' : content;
}

async function hReport(ctx, args) {
  ctx.report({ phase: args.phase || '', detail: args.detail || '' });
  return '已汇报';
}

async function hListAssets(ctx, args) {
  const assets = Assets.list(ctx.projectId, args.category);
  // 必须带上 prompt / prompt_used：LLM 看不到用户已保存的提示词，就会以为自己才是第一个写的人，
  // 用 update_asset 把用户的提示词覆盖掉（「保存了提示词却不生效」的一大来源）。
  return JSON.stringify(assets.map((a) => ({
    id: a.id, category: a.category, name: a.name, description: a.description, voice_desc: a.voice_desc,
    prompt: a.prompt || '', prompt_used: a.prompt_used || '', prompt_locked: a.prompt_locked ? 1 : 0,
    image_path: a.image_path, voice_ref: a.voice_ref, parent_id: a.parent_id || '', source: a.source || '', status: a.status,
  })));
}

// 资产写入前的 parent_id 统一校验（Agent 工具侧）：
//   变体（服装/年龄）：必须用 parent_id 指向本项目的角色素材。refs.js 只按 parent_id 把变体映射到
//     角色（镜头里有该角色时才拿它替换角色参考图），缺父/父不是角色的变体在生成阶段被完全忽略，
//     却照样出现在素材库与分镜引用列表里 —— 用户以为绑上了、分镜也「更新成功」，实际静默无效。
//     db 层 Assets.create 会抛 BAD_VARIANT_PARENT，但那是「模型看不懂的 DB 错误」，这里给出可读指引，
//     把 LLM 引导到只干这件事的专用工具（change_outfit / design_outfits / change_age / design_ages）。
//   非变体分类：parent_id 无意义（只会让 Assets.remove 把它当子变体级联删、usageOf 把它计成 children），
//     传了就直接拒绝，绝不静默丢弃（静默丢弃 = 模型以为写成功，是同一类坑）。
function resolveAssetParent(ctx, category, parentId) {
  const pid = String(parentId || '').trim();
  if (!isVariantAssetCategory(category)) {
    if (pid) throw new Error('parent_id 只能用于服装（costume）/年龄（age）变体；' + category + ' 不挂在其它素材下，请去掉 parent_id');
    return '';
  }
  const parent = pid ? Assets.get(pid) : null;
  if (!parent || parent.project_id !== ctx.projectId || parent.category !== 'character') {
    const hint = category === 'costume'
      ? '生成服装建议改用 change_outfit / design_outfits（会以角色 canonical 图为参考出图）'
      : '生成年龄变体建议改用 change_age / design_ages（会以角色 canonical 图为参考出图）';
    throw new Error('服装/年龄变体必须用 parent_id 绑定到本项目的一个角色（character）资产；' + hint);
  }
  return pid;
}

async function hCreateAsset(ctx, args) {
  const parentId = resolveAssetParent(ctx, args.category, args.parent_id);
  const isVariant = isVariantAssetCategory(args.category);
  // 幂等：同分类+同名资产已存在则复用，避免续跑时重复建。
  // 变体（服装/年龄）还要按 parent_id 区分：同一套「旧衣」可能是不同角色各自的，
  // 只按 name 复用会把 A 角色的服装错算成 B 角色的（refs.js 按 parent_id 映射，挂到别的角色上）。
  const existing = Assets.list(ctx.projectId, args.category).find((a) => a.name === args.name && (!isVariant || (a.parent_id || '') === parentId));
  if (existing) {
    // 续跑复用：此前没写声音画像而这次提供了，补上（否则设计音色仍会性别错乱）
    if (existing.category === 'character' && args.voice_desc && !(existing.voice_desc || '').trim()) {
      Assets.update(existing.id, { voice_desc: args.voice_desc });
      logger.info('续跑资产补 voice_desc：' + existing.name);
    }
    return JSON.stringify({ id: existing.id, category: existing.category, name: existing.name, parent_id: existing.parent_id || '', reused: true, status: existing.status, image_path: existing.image_path });
  }
  const a = Assets.create(ctx.projectId, { category: args.category, name: args.name, description: args.description || '', voice_desc: args.voice_desc || '', parent_id: parentId });
  return JSON.stringify({ id: a.id, category: a.category, name: a.name, parent_id: a.parent_id || '', voice_desc: a.voice_desc });
}

// 用户在前端「素材库」手动保存过的提示词（prompt_locked=1）是权威，LLM 不得覆盖：
// 否则用户改完提示词、再跑一次 LLM 阶段，提示词就被 LLM 重写回去了（用户看到的现象就是「改了不生效」）。
// 想把提示词交回给 LLM 改写，只需在素材库里把提示词清空保存（清空即解锁）。
export function keepsUserPrompt(asset) {
  return !!(asset && asset.prompt_locked && String(asset.prompt || '').trim());
}

async function hUpdateAsset(ctx, args) {
  const patch = {};
  for (const k of ['name', 'description', 'voice_desc', 'prompt', 'negative_prompt', 'voice_ref', 'consistency_key']) {
    if (args[k] != null) patch[k] = args[k];
  }
  const asset = Assets.get(args.id);
  if (!asset || asset.project_id !== ctx.projectId) throw new Error('资产不存在：' + args.id);
  let keptPrompt = false;
  const imgBusy = Queue.activeByDedupe('asset:' + asset.id);
  const voiceBusy = Queue.activeByDedupe('voice:' + asset.id);
  const deferred = [];
  // 正在渲染时不要改输入：否则出来的图/音色对应的是旧提示词，下一阶段又会重做一遍。
  if (patch.prompt != null && imgBusy) { delete patch.prompt; deferred.push('prompt'); }
  if (patch.voice_desc != null && voiceBusy) { delete patch.voice_desc; deferred.push('voice_desc'); }
  if (patch.prompt != null && keepsUserPrompt(asset) && String(patch.prompt) !== String(asset.prompt)) {
    delete patch.prompt;
    keptPrompt = true;
  }
  Assets.update(args.id, patch);
  if (deferred.length) {
    return '已更新资产 ' + args.id + '（' + deferred.join('/') + ' 正在渲染，本次未改动；请等渲染结束后再更新，避免成品与提示词不一致）';
  }
  return keptPrompt
    ? ('已更新资产 ' + args.id + '（提示词保持用户手写版本不变：素材库里手动保存的提示词优先于 LLM；如需让 LLM 改写，请在素材库把该资产的提示词清空保存）')
    : ('已更新资产 ' + args.id);
}

// 其他章节正在渲染同一素材时，等待它完成，而不是立刻跳过：
// 跳过会让本批以为素材已就绪，后续视频阶段又因缺图失败/重试。最多等到队列超时。
async function waitForActiveRender(dedupeKey, isAborted, maxMs = 30 * 60 * 1000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (isAborted && isAborted()) throw new Error('任务已停止（等待其他任务完成渲染）');
    if (!Queue.activeByDedupe(dedupeKey)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function assetImageReady(asset) {
  return !!(asset && asset.image_path && asset.status === 'done' && (asset.prompt_used || '') === (asset.prompt || ''));
}

async function hGenerateAssetImage(ctx, args) {
  let asset = Assets.get(args.asset_id);
  if (!asset || asset.project_id !== ctx.projectId) throw new Error('资产不存在');
  const dedupeKey = 'asset:' + asset.id;
  if (Queue.activeByDedupe(dedupeKey)) {
    if (!(await waitForActiveRender(dedupeKey, ctx.isAborted))) throw new Error('等待其他任务完成该素材渲染超时');
    asset = Assets.get(asset.id) || asset;
    if (assetImageReady(asset)) {
      return JSON.stringify({ asset_id: asset.id, skipped: true, reason: '其他任务已完成该素材生成' });
    }
  }
  const fb = assetFallback(asset, ctx.project);
  // 资产自身的提示词优先（用户编辑过 / LLM 阶段写过的，都应盖过调用方这次的临时 prompt），args.prompt 仅作兜底
  const prompt = asset.prompt || args.prompt || fb.prompt;
  const baseNegative = sanitizeNegativePrompt(asset.negative_prompt || args.negative_prompt || fb.negative_prompt);
  // 按资产类型选合适尺寸：人物四格设定板/场景用 16:9，道具白底用 1:1，其余默认 16:9；可用参数 args.ratio 覆盖
  const RATIO_BY_CATEGORY = { character: '16:9', scene: '16:9', prop: '1:1', other: '16:9' };
  const ratio = RATIO_LIST.includes(args.ratio) ? args.ratio : (RATIO_BY_CATEGORY[asset.category] || '16:9');
  // 分辨率档位：调用方显式指定 > 项目设置 > 1K；具体像素按宽高比由 imageSizeFor 计算
  const resolution = IMAGE_RESOLUTIONS.includes(args.resolution) ? args.resolution : (ctx.project.image_resolution || '1K');
  const [w, h] = imageSizeFor(ratio, resolution);
  const spec = getSpecForKind(ctx.cfg, 't2i');
  // 人物素材不再依赖具体工作流 id，也不再用 prompt.includes('左侧1/3') 这种语言绑定判断：
  // 所有人物 t2i 都统一注入「四格角色设定板」契约，旧提示词里的版式/背景描述先剥离，避免两套指令冲突。
  const positive_prompt = asset.category === 'character' ? composeCharacterT2IPrompt(prompt, ctx.project.style) : prompt;
  const negative_prompt = asset.category === 'character' ? composeCharacterNegativePrompt(baseNegative) : baseNegative;
  const prefix = 'assets/' + slugify(asset.name) + '_' + uid().slice(0, 8);
  const prevImage = asset.image_path || '';
  const restoreAsset = (error = '') => Assets.update(asset.id, { status: prevImage ? 'done' : 'failed', error });
  ctx.report({ phase: '资产生成', detail: '文生图：' + asset.name });
  Assets.update(asset.id, { status: 'generating' });
  let outputs;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      ({ outputs } = await runWorkflow(ctx.cfg, spec, {
        positive_prompt, negative_prompt, width: w, height: h, seed: randomSeed(), filename_prefix: prefix,
      }, { timeoutMs: IMG_TIMEOUT(ctx.cfg), isAborted: ctx.isAborted, jobId: ctx.jobId, projectId: ctx.projectId, chapter: '', subject: asset.name || asset.id, dedupeKey, onStatus: (s) => { if (s.kind === 'error') throw new Error(s.message); } }));
      break;
    } catch (e) {
      // 流水线 / 手动入口并发提交同一资产：等先到的任务完成；若已完成则跳过，不重复扣费。
      if (e && e.code === 'DUPLICATE_RENDER' && attempt === 0) {
        const ok = await waitForActiveRender(dedupeKey, ctx.isAborted);
        if (!ok) { restoreAsset('等待其他任务完成该素材渲染超时'); throw new Error('等待其他任务完成该素材渲染超时'); }
        const fresh = Assets.get(asset.id);
        if (assetImageReady(fresh)) {
          Assets.update(asset.id, { status: 'done', error: '' });
          return JSON.stringify({ asset_id: asset.id, skipped: true, reason: '其他任务已完成该素材生成' });
        }
        // 先到的任务失败/取消，或它生成后提示词又被改过：用本批的提示词再提交一次
        continue;
      }
      Assets.update(asset.id, { status: prevImage ? 'done' : 'failed', error: e.message });
      throw e;
    }
  }
  if (!outputs) { restoreAsset('资产生成未完成'); throw new Error('资产生成未完成'); }
  const img = pickOutput(outputs, 'images');
  if (!img) { restoreAsset('文生图工作流未返回图片'); throw new Error('文生图工作流未返回图片'); }
  const ext = path.extname(img.filename) || '.png';
  const relDir = 'assets/' + PROJECT_ASSET_SUBDIRS[asset.category] + '/';
  const relPath = relDir + slugify(asset.name) + '_' + uid().slice(0, 8) + ext;
  await downloadOutputTo(ctx, img, relPath);
  if (asset.category === 'character') await cleanCharacterSheetBorders(ctx, relPath);
  Assets.update(asset.id, { image_path: relPath, source: 'generated', prompt, prompt_used: prompt, negative_prompt, status: 'done', error: '' });
  return JSON.stringify({ asset_id: asset.id, image_path: relPath });
}

// 复用：以参考图跑图生图，返回产物 { img, ext }（调用方负责下载落盘）。
// refs 支持 1..N 张参考图（多图参考生图 = 单图的一般化）：spec 带 media 绑定时走 references 多图装配，
// 否则回落到单张 image 角色，保持旧 i2i 规格行为不变。
async function runI2iEdit(ctx, { refs, prompt, namePrefix, seed, dedupeKey, preserveText = true }) {
  const list = (Array.isArray(refs) ? refs : [refs]).filter(Boolean);
  if (!list.length) throw new Error('缺少参考图');
  const references = [];
  for (const refAbs of list) {
    const refName = await uploadTaskInput(ctx.cfg, refAbs, 'ic_ref_' + ctx.projectId.slice(0, 8) + '_' + uid().slice(0, 8) + path.extname(refAbs), 'image');
    // localPath：外接出图引擎直接读本地文件转 data URL（本地没开 ComfyUI 也能出图）
    references.push({ type: 'image', filename: refName, localPath: refAbs });
  }
  const spec = getSpecForKind(ctx.cfg, 'i2i');
  const prefix = namePrefix || ('assets/edit_' + uid().slice(0, 8));
  // 图生图没有负向提示词通道，文字只能靠正向指令保住：参考图上的文字/标签/包装信息默认保留，
  // 否则 Qwen-Image-Edit 会把产品包装、书封、招牌上的字当成噪声擦掉。
  // 人物设定板变体不需要文字，传 preserveText=false，避免模型在灰底上生成标签或水印。
  const editPrompt = prompt + (preserveText
    ? '\n参考图中已有的文字、标签、包装说明与 logo 保持原样（除非上面的指令明确要求改动），不要擦除或改写。'
    : '');
  const params = { positive_prompt: editPrompt, seed: seed ?? randomSeed(), filename_prefix: prefix };
  // 图生图默认 1024×1024 会把四格设定板压成方图/裁掉格子，必须按参考图宽高比出图。
  const refSize = await probeImageSize(list[0]);
  const ratio = refSize?.width && refSize?.height ? (refSize.width + ':' + refSize.height) : '16:9';
  const [w, h] = imageSizeFor(ratio, ctx.project.image_resolution || '1K');
  params.width = w;
  params.height = h;
  if (spec.media) params.references = references;
  else params.image = references[0].filename;
  const { outputs } = await runWorkflow(ctx.cfg, spec, params, { timeoutMs: IMG_TIMEOUT(ctx.cfg), isAborted: ctx.isAborted, jobId: ctx.jobId, projectId: ctx.projectId, dedupeKey, onStatus: (s) => { if (s.kind === 'error') throw new Error(s.message); } });
  const img = pickOutput(outputs, 'images');
  if (!img) throw new Error('图生图工作流未返回图片');
  return { img, ext: path.extname(img.filename) || '.png' };
}

async function hEditAssetImage(ctx, args) {
  const asset = Assets.get(args.asset_id);
  if (!asset || asset.project_id !== ctx.projectId) throw new Error('资产不存在');
  let refAbs;
  if (args.reference_image_path) {
    refAbs = resolveProjectPath(ctx.projectId, args.reference_image_path);
  } else {
    const refAsset = args.reference_asset_id ? Assets.get(args.reference_asset_id) : asset;
    // 参考资产必须属于本项目：跨项目 id 在下面按本项目路径解析，会指向本项目里的同名相对路径
    // （两个项目的 assets/character/xxx.png 都可能存在），等于拿错图当参考。
    if (!refAsset || refAsset.project_id !== ctx.projectId) throw new Error('参考资产不存在');
    refAbs = resolveProjectPath(ctx.projectId, refAsset.image_path);
  }
  if (!refAbs || !fs.existsSync(refAbs)) throw new Error('参考图不存在，请先生成/上传参考图');
  const fb = assetFallback(asset, ctx.project);
  // 资产自身的提示词优先（用户编辑过 / LLM 阶段写过的，都应盖过调用方这次的临时 prompt），args.prompt 仅作兜底
  const prompt = asset.prompt || args.prompt || fb.prompt;
  const ratio = RATIO_LIST.includes(args.ratio) ? args.ratio : '';
  const resolution = IMAGE_RESOLUTIONS.includes(args.resolution) ? args.resolution : (ctx.project.image_resolution || '1K');
  ctx.report({ phase: '资产生成', detail: '图生图：' + asset.name });
  const { img, ext } = await runI2iEdit(ctx, { refs: [refAbs], prompt, namePrefix: 'assets/' + slugify(asset.name) + '_edit_' + uid().slice(0, 8), dedupeKey: 'asset:' + asset.id });
  const relDir = 'assets/' + PROJECT_ASSET_SUBDIRS[asset.category] + '/';
  const relPath = relDir + slugify(asset.name) + '_' + uid().slice(0, 8) + ext;
  await downloadOutputTo(ctx, img, relPath);
  await normalizeGeneratedImage(ctx, relPath, resolution, ratio);
  if (asset.category === 'character') await cleanCharacterSheetBorders(ctx, relPath);
  // 追加版本，仍以最新为准
  const versions = [...(asset.versions || []), asset.image_path].filter(Boolean);
  Assets.update(asset.id, { image_path: relPath, source: 'generated', prompt, prompt_used: prompt, versions, status: 'done', error: '' });
  return JSON.stringify({ asset_id: asset.id, image_path: relPath });
}

// 变体（换装 / 年龄）是否可以直接复用已有图。
// 复用条件必须包含「内容与提示词都没被改过」：用户可能在前端把变体的提示词改了并保存，
// 这时 prompt ≠ prompt_used —— 直接复用旧图等于把用户的修改吞掉（就是「改了提示词不生效」）。
export function variantReusable(existing, description, explicitPrompt) {
  if (!existing || !existing.image_path || existing.status !== 'done') return false;
  if (String(existing.description || '') !== String(description || '')) return false;
  if (String(existing.prompt || '') !== String(existing.prompt_used || '')) return false;
  if (explicitPrompt != null && String(existing.prompt || '') !== String(explicitPrompt)) return false;
  return true;
}

// 变体出图用的提示词：调用方显式给的 > 资产里被改过的（用户手改的优先）> 兜底/视觉精修。
// 注意「被改过」= prompt ≠ prompt_used：只有这时资产自身的提示词才代表用户的新指令。
export function variantPrompt(existing, explicitPrompt, fallback) {
  if (explicitPrompt != null && String(explicitPrompt).trim()) return String(explicitPrompt);
  const own = String((existing && existing.prompt) || '').trim();
  if (own && own !== String((existing && existing.prompt_used) || '')) return own;
  return fallback;
}

// 自动生成的 BGM 回写「背景音乐库」：同名资产复用（原地更新），否则每次重新生成都会新增一条
// 同名资产——音乐库堆重复条目，audios 按名字映射时指向哪一条还取决于列表顺序。
export function upsertMusicAsset(ctx, name, patch) {
  const dup = Assets.list(ctx.projectId, 'music').find((a) => a.name === name);
  const asset = dup || Assets.create(ctx.projectId, { category: 'music', name });
  Assets.update(asset.id, patch);
  return asset.id;
}

// 换装/年龄变体是图生图：参考图本身是四格角色设定板。
// 只改目标属性时，必须把版式、格数、顺序、背景、光位一起锁死，否则模型会顺手重排或增删视图。
const CHARACTER_VARIANT_LAYOUT_LOCK = '【版式锁定】保持参考图的四格角色设定板构图不变：从左到右为大脸特写、正面全身、90°侧面全身、背面全身；竖线分格、视图数量、人物位置、中性灰背景、柔光方向、曝光、身体比例和画幅完全不变；不要增加、减少、重排或裁切任何一格。四格必须全部应用同一次修改（包括第一格大脸特写的领口、肩部衣物与面部状态），不允许只改全身格、保留第一格旧样子。';

function withCharacterLayoutLock(prompt) {
  const p = String(prompt || '').trim();
  return p.includes('【版式锁定】') ? p : p + '\n' + CHARACTER_VARIANT_LAYOUT_LOCK;
}

async function hChangeOutfit(ctx, args) {
  const char = Assets.get(args.character_id);
  if (!char || char.project_id !== ctx.projectId) throw new Error('角色资产不存在');
  if (char.category !== 'character') throw new Error('change_outfit 只能对角色（character）资产使用');
  const refAbs = resolveProjectPath(ctx.projectId, char.image_path);
  if (!refAbs || !fs.existsSync(refAbs)) throw new Error('角色参考图不存在，请先生成/上传角色 canonical 图');
  const outfit = String(args.outfit || '').trim();
  if (!outfit) throw new Error('请提供 outfit（服装描述）');
  const label = String(args.label || '').trim();
  const name = char.name + '-' + (label || outfit);
  // 同名变体（不限状态）：内容/提示词改过就原地重做——既不新建重复资产，也不复用旧图吞掉修改。
  const existing = Assets.list(ctx.projectId, 'costume').find((a) => a.parent_id === char.id && a.name === name);
  if (variantReusable(existing, outfit, args.prompt)) {
    return JSON.stringify({ costume_id: existing.id, image_path: existing.image_path, parent_id: existing.parent_id, reused: true });
  }

  let prompt = variantPrompt(existing, args.prompt, '');
  if (!prompt) {
    const base = 'Keep the character identity, face, hairstyle, expression and art style exactly the same as the reference image; change only the clothing to: ' + outfit + '. Keep the same pose, the same layout and panel order, the same view count and the same body proportions. Keep the background pure white (#FFFFFF), plain and seamless, with no gradient, no texture, no props and no environment; keep the upper-left soft lighting direction and color temperature unchanged. Do not add or remove any panel.';
    // 视觉精修只要求「开了 vision 且配了 Base URL」：本地无鉴权的多模态端点（llama.cpp 等）
    // 本来就没有 api_key，卡 apiKey 会让这些用户的视觉精修永远静默降级。
    if (!ctx.llmDisabled && visionEnabled(ctx) && ctx.cfg.llm?.baseUrl) {
      try {
        const img = imageToDataUrl(refAbs);
        const dataUrls = img ? ['data:' + img.mimeType + ';base64,' + img.data] : [];
        const r = await llmChat(ctx.cfg.llm, [
          { role: 'system', content: '你是图生图（Qwen-Image-Edit）换装提示词专家。基于参考图与服装描述，输出一段英文编辑指令：保持角色身份/脸部/发型/画风一致，只更换服装；不要输出任何解释，只输出指令文本。' },
          buildVisionUserMessage('参考图如下。请为以下服装写英文图生图换装指令：' + outfit, dataUrls),
        ], { temperature: 0.5, maxTokens: 400 });
        prompt = (r.content || '').trim() || base;
      } catch (e) { logger.warn('换装视觉精修失败，用默认指令', { error: e.message }); prompt = base; }
    } else {
      prompt = base;
    }
  }

  prompt = withCharacterLayoutLock(prompt);
  ctx.report({ phase: '人物换装', detail: '为 ' + char.name + ' 生成服装「' + outfit + '」（图生图）' });
  const { img, ext } = await runI2iEdit(ctx, { refs: [refAbs], prompt, preserveText: false, namePrefix: 'assets/costume_' + slugify(char.name) + '_' + uid().slice(0, 8), dedupeKey: 'outfit:' + char.id });
  const relPath = 'assets/' + PROJECT_ASSET_SUBDIRS.costume + '/' + slugify(name) + '_' + uid().slice(0, 8) + ext;
  await downloadOutputTo(ctx, img, relPath);
  await normalizeGeneratedImage(ctx, relPath, ctx.project.image_resolution || '1K');
  await cleanCharacterSheetBorders(ctx, relPath);
  const costume = existing || Assets.create(ctx.projectId, { category: 'costume', name, description: outfit, prompt, parent_id: char.id });
  // prompt_used 必须落库（= 本次真正用于出图的提示词）：批量/阶段判定「提示词是否改过」全靠它。
  Assets.update(costume.id, { image_path: relPath, source: 'generated', description: outfit, prompt, prompt_used: prompt, status: 'done', error: '' });
  return JSON.stringify({ costume_id: costume.id, image_path: relPath, parent_id: char.id, prompt });
}

// 一次性给角色设计并生成多套服装（衣橱）：复用 change_outfit 的图生图换装，逐套生成服装资产
async function hDesignOutfits(ctx, args) {
  const char = Assets.get(args.character_id);
  if (!char || char.project_id !== ctx.projectId) throw new Error('角色资产不存在');
  if (char.category !== 'character') throw new Error('design_outfits 只能对角色（character）资产使用');
  const outfits = Array.isArray(args.outfits) ? args.outfits : [];
  if (!outfits.length) throw new Error('请提供 outfits（该角色的多套服装清单）');
  // 依赖判定：服装变体是图生图，必须等父角色的 canonical 图完成，否则每一套都会失败。
  if (!(char.status === 'done' && char.image_path && fs.existsSync(resolveProjectPath(ctx.projectId, char.image_path)))) {
    return JSON.stringify({
      character_id: char.id, character_name: char.name,
      costumes: outfits.map((o) => ({ name: String((o && o.name) || ''), deferred: true })),
      note: '父角色 canonical 图尚未生成完成，服装变体暂缓：请先生成该角色图片',
    });
  }
  // 并发提交：真正限流的是 runWorkflow 的渲染槽位（RunningHub 按 runninghubConcurrency，
  // 本地 ComfyUI 恒为 1），这里一次性把整套服装排进队列即可。
  const results = await Promise.all(outfits.map(async (o) => {
    const name = String((o && o.name) || '').trim();
    const description = String((o && o.description) || name || '').trim();
    if (!description) return null;
    try {
      const r = await hChangeOutfit(ctx, { character_id: char.id, outfit: description, label: name });
      return { name: name || description, ...JSON.parse(r) };
    } catch (e) {
      logger.warn('design_outfits 单套生成失败：' + (name || description), { error: e.message });
      return { name: name || description, error: e.message };
    }
  }));
  const list = results.filter(Boolean);
  const okCount = list.filter((r) => !r.error).length;
  ctx.report({ phase: '人物换装', detail: '为 ' + char.name + ' 设计衣橱：生成 ' + okCount + '/' + outfits.length + ' 套服装' });
  return JSON.stringify({ character_id: char.id, character_name: char.name, costumes: list });
}

// 人物年龄变体：复用换装的图生图一致性思路，只把「换服装」改成「改年龄」。
// 产出 category=age、parent_id 指向角色，供回忆/时间跳跃镜头按章引用。
async function hChangeAge(ctx, args) {
  const char = Assets.get(args.character_id);
  if (!char || char.project_id !== ctx.projectId) throw new Error('角色资产不存在');
  if (char.category !== 'character') throw new Error('change_age 只能对角色（character）资产使用');
  const refAbs = resolveProjectPath(ctx.projectId, char.image_path);
  if (!refAbs || !fs.existsSync(refAbs)) throw new Error('角色参考图不存在，请先生成/上传角色 canonical 图');
  const age = String(args.age || '').trim();
  if (!age) throw new Error('请提供 age（年龄/时期描述）');
  const label = String(args.label || '').trim();
  const name = char.name + '-' + (label || age);
  // 同名变体（不限状态）优先；其次按描述精确匹配（避免旧数据命名不一致时重复生成）。
  // 不再用 name.includes(label) 这种模糊匹配 —— 它可能命中另一个变体，把改过的内容静默跳过。
  const ages = Assets.list(ctx.projectId, 'age').filter((a) => a.parent_id === char.id);
  const existing = ages.find((a) => a.name === name) || ages.find((a) => String(a.description || '') === age);
  if (variantReusable(existing, age, args.prompt)) {
    return JSON.stringify({ age_id: existing.id, image_path: existing.image_path, parent_id: existing.parent_id, reused: true });
  }

  let prompt = variantPrompt(existing, args.prompt, '');
  if (!prompt) {
    const younger = /年轻|少年|青年|童年|幼年|小时候|减龄|学生/.test(age);
    const older = /老|中年|老年|年长|增龄|多年后|花甲|古稀/.test(age);
    const ageDirection = younger
      ? 'Age change must be obvious at a glance: at least 10 years younger, smoother and firmer skin, clearly fewer deep lines around eyes and mouth, fuller cheeks, darker and denser hair; not just a mild skin retouch.'
      : older
        ? 'Age change must be obvious at a glance: at least 10 years older, deeper lines, looser skin, more visible eye bags and neck lines, greyer/ thinner hair; not just a mild skin retouch.'
        : 'Age change must be obvious at a glance: skin texture, wrinkles, facial fullness and hair color must all change visibly; not just a mild skin retouch.';
    const base = 'Keep the character identity and species exactly as in the reference image (a cat stays a cat, a human stays a human). Keep the face, facial features, body structure, hairstyle, hair color and art style unchanged; change only the age/life stage to: ' + age + '. ' + ageDirection + ' Keep the same pose, the same outfit, the same layout and panel order, the same view count and the same body proportions. Keep the background pure white (#FFFFFF), plain and seamless, with no gradient, no texture, no props and no environment; keep the upper-left soft lighting direction and color temperature unchanged. Do not add or remove any panel.';
    // 视觉精修只要求「开了 vision 且配了 Base URL」：本地无鉴权的多模态端点（llama.cpp 等）
    // 本来就没有 api_key，卡 apiKey 会让这些用户的视觉精修永远静默降级。
    if (!ctx.llmDisabled && visionEnabled(ctx) && ctx.cfg.llm?.baseUrl) {
      try {
        const img = imageToDataUrl(refAbs);
        const dataUrls = img ? ['data:' + img.mimeType + ';base64,' + img.data] : [];
        const r = await llmChat(ctx.cfg.llm, [
          { role: 'system', content: '你是图生图（Qwen-Image-Edit）年龄变体提示词专家。基于参考图与年龄描述，输出一段英文编辑指令：保持角色物种与身份一致（猫仍是猫、人仍是人，禁止把动物变成人或把人变成动物）、保持脸部/五官/发型/毛色/身体结构/画风一致，只改年龄/生命阶段；不要输出任何解释，只输出指令文本。' },
          buildVisionUserMessage('参考图如下。请为以下年龄/时期写英文图生图变体指令：' + age, dataUrls),
        ], { temperature: 0.5, maxTokens: 400 });
        prompt = (r.content || '').trim() || base;
      } catch (e) { logger.warn('年龄变体视觉精修失败，用默认指令', { error: e.message }); prompt = base; }
    } else {
      prompt = base;
    }
  }

  prompt = withCharacterLayoutLock(prompt);
  ctx.report({ phase: '人物年龄', detail: '为 ' + char.name + ' 生成年龄变体「' + age + '」（图生图）' });
  const { img, ext } = await runI2iEdit(ctx, { refs: [refAbs], prompt, preserveText: false, namePrefix: 'assets/age_' + slugify(char.name) + '_' + uid().slice(0, 8), dedupeKey: 'age:' + char.id });
  const relPath = 'assets/' + PROJECT_ASSET_SUBDIRS.age + '/' + slugify(name) + '_' + uid().slice(0, 8) + ext;
  await downloadOutputTo(ctx, img, relPath);
  await normalizeGeneratedImage(ctx, relPath, ctx.project.image_resolution || '1K');
  await cleanCharacterSheetBorders(ctx, relPath);
  const ageAsset = existing || Assets.create(ctx.projectId, { category: 'age', name, description: age, prompt, parent_id: char.id });
  Assets.update(ageAsset.id, { image_path: relPath, source: 'generated', description: age, prompt, prompt_used: prompt, status: 'done', error: '' });
  return JSON.stringify({ age_id: ageAsset.id, image_path: relPath, parent_id: char.id, prompt });
}

// 一次性给角色设计并生成多个时期/年龄变体：复用 change_age 的图生图变体，逐时期生成 age 资产
async function hDesignAges(ctx, args) {
  const char = Assets.get(args.character_id);
  if (!char || char.project_id !== ctx.projectId) throw new Error('角色资产不存在');
  if (char.category !== 'character') throw new Error('design_ages 只能对角色（character）资产使用');
  const ages = Array.isArray(args.ages) ? args.ages : [];
  if (!ages.length) throw new Error('请提供 ages（该角色的多时期清单）');
  // 依赖判定：年龄变体同为图生图，必须等父角色 canonical 图完成。
  if (!(char.status === 'done' && char.image_path && fs.existsSync(resolveProjectPath(ctx.projectId, char.image_path)))) {
    return JSON.stringify({
      character_id: char.id, character_name: char.name,
      ages: ages.map((o) => ({ name: String((o && o.name) || ''), deferred: true })),
      note: '父角色 canonical 图尚未生成完成，年龄变体暂缓：请先生成该角色图片',
    });
  }
  const results = await Promise.all(ages.map(async (o) => {
    const name = String((o && o.name) || '').trim();
    const description = String((o && o.description) || name || '').trim();
    if (!description) return null;
    try {
      const r = await hChangeAge(ctx, { character_id: char.id, age: description, label: name });
      return { name: name || description, ...JSON.parse(r) };
    } catch (e) {
      logger.warn('design_ages 单时期生成失败：' + (name || description), { error: e.message });
      return { name: name || description, error: e.message };
    }
  }));
  const list = results.filter(Boolean);
  const okCount = list.filter((r) => !r.error).length;
  ctx.report({ phase: '人物年龄', detail: '为 ' + char.name + ' 设计年龄变体：生成 ' + okCount + '/' + ages.length + ' 个时期' });
  return JSON.stringify({ character_id: char.id, character_name: char.name, ages: list });
}

async function hViewAsset(ctx, args) {
  const a = Assets.get(args.asset_id);
  if (!a || a.project_id !== ctx.projectId) throw new Error('资产不存在');
  const text = JSON.stringify({ id: a.id, category: a.category, name: a.name, description: a.description, prompt: a.prompt || '', prompt_used: a.prompt_used || '', prompt_locked: a.prompt_locked ? 1 : 0, negative_prompt: a.negative_prompt || '', image_path: a.image_path, voice_desc: a.voice_desc || '', parent_id: a.parent_id || '', status: a.status });
  if (!visionEnabled(ctx)) return text + '（当前模型不支持图片输入，仅返回文本描述）';
  const abs = resolveProjectPath(ctx.projectId, a.image_path);
  const images = imagesFromPaths([abs], 1);
  return images.length ? { text, images } : text + '（该资产暂无参考图）';
}

async function hViewShotReferences(ctx, args) {
  const shot = Shots.get(args.shot_id);
  if (!shot || shot.project_id !== ctx.projectId) throw new Error('分镜不存在');
  const assets = Assets.list(ctx.projectId);
  const byId = (id) => assets.find((x) => x.id === id);
  const chars = (shot.character_ids || []).map(byId).filter(Boolean);
  const scenes = (shot.scene_ids || []).map(byId).filter(Boolean);
  const props = (shot.prop_ids || []).map(byId).filter(Boolean);
  const costumes = (shot.costume_ids || []).map(byId).filter(Boolean);
  const ages = (shot.age_ids || []).map(byId).filter(Boolean);
  const audios = (shot.audio_ids || []).map(byId).filter(Boolean);
  // 同一角色只给一张图：已挂服装/年龄变体时，变体图就是实际提交的角色参考图（服装优先于年龄），
  // 不再把角色原图也塞进图片块——否则模型会看到同一个人物的两张设定图。
  const costumeCharIds = new Set(costumes.map((a) => a.parent_id).filter(Boolean));
  const variantCharIds = new Set([...costumeCharIds, ...ages.map((a) => a.parent_id).filter(Boolean)]);
  const text = JSON.stringify({
    characters: chars.map((c) => ({ id: c.id, name: c.name, image_path: c.image_path })),
    scenes: scenes.map((s) => ({ id: s.id, name: s.name, image_path: s.image_path })),
    props: props.map((p) => ({ id: p.id, name: p.name, image_path: p.image_path })),
    costumes: costumes.map((c) => ({ id: c.id, name: c.name, image_path: c.image_path, parent_id: c.parent_id || '' })),
    ages: ages.map((a) => ({ id: a.id, name: a.name, image_path: a.image_path, parent_id: a.parent_id || '' })),
    audios: audios.map((a) => ({ id: a.id, name: a.name, category: a.category, audio_path: a.audio_path || a.voice_ref })),
  });
  if (!visionEnabled(ctx)) return text + '（当前模型不支持图片输入，仅返回文本清单）';
  const absPaths = [
    ...chars.filter((c) => !variantCharIds.has(c.id)),
    ...scenes, ...props,
    ...costumes,
    ...ages.filter((a) => !costumeCharIds.has(a.parent_id)),
  ].map((x) => resolveProjectPath(ctx.projectId, x.image_path)).filter(Boolean);
  const images = imagesFromPaths(absPaths, 6);
  return images.length ? { text, images } : text + '（该分镜暂无参考图）';
}

// 解析目标章节 id 集合：ctx.chapter 可能是标题或 id；无目标（全部章节）返回 null。
export function targetChapterIdSet(ctx) {
  if (!ctx.chapter) return null;
  const set = new Set();
  for (const c of Chapters.list(ctx.projectId)) {
    if (c.title === ctx.chapter || c.id === ctx.chapter) set.add(c.id);
  }
  return set;
}

async function hViewProjectReferences(ctx) {
  const refs = filterReferenceImages(ReferenceImages.list(ctx.projectId, { mode: 'reference' }), targetChapterIdSet(ctx));
  const text = JSON.stringify(refs.map((r) => ({ id: r.id, chapter_id: r.chapter_id || '', name: r.name, image_path: r.image_path, category: r.category, description: r.description || '' })));
  if (!visionEnabled(ctx)) return text + '（当前模型不支持图片输入，仅返回文本清单）';
  const absPaths = refs.map((r) => resolveProjectPath(ctx.projectId, r.image_path)).filter(Boolean);
  const images = imagesFromPaths(absPaths, 6);
  return images.length ? { text, images } : text + '（暂无参考图）';
}

async function hWebSearch(ctx, args) {
  // 设置里关闭联网搜索时，两个工具都返回 disabled（不抛错），让 Agent 用既有知识继续、不要重试。
  if (ctx.cfg.search?.enabled === false) {
    return JSON.stringify({ disabled: true, message: '联网搜索已在设置中关闭。请改用你的既有知识继续，不要重试。' });
  }
  if (args.type === 'image') {
    return JSON.stringify(await searchImages(args.query, { limit: args.limit }));
  }
  return JSON.stringify(await searchWeb(args.query, { limit: args.limit, engine: args.engine }));
}

async function hDownloadReferenceImage(ctx, args) {
  if (ctx.cfg.search?.enabled === false) {
    return JSON.stringify({ disabled: true, message: '联网搜索已在设置中关闭，无法下载参考图。' });
  }
  const url = String(args.url || '').trim();
  if (!url) throw new Error('请提供图片 URL');
  const { buffer, ext } = await downloadImageSafe(url);
  // 参考图必须归属某章（references 上传链路要求 chapter_id 必填）；优先当前目标章节，否则第一章。
  const chapters = Chapters.list(ctx.projectId);
  if (!chapters.length) throw new Error('项目还没有章节，无法登记参考图');
  const chapterId = (chapters.find((c) => c.title === ctx.chapter || c.id === ctx.chapter) || chapters[0]).id;
  const category = ASSET_CATEGORY_IDS.includes(args.category) ? args.category : 'prop';
  let baseName = String(args.name || '').trim();
  if (!baseName) {
    try {
      const p = new URL(url).pathname;
      const b = path.basename(p, path.extname(p));
      if (b) baseName = decodeURIComponent(b).slice(0, 40);
    } catch { /* 用兜底名 */ }
  }
  const name = (baseName || '下载参考图').trim();
  const relPath = 'references/' + slugify(name) + '_' + uid().slice(0, 8) + ext;
  const abs = resolveProjectPath(ctx.projectId, relPath);
  if (!abs) throw new Error('非法保存路径');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buffer);
  const ref = ReferenceImages.create(ctx.projectId, {
    chapter_id: chapterId,
    name,
    image_path: relPath,
    mode: 'reference',
    category,
    description: String(args.description || '').trim(),
    origin: 'downloaded',
  });
  ctx.report({ phase: '下载参考图', detail: '已下载并登记参考图：' + name });
  return JSON.stringify({ reference_id: ref.id, name: ref.name, image_path: relPath, category });
}

async function hGenerateAssetFromReference(ctx, args) {
  const ref = ReferenceImages.get(args.reference_id);
  if (!ref || ref.project_id !== ctx.projectId) throw new Error('参考素材不存在');
  const category = args.category || 'other';
  const name = String(args.name || '').trim();
  if (!name) throw new Error('请提供新素材名称 name');
  // 变体（服装/年龄）必须绑角色；非变体传了 parent_id 直接拒绝（见 resolveAssetParent）
  const parentId = resolveAssetParent(ctx, category, args.parent_id);
  const refAbs = resolveProjectPath(ctx.projectId, ref.image_path);
  if (!refAbs || !fs.existsSync(refAbs)) throw new Error('参考图不存在，请先上传参考图');
  const asset = Assets.create(ctx.projectId, { category, name, description: args.description || '', parent_id: parentId });
  const fb = fallbackAssetPrompt({ type: category, name, description: args.description || '', style: ctx.project.style });
  const prompt = args.prompt || fb.prompt;
  ctx.report({ phase: '资产生成', detail: '参考图生成新素材：' + name });
  const { img, ext } = await runI2iEdit(ctx, { refs: [refAbs], prompt, namePrefix: 'assets/' + slugify(name) + '_ref_' + uid().slice(0, 8), dedupeKey: 'ref-asset:' + asset.id });
  const relDir = 'assets/' + (PROJECT_ASSET_SUBDIRS[category] || 'other') + '/';
  const relPath = relDir + slugify(name) + '_' + uid().slice(0, 8) + ext;
  await downloadOutputTo(ctx, img, relPath);
  await normalizeGeneratedImage(ctx, relPath, ctx.project.image_resolution || '1K');
  Assets.update(asset.id, { image_path: relPath, source: 'generated', prompt, prompt_used: prompt, status: 'done', error: '' });
  return JSON.stringify({ asset_id: asset.id, image_path: relPath, reference_id: ref.id });
}

async function hRegisterVoice(ctx, args) {
  const a = Assets.get(args.asset_id);
  if (!a || a.project_id !== ctx.projectId) throw new Error('资产不存在');
  // 手填/上传的参考语音同样标记「声音限制已用」，避免音色阶段重复重做
  Assets.update(args.asset_id, { voice_ref: args.voice_ref, voice_desc_used: a.voice_desc || '' });
  return '已登记参考语音';
}

async function hDesignVoice(ctx, args) {
  let asset = Assets.get(args.asset_id);
  if (!asset || asset.project_id !== ctx.projectId) throw new Error('资产不存在');
  const dedupeKey = 'voice:' + asset.id;
  if (Queue.activeByDedupe(dedupeKey)) {
    if (!(await waitForActiveRender(dedupeKey, ctx.isAborted))) throw new Error('等待其他任务完成该角色音色超时');
    asset = Assets.get(asset.id) || asset;
    let exists = false;
    try { exists = !!(asset.voice_ref && fs.existsSync(resolveProjectPath(ctx.projectId, asset.voice_ref))); } catch {}
    if (exists && (asset.voice_desc_used || '') === (asset.voice_desc || '')) {
      return JSON.stringify({ asset_id: asset.id, skipped: true, reason: '其他任务已完成该角色音色' });
    }
  }
  // 朗读文案：优先显式传入；其次从声音画像取；绝不用「外貌描述」当朗读文案（那是给文生图的）。
  // 都缺时给通用自我介绍模板，避免批量阶段念出一段外貌描写。
  const MAX_TTS_TEXT = 30;
  let text = (args.text || '').trim();
  if (!text) text = (asset.voice_desc || '').trim() || ('你好，我是' + asset.name + '。很高兴认识你。');
  if (text.length > MAX_TTS_TEXT) {
    logger.warn('音色设计朗读文案过长（' + text.length + ' 字），已截断到 ' + MAX_TTS_TEXT + ' 字：' + asset.name);
    text = text.slice(0, MAX_TTS_TEXT);
  }
  // 音色描述：显式传入（含空串=用户想清空） > 资产声音画像(voice_desc) > 从名称/描述推断性别年龄 > 中性兜底。
  // 必须让性别/年龄显式进入 voice_description——缺失时 Qwen3-TTS 自由发挥，男主会变女声。
  const hasExplicitVoiceDesc = Object.prototype.hasOwnProperty.call(args, 'voice_description');
  const rawVoiceDesc = hasExplicitVoiceDesc ? (args.voice_description || '').trim() : '';
  const voice_description = rawVoiceDesc
    || (asset.voice_desc || '').trim()
    || inferVoiceBaseline(asset.name, asset.description)
    || '自然清晰的中性嗓音，无明显性别特征';
  // 若用户显式传了空串（想清空），用默认兜底且后续把 asset.voice_desc 设为空
  const explicitEmpty = hasExplicitVoiceDesc && rawVoiceDesc === '';
  if (!rawVoiceDesc && !(asset.voice_desc || '').trim()) {
    logger.warn('音色描述使用推断兜底（资产缺 voice_desc）：' + asset.name + ' → ' + voice_description);
  }
  const spec = getSpecForKind(ctx.cfg, 'tts');
  const prefix = 'voice/' + slugify(asset.name) + '_' + uid().slice(0, 8);
  const prevRef = asset.voice_ref || asset.audio_path || '';
  ctx.report({ phase: '音色设计', detail: '设计音色：' + asset.name });
  Assets.update(asset.id, { status: 'generating' });
  try {
    const { outputs } = await runWorkflow(ctx.cfg, spec, {
      text, voice_description, seed: randomSeed(), filename_prefix: prefix,
    }, { timeoutMs: IMG_TIMEOUT(ctx.cfg), isAborted: ctx.isAborted, jobId: ctx.jobId, projectId: ctx.projectId, chapter: '', subject: asset.name || asset.id, dedupeKey: 'voice:' + asset.id, onStatus: (s) => { if (s.kind === 'error') throw new Error(s.message); } });
    const aud = pickOutput(outputs, 'audio');
    if (!aud) throw new Error('音色设计工作流未返回音频');
    const ext = path.extname(aud.filename) || '.wav';
    const relPath = 'assets/voice/' + slugify(asset.name) + '_' + uid().slice(0, 8) + ext;
    await downloadOutputTo(ctx, aud, relPath);
    // 若用户显式传了空串（想清空），把 asset.voice_desc 设为空；否则写入生成时用的 voice_description
    const savedVoiceDesc = explicitEmpty ? '' : voice_description;
    Assets.update(asset.id, { voice_ref: relPath, audio_path: relPath, source: 'generated', status: 'done', voice_desc: savedVoiceDesc, voice_desc_used: voice_description, error: '' });
    return JSON.stringify({ asset_id: asset.id, voice_ref: relPath });
  } catch (e) {
    Assets.update(asset.id, { status: prevRef ? 'done' : 'failed', error: e.message });
    throw e;
  }
}

// —— 音色克隆（Qwen3-TTS Voice Clone）共享执行体 ——
// 上传参考音色 → 跑 tts_clone 工作流 → 下载语音到 targetRelPath，返回最终相对路径。
async function synthesizeClone(ctx, { text, refAbs, filenamePrefix, targetRelPath }) {
  const refExt = path.extname(refAbs) || '.wav';
  const refName = 'ic_vc_' + ctx.projectId.slice(0, 8) + '_' + uid().slice(0, 8) + refExt;
  const refFilename = await uploadTaskInput(ctx.cfg, refAbs, refName);
  const spec = getSpecForKind(ctx.cfg, 'tts_clone');
  const { outputs } = await runWorkflow(ctx.cfg, spec, {
    text,
    ref_audio: refFilename,
    seed: randomSeed(),
    filename_prefix: filenamePrefix,
  }, {
    timeoutMs: IMG_TIMEOUT(ctx.cfg),
    isAborted: ctx.isAborted,
    jobId: ctx.jobId,
    projectId: ctx.projectId,
    chapter: '',
    subject: '音色克隆',
    onStatus: (s) => { if (s.kind === 'error') throw new Error(s.message); },
  });
  const aud = pickOutput(outputs, 'audio');
  if (!aud) throw new Error('音色克隆工作流未返回音频');
  const ext = path.extname(aud.filename) || '.wav';
  await downloadOutputTo(ctx, aud, targetRelPath + ext);
  return targetRelPath + ext;
}

// 独立「音色克隆」工具：把参考音色克隆成朗读 text 的语音，落为 voice 资产。
async function hCloneVoice(ctx, args) {
  const asset = Assets.get(args.asset_id);
  if (!asset || asset.project_id !== ctx.projectId || asset.category !== 'voice') throw new Error('语音资产不存在');
  const text = String(args.text || '').trim();
  if (!text) throw new Error('缺少说话内容 text');
  const refRel = String(args.ref_audio || asset.voice_ref || '').trim();
  if (!refRel) throw new Error('缺少参考音色 ref_audio');
  const refAbs = resolveProjectPath(args.ref_audio_project_id || ctx.projectId, refRel);
  if (!refAbs || !fs.existsSync(refAbs)) throw new Error('参考音色文件不存在：' + refRel);

  const prefix = 'assets/voice/' + slugify(asset.name) + '_' + uid().slice(0, 8);
  ctx.report({ phase: '音色克隆', detail: '克隆音色：' + asset.name });
  Assets.update(asset.id, { status: 'generating' });
  try {
    const relPath = await synthesizeClone(ctx, { text, refAbs, filenamePrefix: 'voice/' + uid().slice(0, 8), targetRelPath: prefix });
    Assets.update(asset.id, { voice_ref: relPath, audio_path: relPath, source: 'generated', status: 'done', params: { text, ref_audio: refRel, ref_audio_project_id: args.ref_audio_project_id || '' }, error: '' });
    return JSON.stringify({ asset_id: asset.id, voice_ref: relPath });
  } catch (e) {
    Assets.update(asset.id, { status: asset.voice_ref ? 'done' : 'failed', error: e.message });
    throw e;
  }
}

// 数字人两步流水线：① 语音克隆（参考音色 + 说话内容）→ 语音；② 头像 + 语音 → r2v 数字人视频。
async function hGenerateDigitalHuman(ctx, args) {
  const asset = (args && args.asset_id) ? Assets.get(args.asset_id) : null;
  if (!asset || asset.project_id !== ctx.projectId || asset.category !== 'video') throw new Error('视频资产不存在');
  const text = String(args.text || '').trim();
  if (!text) throw new Error('缺少说话内容 text');
  const prompt = String(args.prompt || asset.prompt || '').trim();
  if (!prompt) throw new Error('缺少动作描述提示词 prompt');
  const avatarRel = String(args.avatar || '').trim();
  if (!avatarRel) throw new Error('缺少人物头像 avatar');
  const refRel = String(args.ref_audio || '').trim();
  if (!refRel) throw new Error('缺少参考音色 ref_audio');

  const avatarAbs = resolveProjectPath(ctx.projectId, avatarRel);
  if (!avatarAbs || !fs.existsSync(avatarAbs)) throw new Error('人物头像不存在：' + avatarRel);
  const refAbs = resolveProjectPath(args.ref_audio_project_id || ctx.projectId, refRel);
  if (!refAbs || !fs.existsSync(refAbs)) throw new Error('参考音色不存在：' + refRel);

  const reso = String(args.resolution || '480P');
  const ratio = String(args.aspect_ratio || '16:9');
  const seconds = Number(args.seconds) > 0 ? Number(args.seconds) : 5;

  ctx.report({ phase: '数字人', detail: '① 语音克隆：' + text });
  Assets.update(asset.id, { status: 'generating', prompt });
  try {
    const speechRel = await synthesizeClone(ctx, { text, refAbs, filenamePrefix: 'voice/' + uid().slice(0, 8), targetRelPath: 'uploads/dh_speech_' + uid().slice(0, 8) });

    const avatarName = 'ic_dh_' + ctx.projectId.slice(0, 8) + '_img_' + uid().slice(0, 8) + (path.extname(avatarAbs) || '.png');
    const avatarFilename = await uploadTaskInput(ctx.cfg, avatarAbs, avatarName, 'video');
    const speechAbs = resolveProjectPath(ctx.projectId, speechRel);
    const speechName = 'ic_dh_' + ctx.projectId.slice(0, 8) + '_audio_' + uid().slice(0, 8) + (path.extname(speechAbs) || '.wav');
    const speechFilename = await uploadTaskInput(ctx.cfg, speechAbs, speechName, 'video');

    const { spec, scale, resolution: wfResolution } = getR2vSpecForResolution(ctx.cfg, reso, 'digital_human', 1);
    ctx.report({ phase: '数字人', detail: '② 生成数字人视频' });
    const wfParams = {
      positive_prompt: prompt,
      seconds,
      aspect_ratio: ratio,
      resolution: wfResolution,
      seed: randomSeed(),
      filename_prefix: 'video/' + slugify(asset.name) + '_' + uid().slice(0, 8),
      references: [{ type: 'image', filename: avatarFilename }, { type: 'audio', filename: speechFilename }],
      mode: 'digital_human',
    };
    if (scale) wfParams.scale = scale;
    const { outputs } = await runWorkflow(ctx.cfg, spec, wfParams, { jobId: ctx.jobId, timeoutMs: VID_TIMEOUT(ctx.cfg), isAborted: ctx.isAborted, onStatus: (s) => { if (s.kind === 'error') throw new Error(s.message); } });
    const vid = pickOutput(outputs, 'videos');
    if (!vid) throw new Error('数字人工作流未返回视频文件');
    const ext = path.extname(vid.filename) || '.mp4';
    const relPath = 'assets/videos/' + slugify(asset.name) + '_' + uid().slice(0, 8) + ext;
    await downloadOutputTo(ctx, vid, relPath);
    Assets.update(asset.id, { video_path: relPath, prompt_used: prompt, source: 'generated', status: 'done', params: { mode: 'digital_human_tts', text, prompt, avatar: avatarRel, ref_audio: refRel, ref_audio_project_id: args.ref_audio_project_id || '', seconds, resolution: reso, aspect_ratio: ratio } });
    return JSON.stringify({ asset_id: asset.id, name: asset.name, video_path: relPath });
  } catch (e) {
    const aborted = !!(ctx.isAborted && ctx.isAborted());
    if (aborted && asset.video_path) Assets.update(asset.id, { status: 'done' });
    else Assets.update(asset.id, { status: 'failed' });
    throw e;
  }
}

// 按工作流分批统一生成：① 文生图全部图片资产 → ② Qwen3-TTS 全部人物音色（同一工作流连续跑完再切下一类，省模型加载）
// only 缺省时图+音色一起跑（Agent 原有行为不变）；传 only 可只跑其中一类，
// 供阶段调度把「资产图」和「音色」拆到不同的 ComfyUI 实例（CK 开关要求不同）
async function hGenerateAssetsBatch(ctx, args) {
  const only = args && Array.isArray(args.only) ? args.only : null;
  // 值域与工具 schema 的 enum 一致：只有 image / tts 两类。写错（如 ['video']）时
  // 会两类都不跑，却回报一条「全部完成、0 失败」的成功结果，阶段调度据此以为已经做完了。
  if (only) {
    const bad = only.filter((k) => k !== 'image' && k !== 'tts');
    if (bad.length) throw new Error('only 只能是 image / tts（收到：' + bad.join('、') + '）');
  }
  const wantImage = !only || only.includes('image');
  const wantVoice = !only || only.includes('tts');
  const assets = Assets.list(ctx.projectId);
  const imageAssets = assets.filter((a) => IMAGE_ASSET_CATEGORIES.includes(a.category));
  const charAssets = assets.filter((a) => a.category === 'character');
  const res = { images: { total: 0, generated: 0, failed: 0 }, voices: { total: 0, generated: 0, failed: 0, skipped: 0 } };

  if (wantImage) {
    // 并发提交：真正限流的是 runWorkflow 里的渲染槽位（RunningHub 按 runninghubConcurrency，
    // 本地 ComfyUI 恒为 1），这里把整批一次性排进队列即可。
    // 跳过「已生成且提示词未变过」的资产；用户若改过 prompt（与上次生成用的 prompt_used 不同）则重新生成。
    const pending = imageAssets.filter((a) => !(a.image_path && a.status === 'done' && (a.prompt_used || '') === (a.prompt || '')));
    ctx.report({ phase: '资产生成', detail: '第1批·文生图：' + pending.length + ' 个图片资产（并发 ' + renderConcurrencyLimit(ctx.cfg) + '）' });
    await Promise.all(pending.map(async (a) => {
      if (ctx.isAborted && ctx.isAborted()) return;
      res.images.total++;
      try { await hGenerateAssetImage(ctx, { asset_id: a.id }); res.images.generated++; }
      catch (e) {
        if (ctx.isAborted && ctx.isAborted()) return;
        res.images.failed++; Assets.update(a.id, { status: 'failed', error: e.message }); ctx.report({ phase: '资产生成', detail: '图片失败 ' + a.name + '：' + e.message });
      }
    }));
    if (ctx.isAborted && ctx.isAborted()) return JSON.stringify({ ...res, aborted: true });
  }

  if (wantVoice) {
    // 音色同样按渲染槽位并发；跳过逻辑与串行版本一致。
    ctx.report({ phase: '音色设计', detail: '第2批·音色设计：' + charAssets.length + ' 个角色音色（并发 ' + renderConcurrencyLimit(ctx.cfg) + '）' });
    await Promise.all(charAssets.map(async (a) => {
      if (ctx.isAborted && ctx.isAborted()) return;
      // 跳过「已有音色且声音限制未变过」的角色；用户改过 voice_desc（与上次用的 voice_desc_used 不同）则重做
      if (a.voice_ref && fs.existsSync(resolveProjectPath(ctx.projectId, a.voice_ref)) && (a.voice_desc_used || '') === (a.voice_desc || '')) return;
      // 无声音画像且无法从名称/描述推断性别年龄 → 跳过并提示，不静默出性别错乱的音色
      const base = inferVoiceBaseline(a.name, a.description);
      if (!(a.voice_desc || '').trim() && !base) {
        res.voices.skipped++;
        ctx.report({ phase: '音色设计', detail: '跳过 ' + a.name + '：资产无声音特征描述（voice_desc），无法推断性别/年龄。请先在 LLM 阶段调用 create_asset/update_asset 补充 voice_desc 或用 design_voice 为其设计音色。' });
        return;
      }
      res.voices.total++;
      try { await hDesignVoice(ctx, { asset_id: a.id }); res.voices.generated++; }
      catch (e) {
        if (ctx.isAborted && ctx.isAborted()) return;
        res.voices.failed++; Assets.update(a.id, { status: 'failed', error: e.message }); ctx.report({ phase: '音色设计', detail: '音色失败 ' + a.name + '：' + e.message });
      }
    }));
    if (ctx.isAborted && ctx.isAborted()) return JSON.stringify({ ...res, aborted: true });
  }

  return JSON.stringify(res);
}

// —— 换装事件自动识别与服装资产生成（确定性兜底，不依赖 LLM 记忆） ——
// 剧情里的「沐浴/洗澡/更衣/换衣/换装」意味着角色着装状态发生变化（洗澡后理应换干净衣服）。
// 系统据此自动为对应角色生成一套服装资产（change_outfit，图生图保持脸/发型/画风一致），
// 并自动绑定到「换装事件之后」的镜头；事件之前的镜头继续用角色原图或旧服装。
// 「沐浴」单独出现不算换装（「沐浴在晨光里」「沐浴露」都是普通描写），但「在屋后沐浴」是动作本身。
const OUTFIT_BATH_RE = /沐浴(?!在|露)|出浴|洗完澡|洗澡|浴桶/;
const OUTFIT_CHANGE_RE = /更衣|换衣|换装|换衣服|换了衣服|换上一身|换了一身|换上一套|换了一套|换上新衣|换上新裳|换上新衣裳/;

function detectOutfitChange(text) {
  if (!text) return null;
  const m = String(text).match(OUTFIT_BATH_RE);
  if (m) return { kind: 'bath', keyword: m[0] };
  const c = String(text).match(OUTFIT_CHANGE_RE);
  if (c) return { kind: 'change', keyword: c[0] };
  return null;
}

function inferOutfitDescription(text, kind, keyword) {
  if (kind === 'bath') return '沐浴后换上的干净衣裳';
  if (kind === 'change') {
    const t = String(text);
    const i = t.indexOf(keyword);
    if (i >= 0) {
      let seg = t.slice(i + keyword.length, i + keyword.length + 16);
      seg = seg.replace(/^[的了过，。；：!！?？]+/, '').trim();
      const cut = seg.search(/[，。；：!！?？]/);
      if (cut >= 0) seg = seg.slice(0, cut);
      if (seg.trim()) return seg.trim();
    }
    return '新换的衣裳';
  }
  return '新换的衣裳';
}


// 扫描本次写入分镜所属章节的换装事件，自动生成服装资产并绑定到事件之后的镜头。
// 幂等：同名服装已存在则复用（change_outfit 内部去重）；生成失败不阻塞分镜写入（该镜继续用角色原图兜底）。
async function autoResolveOutfits(ctx, chapters) {
  const chapterSet = new Set((chapters || []).filter(Boolean).map(String));
  if (!chapterSet.size) return { generated: 0, bound: 0, notes: [] };
  const shots = Shots.list(ctx.projectId)
    .filter((s) => chapterSet.has(String(s.chapter || '')))
    .sort((a, b) => String(a.chapter || '').localeCompare(String(b.chapter || ''), 'zh') || (a.idx - b.idx));
  if (!shots.length) return { generated: 0, bound: 0, notes: [] };

  // 本阶段禁止渲染（LLM 创作阶段）时只检测、不生成：兜底要图生图出图，而那个阶段的硬约束是不碰
  // ComfyUI（见 runTool 对 RENDER_TOOLS 的拦截、agent-loop 系统提示「这些工具只会返回已跳过」）。
  // 原先 set_storyboard 直接调 hChangeOutfit，绕过了这层拦截：LLM 阶段照跑一次渲染，ComfyUI 没启动
  // 时会白等一次超时。生成改由「资产图」阶段执行（stages.js RENDER_STAGE_TOOLS.image →
  // resolveShotProvisions），那里才有 ComfyUI。这里把待兜底镜头数回报出去，免得静默消失。
  if (ctx.renderDisabled) {
    const pending = shots.filter((s) => detectOutfitChange([s.scene_name, s.visual, s.dialogue, s.sub_shots].filter(Boolean).join(' '))).length;
    return { generated: 0, bound: 0, notes: [], deferred: pending };
  }

  const assets = Assets.list(ctx.projectId);
  const byId = {};
  const charById = {};
  for (const a of assets) { byId[a.id] = a; if (a.category === 'character') charById[a.id] = a; }

  const currentCostume = {};   // charId -> costumeId（本章内当前着装）
  let prevChapter = null;
  let generated = 0, bound = 0;
  const notes = [];
  const textOf = (s) => [s.scene_name, s.visual, s.dialogue, s.sub_shots].filter(Boolean).join(' ');

  for (const s of shots) {
    // 用户已停止：不再往下识别/生成换装变体。每个事件都会真的提交一次图生图，
    // 停止之后继续跑等于白烧 GPU（已提交的项目会排在 ComfyUI 队列里被挨个执行）。
    if (ctx.isAborted && ctx.isAborted()) break;
    // 章节边界：重置「当前着装」状态（换装跟随剧情在同一章内连续）
    if (prevChapter !== null && s.chapter !== prevChapter) { for (const k of Object.keys(currentCostume)) delete currentCostume[k]; }
    prevChapter = s.chapter;

    const charIds = (s.character_ids || []).filter((id) => charById[id]);
    const charNames = charIds.map((id) => charById[id] && charById[id].name).filter(Boolean);
    const text = textOf(s);
    const costumeIds = new Set(s.costume_ids || []);

    // 已显式引用服装的角色（LLM 在 costumes 字段里绑定了服装资产）跳过自动兜底，避免重复生成。
    // 判定必须只看「库里已有的绑定」，即必须在并入 currentCostume 之前算：
    // currentCostume 是本函数刚刚自动生成/绑定出来的结果，把它一起算进去的话，同一章里
    // 第二次换装事件会被当成「已显式引用」直接 continue —— 服装只换一次，之后永不更新。
    const charHasCostume = {};
    for (const costumeId of costumeIds) { const a = byId[costumeId]; if (a && a.parent_id) charHasCostume[a.parent_id] = true; }

    // 1) 再应用当前着装到本镜（若此前已发生换装）
    for (const cid of charIds) if (currentCostume[cid]) costumeIds.add(currentCostume[cid]);

    // 2) 检测本镜是否发生换装事件，归属到具体角色并生成服装资产（自下一镜起生效）
    const evt = detectOutfitChange(text);
    if (evt) {
      for (const cid of charIds) {
        if (charHasCostume[cid]) continue;
        const char = charById[cid];
        // 归属判定用 textMentions：文本里「小明」提到的是「小明」，不是同场的短名「明」
        //（旧写法 text.includes(char.name) 会给「明」也错生成一套服装，并写进本镜 costume_ids）
        const named = charIds.length === 1 || textMentions(text, char.name, charNames);
        if (!named) continue;
        const outfit = inferOutfitDescription(text, evt.kind, evt.keyword);
        try {
          const r = await hChangeOutfit(ctx, { character_id: cid, outfit });
          const info = JSON.parse(r);
          currentCostume[cid] = info.costume_id;
          generated++;
          notes.push('自动换装：' + char.name + ' → ' + outfit);
        } catch (e) {
          logger.warn('自动换装失败：' + char.name + '（' + outfit + '）', { error: e.message });
          notes.push('自动换装失败：' + char.name + '（' + e.message + '）');
        }
      }
    }

    // 3) 写回本镜 costume_ids（含新生成/复用的服装）
    const existing = [...(s.costume_ids || [])].sort();
    const next = [...costumeIds].sort();
    if (JSON.stringify(existing) !== JSON.stringify(next)) {
      Shots.update(s.id, { costume_ids: next });
      bound++;
    }
  }
  return { generated, bound, notes };
}

// —— 年龄变化事件自动识别与年龄变体资产生成（确定性兜底，不依赖 LLM 记忆） ——
// 剧情里的「回忆/年轻时/N年前/多年后/步入中年/步入老年」意味着角色年龄状态发生变化。
// 系统据此以角色 canonical 图为参考自动生成年龄变体（change_age，图生图保持身份一致、只改年龄），
// 并绑定到「时间跳跃之后」的镜头；事件之前的镜头继续用角色原图（或旧年龄变体）。
// 只认「明确的时间跳跃/时期切换」，不认「年轻/少年/白发」这类外貌描写：
// 它们经常只是普通形容词（「年轻女子」「少年感」「白发苍苍的老者」是角色设定而非时间跳跃），
// 拿它们当触发词会把同一章所有角色都生成一遍年龄变体，产出大量用不上的素材。
const AGE_OLD_RE = /老年时|步入老年|年迈|变老了?|老了|苍老/;
const AGE_MID_RE = /中年时|步入中年|人到中年/;
const AGE_YOUNG_RE = /小时候|童年时|幼年时|年轻时|少年时|少女时代|学生时代|闪回|时间回到|\d+\s*年前|多年前|当年/;
const AGE_OLDER_RE = /长大后|成年后|多年后|数年后|\d+\s*年后/;

function detectAgeChange(text) {
  if (!text) return null;
  const t = String(text);
  let m = t.match(AGE_OLD_RE); if (m) return { keyword: m[0], variant: { label: '老年', age: '老年时的样貌' } };
  m = t.match(AGE_MID_RE); if (m) return { keyword: m[0], variant: { label: '中年', age: '中年时的样貌' } };
  m = t.match(AGE_YOUNG_RE); if (m) return { keyword: m[0], variant: { label: '年轻', age: '年轻时的样貌' } };
  m = t.match(AGE_OLDER_RE); if (m) return { keyword: m[0], variant: { label: '更年长', age: '更年长时的样貌' } };
  return null;
}

// 扫描本次写入分镜所属章节的年龄变化事件，自动生成年龄变体并绑定到事件之后的镜头。
// 幂等：同名年龄变体已存在则复用（change_age 内部去重）；生成失败不阻塞分镜写入（该镜继续用角色原图兜底）。
async function autoResolveAges(ctx, chapters) {
  const chapterSet = new Set((chapters || []).filter(Boolean).map(String));
  if (!chapterSet.size) return { generated: 0, bound: 0, notes: [] };
  const shots = Shots.list(ctx.projectId)
    .filter((s) => chapterSet.has(String(s.chapter || '')))
    .sort((a, b) => String(a.chapter || '').localeCompare(String(b.chapter || ''), 'zh') || (a.idx - b.idx));
  if (!shots.length) return { generated: 0, bound: 0, notes: [] };

  // 同 autoResolveOutfits：LLM 阶段（renderDisabled）只检测不生成，生成推迟到「资产图」阶段。
  if (ctx.renderDisabled) {
    const pending = shots.filter((s) => detectAgeChange([s.scene_name, s.visual, s.dialogue, s.sub_shots].filter(Boolean).join(' '))).length;
    return { generated: 0, bound: 0, notes: [], deferred: pending };
  }

  const assets = Assets.list(ctx.projectId);
  const byId = {};
  const charById = {};
  for (const a of assets) { byId[a.id] = a; if (a.category === 'character') charById[a.id] = a; }

  const currentAge = {};   // charId -> ageId（本章内当前年龄）
  let prevChapter = null;
  let generated = 0, bound = 0;
  const notes = [];
  const textOf = (s) => [s.scene_name, s.visual, s.dialogue, s.sub_shots].filter(Boolean).join(' ');

  for (const s of shots) {
    // 同 autoResolveOutfits：停止后不再继续生成年龄变体（每次都会真提交一次图生图）
    if (ctx.isAborted && ctx.isAborted()) break;
    if (prevChapter !== null && s.chapter !== prevChapter) { for (const k of Object.keys(currentAge)) delete currentAge[k]; }
    prevChapter = s.chapter;

    const charIds = (s.character_ids || []).filter((id) => charById[id]);
    const charNames = charIds.map((id) => charById[id] && charById[id].name).filter(Boolean);
    const text = textOf(s);
    const ageIds = new Set(s.age_ids || []);

    // 已显式引用年龄变体的角色（LLM 在 ages 字段里绑定）跳过自动兜底，避免重复生成。
    // 与服装同理：必须在并入 currentAge 之前判定，否则同一章内第二次时间跳跃会被跳过。
    const charHasAge = {};
    for (const ageId of ageIds) { const a = byId[ageId]; if (a && a.parent_id) charHasAge[a.parent_id] = true; }

    // 1) 再应用当前年龄到本镜（若此前已发生时间跳跃）
    for (const cid of charIds) if (currentAge[cid]) ageIds.add(currentAge[cid]);

    // 2) 检测本镜是否发生年龄变化事件，归属到具体角色并生成年龄变体（自下一镜起生效）
    const evt = detectAgeChange(text);
    if (evt) {
      for (const cid of charIds) {
        if (charHasAge[cid]) continue;
        const char = charById[cid];
        // 同 autoResolveOutfits：年龄变体只归属「文本真正提到」的角色（短名不被同场更长名吞掉）
        const named = charIds.length === 1 || textMentions(text, char.name, charNames);
        if (!named) continue;
        try {
          const r = await hChangeAge(ctx, { character_id: cid, age: evt.variant.age, label: evt.variant.label });
          const info = JSON.parse(r);
          currentAge[cid] = info.age_id;
          generated++;
          notes.push('自动年龄变体：' + char.name + ' → ' + evt.variant.age);
        } catch (e) {
          logger.warn('自动年龄变体失败：' + char.name + '（' + evt.variant.age + '）', { error: e.message });
          notes.push('自动年龄变体失败：' + char.name + '（' + e.message + '）');
        }
      }
    }

    // 3) 写回本镜 age_ids（含新生成/复用的年龄变体）
    const existing = [...(s.age_ids || [])].sort();
    const next = [...ageIds].sort();
    if (JSON.stringify(existing) !== JSON.stringify(next)) {
      Shots.update(s.id, { age_ids: next });
      bound++;
    }
  }
  return { generated, bound, notes };
}

// set_storyboard 每个分镜只认这些字段，与工具 schema 的 items.properties 一一对应。
// 拼错/传错（visual 写成 sence_name 之外的名字、characters 写成 cast 等）原先会被静默丢弃：
// 分镜照建、内容为空，回报却是「分镜已写入」——模型以为写好了，出片时才发现没有画面/角色。
// 与外部写入 API（shot-write.js 对未声明字段直接 400）同口径：宁可当场报错让模型自纠。
const SHOT_INPUT_KEYS = new Set(['idx', 'chapter', 'scene_name', 'duration', 'characters', 'scenes', 'props', 'costumes', 'ages', 'audios', 'sub_shots', 'dialogue', 'narration', 'camera', 'visual', 'blocking', 'mode']);

// 分镜时长的唯一入口。非数字（模型爱写 "8秒"、"约 10 秒"）必须当场拒绝：静默写成 NaN 会让这条
// 分镜**永远出不了片** —— validateSubShots 里 parseFloat(NaN) || 0 = 0，任何子分镜都判「超过总时长」，
// 重试多少次都一样，而错误信息里只有「超过」两个字，看不出根因在时长上。
// 数字越界仍按原行为夹到 [SHOT_DURATION_MIN, SHOT_DURATION_MAX]。
const durationOf = (sb, videoModel) => {
  const raw = sb.duration;
  if (raw == null || raw === '') return SHOT_DURATION_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error('分镜 duration 必须是数字（秒），当前：' + JSON.stringify(raw));
  // 上限按视频模型：h3 / seedance20 = 15s，seedance25 = 30s（见 shot-write.js DURATION_PROFILES）
  return Math.min(shotDurationMax(videoModel), Math.max(SHOT_DURATION_MIN, n));
};

// ===== 分镜锁档：G0 六项锁 + 情绪节拍曲线 + 拆段表 =====
// 依据 forest-laoli-h3 老李全流程：
//   pipeline.md §一 G0 六项锁（A 模式 / B 画幅 / C 时长档 / D 画风基底 / E 资产形态 / F 段缝）
//   pipeline.md §五 标准产出顺序第 4–5 步：情绪节拍曲线（强度 1–10 + 持续镜数）→ 拆段表（段号/时长/功能/段缝）
//   pipeline.md §四 拆段实操：一个节拍 = 一次情绪变化或一次信息揭示；一段内不许塞两个反转
// 旧流水线直接 set_storyboard 一次性写镜行，跳过锁与节拍——运镜/留白/段缝全凭感觉，这是"分镜不像老李写的"根因。
// 落盘 data/projects/<id>/context/storyboard-plan.json，结构 { [chapter]: plan }。
const PLAN_MODES = new Set(['T2VA', 'I2VA', 'L2VA', 'FL2VA', 'Ref2VA']);
const PLAN_ASPECTS = new Set(['9:16', '16:9']);
const PLAN_BASES = new Set(['BASE_LIVE', 'BASE_ANIME', 'BASE_2D', 'BASE_INK']);
const PLAN_ASSET_MODES = new Set(['M1', 'M2']);
const PLAN_SEAMS = new Set(['tail_frame', 'hard_cut', 'empty_shot']);
const PLAN_BEAT_FNS = new Set(['钩子', '递进', '反转', '收束']);
// 锁档段长区间**按视频模型取值**：h3 / 2.0 = 4–15，seedance25 = 4–30（默认 25–30 吃满上限）。
// 原先写死 4–15 是照 H3 口径，2.5 线的拆段表根本排不出 25–30s 的段——实测 77 镜全落在 5–11s，
// 每镜都触机检 C1b「段时长 <12s」告警。
const planDurationRange = (videoModel) => {
  const prof = durationProfile(videoModel);
  return { min: prof.planMin, max: prof.planMax };
};

function storyboardPlanFile(projectId) {
  return path.join(projectDir(projectId), 'context', 'storyboard-plan.json');
}
// 已读 reference 记录落盘（第二层保险）：ctx.loadedRefs 在内存，若工具运行时被重建 / MCP 进程重启就会丢，
// 门禁会误判「读完还缺」。按 jobId 分组，避免上一个 job 的记录让这个 job 蒙过门禁。
function loadedRefsFile(projectId) {
  return path.join(projectDir(projectId), 'context', 'loaded-refs.json');
}
function loadLoadedRefsFromDisk(projectId, jobId) {
  if (!jobId) return new Set();
  try {
    const all = JSON.parse(fs.readFileSync(loadedRefsFile(projectId), 'utf8'));
    const rec = all && all[jobId];
    return new Set(Array.isArray(rec) ? rec : []);
  } catch { return new Set(); }
}
function addLoadedRefToDisk(projectId, jobId, key) {
  if (!jobId) return;
  try {
    const dir = path.join(projectDir(projectId), 'context');
    fs.mkdirSync(dir, { recursive: true });
    const f = loadedRefsFile(projectId);
    let all = {};
    try { const raw = JSON.parse(fs.readFileSync(f, 'utf8')); if (raw && typeof raw === 'object' && !Array.isArray(raw)) all = raw; } catch {}
    const set = new Set(Array.isArray(all[jobId]) ? all[jobId] : []);
    set.add(key);
    all[jobId] = [...set];
    fs.writeFileSync(f, JSON.stringify(all, null, 2));
  } catch { /* 落盘失败不影响内存记录 */ }
}
function loadStoryboardPlan(projectId, chapter) {
  try {
    const all = JSON.parse(fs.readFileSync(storyboardPlanFile(projectId), 'utf8'));
    return all && typeof all === 'object' ? (all[chapter] || null) : null;
  } catch { return null; }
}
function saveStoryboardPlan(projectId, chapter, plan) {
  const dir = path.join(projectDir(projectId), 'context');
  fs.mkdirSync(dir, { recursive: true });
  const f = storyboardPlanFile(projectId);
  let all = {};
  try { const raw = JSON.parse(fs.readFileSync(f, 'utf8')); if (raw && typeof raw === 'object' && !Array.isArray(raw)) all = raw; } catch {}
  all[chapter] = { ...plan, chapter, updatedAt: Date.now() };
  fs.writeFileSync(f, JSON.stringify(all, null, 2));
  return true;
}
// "1-3" / "4" / "5~7" → { from, to }
function parseShotRange(raw) {
  const m = String(raw == null ? '' : raw).match(/^\s*(\d+)\s*(?:[-–~至到]\s*(\d+))?\s*$/);
  if (!m) return null;
  const from = Number(m[1]);
  const to = m[2] == null ? from : Number(m[2]);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to < from) return null;
  return { from, to };
}

// G0 六项锁 + 节拍/拆段表校验。返回错误数组（空数组=通过）。
function validateStoryboardPlan(plan, videoModel) {
  if (!plan || typeof plan !== 'object') return ['锁档为空'];
  const errs = [];
  if (!PLAN_MODES.has(plan.mode)) errs.push('A 模式锁 mode 必须是 T2VA/I2VA/L2VA/FL2VA/Ref2VA 之一（短剧默认 Ref2VA），当前「' + plan.mode + '」');
  if (!PLAN_ASPECTS.has(plan.aspect)) errs.push('B 画幅锁 aspect 必须是 9:16 或 16:9（禁 auto/adaptive），当前「' + plan.aspect + '」');
  if (!PLAN_BASES.has(plan.base)) errs.push('D 画风基底锁 base 必须是 BASE_LIVE/BASE_ANIME/BASE_2D/BASE_INK 之一，当前「' + plan.base + '」');
  if (!PLAN_ASSET_MODES.has(plan.assetMode)) errs.push('E 资产形态锁 assetMode 必须是 M1（文字档）或 M2（已出图），当前「' + plan.assetMode + '」');
  if (!PLAN_SEAMS.has(plan.seam)) errs.push('F 段缝锁 seam 必须是 tail_frame（尾帧锚定）/hard_cut（换机位硬切）/empty_shot（空镜过渡），当前「' + plan.seam + '」');
  const anchors = plan.anchors;
  if (!anchors || typeof anchors !== 'object') {
    errs.push('A6 空间锚点卡缺失（anchors：furniture 家具清单 / positions 站位表 / directions 方位词 / doors 门窗初始开闭态）');
  } else if (!Array.isArray(anchors.positions) || !anchors.positions.length) {
    errs.push('A6 空间锚点卡缺 positions（每人在本段的位置与朝向，至少一条）');
  }
  const beats = Array.isArray(plan.beats) ? plan.beats : [];
  if (!beats.length) {
    errs.push('情绪节拍/拆段表 beats 为空（每段必须有 emotion + intensity 1–10 + durationSec + shotRange + beatFunction）');
    return errs;
  }
  let cursor = 1;
  beats.forEach((b, i) => {
    const tag = '第' + (i + 1) + '段（' + (b && b.id ? b.id : '未命名') + '）';
    if (!b || typeof b !== 'object') { errs.push(tag + ' 不是对象'); return; }
    const dur = Number(b.durationSec);
    const pr = planDurationRange(videoModel);
    if (!Number.isFinite(dur) || dur < pr.min || dur > pr.max) {
      errs.push(tag + ' durationSec 必须是 ' + pr.min + '–' + pr.max + ' 的整数秒（当前「' + b.durationSec + '」；' + durationHint(videoModel) + '）');
    }
    const inten = Number(b.intensity);
    if (!Number.isFinite(inten) || inten < 1 || inten > 10) errs.push(tag + ' intensity 必须是 1–10，当前「' + b.intensity + '」');
    if (!String(b.emotion || '').trim()) errs.push(tag + ' 缺 emotion（这一段情绪是什么）');
    if (!String(b.type || '').trim()) errs.push(tag + ' 缺 type（情绪类型：紧张上升/爆发/留白/凝固）');
    if (!PLAN_BEAT_FNS.has(b.beatFunction)) errs.push(tag + ' beatFunction 必须是 钩子/递进/反转/收束 之一，当前「' + b.beatFunction + '」');
    const range = parseShotRange(b.shotRange);
    if (!range) {
      errs.push(tag + ' shotRange 格式错误（应形如 "1-3"），当前「' + b.shotRange + '」');
    } else if (range.from !== cursor) {
      errs.push(tag + ' shotRange 必须从第 ' + cursor + ' 镜接续（不许有空洞或重叠），当前「' + b.shotRange + '」');
      cursor = range.to + 1;
    } else {
      cursor = range.to + 1;
    }
  });
  return errs;
}

// 分镜结构机检（老李 gates.md P0-1/P0-12/P0-14/P1-1/P1-2 + pipeline.md §一 F 段缝规则）。
// 只做「分镜表层面可机器判定」的项；物理四件套/表演/词根这些属提示词层，交给 h3_lint。
function lintStoryboardShots(shots, chapterTitles, planOf, videoModel) {
  const errs = [];
  // ① 时长档 + 首镜/每镜有具名主体（P0-1 / P0-14 / P0-12）
  shots.forEach((sb) => {
    const raw = Number(sb.duration);
    const pr = planDurationRange(videoModel);
    if (Number.isFinite(raw) && (raw < pr.min || raw > pr.max)) {
      errs.push('镜 ' + sb.idx + ' 时长 ' + raw + 's 越界：单段必须 ' + pr.min + '–' + pr.max + ' 秒（' + durationHint(videoModel) + '）');
    }
    if (!Array.isArray(sb.characters) || !sb.characters.length) {
      errs.push('镜 ' + sb.idx + ' 没有 characters：首镜必须有具名主体、每镜都要写清在场人物（P0-14 / P0-12）');
    }
  });
  // ② 按章分组、按 idx 排序，查相邻镜与节拍归属
  const groups = new Map();
  shots.forEach((sb, i) => {
    const ch = chapterTitles[i];
    if (!groups.has(ch)) groups.set(ch, []);
    groups.get(ch).push(sb);
  });
  for (const [ch, list] of groups) {
    list.sort((a, b) => Number(a.idx) - Number(b.idx));
    // ③ 相邻两镜「同景别 + 同机位」——camera 归一化后完全相同（P1-2，保守判定，不误伤只换焦段的写法）
    for (let i = 1; i < list.length; i++) {
      const a = String(list[i - 1].camera || '').replace(/\s+/g, '').toLowerCase();
      const b = String(list[i].camera || '').replace(/\s+/g, '').toLowerCase();
      if (a && a === b) {
        errs.push('镜 ' + list[i - 1].idx + '→' + list[i].idx + ' 机位写法完全相同（' + list[i].camera + '）：连续两镜同景别+同机位会让模型原地闪现两人（' + String(videoModel || 'h3') + ' 线同样适用），必须换景别档或换角度 ≥30°（P1-2）');
      }
    }
    // ④ 每镜必须归属某个节拍（plan.beats 的 shotRange 覆盖）
    const plan = planOf(ch);
    const maxIdx = Math.max(...list.map((s) => Number(s.idx) || 0));
    if (plan && Array.isArray(plan.beats) && plan.beats.length) {
      const covered = new Set();
      plan.beats.forEach((b) => {
        const r = parseShotRange(b && b.shotRange);
        if (r) for (let k = r.from; k <= r.to; k++) covered.add(k);
      });
      const orphans = list.map((s) => Number(s.idx)).filter((k) => Number.isFinite(k) && k >= 1 && k <= maxIdx && !covered.has(k));
      if (orphans.length) {
        errs.push('镜 ' + orphans.join('、') + ' 不属于任何节拍：锁档 beats 的 shotRange 必须连续覆盖 1–' + maxIdx + '，每镜都要有归属（pipeline.md §五）');
      }
    }
    // ⑤ 镜数/时长密度（P1-1）。老李原始锚点是 4s→1–2、8s→2–4、12s→3–5、15s→4–6，本质「每镜 2.5–4s」；
    // 但 2.5 的 25–30s 段是「少切段、多留长镜」，段内镜头可以到 6–8s（真实分镜表实测 4–6s/镜）。
    // 旧实现按「每秒 0.375 镜」线性外推到 30s，逼出 10–12 镜 = 每 2.5s 一切，把长镜全拆碎
    // （实测：把真实表 5 个 4–6s 镜头合并成 1 个 30s 段，被判「应写 10–12 个」直接拒写）。
    // 改为区间口径「每镜 2.5–7.5 秒」：lo=ceil(dur/7.5)、hi=floor(dur/2.5)+1，两端都不误伤。
    const densityErr = [];
    list.forEach((sb) => {
      const dur = Number(sb.duration);
      const lines = String(sb.sub_shots || '').split(/\n+/).filter((x) => x.trim()).length;
      if (!Number.isFinite(dur) || !lines) return;
      const lo = Math.max(1, Math.ceil(dur / 7.5));
      const hi = Math.max(lo, Math.floor(dur / 2.5) + 1);
      if (lines < lo || lines > hi) densityErr.push('镜 ' + sb.idx + '（' + dur + 's）写了 ' + lines + ' 个镜头，合理区间 ' + lo + '–' + hi + '（P1-1：每镜 2.5–7.5 秒）');
    });
    if (densityErr.length) errs.push(...densityErr);
  }
  return errs;
}

// 写入分镜锁档（G0 六项锁 + 情绪节拍曲线 + 拆段表）。set_storyboard 的硬前置。
async function hSetStoryboardPlan(ctx, args) {
  const chapterMap = new Map();
  for (const c of Chapters.list(ctx.projectId)) { chapterMap.set(c.title, c.title); chapterMap.set(c.id, c.title); }
  const want = String(args.chapter == null ? '' : args.chapter).trim() || String(ctx.chapter || '').trim();
  if (!want) throw new Error('锁档缺少 chapter：请传章节标题或 id（可用 list_chapters 查看本项目章节）');
  const title = chapterMap.get(want);
  if (title === undefined) {
    throw new Error('章节不存在：' + want + '（本项目现有章节：' + [...new Set(chapterMap.values())].join('、') + '）');
  }
  const strArr = (v) => (Array.isArray(v) ? v.map((x) => String(x)).filter((x) => x.trim()) : []);
  const anchors = args.anchors && typeof args.anchors === 'object'
    ? {
      furniture: strArr(args.anchors.furniture),
      positions: strArr(args.anchors.positions),
      directions: strArr(args.anchors.directions),
      doors: String(args.anchors.doors || ''),
    }
    : null;
  const beats = Array.isArray(args.beats)
    ? args.beats.map((b) => ({
      id: String(b && b.id ? b.id : ''),
      emotion: String(b && b.emotion ? b.emotion : ''),
      type: String(b && b.type ? b.type : ''),
      intensity: Number(b && b.intensity),
      durationSec: Number(b && b.durationSec),
      shotRange: String(b && b.shotRange ? b.shotRange : ''),
      beatFunction: String(b && b.beatFunction ? b.beatFunction : ''),
      seam: String(b && b.seam ? b.seam : ''),
    }))
    : [];
  const plan = {
    mode: String(args.mode || '').trim(),
    aspect: String(args.aspect || '').trim(),
    base: String(args.base || '').trim(),
    assetMode: String(args.assetMode || '').trim(),
    seam: String(args.seam || '').trim(),
    anchors,
    beats,
  };
  const errs = validateStoryboardPlan(plan, ctx.project?.video_model);
  if (errs.length) {
    throw new Error('【锁档校验不通过 · 未落盘】按 forest-laoli-h3 pipeline.md §一/§四/§五 逐条改正后重试：\n- ' + errs.join('\n- '));
  }
  saveStoryboardPlan(ctx.projectId, title, plan);
  const lastRange = parseShotRange(beats[beats.length - 1].shotRange);
  const totalDur = beats.reduce((s, b) => s + (Number.isFinite(b.durationSec) ? b.durationSec : 0), 0);
  return '锁档已写入章节「' + title + '」：'
    + plan.mode + ' ｜ ' + plan.aspect + ' ｜ ' + plan.base + ' ｜ ' + plan.assetMode + ' ｜ ' + plan.seam
    + '；' + beats.length + ' 段节拍，总时长 ' + totalDur + 's'
    + (lastRange ? '，覆盖镜 1–' + lastRange.to + '（分镜 idx 必须落在此范围）' : '')
    + '。下一步：按节拍写逐段镜行，再调 set_storyboard（结构机检会核对时长/机位/节拍归属/镜数密度）。';
}

async function hSetStoryboard(ctx, args) {
  // 字段白名单先于一切：不认的字段一律拒绝，避免「悄悄丢掉内容却回报成功」
  const unknownShotKeys = [];
  const badShots = [];
  (args.shots || []).forEach((sb, i) => {
    // 不是对象的元素必须当场拒绝：后面几轮校验直接按字段取值，遇到 null 会抛 TypeError
    // （"Cannot read properties of null"），模型看不出自己错在哪一条。
    if (!sb || typeof sb !== 'object' || Array.isArray(sb)) { badShots.push('第' + (i + 1) + '条'); return; }
    for (const k of Object.keys(sb)) if (!SHOT_INPUT_KEYS.has(k)) unknownShotKeys.push('第' + (i + 1) + '条.' + k);
  });
  if (badShots.length) {
    throw new Error('分镜必须是对象（每条含 chapter/idx/visual 等字段）：' + badShots.join('、') + ' 不是对象');
  }
  if (unknownShotKeys.length) {
    throw new Error('分镜含未声明字段：' + [...new Set(unknownShotKeys)].join('、') + '。每条分镜只支持：' + [...SHOT_INPUT_KEYS].join('、'));
  }
  // 【分镜必读规则门禁】分镜是「一次写死结构」的阶段——站位/依托物/台词速率/同框人数一旦写错，
  // 提示词阶段救不回来（提示词只能照着写）。但旧版只靠 system 软提示"至少加载这几个 reference"，
  // 实测模型只加载 1 个（short-drama-camera-system.md）就往下写，导致依托物丢、换手、超时口、
  // 四人同框等缺陷全部入库。这里做成硬门禁：按 video_model 要求的必读 reference 没加载 → 拒绝写入。
  // ctx.loadedRefs 由 skill_reference 工具写入，MCP 进程内单例可跨调用累积。
  {
    const vm = String(ctx.project?.video_model || 'h3');
    const isSD = vm.startsWith('seedance');
    // 分镜权威按视频模型走全流程技能本身：H3 → forest-laoli-h3；Seedance → short-drama-director（老李总控）。
    const skillName = isSD ? 'short-drama-director' : 'forest-laoli-h3';
    // 必读项 = 全流程技能里「管分镜结构」的权威文件（各地管一类分镜缺陷，缺一个就会漏一类）。
    // H3 线取 forest-laoli-h3 原包的 pipeline/camera-four-axis/h3-shot-grammar/spatial-anchor/dialogue-density/checklist/constraints；
    // SD 线取老李总控的 camera-specs-15rules/blocking-direction/spatial-reference-system/segment-splicing/dialogue-speed-check/camera-transitions。
    const requiredRefs = isSD
      ? ['camera-specs-15rules.md', 'blocking-direction.md', 'spatial-reference-system-V3.md', 'segment-splicing.md', 'dialogue-speed-check.md', 'camera-transitions-6types.md']
      : ['00-framework-adapter.md', 'pipeline.md', 'camera-four-axis-h3.md', 'h3-shot-grammar.md', 'spatial-anchor-and-hold.md', 'dialogue-density.md', 'checklist.md', 'h3-constraints-qc.md'];
    const loaded = ctx.loadedRefs || new Set();
    const loadedDisk = loadLoadedRefsFromDisk(ctx.projectId, ctx.jobId);
    const missing = requiredRefs.filter((r) => !loaded.has(skillName + '/' + r) && !loadedDisk.has(skillName + '/' + r));
    if (missing.length) {
      throw new Error(
        '【分镜规则未加载 · 拒绝写入】拆分镜前必须先加载 ' + skillName + ' 的必读 reference，当前缺 ' + missing.length + ' 个：'
        + missing.join('、')
        + '。请先调用 skill_reference(name="' + skillName + '", ref="<文件名>") 逐个读完（这些文件分别管：'
        + (isSD
          ? '镜头五要素与景别阶梯 / 站位与权力几何 / 空间坐标系 / 段缝衔接 / 台词语速自检 / 转场六型'
          : '框架适配层 / G0六项锁+拆段+产出顺序 / 八档四轴 / 运镜越轴站位 / 空间锚点与段间衔接 / 台词密度 / 十组必查 / H1-H38 对照')
        + '），再重新提交 set_storyboard。这是硬门禁：分镜结构一旦写错，提示词阶段无法补救。'
      );
    }
  }
  // 台词时长校验：对齐老李全流程 dialogue-density.md §三——中文口播实测 3.2–3.5 字/秒，按 3.5 上限算
  //（旧值 5.5 比实测宽 1.67 倍，放行了 110% 超时口的稿）。超速会在成片里被压缩成听不清的模糊声。
  // 硬性拒绝，强制 Agent 缩短台词或拆分镜头，而不是生成后才发现语音对不上。
  // 中文按「字/秒」（3.5 上限），英文按「词/秒」（3.8 上限 ≈228wpm）——不能一律按字符数算：
  // 英文一句 60 字符往往只有 12 个词，按字符算等于 5 字/秒，会把合法英文台词整批判死
  // （实测：海外短剧 28s 段两句英文 OS 共 152 字符被判超速拒写，而人工交付稿机检 0 FAIL）。
  const over = [];
  for (const sb of args.shots || []) {
    const dur = durationOf(sb, ctx.project?.video_model);
    const sp = dialogueSpeed(sb.dialogue || '', dur);
    if (sp.count && sp.count > sp.limit) {
      over.push({ idx: sb.idx, durationSec: dur, [sp.unit]: sp.count, max: sp.limit, rate: Number(sp.rate.toFixed(2)), limit: sp.max });
    }
  }
  if (over.length) {
    throw new Error('台词与时长不匹配（中文 ≤3.5 字/秒；英文 ≤3.8 词/秒）：超出会在成片里被压缩成听不清的模糊声。请把以下镜头台词压到 max 以内（或拆成更多镜头 / 延长时长，单段上限 ' + shotDurationMax(ctx.project?.video_model) + ' 秒）：' + JSON.stringify(over));
  }
  // 多人对话校验：单分镜最多 MAX_SPEAKERS_PER_SHOT 个说话人；≥3 人对话必须拆成多个分镜，
  // 避免参考音频超限（每说话人一段参考音色）且避免多人同框对话质量下降。
  const multiSpeaker = [];
  for (const sb of args.shots || []) {
    const speakers = dialogueSpeakerNames(sb.dialogue);
    if (speakers.length > MAX_SPEAKERS_PER_SHOT) {
      multiSpeaker.push({ idx: sb.idx, speakers });
    }
  }
  if (multiSpeaker.length) {
    throw new Error('分镜对话人数过多：每个分镜最多 ' + MAX_SPEAKERS_PER_SHOT + ' 个说话人，请把多人对话拆成多个分镜（每个分镜最多 ' + MAX_SPEAKERS_PER_SHOT + ' 人说话）。涉及分镜：' + JSON.stringify(multiSpeaker));
  }
  // 章节归属先整批解析：分镜是按「章节标题」挂到章节上的（chapter 就是业务键），所以 chapter 必须
  // 是本项目已存在的章节。模型可能传标题、也可能传 id（get_project / list_chapters 同时给出两者），
  // 两个都认。这一步必须在 clear 之前完成：否则一次非法写入会把整章分镜清空后才抛错。
  // 不做这一步的后果：写出「章节视图里看不到、也永远不会被生成」的孤儿分镜，却回报「分镜已写入」。
  const chapterMap = new Map();
  for (const c of Chapters.list(ctx.projectId)) { chapterMap.set(c.title, c.title); chapterMap.set(c.id, c.title); }
  const resolveChapter = (raw) => {
    const want = String(raw == null ? '' : raw).trim() || String(ctx.chapter || '').trim();
    if (!want) throw new Error('分镜缺少 chapter：请传章节标题或 id（可用 list_chapters 查看本项目章节）');
    const title = chapterMap.get(want);
    if (title === undefined) {
      throw new Error('章节不存在：' + want + '（本项目现有章节：' + [...new Set(chapterMap.values())].join('、') + '）');
    }
    return title;
  };
  const shotInputs = args.shots || [];
  const chapterTitles = shotInputs.map((sb) => resolveChapter(sb.chapter || args.chapter));
  // 【分镜锁档门禁 · 老李全流程 G0】set_storyboard 之前必须已写本章锁档（六项锁 + 情绪节拍 + 拆段表）。
  // 没有锁档就写镜行 = 跳过 pipeline.md §五 的标准产出顺序第 4–5 步，运镜/留白/段缝全凭感觉。
  {
    const planCache = new Map();
    const getPlan = (ch) => {
      if (!planCache.has(ch)) planCache.set(ch, loadStoryboardPlan(ctx.projectId, ch));
      return planCache.get(ch);
    };
    for (const ch of [...new Set(chapterTitles)]) {
      const plan = getPlan(ch);
      if (!plan) {
        throw new Error(
          '【分镜锁档缺失 · 拒绝写入】章节「' + ch + '」还没有锁档。按 forest-laoli-h3 全流程，动笔前必须先调 set_storyboard_plan 定完 G0 六项锁 + 情绪节拍曲线 + 拆段表：'
          + 'mode（T2VA/I2VA/L2VA/FL2VA/Ref2VA，短剧默认 Ref2VA）、aspect（9:16 或 16:9，禁 auto）、base（BASE_LIVE/BASE_ANIME/BASE_2D/BASE_INK）、'
          + 'assetMode（M1 文字档 / M2 已出图）、seam（tail_frame/hard_cut/empty_shot）、anchors（positions 站位表必填）、'
          + 'beats（每段 emotion + type + intensity 1–10 + durationSec（' + durationHint(ctx.project?.video_model) + '）+ shotRange 如 "1-3" + beatFunction 钩子/递进/反转/收束，且 shotRange 从 1 连续覆盖）。'
          + '锁档是运镜速度、留白、段缝方案的唯一依据（pipeline.md §五：跳过第 4 步就只能凭感觉，运镜必然平）。'
        );
      }
      const planErrs = validateStoryboardPlan(plan, ctx.project?.video_model);
      if (planErrs.length) {
        throw new Error('【分镜锁档不完整 · 拒绝写入】章节「' + ch + '」的锁档有问题，请用 set_storyboard_plan 覆盖修正后重试：\n- ' + planErrs.join('\n- '));
      }
    }
    // 结构机检：时长档 / 具名主体 / 连续同机位 / 节拍归属 / 镜数密度
    const structErrs = lintStoryboardShots(shotInputs, chapterTitles, getPlan, ctx.project?.video_model);
    if (structErrs.length) {
      throw new Error('【分镜结构机检不通过 · 拒绝写入】按 gates.md 与 pipeline.md 逐条修正后重试：\n- ' + structErrs.join('\n- '));
    }
  }
  const assets = Assets.list(ctx.projectId);
  const byName = (cat) => {
    const m = {};
    for (const a of assets) if (a.category === cat) m[a.name] = a.id;
    return m;
  };
  const charMap = byName('character'); const sceneMap = byName('scene'); const propMap = byName('prop'); const costumeMap = byName('costume'); const ageMap = byName('age');
  // 音频素材跨 voice/music/sfx 三类：统一按名字映射（作为 H3 音色参考）
  const audioMap = {};
  for (const a of assets) if (['voice', 'music', 'sfx'].includes(a.category)) audioMap[a.name] = a.id;
  // clear 只清「本次写入涉及的章节」：原先删的是整个项目的分镜，让「重新生成第2章分镜」把第1章
  // 已出片的镜头一并删掉，还回报「分镜已写入」——看起来完全正常。外部写入 API 的整章写入同口径
  // （app/api/.../storyboard/route.js 只删本章）。其他章节的分镜一律保留。
  const clearTitles = new Set(chapterTitles);
  let existing = Shots.list(ctx.projectId);
  if (args.clear) {
    // 断点续跑防护：clear 会删掉本章分镜（含已渲染的视频）。LLM 阶段重跑时模型若带 clear
    // 重写整章，已花钱出的视频会全部作废，下一次视频阶段又整章重跑。
    // 有成品/正在生成时一律拒绝清空，让模型改用「不带 clear 的 idx upsert」。
    const protectedShots = existing.filter(
      (s) => clearTitles.has(s.chapter) && (s.video_path || s.status === 'done' || s.status === 'generating' || s.status === 'queued'),
    );
    if (protectedShots.length) {
      throw new Error('本章已有 ' + protectedShots.length + ' 个已生成或生成中的分镜，clear 会删除这些成品视频；请去掉 clear，按 idx 更新已有分镜。');
    }
    for (const s of existing) if (clearTitles.has(s.chapter)) Shots.remove(s.id);
    existing = existing.filter((s) => !clearTitles.has(s.chapter));
  }
  // 每章独立 idx 空间：同一 (chapter, idx) 视为同一个镜头，不同章节互不干扰
  const key = (ch, idx) => String(ch || '') + '\u0000' + String(idx);
  const byKey = {}; for (const s of existing) byKey[key(s.chapter, s.idx)] = s;
  const chapterMax = {}; for (const s of existing) chapterMax[s.chapter || ''] = Math.max(chapterMax[s.chapter || ''] || 0, s.idx);
  // 镜号先整批归一（与外部写入 API 的 shot-write.js 同口径：≥1 的整数，章内唯一）：
  // ① 分两遍：先把**全部**显式 idx 计入各章上限，再给省略 idx 的镜头续号。单遍分配时
  //    「自动号在前、显式号在后」会撞号（[无 idx, idx:1] → [1,1]），后一条走 upsert 覆盖前一条，
  //    内容被静默丢掉；
  // ② 越界/非数字在这里拦下，避免 1.5 这类镜号落库后章内序号失去意义。
  for (let i = 0; i < shotInputs.length; i++) {
    const raw = shotInputs[i].idx;
    if (raw == null) continue;
    const n = Math.trunc(Number(raw));
    if (!Number.isFinite(n) || n < 1) throw new Error('分镜 idx 必须是 ≥1 的整数（当前：' + raw + '）');
    const ch = chapterTitles[i];
    chapterMax[ch] = Math.max(chapterMax[ch] || 0, n);
  }
  const idxs = chapterTitles.map((ch, i) => {
    const raw = shotInputs[i].idx;
    if (raw != null) return Math.trunc(Number(raw));
    const n = (chapterMax[ch] || 0) + 1; chapterMax[ch] = n; return n;
  });
  let added = 0, updated = 0;
  // 资产名按名字映射成 id；名字对不上（拼错、资产还没建）原先静默丢弃 —— 分镜照建、参考屏蔽，
  // 回报却是「分镜已写入」。这里收集未命中的名字，随结果一并回报（不拒绝整批：模型可先建资产再回填）。
  const missingRefs = [];
  const idsOf = (names, map, cat) => (names || []).map((n) => {
    const id = map[n];
    if (id === undefined) missingRefs.push(cat + '「' + n + '」');
    return id;
  }).filter(Boolean);
  const touched = [];
  const writtenChapters = new Set();
  // H3 镜行正文语言门禁：camera / visual / sub_shots 必须全英文（H3 写实模型只吃英文视觉词，
  // 中文动作描述会理解不稳、与后续六段式英文正文打架）。只对 H3 项目硬拦；SD 七段式是中文栏位，不拦。
  const isH3Project = !String(ctx.project?.video_model || 'h3').startsWith('seedance');
  const CJK_RE = /[\u4e00-\u9fff]/;
  for (let i = 0; i < shotInputs.length; i++) {
    const sb = shotInputs[i];
    const ch = chapterTitles[i];
    const idx = idxs[i];
    writtenChapters.add(ch);
    if (isH3Project) {
      const zhFields = ['camera', 'visual', 'sub_shots'].filter((k) => CJK_RE.test(String(sb[k] || '')));
      if (zhFields.length) {
        throw new Error('分镜 #' + idx + ' 的 ' + zhFields.join('/') + ' 含中文——H3 镜行正文必须全英文（仅 dialogue 台词保留中文）。请把动作/神态/光影描述翻译成英文再写入。');
      }
    }
    const fields = {
      chapter: ch,
      scene_name: sb.scene_name || ((sb.scenes || []).join('、')),
      camera: sb.camera || '', visual: sb.visual || '', dialogue: sb.dialogue || '', narration: sb.narration || '',
      sub_shots: sb.sub_shots || '', blocking: sb.blocking || '', duration: durationOf(sb, ctx.project?.video_model),
      character_ids: idsOf(sb.characters, charMap, '人物'),
      scene_ids: idsOf(sb.scenes, sceneMap, '场景'),
      prop_ids: idsOf(sb.props, propMap, '道具'),
      costume_ids: idsOf(sb.costumes, costumeMap, '服装'),
      age_ids: idsOf(sb.ages, ageMap, '年龄变体'),
      audio_ids: idsOf(sb.audios, audioMap, '音频'),
      resolution: ctx.project.video_resolution || '480P',
      aspect_ratio: ctx.project.video_aspect_ratio || '16:9',
      mode: sb.mode || '',
    };
    const k = key(ch, idx);
    if (byKey[k] !== undefined) {
      Shots.update(byKey[k].id, fields);
      updated++;
      touched.push({ id: byKey[k].id, idx, reused: true });
    } else {
      const shot = Shots.create(ctx.projectId, { ...fields, idx });
      // 新建的行必须登记回 byKey：否则同一次调用里出现两条 (chapter, idx) 相同的分镜时，
      // 两条都会走 create，落库成「同章同镜号」的重复镜头（注释里承诺的是「视为同一个镜头」）。
      byKey[k] = shot;
      added++;
      touched.push({ id: shot.id, idx: shot.idx });
    }
  }
  // 非破坏：仅新增/更新，绝不自动删除既有分镜（保证旧章节保留，多章节可继续追加）
  // 换装兜底：识别本次写入章节内的沐浴/更衣/换装事件，自动生成服装资产并绑定到事件之后的镜头。
  // 这里用「解析后的章节标题」而不是原始参数：模型传 id 时也要能定位到正确的章节。
  const chapters = [...writtenChapters];
  const outfitRes = await autoResolveOutfits(ctx, chapters);
  if (outfitRes.generated) ctx.report({ phase: '人物换装', detail: '自动识别换装事件，生成服装资产 ' + outfitRes.generated + ' 套' });
  const ageRes = await autoResolveAges(ctx, chapters);
  if (ageRes.generated) ctx.report({ phase: '人物年龄', detail: '自动识别年龄变化事件，生成年龄变体 ' + ageRes.generated + ' 个' });
  let out = '分镜已写入（新增 ' + added + '，更新 ' + updated + '）';
  if (outfitRes.generated) out += '；自动换装生成服装资产 ' + outfitRes.generated + ' 套、绑定 ' + outfitRes.bound + ' 镜';
  if (ageRes.generated) out += '；自动年龄变体生成 ' + ageRes.generated + ' 个、绑定 ' + ageRes.bound + ' 镜';
  // 本阶段不渲染（LLM 创作阶段）时兜底被推迟：把待处理的事件数回报出去，别让模型以为已经处理完
  if (outfitRes.deferred) out += '；检测到 ' + outfitRes.deferred + ' 个换装事件：服装资产将在「资产图」阶段生成并绑定（本阶段不渲染）';
  if (ageRes.deferred) out += '；检测到 ' + ageRes.deferred + ' 个年龄变化：年龄变体将在「资产图」阶段生成并绑定（本阶段不渲染）';
  // 兜底失败原先只写进 notes 且从不使用：服装/年龄变体没生成、镜头继续用原图出片，模型却看不到。
  if (missingRefs.length) out += '；未找到同名资产（已忽略）：' + [...new Set(missingRefs)].join('、') + '。请先创建资产或修正名字';
  const failed = [...(outfitRes.notes || []), ...(ageRes.notes || [])].filter((n) => /失败/.test(n));
  if (failed.length) out += '；' + failed.join('；');
  return out;
}

// 换装/年龄兜底（原先在 set_storyboard 内联执行，见上面的 renderDisabled 分支）：它要图生图出图，
// 所以只能在有 ComfyUI 的阶段调用 —— 即「资产图」阶段（stages.js RENDER_STAGE_TOOLS.image）。
// chapters 传章节标题数组；返回两个子结果（generated/bound/notes/deferred）与可展示的汇总文本。
export async function resolveShotProvisions(ctx, chapters) {
  const outfit = await autoResolveOutfits(ctx, chapters);
  const age = await autoResolveAges(ctx, chapters);
  const lines = [];
  if (outfit.generated) lines.push('自动换装：生成服装资产 ' + outfit.generated + ' 套、绑定 ' + outfit.bound + ' 镜');
  if (age.generated) lines.push('自动年龄变体：生成 ' + age.generated + ' 个、绑定 ' + age.bound + ' 镜');
  const failed = [...(outfit.notes || []), ...(age.notes || [])].filter((n) => /失败/.test(n));
  if (failed.length) lines.push(failed.join('；'));
  return { outfit, age, text: lines.join('；') };
}

async function hListShots(ctx) {
  const target = targetChapterTitle(ctx);
  const shots = target
    ? Shots.list(ctx.projectId).filter((s) => s.chapter === target)
    : Shots.list(ctx.projectId);
  return JSON.stringify(shots.map((s) => ({ id: s.id, idx: s.idx, chapter: s.chapter || '', scene_name: s.scene_name, status: s.status, has_prompt: !!(s.video_prompt && String(s.video_prompt).trim()), has_video: !!s.video_path, error: s.error, duration: s.duration })));
}

async function hUpdateShot(ctx, args) {
  // 归属校验：与其他写工具同口径（generate_shot_video / update_asset 都先比对 project_id）。
  // 不校验的话，传入别的项目的 shot_id 会改掉那个项目的分镜，而变更日志记在本项目名下 ——
  // 回滚时两边都对不上。顺带把分镜读一次复用，不重复查库。
  const shot = Shots.get(args.shot_id);
  if (!shot || shot.project_id !== ctx.projectId) throw new Error('分镜不存在');
  const patch = {};
  for (const k of ['sub_shots', 'dialogue', 'narration', 'camera', 'visual', 'blocking', 'duration', 'video_prompt', 'mode']) if (args[k] != null) patch[k] = args[k];
  // 视频生成模式枚举校验：非空且不在 VIDEO_MODES 内即拒绝（空串 = auto，走确定性推断兜底）
  if (args.mode != null && String(args.mode) && !VIDEO_MODES.includes(String(args.mode))) {
    throw new Error('mode 只能是 ' + VIDEO_MODES.join('/') + '（当前：' + args.mode + '）');
  }
  // 时长归一化后再落库：原先只用「裁剪后的值」做台词/时长校验，却把原值写进 DB ——
  // 校验与落库不是同一个数（-5、0、'8秒' 都能入库）。负时长会被原样传给 H3（seconds=-5），
  // 也会把本章总时长算成负数（背景音乐时长按总时长算），而字符串时长在 REAL 列里退化。
  if (args.duration != null) {
    const d = Number(args.duration);
    if (!Number.isFinite(d)) throw new Error('duration 必须是数字（秒）：' + args.duration);
    patch.duration = Math.min(shotDurationMax(ctx.project?.video_model), Math.max(SHOT_DURATION_MIN, Math.trunc(d)));
  }
  // 若本次修改了台词或时长，同样做「台词字数 ≤ 时长×5」校验
  if (args.dialogue != null || args.duration != null) {
    // 时长缺省值与 db 层 / 外部写入 API 同一份（SHOT_DURATION_DEFAULT）：原先这里写死 8，
    // 与 SHOT_DURATION_DEFAULT=5 漂移 —— 历史行 duration 为空时，两条写入路径按不同的上限判台词。
    const dur = patch.duration != null ? patch.duration : (Number(shot.duration) > 0 ? Number(shot.duration) : SHOT_DURATION_DEFAULT);
    const sp = dialogueSpeed(patch.dialogue != null ? patch.dialogue : (shot.dialogue || ''), dur);
    if (sp.count && sp.count > sp.limit) {
      throw new Error('台词与时长不匹配（中文 ≤3.5 字/秒；英文 ≤3.8 词/秒）：当前 ' + sp.count + ' ' + sp.unitCN + ' / ' + dur + ' 秒（上限 ' + sp.limit + ' ' + sp.unitCN + '）超速，会被压成听不清的模糊声。请缩短台词或延长时长。');
    }
  }
  // 若本次修改了台词，校验说话人数 ≤ MAX_SPEAKERS_PER_SHOT（多人对话需拆镜）
  if (args.dialogue != null) {
    const speakers = dialogueSpeakerNames(patch.dialogue);
    if (speakers.length > MAX_SPEAKERS_PER_SHOT) {
      throw new Error('分镜对话人数过多：每个分镜最多 ' + MAX_SPEAKERS_PER_SHOT + ' 个说话人，请拆成多个分镜。当前说话人：' + speakers.join('、'));
    }
  }
  // video_prompt 禁止手写：LLM 直接往 video_prompt 里写内容，拿不到参考素材的真实编号顺序，
  // 必然写出 __MINIMAX_H3_REF_N__ 平铺占位符或错位引用，编译后变成空壳六段式、人物漂移、音色错乱。
  // 这里统一拦截：要写/改 video_prompt，必须走 write_shot_video_prompt 工具（它会自动解析真实参考顺序并出六段式）。
  if (patch.video_prompt != null && patch.video_prompt !== '') {
    const vp = String(patch.video_prompt);
    if (/__MINIMAX_H3_REF_\d+__/.test(vp)) {
      throw new Error('video_prompt 禁止使用平铺占位符 __MINIMAX_H3_REF_N__（那是旧 Easy 工作流格式）。请改用 write_shot_video_prompt 工具为分镜 ' + shot.idx + ' 生成对应模型的提示词（H3 六段式 / Seedance 七段式），不要在 update_shot 里手写 video_prompt。');
    }
  }
  Shots.update(args.shot_id, patch);
  return '已更新分镜';
}

function shotImageAbsPaths(ctx, shot) {
  const assets = Assets.list(ctx.projectId);
  const byId = (id) => assets.find((x) => x.id === id);
  const ids = [...(shot.character_ids || []), ...(shot.scene_ids || []), ...(shot.prop_ids || []), ...(shot.costume_ids || [])];
  return ids.map(byId).filter(Boolean).map((a) => resolveProjectPath(ctx.projectId, a.image_path)).filter(Boolean);
}

const REF_PLACEHOLDER_RE = /__MINIMAX_H3_REF_\d+__/g;

// 基于用户反馈重写视频提示词。要求 LLM 输出「完整重写结果」，并做三项校验：
//   非空、未被截断（finish_reason !== 'length'）、保留原提示词里的全部 __MINIMAX_H3_REF_N__ 占位符。
// 任一不满足：用更严格的指令重试一次；仍不满足则抛错——绝不把半截/丢参考的结果覆盖进资产。
// （实测踩坑：长提示词被模型摘缩成一句，REF_2/REF_3 全丢，视频随后「对不上」。）
async function rewritePromptWithFeedback(ctx, basePrompt, feedback, imageAbsPaths) {
  // 本批禁用 LLM（渲染 job / 渲染阶段）：不允许在渲染过程中拉起 LLM 抢显存。
  // 反馈改写是「可选 LLM 步骤」，此时要求走纯 LLM 批次改写后再渲染。
  if (ctx.llmDisabled) {
    throw new Error('本批已禁用 LLM（渲染批次）：不能调用 LLM 改写提示词。请先用「仅 LLM 改写」批次改写，再渲染；或去掉反馈直接渲染。');
  }
  const buildMsgs = (strict) => {
    // 改写语言由设置项 llm.rewriteLanguage 决定（same=与原提示词一致 / zh / en）
    const lang = { same: '保持与原提示词相同的语言', zh: '用中文输出', en: '用英文输出' }[ctx.cfg.llm?.rewriteLanguage] || '保持与原提示词相同的语言';
    const sys = '你是视频提示词改写助手。基于原提示词与用户反馈，输出改写后的完整提示词（' + lang + '，保留 __MINIMAX_H3_REF_N__ 占位符与参考标签不变）。只输出提示词文本。'
      + (strict ? '必须完整保留原提示词的全部信息（镜头、画面、时间轴、声音、结尾约束）与所有 __MINIMAX_H3_REF_N__ 占位符，不得缩写、不得只写开头。' : '');
    const msgs = [{ role: 'system', content: sys }];
    if (visionEnabled(ctx)) {
      const dataUrls = imagesFromPaths(imageAbsPaths, 9).map((i) => 'data:' + i.mimeType + ';base64,' + i.data);
      msgs.push(buildVisionUserMessage('原提示词：\n' + basePrompt + '\n\n反馈：' + feedback + '\n\n（附该分镜参考图，供改写参考）', dataUrls));
    } else {
      msgs.push({ role: 'user', content: '原提示词：\n' + basePrompt + '\n\n反馈：' + feedback });
    }
    return msgs;
  };
  const want = new Set(String(basePrompt).match(REF_PLACEHOLDER_RE) || []);
  // 改写最大输出 token 由设置项决定（默认 4000）：思考型模型的 reasoning 与正文共用该预算，
  // 预算不足时正文刚开头就被截断（改写只剩一两句、丢参考占位符）→ 视频画面对不上。
  const maxTokens = Math.max(256, Number(ctx.cfg.llm?.rewriteMaxTokens) || 4000);
  let reason = '未知原因';
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await llmChat(ctx.cfg.llm, buildMsgs(attempt > 0), { temperature: attempt > 0 ? 0.4 : 0.6, maxTokens });
    const out = String(r.content || '').trim();
    if (!out) { reason = 'LLM 返回为空'; continue; }
    if (r.finishReason === 'length') { reason = 'LLM 输出被截断（达到长度上限）'; continue; }
    const got = new Set(out.match(REF_PLACEHOLDER_RE) || []);
    const missing = [...want].filter((x) => !got.has(x));
    if (missing.length) { reason = 'LLM 改写丢失参考占位符 ' + missing.join('、'); continue; }
    return out;
  }
  throw new Error('LLM 改写提示词不可用（' + reason + '），已保留原提示词。请重试。');
}

// 视频任务的显存释放计数已上移到 workflow-runner.maybeFreeComfy（runWorkflow 统一出口），
// 覆盖全部 ComfyUI 生成（文生图/图生图/换装/音色/视频），不再局限视频。

// 准备单个分镜的渲染参数：组装参考素材 + 计算提示词/工作流/分辨率等，不写状态、不提交渲染。
// render=false（仅 LLM 改写）时直接落库并返回 { done }；否则返回渲染所需的 prepared 对象。
async function prepareShotForRender(ctx, shotId, { feedback, render = true } = {}) {
  const shot = Shots.get(shotId);
  if (!shot || shot.project_id !== ctx.projectId) throw new Error('分镜不存在');
  const assets = Assets.list(ctx.projectId);
  // 文生视频（mode='text'）不连接任何媒体节点：跳过参考素材组装（assembleShotReferences 会因
  // 「至少 1 张参考图」抛错），references 留空、不绑定 media_*。
  // 首尾帧（mode='first_last'）：使用用户在「插入自定义分镜」时上传的首帧+尾帧两张图 + 视频提示词跑 FL2VA。
  // 非文生/首尾帧路径：render=false（仅 LLM 改写提示词）走纯文本，upload=false 不上传参考文件，
  // 但仍解析参考标签供 fallbackVideoPrompt 生成 __MINIMAX_H3_REF_N__ 占位符。
  const isText = shot.mode === 'text';
  const isFirstLast = shot.mode === 'first_last';
  const isImage = shot.mode === 'image';
  let references, characterName, characterDesc, sceneDesc, unmatchedSpeakers;
  if (isText) {
    ({ references, characterName, characterDesc, sceneDesc, unmatchedSpeakers } = { references: [], characterName: '', characterDesc: '', sceneDesc: '', unmatchedSpeakers: [] });
  } else if (isFirstLast) {
    ({ references, characterName, characterDesc, sceneDesc, unmatchedSpeakers } = { references: [], characterName: '', characterDesc: '', sceneDesc: '', unmatchedSpeakers: [] });
    if (render !== false) {
      const firstRel = shot.first_frame_path;
      const lastRel = shot.last_frame_path;
      if (!firstRel || !lastRel) throw new Error('首尾帧模式需要先上传首帧和尾帧两张图片（在「插入自定义分镜」时上传）');
      const firstAbs = resolveProjectPath(ctx.projectId, firstRel);
      const lastAbs = resolveProjectPath(ctx.projectId, lastRel);
      const firstName = await uploadTaskInput(ctx.cfg, firstAbs, 'ic_' + ctx.projectId.slice(0, 8) + '_frame_first_' + uid().slice(0, 8) + '.png', 'video');
      const lastName = await uploadTaskInput(ctx.cfg, lastAbs, 'ic_' + ctx.projectId.slice(0, 8) + '_frame_last_' + uid().slice(0, 8) + '.png', 'video');
      references = [
        { type: 'image', filename: firstName, localPath: firstAbs, label: '首帧' },
        { type: 'image', filename: lastName, localPath: lastAbs, label: '尾帧' },
      ];
    }
  } else if (isImage && shot.reference_image_path) {
    // 图生视频：使用用户在「插入自定义分镜」时上传的 1 张参考图
    ({ references, characterName, characterDesc, sceneDesc, unmatchedSpeakers } = { references: [], characterName: '', characterDesc: '', sceneDesc: '', unmatchedSpeakers: [] });
    if (render !== false) {
      const rel = shot.reference_image_path;
      const abs = resolveProjectPath(ctx.projectId, rel);
      if (!abs || !fs.existsSync(abs)) throw new Error('图生视频参考图不存在，请重新上传（在「插入自定义分镜」时上传）');
      const name = await uploadTaskInput(ctx.cfg, abs, 'ic_' + ctx.projectId.slice(0, 8) + '_img_' + uid().slice(0, 8) + '.png', 'video');
      references = [{ type: 'image', filename: name, localPath: abs, label: '参考图' }];
    }
  } else {
    ({ references, characterName, characterDesc, sceneDesc, unmatchedSpeakers } = await assembleShotReferences({ cfg: ctx.cfg, project: ctx.project, shot, assets, upload: render !== false }));
  }
  // 对白说话人没匹配到本镜角色（如「李雷，韩梅梅：台词」这类一行多说话人标签）→ 音色被静默跳过，
  // 用户只会看到「这一镜没声音」。上报一条可读提示到运行日志，别让它无声无息。
  if (unmatchedSpeakers && unmatchedSpeakers.length) {
    ctx.report({ phase: '参考素材', detail: '对白说话人未匹配到本镜角色，音色不会被引用：' + unmatchedSpeakers.join('、') + '（每行台词只写一个说话人，多个说话人拆成多行/多镜）' });
  }
  const timeErr = validateSubShots(shot.duration, shot.sub_shots);
  if (timeErr) throw new Error(timeErr);
  const base = shot.video_prompt || fallbackVideoPrompt({ references, style: ctx.project.style, characterDesc, sceneDesc, subShots: shot.sub_shots, camera: shot.camera, visual: shot.visual, dialogue: shot.dialogue, characterName });
  const prompt = feedback ? await rewritePromptWithFeedback(ctx, base, feedback, shotImageAbsPaths(ctx, shot)) : base;
  // render=false：只做 LLM 改写提示词，不提交 ComfyUI（改写结果落库，供用户复核后再渲染）
  if (render === false) {
    if (!feedback) throw new Error('仅 LLM 改写模式需要反馈文字');
    Shots.update(shot.id, { video_prompt: prompt, error: '' });
    ctx.report({ phase: '分镜提示词', detail: 'LLM 改写完成（未渲染）分镜 ' + shot.idx });
    return { done: JSON.stringify({ shot_id: shot.id, idx: shot.idx, video_prompt: prompt, rendered: false }) };
  }
  // 实际写入节点 2.mode：显式指定且在值域内则直用；未指定/空串走确定性推断兜底
  // （text 经 spec 的 mode.map 映射成节点 image = 文生，不连媒体）。
  const mode = (shot.mode && VIDEO_MODES.includes(shot.mode)) ? shot.mode : inferVideoMode(references);
  // 图生/首尾帧（image）只接受图片，不接受音/视频：否则媒体槽绑定与 mode=image 语义矛盾
  if (mode === 'image' && references.some((r) => r.type === 'audio' || r.type === 'video')) {
    throw new Error('image 模式（图生/首尾帧）只接受 0~2 张图片，不能携带音频/视频参考');
  }
  // 尺寸以项目当前设置为权威（项目改了 9:16 后，旧分镜快照里的 16:9 不应再生效，否则同章会混入不同尺寸）。
  const reso = ctx.project.video_resolution || shot.resolution || '480P';
  const ratio = ctx.project.video_aspect_ratio || shot.aspect_ratio || '16:9';
  // 按分辨率选工作流：>768P 用二次采样超分（首遍 768P + mode.scale），≤768P 用普通 r2v
  const { spec, scale, resolution: wfResolution } = getR2vSpecForResolution(ctx.cfg, reso, mode, references.filter((r) => r.type === 'image').length);
  // 单个分镜生成 N 条候选视频（设置 → generation.videosPerShot，默认 1），用不同 seed 各渲染一条，
  // 用户随后在分镜审查页勾选一条优质候选用于导出成片。N 上限 10 防误配置爆炸。
  const shotsN = Math.max(1, Math.min(10, Math.floor(Number(ctx.cfg?.generation?.videosPerShot) || 1)));
  return { shot, prompt, mode, spec, reso, ratio, scale, wfResolution, shotsN, references, prevStatus: shot.status, prevVideo: shot.video_path };
}

// 渲染单个候选视频（候选 idx，追加模式下从旧候选之后续接），成功返回 { id, idx, video_path, seed }；失败抛错。
async function renderShotCandidate(ctx, prepared, idx) {
  const { shot, prompt, mode, spec, reso, ratio, references, scale, wfResolution } = prepared;
  const seed = randomSeed();
  const prefix = 'video/' + ctx.projectId.slice(0, 8) + '_shot' + shot.idx + '_' + uid().slice(0, 6);
  const wfParams = {
    positive_prompt: prompt,
    seconds: shot.duration || 5,
    aspect_ratio: ratio,
    resolution: wfResolution,
    mode,
    seed, filename_prefix: prefix, references,
  };
  if (scale) wfParams.scale = scale;
  // 自定义分辨率：resolution 固定为 custom，宽高取自项目配置
  if (reso === 'custom') {
    wfParams.width = Number(ctx.project.video_width) || 1024;
    wfParams.height = Number(ctx.project.video_height) || 576;
  }
  const { outputs, prompt_id } = await runWorkflow(ctx.cfg, spec, wfParams, { jobId: ctx.jobId, unitId: 'shot:' + shot.id + ':cand:' + idx, projectId: ctx.projectId, chapter: shot.chapter || '', subject: '第' + shot.idx + '镜', dedupeKey: 'shot:' + shot.id + ':cand:' + idx, timeoutMs: VID_TIMEOUT(ctx.cfg), isAborted: ctx.isAborted, onSubmitted: (pid) => Shots.update(shot.id, { prompt_id: pid }), onStatus: (s) => { if (s.kind === 'error') throw new Error(s.message); if (s.kind === 'waiting_release') ctx.report({ phase: '等待云端释放', detail: s.message }); } });
  const vid = pickOutput(outputs, 'videos');
  if (!vid) throw new Error('视频工作流未返回视频文件');
  const ext = path.extname(vid.filename) || '.mp4';
  const relPath = 'shots/shot' + shot.idx + '_' + uid().slice(0, 8) + ext;
  await downloadOutputTo(ctx, vid, relPath);
  const sv = ShotVideos.create(ctx.projectId, shot.id, { idx, video_path: relPath, seed });
  Shots.update(shot.id, { seed, prompt_id: prompt_id || '' });
  return { id: sv.id, idx, video_path: relPath, seed };
}

// 收尾一个分镜：有候选则确定导出用候选、标 done；无候选按取消/失败复位。
// 成功返回结果对象；无候选时抛错（中断或失败）。
function finalizeShot(ctx, prepared, created, { aborted, interrupted, lastErr, append = false }) {
  const { shot, prompt, prevStatus, prevVideo } = prepared;
  if (created.length) {
    created.sort((a, b) => a.idx - b.idx); // 并发完成顺序不定，按候选序取第一条保证「默认选第一条」
    // 追加候选：保留用户之前勾选的候选（若有），否则选新增的第一条；替换/首次：默认选第一条。
    const keepSelected = append ? ShotVideos.selectedForShot(shot.id) : null;
    const first = keepSelected || created[0];
    ShotVideos.setSelected(shot.id, first.id);
    Shots.update(shot.id, { video_path: first.video_path, status: 'done', video_prompt_used: prompt, error: '', prompt_id: '' });
    return { shot_id: shot.id, idx: shot.idx, video_path: first.video_path, count: created.length };
  }
  if (aborted || interrupted) {
    if (prevStatus === 'done' && prevVideo) Shots.update(shot.id, { status: 'done', video_path: prevVideo, error: '' });
    else Shots.update(shot.id, { status: 'pending', video_path: prevVideo || '', error: '' });
  } else {
    Shots.update(shot.id, { status: 'failed', error: (lastErr && lastErr.message) ? lastErr.message : String(lastErr || '生成失败'), video_path: prevVideo || '' });
  }
  throw lastErr || new Error(interrupted ? '生成已中断' : '生成失败');
}

// 单个分镜生成 N 条候选（单镜工具 / 重生成入口）：串行渲染该镜的 N 条候选。
// append=true 时「追加为新候选」——保留旧候选、新候选 idx 续接，用于「生成候选」按钮；
// append=false（默认）时「替换整批候选」——清掉旧候选、idx 从 0 起。
async function generateShotVideo(ctx, shotId, { feedback, render = true, append = false } = {}) {
  const prepared = await prepareShotForRender(ctx, shotId, { feedback, render });
  if (prepared.done) return prepared.done;
  const { shot, prompt, reso, ratio, shotsN } = prepared;
  // 依赖闸门（与 hGenerateChapterVideos 的 pendingShotAssets 同口径）：单镜直跑也不得在
  // 依赖资产（角色/场景/道具/服装/年龄）未生成完成时开渲染。否则 LLM Agent 会绕过
  // generate_chapter_videos 逐镜调用 generate_shot_video，导致「素材没生成完就出视频」。
  if (prepared.mode !== 'text') {
    const byId = new Map(Assets.list(ctx.projectId).map((a) => [a.id, a]));
    const pending = pendingShotAssets(ctx, shot, byId);
    if (pending.length) {
      throw new Error('分镜 ' + shot.idx + ' 依赖的资产尚未生成完成，请先生成资产图/服装再生成视频：' + pending.join('、'));
    }
  }
  const baseIdx = append ? ShotVideos.listByShot(shot.id).length : 0;
  Shots.update(shot.id, { status: 'generating', video_prompt: prompt, seed: 0, resolution: reso, aspect_ratio: ratio, error: '', prompt_id: '' });
  ctx.report({ phase: '分镜视频', detail: (append ? '追加候选 ' : '生成分镜 ') + shot.idx + (feedback ? '（重生成）' : '') + (shotsN > 1 ? ' ×' + shotsN + ' 条候选' : '') });
  // 追加模式保留旧候选；替换模式清空旧候选（旧候选磁盘文件按现状自然遗留）
  if (!append) ShotVideos.deleteByShot(shot.id);
  const created = [];
  let aborted = false;
  let interrupted = false;
  let lastErr = null;
  for (let i = 0; i < shotsN; i++) {
    if (aborted || interrupted || (ctx.isAborted && ctx.isAborted())) { aborted = true; break; }
    try {
      created.push(await renderShotCandidate(ctx, prepared, baseIdx + i));
    } catch (e) {
      if (ctx.isAborted && ctx.isAborted()) { aborted = true; break; }
      if (e && e.interrupted) { interrupted = true; lastErr = e; break; }
      lastErr = e;
      ctx.report({ phase: '分镜视频', detail: '分镜 ' + shot.idx + ' 候选 ' + (i + 1) + '/' + shotsN + ' 失败：' + (e && e.message ? e.message : String(e)) });
    }
  }
  if (created.length) return JSON.stringify(finalizeShot(ctx, prepared, created, { aborted, interrupted, lastErr, append }));
  finalizeShot(ctx, prepared, created, { aborted, interrupted, lastErr, append }); // 无候选 → 抛错
}

async function hGenerateShotVideo(ctx, args) { return generateShotVideo(ctx, args.shot_id); }
async function hRegenerateShot(ctx, args) { return generateShotVideo(ctx, args.shot_id, { feedback: args.feedback, render: args.render !== false, append: !!args.append }); }

// 给分镜写视频提示词：按内联通用规范 H3_REF2VA_FORMAT_RULES（源自 forest-laoli-h3 六段式规范，
// 已固化为常量、不动态加载 skill 文件），由 LLM 依据本镜画面/台词/参考素材生成一条完整的
// MiniMax H3 六段式提示词，写回 shot.video_prompt。主要用途：分镜需要生成/补全视频提示词时。
const REF_PLACEHOLDER_RE_G = /__MINIMAX_H3_REF_\d+__/g;

// 参考标签命中判定：模型常把 <Picture 1> 写成裸写 Picture 1，语义上仍指向同一图槽。
// 逐镜与批量必须用同一口径，否则批量放行的稿降级到逐镜后会被误杀（镜1那次失败就是这原因之一）。
function refTagPresent(text, tag) {
  if (text.includes(tag)) return true;
  const bare = tag.replace(/[<>]/g, ''); // <Picture 1> → Picture 1；@图片1 不受影响
  if (bare === tag) return false;
  return new RegExp('\\b' + bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(text);
}

// 机检反馈只回灌 FAIL 项：整份 h3_lint 报告含几十行 OK/WARN 和通用模板处方
// （如 "补 the two stools stay..."），全塞给模型会把它带偏、写出更长镜行。
export function conciseCheckFeedback(detail, maxChars = 1600) {
  const s = String(detail || '');
  // 两种机检脚本的 FAIL 行前缀不同：H3 的 h3_lint.py 打 `[FAIL] 描述`，
  // 老李的 validate_prompt.py 打 `[-] FAIL: C14 ...`。原先只认 [FAIL]，
  // 于是 Seedance 线永远提取不到 FAIL 列表、退化成「截前 1600 字」——
  // 模型收到的补正清单里全是 WARN，改不到点上。
  const fails = s.split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l.startsWith('[FAIL]') || /^\[-\]\s*FAIL/.test(l))
    .map((l) => l.replace(/^\[FAIL\]\s*/, '').replace(/^\[-\]\s*FAIL\s*[：:]?\s*/, ''));
  const core = fails.length
    ? '机检 FAIL 项（每条都必修）：\n' + fails.join('\n')
    : s.slice(0, maxChars);
  return core.slice(0, maxChars);
}

// ===== 滚动状态卡（批量提示词生成用）=====
// 存 data/projects/<id>/context/continuity-state.json，结构 { [chapter]: { scene, lastIdx, card, updatedAt } }。
// 与 bible/style/continuity 分开，避免动 CONTEXT_KEYS enum 与 save_context 的校验口径。
function stateCardFile(projectId) {
  return path.join(projectDir(projectId), 'context', 'continuity-state.json');
}
function loadStateCard(projectId, chapter) {
  try {
    const all = JSON.parse(fs.readFileSync(stateCardFile(projectId), 'utf8'));
    return all && typeof all === 'object' ? (all[chapter] || null) : null;
  } catch { return null; }
}
function saveStateCard(projectId, chapter, rec) {
  try {
    const dir = path.join(projectDir(projectId), 'context');
    fs.mkdirSync(dir, { recursive: true });
    const f = stateCardFile(projectId);
    let all = {};
    try { const raw = JSON.parse(fs.readFileSync(f, 'utf8')); if (raw && typeof raw === 'object' && !Array.isArray(raw)) all = raw; } catch {}
    all[chapter] = { ...rec, updatedAt: Date.now() };
    fs.writeFileSync(f, JSON.stringify(all, null, 2));
    return true;
  } catch { return false; }
}
// 从一条已生成的六段式正文里提炼「段尾站位卡」（h3 全流程 H51/H58 · 衔接必须品）。
// 旧版直接截 detailed_description 尾部原文——混着台词、说话人、(Sx)、Shot 标记，模型跟着台词跑、抓不住站位。
// 新版只取【末镜正文】并剥掉台词/时间戳/Shot 标记，留下干净的站位事实：
//   谁在哪（left/right）· 面朝哪（facing）· 手在哪 / 拿什么 · 道具状态 · 机位侧 · 定格句。
// 同时显式抽出景别词（H54 逐字一致）和朝向短语（H53 逐段重述），供下一批硬锁。
function extractTailFrameCard(promptText, maxChars = 900) {
  const s = String(promptText || '');
  // Seedance 七段式：站位事实写在【站位声明】栏（中文），没有 detailed_description / [Shot N] / 英文时间戳。
  // 从这里抽干净站位卡，供下一批【站位声明】栏承接，避免把七段式稿当 H3 抽导致卡里混进台词/空壳。
  if (/【站位声明】/.test(s)) {
    const sd = s.match(/【站位声明】\s*([\s\S]*?)(?=【时间轴分镜】|【音效】|【强制禁止项】|$)/);
    const sdBody = (sd ? sd[1] : '').trim();
    const sdClean = sdBody
      .replace(/台词[：:][\s\S]*$/g, '')          // 台词位到本栏末尾整段去掉（含引号与收尾括号）
      .replace(/@(图片|音频|视频)\d+（[^）]*）/g, '')
      .replace(/[」」】]+$/g, '')                  // 剥台词后可能残留的孤立右括号
      .replace(/\s+/g, ' ')
      .trim();
    const sdSize = sdClean.match(/(特写|近景|中近景|中景|远景|全景|大远景)/);
    const sdFacing = sdClean.match(/(面朝|朝向|面向)[^，。；\s]*/);
    return {
      card: sdClean.slice(0, maxChars),
      shotSize: sdSize ? sdSize[0] : '',
      facing: sdFacing ? sdFacing[0] : '',
    };
  }
  const dd = s.match(/detailed_description\s*\n([\s\S]*?)(?=\noverall_soundscape|\nnon_diegetic_music|$)/);
  const body = (dd ? dd[1] : s).trim();
  const shots = body.split(/(?=\[Shot \d+\])/).filter((x) => x.trim().startsWith('[Shot'));
  const lastRaw = shots.length ? shots[shots.length - 1] : body;
  // 剥时间戳 / Shot 标记 / 台词 / 说话人编号 / "X says ...:" 引子，只留可见画面事实
  const clean = lastRaw
    .replace(/^\[Shot \d+\]\s*(?:At 00:\d\d\.\d\d\d,\s*)?/i, '')
    .replace(/\s*At 00:\d\d\.\d\d\d,\s*/gi, ' ')
    // 先剥「说话人引子 + 台词」整段（voice/says/answers … : <d>…</d>），避免留下 ": S" 残尾
    .replace(/[^.;]{0,160}?\b(?:says|says in[^:;]{0,80}|answers|asks|replies|voice|voiceover)\b[^:;]{0,160}:\s*<d>[\s\S]*?<\/d>/gi, '')
    .replace(/<d>[\s\S]*?<\/d>/g, '')       // 再剥裸台词
    .replace(/\([Ss]\d+\)/g, '')            // 说话人编号
    .replace(/\s+/g, ' ')
    .trim();
  // 显式事实：景别（H54 要逐字一致）/ 朝向（H53 要逐段重述）
  // 景别要取【末镜所在段落里最后一个写全的景别词】：末镜若写 "the camera holds/cuts" 不带景别，
  // 就往前找最近的镜行头（Shot 1 常带 medium close-up / close-up），避免抓空导致 H54 锁失效。
  const SIZE_RE = /\b(extreme close-up|medium close-up|close-up|medium shot|long shot|close shot|wide shot)\b/i;
  let sizeMatch = SIZE_RE.exec(lastRaw.slice(0, 160));
  if (!sizeMatch) {
    for (let j = shots.length - 1; j >= 0; j--) {
      const mm = SIZE_RE.exec(shots[j].slice(0, 160));
      if (mm) { sizeMatch = mm; break; }
    }
  }
  // 朝向同理：末镜没有就从末两镜找
  let facingMatch = clean.match(/\bfacing\s+(?:the\s+)?(?:left|right|screen left|screen right|ahead|away)[^,.;]*/i);
  if (!facingMatch && shots.length > 1) {
    const prevClean = shots[shots.length - 2].replace(/<d>[\s\S]*?<\/d>/g, '').replace(/\([Ss]\d+\)/g, '');
    facingMatch = prevClean.match(/\bfacing\s+(?:the\s+)?(?:left|right|screen left|screen right|ahead|away)[^,.;]*/i);
  }
  return {
    card: clean.slice(0, maxChars),
    shotSize: sizeMatch ? sizeMatch[0] : '',
    facing: facingMatch ? facingMatch[0] : '',
  };
}

// 兼容旧调用点：只取站位卡字符串
function extractStateCard(promptText, maxChars = 900) {
  return extractTailFrameCard(promptText, maxChars).card;
}

// h3 全流程 H52 容帧续接句：本段首镜逐字复述，禁止模型重摆人物。
const TAIL_CONTINUATION_LINE = 'Continues from the tail frame of the segment before: the same positions, nobody re-enters, nothing is re-staged.';
const TAIL_CONTINUATION_RE = /continues? from the tail frame|same positions, nobody re-enters|nothing is re-staged/i;

// 构造「写视频提示词」的 system prompt。单镜工具与批量工具共用这一处，保证门禁/铁律文案不分裂。
// opt.stateCard：上一批滚动状态卡（同场景才传），注入后要求本批从该状态续写；
// opt.batchMode：批量模式追加「多镜分隔输出」格式要求。
function buildVideoPromptSystem(ctx, opt) {
  const { skillText, isSeedance, nativeH3 } = opt;
  const stateCard = opt.stateCard || '';
  const base = isSeedance
    ? [
        skillText,
        buildSeedanceLockCard(ctx.cfg, ctx.project),
        '你是 Seedance 七段式投喂稿撰写助手：严格按上面的 model-adapters.md 规范，为本镜写「完整的七段式投喂提示词」。',
        '七段式七个栏位固定顺序、缺一不可：【画幅风格】→【场景资产】→【核心人物】→【站位声明】→【时间轴分镜】→【音效】→【强制禁止项】。',
        '【站位声明】每人写**六要素**（位置 / 依托物 / **身后背景物** / 朝向 / 姿态 / **手头事务**）。'
        + '例外：跨场景段、车内/走廊/人群等无固定依托物的段，允许只写「位置 · 朝向 · 手头事务」三项，不要硬凑「身后：无」——真实交付稿这类段就是三个字段，硬凑反而让模型去编一个不存在的背景物。三条硬口径（实测 5 镜里 4 镜踩坑）：'
        + '① 身后背景物必须用「身后：墙/门/窗/家具」这类字样显式写出，光写「背靠/依托」不算背景锚（C17c 只认「身后/背后/侧后」，语义对但词不对仍判 WARN）；'
        + '② 手头事务每人必写，没有就写 `手头事务：无—全神注视对手`（用破折号，**不要用括号**：`无（全神注视对手）` 的嵌套括号会让 C40c 把一个人算成两个人，误报缺事务）；'
        + '③ 双人/多人戏里即使对方在画外或不入画，也必须用 @角色名 具名指代，**禁止写「对方」「他」「那个女人」**——不具名会让参考图绑定丢人、下一镜指代不清。',
        '版本按锁卡执行（2.5 / 2.0 语法彻底分开，禁混写）；有台词的镜行必须写「台词：【角色（语气）："…"】」语气位；镜行五要素（景别/焦段/机位角度/运镜/用途标签）齐全。',
        '【时间轴镜头数 · C2 硬约束】镜头数不得超过 段长÷3 秒（4~6s→≤2 镜、7~8s→≤2 镜、9~11s→≤3 镜、12~14s→≤4 镜、15s→≤5 镜、16~20s→≤6 镜、21~25s→≤8 镜、26~30s→≤10 镜）。分镜表给的子镜头若超出，按剧情顺序合并相邻子镜头（合并运镜，不要删剧情动作），保证镜头数达标——镜头数超限会被 C2 直接判失败。',
        '【分镜九字段分流 · 分镜表的 visual 里已写好「画面/状态/光影/色调/重音/人声/音效」，按下列分派，不要整段照搬】画面 + 状态 →【时间轴分镜】的动作与人物表演（进镜姿态→出镜姿态要能看出来）；光影 + 色调 →【画幅风格】的影调与色温、【场景资产】的光位来源（色值只作选色参考，不要堆成 #XXXXXX 技术参数串）；重音 → 只用于台词语气位（写法「【角色（语气）：台词】」），不进正文；人声 + 音效 →【音效】栏（环境音、动作音、音桥入/出）。「光影：」「色调：」「重音：」这类栏位名本身严禁出现在投喂正文里（栏位名外溢会被 C12 判工作流规则词）。',
        '【参考标签 · 硬校验，缺一即失败】参考素材按给出的顺序，必须在正文栏位里用「@图片N / @音频N / @视频N（参考图N）」把每一个标签【原样逐个】写出，一个都不能漏；不得只写素材名字而不写 @图片N，不得新造编号；2.0 禁写首尾帧。',
        '【位置权威 · 一处定义，处处引用（C17f）】段首【站位声明】是本段**唯一**的画面位置权威。若分镜数据里已给出「段首站位声明」，**直接沿用它的左右关系与轴线**（那是分镜阶段锁定的），不要自己重新判断谁在左谁在右——自行重排是本项目越轴的第一来源。时间轴镜行只写动作与相对关系（「走向 @怀亚特」「站定在 @怀亚特 面前」），**禁止在镜行里重复写「@某某 位于画面左/右/中央」**——重复声明会和站位声明打架，模型按镜行重新布局就会造成越轴与站位漂移。镜头需要指示方向时用「向画面右前迈步」这类运动方向词，不要描述他人的绝对左右。',
        '【世界锚 · C26a 必写】每条【画幅风格】行必须写明**年代锚**（年份或年代 + 技术时代），如「当代 2020 年代，智能终端普及」「民国初年」。不写年代，模型会回落到自己的默认年代（实测：设定 2035 年出片成 80 年代街景）。分镜表没给年代时，按项目「画面风格」与剧情道具（手机/平板/F1 赛车）推断并写明。',
        (() => {
          const seam = String(ctx.project?.seam || 'auto');
          const tail = '全段最后一镜行尾必须写「末 1 秒全体保持姿态与站位、动作完全静止，画面定格。」，禁止写「接口余量 0.5 秒」这类硬切写法';
          const cut = '全段最后一镜行尾必须写「接口余量 0.5 秒：保留未收死的运动。」，禁止写「画面定格」';
          const blank = '全段以收尾空镜结束，最后一镜行尾写「末镜为收尾空镜，画面静止无人物动作。」';
          const pick = seam === 'hard_cut' ? cut : seam === 'empty_shot' ? blank : tail;
          return '【段缝末镜 · 本项目 D 锁 = ' + seam + '，照它写死，不要自己换】' + pick + '。缺这句会被 C11b 判缺定格。';
        })(),
        '【画外音 / OS / VO · C14 硬约束】分镜表里的「角色（画外）：…」是画外音，不是画内台词：该镜台词字段一律写「台词：无。」，改在**这一镜在【时间轴分镜】里那一行的「声音：」**（注意是镜行内，不是七段式的【音效】段）写「画外·内心独白（OS·角色音色）："原文"」并补「（画面中角色双唇闭合，未开口）」作为口型证据——这样时间对位准确、配音知道哪一镜该出声。正确示例（照这个结构写）：`00:06-00:12 [镜头2] 中近景 · 85mm · 侧45度平视 · 固定。@斯洛恩 双手扶护栏，目光投向赛道；声音：画外·内心独白（OS·斯洛恩音色）："I gave up my family fortune."（画面中斯洛恩双唇闭合，未开口）。台词：无。`把 OS/VO 塞进台词字段会被 C14 直接判失败；【音效】段只汇总环境声与动作声，不要重复 OS 原文（重复会被念两遍）。',
        '【参考标签写法 · 决定 C26e 是否 FAIL】绑定参考图的主体只写紧凑一行：`@图片1 · 姜知微（参考图1，声线锁：低沉克制）`。**严禁**在标签后面再写年龄 / 发型 / 服装 / 材质 / 场景细节等外貌描述——全能参考会直接吃参考图，二次文字介绍反而抢图片权重，C26e 判「冗余二次介绍」直接失败。人物外貌、场景陈设全部交给参考图，文字只负责「谁是谁、站在哪、在做什么」。',
        '【强制禁止项 · 3 条以内，短句】固定骨架：① 画面：禁水印（含 Logo）、禁字幕条与文字贴片；② 音频：背景音乐音量低于人声、不压人声；'
        + '③ 只按本段实际最可能翻车的一项加一条（换人/换装/越轴/道具跳变/人物瞬移，挑一个，不要全列）。禁止写成长清单、禁止抄模板空话——真实交付稿这一栏就是两三条，写满六条反而抢正文权重。',
        '【音效】只写现场能听到的声音（环境音 / 动作音 / 人声气口），按时间顺序罗列；不写「后期贴声」「配音」「混音」「由后期处理」这类制作说明——投喂稿里出现流程词会被当成画面内容。',
        '要求：只输出七段式提示词正文，不要任何解释、标题或 Markdown 围栏；提示词只写画面、动作、光线与声音本身。',
      ]
    : [
        skillText,
        '你是视频提示词撰写助手：严格按上面的技能规范，为一条 MiniMax H3 分镜写「完整的视频提示词」。',
        nativeH3
          ? '当前工作流是原生 MiniMaxH3ReferenceToVideo（多模态参考 Ref2VA）：必须输出官方 Ref2VA 六段式（subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music），正文全英文。**严禁输出任何指令行**——规范里的 I2VA / FL2VA / L2VA 指令行（如 "For the target video, at 0.00 seconds..." / "How the reference pictures align with the target video..."）只适用于首尾帧模式，Ref2VA 没有指令行，第一行必须直接是 subject_definitions；正文里也不许出现 "from Shot 1" / "aligns with the X-second mark" 这类首尾帧对齐语句。禁止出现 __MINIMAX_H3_REF_N__。'
          : '当前工作流是项目内置 MiniMaxH3Easy：参考素材按给出的顺序编号，必须逐个用 __MINIMAX_H3_REF_N__ 引用，不得新造编号。',
        '要求：只输出提示词正文，不要任何解释、标题或 Markdown 围栏；',
        nativeH3
          ? '【标签用法 · 官方铁律，必守】<Picture N> / <Audio N> / <Video N> 【只在 subject_definitions 里出现一次】，用来把主体的外观/音色绑定到第 N 个参考槽，写法如 "<Subject 1> is the young woman in Picture 1: ..." / "<Audio 1> is the voice of <Subject 1> (S1)"。**detailed_description 等正文里绝对禁止出现 <Picture N> / <Video N> 标签**——正文只能用 subject_definitions 已定义的 <Subject N> 指代人物/场景/道具，用 (Sx) 指代说话人。把 <Picture 2> 当成人在正文里写 "<Picture 2> stands..." 是错的（Picture 是图槽号不是主体），必须写 "<Subject 2> stands..."。'
          : '参考素材按给出的顺序编号，必须逐个用 __MINIMAX_H3_REF_N__ 引用，不得新造编号；',
        nativeH3
          ? '参考图只作角色/场景/道具的外观与空间参考，不要把它当成首帧或尾帧；参考音频只作音色参考，不要当环境音。'
          : '参考图仅作角色/场景/道具的外观与风格参考（对应 <Subject>），禁止把参考图本身当作首帧/尾帧/关键帧（不要写 <Picture>），也禁止把参考图（角色三视图/场景九宫格/道具板）原样或作为插帧出现在成片画面里；参考图所代表的角色/场景/道具应自然融入画面。',
        nativeH3
          ? '【跨镜锁定门禁 · 逐镜必过】严格对照 h3-format.md「跨镜锁定自检清单」与 h3-shot-grammar.md §1.16/§四、spatial-anchor-and-hold.md §8 自检六条：①相邻镜换主体/说话人，机位角度或景别至少换一样（否则 H3 原地闪现两人）②人数场景不变的固定站位戏：全员从 [Shot 1] 就在场、站位锁死、切镜只切机位/景别/看向谁；换视角时其他人写成【无 <Subject> 标签】的虚化肩背/后影（the softened back of ... / an out-of-focus shoulder at the frame edge），并在段内写站位锁死句（Every person keeps this position and facing...）——这是合法换视角，不是退场，严禁为过机检硬写 steps into frame / leaves frame（那是擅自加剧情动作）。只有剧情真的有人来/走才写入退场。③首镜无时间戳、后续 "At MM:SS.mmm," 严格递增、一镜一时戳 ④单镜 ≤100 词、同框带标签主体 ≤2 人 ⑤<Subject N> 编号固定不换主体、正文只用 <Subject N>、禁写 <Picture N>/<Video N> 标签（Picture 只在定义段出现）⑥越轴只写正向不变式、不写 line/axis/frame。写完逐镜自查，这是实测高频 FAIL，不得依赖机检重试补救。'
          : null,
        nativeH3
          ? '【画外声/电话音/VO · 严格按上面 h3-format.md §4.2补 / §4.3 官方规则执行】画外声源自具体人物时【必须给 (Sx)】，用官方固定公式 "says in an off-screen voiceover: <d>[Chinese] …</d> while … lips remain completely closed"，并写明声源（如 comes through the phone speaker）。音色参考按 §4.2补判定：【有音色音频文件】才在 subject_definitions 定义 <Audio N> 并绑 (Sx)；【无音色文件】只用文字描述音质（a deep, steady male voice），不定义 <Audio N>，但 (Sx) 照给、闭口证据照写。禁止用任何项目私有「A/B 两档」简化口径覆盖官方规则。'
          : null,
        '提示词正文只写画面、动作、光线与声音本身。',
      ];
  const parts = [...base];
  if (stateCard) {
    const tail = opt.tailFrame || {};
    if (isSeedance) {
      // Seedance 七段式：衔接写进【站位声明】栏（中文栏位），绝不塞 H3 的英文 detailed_description/[Shot 1]。
      const sdAnchor = [
        '【跨段衔接 · Seedance 七段式 · 本批第一镜必须执行】',
        'Seedance 零跨段记忆，只认本段文字复述，不认"同上/如前"。本批【第一镜的【站位声明】栏】必须逐条承接下面这张【上一段段尾站位卡】：人物站位、朝向、手部/道具状态、机位侧全部继承；只有剧情明确要求移动时才写"谁从哪动到哪"。',
        '上一段段尾站位卡：\n' + stateCard,
        tail.shotSize ? '景别承接：上一段末镜景别是 "' + tail.shotSize + '"，同一机位沿用段景别保持一致。' : '',
        tail.facing ? '朝向承接：上一段末镜朝向是 "' + tail.facing + '"，不得改成相反方向。' : '',
        '把承接事实写进【站位声明】栏，不要新造 @图片/@音频 编号，不要写 H3 的英文段名。',
      ].filter(Boolean).join('\n');
      parts.push(sdAnchor);
    } else {
      // h3 全流程 H51/H52/H53/H54/H58：段尾站位卡是衔接必须品，且必须写进【投喂正文】——
      // H3 零跨段记忆，只认本段文字复述，不认"上一批/如前/同上"。把这三条逐字写进 [Shot 1] 首句。
      const hardAnchor = [
        '【跨段衔接 · 硬锚点 · 本批第一镜必须逐字执行（h3 spatial-anchor-and-hold.md §9 H51/H52/H53/H54/H58）】',
        '以下是【上一段段尾站位卡】——写 detailed_description 时，本批【第一镜 [Shot 1] 的第一句】必须【逐字】包含这句续接句：',
        TAIL_CONTINUATION_LINE,
        '随后逐字复述上一段段尾站位事实（谁在哪、面朝哪、手在哪/拿什么、道具状态、机位在哪一侧、末镜定格）——这是"从上一段末帧同一姿势继续"的指令，不是引用；严禁写 same as previous / as before / 同上。',
        '上一段段尾站位卡：\n' + stateCard,
        tail.shotSize ? '景别锁（H54）：上一段末镜景别是 "' + tail.shotSize + '"，若本批第一镜沿用同一机位，景别单词必须逐字相同，禁用区间/模糊词。' : '',
        tail.facing ? '朝向锁（H53）：上一段末镜朝向是 "' + tail.facing + '"，本批必须逐段重述，不得改成相反方向。' : '',
        '只有剧情明确要求人物移动时才写"谁从哪动到哪、怎么动"；无变动就逐字沿用，绝不靠猜、绝不让人重入画（nobody re-enters, nothing is re-staged）。',
      ].filter(Boolean).join('\n');
      parts.push(hardAnchor);
    }
  }
  if (opt.batchMode) {
    parts.push(opt.batchFormatInstruction || '');
  }
  return parts.filter(Boolean).join('\n\n');
}

async function writeShotVideoPrompt(ctx, shotId) {
  const shot = Shots.get(shotId);
  if (!shot || shot.project_id !== ctx.projectId) throw new Error('分镜不存在');
  if (ctx.llmDisabled) throw new Error('本批已禁用 LLM（渲染批次）：不能生成提示词。请在渲染之外的批次里生成。');
  const assets = Assets.list(ctx.projectId);
  // 只解析参考素材（不上传）：占位符必须与真正会绑定的媒体顺序一致，否则提示词里引用的
  // __MINIMAX_H3_REF_N__ 会和实际传入的图/音对不上。
  const isText = shot.mode === 'text';
  const { references, characterDesc, sceneDesc } = isText
    ? { references: [], characterDesc: '', sceneDesc: '' }
    : await assembleShotReferences({ cfg: ctx.cfg, project: ctx.project, shot, assets, upload: false });

  // 按项目视频模型分流规范（两端各自是一套完整全流程技能，规则与机检同源）：
  // - seedance25/20 → short-drama-director（漫剧老李全流程）：model-adapters.md 七段式语法 + 语速/画幅/段缝/投喂清单全文，前置无人值守锁卡；
  // - h3 → forest-laoli-h3（H3 全流程）：适配层 + h3-format / 镜语法 / 空间锚点 / 物理 / 表演 / 台词 / 氛围 / 机检对照全文，六段式。
  // 全文不裁剪；仅当 skill/reference 缺失时回退内联常量 H3_REF2VA_FORMAT_RULES。
  const videoModel = String(ctx.project?.video_model || 'h3');
  const isSeedance = videoModel.startsWith('seedance');
  const loadedSpec = loadVideoPromptSkillSpec(ctx.cfg, videoModel);
  const skillText = (isSeedance ? loadedSpec : (loadedSpec || H3_REF2VA_FORMAT_RULES))
    || H3_REF2VA_FORMAT_RULES;
  // 当前视频规格如果是原生 MiniMaxH3ReferenceToVideo，提示词必须走官方六段式；
  // 内置 Easy 节点仍走平铺 __MINIMAX_H3_REF_N__ 占位符。两套标签不能混用。
  const videoSpec = getSpecForKind(ctx.cfg, 'r2v');
  const nativeH3 = !isSeedance && videoSpec?.promptFormat === 'minimax-ref2va';
  let imageOrd = 0;
  let audioOrd = 0;
  let videoOrd = 0;
  const refLines = references.map((r, i) => {
    if (isSeedance) {
      // Seedance 七段式：中文参考素材标注，机检认「参考图N / 图N」；逐条标用途。
      const cn = r.type === 'audio' ? '音频' : r.type === 'video' ? '视频' : '图片';
      return '@' + cn + (i + 1) + '（参考图' + (i + 1) + '） = ' + (r.label || '参考素材') + '（用途：' + (r.type === 'audio' ? '锁定音色' : r.type === 'video' ? '锁定动作/运镜' : '锁定外貌/空间') + '）';
    }
    if (!nativeH3) {
      return '__MINIMAX_H3_REF_' + (i + 1) + '__ = ' + (r.type === 'audio' ? '音色：' : '图片：') + (r.label || '参考素材');
    }
    const tag = r.type === 'audio'
      ? '<Audio ' + (++audioOrd) + '>'
      : r.type === 'video'
        ? '<Video ' + (++videoOrd) + '>'
        : '<Picture ' + (++imageOrd) + '>';
    return tag + ' = ' + (r.type === 'audio' ? '音色：' : '图片：') + (r.label || '参考素材');
  });
  const sys = buildVideoPromptSystem(ctx, { skillText, isSeedance, nativeH3 });
  const user = [
    '项目风格：' + (ctx.project.style || '未指定'),
    '时长：' + (shot.duration || 5) + ' 秒',
    shot.scene_name ? '场景名：' + shot.scene_name : '',
    // 段首站位声明是分镜阶段就定好的「方位唯一权威」（老李 model-adapters.md §5.0）。
    // 此前只落库不投喂，模型只能从 visual 自己推左右关系 —— 推出来的和分镜阶段锁的往往不是
    // 同一套，这正是越轴与「东一个西一个」的来源。这里原样给它，并要求逐字沿用。
    shot.blocking
      ? '段首站位声明【本段唯一方位权威 · 必须原样沿用，禁止另起一套左右关系】\n' + shot.blocking
        + '\n写法要求：把它翻译成【站位声明】栏，人物顺序、左右关系、朝向、手头事务、轴线锁定句、位移范围全部照抄；'
        + '不得因为镜行里出现了别的方向描述就换边；不得新增分镜阶段没写的位移。'
      : '',
    shot.camera ? '镜头：' + shot.camera : '',
    shot.visual ? '画面：' + shot.visual : '',
    shot.dialogue ? '台词：' + shot.dialogue : '',
    shot.sub_shots ? '子镜头时间轴：' + shot.sub_shots : '',
    characterDesc ? '角色一致性：' + characterDesc : '',
    sceneDesc ? '场景一致性：' + sceneDesc : '',
    refLines.length
      ? '参考素材（顺序固定）：\n' + refLines.join('\n')
      : (isSeedance
        ? '参考素材：无（纯文生，不要写 @图片N / @音频N / @视频N 标注）'
        : nativeH3
          ? '参考素材：无（纯文生视频，不要写 <Picture N> / <Audio N> / <Video N> 标签）'
          : '参考素材：无（纯文生视频，不要写任何 __MINIMAX_H3_REF_N__ 占位符）'),
  ].filter(Boolean).join('\n');

  // 思考型模型（deepseek-flash 等）的 reasoning_content 与正文 content 共用 max_tokens 预算。
  // 实测：同一条写提示词请求，开思考时 reasoning 吃掉约 66% 预算（3496/5303 token），
  // 正文被挤到 finish_reason=length、六段写不全；关思考后正文更长更完整、耗时减半、质量无损。
  // 故写提示词显式关闭思考（只此一处，经 llmChat 的 thinking 参数透传，其他 LLM 环节不受影响）。
  // maxTokens 保留 8000 作为正文的充足预算（不碰全局 rewriteMaxTokens）。
  // maxTokens 保留 8000 作为正文的充足预算（不碰全局 rewriteMaxTokens）；2.5 的 25–30s 段
  // 七段式正文长一倍以上（实测 10 个子镜约 3500–4500 字），8000 会在【时间轴分镜】中途 stop，
  // 所以按段长追加预算（每多 1 秒 +400 token，上限 16000）。
  const baseTok = Math.max(2048, Number(ctx.cfg.llm?.rewriteMaxTokens) > 4000 ? Number(ctx.cfg.llm?.rewriteMaxTokens) : 8000);
  const maxTokens = Math.min(16000, baseTok + Math.max(0, Math.round((Number(shot.duration) || 5) - 15) * 400));
  const want = new Set(refLines.map((l) => l.split(' =')[0]));
  let reason = '未知原因';
  let feedback = '';
  // 两次都失败时把最后一次输出留档：不落日志就只剩一句「未引用参考素材」，
  // 分不清是模型漏写标签、还是标签写法不同（写成 @图片1 却没写（参考图1））、还是正文被截断。
  let lastOut = '';
  let lastFin = '';
  // 【2.5 长段分批撰写】25–30s 段（段内 ≥7 个镜头）一次写不完：实测同一模型在带规则上下文时
  // 单次正文只有 1300–2200 字（纯生成能到 2700+），而 30s 段完整七段式要 3500–4500 字，
  // 必然在【时间轴分镜】中途 stop（finish_reason=stop），随后被判「未引用参考素材」、整条稿作废。
  // 改为三段组装：① 前四栏 ② 时间轴每 5 镜一批（用精简 system，不再重复注入 150KB 规则）③ 音效+禁止项，
  // 组装后统一跑机检。H3 六段式与短段仍走原来的单次生成。
  if (isSeedance) {
    const subLines = String(shot.sub_shots || '').split(/\n+/).map((x) => x.trim()).filter(Boolean);
    if (subLines.length >= 7) {
      return await writeSeedanceLongShot(ctx, { shot, sysFull: sys, userBase: user, refLines, want, maxTokens, subLines });
    }
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    // 重生补气：上一轮哪怕只是「未引用标签」或机检 FAIL，也把具体原因回灌给模型，
    // 让它知道缺哪几个标签/哪条 FAIL 要补；旧版两次请求 messages 完全相同，只换 temperature，等于盲重试。
    if (attempt > 0 && reason && reason !== '未知原因') {
      feedback = reason.startsWith('机检未通过')
        ? '机检未通过，只针对以下 FAIL 项补正（WARN 不用管）：\n' + conciseCheckFeedback(reason.replace(/^机检未通过：\s*/, ''))
        : reason;
    }
    const userThisAttempt = feedback
      ? user + '\n\n【上一轮未通过 · 必须针对以下问题补正后重新输出完整提示词】\n'
        + feedback.slice(0, 2500)
        + '\n请修正全部问题后重新输出完整正文：六段/七段一个不少、参考标签逐个引用、台词逐字保留、不写任何解释。'
      : user;
    const r = await llmChat(ctx.cfg.llm, [{ role: 'system', content: sys }, { role: 'user', content: userThisAttempt }], {
      temperature: attempt > 0 ? 0.4 : 0.7,
      maxTokens,
      thinking: { type: 'disabled' }, // 仅写视频提示词关思考，避免 reasoning 抢预算导致 finish_reason=length
    });
    const out = String(r.content || '').trim().replace(/^```[a-z]*\n?|```$/g, '').trim();
    lastOut = out;
    lastFin = r.finishReason || '';
    if (!out) { reason = 'LLM 返回为空'; continue; }
    if (r.finishReason === 'length') { reason = 'LLM 输出被截断（达到长度上限）'; continue; }
    if (isSeedance) {
      // 七段式：七个【】栏位齐全（C 交付固定 md，不出看板）
      const SEEDANCE_SECTIONS = ['【画幅风格】', '【场景资产】', '【核心人物】', '【站位声明】', '【时间轴分镜】', '【音效】', '【强制禁止项】'];
      const missingSections = SEEDANCE_SECTIONS.filter((s) => !out.includes(s));
      if (missingSections.length) {
        reason = 'LLM 未输出完整七段式，缺少栏位 ' + missingSections.join('、');
        continue;
      }
      const missingRefs = [...want].filter((tag) => !sdRefTagPresent(out, tag));
      if (missingRefs.length) { reason = 'LLM 未引用参考素材 ' + missingRefs.join('、'); continue; }
    } else if (nativeH3) {
      if (!isOfficialMinimaxPrompt(out)) {
        reason = 'LLM 未输出完整官方六段式（subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music）';
        continue;
      }
      // Ref2VA 严禁指令行：LLM 读全文规范后常凭手感加 I2VA/FL2VA 指令行 → 参考帧错位。
      if (hasRef2vaInstructionLine(out)) {
        reason = 'LLM 输出含 Ref2VA 禁用的首尾帧指令行（How the reference pictures align / from Shot N 等）；Ref2VA 第一行必须直接是 subject_definitions';
        continue;
      }
      const missing = [...want].filter((tag) => !refTagPresent(out, tag));
      if (missing.length) { reason = 'LLM 未引用参考标签 ' + missing.join('、'); continue; }
    } else {
      const got = new Set(out.match(REF_PLACEHOLDER_RE_G) || []);
      const missing = [...want].filter((x) => !got.has(x));
      if (missing.length) { reason = 'LLM 未引用参考占位符 ' + missing.join('、'); continue; }
    }
    // 机检门禁：写完投喂稿后由后端跑对应模型的 Python 机检脚本（H3 线 h3_lint + h3_finalcheck）。
    // 存在真实 FAIL 时带着机检反馈重试一次；机检无法执行（无 Python/脚本缺失/用法错误）不阻断。
    const check = checkVideoPrompt(ctx.cfg, ctx.project?.video_model, shot, out);
    if (!check.ok) {
      reason = '机检未通过：\n' + check.detail;
      continue;
    }
    Shots.update(shot.id, { video_prompt: out, error: '' });
    ctx.report({ phase: '分镜提示词', detail: '已生成分镜 ' + shot.idx + ' 的视频提示词' });
    return JSON.stringify({ shot_id: shot.id, idx: shot.idx, video_prompt: out, refs: references.length });
  }
  logger.warn('写视频提示词失败', { shot: shot.idx, reason, head: lastOut.slice(0, 800), len: lastOut.length, fin: lastFin });
  throw new Error('生成视频提示词失败（' + reason + '），分镜 ' + shot.idx + ' 的提示词未改动。');
}
// 2.5 长段（段内 ≥7 镜，通常 25–30s）分批撰写：三段 LLM 调用组装一份完整七段式，最后统一机检。
// 为什么不用「一次写完 + 截断重试」：截断后重试只会再截一次，因为瓶颈是模型单次正文长度，不是提示词。
// Seedance 参考标签判定：want 里的标签长这样「@图片1（参考图1）」，但规范要求主体写成
// 「@图片1 · 姜知微（参考图1，声线锁：…）」——整串连匹会永远不命中，把合格稿判成「未引用参考素材」
// （实测：模型照规范写，仍被判缺全部 6 个标签、整条稿作废）。这里只核「@图片N / @音频N / @视频N」本身。
function sdRefTagPresent(text, tag) {
  const m = String(tag || '').match(/^@(图片|音频|视频)(\d+)/);
  if (!m) return String(text || '').includes(tag);
  return new RegExp('@' + m[1] + m[2] + '(?!\\d)').test(String(text || ''));
}
function sdTimelineLineNo(line) {
  const m = String(line || '').match(/^\s*(\d+(?:\.\d+)?)\s*[-–~]\s*(\d+(?:\.\d+)?)\s*s?\s*(.*)$/);
  if (!m) return null;
  const toSec = (x) => {
    const n = Number(x);
    return Number.isFinite(n) ? n : 0;
  };
  return { from: toSec(m[1]), to: toSec(m[2]), body: m[3] || '' };
}
function sdFmtTs(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

async function writeSeedanceLongShot(ctx, opt) {
  const { shot, sysFull, userBase, refLines, want, maxTokens, subLines } = opt;
  const dur = Number(shot.duration) || 5;
  const SECTIONS = ['【画幅风格】', '【场景资产】', '【核心人物】', '【站位声明】', '【时间轴分镜】', '【音效】', '【强制禁止项】'];
  const BATCH = 5;
  const batches = [];
  for (let i = 0; i < subLines.length; i += BATCH) batches.push(subLines.slice(i, i + BATCH));
  const call = (messages, mt, temp) => llmChat(ctx.cfg.llm, messages, {
    temperature: temp, maxTokens: mt, thinking: { type: 'disabled' },
  });
  const clean = (t) => String(t || '').trim().replace(/^```[a-z]*\n?/i, '').replace(/```\s*$/, '').trim();

  // 台词逐字约束：分批写时模型只看得到镜头清单、看不到 dialogue 字段，会自己编台词
  // （实测：原文「名单上没有我，对吧？」被写成「你早就知道，是不是。」）。因此每批都把全段台词
  // 原样给出并标记已用过的句子，最后核对「原文是否逐字出现」，被改写就整轮重来。
  const dlgLines = String(shot.dialogue || '').split(/\n+/).map((x) => x.trim()).filter(Boolean);
  const usedDlg = new Set();
  let reason = '未知原因';
  let lastOut = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    usedDlg.clear();
    const fb = attempt > 0 ? '\n\n【上一轮未通过 · 必须修正】\n' + String(reason).slice(0, 1500) : '';
    // ① 前四栏（画幅风格 / 场景资产 / 核心人物 / 站位声明）
    const r1 = await call([
      { role: 'system', content: sysFull },
      { role: 'user', content: userBase
        + '\n\n【本批任务】这是一条 ' + dur + ' 秒的长段（段内 ' + subLines.length + ' 个镜头），投喂稿分三批写。'
        + '本批只输出前四个栏位：' + SECTIONS.slice(0, 4).join('') + '。'
        + '严禁输出【时间轴分镜】【音效】【强制禁止项】（下一批补写）。'
        + '【站位声明】每人不许省六要素（位置 / 依托物 / 身后背景物 / 朝向 / 姿态 / 手头事务）。' + fb },
    ], Math.min(6000, maxTokens), attempt > 0 ? 0.4 : 0.7);
    let head = clean(r1.content);
    const missedHead = SECTIONS.slice(0, 4).filter((x) => !head.includes(x));
    if (missedHead.length) { reason = '第一批（前四栏）缺栏位 ' + missedHead.join('、'); continue; }

    // ② 时间轴：每 5 镜一批，换精简 system（不重复注入全量规则，省 token 也避免再触发长度上限）
    const tlLines = [];
    let prevTail = '';
    let tlFail = '';
    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi];
      const noFrom = bi * BATCH + 1;
      const sys2 = [
        '你是 Seedance 七段式投喂稿的【时间轴分镜】撰写助手。只输出镜头行，不要输出任何【】栏位名、不要解释、不要 Markdown 围栏。',
        '每行格式：MM:SS-MM:SS [镜头k] 景别 · 焦段 · 机位角度 · 运镜（用途）。画面主体：…；动作与神态：…；声音：…；台词：无 或 台词：【角色（语气）："原文"】',
        '硬口径：① 镜行禁止写「位于画面左/右/中央」这类绝对位置（位置权威只在段首【站位声明】）；② 台词一字不改、只写在「台词：」栏；③ 人物用 @角色名 具名指代，禁止「他/她/对方」；④ 严格按给定起止与镜头号，不合并、不增删镜头；'
        + '⑤ 画外音（OS/VO/旁白）：标了「（画外）」「（OS）」「（VO）」「（旁白）」的台词**禁止写进台词栏**——该镜写「台词：无。」，把「画外·内心独白（OS·角色音色）："原文"」写进这一镜的「声音：」栏，并在同句补「（画面中角色双唇闭合，未开口）」作为口型证据。',
      ].join('\n');
      const user2 = [
        '段长：' + dur + ' 秒｜本批是第 ' + noFrom + '–' + (noFrom + batch.length - 1) + ' 镜（全段共 ' + subLines.length + ' 镜）',
        // 段缝末镜句只属于全段最后一镜：逐批都给会让每批末镜都写定格句（成片段段静止）。
        (bi === batches.length - 1
          ? '段缝锁（本批含全段最后一镜）：' + (() => {
            const seam = String(ctx.project?.seam || 'auto');
            if (seam === 'hard_cut') return '换机位硬切——最后一个镜头行尾必须写「接口余量 0.5 秒：保留未收死的运动。」';
            if (seam === 'empty_shot') return '空镜过渡——全段以收尾空镜结束，最后一镜行尾写「末镜为收尾空镜，画面静止无人物动作。」';
            return '尾帧锚定——最后一个镜头行尾必须写「末1秒全体保持姿态与站位，动作完全静止，画面定格。」';
          })()
          : '本批不是全段最后一批：末镜行尾不要写定格句/接口余量句（那是全段最后一镜的事）。'),
        '段首站位声明（位置权威，照它写，不要改写、不要重复绝对位置）：',
        (head.match(/【站位声明】[\s\S]*?(?=\n【|$)/) || [''])[0].slice(0, 1200),
        prevTail ? '上一批最后一镜（衔接用，不要重复写它）：\n' + prevTail : '',
        '本批镜头清单（逐条写成镜头行，时间点照抄）：\n' + batch.map((l, i) => {
          const p = sdTimelineLineNo(l);
          return p ? (sdFmtTs(p.from) + '-' + sdFmtTs(p.to) + '  ' + p.body) : l;
        }).join('\n'),
        '参考素材标注（若本批镜头里有人物/场景开口或出现，用这些标签指代）：' + (refLines.length ? refLines.map((x) => x.split(' =')[0]).join('、') : '无'),
        dlgLines.length
          ? ('本段台词（必须逐字照抄，禁止改写/意译/缩写/新增/合并；一句只能出现在一个镜头；写法「台词：【角色（语气）：\"原文\"】」；本批镜头没有开口点就都写「台词：无」，把台词留给后面的镜头）：\n'
            + dlgLines.map((d, i) => '  ' + (i + 1) + '. ' + d + (usedDlg.has(d) ? '  ← 已在前批使用，本批不得重复' : '')).join('\n'))
          : '本段无台词：所有镜头写「台词：无」。',
        (bi === batches.length - 1 && dlgLines.some((d) => !usedDlg.has(d)))
          ? ('【最后一批 · 必须消化 · 逐条落到指定镜头】下面每句台词都指定了落点，照它写，禁止漏写/改字/挪到别镜/塞进声音栏：\n'
            + (() => {
              // 落点选择：优先「特写 / 近景 / 中近景」的镜头行（开口点通常在这些景别），不够再按顺序补。
              const pending = dlgLines.filter((d) => !usedDlg.has(d));
              const pool = batch
                .map((l, i) => ({ l, no: noFrom + i }))
                .sort((a, b) => {
                  const rank = (x) => (/特写/.test(x.l) ? 0 : /近景/.test(x.l) ? 1 : /中近景/.test(x.l) ? 2 : 3);
                  return rank(a) - rank(b);
                });
              return pending.map((d, i) => '  · 第 ' + (pool[i % pool.length] ? pool[i % pool.length].no : noFrom) + ' 镜：「' + d + '」').join('\n');
            })())
          : '',
        (bi === batches.length - 1 && fb) ? fb : '',
      ].filter(Boolean).join('\n');
      const r2 = await call([
        { role: 'system', content: sys2 },
        { role: 'user', content: user2 + (tlFail ? '\n\n【上一轮这批不合格 · 修正】\n' + tlFail : '') },
      ], 4000, 0.6);
      const got = clean(r2.content)
        .replace(/^\s*【时间轴分镜】\s*$/gm, '')
        .split(/\n+/).map((x) => x.trim()).filter(Boolean)
        .filter((x) => /\[\s*镜头\s*\d+\s*\]|^\d{2}:\d{2}/.test(x));
      if (got.length < Math.max(1, batch.length - 1)) {
        tlFail = '本批应写 ' + batch.length + ' 个镜头，实际只识别到 ' + got.length + ' 行。请按给定清单逐条写全。';
        reason = '第二批（时间轴 ' + noFrom + '–' + (noFrom + batch.length - 1) + '）行数不足：' + got.length + '/' + batch.length;
        break;
      }
      const gotText = got.join('\n');
      for (const d of dlgLines) {
        const say = String(d).replace(/^[^：:]{1,16}[：:]\s*/, '').trim();
        if (say && gotText.includes(say)) usedDlg.add(d);
      }
      tlLines.push(...got);
      prevTail = got[got.length - 1].slice(0, 200);
      tlFail = '';
    }
    if (!tlLines.length || tlLines.length < subLines.length - 1) {
      if (!/行数不足/.test(reason)) reason = '时间轴镜头行不足：' + tlLines.length + '/' + subLines.length;
      continue;
    }

    // ③ 音效 + 强制禁止项（只写这两栏，短）
    const sys3 = [
      '你是 Seedance 七段式投喂稿的收尾栏撰写助手。只输出两个栏位，顺序固定：【音效】然后【强制禁止项】。不要输出其它栏位、不要解释。',
      '【音效】只写环境声/动作声/人声气口，按时间顺序一句；**画内已说出的台词不要在这里重复**（只有画外音 OS/VO 才写说话人身份与原文，形如「画外（角色 OS）："原文"」。',
      '【强制禁止项】只写本段禁止出现的事（换人、换装、越轴、加字、加字幕条、人物瞬移、道具跳变等），按本段实际风险写 3–6 条，不要抄模板空话。',
    ].join('\n');
    const r3 = await call([
      { role: 'system', content: sys3 },
      { role: 'user', content: [
        '场景：' + (shot.scene_name || '') + '｜时长 ' + dur + ' 秒',
        (() => {
          const osLines = dlgLines.filter((d) => /[（(]\s*(画外|OS|VO|旁白)/i.test(d));
          return '音效栏只写环境声与动作声，禁止复制任何台词原文'
            + (osLines.length ? '（本段画外音已写在各镜「声音：」栏，这里不要重复）' : '') + '。';
        })(),
        '段缝锁：' + (ctx.project?.seam || 'auto'),
        '本段镜头数：' + tlLines.length,
        // 音效栏要能和时间轴对得上：把镜行里已写的「声音：」摘要给它，避免模型另编一套
        // （实测：不喂这份素材时，音效栏写出了原片根本没有的「手拍车顶」「车门把手」）。
        '各镜已写的现场声（以此为准，按时间顺序整合成一段，宁可少写不要新增剧情动作声）：\n'
        + tlLines.map((l) => '  · ' + ((l.match(/声音[：:]\s*([^；;\n]+)/) || [])[1] || '（未写）')).join('\n'),
      ].join('\n') },
    ], 2000, 0.6);
    const lostDlg = dlgLines.filter((d) => !usedDlg.has(d));
    if (lostDlg.length) {
      reason = '台词没有逐字落地（被改写或漏写）：' + lostDlg.join('｜').slice(0, 200) + '。请把这些台词原样写进某个镜头的「台词：」栏，一字不改。';
      continue;
    }
    let tail = clean(r3.content);
    if (!tail.includes('【音效】') || !tail.includes('【强制禁止项】')) {
      reason = '第三批（音效/禁止项）缺栏位';
      continue;
    }
    tail = tail.slice(tail.indexOf('【音效】'));

    const full = [head, '', '【时间轴分镜】', ...tlLines, '', tail].join('\n');
    lastOut = full;
    const missed = SECTIONS.filter((x) => !full.includes(x));
    if (missed.length) { reason = '组装后缺栏位 ' + missed.join('、'); continue; }
    const missingRefs = [...want].filter((tag) => !sdRefTagPresent(full, tag));
    if (missingRefs.length) { reason = '未引用参考素材 ' + missingRefs.join('、'); continue; }
    const check = checkVideoPrompt(ctx.cfg, ctx.project?.video_model, shot, full);
    if (!check.ok) { reason = '机检未通过：\n' + check.detail; continue; }
    Shots.update(shot.id, { video_prompt: full, error: '' });
    ctx.report({ phase: '分镜提示词', detail: '已生成分镜 ' + shot.idx + ' 的视频提示词（长段分 ' + (batches.length + 2) + ' 批组装，' + tlLines.length + ' 镜）' });
    return JSON.stringify({ shot_id: shot.id, idx: shot.idx, video_prompt: full, refs: refLines.length, passes: batches.length + 2 });
  }
  logger.warn('写视频提示词失败（长段分批）', { shot: shot.idx, reason, head: lastOut.slice(0, 600), len: lastOut.length });
  throw new Error('生成视频提示词失败（' + reason + '），分镜 ' + shot.idx + ' 的提示词未改动。');
}

async function hWriteShotVideoPrompt(ctx, args) { return writeShotVideoPrompt(ctx, args.shot_id); }

// ===== 批量写视频提示词（分批 + 滚动状态卡）=====
// 与逐镜 write_shot_video_prompt 并存：本工具一次处理一个场景的连续镜头，每批 ≤BATCH_SIZE 镜，
// 一次 llmChat 连续产出多段六段式（天然继承上下文，解决逐镜独立请求"无参照"导致的换手/动作断裂），
// 批间用滚动状态卡传递站位/朝向/手部/机位侧/动作落幅；转场或换章自动重置状态卡。
const VIDEO_PROMPT_BATCH_SIZE = 3;
const BATCH_SHOT_SEP = /^===SHOT[_\s]+(\d+)\s*===\s*$/m;

// 把一批镜头拆成合并的 user message（每镜一段，明确图槽编号），并要求模型按 ===SHOT idx=== 分段输出。
async function buildBatchUser(ctx, batch, assets, globals) {
  const { isSeedance, nativeH3 } = globals;
  const blocks = [];
  const wantByShot = {};
  for (const shot of batch) {
    const isText = shot.mode === 'text';
    // 直接复用真实的参考图组装（upload:false 不上传、只需等待 Promise），
    // 保证批量与逐镜工具的图槽编号/优先级完全一致——手写版会因口径不同导致机检标签对不上。
    const { references, characterDesc, sceneDesc } = isText
      ? { references: [], characterDesc: '', sceneDesc: '' }
      : await assembleShotReferences({ cfg: ctx.cfg, project: ctx.project, shot, assets, upload: false });
    let io = 0, ao = 0, vo = 0;
    const refLines = references.map((r) => {
      if (isSeedance) {
        const cn = r.type === 'audio' ? '音频' : r.type === 'video' ? '视频' : '图片';
        const n = ++io;
        return '@' + cn + n + '（参考图' + n + '） = ' + (r.label || '参考素材') + '（用途：' + (r.type === 'audio' ? '锁定音色' : r.type === 'video' ? '锁定动作/运镜' : '锁定外貌/空间') + '）';
      }
      if (!nativeH3) return '__MINIMAX_H3_REF_' + (++io) + '__ = ' + (r.type === 'audio' ? '音色：' : '图片：') + (r.label || '参考素材');
      const tag = r.type === 'audio' ? '<Audio ' + (++ao) + '>' : r.type === 'video' ? '<Video ' + (++vo) + '>' : '<Picture ' + (++io) + '>';
      return tag + ' = ' + (r.type === 'audio' ? '音色：' : '图片：') + (r.label || '参考素材');
    });
    // 期望标签集合（与逐镜工具同口径）：nativeH3=<Picture/Audio/Video N>，Seedance=@图片N，Easy=__MINIMAX_H3_REF_N__
    wantByShot[shot.idx] = refLines.map((l) => {
      const m = /^(<Picture \d+>|<Audio \d+>|<Video \d+>)/.exec(l);
      if (m) return m[1];
      const m2 = /^(__MINIMAX_H3_REF_\d+__)/.exec(l);
      if (m2) return m2[1];
      const m3 = /^(@(?:图片|音频|视频)\d+)/.exec(l);
      return m3 ? m3[1] : '';
    }).filter(Boolean);
    blocks.push([
      '===SHOT ' + shot.idx + '===',
      '镜号：' + shot.idx + '（本批共 ' + batch.length + ' 镜，按镜号升序连续）',
      '时长：' + (shot.duration || 5) + ' 秒',
      shot.scene_name ? '场景：' + shot.scene_name : '',
      shot.camera ? '镜头设计：' + shot.camera : '',
      shot.visual ? '画面：' + shot.visual : '',
      shot.dialogue ? '台词：' + shot.dialogue : '',
      shot.sub_shots ? '子镜头时间轴：' + shot.sub_shots : '',
      characterDesc ? '角色一致性：' + characterDesc : '',
      sceneDesc ? '场景一致性：' + sceneDesc : '',
      refLines.length ? '本镜参考素材（本镜独立编号，顺序固定）：\n' + refLines.join('\n') : '本镜参考素材：无',
    ].filter(Boolean).join('\n'));
  }
  const text = '以下是同一场景连续的 ' + batch.length + ' 个分镜，请【按顺序连续】为每一镜各写一条完整提示词。\n\n'
    + blocks.join('\n\n')
    + '\n\n【输出格式 · 严格遵守】每一条提示词前必须单独一行写分隔符 ===SHOT <镜号>===，镜号用上面给的镜号；'
    + '分隔符之后只写该镜的提示词正文（六段式/七段式），不要标题、解释或 Markdown 围栏。'
    + (nativeH3
      ? ' 每条六段式的 subject_definitions 必须用【尖括号】写标签 <Picture N> / <Audio N>（不是裸写 Picture N），正文引用也用尖括号。'
      : isSeedance
        // Seedance 侧原先缺这条强指令：模型把「@图片1 = 姜知微」当背景信息，正文只写人名不写标签，
        // 导致每镜都被「缺参考标签」判 FAIL 并无限重试（实测 8 分钟 0 产出）。
        // 与 H3 分支同等强度：逐条点名、缺一即失败、禁裸写名字、禁新造编号。
        ? ' 【硬校验 · 缺一即失败】每条七段式必须把上面列出的参考标签【原样逐个】写进正文栏位（@图片1、@图片2…，可写成「@图片1 = 姜知微」），一个都不能漏、不得新造编号；只写素材名字而不写 @图片N 标签的，该镜直接判失败。'
        : '')
    + 'N 条之间用分隔符区分，不要遗漏任何一镜。';
  return { text, wantByShot };
}

// 切分模型输出：按 ===SHOT idx=== 分隔符拆成 [{idx, text}]。
function splitBatchOutput(text, expectIdxs) {
  const lines = String(text || '').split('\n');
  const out = [];
  let cur = null;
  for (const line of lines) {
    const m = /^===SHOT[_\s]+(\d+)\s*===\s*$/.exec(line.trim());
    if (m) {
      if (cur) out.push(cur);
      cur = { idx: Number(m[1]), lines: [] };
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (cur) out.push(cur);
  return out.map((x) => ({ idx: x.idx, text: x.lines.join('\n').trim().replace(/^```[a-z]*\n?|```$/g, '').trim() }))
    .filter((x) => expectIdxs.includes(x.idx));
}

async function writeVideoPromptsBatch(ctx, chapter) {
  if (ctx.llmDisabled) throw new Error('本批已禁用 LLM（渲染批次）：不能生成提示词。');
  const videoModel = String(ctx.project?.video_model || 'h3');
  const isSeedance = videoModel.startsWith('seedance');
  const loadedSpec = loadVideoPromptSkillSpec(ctx.cfg, videoModel);
  const skillText = (isSeedance ? loadedSpec : (loadedSpec || H3_REF2VA_FORMAT_RULES)) || H3_REF2VA_FORMAT_RULES;
  const videoSpec = getSpecForKind(ctx.cfg, 'r2v');
  const nativeH3 = !isSeedance && videoSpec?.promptFormat === 'minimax-ref2va';
  const globals = { isSeedance, nativeH3, skillText };

  const allShots = Shots.list(ctx.projectId).filter((s) => !chapter || s.chapter === chapter);
  const targets = allShots.filter((s) => !s.video_prompt && !(s.video_path && s.status === 'done'));
  if (!targets.length) return JSON.stringify({ chapter: chapter || '(全部)', batches: 0, written: 0, skipped: allShots.length, note: '本章没有缺提示词的分镜' });

  // 按「同场景 + idx 连续」切批：换场景或 idx 跳号 => 新批（并重置状态卡）。
  const groups = [];
  let curGroup = null;
  for (const s of targets) {
    const scene = s.scene_name || '';
    if (!curGroup || curGroup.scene !== scene) {
      curGroup = { scene, shots: [s] };
      groups.push(curGroup);
    } else curGroup.shots.push(s);
  }

  let written = 0, batches = 0, batchesDetail = [];
  for (const g of groups) {
    // 每批最多 3 镜
    for (let i = 0; i < g.shots.length; i += VIDEO_PROMPT_BATCH_SIZE) {
      const batch = g.shots.slice(i, i + VIDEO_PROMPT_BATCH_SIZE);
      batches++;
      // 状态卡：同场景且是本场景第 2 批起才传；跨场景/新章第一批 = null（重置）
      const prev = i > 0 ? loadStateCard(ctx.projectId, batch[0].chapter || chapter || '') : null;
      const hasTail = !!(prev && prev.scene === g.scene && prev.card);
      const stateCard = hasTail ? prev.card : '';
      const tailFrame = hasTail ? { shotSize: prev.shotSize || '', facing: prev.facing || '' } : null;
      const batchFmt = '【本批输出格式】按 ===SHOT <镜号>=== 分隔符，为上述 ' + batch.length + ' 镜各输出一条完整提示词。'
        + (hasTail
          ? (isSeedance
            ? '本批第一镜的【站位声明】栏必须承接段尾站位卡（人物站位/朝向/手部/机位继承），只写七段式中文字段，不要写 H3 的 detailed_description 或英文续接句。'
            : '本批第一镜 detailed_description 的 [Shot 1] 第一句必须逐字写出续接句 "' + TAIL_CONTINUATION_LINE + '"，随后逐字复述段尾站位卡；缺续接句判 FAIL。')
          : '本批第一镜按镜头设计建立初始站位/朝向/手部状态。')
        + '每镜独立编号参考素材，不要跨镜混用编号。';
      const sys = buildVideoPromptSystem(ctx, { ...globals, stateCard, tailFrame, batchMode: true, batchFormatInstruction: batchFmt });
      const { text: user, wantByShot } = await buildBatchUser(ctx, batch, Assets.list(ctx.projectId), globals);
      const maxTokens = Math.max(4000, Math.min(16000, batch.length * 2600));

      let goodPieces = null, reason = '未知', batchFeedback = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0 && reason && reason !== '未知') {
          batchFeedback = reason.indexOf('机检') >= 0
            ? '上一批机检未通过，只针对以下 FAIL 项补正：\n' + conciseCheckFeedback(reason)
            : reason;
        }
        const userThisAttempt = batchFeedback
          ? user + '\n\n【上一批未通过 · 必须补正后重新输出】\n' + batchFeedback.slice(0, 2500)
            + '\n请严格按 ===SHOT <镜号>=== 分隔符输出全部 ' + batch.length + ' 条完整提示词，字段与参考标签一个不少。'
          : user;
        const r = await llmChat(ctx.cfg.llm, [{ role: 'system', content: sys }, { role: 'user', content: userThisAttempt }], {
          temperature: attempt > 0 ? 0.4 : 0.65, maxTokens, thinking: { type: 'disabled' },
        });
        const out = String(r.content || '').trim().replace(/^```[a-z]*\n?|```$/g, '').trim();
        if (!out) { reason = 'LLM 返回为空'; continue; }
        if (r.finishReason === 'length') { reason = '输出被截断（maxTokens=' + maxTokens + '）'; continue; }
        const pieces = splitBatchOutput(out, batch.map((s) => s.idx));
        if (pieces.length < batch.length) { reason = '分隔符分段不足：期望 ' + batch.length + ' 段，得到 ' + pieces.length + ' 段'; continue; }
        goodPieces = pieces;
        reason = '';
        break;
      }
      if (reason || !goodPieces) {
        // 整批失败：降级为逐镜工具（保留原有逐镜重试/机检），不阻断流水线
        batchesDetail.push('批' + batches + '（镜' + batch.map((s) => s.idx).join(',') + '）失败：' + reason + ' → 降级逐镜');
        for (const s of batch) {
          try { await writeShotVideoPrompt(ctx, s.id); written++; }
          catch (e) { batchesDetail.push('  镜' + s.idx + ' 逐镜也失败：' + e.message); }
        }
        continue;
      }

      // 逐镜校验 + 机检 + 写回
      let batchTail = null;
      for (let k = 0; k < batch.length; k++) {
        const shot = batch[k];
        const piece = goodPieces.find((p) => p.idx === shot.idx);
        const txt = piece ? piece.text : '';
        if (!txt) { batchesDetail.push('  镜' + shot.idx + ' 无正文，跳过'); continue; }
        // ① 参考标签引用校验：本镜期望的 <Picture N>/<Audio N> 等必须出现在正文。
        // 模型常把尖括号写成裸 "Picture 1"——语义上仍是对该图槽的引用，放宽匹配，避免误杀；
        // subject_definitions 里的 "in Picture 1" 与正文引用都算。
        const want = wantByShot[shot.idx] || [];
        const missingTags = want.filter((tag) => !refTagPresent(txt, tag));
        // ② 六段式/七段式完整性 + 指令行（nativeH3）
        const SIX = ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music'];
        const SEVEN = ['【画幅风格】', '【场景资产】', '【核心人物】', '【站位声明】', '【时间轴分镜】', '【音效】', '【强制禁止项】'];
        const need = isSeedance ? SEVEN : (nativeH3 ? SIX : []);
        const missingSections = need.filter((s) => !txt.includes(s));
        const badInstruction = nativeH3 && hasRef2vaInstructionLine(txt);
        // 跨段衔接门禁（H52）：本批第一镜在有上一段时必须逐字写续接句进 [Shot 1] 正文。
        // 软提示模型可执行可不执行，这里做成硬校验——缺了就降级重试，确保"下一段知道人在哪"。
        const missingContinuation = !!(nativeH3 && hasTail && k === 0 && !TAIL_CONTINUATION_RE.test(txt));
        const check = checkVideoPrompt(ctx.cfg, videoModel, shot, txt);
        if (missingTags.length || missingSections.length || badInstruction || missingContinuation || !check.ok) {
          // 单镜校验/机检 FAIL：降级为该镜走逐镜工具（带机检反馈重试）
          const why = [missingTags.length ? '缺参考标签 ' + missingTags.join(',') : '', missingSections.length ? '缺栏位 ' + missingSections.join(',') : '',
            badInstruction ? 'Ref2VA指令行' : '', missingContinuation ? '缺H52续接句(段首未接上一段)' : '', !check.ok ? '机检:' + check.detail.replace(/\s*\n\s*/g, ' ').slice(0, 360) : ''].filter(Boolean).join('；');
          batchesDetail.push('  镜' + shot.idx + ' 校验 FAIL（' + why + '）→ 降级逐镜重试');
          try { await writeShotVideoPrompt(ctx, shot.id); written++; } catch (e) { batchesDetail.push('    逐镜失败：' + e.message); }
          continue;
        }
        Shots.update(shot.id, { video_prompt: txt, error: '' });
        written++;
        // 段尾站位卡取本批最后一镜（干净正文，非尾部原文），供下一批硬锚点用
        if (k === batch.length - 1) batchTail = extractTailFrameCard(txt);
      }
      if (batchTail && batchTail.card) {
        saveStateCard(ctx.projectId, batch[0].chapter || chapter || '', {
          scene: g.scene, lastIdx: batch[batch.length - 1].idx,
          card: batchTail.card, shotSize: batchTail.shotSize, facing: batchTail.facing,
        });
      }
      ctx.report({ phase: '分镜提示词', detail: '批量生成 ' + batch.length + ' 镜（' + g.scene.slice(0, 20) + '），累计 ' + written + ' 镜' });
    }
  }
  return JSON.stringify({ chapter: chapter || '(全部)', batches, written, skipped: targets.length - written, detail: batchesDetail });
}
async function hWriteVideoPromptsBatch(ctx, args) { return writeVideoPromptsBatch(ctx, args.chapter || ''); }

// 镜头依赖判定：镜头引用的角色/场景/道具（含服装/年龄变体）必须**已经生成完成**，
// 该镜头才能进渲染队列。只统计「能解析到资产」的引用——悬空 id 不阻塞
// （参考图组装时会直接跳过它，阻塞一个永远补不上的依赖没有意义）。
function pendingShotAssets(ctx, shot, byId) {
  const pending = [];
  const check = (ids, label) => {
    for (const id of ids || []) {
      const a = byId.get(id);
      if (!a) continue;
      const done = a.status === 'done' && a.image_path && fs.existsSync(resolveProjectPath(ctx.projectId, a.image_path));
      if (!done) pending.push((a.name || a.id) + '·' + label);
    }
  };
  check(shot.character_ids, '角色');
  check(shot.scene_ids, '场景');
  check(shot.prop_ids, '道具');
  check(shot.costume_ids, '服装');
  check(shot.age_ids, '年龄');
  return pending;
}

async function hGenerateChapterVideos(ctx, args) {
  // chapter 与 set_chapter_music 统一走 chapterByRef：标题或 id 都认（get_project / list_chapters
  // 同时给出两者，模型传哪个都得对）。之前只按标题过滤分镜，模型传章节 id 时会静默返回
  // 「本章没有分镜」——一个看似正常的空结果，任务却什么都没做。
  const title = chapterByRef(ctx, args && args.chapter).title;
  const force = !!(args && args.force);
  const all = Shots.list(ctx.projectId).filter((s) => s.chapter === title);
  if (!all.length) return JSON.stringify({ chapter: title, total: 0, generated: 0, remaining: 0, note: '本章没有分镜' });
  // 未指定 force 时跳过「已出片且视频提示词未变过」的镜头；提示词被改写（如「仅 LLM 改写」）过就重渲染
  const target = force ? all : all.filter((s) => s.status !== 'done' || (s.video_prompt_used || '') !== (s.video_prompt || ''));
  const runCount = target.length;

  // 依赖感知调度：先把「引用的资产都已完成」的镜头挑出来，其余等待。
  // 章节视频无论本地 ComfyUI 还是云端 RunningHub，都按 idx 升序**逐镜串行**（见下方 runOne），
  // 否则每个分镜都会在抢槽前就被标成 generating，界面看起来像全部并发生成、顺序也乱。
  const byId = new Map(Assets.list(ctx.projectId).map((a) => [a.id, a]));
  const readiness = target.map((shot) => ({ shot, pending: pendingShotAssets(ctx, shot, byId) }));
  const ready = readiness.filter((r) => r.pending.length === 0).map((r) => r.shot);
  const waiting = readiness.filter((r) => r.pending.length > 0);

  if (waiting.length) {
    const sample = waiting.slice(0, 3).map((r) => '第' + r.shot.idx + '镜←' + r.pending.join('/')).join('；');
    ctx.report({ phase: '分镜视频', detail: '暂缓 ' + waiting.length + ' 镜（依赖资产未完成）：' + sample + (waiting.length > 3 ? ' …' : '') });
  }
  if (!ready.length) {
    return JSON.stringify({
      chapter: title, total: all.length, generated: 0, failed: 0,
      remaining: all.filter((s) => s.status !== 'done').length,
      deferred: waiting.length,
      note: '本章所有待生成镜头都还有未完成的依赖资产，请先生成资产图/服装后再重试',
    });
  }

  // 1) 先为所有就绪分镜组装参考素材 / 提示词（prepare 只计算，不写状态、不提交渲染），
  //    这样候选渲染的「全局顺序」由下方队列决定，不受各镜参考图上传耗时影响。
  const preparedList = [];
  for (const s of ready) {
    if (ctx.isAborted && ctx.isAborted()) break;
    preparedList.push(await prepareShotForRender(ctx, s.id, {}));
  }

  // 2) 按分镜 idx 顺序逐镜生成：一个分镜的候选全部结束后，才开始下一镜。
  //    同一镜的候选可以并发（最多 limit 条），但不会让第 2 镜抢到第 1 镜前面。
  const limit = renderConcurrencyLimit(ctx.cfg);
  ctx.report({ phase: '分镜视频', detail: '按分镜顺序生成 ' + ready.length + '/' + runCount + ' 镜（每镜候选 ' + (preparedList[0]?.shotsN || 1) + '，并发 ' + limit + '）' });

  const started = new Set();        // 已标 generating 并清掉旧候选的分镜
  const okByShot = new Map();       // shotId -> [{id,idx,video_path,seed}]
  const errByShot = new Map();      // shotId -> [Error]
  const finalized = new Set();      // 已收尾的分镜
  let ok = 0, fail = 0, aborted = false;

  // 收尾单个分镜：有候选 → done 并默认选第一条；无候选 → 按取消/失败复位。
  const finalizeOne = (prepared) => {
    const shot = prepared.shot;
    const created = (okByShot.get(shot.id) || []).sort((a, b) => a.idx - b.idx);
    const errs = errByShot.get(shot.id) || [];
    if (created.length) {
      finalizeShot(ctx, prepared, created, { aborted: false, interrupted: false, lastErr: errs[0] || null });
      ok++;
      ctx.report({ phase: '分镜视频', detail: '已完成 ' + (ok + fail) + '/' + preparedList.length + ' 镜（成功 ' + ok + ' / 失败 ' + fail + '）' });
    } else if (aborted) {
      // 被停止/中断：只有真正进入过渲染（标过 generating）的分镜才复位；从未开始的分镜保持原状。
      if (started.has(shot.id)) {
        if (prepared.prevStatus === 'done' && prepared.prevVideo) Shots.update(shot.id, { status: 'done', video_path: prepared.prevVideo, error: '' });
        else Shots.update(shot.id, { status: 'pending', video_path: prepared.prevVideo || '', error: '' });
      }
    } else {
      fail++;
      Shots.update(shot.id, { status: 'failed', error: (errs[0] && errs[0].message) ? errs[0].message : '生成失败', video_path: prepared.prevVideo || '' });
      ctx.report({ phase: '分镜视频', detail: '第' + shot.idx + '镜失败：' + ((errs[0] && errs[0].message) || '生成失败') });
    }
  };

  for (const prepared of preparedList) {
    if (aborted || (ctx.isAborted && ctx.isAborted())) { aborted = true; break; }
    const shot = prepared.shot;
    started.add(shot.id);
    // 分镜进入渲染时才标 generating（并清掉上一版候选），「生成中」只落在真正在跑的分镜上。
    Shots.update(shot.id, { status: 'generating', video_prompt: prepared.prompt, seed: 0, resolution: prepared.reso, aspect_ratio: prepared.ratio, error: '', prompt_id: '' });
    ctx.report({ phase: '分镜视频', detail: '生成 ' + shot.idx + '/' + runCount + (prepared.shotsN > 1 ? '（×' + prepared.shotsN + ' 候选）' : '') });
    ShotVideos.deleteByShot(shot.id);

    const created = [];
    const errs = [];
    let next = 0;
    const worker = async () => {
      while (true) {
        const i = next++;
        if (i >= prepared.shotsN || aborted) break;
        if (ctx.isAborted && ctx.isAborted()) { aborted = true; break; }
        try {
          created.push(await renderShotCandidate(ctx, prepared, i));
        } catch (e) {
          if (ctx.isAborted && ctx.isAborted()) { aborted = true; break; }
          if (e && e.interrupted) { aborted = true; break; }
          errs.push(e);
          ctx.report({ phase: '分镜视频', detail: '分镜 ' + shot.idx + ' 候选 ' + (i + 1) + '/' + prepared.shotsN + ' 失败：' + (e && e.message ? e.message : String(e)) });
        }
      }
    };
    // 同一镜的候选并行度不超过配置的渲染并发；不同分镜之间严格串行。
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, prepared.shotsN)) }, () => worker()));
    okByShot.set(shot.id, created);
    errByShot.set(shot.id, errs);
    finalized.add(shot.id);
    finalizeOne(prepared);
    if (aborted) break;
  }

  // 被停止/中断时，有分镜的候选没跑满（worker 提前 break），这里兜底收尾：
  // 有成功候选 → done；无成功候选且进入过渲染 → 复位；从未渲染 → 保持原状。
  for (const p of preparedList) {
    if (finalized.has(p.shot.id)) continue;
    finalized.add(p.shot.id);
    finalizeOne(p);
  }

  const remaining = Shots.list(ctx.projectId).filter((s) => s.chapter === title && s.status !== 'done').length;
  const base = { chapter: title, total: all.length, generated: ok, failed: fail, remaining };
  if (aborted) return JSON.stringify({ ...base, aborted: true });
  if (waiting.length) return JSON.stringify({ ...base, deferred: waiting.length, note: '有 ' + waiting.length + ' 镜因依赖资产未完成而暂缓' });
  return JSON.stringify(base);
}

async function hAssembleVideo(ctx, args) {
  // 只有显式传了 chapter 才按章合并（不传 = 整片合并，沿用原行为）；
  // 章节引用同样支持标题或 id —— 之前过滤分镜只按标题、找 BGM 却按「标题或 id」，
  // 传 id 时会报「章节没有已完成的分镜视频」，而该章其实有片子。
  const ch = (args && args.chapter) ? chapterByRef(ctx, args.chapter) : null;
  const chapter = ch ? ch.title : '';
  // 顺序：先章节 seq 再章内 idx（多章合并时按全局 idx 会交叉成「第1章第1镜、第2章第1镜…」）
  let done = Shots.listInNarrativeOrder(ctx.projectId).filter((s) => s.video_path && s.status === 'done');
  if (chapter) done = done.filter((s) => s.chapter === chapter);
  if (!done.length) throw new Error(chapter ? ('章节「' + chapter + '」没有已完成的分镜视频') : '没有已完成的分镜视频');
  const inputs = done.map((s) => resolveProjectPath(ctx.projectId, s.video_path)).filter(Boolean);
  const base = chapter ? slugify(ctx.project.name) + '_' + slugify(chapter) : slugify(ctx.project.name);
  const outRel = 'exports/' + base + '_' + uid().slice(0, 8) + '.mp4';
  const outAbs = resolveProjectPath(ctx.projectId, outRel);
  // 背景音乐：仅按章合并时，把该章已生成的 BGM 垫底混入
  let music;
  if (ch) {
    const musicAbs = ch.music_path ? resolveProjectPath(ctx.projectId, ch.music_path) : null;
    if (musicAbs && fs.existsSync(musicAbs)) music = { path: musicAbs, volume: 0.25 };
  }
  ctx.report({ phase: '导出', detail: '合并 ' + inputs.length + ' 段视频' + (music ? '（垫入背景音乐）' : '') });
  // 字幕：项目开启「自动添加字幕」时，按设置页选的模式生成——
  //   script（经典，默认）用分镜台词/旁白，零依赖；whisper 用成片音轨识别，失败自动回退台词。
  // 字幕是烧进画面的，无法从成片里再去掉 → 同时单独合一份不带字幕的版本，供下载时二选一。
  let subtitles = '';
  if (ctx.project.enable_subtitles !== false) {
    const r = await resolveSubtitles({
      projectId: ctx.projectId,
      inputs,
      shots: done,
      isAborted: ctx.isAborted,
      onProgress: (d) => ctx.report({ phase: '字幕', detail: d }),
    });
    subtitles = r.srt;
    if (!subtitles && r.mode === 'whisper') {
      ctx.report({ phase: '字幕', detail: r.fallback ? '剧本台词为空，成片不烧录字幕' : '未识别到语音，成片不烧录字幕' });
    }
  }
  const noSubRel = outRel.replace(/(\.[^.]+)$/, '_nosub$1');
  await mergeVideos(inputs, outAbs, { music, isAborted: ctx.isAborted, subtitles });
  let srtRel = '';
  if (subtitles) {
    await mergeVideos(inputs, resolveProjectPath(ctx.projectId, noSubRel), { music, isAborted: ctx.isAborted });
    // 附带一份 SRT 字幕文件：不进成片列表，只作为「下载字幕」按钮的素材
    srtRel = outRel.replace(/\.[^.]+$/, '.srt');
    fs.writeFileSync(resolveProjectPath(ctx.projectId, srtRel), subtitles, 'utf8');
  }
  return JSON.stringify({ export_path: outRel, shots: done.length, chapter: chapter || null, music: !!music, subtitled: !!subtitles, nosub_path: subtitles ? noSubRel : '', srt_path: srtRel });
}

function chapterByRef(ctx, ref) {
  const title = String(ref || ctx.chapter || '').trim();
  if (!title) throw new Error('请指定章节 chapter');
  const ch = Chapters.list(ctx.projectId).find((c) => c.title === title || c.id === title);
  if (!ch) throw new Error('章节不存在：' + title);
  return ch;
}

async function hSetChapterMusic(ctx, args) {
  const ch = chapterByRef(ctx, args && args.chapter);
  const caption = String((args && args.caption) || '').trim();
  if (!caption) throw new Error('请提供音乐风格描述 caption');
  const lyrics = String((args && args.lyrics) || '').trim();
  const duration = (args && args.duration != null) ? Number(args.duration) : 0;
  Chapters.update(ch.id, { music_prompt: JSON.stringify({ caption, lyrics, duration }) });
  return JSON.stringify({ chapter: ch.title, caption, lyrics, duration });
}

async function hGenerateMusic(ctx, args) {
  // 项目设置「是否生成背景音乐」关闭时，自动流水线跳过（音乐库手动生成/应用不受此限制）
  if (ctx.project.enable_bgm === false) {
    return JSON.stringify({ chapter: args && args.chapter, skipped: true, note: '项目已关闭「是否生成背景音乐」' });
  }
  const ch = chapterByRef(ctx, args && args.chapter);
  let prompt = {};
  try { prompt = JSON.parse(ch.music_prompt || '{}'); } catch {}
  const caption = String(prompt.caption || '').trim()
    || ((ctx.project.style || '').trim() ? ctx.project.style + '，轻柔舒缓的背景音乐' : '轻柔舒缓的背景音乐');
  const lyrics = String(prompt.lyrics || '').trim();
  const promptKey = JSON.stringify({ caption, lyrics });
  // 幂等：已生成且提示词未变，直接跳过
  const existingAbs = ch.music_path ? resolveProjectPath(ctx.projectId, ch.music_path) : null;
  if ((ch.music_prompt_used || '') === promptKey && existingAbs && fs.existsSync(existingAbs)) {
    return JSON.stringify({ chapter: ch.title, music_path: ch.music_path, skipped: true });
  }
  const shots = Shots.list(ctx.projectId).filter((s) => s.chapter === ch.title);
  const total = shots.reduce((sum, s) => sum + (Number(s.duration) || 0), 0);
  if (total <= 0) return JSON.stringify({ chapter: ch.title, skipped: true, note: '本章没有分镜，无法确定背景音乐时长' });
  // 时长：优先 LLM 给的 duration，否则该章全部分镜 duration 之和（不封顶）
  const max_duration = Number(prompt.duration) > 0
    ? Math.max(1, Number(prompt.duration))
    : Math.max(1, Math.round(total * 10) / 10);

  const spec = getSpecForKind(ctx.cfg, 'music');
  const prefix = 'music/' + slugify(ctx.project.name) + '_' + slugify(ch.title) + '_' + uid().slice(0, 8);
  ctx.report({ phase: '背景音乐', detail: '生成背景音乐：' + ch.title });
  const { outputs } = await runWorkflow(ctx.cfg, spec, {
    caption, lyrics: lyrics || ' ', max_duration, seed: randomSeed(), filename_prefix: prefix,
  }, { timeoutMs: VID_TIMEOUT(ctx.cfg), isAborted: ctx.isAborted, jobId: ctx.jobId, projectId: ctx.projectId, chapter: ch.title, subject: ch.title + ' BGM', dedupeKey: 'music:' + ch.id, onStatus: (s) => { if (s.kind === 'error') throw new Error(s.message); } });
  const aud = pickOutput(outputs, 'audio');
  if (!aud) throw new Error('背景音乐工作流未返回音频');
  const ext = path.extname(aud.filename) || '.mp3';
  const relPath = 'assets/music/' + slugify(ctx.project.name) + '_' + slugify(ch.title) + '_' + uid().slice(0, 8) + ext;
  await downloadOutputTo(ctx, aud, relPath);
  Chapters.update(ch.id, { music_path: relPath, music_prompt_used: promptKey });
  // 自动生成的 BGM 也入库「背景音乐库」，便于用户预览/选择（同名复用，见 upsertMusicAsset）
  const assetId = upsertMusicAsset(ctx, ch.title + '背景音乐', { audio_path: relPath, prompt: caption, prompt_used: caption, lyrics, max_duration, source: 'generated', status: 'done' });
  return JSON.stringify({ chapter: ch.title, music_path: relPath, asset_id: assetId, duration: max_duration });
}

async function hGenerateMusicAsset(ctx, args) {
  const asset = (args && args.asset_id) ? Assets.get(args.asset_id) : null;
  if (!asset || asset.project_id !== ctx.projectId || asset.category !== 'music') throw new Error('背景音乐资产不存在');
  // 生成用文案：优先用 POST /music 按 music-caption-rewriter 技能预写好的结构化 caption/lyrics
  // （params.caption_rewrite，且其源描述仍与资产 prompt 一致）；否则退回资产自身字段。
  const rewrite = (asset.params && asset.params.caption_rewrite) || null;
  const rewriteOk = !!(rewrite && rewrite.caption && String(rewrite.source_caption || '') === String(asset.prompt || '').trim());
  const caption = String((rewriteOk ? rewrite.caption : asset.prompt) || '').trim();
  if (!caption) throw new Error('缺少音乐描述 caption');
  const lyrics = String((rewriteOk ? rewrite.lyrics : asset.lyrics) || '').trim();
  // 时长：优先资产里写好的 max_duration；否则按项目总视频时长（不封顶）；未生成视频时默认 60s
  const shots = Shots.list(ctx.projectId);
  const total = shots.reduce((sum, s) => sum + (Number(s.duration) || 0), 0);
  const max_duration = Number(asset.max_duration) > 0
    ? Math.max(1, Number(asset.max_duration))
    : (total > 0 ? Math.max(1, Math.round(total * 10) / 10) : 60);

  const spec = getSpecForKind(ctx.cfg, 'music');
  const prefix = 'music/' + slugify(asset.name) + '_' + uid().slice(0, 8);
  ctx.report({ phase: '背景音乐', detail: '生成背景音乐：' + asset.name });
  Assets.update(asset.id, { status: 'generating' });
  try {
    const { outputs } = await runWorkflow(ctx.cfg, spec, {
      caption, lyrics: lyrics || ' ', max_duration, seed: randomSeed(), filename_prefix: prefix,
    }, { timeoutMs: VID_TIMEOUT(ctx.cfg), isAborted: ctx.isAborted, jobId: ctx.jobId, projectId: ctx.projectId, chapter: '', subject: asset.name || asset.id, dedupeKey: 'music-asset:' + asset.id, onStatus: (s) => { if (s.kind === 'error') throw new Error(s.message); } });
    const aud = pickOutput(outputs, 'audio');
    if (!aud) throw new Error('背景音乐工作流未返回音频');
    const ext = path.extname(aud.filename) || '.mp3';
    const relPath = 'assets/music/' + slugify(asset.name) + '_' + uid().slice(0, 8) + ext;
    await downloadOutputTo(ctx, aud, relPath);
    Assets.update(asset.id, { audio_path: relPath, prompt_used: caption, source: 'generated', status: 'done', error: '' });
    return JSON.stringify({ asset_id: asset.id, name: asset.name, music_path: relPath, duration: max_duration });
  } catch (e) {
    // 失败/被停止时不能把**已有的音频**一起作废：重新生成前资产上那条 audio_path 仍是可用产物
    // （列表里还在播、用户还等着用它「应用到章节」），置成 failed 会让「应用到」直接消失。
    // 与分镜同口径：取消时保留已完成结果，只在确实没有音频时才标失败。
    const aborted = !!(ctx.isAborted && ctx.isAborted());
    if (aborted && asset.audio_path) Assets.update(asset.id, { status: 'done', error: e.message });
    else Assets.update(asset.id, { status: 'failed', error: e.message });
    throw e;
  }
}

// 简单模式页（视频生成 / 数字人）的独立视频资产生成：不走分镜流水线，直接以「上传的参考物料 +
// 模式」跑 r2v 工作流，产物落为 video 资产。数字人 = mode=digital_human（视觉参考 + 单条驱动音频）。
async function hGenerateVideoAsset(ctx, args) {
  const asset = (args && args.asset_id) ? Assets.get(args.asset_id) : null;
  if (!asset || asset.project_id !== ctx.projectId || asset.category !== 'video') throw new Error('视频资产不存在');
  const mode = String((args && args.mode) || 'reference');
  if (!VIDEO_MODES.includes(mode)) throw new Error('mode 只能是 ' + VIDEO_MODES.join('/') + '（当前：' + mode + '）');
  const prompt = String((args && args.prompt) || asset.prompt || '').trim();
  if (!prompt) throw new Error('缺少视频提示词 prompt');

  // 上传本地物料到渲染后端，得到 ComfyUI 认识的输入文件名（Native=本地名，RunningHub=平台 fileName）
  const refs = Array.isArray(args.references) ? args.references : [];
  const references = [];
  for (const r of refs) {
    const type = r.type === 'audio' || r.type === 'video' ? r.type : 'image';
    const rel = String(r.filename || r.path || '').trim();
    if (!rel) continue;
    const abs = resolveProjectPath(ctx.projectId, rel);
    if (!abs || !fs.existsSync(abs)) throw new Error('参考物料不存在：' + rel);
    const ext = path.extname(abs) || (type === 'audio' ? '.flac' : type === 'video' ? '.mp4' : '.png');
    const name = 'ic_' + ctx.projectId.slice(0, 8) + '_' + type + '_' + uid().slice(0, 8) + ext;
    const filename = await uploadTaskInput(ctx.cfg, abs, name, 'video');
    references.push({ type, filename, localPath: abs, label: type });
  }

  // 模式与物料组合约束
  const images = references.filter((r) => r.type === 'image').length;
  const audios = references.filter((r) => r.type === 'audio').length;
  const videos = references.filter((r) => r.type === 'video').length;
  if (mode === 'image') {
    if (audios || videos) throw new Error('图生/首尾帧模式只能连接图片（当前混入了音频/视频）');
    if (images < 1 || images > 2) throw new Error('图生/首尾帧模式需 1–2 张图片（当前 ' + images + ' 张）');
  } else if (mode === 'reference') {
    if (images + videos < 1) throw new Error('参考生视频模式至少需要 1 张图片或 1 段视频');
    if (images > MAX_IMAGE_REFS) throw new Error('参考图片最多 ' + MAX_IMAGE_REFS + ' 张（当前 ' + images + ' 张）');
    if (audios + videos > 3) throw new Error('参考音视频最多 3 段（当前 ' + (audios + videos) + ' 段）');
  } else if (mode === 'digital_human') {
    if (images !== 1) throw new Error('数字人模式需 1 张视觉参考（头像），当前 ' + images + ' 张');
    if (audios !== 1 || videos) throw new Error('数字人模式需且仅需 1 条驱动音频，当前音频 ' + audios + ' / 视频 ' + videos);
  }

  const reso = String((args && args.resolution) || '480P');
  const ratio = String((args && args.aspect_ratio) || '16:9');
  const seconds = Number(args && args.seconds) > 0 ? Number(args.seconds) : 5;
  const { spec, scale, resolution: wfResolution } = getR2vSpecForResolution(ctx.cfg, reso, mode, images);
  const prefix = 'video/' + slugify(asset.name) + '_' + uid().slice(0, 8);
  ctx.report({ phase: '视频生成', detail: '生成视频：' + asset.name + '（' + mode + '）' });
  Assets.update(asset.id, { status: 'generating', prompt });
  try {
    const wfParams = { positive_prompt: prompt, seconds, aspect_ratio: ratio, resolution: wfResolution, seed: randomSeed(), filename_prefix: prefix, references, mode };
    if (scale) wfParams.scale = scale;
    const { outputs } = await runWorkflow(ctx.cfg, spec, wfParams, { jobId: ctx.jobId, timeoutMs: VID_TIMEOUT(ctx.cfg), isAborted: ctx.isAborted, onStatus: (s) => { if (s.kind === 'error') throw new Error(s.message); } });
    const vid = pickOutput(outputs, 'videos');
    if (!vid) throw new Error('视频工作流未返回视频文件');
    const ext = path.extname(vid.filename) || '.mp4';
    const relPath = 'assets/videos/' + slugify(asset.name) + '_' + uid().slice(0, 8) + ext;
    await downloadOutputTo(ctx, vid, relPath);
    Assets.update(asset.id, { video_path: relPath, prompt_used: prompt, source: 'generated', status: 'done' });
    return JSON.stringify({ asset_id: asset.id, name: asset.name, video_path: relPath, mode });
  } catch (e) {
    const aborted = !!(ctx.isAborted && ctx.isAborted());
    if (aborted && asset.video_path) Assets.update(asset.id, { status: 'done' });
    else Assets.update(asset.id, { status: 'failed' });
    throw e;
  }
}

async function hApplyChapterMusic(ctx, args) {
  const musicId = args && args.music_id;
  const music = musicId ? Assets.get(musicId) : null;
  if (!music || music.project_id !== ctx.projectId || music.category !== 'music') throw new Error('背景音乐不存在');
  if (!music.audio_path) throw new Error('该背景音乐还没有音频文件');
  const titles = (Array.isArray(args && args.chapters) ? args.chapters : []).filter(Boolean);
  if (!titles.length) throw new Error('请选择要应用的章节');
  const results = [];
  let aborted = false;
  for (const t of titles) {
    // 与 hGenerateChapterVideos 一致：停止后不再继续合并后续章节（每章合并都是一次数十秒的 ffmpeg）
    if (ctx.isAborted && ctx.isAborted()) { aborted = true; break; }
    const ch = Chapters.list(ctx.projectId).find((c) => c.title === t || c.id === t);
    if (!ch) { results.push({ chapter: t, error: '章节不存在' }); continue; }
    const shots = Shots.list(ctx.projectId).filter((s) => s.chapter === ch.title);
    if (!shots.length || shots.some((s) => s.status !== 'done' || !s.video_path)) {
      results.push({ chapter: ch.title, error: '尚未全部生成完成' });
      continue;
    }
    // 单章失败不能中断后续章节：这是批量动作，用户期望「能应用的都应用上，失败的列出来」。
    // 原先一次合并抛错会让后面所有章节都不再处理（前几章已改了 music_path，后面几章连碰都没碰）。
    try {
      Chapters.update(ch.id, { music_path: music.audio_path });
      const r = await hAssembleVideo(ctx, { chapter: ch.title });
      results.push({ chapter: ch.title, applied: true, export_path: JSON.parse(r).export_path });
    } catch (e) {
      results.push({ chapter: ch.title, error: '已写入背景音乐，但合并成片失败：' + e.message });
    }
  }
  // 全失败不能静默返回结果：任务会被记成 done，前端弹「任务完成」、按钮提示「已重新合成成片」，
  // 而用户其实什么都没得到。逐章原因带进错误里（日志/任务详情仍能看到是哪一章、为什么）。
  // aborted 时不抛：用户主动停止属于「取消」，不是失败（与阶段任务的停止语义一致）。
  if (!aborted && results.length && results.every((r) => r.error)) {
    throw new Error('所有章节都未能应用背景音乐：' + results.map((r) => r.chapter + '（' + r.error + '）').join('；'));
  }
  return JSON.stringify({ music_id: musicId, results, aborted });
}

async function hListWorkflows() {
  return JSON.stringify(Workflows.list().map((w) => ({ id: w.id, name: w.name, kind: w.kind, sourceFile: w.sourceFile })));
}

// ================= opuscar（lemo-opuscar 代码电影）工具 =================
const OPUSCAR_LIB_ROOT = path.join(SKILLS_DIR, 'lemo-opuscar');
// 每条影片记录（视频资产）一个独立工作区 film/<assetId>：多条记录互不覆盖，
// 也让「继续修改」能读回自己上一版的页面代码。无 assetId 时回落到项目级 film/。
function opuscarFilmDir(ctx) {
  const rel = ctx.assetId ? 'film/' + ctx.assetId : 'film';
  return resolveProjectPath(ctx.projectId, rel);
}
function isInsideDir(candidate, root) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function hOpuscarInit(ctx) {
  if (!fs.existsSync(OPUSCAR_LIB_ROOT)) throw new Error('lemo-opuscar 技能库不存在：' + OPUSCAR_LIB_ROOT);
  const filmDir = opuscarFilmDir(ctx);
  if (!filmDir) throw new Error('影片工作区路径非法');
  fs.mkdirSync(filmDir, { recursive: true });
  return JSON.stringify({ lib_root: OPUSCAR_LIB_ROOT, film_dir: filmDir });
}

function opuscarShellTimeout(ctx) {
  // 视频渲染/合成耗时较长，给足超时（对齐 VID_TIMEOUT 语义），单条命令最长 30 分钟。
  return Number(ctx.cfg?.generation?.videoTimeoutMinutes) > 0
    ? Number(ctx.cfg.generation.videoTimeoutMinutes) * 60 * 1000
    : 30 * 60 * 1000;
}

async function hOpuscarShell(ctx, args) {
  const libRoot = OPUSCAR_LIB_ROOT;
  const filmDir = opuscarFilmDir(ctx);
  if (!filmDir) throw new Error('影片工作区路径非法');
  fs.mkdirSync(filmDir, { recursive: true });
  const cwd = args.cwd === 'film' ? filmDir : libRoot;
  const command = String(args.command || '').trim();
  if (!command) throw new Error('command 不能为空');
  if (command.includes('..')) throw new Error('命令含非法路径段 ".."');
  // 命令里出现的绝对路径必须落在 lib_root / film_dir 两个白名单根之内
  const absTokens = command.match(/(?:^|[\s"'=(])(\/[^\s"'=)]+)/g) || [];
  for (const tok of absTokens) {
    const p = tok.replace(/^[\s"'=(]+/, '');
    if (!isInsideDir(p, libRoot) && !isInsideDir(p, filmDir)) {
      throw new Error('命令引用了允许范围之外的绝对路径：' + p);
    }
  }
  const env = { ...process.env, LEMO_LIB: libRoot, LEMO_FILM: filmDir };
  // 用独立进程组执行，停止时整组 SIGKILL —— 只 kill 外层 /bin/sh 会留下 ffmpeg/node 子进程继续跑。
  return await new Promise((resolve, reject) => {
    // windowsHide：Windows 下每次执行 shell 命令都会弹控制台窗口
    const child = spawn('/bin/sh', ['-c', command], {
      windowsHide: true,
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let done = false;
    let timer = null;
    let abortTimer = null;
    const killGroup = (sig) => {
      try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* 进程已退出 */ } }
    };
    const finish = (payload, err) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (abortTimer) clearInterval(abortTimer);
      if (err) reject(err);
      else resolve(JSON.stringify(payload));
    };
    timer = setTimeout(() => {
      killGroup('SIGKILL');
      finish({ code: 124, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000), error: '命令超时' });
    }, opuscarShellTimeout(ctx));
    abortTimer = setInterval(() => {
      if (ctx.isAborted && ctx.isAborted()) {
        killGroup('SIGKILL');
        finish(null, new Error('任务已停止'));
      }
    }, 400);
    child.stdout.on('data', (d) => { stdout += d; if (stdout.length > 8 * 1024 * 1024) stdout = stdout.slice(-4 * 1024 * 1024); });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 8 * 1024 * 1024) stderr = stderr.slice(-4 * 1024 * 1024); });
    child.on('error', (e) => finish({ code: 1, stdout: '', stderr: '', error: String(e.message || e).slice(0, 500) }));
    child.on('close', (code, signal) => finish({
      code: code == null ? 1 : code,
      stdout: stdout.slice(-4000),
      stderr: stderr.slice(-4000),
      error: signal ? '命令被终止：' + signal : '',
    }));
  });
}

async function hOpuscarWriteFile(ctx, args) {
  const relPath = String(args.path || '').trim();
  if (!relPath) throw new Error('path 不能为空');
  const abs = resolveProjectPath(ctx.projectId, 'film/' + relPath);
  if (!abs) throw new Error('非法保存路径：' + relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, String(args.content ?? ''), 'utf8');
  return '已写入：' + relPath;
}

async function hOpuscarReadFile(ctx, args) {
  const relPath = String(args.path || '').trim();
  if (!relPath) throw new Error('path 不能为空');
  const libRoot = OPUSCAR_LIB_ROOT;
  const filmDir = opuscarFilmDir(ctx) || '';
  let abs = path.resolve(libRoot, relPath);
  if (!isInsideDir(abs, libRoot)) abs = path.resolve(filmDir, relPath);
  if (!isInsideDir(abs, libRoot) && !isInsideDir(abs, filmDir)) throw new Error('非法路径：' + relPath);
  if (!fs.existsSync(abs)) throw new Error('文件不存在：' + relPath);
  const content = fs.readFileSync(abs, 'utf8');
  return content.length > 120000 ? content.slice(0, 120000) + '…（截断）' : content;
}

async function hOpuscarSaveFilm(ctx, args) {
  const assetId = ctx.assetId;
  if (!assetId) throw new Error('未关联视频资产');
  const asset = Assets.get(assetId);
  if (!asset || asset.project_id !== ctx.projectId) throw new Error('视频资产不存在');
  const filmDir = opuscarFilmDir(ctx);
  if (!filmDir) throw new Error('影片工作区路径非法');
  const candidates = ['out/final.mp4', 'out/video.mp4', 'final.mp4', 'video.mp4'].map((p) => path.join(filmDir, p));
  const src = candidates.find((p) => fs.existsSync(p));
  if (!src) throw new Error('未找到成片文件（已查找 out/final.mp4、out/video.mp4、final.mp4、video.mp4）');
  const name = String(args.name || asset.name || 'film').trim();
  const rel = 'assets/videos/' + slugify(name || 'film') + '_' + uid().slice(0, 8) + '.mp4';
  const abs = resolveProjectPath(ctx.projectId, rel);
  if (!abs) throw new Error('非法输出路径');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.copyFileSync(src, abs);
  Assets.update(assetId, { status: 'done', video_path: rel, name: name || asset.name });
  return '成片已保存：' + rel;
}

// —— 无限・卷轴 handler ——

function novelRel(relPath) {
  const s = String(relPath || '').trim().replace(/\\/g, '/');
  if (!s) throw new Error('path 不能为空');
  if (path.isAbsolute(s) || s.startsWith('/')) throw new Error('path 禁止绝对路径：' + relPath);
  if (s.includes('..')) throw new Error('path 禁止 ".." 段：' + relPath);
  return s;
}

async function hNovelInit(ctx) {
  ensureProjectDirs(ctx.projectId);
  const state = loadNovelState(ctx.projectId);
  const files = listNovelFiles(ctx.projectId);
  return JSON.stringify({
    project_name: ctx.project?.name || '',
    project_idea: ctx.project?.idea || '',
    files,
    has_outline: !!state.structure.outline,
    has_volumes: !!state.structure.volumes,
    has_chapters: !!state.structure.chapters,
    character_count: state.characters.length,
    volume_count: state.volumes.length,
    volumes: state.volumes.map((v) => ({ seq: v.seq, title: v.title, chapterFrom: v.chapterFrom, chapterTo: v.chapterTo })),
    memory_files: state.memory.map((m) => m.name),
  });
}

async function hNovelWriteFile(ctx, args) {
  const rp = novelRel(args.path);
  const abs = writeNovelFile(ctx.projectId, rp, String(args.content ?? ''));
  if (!abs) throw new Error('非法保存路径：' + args.path);
  return '已写入：' + rp;
}

async function hNovelReadFile(ctx, args) {
  const rp = novelRel(args.path);
  const content = readNovelFile(ctx.projectId, rp);
  if (content == null) throw new Error('非法读取路径：' + args.path);
  if (!content) return '';
  return content.length > 120000 ? content.slice(0, 120000) + '\n…（截断）' : content;
}

async function hNovelListFiles(ctx) {
  return JSON.stringify(listNovelFiles(ctx.projectId));
}

async function hNovelSaveCharacters(ctx, args) {
  const chars = args.characters;
  if (!Array.isArray(chars)) throw new Error('characters 必须是数组');
  const cleaned = chars.map((c, i) => ({
    id: String(c?.id ?? ''),
    name: String(c?.name ?? '').trim(),
    role: String(c?.role ?? '').trim(),
    description: String(c?.description ?? '').trim(),
    notes: c?.notes != null ? String(c.notes) : '',
  })).filter((c) => c.name || c.role || c.description);
  const existing = loadNovelState(ctx.projectId).characters;
  // 给新角色分配稳定 id（空 id 且 name 没重复）
  const seen = new Set(existing.map((c) => c.id).filter(Boolean));
  for (const c of cleaned) {
    if (!c.id) {
      c.id = uid().slice(0, 8);
      while (seen.has(c.id)) c.id = uid().slice(0, 8);
      seen.add(c.id);
    } else {
      seen.add(c.id);
    }
  }
  saveNovelState(ctx.projectId, { characters: cleaned });
  return JSON.stringify({ count: cleaned.length, names: cleaned.map((c) => c.name) });
}

async function hNovelGetCharacters(ctx) {
  const state = loadNovelState(ctx.projectId);
  return JSON.stringify(state.characters);
}

async function hNovelSaveVolumes(ctx, args) {
  const vols = args.volumes;
  if (!Array.isArray(vols)) throw new Error('volumes 必须是数组');
  const cleaned = vols.map((v, i) => ({
    id: String(v?.id ?? ''),
    seq: Number.isFinite(Number(v?.seq)) && Number(v?.seq) >= 1 ? Math.floor(Number(v.seq)) : i + 1,
    title: String(v?.title ?? '').trim(),
    outline: String(v?.outline ?? '').trim(),
    chapterFrom: Number.isFinite(Number(v?.chapterFrom)) ? Math.floor(Number(v.chapterFrom)) : 0,
    chapterTo: Number.isFinite(Number(v?.chapterTo)) ? Math.floor(Number(v.chapterTo)) : 0,
  })).filter((v) => v.title || v.outline || v.chapterFrom || v.chapterTo);
  saveNovelState(ctx.projectId, { volumes: cleaned });
  return JSON.stringify({ count: cleaned.length, volumes: cleaned.map((v) => ({ seq: v.seq, title: v.title, chapterFrom: v.chapterFrom, chapterTo: v.chapterTo })) });
}

async function hNovelGetVolumes(ctx) {
  const state = loadNovelState(ctx.projectId);
  return JSON.stringify(state.volumes);
}

async function hNovelGetMemory(ctx) {
  const state = loadNovelState(ctx.projectId);
  return JSON.stringify(state.memory.map((m) => ({ name: m.name, content: m.content })));
}

async function hNovelSaveMemory(ctx, args) {
  const raw = String(args.name || '').trim().replace(/\\/g, '/');
  if (!raw) throw new Error('name 不能为空');
  // 规范成 memory/<name>.md：去掉可能的 memory/ 前缀与 .md 后缀
  let name = raw.replace(/^memory\//i, '').replace(/\.md$/i, '');
  if (!name) throw new Error('name 非法');
  const rel = 'memory/' + name + '.md';
  const abs = writeNovelFile(ctx.projectId, rel, String(args.content ?? ''));
  if (!abs) throw new Error('非法记忆路径：' + name);
  return '已更新记忆：' + rel;
}

async function hNovelListChapters(ctx) {
  const list = Chapters.list(ctx.projectId).map((c) => ({
    title: c.title || '',
    seq: c.seq || 0,
    volume: c.volume ?? 1,
    outline: c.outline || '',
    wordCount: String(c.novel || '').length,
    hasContent: !!String(c.novel || '').trim(),
  }));
  return JSON.stringify(list);
}

async function hNovelSaveChapter(ctx, args) {
  const title = String(args.title || '').trim();
  if (!title) throw new Error('章节标题不能为空');
  const volume = Number.isFinite(Number(args.volume)) && Number(args.volume) >= 1 ? Math.floor(Number(args.volume)) : 1;
  const outline = String(args.outline ?? '');
  // 只有显式传了非空 content 才写正文：避免「只更新章纲」时把已写正文清空
  const content = args.content !== undefined ? String(args.content ?? '') : undefined;
  const hasContent = content !== undefined && content.length > 0;
  const existing = Chapters.list(ctx.projectId).find((c) => c.title === title);
  if (existing) {
    const patch = {};
    if (hasContent) patch.novel = content;
    if (args.volume !== undefined) patch.volume = volume;
    if (args.outline !== undefined) patch.outline = outline;
    if (Object.keys(patch).length) Chapters.update(existing.id, patch);
    return JSON.stringify({ title, updated: true, volume, wordCount: (patch.novel ?? existing.novel ?? '').length });
  }
  const c = Chapters.create(ctx.projectId, { title, novel: hasContent ? content : '', volume, outline });
  return JSON.stringify({ title: c.title, created: true, volume, wordCount: String(c.novel || '').length });
}

const HANDLERS = {
  get_project: hGetProject,
  save_context: hSaveContext,
  skill: hLoadSkill,
  skill_reference: hSkillReference,
  report: hReport,
  list_chapters: hListChapters,
  get_chapter: hGetChapter,
  set_chapter_script: hSetChapterScript,
  set_scene_state: hSetSceneState,
  list_assets: hListAssets,
  create_asset: hCreateAsset,
  update_asset: hUpdateAsset,
  generate_asset_image: hGenerateAssetImage,
  edit_asset_image: hEditAssetImage,
  change_outfit: hChangeOutfit,
  design_outfits: hDesignOutfits,
  change_age: hChangeAge,
  design_ages: hDesignAges,
  view_asset: hViewAsset,
  view_shot_references: hViewShotReferences,
  view_project_references: hViewProjectReferences,
  web_search: hWebSearch,
  download_reference_image: hDownloadReferenceImage,
  register_voice: hRegisterVoice,
  design_voice: hDesignVoice,
  generate_assets_batch: hGenerateAssetsBatch,
  generate_asset_from_reference: hGenerateAssetFromReference,
  set_storyboard_plan: hSetStoryboardPlan,
  set_storyboard: hSetStoryboard,
  list_shots: hListShots,
  update_shot: hUpdateShot,
  generate_shot_video: hGenerateShotVideo,
  regenerate_shot: hRegenerateShot,
  write_shot_video_prompt: hWriteShotVideoPrompt,
  write_video_prompts_batch: hWriteVideoPromptsBatch,
  generate_chapter_videos: hGenerateChapterVideos,
  assemble_video: hAssembleVideo,
  set_chapter_music: hSetChapterMusic,
  generate_music: hGenerateMusic,
  generate_music_asset: hGenerateMusicAsset,
  generate_video_asset: hGenerateVideoAsset,
  clone_voice: hCloneVoice,
  generate_digital_human: hGenerateDigitalHuman,
  apply_chapter_music: hApplyChapterMusic,
  list_workflows: hListWorkflows,
  opuscar_init: hOpuscarInit,
  opuscar_shell: hOpuscarShell,
  opuscar_write_file: hOpuscarWriteFile,
  opuscar_read_file: hOpuscarReadFile,
  opuscar_save_film: hOpuscarSaveFilm,
  novel_init: hNovelInit,
  novel_write_file: hNovelWriteFile,
  novel_read_file: hNovelReadFile,
  novel_list_files: hNovelListFiles,
  novel_save_characters: hNovelSaveCharacters,
  novel_get_characters: hNovelGetCharacters,
  novel_list_chapters: hNovelListChapters,
  novel_save_chapter: hNovelSaveChapter,
  novel_save_volumes: hNovelSaveVolumes,
  novel_get_volumes: hNovelGetVolumes,
  novel_get_memory: hNovelGetMemory,
  novel_save_memory: hNovelSaveMemory,
};

export async function runTool(ctx, name, args) {
  // 运行时安全守卫：扫描工具参数，命中危险命令/危险参数即拦截该次调用（不终止任务）。
  const g = guardToolCall(name, args || {});
  if (g.blocked) {
    const msg = '[安全拦截] 工具 ' + name + ' 命中危险规则 ' + g.rule + '（' + g.severity + '）：' + g.message;
    logger.warn('guard: ' + msg, { name, rule: g.rule, severity: g.severity });
    if (ctx.report) ctx.report({ phase: '安全拦截', detail: msg });
    return JSON.stringify({ blocked: true, tool: name, rule: g.rule, severity: g.severity, message: g.message });
  }
  // 封闭参数校验：拒绝未在工具 schema 中声明的顶层参数字段（未知字段=硬错误，不静默丢弃）。
  const allowedKeys = ALLOWED_ARG_KEYS.get(name);
  if (allowedKeys) {
    const unknown = Object.keys(args || {}).filter((k) => !allowedKeys.has(k));
    if (unknown.length) {
      const msg = '[安全拦截] 工具 ' + name + ' 含未声明参数：' + unknown.join(', ');
      logger.warn('guard: ' + msg, { name, unknown });
      if (ctx.report) ctx.report({ phase: '安全拦截', detail: msg });
      return JSON.stringify({ blocked: true, tool: name, rule: 'unknown-args', message: '未声明的参数字段：' + unknown.join(', ') });
    }
  }
  const h = HANDLERS[name];
  if (!h) throw new Error('未知工具：' + name);
  // 只跑 LLM 的阶段：渲染工具一律跳过。这里刻意「返回」而不是抛错——
  // 抛错会让 Agent 把同一个必然失败的调用反复重试，白烧 token 且跑不到收尾。
  // 例外：regenerate_shot 的 render=false 是纯 LLM 改写提示词（不提交 ComfyUI），LLM 阶段放行。
  const llmOnlyCall = name === 'regenerate_shot' && args && args.render === false;
  if (ctx.renderDisabled && RENDER_TOOLS.has(name) && !llmOnlyCall) {
    const reason = '渲染需另起一批（ComfyUI 与 LLM 抢显存，本阶段不启动 ComfyUI）';
    logger.warn('stage: 跳过渲染工具', { name });
    if (ctx.report) ctx.report({ phase: '渲染已跳过', detail: name + '：' + reason });
    return JSON.stringify({ skipped: true, tool: name, reason });
  }
  logger.debug('agent tool', { name, args });
  // 内置 Agent 的内容写入同样进变更日志（source=agent:<tool>），与 UI / 外部 harness 一致
  return await withWriteContext('agent:' + name, () => h(ctx, args || {}));
}
