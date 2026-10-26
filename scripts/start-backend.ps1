<#
.SYNOPSIS
在当前终端构建并启动 Spring Boot 后端，使用外部 local 配置。
.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-backend.ps1
.EXAMPLE
.\scripts\start-backend.ps1 -Port 8081 -JavaHome 'C:\Tools\jdk-21' -MavenHome 'C:\Tools\apache-maven'
.EXAMPLE
.\scripts\start-backend.ps1 -CheckOnly -Port 8081
#>
[CmdletBinding()]
param(
    [ValidateRange(1, 65535)][int]$Port = 8080,
    [string]$JavaHome = '',
    [string]$MavenHome = '',
    [string]$LocalConfig = '',
    [switch]$SkipBuild,
    [switch]$CheckOnly,
    [Alias('h')][switch]$Help
)

if ($Help) {
    Write-Output @'
启动后端：powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-backend.ps1

参数：
  -Port 8080          后端端口；占用时明确报错，不自动换端口
  -JavaHome <目录>    JDK 安装目录；默认使用 JAVA_HOME 或 PATH
  -MavenHome <目录>   Maven 安装目录；默认使用 MAVEN_HOME / M2_HOME 或 PATH
  -LocalConfig <文件> 外部 application-local.yml；默认读取 server/src/main/resources 下的本地文件
  -SkipBuild         使用已有 JAR，仅用于代码未修改时
  -CheckOnly         只检查环境、端口、配置路径；不构建、不启动、不访问数据库
  -Help              显示本帮助

先启动 MySQL。脚本在当前终端运行，Ctrl+C 停止本次服务。前端需要另开一个终端。
'@
    return
}

. (Join-Path $PSScriptRoot 'start-common.ps1')
$projectRoot = Get-CollabProjectRoot
$previousJavaHome = $env:JAVA_HOME
$previousPath = $env:PATH
$locationPushed = $false
try {
    Assert-LaunchPortAvailable -Port $Port -Name '后端'
    $java = Resolve-LaunchJava -JavaHome $JavaHome
    $env:JAVA_HOME = $java.Home
    $env:PATH = (Join-Path $java.Home 'bin') + [System.IO.Path]::PathSeparator + $previousPath

    $maven = $null
    if (-not $SkipBuild) {
        $candidateMavenHome = $MavenHome
        if (-not $candidateMavenHome) { $candidateMavenHome = $env:MAVEN_HOME }
        if (-not $candidateMavenHome) { $candidateMavenHome = $env:M2_HOME }
        $mavenDirectory = if ($candidateMavenHome) { Join-Path $candidateMavenHome 'bin' } else { '' }
        $maven = Resolve-LaunchExecutable -Names @('mvn.cmd') -Directory $mavenDirectory -Description 'Maven 3.9'
    }

    $configPath = if ($LocalConfig) {
        [System.IO.Path]::GetFullPath($LocalConfig)
    } else {
        Join-Path $projectRoot 'server/src/main/resources/application-local.yml'
    }
    $configExists = Test-Path -LiteralPath $configPath -PathType Leaf
    if ($LocalConfig -and -not $configExists) { throw "指定的本地配置文件不存在：$configPath" }
    if (-not $configExists -and [System.Text.Encoding]::UTF8.GetByteCount([string]$env:JWT_SECRET) -lt 32) {
        throw '缺少本地配置。请按 docs/local-development.md 设置 application-local.yml，或提供 DB_* 与至少 32 字节的 JWT_SECRET 环境变量。'
    }
    $jarPath = Get-LaunchServerJar -ProjectRoot $projectRoot
    if ($SkipBuild) { Assert-LaunchJarHasNoLocalConfig -JarPath $jarPath }
    if ($configExists) { $configUri = (New-Object System.Uri($configPath)).AbsoluteUri }

    Write-Host "[后端] JDK $($java.Version)；项目：$projectRoot"
    if ($configExists) { Write-Host "[后端] 外部配置：$configPath（不输出配置内容）" }
    else { Write-Host '[后端] 使用当前终端的 DB_* / JWT_SECRET 环境变量。' }
    Write-Host "[后端] 目标端口：$Port；请先确认 MySQL 服务已经运行。"
    if ($CheckOnly) {
        Write-Host '[后端] 预检查通过，未构建、未启动服务、未连接数据库。'
        return
    }

    Push-Location -LiteralPath $projectRoot
    $locationPushed = $true
    if (-not $SkipBuild) {
        Write-Host '[后端] 构建 engine 与 server；首次构建可能需要下载 Maven 依赖。'
        Invoke-LaunchCommand -Executable $maven -Arguments @('clean', 'package', '-pl', 'server', '-am', '-DskipTests') -Description '后端构建'
    }
    Assert-LaunchJarHasNoLocalConfig -JarPath $jarPath
    # Recheck after the build: another process may have claimed the port meanwhile.
    Assert-LaunchPortAvailable -Port $Port -Name '后端'
    $javaArguments = @('-jar', $jarPath, '--spring.profiles.active=local', "--server.port=$Port")
    if ($configExists) {
        $javaArguments += "--spring.config.additional-location=$configUri"
    }
    Write-Host "[后端] 正在启动 http://localhost:$Port；看到 Started CollabServerApplication 后可启动前端。Ctrl+C 停止。"
    Invoke-LaunchCommand -Executable $java.Executable -Arguments $javaArguments -Description '后端进程'
}
catch {
    Write-Error -Message $_.Exception.Message -ErrorAction Continue
    exit 1
}
finally {
    if ($locationPushed) { Pop-Location }
    $env:JAVA_HOME = $previousJavaHome
    $env:PATH = $previousPath
}
