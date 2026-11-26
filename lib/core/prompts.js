import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

// —— 剧本生成 ——
export function buildScriptMessages({ idea, novel, style }) {
  const source = novel?.trim()
    ? '以下是用户提供的小说文本：\n' + novel.trim()
    : '以下是用户提供的故事想法：\n' + (idea?.trim() || '（无）');
  const styleLine = style?.trim() ? '画面风格：' + style.trim() + '。所有视觉元素（角色、场景、道具）需统一遵循此风格。' : '';
  const system = [
    '你是一名专业的漫剧（动态漫画/有声漫画）编剧与分镜师。',
    '根据用户提供的小说文本或故事想法，创作一部适合制作成漫剧的完整剧本。',
    styleLine,
    '只输出严格合法的 JSON，结构如下（字段名不可更改）：',
    JSON.stringify({
      title: '剧名',
      logline: '一句话梗概',
      characters: [{ name: '角色名', appearance: '外貌、服装、气质等视觉描述，用于文生图', voice: '声音特征描述，用于配音参考' }],
      scenes: [{ name: '场景名', description: '场景环境、光线、风格描述，用于文生图' }],
      props: [{ name: '道具名', description: '道具外观描述，用于文生图' }],
      storyboard: [{ shot: 1, scenes: ['场景名'], duration: 12, characters: ['角色名'], props: ['道具名'], sub_shots: '0-3秒（近景、近距离、正前方平视、固定机位）：画面内容描述；运镜：静止；背景声音描述；台词：人物名+台词。3-7秒（中景、中距离、正前方平视、跟拍）：画面内容描述；背景声音描述；台词：人物名+台词。7-12秒（全景、远距离、俯视、缓推）：画面内容描述；背景声音描述；台词：人物名+台词。' }],
    }, null, 2),
    '要求：',
    '- characters 1~5 个，每个都有 appearance 和 voice；',
    '- scenes 1~5 个；',
    '- storyboard 里的每个分镜就是一个「场景（主分镜/长镜头）」：尽量少拆分镜，把同一场景里连续的动作/对话/走位合并进一个长镜头，duration 建议 8~15 秒（最长 15 秒），避免 3~5 秒的短镜头碎剪；',
    '- 每个主分镜的 characters 可包含多个角色、scenes 可包含 1~2 个场景、props 可包含多个道具（用名称数组表示）；',
    '- 每个主分镜用 sub_shots 描述「子分镜时间轴」：把整个场景按时间连续拆成多个子分镜（如 0-3秒、3-7秒、7-12秒），子分镜时间首尾相接、各子分镜时长之和等于该主分镜 duration；每个子分镜写清括号内的镜头描述（景别/距离/角度/机位）、画面内容、运镜、背景声音、台词（人物名+台词）；',
    '- 台词口语化，适合配音，不出现动作标注；用标点（叹号/问号/省略号）与短句断句体现情绪和语速变化，不要把「愤怒地/语速快」等情绪标签写进台词正文；',
    '- 只输出 JSON，不要任何多余文字或解释。',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: source },
  ];
}

// —— 章节剧本生成 / 改写 ——
// 输出「可分镜的中文剧本文本」：场次 + 动作 + 台词 + 旁白，不输出 JSON。
const SCRIPT_SOURCE_LIMIT = 12000;
const SCRIPT_DEFAULT_INSTRUCTION = '在不改变剧情走向与结局的前提下润色剧本，强化节奏与台词口语化，使每个场次都能直接拆分镜。';

function clipScriptSource(text, limit = SCRIPT_SOURCE_LIMIT) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return '';
  return s.length > limit ? s.slice(0, limit) + '\n……（已截断，仅保留前 ' + limit + ' 字）' : s;
}

export function buildChapterScriptMessages({ chapterTitle, novel, idea, style, script, instruction, mode }) {
  const rewrite = mode === 'rewrite';
  const styleLine = style?.trim() ? '画面风格：' + style.trim() + '。' : '';
  const system = [
    '你是一名专业的中文漫剧编剧，负责把小说/故事写成可直接拆分成镜头的章节剧本。',
    styleLine,
    '输出格式（必须严格遵守）：',
    '1. 按场次组织，每场以「【第N场｜时间｜地点】」开头；',
    '2. 每场依次写：出场人物、场景与动作描述、台词（写成「人物名：台词」）、必要的旁白；',
    '3. 台词口语化、可直接配音；用标点（叹号/问号/省略号）体现情绪与语速，不写「愤怒地/语速快」等情绪标签；',
    '4. 场次与剧情要完整覆盖原文，不省略关键情节；人物名、地名、关键道具名保持原文一致；',
    '5. 只输出剧本正文，不要输出 JSON、Markdown 表格、标题解释或任何多余说明。',
  ].filter(Boolean).join('\n');

  const parts = ['章节：' + (chapterTitle || '（未命名）')];
  if (rewrite) {
    parts.push('修改要求：' + (String(instruction || '').trim() || SCRIPT_DEFAULT_INSTRUCTION));
    parts.push('以下是需要改写的现有剧本：\n' + clipScriptSource(script));
    if (clipScriptSource(novel)) parts.push('以下是本章小说原文（仅作剧情与人物参考）：\n' + clipScriptSource(novel));
    parts.push('请输出改写后的完整剧本正文（不是修改说明）。');
  } else if (clipScriptSource(novel)) {
    parts.push('以下是本章小说原文，请据此写完整剧本：\n' + clipScriptSource(novel));
    parts.push('请输出完整剧本正文。');
  } else {
    parts.push('以下是故事想法，请据此展开写完整剧本：\n' + (String(idea || '').trim() || '（无）'));
    parts.push('请输出完整剧本正文。');
  }

  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

const QWEN_IMAGE_GUIDE = [
  '1. 结构化优于叙事化：按「主体 → 环境/背景 → 光照/材质/色调/视角等细节」分类描述，避免流水账长句；',
  '2. 描述优先级：先写主体核心特征，再写环境设定，最后补充细节（材质、光影、色调、镜头视角）；',
  '3. 简洁胜于冗长：1~3 句话最佳，去掉冗余修饰；',
  '4. 明确镜头视角：特写/中景/全景、正面/侧面/背面、平视/俯视/仰视等要写清楚；',
  '5. 允许保留与主体相关的真实文字（招牌、书名、包装标签、屏幕文案、道具品牌名/logo 等），并写清文字内容与位置；不要出现与画面无关的字幕条、水印、签名或乱码；',
  '6. 必须输出负向提示词 negative_prompt：通用排除 blurry, low quality, pixelated, distorted, watermark, oversaturated, artificial, plastic-looking；人物类额外排除 extra fingers, deformed hands, mutated hands, fused fingers, plastic skin, over-smoothed。',
].join('\n');

let _guideCache = null;
function loadQwenGuide() {
  if (_guideCache !== null) return _guideCache;
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'Qwen-Image-2512_提示词实战指南.md'), 'utf8');
    _guideCache = raw.split('\n').filter((l) => !l.trimStart().startsWith('![Image](') && !l.trimStart().startsWith('>') && !l.trimStart().startsWith('### 5.2')).join('\n').trim();
    if (!_guideCache) _guideCache = '';
  } catch { _guideCache = ''; }
  return _guideCache;
}

export function buildAssetPromptMessages({ type, name, description, scriptSummary, style }) {
  const typeLabel = { character: '角色/人物', scene: '场景', prop: '道具' }[type] || '对象';
  const typeRule = type === 'character'
    ? '- 只描述人物本身的相貌、年龄、发型、服装、配饰、体型与气质；不要描述视图数量、分格、版式、背景、光线、相机、画幅比例或画质参数——这些由系统统一注入，避免出现第二套互相冲突的版式指令；'
    : type === 'scene'
      ? '- 这是场景环境图：突出环境氛围、空间透视、光线与风格，画面完整可作背景；'
      : '- 这是道具图：白色背景（纯白底），画面中只出现该道具本身，不要出现人物、场景或其他无关元素；道具自带的真实文字/标签/包装说明/品牌 logo 必须保留，并在提示词里写清具体内容与位置；只描述道具的形状/材质/细节等特征；';
  const guideText = loadQwenGuide() || QWEN_IMAGE_GUIDE;
  const user = [
    '请为一个漫剧项目里的' + typeLabel + '编写文生图提示词。',
    '类型：' + typeLabel,
    '名称：' + name,
    '设定描述：' + (description || '（无，请根据名称与剧本自行合理发挥）'),
    '剧本摘要：' + (scriptSummary || '（无）'),
    '要求：',
    typeRule,
    '- 画面风格：' + (style?.trim() || '适合漫剧的精美二次元/国漫插画风格') + '（保持与项目整体风格一致）；',
    '- 严格参考系统提示词中的《Qwen-Image-2512 提示词实战指南》编写：结构化分类描述（主体→环境→细节）、简洁（80~150 字）、明确镜头视角；',
    '- 同时给出负向提示词 negative_prompt；',
    '- 纯中文，prompt 直接可喂给文生图模型；',
    '- 只输出 JSON：{"prompt":"...","negative_prompt":"..."}。',
  ].join('\n');
  return [
    { role: 'system', content: '你是一名专业的 AI 绘画提示词专家，擅长为 Qwen-Image-2512 文生图模型编写高质量中文提示词。\n\n以下是《Qwen-Image-2512 提示词实战指南》，你必须严格参考其中的原则来编写提示词：\n\n<Qwen-Image-2512 实战指南>\n' + guideText + '\n</Qwen-Image-2512 实战指南>\n\n只输出 JSON：{"prompt":"...","negative_prompt":"..."}。' },
    { role: 'user', content: user },
  ];
}

export function fallbackAssetPrompt({ type, name, description, style }) {
  const s = style?.trim() || '适合漫剧的精美二次元/国漫插画风格';
  const d = description?.trim() || '';
  // 文字策略：允许保留与主体相关的真实文字（招牌/书名/包装标签/品牌 logo 等），
  // 只排除与画面无关的字幕条、水印、签名——产品道具的包装文字不能再被抹掉。
  const textRule = '；允许出现与主体相关的真实文字（招牌、书名、包装标签、品牌名/logo 等），写清文字内容与位置，不要出现与画面无关的字幕条、水印、签名或乱码';
  const commonNeg = 'blurry, low quality, pixelated, watermark';
  if (type === 'character') {
    return {
      // 人物提示词只写「长什么样」；版式/背景/光位/视图数量统一由
      // CHARACTER_T2I_LAYOUT_CONSTRAINT 注入，避免两套指令互相打架。
      prompt: '人物外观：' + name + (d ? '，' + d : '') + '；只描述相貌、年龄、发型、服装、配饰、体型与气质，不描述视图、分格、背景、光线或画幅比例。相貌要精致、五官立体、轮廓分明、好看有辨识度；皮肤必须写英文强压：flawless, smooth, even, clear, radiant skin, absolutely no freckles, no blemishes, no spots（男女都必须无斑，中文"无斑点"压不住写实模型的雀斑先验）。气质高级、干净，不刻意像任何明星。',
      negative_prompt: commonNeg + ', extra fingers, deformed hands, mutated hands, fused fingers, plastic skin, over-smoothed',
    };
  }
  if (type === 'scene') {
    return {
      prompt: '场景：' + name + (d ? '，' + d : '') + '；突出环境氛围、空间透视、光线与风格，画面完整可作背景' + textRule + '；画面风格：' + s,
      negative_prompt: commonNeg + ', oversaturated, artificial, plastic-looking',
    };
  }
  return {
    prompt: '道具：' + name + (d ? '，' + d : '') + '；纯白背景，画面中只出现该道具本身，无人物、无其它无关元素；道具自带的文字/标签/包装说明/品牌 logo 必须保留并写清内容' + textRule + '；突出形状、材质、细节；画面风格：' + s,
    negative_prompt: commonNeg + ', person, extra elements',
  };
}

// 人物文生图的唯一权威版式契约：
// 四格等宽角色设定板（大脸特写 / 正面全身 / 90°侧面全身 / 背面全身），
// 同一人物、服装、发型、光位、身体比例，纯白无缝背景，画面内无文字与装饰。
// 所有人物 t2i 工作流都必须在最终提示词里带上这一段，LLM 只负责描述人物外观。
// 背景一律纯白：灰底/灰缝/渐变会被下游 H3 当成场景元素带进视频，造成"环境脏、人物飘"的污染。
export const CHARACTER_T2I_LAYOUT_CONSTRAINT = [
  '【人物设定板｜强制版式，优先级最高】',
  '一张横向四格角色设定板，四格等宽并排，铺满整张画面宽度，每格占满画面高度。',
  '从左至右：',
  '第一格：正面大脸特写，头肩完整入画。',
  '第二格：正面全身，从头到脚，正面朝镜头。',
  '第三格：90°侧面全身，从头到脚。',
  '第四格：背面全身，从头到脚。',
  '四格是同一人物、同一服装、同一发型、同一光位、同一身体比例。',
  '背景为纯白无缝背景（#FFFFFF），均匀一致，一直延伸到画面四边；四格共用这一整片连续纯白。',
  '单一柔光自左上方打入，四格光位与色温完全一致，电影级质感。',
  '皮肤要求（2026-11-21 实测定版，分男女两档）：女性用 flawless, smooth, even, clear, radiant skin, no freckles, no blemishes, no spots, no dullness（可做到彻底无斑）；男性（中年）接受自然皮肤质感、年龄感优先，只用 clean-shaven, well-groomed, fresh clear skin, smooth even complexion 兜住"不邋遢、不满脸斑"的底，不写 no age spots/no sun spots/no wrinkles 这类无效否定词。皮肤干净通透、均匀、有自然光泽，不过度磨皮、不塑料感。',
  '颜值气质：五官精致立体、轮廓分明、眉眼有神、妆面干净，好看、有辨识度、有高级气质；不刻意模仿任何现实明星或网红，是"长得好看的普通人"而非"某明星既视感"。',
  '画面里只有这一位人物与纯白背景。',
].join('\n');

export const CHARACTER_T2I_NEGATIVE_CONSTRAINT =
  'extra panels, two panels, three panels, five panels, duplicate character, multiple people, different faces, different outfits, inconsistent body proportions, cropped head, cropped feet, text, watermark, logo, border decoration, black vertical bars, outer border, props, grainy, noisy, plastic skin, over-smoothed skin, deformed hands, grey backdrop, gray background, colored background, gradient background, textured backdrop, studio backdrop, cast shadow on wall, floor line, freckles, blemishes, acne, age spots, sun spots, dark spots, uneven skin, dull skin, rough skin, splotchy skin';

const CHARACTER_LAYOUT_MARKER = '【人物设定板｜强制版式';

// 判断一段文本是否「自带版式/构图指令」——用户或 LLM 把四视图、背景、光位、构图、负面限制
// 整段写进 prompt 时，与系统契约冲突。系统契约是唯一权威，必须把这些段落整体剔除，
// 只保留「人物长什么样」的纯外观描述。
const LAYOUT_SECTION_RE = /(【[^】]*(?:构图|版式|四视图|四格|画面统一性|负面|限制|背景|光线|光位)[^】]*】)/g;

// 把旧提示词里已有的版式/背景/光位描述剥离，只保留人物外观。
// 旧 LLM 提示词常写成 “left one-third + right two-thirds + studio background”，
// 如果直接再追加统一契约，模型会收到两套版式指令，导致视图数量漂移。
function stripCharacterLayout(prompt) {
  let text = String(prompt || '').split(CHARACTER_LAYOUT_MARKER)[0].trim();
  if (!text) return '';
  // 先整体剥掉「构图/版式/四视图/画面统一性/负面限制/背景/光位」这类带标题的段落
  text = text.replace(LAYOUT_SECTION_RE, '');
  const layoutRe = new RegExp(
    [
      '左侧', '右侧', '左\\s*1/3', '右\\s*2/3', '1/3', '2/3', '三视图', '四视图', '视图', '四格', '格子', '格',
      '分格', '版式', '横向布局', '横向宽幅', '宽幅', '横版', '竖版', '背景', '底色', '浅色', '纯白', '白底',
      '影棚', '无缝', '光位', '光线', '打光', '柔光', '主光', '补光', '构图', '画幅',
      '全身', '头顶到脚尖', '正面、侧面', '正面/侧面', '特写', '从.?左到右', '第.?格', '四.?区域', '区域',
      'turnaround', 'character\\s+sheet', 'horizontal\\s+layout', '16:9', 'four.?panel',
      'left\\s*[- ]?one\\s*[- ]?third', 'right\\s*[- ]?two\\s*[- ]?thirds',
      'full[- ]body', 'front\\s*[,/]\\s*side', 'side\\s*[,/]\\s*back',
      'head\\s*to\\s*toe', 'studio\\s+background', 'seamless', 'key\\s+light',
      'lighting', 'background', 'composition', 'multiple\\s+views', 'three[- ]view', 'four[- ]view',
      '^\\s*(front|side|back)(\\s+view)?\\s*$',
    ].join('|'),
    'i',
  );
  const parts = text.split(/([，,；;。.\n]+)/);
  const kept = [];
  for (let i = 0; i < parts.length; i += 2) {
    const clause = (parts[i] || '').trim();
    if (!clause) continue;
    if (layoutRe.test(clause)) continue;
    // 否定句整句删：系统契约已是正向事实，「不要/禁止/没有/无需」这类词根会被模型画出来
    if (/不要|不要出现|禁止|不得|无需|没有|不含|不出现|不包含|勿/.test(clause)) continue;
    kept.push(clause);
  }
  return kept.join('，').replace(/[，,；;。\n]{2,}/g, '，').replace(/^[，,；;。\n]+|[，,；;。\n]+$/g, '').trim();
}

// 人物 t2i 最终提示词 = 系统版式契约 + 人物外观（旧版式描述已剥离）。
// 版式永远由系统强制注入（四视图 + 纯白 + 英文无斑 + 颜值气质），用户/LLM 只负责「长什么样」——
// 这是 skill 里「四格版式固定、AI 出错率最高」这条规范的代码级落地，不依赖 AI 自觉。
// 注意：这里**不拼项目风格行**。人物设定板只承担「这张脸长什么样」，
// 一旦把「青绿调/霓虹溢色/胶片颗粒」这类色彩与光效写进来，纯白底会被染色，
// 下游 H3 再拿它当参考图，整片人物都带色调。风格由场景图与视频层承载。
export function composeCharacterT2IPrompt(prompt, style) { // eslint-disable-line no-unused-vars
  const appearance = stripCharacterLayout(prompt);
  return [CHARACTER_T2I_LAYOUT_CONSTRAINT, appearance ? '角色外观：' + appearance : '']
    .filter(Boolean)
    .join('\n');
}

export function composeCharacterNegativePrompt(negative) {
  const base = String(negative || '').trim();
  return [base, CHARACTER_T2I_NEGATIVE_CONSTRAINT].filter(Boolean).join(', ');
}

export function buildStoryboardMessages(script, style) {
  const styleLine = style?.trim() ? '画面风格：' + style.trim() + '。' : '';
  return [
    { role: 'system', content: '你是一名漫剧分镜师。根据剧本，输出分镜列表 JSON：{"storyboard":[{"shot":1,"scenes":["场景名"],"duration":12,"characters":["角色名"],"props":["道具名"],"sub_shots":"0-3秒（近景、近距离、正前方平视、固定机位）：画面内容；运镜：静止；背景声音；台词：人物名+台词。..."}]}。每个分镜就是一个场景（主分镜/长镜头），尽量少拆分镜、把同一场景连续动作合并，duration 建议 8~15 秒（最长 15 秒）；characters/scenes/props 用名称数组；sub_shots 是把整个场景按时间连续拆成多个子分镜的画面提示词，子分镜时间首尾相接、时长之和等于 duration。台词口语化，用标点（叹号/问号/省略号）体现情绪与语速节奏，不要把情绪标签写进台词正文。' + styleLine + '只输出 JSON。' },
    { role: 'user', content: '剧本如下：\n' + JSON.stringify(script, null, 2) },
  ];
}

// —— MiniMax H3 视频提示词（兜底）——
// 仅在 LLM 尚未通过「视频提示词」节点技能（h3-storyboard）写出 shot.video_prompt 时使用的最小兜底：
// 按 H3 规范用 __MINIMAX_H3_REF_N__ 逐个引用参考素材，注入风格/角色/场景一致性描述。
export function fallbackVideoPrompt({ references, style, characterDesc, sceneDesc, subShots, camera, visual, dialogue, characterName }) {
  const parts = [];
  if (style) parts.push('画面风格：' + style);
  (references || []).forEach((ref, i) => {
    parts.push('__MINIMAX_H3_REF_' + (i + 1) + '__' + (ref.label || '参考'));
  });
  if (characterDesc) parts.push('角色保持一致：' + characterDesc);
  if (sceneDesc) parts.push('场景保持一致：' + sceneDesc);
  if (subShots) parts.push('分镜时间轴：' + subShots);
  else {
    if (camera) parts.push('镜头：' + camera);
    if (visual) parts.push(visual);
    if (dialogue) parts.push((characterName || '角色') + '根据台词标点自然流露情绪、语速随句意起伏地说出“' + dialogue + '”');
  }
  parts.push('参考图仅作外观/风格/场景参考（不要当作首尾帧或关键帧），参考图本身（角色三视图、场景九宫格、道具板）不得原样出现在成片画面中；画面中不得出现任何文字、字幕、水印、logo、标语');
  return parts.join('，');
}

// —— 对白说话人解析与参考音频约束 ——
// 单个分镜最多允许的说话人数量（≥3 人对话必须拆成多个分镜）
export const MAX_SPEAKERS_PER_SHOT = 2;
// 单个分镜参考素材中最多允许的音频段数（MiniMax H3 节点 maxAudioVideo 上限）
export const MAX_AUDIO_REFS = 3;
// 单个分镜参考图中最多允许的图片数（用户定：H3 参考图控制在 7 张以内为最优；超出按 人物>场景>道具 裁剪）
export const MAX_IMAGE_REFS = 7;

// 从对白字符串中提取所有说话人名字：每行「人物：台词」，取第一个全/半角冒号前的人名，
// 剥离舞台提示括号（如「林默（站在路口）」）与句尾标点；无冒号行（画面/旁白描述）跳过。
export function dialogueSpeakerNames(dialogue) {
  if (!dialogue) return [];
  const names = new Set();
  for (const line of String(dialogue).split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^(.+?)[：:]/);
    if (!m) continue;
    const name = m[1]
      .replace(/[(（][^()（）]*[)）]/g, '')   // 剥离舞台提示（站在路口）/(望着远处)
      .replace(/[，。、,;；!！?？.·]+$/g, '') // 剥离句尾标点
      .trim();
    if (name) names.add(name);
  }
  return [...names];
}

// 解析子分镜时间轴里最大的「结束秒数」
export function parseSubShotEndSeconds(text) {
  if (!text) return null;
  let max = null;
  const re = /(\d+(?:\.\d+)?)\s*[-~—–至到]\s*(\d+(?:\.\d+)?)\s*秒/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const end = parseFloat(m[2]);
    if (max === null || end > max) max = end;
  }
  return max;
}

export function validateSubShots(duration, subShots) {
  const maxEnd = parseSubShotEndSeconds(subShots);
  if (maxEnd !== null && maxEnd > (parseFloat(duration) || 0)) {
    return '子分镜提示词的时间（' + maxEnd + ' 秒）超过了总时长（' + (parseFloat(duration) || 0) + ' 秒）';
  }
  return null;
}
