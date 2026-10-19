# Windows PowerShell 5.1 lock host. Node keeps stdin open for the entire session.
param([string]$MutexName='Local\AM4_Automater_Operations_Singleton')
$ErrorActionPreference='Stop'
$mutex=New-Object System.Threading.Mutex($false,$MutexName)
$owned=$false
try {
    try { $owned=$mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned=$true }
    if(!$owned){[Console]::Out.WriteLine('BUSY');exit 3}
    [Console]::Out.WriteLine('READY')
    [Console]::Out.Flush()
    $null=[Console]::In.ReadToEnd()
} finally { if($owned){$mutex.ReleaseMutex()};$mutex.Dispose() }
