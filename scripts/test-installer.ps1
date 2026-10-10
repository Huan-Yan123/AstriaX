# Compile two isolated test installers from Tauri's rendered NSIS script.
# Product name, bundle id, shortcuts and registry keys are unique per test run.
$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$generated = Join-Path $repository 'target/release/nsis/x64'
$compiler = Join-Path $env:LOCALAPPDATA 'tauri/NSIS/makensis.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Run pnpm dist before testing the installer' }
$id = [guid]::NewGuid().ToString('N')
$product = 'AstriaX Installer Test ' + $id
$scope = 'fun.huanyan.astriax.test.' + $id
$sandbox = Join-Path $repository ('tmp/installer-smoke-' + $id)
New-Item -ItemType Directory -Path $sandbox | Out-Null
$resolved = (Resolve-Path -LiteralPath $sandbox).Path
if (-not $resolved.StartsWith((Join-Path $repository 'tmp/installer-smoke-'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid installer test scope' }
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $product
if (Test-Path -LiteralPath $uninstallKey) { throw 'Test product identity already exists' }
foreach ($name in @('utils.nsh','FileAssociation.nsh','SimpChinese.nsh')) { Copy-Item -LiteralPath (Join-Path $generated $name) -Destination $sandbox }
$template = Get-Content -LiteralPath (Join-Path $generated 'installer.nsi') -Raw
$template = $template.Replace('!define PRODUCTNAME "AstriaX"', ('!define PRODUCTNAME "' + $product + '"'))
$template = $template.Replace('!define BUNDLEID "fun.huanyan.astriax"', ('!define BUNDLEID "' + $scope + '"'))
$template = $template.Replace('!define MANUFACTURER "huanyan"', ('!define MANUFACTURER "astriax-test-' + $id + '"'))
foreach ($version in @('1.0.1','1.0.2')) {
    $source = $template.Replace('!define VERSION "1.0.2"', ('!define VERSION "' + $version + '"')).Replace('!define VERSIONWITHBUILD "1.0.2.0"', ('!define VERSIONWITHBUILD "' + $version + '.0"'))
    $source = $source.Replace('!define OUTFILE "nsis-output.exe"', ('!define OUTFILE "test-' + $version + '.exe"'))
    $script = Join-Path $sandbox ('test-' + $version + '.nsi')
    [IO.File]::WriteAllText($script, $source, [Text.UTF8Encoding]::new($false))
    Push-Location $sandbox
    try {
        & $compiler /V2 $script | Out-File -Encoding utf8 (Join-Path $sandbox ('compile-' + $version + '.log'))
        if ($LASTEXITCODE -ne 0) { throw "Test NSIS compilation failed: $version" }
    } finally { Pop-Location }
}
function Run-Installer([string]$Version, [string]$Directory) {
    $exe = Join-Path $sandbox ('test-' + $Version + '.exe')
    $process = Start-Process -FilePath $exe -ArgumentList @('/S','/NS',('/D=' + $Directory)) -WindowStyle Hidden -PassThru
    $null = $process.Handle
    if (-not $process.WaitForExit(60000)) { $process.Kill(); throw 'Test installer timed out' }
    if ($process.ExitCode -ne 0) { throw "Test installer exited $($process.ExitCode): $sandbox" }
}
function Run-Uninstaller([string]$Directory, [bool]$DeleteData) {
    $arguments = @('/S')
    if ($DeleteData) { $arguments += '/DELETE_DATA' }
    $process = Start-Process -FilePath (Join-Path $Directory 'uninstall.exe') -ArgumentList $arguments -WindowStyle Hidden -PassThru
    $null = $process.Handle
    if (-not $process.WaitForExit(60000)) { $process.Kill(); throw 'Test uninstaller timed out' }
    if ($process.ExitCode -ne 0) { throw "Test uninstaller exited $($process.ExitCode): $sandbox" }
    for ($attempt=0; $attempt -lt 100 -and (Test-Path -LiteralPath $uninstallKey); $attempt++) { Start-Sleep -Milliseconds 100 }
    if (Test-Path -LiteralPath $uninstallKey) { throw 'Test uninstall registry record remains' }
    if (Test-Path -LiteralPath (Join-Path $Directory 'astriax-desktop.exe')) { throw 'Desktop binary remains after uninstall' }
}
$install = Join-Path $sandbox 'installed app'
$data = Join-Path $sandbox 'custom data'
Run-Installer '1.0.1' $install
if (-not (Test-Path -LiteralPath (Join-Path $install 'installation.json'))) { throw 'Fresh install did not register data root' }
New-Item -ItemType Directory -Path (Join-Path $data 'instances/test/data/plugins'), (Join-Path $data 'runtimes/a/test') -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $install 'data-root.txt'), $data, [Text.UTF8Encoding]::new($false))
@{dataRoot=$data;customField='保留'} | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $data 'config.json')
'插件数据' | Set-Content -Encoding utf8 (Join-Path $data 'instances/test/data/plugins/test.txt')
'upstream runtime' | Set-Content -Encoding utf8 (Join-Path $data 'runtimes/a/test/main.py')
'unrelated user file' | Set-Content -Encoding utf8 (Join-Path $data 'foreign.txt')
'{}' | Set-Content -Encoding utf8 (Join-Path $data 'rust-version-cache.json')
New-Item -ItemType Directory -Path (Join-Path $data '.transactions') | Out-Null
Run-Installer '1.0.2' $install
$configuration = Get-Content (Join-Path $data 'config.json') -Raw | ConvertFrom-Json
if ($configuration.customField -ne '保留') { throw 'Upgrade lost custom config' }
if ((Get-Content (Join-Path $install 'data-root.txt') -Raw).Trim() -ne $data) { throw 'Upgrade lost custom data root' }
if (-not (Test-Path -LiteralPath (Join-Path $data 'instances/test/data/plugins/test.txt'))) { throw 'Upgrade lost instance data' }
$backups = @(Get-ChildItem -LiteralPath (Join-Path $sandbox 'AstriaX-update-backups') -Filter upgrade.zip -File -Recurse)
if ($backups.Count -lt 1) { throw 'Upgrade snapshot was not created' }
Run-Uninstaller $install $false
if (-not (Test-Path -LiteralPath (Join-Path $data 'config.json'))) { throw 'Keep-data uninstall removed config' }
if ((Get-Content (Join-Path $install 'data-root.txt') -Raw).Trim() -ne $data) { throw 'Keep-data uninstall lost pointer' }
Run-Installer '1.0.2' $install
Run-Uninstaller $install $true
foreach ($managed in @('config.json','instances','runtimes','rust-version-cache.json','.transactions')) {
    if (Test-Path -LiteralPath (Join-Path $data $managed)) { throw "Delete-data uninstall retained $managed" }
}
if (-not (Test-Path -LiteralPath (Join-Path $data 'foreign.txt'))) { throw 'Uninstall deleted an unrelated user file' }
if (-not (Test-Path -LiteralPath $backups[0].FullName)) { throw 'Uninstall removed the upgrade snapshot' }
if (Test-Path -LiteralPath ('HKCU:\Software\AstriaX\' + $scope)) { throw 'Rust installation registry record remains' }
$report = @{freshInstall=$true;upgradePreservesData=$true;upgradeSnapshot=$true;keepData=$true;reinstallFindsData=$true;deleteManagedData=$true;foreignFilesRetained=$true;scope=$scope;sandbox=$sandbox}
$report | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $sandbox 'report.json')
$report | ConvertTo-Json
