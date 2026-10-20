#requires -Version 5.1
[CmdletBinding()]
param([switch]$ElevatedReview,[switch]$Diagnostics)
$ErrorActionPreference='Stop'
$nodeCommand=Get-Command node.exe -ErrorAction SilentlyContinue
$nodePath=if($nodeCommand){$nodeCommand.Source}else{Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'}
$scriptPath=Join-Path $PSScriptRoot 'process-diagnostics.mjs'
if($ElevatedReview){Write-Host 'Compatibility option: this now performs read-only diagnostics. No process approvals are needed or written.'}
& $nodePath $scriptPath diagnose
if($LASTEXITCODE){exit $LASTEXITCODE}
Write-Host ''
Write-Host 'Diagnostics only. Operator mode, controller, approvals and recovery data were not changed.'
Write-Host 'Opaque shells are visibility warnings. Identifiable AM4 launchers/workers or foreign live CDP clients block startup.'
Write-Host 'Resolve credible conflicts, then explicitly select RESUME AUTOMATIC in the normal operator window.'
