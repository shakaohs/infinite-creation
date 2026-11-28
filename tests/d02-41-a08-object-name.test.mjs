// P10-A · A-08 对象身份 = (摘要, 规范化扩展名)（D-31-02 v3 / D02-35 §4.5）
//
// 断言三件事：名字只由字节与扩展名决定；扩展名走"嗅探→路径→失败关闭"；名字里不含
// project_id / role / asset_id / 时间戳 / uid（否则同一份字节会被存成多个对象）。
import test from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { objectNameOf, sniffExt, normalizeExtFromPath } from '../lib/core/refs.js';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(12, 1)]);
const gif = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(8, 2)]);
const webp = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ', 'ascii')]);
const wav = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVEfmt ', 'ascii')]);
const flac = Buffer.concat([Buffer.from('fLaC', 'ascii'), Buffer.alloc(8, 3)]);
const ogg = Buffer.concat([Buffer.from('OggS', 'ascii'), Buffer.alloc(8, 4)]);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'ascii'), Buffer.alloc(8, 5)]);
const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(8, 6)]);
const mp3 = Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.alloc(8, 7)]);
const unknown = Buffer.from('这不是任何已知媒体格式的字节', 'utf8');

const sha = (b) => createHash('sha256').update(b).digest('hex');

test('A08-01 魔数嗅探覆盖图片/音频/视频，且优先级不被路径干扰', () => {
  for (const [buf, ext] of [[png, 'png'], [jpg, 'jpg'], [gif, 'gif'], [webp, 'webp'], [wav, 'wav'], [flac, 'flac'], [ogg, 'ogg'], [mp4, 'mp4'], [webm, 'webm'], [mp3, 'mp3']]) {
    assert.equal(sniffExt(buf), ext, `嗅探 ${ext} 失败`);
    // 路径写的是别的扩展名，也必须以魔数为准（防"内容是 mp4、名字叫 .png"）
    assert.equal(objectNameOf(buf, 'whatever.png'), `ic-${sha(buf)}.${ext}`);
  }
});

test('A08-02 名字形态：ic-<64 hex>.<ext>，不截断、不含业务标识', () => {
  const name = objectNameOf(png, 'refs/角色图.png');
  assert.match(name, /^ic-[0-9a-f]{64}\.png$/);
  assert.equal(name.length, 3 + 64 + 1 + 3);
  for (const bad of ['p-a06', 'char', 'as-1', '1700000000000', 'uid']) {
    assert.equal(name.includes(bad), false, `名字不应包含 ${bad}`);
  }
});

test('A08-03 同字节同名（幂等）；不同字节不同名', () => {
  assert.equal(objectNameOf(png, 'a.png'), objectNameOf(Buffer.from(png), 'b/c.png'));
  const png2 = Buffer.from(png); png2[11] = 9;
  assert.notEqual(objectNameOf(png, 'a.png'), objectNameOf(png2, 'a.png'));
  // 魔数命中时路径不参与 ⇒ 同一份字节即使从 .png 与 .jpg 两条路径来，也只产生一个对象
  assert.equal(objectNameOf(png, 'a.png'), objectNameOf(png, 'a.jpg'));
});

test('A08-04 路径兜底：魔数不认识时用路径扩展名（小写、.jpeg 归一成 .jpg、多重扩展名取最后一段）', () => {
  assert.equal(normalizeExtFromPath('a/b/c.PNG'), 'png');
  assert.equal(normalizeExtFromPath('photo.JPEG'), 'jpg');
  assert.equal(normalizeExtFromPath('x.tar.png'), 'png');
  assert.equal(normalizeExtFromPath('noext'), '');
  assert.equal(objectNameOf(unknown, 'records/clip.webp'), `ic-${sha(unknown)}.webp`);
});

test('A08-05 失败关闭：魔数与路径都不认识 → UNSUPPORTED_MEDIA_EXT（不猜、不回退成 .bin）', () => {
  assert.throws(() => objectNameOf(unknown, 'a.xyz'), (e) => e.code === 'UNSUPPORTED_MEDIA_EXT');
  assert.throws(() => objectNameOf(unknown, ''), (e) => e.code === 'UNSUPPORTED_MEDIA_EXT');
});

test('A08-06 非字节输入直接拒绝：身份只能来自内容', () => {
  assert.throws(() => objectNameOf('not a buffer', 'a.png'), (e) => e.code === 'BAD_MEDIA_INPUT');
  assert.throws(() => objectNameOf(Buffer.alloc(0), 'a.png'), (e) => e.code === 'BAD_MEDIA_INPUT');
  assert.throws(() => objectNameOf(null, 'a.png'), (e) => e.code === 'BAD_MEDIA_INPUT');
});

test('A08-07 跨"渲染任务"稳定：同一文件重复取名不产生第二个对象名', () => {
  const names = new Set();
  for (let i = 0; i < 5; i++) names.add(objectNameOf(Buffer.from(png), `task${i}/x.png`));
  assert.equal(names.size, 1);
});
