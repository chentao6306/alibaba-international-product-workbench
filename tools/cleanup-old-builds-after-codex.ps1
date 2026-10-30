param([Parameter(Mandatory = $true)][int]$TargetPid)

$ErrorActionPreference = 'SilentlyContinue'
$cleanupScript = Join-Path $PSScriptRoot 'cleanup-project-artifacts.ps1'
$logFile = Join-Path $PSScriptRoot 'cleanup-after-codex.log'

Wait-Process -Id $TargetPid -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 700

for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
  $result = & $cleanupScript 2>&1 | Out-String
  $result | Set-Content -LiteralPath $logFile -Encoding UTF8
  try {
    $summary = $result | ConvertFrom-Json
    if ($summary.FailedCount -eq 0) { break }
  } catch {}
  Start-Sleep -Seconds 1
}
