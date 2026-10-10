$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$binary = Join-Path $repository 'target/debug/astriax-desktop.exe'
if (-not (Test-Path -LiteralPath $binary)) { throw 'Build the debug desktop binary first' }
Invoke-WebRequest 'http://127.0.0.1:1420/' -UseBasicParsing -TimeoutSec 5 | Out-Null
$root = Join-Path $repository ('tmp/desktop-smoke-' + [guid]::NewGuid().ToString('N'))
$instance = Join-Path $root 'instances/AstrBot/a_smoke'
New-Item -ItemType Directory -Path $instance -Force | Out-Null
$candidates = @()
foreach ($folder in ($env:PATH -split ';')) {
    if ([string]::IsNullOrWhiteSpace($folder)) { continue }
    foreach ($name in @('python.exe','python3.exe')) {
        $candidate = Join-Path $folder $name
        if ((Test-Path -LiteralPath $candidate -PathType Leaf) -and (Get-Item -LiteralPath $candidate).Length -gt 0) { $candidates += $candidate }
    }
}
$python = $candidates | Select-Object -First 1
if (-not $python) {
    # Resolve the Store execution alias once, then launch the actual interpreter.
    $python = (& python.exe -I -c 'import sys;print(sys.executable)').Trim()
}
$fixture = Join-Path $repository 'tests/fixtures/rust-rewrite/webui-server.py'
$server = Start-Process $python -ArgumentList @('-u',('"' + $fixture + '"'),('"' + $root + '"')) -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $root 'server-stderr.txt')
$desktop = $null
$oldRoot = $env:ASTRIAX_DATA_ROOT
$oldSmoke = $env:ASTRIAX_SMOKE_TEST
$oldWebuiSmoke = $env:ASTRIAX_WEBUI_SMOKE
try {
    for ($attempt=0; $attempt -lt 200 -and -not (Test-Path (Join-Path $root 'server.json')); $attempt++) {
        if ($server.HasExited) { throw "Python fixture exited: $(Get-Content (Join-Path $root 'server-stderr.txt') -Raw)" }
        Start-Sleep -Milliseconds 100
    }
    $port = (Get-Content (Join-Path $root 'server.json') -Raw | ConvertFrom-Json).port
    @{dataRoot=$root} | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $root 'config.json')
    @{runtimeTag='v4.28.1'} | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $instance 'instance.json')
    @{instances=@(@{id='a_smoke';type='a';name='Smoke fixture';templateVersion=1;port=$port;dir=$instance;status='stopped';createdAt='2026-10-10';updatedAt='2026-10-10'})} | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 (Join-Path $root 'instances.json')
    $env:ASTRIAX_DATA_ROOT=$root
    $env:ASTRIAX_SMOKE_TEST='1'
    $env:ASTRIAX_WEBUI_SMOKE='1'
    $desktop=Start-Process $binary -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $root 'stderr.txt')
    $null=$desktop.Handle
    if (-not $desktop.WaitForExit(45000)) { throw "Desktop smoke timed out: $root" }
    if ($desktop.ExitCode -ne 0) { throw "Desktop exited $($desktop.ExitCode): $root" }
    $report=Get-Content (Join-Path $root 'smoke.json') -Raw | ConvertFrom-Json
    foreach ($key in @('vueBridge','embeddedWebui','remoteDenied','mainCommandsAfterWebui','webuiShortcut')) {
        if (-not $report.$key) { throw "Smoke failed $key : $root" }
    }
    $session=Get-Content (Join-Path $root 'logs/session.json') -Raw | ConvertFrom-Json
    if ($session.active) { throw 'Shutdown did not mark the session clean' }
    $report | ConvertTo-Json
} finally {
    if ($desktop -and -not $desktop.HasExited) { $desktop.Kill(); $desktop.WaitForExit() }
    if (-not $server.HasExited) { $server.Kill(); $server.WaitForExit() }
    $env:ASTRIAX_DATA_ROOT=$oldRoot
    $env:ASTRIAX_SMOKE_TEST=$oldSmoke
    $env:ASTRIAX_WEBUI_SMOKE=$oldWebuiSmoke
}
