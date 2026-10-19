#requires -Version 5.1
# Shared thin bridge to the same SQLite operator state used by the Node harness.
$script:AM4OperatorRoot=Join-Path $PSScriptRoot 'state'
$script:AM4OperatorCli=Join-Path $PSScriptRoot 'cli.mjs'
$nodeCommand=Get-Command node.exe -ErrorAction SilentlyContinue
if($nodeCommand){$script:AM4Node=$nodeCommand.Source}else{$script:AM4Node=Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'}
function Invoke-AM4Control([string]$Command,[string[]]$Arguments=@(),[string]$Expression){
    $allArgs=@($script:AM4OperatorCli,$Command,'--root',$script:AM4OperatorRoot)+$Arguments
    if($PSBoundParameters.ContainsKey('Expression')){
        $OutputEncoding=New-Object System.Text.UTF8Encoding($false)
        $raw=$Expression | & $script:AM4Node @allArgs
    }else{$raw=& $script:AM4Node @allArgs}
    $value=$raw | ConvertFrom-Json
    if(!$value.ok){
        $details=if($value.processDiagnostics){' '+($value.processDiagnostics|ConvertTo-Json -Depth 6 -Compress)}else{''}
        throw ($value.error+$details)
    }
    return $value
}
function Start-AM4Operator([string]$Role='AUTOMATIC'){
    $owner=Invoke-AM4Control 'acquire' @('--role',$Role,'--pid',"$PID")
    $script:AM4OperatorToken=$owner.token;$script:AM4OperatorGroup=$false;$script:AM4OperatorBrowserOffset=0
}
function Stop-AM4Operator {
    if($script:AM4OperatorToken){try{$null=Invoke-AM4Control 'release' @('--token',$script:AM4OperatorToken)}finally{$script:AM4OperatorToken=$null}}
}
function Enter-AM4OperatorGroup([string]$Name){
    $null=Invoke-AM4Control 'begin' @('--token',$script:AM4OperatorToken,'--name',$Name)
    $script:AM4OperatorGroup=$true;$script:AM4OperatorAction=$Name;$script:AM4OperatorIrreversible=$false;$script:AM4OperatorGroupOutcome='RETURNED'
}
function Exit-AM4OperatorGroup([string]$Outcome='RETURNED'){
    if($script:AM4OperatorGroupOutcome -eq 'UNKNOWN'){$Outcome='UNKNOWN'}
    if($script:AM4OperatorGroup){try{$null=Invoke-AM4Control 'end' @('--token',$script:AM4OperatorToken,'--outcome',$Outcome)}catch{if($_.Exception.Message -ne 'OPERATOR_OWNERSHIP_LOST'){throw}}finally{$script:AM4OperatorGroup=$false;$script:AM4OperatorIrreversible=$false}}
}
function Start-AM4OperatorStep([string]$Expression){
    $name=if($script:AM4OperatorGroup){$script:AM4OperatorAction}else{'Inspect / navigate AM4'}
    $script:AM4OperatorDeniedBeforeSend=$false
    try{$lease=Invoke-AM4Control 'step' @('--token',$script:AM4OperatorToken,'--name',$name,'--offset',([string]$script:AM4OperatorBrowserOffset),'--irreversible',([string][bool]$script:AM4OperatorIrreversible).ToLowerInvariant()) -Expression $Expression}
    catch{$script:AM4OperatorDeniedBeforeSend=$true;throw}
    $script:AM4OperatorIrreversible=$false
    return $lease
}
function Stop-AM4OperatorStep($Lease,[string]$Outcome='RETURNED'){
    if($Outcome -eq 'UNKNOWN'){$script:AM4OperatorGroupOutcome='UNKNOWN'}
    $null=Invoke-AM4Control 'end-step' @('--token',$script:AM4OperatorToken,'--implicit',([string][bool]$Lease.implicit).ToLowerInvariant(),'--outcome',$Outcome)
}
