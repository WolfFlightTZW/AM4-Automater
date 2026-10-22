#requires -Version 5.1
# Read-only Details inspection. Uses the existing safe pause and exclusive CDP lease.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'operator\Operator-Library.ps1')
& $script:AM4Node (Join-Path $PSScriptRoot 'harness\snapshot-command.mjs') --run
exit $LASTEXITCODE
