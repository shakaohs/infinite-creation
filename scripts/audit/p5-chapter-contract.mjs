// P5 独立复审 · 证据脚本（只读）
//
// 用途：验证 U-P5-2 —— 章级规则（V-06 / V-07 / V-08）在 `chapterShots` 各种
// "传得不完整/传错"的情况下，是**静默不适用**、**静默算错**，还是**报错**。
//
// 运行：node scripts/audit/p5-chapter-contract.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-p5-chapter-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;
delete process.env.IC_DB;
delete process.env.DATABASE_URL;

const V = await import('../../lib/core/validate/index.js');
const F = await import('../../tests/helpers/qc-fixture.mjs');

const CHAPTER = F.chapter(6); // sh_02 .. sh_07
const CUR = 'sh_03';

function ctxOf(chapterShots) {
  const c = F.ctx({ blockings: [F.b()], shot: { id: CUR }, sceneState: F.scene() });
  if (chapterShots !== undefined) c.chapterShots = chapterShots;
  return c;
}

const CASES = [
  ['基线：完整 6 镜（含本镜）', () => CHAPTER],
  ['① chapterShots 缺失（undefined）', () => undefined],
  ['② chapterShots = []', () => []],
  ['③ 只有 1 镜且不是本镜', () => [CHAPTER.find((s) => s.id === 'sh_05')]],
  ['④ 只含部分章节（3 镜，本镜不在其中）', () => CHAPTER.filter((s) => ['sh_02', 'sh_04', 'sh_05'].includes(s.id))],
  ['⑤ 含重复镜（本镜出现 2 次）', () => [...CHAPTER, CHAPTER.find((s) => s.id === CUR)]],
  ['⑥ 排序错误（shot_no 倒序）', () => CHAPTER.slice().reverse()],
  ['⑦ 与当前镜数据不一致（同 id 但 shot_size 不同）', () => CHAPTER.map((s) => (s.id === CUR ? { ...s, shot_size: 'extreme_wide' } : s))],
  ['⑧ 混入别的章（id 前缀不同、shot_no 从 1 重来）', () => [...CHAPTER, ...F.chapter(6).map((s) => ({ ...s, id: `z_${s.id}` }))]],
  ['⑨ 全章 shot_size 相同（应命中 V-07 三连窗）', () => CHAPTER.map((s) => ({ ...s, shot_size: 'medium' }))],
];

const IDS = ['V-06', 'V-07', 'V-08'];

console.log('| 情形 | V-06 | V-07 | V-08 | 是否报错 |');
console.log('|---|---|---|---|---|');
for (const [label, make] of CASES) {
  const ctx = ctxOf(make());
  const cells = [];
  let threw = '';
  for (const id of IDS) {
    try {
      const e = V.validateRule(id, ctx);
      cells.push(e.applicable === false ? `N/A（${e.detail.reason}）` : `${e.level}/${e.code}`);
    } catch (err) {
      cells.push('THROW');
      threw = String(err && err.message).slice(0, 40);
    }
  }
  console.log(`| ${label} | ${cells.join(' | ')} | ${threw || '否'} |`);
}

// 证据 2：V-06 的"章内不足 3 镜"门槛在跨章混入时会不会被绕过
const mixed = [...CHAPTER.slice(0, 2), ...F.chapter(6).map((s) => ({ ...s, id: `z_${s.id}`, cam_roll_deg: 5 }))];
const e = V.validateRule('V-06', ctxOf(mixed));
console.log('');
console.log(`跨章混入 + 2 镜本章：V-06 → ${e.applicable === false ? 'N/A' : `${e.level}/${e.code}`}（本镜实际所在章只有 2 镜，正确结果应是"配额无统计意义"）`);
