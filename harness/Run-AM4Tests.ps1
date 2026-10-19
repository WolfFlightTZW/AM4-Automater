#requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('Offline','SelfTest','Inventory','InspectMarkets','InspectAircraft','InspectSchedule','InspectEligibility','Repair','ACheck','RepairChain','ACheckChain','ResumeChain','Departure','PurchaseFuel','PurchaseCO2','IntegratedPass')]
    [string]$Scenario='Offline',
    [string]$ProductionRoot=(Split-Path -Parent $PSScriptRoot),
    [string]$OutputDirectory=(Join-Path $PSScriptRoot 'results'),
    [string]$Registration,
    [string]$Checkpoint,
    [ValidateRange(10,300)][int]$MaximumSeconds=90,
    [ValidateRange(0,120)][int]$WaitSeconds=0,
    [ValidateRange(1,3)][int]$MaximumActions=1,
    [string[]]$Steps=@('InspectMarkets','InspectAircraft','InspectSchedule','InspectEligibility'),
    [string]$Reason,
    [switch]$Live,
    [string]$NodePath
)
$ErrorActionPreference='Stop'
if(!$NodePath){
    $command=Get-Command node.exe -ErrorAction SilentlyContinue
    if($command){$NodePath=$command.Source}
    else {
        $bundled=Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
        if(Test-Path -LiteralPath $bundled){$NodePath=$bundled}else{throw 'Node.js 24 LTS is required; pass -NodePath or install it on PATH.'}
    }
}
$runtime=& $NodePath -p 'parseInt(process.versions.node)'
if($LASTEXITCODE -ne 0 -or [int]$runtime -lt 24){throw 'Node.js 24 or newer is required.'}
$nodeArgs=@((Join-Path $PSScriptRoot 'main.mjs'),'--scenario',$Scenario,'--production-root',$ProductionRoot,'--output',$OutputDirectory,'--max-seconds',"$MaximumSeconds",'--wait-seconds',"$WaitSeconds",'--max-actions',"$MaximumActions",'--steps',($Steps -join ','))
if($Registration){$nodeArgs+=@('--registration',$Registration)}
if($Checkpoint){$nodeArgs+=@('--checkpoint',$Checkpoint)}
if($Reason){$nodeArgs+=@('--reason',$Reason)}
if($Live){$nodeArgs+='--live'}
& $NodePath @nodeArgs
exit $LASTEXITCODE
