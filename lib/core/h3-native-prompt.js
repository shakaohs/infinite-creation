// H3 原生 Ref2VA 节点的提示词适配器。
//
// 项目内置的 H3 Easy 规格使用平铺占位符 __MINIMAX_H3_REF_N__；
// ComfyUI 原生 MiniMaxH3ReferenceToVideo 节点只认官方标签
// <Subject N> / <Picture N> / <Audio N> / <Video N>，并且要求官方六段式结构：
//   subject_definitions / summary / retention_analysis /
//   detailed_description / overall_soundscape / non_diegetic_music
// 这里只在 spec.promptFormat === 'minimax-ref2va' 时启用，不影响其它工作流。

const PLACEHOLDER_RE = /__MINIMAX_H3_REF_(\d+)__/g;
const SECTION_KEYS = [
  'subject_definitions',
  'summary',
  'retention_analysis',
  'detailed_description',
  'overall_soundscape',
  'non_diegetic_music',
];
const SECTION_HEAD_RE = /(^|\n)[ \t]*(subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music)[ \t]*(?::|(?=\n|$))/g;

function tagFor(kind, ordinal) {
  if (kind === 'image') return '<Picture ' + ordinal + '>';
  if (kind === 'audio') return '<Audio ' + ordinal + '>';
  if (kind === 'video') return '<Video ' + ordinal + '>';
  return '';
}

function collectTags(references) {
  const refs = Array.isArray(references) ? references : [];
  const byGlobalIndex = new Map();
  const items = [];
  const counters = { image: 0, audio: 0, video: 0 };
  refs.forEach((ref, i) => {
    const kind = ref && ref.type === 'audio' ? 'audio' : ref && ref.type === 'video' ? 'video' : 'image';
    counters[kind] += 1;
    const ordinal = counters[kind];
    const tag = tagFor(kind, ordinal);
    byGlobalIndex.set(i + 1, tag);
    items.push({ kind, ordinal, tag, label: String(ref?.label || '').trim() });
  });
  return { byGlobalIndex, items };
}

function replacePlaceholders(text, byGlobalIndex) {
  return String(text || '').replace(PLACEHOLDER_RE, (m, n) => byGlobalIndex.get(Number(n)) || m);
}

// 解析已有段落。支持两种官方写法：
//   subject_definitions:\n...
//   overall_soundscape: Quiet room tone...（标题和正文同一行）
function parseSections(text) {
  const source = String(text || '');
  const matches = [];
  SECTION_HEAD_RE.lastIndex = 0;
  let m;
  while ((m = SECTION_HEAD_RE.exec(source))) {
    matches.push({ key: m[2], start: m.index, bodyStart: m.index + m[0].length });
  }
  const sections = {};
  const preamble = matches.length ? source.slice(0, matches[0].start).trim() : '';
  matches.forEach((item, i) => {
    const end = i + 1 < matches.length ? matches[i + 1].start : source.length;
    sections[item.key] = source.slice(item.bodyStart, end).trim();
  });
  return { sections, preamble };
}

function hasAllOfficialSections(text) {
  const { sections } = parseSections(text);
  return SECTION_KEYS.every((key) => typeof sections[key] === 'string' && sections[key].trim());
}

function looksLikeChinese(text) {
  return /[\u3400-\u9fff]/.test(String(text || ''));
}

function subjectLine(item) {
  if (item.kind === 'image') {
    return '<Subject ' + item.ordinal + '> is the subject shown in ' + item.tag
      + '. Preserve its identity, facial appearance, hairstyle, clothing and body proportions.';
  }
  if (item.kind === 'audio') {
    return '<Audio ' + item.ordinal + '> is the voice-timbre reference for the corresponding speaking character. '
      + 'Preserve the voice identity and pronunciation.';
  }
  return '<Video ' + item.ordinal + '> is the motion reference. Preserve the motion pattern and timing.';
}

function retentionLine(item) {
  if (item.kind === 'image') {
    return '<Subject ' + item.ordinal + '> (image): fully_preserved — preserve the identity and appearance carried by '
      + item.tag + '.';
  }
  if (item.kind === 'audio') {
    return '<Audio ' + item.ordinal + '> (audio): reference — preserve the voice timbre and pronunciation.';
  }
  return '<Video ' + item.ordinal + '> (video): reference — preserve the motion and timing.';
}

// 扁平提示词里常见的否定式（No subtitles / no text / without watermark）会让 H3 把「无字幕」
// 当成画面内容去生成——否定词根会被渲染。这里**直接删掉**该短语，不替换成正向句：
// 任何替换句（如 all visible lettering is diegetic signage）都自带 lettering/signage 词根，
// 等于换个说法继续诱导模型画字。官方六段式原文不改写。
function sanitizeFlatPrompt(text) {
  return String(text || '')
    // 长备选必须排在短备选前面：text\s+overlays 在 text 之前，否则 "no text overlays" 只吃掉
    // "no text"、留下一个孤零零的 overlays。
    .replace(/\b(?:no|without|zero)\s+(?:any\s+)?(?:on[- ]screen\s+)?(?:subtitles?|captions?(?:\s+bars?)?|text\s+overlays?|text|overlay\s+graphics|watermarks?|logos?|signatures?)\b/gi, '')
    .replace(/([,;:])(?:\s*[,;:])+/g, '$1')   // 连删多段后留下的 ",,," 收敛成 ","
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/[,;:]\s*(?=[.!?])/g, '')
    .replace(/([.!?])[.!?]+/g, '$1')          // ".." / "..." 收敛成 "."
    .replace(/^[\s,;:.]+/, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function firstSentence(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const m = clean.match(/^(.{1,220}?[.!?])\s/);
  return (m ? m[1] : clean.slice(0, 220)).trim();
}

function summaryWithType(summary, fallbackText) {
  const clean = String(summary || firstSentence(fallbackText) || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '[reference generation] Generate the described shot with consistent identity and environment.';
  const types = ['reference generation', 'keyframe completion', 'video editing', 'video continuation', 'audio reuse', 'audio reference'];
  // 只有方括号里是官方任务类型时才认为已有前缀；[Shot 1] 不是任务类型，不能被当成 summary 前缀。
  if (clean.startsWith('[')) {
    const inner = clean.match(/^\[([^\]]+)\]/)?.[1]?.toLowerCase() || '';
    if (types.includes(inner)) return clean;
  }
  // 兼容没有方括号、直接写 "reference generation — ..." 的旧提示词。
  const stripShot = (s) => String(s || '').replace(/^\[Shot\s+\d+\]\s*/i, '').trim();
  const hit = types.find((t) => clean.toLowerCase().startsWith(t));
  if (hit) return '[' + hit + '] ' + stripShot(clean.slice(hit.length).replace(/^[\s\-—:]+/, ''));
  return '[reference generation] ' + stripShot(clean);
}

function musicSection(text) {
  if (/\bno\s+(?:non[- ]diegetic\s+)?music\b|无配乐|没有音乐|不要音乐/i.test(String(text || ''))) return 'N/A';
  if (/\bmusic\b|\bsoundtrack\b|\bscore\b|\bbgm\b|配乐|音乐/i.test(String(text || ''))) {
    return 'Preserve the music described in the shot; keep it consistent with the action and dialogue.';
  }
  return 'N/A';
}

function defaultSections(flatPrompt, items) {
  const clean = sanitizeFlatPrompt(flatPrompt);
  const detailed = clean || 'Describe the shot in one continuous take.';
  return {
    subject_definitions: items.length
      ? items.map(subjectLine).join('\n')
      : 'N/A',
    summary: summaryWithType('', detailed),
    retention_analysis: items.length
      ? items.map(retentionLine).join('\n')
      : 'N/A',
    detailed_description: detailed,
    overall_soundscape: 'Natural ambience and diegetic sound consistent with the described action. Dialogue is carried by the reference voice.',
    non_diegetic_music: musicSection(clean),
  };
}

function assembleSections(sections) {
  return SECTION_KEYS.map((key) => key + ':\n\n' + String(sections[key] || '').trim()).join('\n\n');
}

/**
 * 将项目生成的平铺占位符提示词转换为原生 H3 Ref2VA 可读的官方结构。
 * - 已经是完整官方六段式：只替换占位符，并补上 summary 的任务类型前缀。
 * - 只有部分段落：保留已有段落，补齐缺失段落，不把整段文本重复塞进 summary 和 detailed。
 * - 完全扁平：按参考素材生成六段式。
 */
export function compileMinimaxRef2vaPrompt(prompt, references) {
  // 平铺占位符（__MINIMAX_H3_REF_N__）是旧 Easy 工作流的产物：LLM 手写时拿不到参考素材真实编号，
  // 编号必然与 references 错位，编译成六段式只会产出「空壳 subject_definitions + 音色被标成 Picture」的垃圾。
  // 这里直接拒绝，强制上游用 write_shot_video_prompt 重新生成官方六段式，而不是硬套空壳掩盖问题。
  if (PLACEHOLDER_RE.test(String(prompt || ''))) {
    throw new Error('video_prompt 仍是旧平铺占位符格式（__MINIMAX_H3_REF_N__），参考素材编号已错位，无法安全编译。请用 write_shot_video_prompt 重新生成该分镜的官方六段式提示词。');
  }
  const { byGlobalIndex, items } = collectTags(references);
  const replaced = replacePlaceholders(prompt, byGlobalIndex);
  const { sections, preamble } = parseSections(replaced);
  const found = Object.keys(sections).filter((key) => SECTION_KEYS.includes(key) && sections[key].trim());

  if (!found.length) {
    return assembleSections(defaultSections(replaced, items));
  }

  const defaults = defaultSections(replaced, items);
  const merged = {};
  for (const key of SECTION_KEYS) {
    merged[key] = sections[key] && sections[key].trim() ? sections[key].trim() : defaults[key];
  }
  // summary 必须总结「目标视频」，不能把 subject_definitions 的标题当正文。
  // 原文没有 summary 时，用补好的 detailed_description 重新提炼，而不是用整段原始文本。
  if (!sections.summary || !sections.summary.trim()) {
    merged.summary = summaryWithType('', merged.detailed_description);
  }
  // 已有完整六段式时不改动正文，只给 summary 补官方任务类型前缀。
  if (hasAllOfficialSections(replaced)) {
    merged.summary = summaryWithType(merged.summary, merged.detailed_description);
    return assembleSections(merged);
  }
  // 部分段落：preamble 是第一个标题之前的正文，不能被丢掉；挂到 detailed_description 开头。
  if (preamble) merged.detailed_description = preamble + '\n' + merged.detailed_description;
  merged.summary = summaryWithType(merged.summary, merged.detailed_description);
  return assembleSections(merged);
}

export function isOfficialMinimaxPrompt(text) {
  return hasAllOfficialSections(text);
}

// Ref2VA 严禁指令行：规范里的 I2VA/FL2VA/L2VA 指令行只适用于首尾帧模式。
// LLM 读了 h3-format.md 全文后常"凭手感"在六段式前加一行 "How the reference pictures align..."
// 或 "For the target video, at 0.00 seconds..."，会被 H3 当成首尾帧对齐指令 → 参考帧错位。
// 返回 true 表示检测到禁用指令行（应判 FAIL 重试）。
export function hasRef2vaInstructionLine(text) {
  const s = String(text || '');
  // 只看首个实质段标题之前的前导区；正文里出现的 from Shot N / aligns with the X-second mark 也要拦。
  const firstSection = s.search(/(?:^|\n)\s*subject_definitions\s*(?:\n|$)/i);
  const head = firstSection > 0 ? s.slice(0, firstSection) : s.slice(0, 400);
  const headHit = /For the target video,?\s+at\s+0\.00\s+seconds|How the reference pictures align with the target video|aligns?\s+with\s+the\s+[\d.]+-second mark/i.test(head);
  const bodyHit = /\bfrom\s+\[?Shot\s*\d+\]?\b|aligns?\s+with\s+the\s+[\d.]+-second mark/i.test(s);
  return headHit || bodyHit;
}
