// 像素级检查：黑边 / 竖线 / 背景纯度
import sharp from 'sharp';

const f = process.argv[2];
const { data, info } = await sharp(f).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H, channels: C } = info;
const px = (x, y) => {
  const i = (y * W + x) * C;
  return [data[i], data[i + 1], data[i + 2]];
};
const isDark = ([r, g, b]) => r < 80 && g < 80 && b < 80;
const isNearWhite = ([r, g, b]) => r > 245 && g > 245 && b > 245;

function rowDark(y) {
  let n = 0;
  for (let x = 0; x < W; x++) if (isDark(px(x, y))) n++;
  return n / W;
}
function colDark(x) {
  let n = 0;
  for (let y = 0; y < H; y++) if (isDark(px(x, y))) n++;
  return n / H;
}

console.log('尺寸', W + 'x' + H, 'channels', C);

// 1) 四条边是否有连续深色线
for (const [name, vals] of [
  ['top rows 0-3', [0, 1, 2, 3].map((y) => rowDark(y).toFixed(3))],
  ['bottom rows', [H - 1, H - 2, H - 3, H - 4].map((y) => rowDark(y).toFixed(3))],
  ['left cols 0-3', [0, 1, 2, 3].map((x) => colDark(x).toFixed(3))],
  ['right cols', [W - 1, W - 2, W - 3, W - 4].map((x) => colDark(x).toFixed(3))],
]) console.log(name, vals.join(' '));

// 2) 找"整列几乎全暗"的竖线（>90% 暗像素）
const cols = [];
for (let x = 0; x < W; x++) { const d = colDark(x); if (d > 0.9) cols.push(x + '(' + d.toFixed(2) + ')'); }
console.log('近乎全暗的竖线列:', cols.length ? cols.join(', ') : '无');

// 3) 背景纯度：在画面顶部 8 行（人物头顶之上）采样
let white = 0, total = 0; let minV = 255;
for (let y = 0; y < 8; y++) for (let x = 0; x < W; x += 3) {
  const p = px(x, y); total++;
  if (isNearWhite(p)) white++;
  minV = Math.min(minV, p[0], p[1], p[2]);
}
console.log('顶部 8 行近白占比', (white / total * 100).toFixed(1) + '%', '| 最暗通道值', minV);

// 4) 格间空白处采样（人物之间，y=60 高度扫一遍，看是否有灰）
const gaps = [];
for (let x = 0; x < W; x += 40) {
  const p = px(x, 60);
  if (!isNearWhite(p)) gaps.push(x + ':' + p.join('/'));
}
console.log('y=60 行非纯白采样点:', gaps.length ? gaps.slice(0, 12).join(' ') : '无（全白）');
