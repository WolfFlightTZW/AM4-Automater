#requires -Version 5.1
param([ValidateSet('Panel','Pause','Resume','Testing','Status')][string]$Action='Panel')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Operator-Library.ps1')
Write-Output 'Operator control library loaded.'
function Start-Controller {
    $engine=Join-Path (Split-Path -Parent $PSScriptRoot) 'Start-AM4.ps1'
    Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$engine+'"')) | Out-Null
}
if($Action -ne 'Panel'){
    $command=switch($Action){'Pause'{'pause'}'Resume'{'automatic'}'Testing'{'testing'}'Status'{'status'}}
    $state=Invoke-AM4Control $command
    if($Action -eq 'Resume'){Start-Controller}
    Write-Host ("MODE: {0}`n{1}`nActive: {2}`nLast completed: {3}" -f $state.mode,$state.display,$state.activeAction,$state.lastCompletedAction)
    if($Action -eq 'Pause'){
        $until=(Get-Date).AddSeconds(35)
        while(!$state.safeToUseGame -and (Get-Date) -lt $until){Start-Sleep -Milliseconds 250;$state=Invoke-AM4Control 'status'}
        Write-Host $state.display
        if(!$state.safeToUseGame){Write-Host 'Pause is latched. Interface is not acknowledged released yet. Check the operator panel.';exit 2}
    }
    exit 0
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form=New-Object Windows.Forms.Form
Write-Output 'Operator form constructed.'
$form.Text='AM4 Operator Control';$form.Size=New-Object Drawing.Size(610,305);$form.StartPosition='CenterScreen';$form.TopMost=$true;$form.FormBorderStyle='FixedDialog';$form.MaximizeBox=$false
$status=New-Object Windows.Forms.Label;$status.Location=New-Object Drawing.Point(16,15);$status.Size=New-Object Drawing.Size(565,55);$status.Font=New-Object Drawing.Font('Segoe UI',14,[Drawing.FontStyle]::Bold);$form.Controls.Add($status)
$detail=New-Object Windows.Forms.Label;$detail.Location=New-Object Drawing.Point(16,78);$detail.Size=New-Object Drawing.Size(565,80);$form.Controls.Add($detail)
$note=New-Object Windows.Forms.Label;$note.Location=New-Object Drawing.Point(16,215);$note.Size=New-Object Drawing.Size(560,40);$note.Text='Pause is persistent. Closing this panel does not resume automation. TESTING must be selected before a live harness session.';$form.Controls.Add($note)
function Refresh-State {
    try{
        $s=Invoke-AM4Control 'status';$status.Text=$s.display
        $status.ForeColor=if($s.safeToUseGame){[Drawing.Color]::DarkGreen}else{[Drawing.Color]::DarkRed}
        $uncertain=if($s.uncertainty){"`nOutcome uncertainty: "+$s.uncertainty.reason}else{''}
        $detail.Text=("Mode: {0}`nActive action: {1}`nLast completed: {2}{3}" -f $s.mode,$s.activeAction,$s.lastCompletedAction,$uncertain)
    }catch{$status.Text='STATUS UNAVAILABLE - DO NOT ASSUME RELEASED';$status.ForeColor=[Drawing.Color]::DarkRed;$detail.Text=$_.Exception.Message}
}
foreach($spec in @(@('PAUSE / MANUAL',16,'pause'),@('RESUME AUTOMATIC',210,'automatic'),@('ENTER TESTING',404,'testing'))){
    $button=New-Object Windows.Forms.Button;$button.Text=$spec[0];$button.Location=New-Object Drawing.Point($spec[1],165);$button.Size=New-Object Drawing.Size(178,38);$button.Tag=$spec[2]
    $button.Add_Click({param($sender,$eventArgs)try{$null=Invoke-AM4Control ([string]$sender.Tag);if($sender.Tag -eq 'automatic'){Start-Controller};Refresh-State}catch{[Windows.Forms.MessageBox]::Show($_.Exception.Message,'AM4 control')|Out-Null}})
    $form.Controls.Add($button)
}
Write-Output 'Operator controls constructed.'
$timer=New-Object Windows.Forms.Timer;$timer.Interval=750;$timer.Add_Tick({Refresh-State});$timer.Start();Refresh-State
Write-Output 'Operator initial status loaded.'
# A hidden PowerShell console can pass SW_HIDE to the first top-level window.
# Re-show only our form; keep the background console hidden.
$form.Show();$form.Hide();$form.Show();$form.Activate()
try{[Windows.Forms.Application]::Run($form)}finally{$timer.Stop();$timer.Dispose();$form.Dispose()}
