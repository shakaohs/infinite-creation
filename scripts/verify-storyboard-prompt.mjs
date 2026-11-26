// 真实复现 writeShotVideoPrompt 的核心链路：
// forest-laoli-h3 技能全文 → sys 六段式强约束 → user 项目/分镜/参考素材 → 真实 LLM 调用 → 官方六段式
// 产出「前端提交后 LLM 实际会写出的最终提示词」，供用户拿去测试 H3。
import { llmChat } from '../lib/core/llm.js';
import { loadSkillWithResources, renderSkillContent } from '../lib/agent/skill-engine.js';
import { loadConfig } from '../lib/core/config.js';

const cfg = loadConfig();
const llmCfg = { ...cfg.llm, model: 'deepseek-chat' };

// 镜 2：程远舟 / 姜知微，7s，双人对话，2 句台词，含音色参考
const shot = {
  idx: 2,
  duration: 7,
  scene_name: '云港码头 · 接驳车旁',
  camera: '中近景，70度侧角，固定机位，正反打',
  visual: '程远舟坐在接驳车侧滑门内看手机，抬头催妻子；姜知微站在车门外，一条行李箱边抵着膝盖',
  dialogue: '程远舟：知微，快点，游船马上就要开了。\n姜知微：好，这是最后一个箱子了。',
  sub_shots: '',
};

// 参考素材（顺序固定，与图槽表一致）
const references = [
  { type: 'image', label: '姜知微（女主，米灰针织衫）' },
  { type: 'image', label: '程远舟（丈夫，海军蓝衬衫）' },
  { type: 'image', label: '接驳车侧滑门场景' },
  { type: 'image', label: '手机道具' },
  { type: 'audio', label: '姜知微音色' },
  { type: 'audio', label: '程远舟音色' },
];

const project = {
  style: '90 年代港产文艺片：低饱和青绿调、16mm 胶片颗粒、窗外霓虹溢色、硬侧光、浅景深',
};

// 复现 writeShotVideoPrompt 的 sys/user 组装
const skill = loadSkillWithResources('forest-laoli-h3');
const skillText = skill ? renderSkillContent({ ...skill, references: [] }) : '';

const nativeH3 = true; // promptFormat = minimax-ref2va
let imageOrd = 0, audioOrd = 0, videoOrd = 0;
const refLines = references.map((r) => {
  const tag = r.type === 'audio'
    ? '<Audio ' + (++audioOrd) + '>'
    : r.type === 'video'
      ? '<Video ' + (++videoOrd) + '>'
      : '<Picture ' + (++imageOrd) + '>';
  return tag + ' = ' + (r.type === 'audio' ? '音色：' : '图片：') + (r.label || '参考素材');
});

const sys = [
  skillText,
  '你是视频提示词撰写助手：严格按上面的技能规范，为一条 MiniMax H3 分镜写「完整的视频提示词」。',
  '当前工作流是原生 MiniMaxH3ReferenceToVideo：必须输出官方 Ref2VA 六段式（subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music），正文全英文，参考素材一律用 <Picture N> / <Audio N> / <Video N>。禁止出现 __MINIMAX_H3_REF_N__。',
  '要求：只输出提示词正文，不要任何解释、标题或 Markdown 围栏；',
  '参考素材按给出的顺序编号，必须逐个用对应的 <Picture N> / <Audio N> / <Video N> 引用；标签必须在 subject_definitions 中先定义，再在正文引用。',
  '参考图只作角色/场景/道具的外观与空间参考，不要把它当成首帧或尾帧；参考音频只作音色参考，不要当环境音。',
  '提示词正文只写画面、动作、光线与声音本身。',
].filter(Boolean).join('\n\n');

const user = [
  '项目风格：' + (project.style || '未指定'),
  '时长：' + (shot.duration || 5) + ' 秒',
  shot.scene_name ? '场景名：' + shot.scene_name : '',
  shot.camera ? '镜头：' + shot.camera : '',
  shot.visual ? '画面：' + shot.visual : '',
  shot.dialogue ? '台词：' + shot.dialogue : '',
  shot.sub_shots ? '子镜头时间轴：' + shot.sub_shots : '',
  '参考素材（顺序固定）：\n' + refLines.join('\n'),
].filter(Boolean).join('\n');

console.log('=== sys 字符数:', sys.length, '| user 字符数:', user.length, '===');

const r = await llmChat(llmCfg, [{ role: 'system', content: sys }, { role: 'user', content: user }], {
  temperature: 0.7,
  maxTokens: Math.max(512, Number(cfg.llm?.rewriteMaxTokens) || 4000),
});

let out = String(r.content || '').trim().replace(/^```[a-z]*\n?|```$/g, '').trim();
console.log('=== 最终提交的六段式提示词（前端提交后 LLM 实际产出）===');
console.log(out);
console.log('');
console.log('=== 校验 ===');
const fields = ['subject_definitions:', 'summary:', 'retention_analysis:', 'detailed_description:', 'overall_soundscape:', 'non_diegetic_music:'];
const idx = fields.map((f) => out.indexOf(f));
console.log('六段齐全:', idx.every((i) => i >= 0));
console.log('字段顺序正确:', idx.every((v, i) => i === 0 || v > idx[i - 1]));
const want = refLines.map((l) => l.split(' =')[0]);
console.log('标签引用完整:', want.every((t) => out.includes(t)), want.join(' '));
console.log('finishReason:', r.finishReason);
