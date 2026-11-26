// 三种 hash 的统一出口（D01-06 §四）
//
// 纯函数模块：不读数据库、不写文件、不读运行时项目配置。
// 输入是"已经取好的行/对象"，输出是 'sha256:<hex>' 字符串。
// 这条约束让 hash 可以在任何环境（CI、容器、离线脚本）复算出同一个值。
export { cmpStr, sortBy } from './cmp-str.js';
export {
  canonicalStringify, canonical, canonState, canonMeta, num, numOrNull, arr, normStr, numStr,
} from './canonical-stringify.js';
export {
  sourceSpecHash, buildSourcePayload,
  bodyOf, contentHashOfBody, canonicalActions,
  stripRefTrigger, stripRefSync, posRel, posRelDetail, jsonArr, jsonObj,
} from './source-spec-hash.js';
export { adaptationHash, buildAdaptationPayload } from './adaptation-hash.js';
export { compiledHash, buildCompiledPayload, COMPILER_PARAM_FIELDS } from './compiled-hash.js';
