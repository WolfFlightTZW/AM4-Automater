#requires -Version 5.1
[CmdletBinding()]
param([switch]$ElevatedReview,[switch]$Diagnostics)
$ErrorActionPreference='Stop'
$nodeCommand=Get-Command node.exe -ErrorAction SilentlyContinue
$nodePath=if($nodeCommand){$nodeCommand.Source}else{Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'}
$scriptPath=Join-Path $PSScriptRoot 'process-attestation.mjs'
if($ElevatedReview){
    & $nodePath $scriptPath review
    if($LASTEXITCODE){exit $LASTEXITCODE}
    Write-Host 'Approval saved locally. Nothing was resumed. Close this administrator terminal.'
    Write-Host 'Return to your normal operator window and select RESUME AUTOMATIC once.'
    exit 0
}
& $nodePath $scriptPath diagnose
if($LASTEXITCODE){exit $LASTEXITCODE}
if($Diagnostics){exit 0}
& $nodePath $scriptPath prepare
if($LASTEXITCODE){exit $LASTEXITCODE}
Write-Host ''
Write-Host 'No process was approved and no operator mode was changed.'
Write-Host 'If review is required, open Windows PowerShell as administrator and run:'
Write-Host ('powershell -NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'" -ElevatedReview')
Write-Host 'Complete review within 10 minutes. Inspect each full command and executable.'
Write-Host 'Approve only processes you have verified are unrelated to AM4 automation.'
