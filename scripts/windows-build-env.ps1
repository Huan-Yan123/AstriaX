$ErrorActionPreference = 'Stop'
if (-not (Get-Command link.exe -ErrorAction SilentlyContinue)) {
    $locator = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $locator)) { throw 'Visual Studio C++ Build Tools and Windows SDK are required' }
    $installation = & $locator -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $installation) { throw 'Visual Studio C++ toolchain was not found' }
    Import-Module (Join-Path $installation 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll')
    Enter-VsDevShell -VsInstallPath $installation -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64' | Out-Null
}
# Optional SDK fallback for development machines; never downloaded or packaged by the app.
$localSdk = Join-Path $PSScriptRoot '../tmp/windows-sdk'
if (Test-Path -LiteralPath (Join-Path $localSdk 'x64/c/um/x64/kernel32.Lib')) {
    $sdkRoot = (Resolve-Path -LiteralPath (Join-Path $localSdk 'cpp/c')).Path
    $sdkLib = (Resolve-Path -LiteralPath (Join-Path $localSdk 'x64/c')).Path
    $env:LIB = "$sdkLib\um\x64;$sdkLib\ucrt\x64;$env:LIB"
    $env:INCLUDE = "$sdkRoot\Include\10.0.26100.0\ucrt;$sdkRoot\Include\10.0.26100.0\shared;$sdkRoot\Include\10.0.26100.0\um;$sdkRoot\Include\10.0.26100.0\winrt;$env:INCLUDE"
    $env:PATH = "$sdkRoot\bin\10.0.26100.0\x64;$env:PATH"
    $env:WindowsSdkDir = "$sdkRoot\"
    $env:WindowsSDKVersion = '10.0.26100.0\'
}
