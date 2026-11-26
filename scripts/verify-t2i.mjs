// 临时验证脚本：用真实提示词拼接 + 真实 Z-Image 工作流跑一张人物设定板
import fs from 'node:fs';
import path from 'node:path';
import { composeCharacterT2IPrompt } from '../lib/core/prompts.js';

const COMFY = 'http://127.0.0.1:8188';
const WF = path.resolve('workflows/custom_z_image_turbo_文生图.json');

const appearance = process.argv[2] || '38岁中国女性，鹅蛋脸偏长，杏眼内双，眼下有淡青灰与细纹，自然平眉，唇薄色淡，及肩黑发发尾略毛躁，别一枚黑色一字夹，米灰色细针织衫袖口起毛球，深灰直筒长裤，磨旧白色平底鞋，无首饰，偏瘦，手背青筋明显，指甲短平';
const styleArg = process.argv[3] || '90 年代港产文艺片：低饱和青绿调、16mm 胶片颗粒、窗外霓虹溢色、硬侧光、浅景深';

const raw = process.argv[4] === 'raw';
const prompt = raw ? appearance : composeCharacterT2IPrompt(appearance, styleArg);
console.log('=== 最终正向（%d 字）===', prompt.length);
console.log(prompt);
console.log('=== 结尾 ===');

const wf = JSON.parse(fs.readFileSync(WF, 'utf8'));
wf['57:27'].inputs.text = prompt;
wf['57:13'].inputs.width = 1344;
wf['57:13'].inputs.height = 768;
wf['57:3'].inputs.seed = Math.floor(Math.random() * 1e15);
wf['9'].inputs.filename_prefix = 'ic_test/' + (raw ? 'scene_style' : 'character_white');
console.log('steps =', wf['57:3'].inputs.steps, '| cfg =', wf['57:3'].inputs.cfg, '| size =', wf['57:13'].inputs.width + 'x' + wf['57:13'].inputs.height);

const t0 = Date.now();
const r = await fetch(COMFY + '/prompt', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: wf, client_id: 'ic-verify' }),
});
const queued = await r.json();
if (!r.ok) { console.error('提交失败', JSON.stringify(queued).slice(0, 500)); process.exit(1); }
const id = queued.prompt_id;
console.log('已入队', id);

let out = null;
for (let i = 0; i < 180; i++) {
  await new Promise((res) => setTimeout(res, 1500));
  const h = await (await fetch(COMFY + '/history/' + id)).json();
  const rec = h[id];
  if (!rec) continue;
  if (rec.status && rec.status.status_str === 'error') { console.error('执行出错', JSON.stringify(rec.status).slice(0, 800)); process.exit(2); }
  const imgs = rec.outputs && rec.outputs['9'] && rec.outputs['9'].images;
  if (imgs && imgs.length) { out = imgs[0]; break; }
}
if (!out) { console.error('超时未出图'); process.exit(3); }
console.log('出图', JSON.stringify(out), '| 耗时', ((Date.now() - t0) / 1000).toFixed(1) + 's');

const url = COMFY + '/view?filename=' + encodeURIComponent(out.filename) + '&subfolder=' + encodeURIComponent(out.subfolder || '') + '&type=' + (out.type || 'output');
const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
const dest = path.resolve('data/_verify', 'char_white_' + Date.now() + '.png');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, buf);
console.log('已保存', dest, buf.length + ' bytes');
