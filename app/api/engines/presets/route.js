// 主流线上生成平台的接入预设。
// GET /api/engines/presets            → 精简列表（名称/厂商/类型/是否可直接用/文档/鉴权说明）
// GET /api/engines/presets?key=xxx    → 该平台的完整配置模板（用于「一键填入」表单）
//
// 模板里不含任何密钥：apiKey 一律留空，由用户在设置页填。
import { NextResponse } from 'next/server';
import { listEnginePresets, getEnginePreset, presetToEngine } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  const key = new URL(req.url).searchParams.get('key');
  if (key) {
    const preset = getEnginePreset(key);
    if (!preset) return NextResponse.json({ error: '没有这个平台模板：' + key }, { status: 404 });
    // 展开成一条可直接入库的引擎配置（apiKey 为空、enabled=false）
    return NextResponse.json({ preset, engine: presetToEngine(preset) });
  }
  return NextResponse.json({ items: listEnginePresets() });
}
