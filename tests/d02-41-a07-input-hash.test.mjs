// P10-A · A-07 段输入指纹骨架（`seg-2` / D-30-09 v4 / D02-40 §5.2、§5.3、§5.6）
//
// 阶段 A 只交付结构与键集。这里测三件事：
//   ① 键集冻结（白名单不是"差不多"，而是逐字相等）；
//   ② 秘密零接触（只有 apiKey 不同 → 指纹必须相同）；
//   ③ 固定向量（同一份输入在任何机器上必须得到同一个值，否则"过期判定"跨机不可判）。
// 不测：真实渲染链的接线（阶段 D）、媒体读取时点（IMP-01）。
import test from 'node:test';
import assert from 'node:assert';
import {
  SEG_INPUTHASH_ALGO, PROMPT_BUILD_VER, HASH_PROJECTION_FIELDS, HASH_PROJECTION_ENGINE_FIELDS,
  COVERED_FIELDS, MEDIA_FIELDS, OUTPUT_FIELDS,
  canonicalJson, hashProjectionOf, segmentInputHash, isSegInputHash,
} from '../lib/core/render/input-hash.js';

const SNAPSHOT = {
  exec: {
    backend: 'native', provider: 'comfyui', hardware: 'nvidia', endpoint: 'http://127.0.0.1:8188',
    apiKey: 'sk-绝不能进指纹',
    engine: null,
    specId: 'sp-1', specKind: 'video', promptFormat: 'ref2va', specSha256: 'sha256:abc',
    // 以下 11 个槽"不进但保存"，出现也不得影响指纹
    name: '本机', enabled: true, tasks: ['t2v'], authHeader: 'Authorization', authPrefix: 'Bearer',
    taskIdPath: 'data.id', pollPath: 'data.status', pollMethod: 'GET', pollBody: '{}',
    statusPath: 'data.status', doneValues: ['ok'], failValues: ['err'],
  },
  prompt: '镜头一：雨夜街头，主角回头。',
  output: { resolution: '480P', workflowResolution: '480P', aspectRatio: '16:9', width: 854, height: 480, scale: 1 },
  timing: { seconds: 3.04 },
  mode: 'ref2va',
  media: [
    { i: 1, type: 'image', role: 'char', ref: 'char:as-1', sha256: 'sha256:1111', bytes: 1024 },
    { i: 2, type: 'image', role: 'scene', ref: 'scene:as-2', sha256: 'sha256:2222', bytes: 2048 },
  ],
  covered: [
    { id: 'ss-b', globalNo: 2, duration: 1.5, dialogue: '', narration: '', visual: 'v2', camera: 'c2', subShots: '[]', blocking: 'b2', characterIds: '[]', sceneIds: '[]', propIds: '[]', costumeIds: '[]', ageIds: '[]', audioIds: '[]' },
    { id: 'ss-a', globalNo: 1, duration: 1.5, dialogue: '', narration: '', visual: 'v1', camera: 'c1', subShots: '[]', blocking: 'b1', characterIds: '[]', sceneIds: '[]', propIds: '[]', costumeIds: '[]', ageIds: '[]', audioIds: '[]' },
  ],
};

test('A07-01 算法与提示词构建器版本冻结', () => {
  assert.equal(SEG_INPUTHASH_ALGO, 'seg-2');
  assert.equal(PROMPT_BUILD_VER, 'pb-1');
});

test('A07-02 HashProjection 键集逐字等于冻结白名单（新增字段默认不进）', () => {
  const p = hashProjectionOf(SNAPSHOT.exec);
  assert.deepEqual(Object.keys(p).sort(), [...HASH_PROJECTION_FIELDS].sort());
  // 明确不进的 11 个槽与秘密，一个都不许出现
  for (const k of ['apiKey', 'name', 'enabled', 'tasks', 'authHeader', 'authPrefix', 'taskIdPath', 'pollPath', 'pollMethod', 'pollBody', 'statusPath', 'doneValues', 'failValues']) {
    assert.equal(k in p, false, `${k} 不应进投影`);
  }
  assert.equal(p.engine, null);
  // 白名单以外的字段即使传进来也不进
  const withExtra = hashProjectionOf({ ...SNAPSHOT.exec, 新字段: 'x', nested: { a: 1 } });
  assert.equal('新字段' in withExtra, false);
  assert.equal('nested' in withExtra, false);
});

test('A07-03 秘密零接触：只有 apiKey 不同 → 投影与指纹都相同', () => {
  const a = hashProjectionOf({ ...SNAPSHOT.exec, apiKey: 'AAA' });
  const b = hashProjectionOf({ ...SNAPSHOT.exec, apiKey: 'BBB' });
  assert.deepEqual(a, b);
  assert.equal(segmentInputHash({ ...SNAPSHOT, exec: { ...SNAPSHOT.exec, apiKey: 'AAA' } }),
    segmentInputHash({ ...SNAPSHOT, exec: { ...SNAPSHOT.exec, apiKey: 'BBB' } }));
  // 连"读都没读"也要能证明：把 apiKey 换成会抛错的 getter，构造过程不得触碰它
  const trap = { ...SNAPSHOT.exec };
  Object.defineProperty(trap, 'apiKey', { get() { throw new Error('不应读取 apiKey'); }, enumerable: true });
  assert.doesNotThrow(() => hashProjectionOf(trap));
});

test('A07-04 canonicalJson：键按 cmpStr 升序、数组保序、undefined 不出现、空串保留', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson({ a: undefined, b: '' }), '{"b":""}');
  assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]');
  assert.equal(canonicalJson({ z: [1, { y: 2, x: 3 }] }), '{"z":[1,{"x":3,"y":2}]}');
  // 中文原样（不做 NFC、不转 \u 转义）
  assert.equal(canonicalJson({ s: '雨夜' }), '{"s":"雨夜"}');
  assert.throws(() => canonicalJson({ n: Infinity }), (e) => e.code === 'BAD_JSON_VALUE');
});

test('A07-05 指纹形态：seg-2:<64 hex>，且同输入稳定', () => {
  const h1 = segmentInputHash(SNAPSHOT);
  const h2 = segmentInputHash(JSON.parse(JSON.stringify(SNAPSHOT)));
  assert.match(h1, /^seg-2:[0-9a-f]{64}$/);
  assert.equal(h1, h2);
  assert.equal(isSegInputHash(h1), true);
  assert.equal(isSegInputHash('seg-1:abc'), false);
});

test('A07-06 固定向量：这一串输入在任何机器上必须是同一个值', () => {
  assert.equal(segmentInputHash(SNAPSHOT), 'seg-2:a94ef245531f9d958bd51c4042c389e0447d2e1f802c00ffcb7ee190cc6ba119');
});

test('A07-07 covered / media / output 的键集冻结，缺失 sha256 落 missing 哨兵', () => {
  assert.deepEqual(COVERED_FIELDS.length, 15);
  assert.deepEqual(MEDIA_FIELDS, ['i', 'type', 'role', 'ref', 'sha256', 'bytes']);
  assert.deepEqual(OUTPUT_FIELDS, ['resolution', 'workflowResolution', 'aspectRatio', 'width', 'height', 'scale']);
  const missingMedia = segmentInputHash({ ...SNAPSHOT, media: [{ i: 1, type: 'image', role: 'char', ref: 'x', bytes: 0 }] });
  const explicitMissing = segmentInputHash({ ...SNAPSHOT, media: [{ i: 1, type: 'image', role: 'char', ref: 'x', sha256: 'missing', bytes: 0 }] });
  assert.equal(missingMedia, explicitMissing, '缺失文件必须与显式 missing 哨兵等价');
});

test('A07-08 covered 排序与内容敏感：按 global_no 升序，改任一内容列都变指纹', () => {
  const sorted = (list) => segmentInputHash({ ...SNAPSHOT, covered: list });
  assert.equal(sorted(SNAPSHOT.covered), sorted([...SNAPSHOT.covered].reverse()), 'covered 顺序不影响指纹');
  const changed = SNAPSHOT.covered.map((c) => (c.id === 'ss-a' ? { ...c, dialogue: '改一句' } : c));
  assert.notEqual(sorted(SNAPSHOT.covered), sorted(changed));
});

test('A07-09 各段独立敏感：prompt / mode / output / timing / media 任一变化都变指纹', () => {
  const base = segmentInputHash(SNAPSHOT);
  const cases = {
    prompt: { ...SNAPSHOT, prompt: SNAPSHOT.prompt + '（改）' },
    mode: { ...SNAPSHOT, mode: 't2va' },
    output: { ...SNAPSHOT, output: { ...SNAPSHOT.output, resolution: '720P' } },
    timing: { ...SNAPSHOT, timing: { seconds: 3.06 } },
    media: { ...SNAPSHOT, media: [SNAPSHOT.media[0]] },
    exec: { ...SNAPSHOT, exec: { ...SNAPSHOT.exec, specSha256: 'sha256:other' } },
  };
  for (const [k, v] of Object.entries(cases)) {
    assert.notEqual(segmentInputHash(v), base, `${k} 变化未引起指纹变化`);
  }
});

test('A07-10 排除清单生效：seed / prompt_id / status / video_path / updated_at 不进指纹', () => {
  const base = segmentInputHash(SNAPSHOT);
  const noisy = {
    ...SNAPSHOT,
    seed: 12345,
    promptId: 'pid-x',
    status: 'done',
    videoPath: 'shots/a.mp4',
    videoPromptUsed: '用过',
    updatedAt: 999,
    sceneName: '病房',
    chapter: '第1章',
    idx: 7,
    refs: ['r1'],
    filenamePrefix: 'ic_x',
  };
  assert.equal(segmentInputHash(noisy), base, '排除清单里的字段不得影响指纹');
});
