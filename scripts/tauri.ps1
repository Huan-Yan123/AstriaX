$TauriArguments = $args
. (Join-Path $PSScriptRoot 'windows-build-env.ps1')
& pnpm exec tauri @TauriArguments
exit $LASTEXITCODE
