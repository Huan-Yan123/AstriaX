$TauriArguments = $args
. (Join-Path $PSScriptRoot 'windows-build-env.ps1')
if ($TauriArguments.Count -gt 0 -and $TauriArguments[0] -in @('build','bundle') -and $TauriArguments -notcontains '--no-bundle') {
    & cargo build -p astriax-core --bin astriax-maintenance --release
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
& pnpm exec tauri @TauriArguments
exit $LASTEXITCODE
