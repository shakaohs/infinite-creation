// C-07：投影模块不得调用 Shots.remove（D02-40 §4.5 / D02-46 §八 的候选保护）
//
// 这条不是"代码风格"测试：`Shots.remove` 会级联删 `shot_videos`，投影若用它清理 0 镜段，
// 就会在"整理分段"的同时把用户的生成候选删干净 —— 删空段不等于可以删候选。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'lib', 'core', 'render', 'project-units.js');

test('C07-01 project-units.js 内不出现 Shots.remove（含 import 与调用两种形态）', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const calls = src.match(/Shots\.remove\s*\(/g) || [];
  assert.equal(calls.length, 0, `投影模块出现了 ${calls.length} 次 Shots.remove`);
  // 也不许把整个 Shots 模块引进来 —— 引进来就可能哪天顺手调别的写方法
  assert.ok(!/from '\.\.\/db\.js'[\s\S]{0,200}Shots/.test(src), 'project-units.js 不应 import Shots');
});

test('C07-02 空段删除走专用裸 SQL，且带候选检查', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.ok(/DELETE FROM shots WHERE id = \?/.test(src), '必须有专用的裸 DELETE');
  assert.ok(/shot_videos/.test(src), '删除前必须查候选（不得静默丢候选）');
  assert.ok(/blocked/.test(src), '有候选时必须走"拒绝并报告"分支');
});

test('C07-03 投影模块不触碰 B/C/E 组（只写 A 组 + 建行 status/error）', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  for (const banned of ['video_prompt', 'first_frame_path', 'last_frame_path', 'reference_image_path', 'video_path', 'seed', 'resolution', 'aspect_ratio']) {
    assert.ok(!new RegExp(`\\b${banned}\\b`).test(src.split('PROJECTION_FIELDS')[0] || ''), `投影不得引用 ${banned}`);
  }
  // 建行初始化只允许 status/error 两个 C 列
  assert.ok(/status, error/.test(src), '建行只初始化 status/error');
});
