#requires -Version 5.1
# Read-only log viewer. Does not start, stop, or acquire the controller.
$logDirectory = Join-Path $PSScriptRoot 'logs'
$log = Get-ChildItem -LiteralPath $logDirectory -Filter 'production-*.log' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if ($log) {
    Write-Host ('Watching: ' + $log.FullName) -ForegroundColor Cyan
    Get-Content -LiteralPath $log.FullName -Tail 40 -Wait
} else {
    Write-Host 'No production logs found.' -ForegroundColor Yellow
}
