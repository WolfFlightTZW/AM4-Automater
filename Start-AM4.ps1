#requires -Version 5.1
# Normal unattended launcher; all actions use the existing Node/SQLite worker.
param([int]$CycleSeconds=0,[int]$MaxDeparturesPerPass=16,[int]$MaxMaintenancePerPass=2,[int]$CsvBatchSize=10,[int]$MaximumPassSeconds=600,[int]$MaxPasses=0,[switch]$Resume,[switch]$EnableGuardedMaintenance)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'operator\Operator-Library.ps1')
if($Resume){$null=Invoke-AM4Control 'automatic'}
if((Invoke-AM4Control 'status').mode -ne 'AUTOMATIC'){Write-Host 'Paused. Start explicitly with -Resume, Start-AM4.cmd, or RESUME AUTOMATIC in Operator Control.';return}
$logDir=Join-Path $PSScriptRoot 'logs'
if(!(Test-Path -LiteralPath $logDir)){New-Item -ItemType Directory -Path $logDir|Out-Null}
$log=Join-Path $logDir ('production-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+$PID+'.log')
$worker=Join-Path $PSScriptRoot 'harness\production.mjs'
if($CycleSeconds -eq 0){$CycleSeconds=(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'harness\production-settings.json') -Raw|ConvertFrom-Json).cycleSeconds}
Write-Host "AM4 automatic operations. Log: $log"
& $script:AM4Node $worker --parent-pid $PID --cycle-seconds $CycleSeconds --max-departures $MaxDeparturesPerPass --max-maintenance $MaxMaintenancePerPass --csv-batch $CsvBatchSize --pass-seconds $MaximumPassSeconds --max-passes $MaxPasses *>> $log
exit $LASTEXITCODE
