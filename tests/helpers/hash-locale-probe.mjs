// 跨 locale 探针：在指定 LANG/LC_ALL 下算一次 sourceSpecHash 并打印
// 由 tests/stage1-hash.test.mjs 的 R-42 用 spawnSync 拉起（同进程改 LANG 无效，ICU 已初始化）
import { sourceSpecHash } from '../../lib/core/hash/index.js';
import { fx } from './hash-fixture.mjs';

process.stdout.write(sourceSpecHash(fx()));
