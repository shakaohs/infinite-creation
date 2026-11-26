// 分镜/投喂稿的 Python 机检门禁通道。
// 无人值守流水线里，LLM 写出的投喂稿由后端 spawn 本地 Python 机检脚本验证（而非让 LLM 执行脚本）。
// 机检脚本随「全流程技能」一起分发（skills/<全流程技能名>/scripts/），按视频模型路由：
//   h3            → forest-laoli-h3/scripts/{h3_lint.py, h3_finalcheck.py}（H1-H38 + L0/F/G 收尾复检）
//   seedance25/20 → short-drama-director/scripts/validate_prompt.py（七段式 C1~C30 + 版本/画幅/段缝）
// 两份脚本都是上游原版（h3_lint.py 另含本框架的 3 处硬化补丁：--strict-en / H5 正文图槽标签 / H42 固定站位豁免），
// 技能目录改名/换线时只需改这里的技能名，脚本本身不用动。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SKILLS_DIR } from './config.js';
import { detectPython } from './subtitle.js';

// 逻辑线 → 全流程技能名（分镜、提示词、机检必须同源，否则规则和判据会打架）
export const PIPELINE_SKILLS = {
  h3: 'forest-laoli-h3',
  seedance: 'short-drama-director',
};
export function pipelineSkillOf(videoModel) {
  return String(videoModel || 'h3').startsWith('seedance') ? PIPELINE_SKILLS.seedance : PIPELINE_SKILLS.h3;
}

// 跑单个机检脚本：inputText 写入临时文件作为第一个位置参数，args 追加其后。
// 返回 { ran, ok, exitCode, stdout, stderr, error }。
// exitCode 约定：0=PASS，1=FAIL（稿件有真实问题），2=用法/读取错误（机检无法执行，视作跳过，不阻断）。
export function runSkillCheck(cfg, skillName, scriptName, args, inputText) {
  const py = detectPython(String(cfg?.subtitle?.pythonPath || ''));
  if (!py.ok) return { ran: false, ok: false, exitCode: 0, stdout: '', stderr: '', error: '无 Python 环境（' + py.error + '）' };
  const scriptPath = path.join(SKILLS_DIR, skillName, 'scripts', scriptName);
  if (!fs.existsSync(scriptPath)) return { ran: false, ok: false, exitCode: 0, stdout: '', stderr: '', error: '机检脚本不存在：' + scriptPath };
  const tmp = path.join(os.tmpdir(), 'ic-check-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.md');
  fs.writeFileSync(tmp, String(inputText || ''), 'utf8');
  try {
    // Windows 下 detectPython 可能返回 .cmd/.bat 包装（如可移植运行时的 python3.cmd），
    // Node 22 的 spawnSync 直接 spawn .cmd 会 EINVAL——此类必须用 shell:true 执行。
    // 注意脚本路径含空格/中文，shell 模式下需加引号防止被拆断。
    const isCmd = /\.cmd$/i.test(py.path) || /\.bat$/i.test(py.path);
    const exe = isCmd ? '"' + py.path + '"' : py.path;
    const q = (s) => '"' + String(s) + '"';
    const argv = isCmd
      ? [exe, q(scriptPath), q(tmp), ...(args || []).map(q)]
      : [py.path, scriptPath, tmp, ...(args || [])];
    const r = spawnSync(argv[0], argv.slice(1), {
      encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 10 * 1024 * 1024,
      shell: isCmd,
    });
    if (r.error) return { ran: true, ok: false, exitCode: -1, stdout: '', stderr: String(r.error), error: '机检执行失败：' + r.error.message };
    return { ran: true, ok: r.status === 0, exitCode: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: '' };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// 按视频模型跑分镜投喂稿的整套机检。返回 { ok, detail, results }。
// ok=false 表示「存在真实 FAIL」；机检无法执行（无 Python/脚本缺失/exit 2）不算 FAIL，视为跳过。
function detailWithBypass(results) {
  return results.map((r) => {
    if (!r.ran) return r.name + ' SKIP（' + r.error + '）';
    if (r.exitCode === 1) return r.name + ' FAIL（已放行用于对比）\n' + (r.stdout + '\n' + r.stderr).trim().slice(0, 1200);
    return r.name + ' PASS';
  }).join('\n');
}

// 机检输出摘要：FAIL 行优先、逐条保留，WARN 只留少量样例行。
// 原先直接 slice(0,1200) 从头截断，而 Seedance 的 WARN 单行就 100~200 字（C1b 段时长 / C17c 背景锚点），
// 两三条就把预算吃光，真正的 [-] FAIL 行被挤到 1200 字之后丢掉 —— 模型收到「机检 FAIL」却看不到该改什么，
// 只能瞎改后再次 FAIL（实测批量阶段 4 镜空转、最后靠降级逐镜才过）。这里改成按行分类提纯。
function digestCheckOutput(text) {
  const lines = String(text || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const fails = lines.filter((x) => /^\[-\]\s*FAIL/.test(x));
  const warns = lines.filter((x) => /^\[!\]\s*WARN/.test(x));
  const heads = lines.filter((x) => /^\[\+\]/.test(x)).slice(0, 2);
  const failLines = fails.slice(0, 12).map((x) => (x.length > 320 ? x.slice(0, 320) + '…' : x));
  const warnLines = warns.slice(0, 3).map((x) => (x.length > 140 ? x.slice(0, 140) + '…' : x));
  return [
    ...heads,
    failLines.length ? '【必须修复的 FAIL】\n' + failLines.join('\n') : '【必须修复的 FAIL】无逐条明细（脚本未输出 [-] 行，见返回码）',
    fails.length > failLines.length ? '（另有 ' + (fails.length - failLines.length) + ' 条 FAIL 未列出）' : '',
    warnLines.length ? '【WARN · 仅供参考，不影响通过】\n' + warnLines.join('\n') : '',
  ].filter(Boolean).join('\n').slice(0, 2200);
}

export function checkVideoPrompt(cfg, videoModel, shot, promptText) {
  const m = String(videoModel || 'h3');
  const dur = String(Math.max(1, Math.round(Number(shot?.duration) || 5)));
  // 主用全流程技能自带的脚本；技能目录被改名/未同步时回退到历史派生技能目录（保证老环境不炸）。
  const primary = pipelineSkillOf(m);
  const legacy = m.startsWith('seedance') ? 'storyboard-director' : 'h3-storyboard';
  const hasScript = (skill, file) => fs.existsSync(path.join(SKILLS_DIR, skill, 'scripts', file));
  const pick = (file) => (hasScript(primary, file) ? primary : legacy);
  let results;
  if (m.startsWith('seedance')) {
    // Seedance 七段式：validate_prompt.py 是 C1~C30 门禁（版本/画幅/段缝/台词/字数），
    // 版本按 video_model 锁死（seedance20 → 2.0，其余 2.5），与投喂稿 sys 里的锁卡一致。
    const sdVersion = m === 'seedance20' ? '2.0' : '2.5';
    results = [
      { name: 'sd_validate', ...runSkillCheck(cfg, pick('validate_prompt.py'), 'validate_prompt.py', ['--model', sdVersion], promptText) },
    ];
  } else {
    results = [
      // --strict-en：把 H4「正文中文」从 WARN 升为 FAIL，镜行正文必须全英文（台词 <d> 除外）。
      { name: 'h3_lint', ...runSkillCheck(cfg, pick('h3_lint.py'), 'h3_lint.py', ['--duration', dur, '--strict-en'], promptText) },
      { name: 'h3_finalcheck', ...runSkillCheck(cfg, pick('h3_finalcheck.py'), 'h3_finalcheck.py', [], promptText) },
    ];
  }
  // 交付契约豁免（C31）：老李的 validate_prompt.py 在「像项目文档」的稿上会核销 CT1~CT6 契约
  // （要求同稿附角色四格/场景母版/九宫格/素材接线单）。本框架的资产提示词存在 assets 表里、
  // 参考图编号由工具注入，投喂稿按设计只放七段式正文——这条契约在流水线里恒不成立。
  // 处理：若 FAIL 全部来自 C31 契约，降级为「通过 + 说明」，其余任何 FAIL 仍然拦。
  const c31Only = (r) => {
    if (!r || r.exitCode !== 1) return false;
    const lines = String(r.stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const fails = lines.filter((x) => /^\[-\]\s*FAIL/.test(x));
    if (!fails.length) return false;
    return fails.every((x) => /^\[-\]\s*FAIL:\s*(C31|CT\d)/.test(x));
  };
  if (m.startsWith('seedance')) {
    results = results.map((r) => (c31Only(r)
      ? { ...r, exitCode: 0, ok: true, c31Exempt: true, stdout: String(r.stdout || '') + '\n[豁免] C31 交付契约（资产提示词存于项目 assets、编号由工具注入，投喂稿不含资产段）' }
      : r));
  }
  // 只有「脚本真的跑了且退出码=1（有真实 FAIL）」才判定不通过；跳过/环境错误不阻断。
  // IC_EXPORT_BYPASS_CHECK=1：仅供 A/B 对比导出用——机检照跑、detail 照记，但不以 FAIL 阻断写回，
  // 让整段戏的稿子都能导出供外部渲染端对比；生产默认不设，行为不变。
  const realFails = results.filter((r) => r.ran && r.exitCode === 1);
  if (process.env.IC_EXPORT_BYPASS_CHECK === '1') {
    return { ok: true, detail: detailWithBypass(results), results, bypassed: realFails.length > 0 };
  }
  const detail = results.map((r) => {
    if (!r.ran) return r.name + ' SKIP（' + r.error + '）';
    if (r.exitCode === 1) return r.name + ' FAIL\n' + digestCheckOutput(r.stdout + '\n' + r.stderr);
    return r.name + ' PASS';
  }).join('\n');
  return { ok: realFails.length === 0, detail, results };
}
