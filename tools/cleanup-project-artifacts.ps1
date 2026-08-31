$ErrorActionPreference = 'Stop'

$workspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$removed = [System.Collections.Generic.List[object]]::new()
$failed = [System.Collections.Generic.List[object]]::new()

function Assert-WorkspaceChild([string]$Path) {
  $full = [System.IO.Path]::GetFullPath($Path)
  $prefix = $workspace + [System.IO.Path]::DirectorySeparatorChar
  if (-not $full.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove path outside workspace: $full"
  }
  return $full
}

function Remove-GeneratedPath([string]$Path) {
  $full = Assert-WorkspaceChild $Path
  if (-not (Test-Path -LiteralPath $full)) { return }
  $item = Get-Item -LiteralPath $full -Force
  $bytes = if ($item.PSIsContainer) {
    (Get-ChildItem -LiteralPath $full -Recurse -Force -File -ErrorAction SilentlyContinue |
      Measure-Object -Property Length -Sum).Sum
  } else {
    $item.Length
  }
  try {
    Remove-Item -LiteralPath $full -Recurse -Force
    $removed.Add([pscustomobject]@{ Path = $full; Bytes = [long]$bytes })
  } catch {
    $failed.Add([pscustomobject]@{ Path = $full; Error = $_.Exception.Message })
  }
}

# Old installers, unpacked applications, and superseded delivery copies.
$topLevelDirectories = Get-ChildItem -LiteralPath $workspace -Directory -Force | Where-Object {
  $_.Name -like 'release-*' -or
  $_.Name -like 'electron-dist-*' -or
  $_.Name -in @('installer-extracted', 'delivery-current', 'deploy')
}
foreach ($directory in $topLevelDirectories) {
  Remove-GeneratedPath $directory.FullName
}

foreach ($fileName in @(
  'captcha-fixed-app.asar',
  'release-installer-v3-app.asar',
  'seller-session-fixed-app.asar'
)) {
  Remove-GeneratedPath (Join-Path $workspace $fileName)
}

# Preserve workspace.json because it contains the user's product workspace.
# Everything else listed here is reproducible browser state, upload cache,
# diagnostics, screenshots, logs, or obsolete backups.
$dataDirectory = Join-Path $workspace '.data'
foreach ($directoryName in @(
  'source-profile',
  'seller-profile',
  'collector-profile',
  'publish-images',
  'publish-videos',
  'test-profile'
)) {
  Remove-GeneratedPath (Join-Path $dataDirectory $directoryName)
}
if (Test-Path -LiteralPath $dataDirectory) {
  Get-ChildItem -LiteralPath $dataDirectory -File -Force |
    Where-Object { $_.Name -ne 'workspace.json' } |
    ForEach-Object { Remove-GeneratedPath $_.FullName }
}

$reclaimed = ($removed | Measure-Object -Property Bytes -Sum).Sum
[pscustomobject]@{
  Workspace = $workspace
  RemovedCount = $removed.Count
  ReclaimedBytes = [long]$reclaimed
  ReclaimedGB = [math]::Round($reclaimed / 1GB, 2)
  FailedCount = $failed.Count
  Failed = @($failed)
} | ConvertTo-Json -Depth 4
