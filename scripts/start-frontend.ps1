<#
.SYNOPSIS
在当前终端启动 Vue 前端；仅在 node_modules 不存在时安装依赖。
.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-frontend.ps1
.EXAMPLE
.\scripts\start-frontend.ps1 -Port 5174 -ProxyTarget http://localhost:8081
#>
[CmdletBinding()]
param(
    [ValidateRange(1, 65535)][int]$Port = 5173,
    [string]$ProxyTarget = '',
    [string]$NodeHome = '',
    [string]$HostName = 'localhost',
    [switch]$CheckOnly,
    [Alias('h')][switch]$Help
)

if ($Help) {
    Write-Output @'
启动前端：powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-frontend.ps1

参数：
  -Port 5173          前端端口；占用时明确报错，不自动换端口
  -ProxyTarget <地址> 后端地址；默认 VITE_PROXY_TARGET 或 http://localhost:8080
  -NodeHome <目录>    Node.js 安装目录；默认从 PATH 查找
  -HostName localhost 监听地址，默认仅本机访问
  -CheckOnly         只检查环境与端口；不安装依赖、不启动服务
  -Help              显示本帮助

首次启动缺少 frontend/node_modules 时会执行 npm ci。Ctrl+C 停止本次前端。
MySQL 和后端需要同时保持运行。后端端口改变时同步设置 -ProxyTarget。
'@
    return
}

. (Join-Path $PSScriptRoot 'start-common.ps1')
$projectRoot = Get-CollabProjectRoot
$frontendRoot = Join-Path $projectRoot 'frontend'
$previousProxy = $env:VITE_PROXY_TARGET
$previousPath = $env:PATH
$locationPushed = $false
try {
    Assert-LaunchPortAvailable -Port $Port -Name '前端'
    if (-not $HostName -or $HostName -match '\s|[/?#]') { throw '-HostName 必须是主机名或 IP 地址。' }
    if (-not $ProxyTarget) { $ProxyTarget = $env:VITE_PROXY_TARGET }
    if (-not $ProxyTarget) { $ProxyTarget = 'http://localhost:8080' }
    $proxyUri = $null
    if (-not [System.Uri]::TryCreate($ProxyTarget, [System.UriKind]::Absolute, [ref]$proxyUri) -or
        $proxyUri.Scheme -notin @('http', 'https') -or $proxyUri.UserInfo -or $proxyUri.Query -or
        $proxyUri.Fragment -or $proxyUri.AbsolutePath -ne '/') {
        throw '-ProxyTarget 应为后端根地址，例如 http://localhost:8080，不能包含账号、路径或查询参数。'
    }
    $ProxyTarget = $proxyUri.GetLeftPart([System.UriPartial]::Authority)
    $node = Resolve-LaunchExecutable -Names @('node.exe', 'node') -Directory $NodeHome -Description 'Node.js 18+（建议 22 LTS）'
    $nodeVersion = (Invoke-LaunchProbe -Executable $node -Arguments '--version').Trim()
    $majorMatch = [regex]::Match($nodeVersion, '^v(\d+)')
    if (-not $majorMatch.Success -or [int]$majorMatch.Groups[1].Value -lt 18) {
        throw "检测到 Node.js $nodeVersion。前端需要 18 或更高版本，建议安装 22 LTS。"
    }
    $nodeDirectory = Split-Path -Parent $node
    $npm = Resolve-LaunchExecutable -Names @('npm.cmd') -Directory $nodeDirectory -Description '与 Node.js 配套的 npm'
    $env:PATH = $nodeDirectory + [System.IO.Path]::PathSeparator + $previousPath
    $env:VITE_PROXY_TARGET = $ProxyTarget
    $modules = Join-Path $frontendRoot 'node_modules'
    $modulesExist = Test-Path -LiteralPath $modules -PathType Container
    if (-not (Test-Path -LiteralPath (Join-Path $frontendRoot 'package-lock.json') -PathType Leaf)) {
        throw '缺少 frontend/package-lock.json，请确认打开的是完整项目。'
    }
    if ($modulesExist -and -not (Test-Path -LiteralPath (Join-Path $modules '.bin/vite.cmd') -PathType Leaf)) {
        throw 'frontend/node_modules 不完整。请在 frontend 目录手动执行 npm.cmd ci，然后重新启动。'
    }
    Write-Host "[前端] Node.js $nodeVersion；项目：$frontendRoot"
    Write-Host "[前端] 页面：http://${HostName}:$Port；后端代理：$ProxyTarget"
    if (-not $modulesExist) { Write-Host '[前端] 尚未安装依赖；正式启动时将根据锁文件执行 npm ci。' }
    if ($CheckOnly) {
        Write-Host '[前端] 预检查通过，未安装依赖、未启动服务。'
        return
    }

    Push-Location -LiteralPath $frontendRoot
    $locationPushed = $true
    if (-not $modulesExist) {
        Invoke-LaunchCommand -Executable $npm -Arguments @('ci') -Description '前端依赖安装'
    }
    Assert-LaunchPortAvailable -Port $Port -Name '前端'
    Write-Host '[前端] 正在启动开发服务器，Ctrl+C 停止。请保持后端与 MySQL 运行。'
    Invoke-LaunchCommand -Executable $npm -Arguments @('run', 'dev', '--', '--host', $HostName, '--port', [string]$Port, '--strictPort') -Description '前端进程'
}
catch {
    Write-Error -Message $_.Exception.Message -ErrorAction Continue
    exit 1
}
finally {
    if ($locationPushed) { Pop-Location }
    $env:VITE_PROXY_TARGET = $previousProxy
    $env:PATH = $previousPath
}
