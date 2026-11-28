import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { projectDir } from './config.js';
import { uploadTaskInput } from './backend.js';
import { extractFrame } from './ffmpeg.js';
import { logger } from './logger.js';
import { dialogueSpeakerNames, MAX_AUDIO_REFS, MAX_IMAGE_REFS } from './prompts.js';
import { nameMatches } from '../shared/index.js';

// 项目内相对路径 -> 绝对路径（asset.image_path / voice_ref 均相对项目目录存储）。
// 必须在这里做越界防护：rel 不全是可信的内部产物——asset.image_path / voice_ref 可由 HTTP PATCH、
// 以及 LLM 工具（update_asset.voice_ref、edit_asset_image.reference_image_path）写入，
// 而 novel 正文可经提示注入操纵这些工具参数。一旦 rel 是 '../..' 或绝对路径，
// path.resolve 会逃出项目目录，随后被 references 删除时 unlinkSync、被参考图提交时
// uploadTaskInput 上传到 ComfyUI/RunningHub、被 imageToDataUrl 读成 base64 —— 等于任意文件删/读。
// 越界一律返回 null，调用方按「文件不存在」处理（各调用点都已判 null）。
export function resolveProjectPath(projectId, rel) {
  if (!rel) return null;
  const base = projectDir(projectId);
  const abs = path.resolve(base, rel);
  const inside = path.relative(base, abs);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null;
  return abs;
}

// 懒生成章节首帧预览图（存在即复用）：从章节第一个已完成分镜的视频抽首帧存为 jpg。
// 同一章节的抽取只允许一个在跑：GET /chapters 会被前端高频轮询（WS 每条进度都刷新 + 运行期每 2.5s 一次），
// 少了这道闸门，同一张 posters/<章节id>.jpg 会被多个请求并发抽取/写入，既同时起一堆 ffmpeg，
// 又可能写出半截文件——而「存在即复用」会让这张坏图被永久缓存下来。
const posterInflight = new Set();
export async function ensureChapterPoster(projectId, chapterId, firstDoneShot) {
  const rel = 'posters/' + chapterId + '.jpg';
  const abs = resolveProjectPath(projectId, rel);
  if (!abs) return '';
  if (fs.existsSync(abs)) return rel;
  if (posterInflight.has(abs)) return '';
  posterInflight.add(abs);
  try {
    const videoAbs = resolveProjectPath(projectId, firstDoneShot.video_path);
    if (!videoAbs || !fs.existsSync(videoAbs)) return '';
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    await extractFrame(videoAbs, abs);
    return fs.existsSync(abs) ? rel : '';
  } catch { return ''; } finally { posterInflight.delete(abs); }
}

// ── P10-A · A-08 内容寻址命名（D-31-02 v3，阶段 A 只交付函数，不接线）───────────────
//
// 对象身份 = (sha256(bytes), 规范化扩展名)；名字 = `ic-<64 hex>.<ext>`，**不截断**。
// 为什么不是"名字只由字节决定"：同一份字节按 .png 与 .jpg 两条路径上传会得到两个对象。
// 代价只是重复存储，不会串台 —— 但陈述必须准确（D02-35 §4.5）。
//
// 名字里**不含** project_id / role / asset_id / 时间戳 / uid：那些全部是"谁在用"的信息，
// 放进名字就等于让同一份字节产生多个对象，同名覆盖问题照旧。
//
// 扩展名规范化三步：魔数嗅探优先 → 路径兜底 → 失败关闭（UNSUPPORTED_MEDIA_EXT）。
// 为什么不只信路径：路径来自数据库与 HTTP 参数，可被写成 a.png 而内容是 mp4；
// 为什么不只信魔数：外接引擎传 dataUrl 时上限未知，且部分合法容器没有稳定魔数。
//
// **接线是阶段 D 的事**（native 通道的上传名切换，D-31-02 与 IMP-01 同批）。
// 在此之前本函数全仓零调用方，删除它不影响任何行为（§11.4 回滚要求）。
const EXT_BY_MAGIC = [
  { ext: 'png', match: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: 'jpg', match: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', match: (b) => b.length >= 4 && b.slice(0, 4).toString('ascii') === 'GIF8' },
  { ext: 'webp', match: (b) => b.length >= 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' },
  { ext: 'wav', match: (b) => b.length >= 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WAVE' },
  { ext: 'bmp', match: (b) => b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d },
  { ext: 'flac', match: (b) => b.length >= 4 && b.slice(0, 4).toString('ascii') === 'fLaC' },
  { ext: 'ogg', match: (b) => b.length >= 4 && b.slice(0, 4).toString('ascii') === 'OggS' },
  { ext: 'mp4', match: (b) => b.length >= 12 && b.slice(4, 8).toString('ascii') === 'ftyp' },
  { ext: 'webm', match: (b) => b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  // mp3 放最后：它的帧同步 0xFF 与 jpeg 的 0xFF 前缀重叠，必须让 jpeg 先判
  { ext: 'mp3', match: (b) => b.length >= 3 && (b.slice(0, 3).toString('ascii') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) },
];

/** 允许的扩展名（路径兜底时的白名单；不在表内 = 不认识 = 失败关闭） */
const SUPPORTED_EXTS = new Set([
  'png', 'jpg', 'gif', 'webp', 'bmp',
  'wav', 'flac', 'ogg', 'mp3', 'm4a',
  'mp4', 'webm', 'mov',
]);

/** 路径兜底：取最后一段扩展名 → 小写 → .jpeg 归一成 .jpg → 白名单校验 */
export function normalizeExtFromPath(hintPath) {
  const base = path.basename(String(hintPath || ''));
  const raw = path.extname(base).replace(/^\./, '').toLowerCase();
  if (!raw) return '';
  const ext = raw === 'jpeg' ? 'jpg' : raw;
  return SUPPORTED_EXTS.has(ext) ? ext : '';
}

/** 魔数嗅探：命中返回扩展名，未命中返回空串（不猜） */
export function sniffExt(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return '';
  for (const m of EXT_BY_MAGIC) {
    try { if (m.match(buf)) return m.ext; } catch { /* 长度不足等异常按不命中处理 */ }
  }
  return '';
}

/**
 * 内容寻址对象名：`ic-<sha256 64 hex>.<ext>`
 * @param {Buffer} buf 文件的**真实字节**（不是路径、不是上传后的名字）
 * @param {string} hintPath 路径兜底用（可空；魔数命中时忽略）
 * @returns {string}
 * @throws {Error} code=UNSUPPORTED_MEDIA_EXT（魔数与路径都不认识）| code=BAD_MEDIA_INPUT（非 buffer/空）
 */
export function objectNameOf(buf, hintPath) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    throw Object.assign(new Error('objectNameOf: 需要非空的 Buffer（内容寻址的身份只能来自字节）'), { code: 'BAD_MEDIA_INPUT' });
  }
  const ext = sniffExt(buf) || normalizeExtFromPath(hintPath);
  if (!ext) {
    throw Object.assign(
      new Error(`objectNameOf: 无法确定扩展名（魔数未命中、路径兜底也失败）：${String(hintPath || '')}`),
      { code: 'UNSUPPORTED_MEDIA_EXT', hintPath: String(hintPath || '') },
    );
  }
  const hex = createHash('sha256').update(buf).digest('hex');
  return `ic-${hex}.${ext}`;
}

// 组装一个分镜的参考素材（MiniMax H3 全能参考范式：多图 + 多音视频）。
// 顺序：人物图 -> 场景图 -> 道具图 -> 人物语音。
// upload=false：只解析参考清单与标签，不向 ComfyUI 上传文件（「仅 LLM 改写提示词、不渲染」用，
// 该路径无需 ComfyUI，也就不应因 ComfyUI 未启动而失败）。
export async function assembleShotReferences({ cfg, project, shot, assets, upload = true }) {
  const pid = project.id;
  // 同一张素材在一个镜头里只出一次：character_ids / scene_ids / prop_ids 可能因历史数据或
  // 外部写入出现重复 id，重复上传不仅白占「最多 7 张参考图」的名额，还会让同一个人物在
  // 参考素材里出现两次。
  const uniqAssets = (ids) => {
    const seen = new Set();
    const out = [];
    for (const id of (ids || [])) {
      const key = String(id || '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const a = assets.find((x) => x.id === key);
      if (a) out.push(a);
    }
    return out;
  };
  const charIds = (shot.character_ids && shot.character_ids.length) ? shot.character_ids : [];
  const sceneIds = (shot.scene_ids && shot.scene_ids.length) ? shot.scene_ids : [];
  const chars = uniqAssets(charIds);
  const scenes = uniqAssets(sceneIds);
  const props = uniqAssets(shot.prop_ids);
  const costumeIds = (shot.costume_ids || []).filter(Boolean);
  // 服装替换：把 costume 资产按 parent_id 归属到角色；有服装时角色参考图改用服装图
  const costumeByChar = {};
  for (const cid of costumeIds) {
    const c = assets.find((a) => a.id === cid && a.category === 'costume');
    if (c?.parent_id) costumeByChar[c.parent_id] = c;
  }
  // 年龄变体：把 age 资产按 parent_id 归属到角色；有时间跳跃时角色参考图改用对应时期变体
  const ageIds = (shot.age_ids || []).filter(Boolean);
  const ageByChar = {};
  for (const aid of ageIds) {
    const a = assets.find((x) => x.id === aid && x.category === 'age');
    if (a?.parent_id) ageByChar[a.parent_id] = a;
  }
  // 至少需要一张参考图（人物或场景）；无图的人物会被自然跳过。
  // 报错必须带上「哪个镜、绑了谁、下一步做什么」：批量导入刚建完资产占位时必然无图，
  // 只回一句「请先生成参考图」会让用户不知道是全部资产没出、还是这一个镜少绑了人。
  const hasImage = [...chars, ...scenes, ...props].some((a) => a?.image_path);
  if (!hasImage) {
    const names = [...chars, ...scenes, ...props].filter(Boolean).map((a) => a.name + '（' + a.category + '）');
    throw new Error(
      '分镜 ' + (shot?.idx ?? '?') + ' 还没有任何参考图，无法按参考模式写提示词。'
      + (names.length
        ? '本镜已绑定 ' + names.join('、') + '，但这些资产的图片都还没生成。'
        : '本镜没有绑定任何人物/场景资产。')
      + '下一步：先在「资产」阶段跑一次出图（generate_assets_batch），或把本镜改成文字档模式（M1）再写提示词。'
    );
  }

  // 返回 { name, abs }：name 给 ComfyUI/RunningHub 的 LoadImage 用；
  // abs 给「外接线上引擎」用（engine-runner 读本地文件转 data URL，见 lib/core/engine-runner.js）。
  const uploadImageRef = async (asset, role) => {
    if (!asset?.image_path) return null;
    const abs = resolveProjectPath(pid, asset.image_path);
    if (!abs || !fs.existsSync(abs)) return null;
    const ext = path.extname(abs) || '.png';
    const name = 'ic_' + pid.slice(0, 8) + '_' + role + '_' + asset.id.slice(0, 8) + ext;
    // 走渲染后端分派层（backend.uploadTaskInput）：原生通道返回本地文件名；RunningHub 通道必须
    // 把文件传到平台并返回平台的 fileName，云端工作流里的 LoadImage 才找得到它。
    // 原先固定调 comfyui.uploadToInput（写死 127.0.0.1:8188）：RunningHub 模式下参考图传到本机，
    // 云端任务因缺输入失败、本机没开 ComfyUI 时直接 ECONNREFUSED——「参考图 → 视频」整条不可用。
    const useName = upload ? await uploadTaskInput(cfg, abs, name, 'video') : name;
    return { name: useName, abs };
  };

  const references = [];
  for (const c of chars) {
    const costume = costumeByChar[c.id];
    const age = ageByChar[c.id];
    // 优先级：服装 > 年龄变体 > 角色原图（年龄与服装为两个独立维度，不做叠加）
    const imgAsset = (costume && costume.image_path) ? costume : ((age && age.image_path) ? age : c);
    const img = await uploadImageRef(imgAsset, 'char');
    if (img) references.push({ type: 'image', filename: img.name, localPath: img.abs, label: c.name + (costume ? '（' + costume.name + '）' : (age ? '（' + age.name + '）' : '（人物形象）')) });
  }
  for (const s of scenes) {
    const img = await uploadImageRef(s, 'scene');
    if (img) references.push({ type: 'image', filename: img.name, localPath: img.abs, label: s.name + '（场景背景）' });
  }
  for (const pr of props) {
    // 参考图总量超 MAX_IMAGE_REFS 时，道具图最先被裁（人物、场景对锁定影响更大，优先级更高）
    if (references.filter((r) => r.type === 'image').length >= MAX_IMAGE_REFS) {
      logger.warn('参考图已达上限 ' + MAX_IMAGE_REFS + ' 张，道具「' + pr.name + '」的参考图被跳过（优先保留人物与场景）');
      continue;
    }
    const img = await uploadImageRef(pr, 'prop');
    if (img) references.push({ type: 'image', filename: img.name, localPath: img.abs, label: pr.name + '（道具）' });
  }
  // 音频参考统一走 MAX_AUDIO_REFS 上限（MiniMax H3 节点 maxAudioVideo 上限）。
  // 顺序：①说话角色的参考音色（多人同场仅说话角色才引用音色）→ ②分镜显式绑定的独立音频素材
  //（voice/music/sfx，含旁白音色），同样作为 H3 音色参考输入。
  const speakers = dialogueSpeakerNames(shot.dialogue);
  // 规范化后精确相等（lib/shared 的 nameMatches）：用 includes 双向包含匹配时，
  // 同场的「明」会因为对白里「小明」说话而被误判为说话人 —— 它的音色被一起提交，
  // 音色错乱，还会挤掉 MAX_AUDIO_REFS 名额把后面真正的参考音频截断。
  const speaks = (c) => speakers.some((s) => nameMatches(s, c.name));
  const speakingChars = chars.filter(speaks);
  // 可观测性：对白里的说话人没匹配到本镜任何角色时，其音色会被静默跳过（不报错，用户只看到「这一镜没有声音」）。
  // 典型来源是「李雷，韩梅梅：台词」这类一行多说话人标签——dialogueSpeakerNames 会把整串逗号名当成一个名字，
  // 而 nameMatches 是规范化后精确相等，于是两人谁都匹配不上（顺带也让「单镜 ≤2 说话人」的校验失效）。
  // 这里只提示、不改判定：拆逗号会误伤台词正文（「小明，别走」），说话人归属属于内容层问题。
  const unmatchedSpeakers = speakers.filter((s) => !chars.some((c) => nameMatches(s, c.name)));
  if (unmatchedSpeakers.length) {
    logger.warn('分镜对白里的说话人未匹配到本镜角色，其音色不会被引用：' + unmatchedSpeakers.join('、')
      + '（每行台词只写一个说话人，如「李雷：你好」；多个说话人请拆成多行/多镜）');
  }
  let audioTruncated = false;
  const pushAudio = async (rel, label, prefix) => {
    if (references.filter((r) => r.type === 'audio').length >= MAX_AUDIO_REFS) { audioTruncated = true; return; }
    if (!rel) return;
    const abs = resolveProjectPath(pid, rel);
    if (!abs || !fs.existsSync(abs)) {
      // 本地不存在该音频文件：不引用，避免 ComfyUI LoadAudio 报 Invalid audio file 而整图被拒
      logger.warn('跳过不存在的参考音频：' + rel);
      return;
    }
    const ext = path.extname(rel) || '.flac';
    const cName = 'ic_' + pid.slice(0, 8) + '_' + prefix + ext;
    // 同 uploadImageRef：音频也必须走分派层（RunningHub 下需平台 fileName）
    const useName = upload ? await uploadTaskInput(cfg, abs, cName, 'video') : cName;
    references.push({ type: 'audio', filename: useName, localPath: abs, label });
  };
  for (const c of speakingChars) {
    if (!c.voice_ref) continue;
    const voices = String(c.voice_ref).split(/[\n,;，；]+/).map((s) => s.trim()).filter(Boolean);
    for (let vi = 0; vi < voices.length; vi++) {
      await pushAudio(voices[vi], c.name + '的声音', 'voice_' + c.id.slice(0, 8) + '_' + vi);
    }
  }
  // 独立音频素材：优先 audio_path，其次 voice_ref（voice 资产两者都写、music/sfx 只有 audio_path）
  const audioLabel = { voice: '语音', music: '音乐', sfx: '音效' };
  for (const aid of (shot.audio_ids || []).filter(Boolean)) {
    const a = assets.find((x) => x.id === aid);
    if (!a) continue;
    await pushAudio(a.audio_path || a.voice_ref, a.name + '（' + (audioLabel[a.category] || '音频') + '）', 'audio_' + a.id.slice(0, 8));
  }
  if (audioTruncated) logger.warn('参考音频超过 ' + MAX_AUDIO_REFS + ' 段，已截断（仅保留前 ' + MAX_AUDIO_REFS + ' 段）');
  if (!references.length) throw new Error('没有可用的参考素材（人物图/场景图/道具图/语音）');

  const imgCount = references.filter((r) => r.type === 'image').length;
  const avCount = references.filter((r) => r.type === 'audio' || r.type === 'video').length;
  if (imgCount > MAX_IMAGE_REFS) throw new Error('参考图片过多（最多 ' + MAX_IMAGE_REFS + ' 张），当前 ' + imgCount + ' 张');
  if (avCount > MAX_AUDIO_REFS) throw new Error('参考音视频过多（最多 ' + MAX_AUDIO_REFS + ' 段），当前 ' + avCount + ' 段');

  const characterName = chars[0]?.name || '';
  const characterDesc = chars.map((c) => c.description || c.name).filter(Boolean).join('；');
  const sceneDesc = scenes.map((s) => s.description || s.name).filter(Boolean).join('；');
  return { references, chars, scenes, characterName, characterDesc, sceneDesc, unmatchedSpeakers };
}
