// compiledHash（D01-06 §4.4）：组合"源 + 适配 + 编译器"
//
// 三者用途不许混：
//   sourceSpecHash  —— 分镜内容变没变（跨轨道可比，同源证明）
//   adaptationHash  —— 切分方案变没变（含 profile / seam；不含 G0 锁）
//   compiledHash    —— 这一份产物是哪三者组合出来的（用于产物幂等与溯源）
import { createHash } from 'node:crypto';
import { canonicalStringify, canonical } from './canonical-stringify.js';

function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export const COMPILER_PARAM_FIELDS = [
  'format',          // 'ref2va' | 't2va'
  'language',        // 'en' | 'zh'
  'aspectRatio',
  'fps',
  'refPackPolicy',   // 'ordered' | 'by-role'
  'seamInjection',   // true | false
];

export function buildCompiledPayload({ sourceHash, adaptationHash, compilerVer, compilerParams } = {}) {
  return {
    hashKind: 'd01.compiled',
    sourceSpecHash: sourceHash,
    adaptationHash,
    compilerVer,
    compilerParams: canonical(compilerParams || {}, COMPILER_PARAM_FIELDS),
  };
}

export function compiledHash(args) {
  return 'sha256:' + sha256(canonicalStringify(buildCompiledPayload(args)));
}
