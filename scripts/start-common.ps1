# Shared helpers for the foreground local-development launchers.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-CollabProjectRoot {
    return [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
}

function Resolve-LaunchExecutable {
    param(
        [Parameter(Mandatory = $true)][string[]]$Names,
        [string]$Directory = '',
        [Parameter(Mandatory = $true)][string]$Description
    )
    if ($Directory) {
        foreach ($name in $Names) {
            $candidate = Join-Path $Directory $name
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                return (Resolve-Path -LiteralPath $candidate).Path
            }
        }
        throw "找不到 $Description。请检查指定目录：$Directory"
    }
    foreach ($name in $Names) {
        $command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $command) { return $command.Source }
    }
    throw "找不到 $Description。请安装后加入 PATH，或使用脚本的路径参数。"
}

function Assert-LaunchPortAvailable {
    param([Parameter(Mandatory = $true)][int]$Port, [Parameter(Mandatory = $true)][string]$Name)
    $listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    if (@($listeners | Where-Object { $_.Port -eq $Port }).Count -gt 0) {
        throw "$Name 端口 $Port 已被占用。如果已经启动，请直接使用原服务；需要另开时显式指定 -Port。脚本不会结束已有进程或自动换端口。"
    }
}

function Invoke-LaunchProbe {
    param([Parameter(Mandatory = $true)][string]$Executable, [Parameter(Mandatory = $true)][string]$Arguments)
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $Executable
    # Callers pass fixed version-inspection flags only, never user input here.
    $startInfo.Arguments = $Arguments
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { throw '无法运行环境版本检查。' }
        $outputTask = $process.StandardOutput.ReadToEndAsync()
        $errorTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(15000)) {
            # This is our own short-lived version probe, never a user service.
            $process.Kill()
            throw '环境版本检查超过 15 秒，请检查 JDK / Node.js 安装。'
        }
        $output = $outputTask.GetAwaiter().GetResult() + $errorTask.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw '环境版本检查失败，请确认可执行文件有效。' }
        return $output
    }
    finally { $process.Dispose() }
}

function Invoke-LaunchCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$Description
    )
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Description 失败（退出码 $LASTEXITCODE），请查看上方输出。" }
}

function Resolve-LaunchJava {
    param([string]$JavaHome = '')
    $candidateHome = $JavaHome
    if (-not $candidateHome) { $candidateHome = $env:JAVA_HOME }
    $javaDirectory = if ($candidateHome) { Join-Path $candidateHome 'bin' } else { '' }
    $java = Resolve-LaunchExecutable -Names @('java.exe', 'java') -Directory $javaDirectory -Description 'JDK 17 或更高版本'
    $properties = Invoke-LaunchProbe -Executable $java -Arguments '-XshowSettings:properties -version'
    $versionMatch = [regex]::Match($properties, '(?m)^\s*java\.version\s*=\s*(\S+)')
    $homeMatch = [regex]::Match($properties, '(?m)^\s*java\.home\s*=\s*(.+)$')
    if (-not $versionMatch.Success -or -not $homeMatch.Success) { throw '无法识别 Java 版本和安装路径。' }
    $version = $versionMatch.Groups[1].Value
    $major = if ($version.StartsWith('1.')) { [int]$version.Split('.')[1] } else { [int]([regex]::Match($version, '^\d+').Value) }
    if ($major -lt 17) { throw "检测到 Java $version，项目需要 JDK 17 或更高版本。可通过 -JavaHome 指定 JDK。" }
    $resolvedHome = $homeMatch.Groups[1].Value.Trim()
    if (-not (Test-Path -LiteralPath (Join-Path $resolvedHome 'bin/javac.exe') -PathType Leaf)) {
        throw "当前 Java 不是完整 JDK，缺少 javac。请通过 -JavaHome 指向 JDK 17 或更高版本。"
    }
    return @{ Executable = $java; Home = $resolvedHome; Version = $version }
}

function Get-LaunchServerJar {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)
    [xml]$pom = Get-Content -LiteralPath (Join-Path $ProjectRoot 'server/pom.xml') -Raw
    $artifact = $pom.SelectSingleNode("/*[local-name()='project']/*[local-name()='artifactId']").InnerText
    $versionNode = $pom.SelectSingleNode("/*[local-name()='project']/*[local-name()='version']")
    if ($null -eq $versionNode) {
        $versionNode = $pom.SelectSingleNode("/*[local-name()='project']/*[local-name()='parent']/*[local-name()='version']")
    }
    if ($null -eq $versionNode) { throw '无法从 server/pom.xml 读取构建版本。' }
    return Join-Path $ProjectRoot "server/target/$artifact-$($versionNode.InnerText).jar"
}

function Assert-LaunchJarHasNoLocalConfig {
    param([Parameter(Mandatory = $true)][string]$JarPath)
    if (-not (Test-Path -LiteralPath $JarPath -PathType Leaf)) {
        throw '没有找到后端 JAR。首次启动不要添加 -SkipBuild。'
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($JarPath)
    try {
        $localEntries = @($archive.Entries | Where-Object {
            $_.FullName -match '(^|/)application-local\.(ya?ml|properties)$'
        })
        if ($localEntries.Count -gt 0) {
            throw '后端 JAR 包含本地私密配置，已停止启动。请确认 Maven 排除了 application-local.yml，并去掉 -SkipBuild 重新构建；配置应由外部文件读取。'
        }
    }
    finally { $archive.Dispose() }
}
