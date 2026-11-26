# infinite-creation 一键启动（后端 4610 + Studio 前端 4710）
# 用法：在此文件上右键「使用 PowerShell 运行」，或执行： powershell -ExecutionPolicy Bypass -File .\start-app.ps1
# 行为：已在运行则先停止再重启——同一个入口完成「启动 / 重启」。
# 注意：依赖已用 Bun 装好，请勿再运行 pnpm install（在本机易卡死）。
#
# ── 2026-11-24 修复记录（原脚本在本机会「启动即失败」或「起完就被回收」） ────────────────
# 1) Start-Process 崩溃：「已添加项。字典中的关键字:"HTTPS_PROXY"所添加的关键字:"https_proxy"」
#    宿主进程同时注入了 HTTP_PROXY/http_proxy、HTTPS_PROXY/https_proxy 两组大小写重复的代理变量
#    （Windows 环境块是字符串列表，允许同名不同大小写；PowerShell 构造环境字典时撞键）。
#    → 不再用 Start-Process，改走 cmd/wscript，绕开 PowerShell 的环境字典。
# 2) bat 里硬编码中文路径会变乱码（Agent���޴���）→ cmd 报「The system cannot find the path」
#    → bat/vbs 一律纯 ASCII，路径用 %~dp0 与 WScript.ScriptFullName 在运行时定位。
# 3) `start /b` 起的进程依附当前控制台，PowerShell 会话一结束就被回收（自检 OK、退出即死）
#    → 改用 wscript.exe 隐藏启动：0 = 隐藏窗口，False = 不等待，进程完全脱离父会话。
# ── 2026-11-25 修复记录（桌面快捷方式一直挂着一个黑窗） ─────────────────────────
# 症状：桌面「一键流启动」指向 start-app.ps1，双击 .ps1 时 Windows 必然开一个 PowerShell
#       控制台；脚本里还有 60 秒就绪自检，于是那个黑窗一直挂着不关。
# 做法：本脚本被直接打开时（没有 -Silent），立刻把启动交给同目录「启动创作台.vbs」
#       （wscript 无控制台），然后马上退出——当前窗口随之关闭，最多闪一下。
#       用 .NET 的 Process::Start 而不是 Start-Process：本机环境里有 HTTPS_PROXY/https_proxy
#       两组大小写重复的变量，Start-Process 构造环境字典时会直接崩（早已踩过）。
param([switch]$Silent)

if (-not $Silent) {
    $vbs = Join-Path $PSScriptRoot '启动创作台.vbs'
    if (Test-Path -LiteralPath $vbs) {
        try {
            [System.Diagnostics.Process]::Start('wscript.exe', '"' + $vbs + '"') | Out-Null
            exit 0
        } catch {
            # 转交失败就继续按原流程前台启动（至少能用，只是有窗口）
        }
    }
}

$root = $PSScriptRoot
if (-not $root) { $root = Split-Path -Parent $MyInvocation.MyCommand.Path }

$env:CLAUDE_CODE_GIT_BASH_PATH = "D:\豆包测试\PortableGit\bin\bash.exe"
$env:PORT = "4610"
$env:BACKEND_PORT = "4610"
$env:NEXT_DIST_DIR = ".next-studio-dev"
$env:HOST = "0.0.0.0"
$env:NODE_OPTIONS = "--max-old-space-size=8192"
$env:STUDIO_PORT = "4710"
$env:STUDIO_BACKEND = "http://127.0.0.1:4610"

New-Item -ItemType Directory -Path "$root\logs", "$root\studio\logs" -Force | Out-Null

# 1) 已有服务在跑 -> 先结束进程，再重新拉起
foreach ($port in 4610, 4710) {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($conns) {
        foreach ($c in $conns) {
            Write-Output "停止端口 $port 上的进程 (PID $($c.OwningProcess))"
            Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
        }
    }
}
Start-Sleep -Seconds 2


# 2) 生成 node 版「守护启动器」——用 spawn({detached:true}) + unref() 让服务脱离父进程。
#    为什么不用其它方式（都在本机踩过坑）：
#      · Start-Process  → 环境里有大小写重复的代理变量，构造环境字典时崩溃
#      · start /b       → 进程依附当前控制台，PowerShell 会话一关就被回收
#      · wscript / vbs  → 被安全策略判为 LOLBin，且有弹框风险
#    node 的 detached spawn 是标准做法：父进程 node 立即退出，子进程独立存活、无窗口。
$launchScript = Join-Path $root "logs\_launch.mjs"
$launchLines = @(
    "import { spawn } from 'node:child_process';",
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    "",
    "const here = path.dirname(fileURLToPath(import.meta.url));",
    "const root = path.resolve(here, '..');",
    "const which = process.argv[2] || 'backend';",
    "const isBackend = which === 'backend';",
    "const cwd = isBackend ? root : path.join(root, 'studio');",
    "const logFile = isBackend ? path.join(root, 'logs', 'backend.log') : path.join(root, 'studio', 'logs', 'studio.log');",
    "const errFile = isBackend ? path.join(root, 'logs', 'backend.err.log') : path.join(root, 'studio', 'logs', 'studio.err.log');",
    "const out = fs.openSync(logFile, 'a');",
    "const err = fs.openSync(errFile, 'a');",
    "const args = isBackend ? ['server.js'] : [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')];",
    "const env = Object.assign({}, process.env, isBackend",
    "  ? { PORT: '4610', BACKEND_PORT: '4610', NEXT_DIST_DIR: '.next-studio-dev', HOST: '0.0.0.0', NODE_OPTIONS: '--max-old-space-size=8192' }",
    "  : { STUDIO_PORT: '4710', STUDIO_BACKEND: 'http://127.0.0.1:4610' });",
    "const child = spawn(process.execPath, args, { cwd, detached: true, stdio: ['ignore', out, err], env, windowsHide: true });",
    "child.unref();",
    "console.log(which + ' started, pid=' + child.pid);",
    "process.exit(0);"
)
Set-Content -Path $launchScript -Value $launchLines -Encoding UTF8

# 3) 启动（node 启动器秒退，服务在脱离父进程的独立进程里运行）
& node "$launchScript" backend
Write-Output "后端启动中 -> http://127.0.0.1:4610"
& node "$launchScript" frontend
Write-Output "前端启动中 -> http://127.0.0.1:4710"

# 4) 就绪自检（最多等 60 秒，直接给结果）
$okB = $false; $okF = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    if (-not $okB) { try { $okB = (Invoke-WebRequest -Uri "http://127.0.0.1:4610/api/health" -TimeoutSec 3 -UseBasicParsing).StatusCode -eq 200 } catch {} }
    if (-not $okF) { try { $okF = (Invoke-WebRequest -Uri "http://127.0.0.1:4710/" -TimeoutSec 3 -UseBasicParsing).StatusCode -eq 200 } catch {} }
    if ($okB -and $okF) { break }
}
Write-Output ""
Write-Output ("后端 4610 : " + $(if ($okB) { "OK" } else { "未就绪（看 logs\backend.err.log）" }))
Write-Output ("前端 4710 : " + $(if ($okF) { "OK" } else { "未就绪（看 studio\logs\studio.err.log）" }))
if ($okB -and $okF) { Write-Output "打开浏览器访问: http://127.0.0.1:4710" }
