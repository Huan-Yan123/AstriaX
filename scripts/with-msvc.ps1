$CargoArguments = $args
. (Join-Path $PSScriptRoot 'windows-build-env.ps1')
& cargo @CargoArguments
exit $LASTEXITCODE