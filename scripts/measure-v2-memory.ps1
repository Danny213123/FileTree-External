param(
  [int]$ProcessId = 0,
  [string]$LaunchPath = "",
  [int]$DurationMinutes = 10,
  [int]$SampleSeconds = 2,
  [int]$WarmupSeconds = 30,
  [int]$MaxMiB = 0,
  [string]$OutputPath = "",
  [switch]$KeepLaunchedProcess
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$launchedByHarness = $false
if ($ProcessId -le 0) {
  if ([string]::IsNullOrWhiteSpace($LaunchPath)) {
    throw "Pass -ProcessId or -LaunchPath."
  }
  $resolved = (Resolve-Path -LiteralPath $LaunchPath).Path
  $launched = Start-Process -FilePath $resolved -PassThru -WindowStyle Hidden
  $ProcessId = $launched.Id
  $launchedByHarness = $true
}

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $OutputPath = Join-Path $PSScriptRoot "..\artifacts\memory-$stamp.csv"
}
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($OutputPath)) | Out-Null

function Get-DescendantIds([int]$RootId) {
  $rows = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine, CreationDate
  $script:ProcessRoles = @{}
  $rowsById = @{}
  foreach ($row in $rows) { $rowsById[[int]$row.ProcessId] = $row }
  $children = @{}
  foreach ($row in $rows) {
    $role = "app"
    if ($row.Name -ieq "msedgewebview2.exe") {
      $detail = [string]$row.CommandLine
      if ($detail -match '--type=([^\s"]+)') { $role = $Matches[1] } else { $role = "browser" }
    }
    $script:ProcessRoles[[int]$row.ProcessId] = $role
    $parent = [int]$row.ParentProcessId
    # ParentProcessId can outlive its parent and later point at an unrelated
    # process after PID reuse. A real child cannot predate its live parent.
    if ($rowsById.ContainsKey($parent)) {
      $parentCreated = [datetime]$rowsById[$parent].CreationDate
      $childCreated = [datetime]$row.CreationDate
      if ($childCreated.AddSeconds(2) -lt $parentCreated) { continue }
    }
    if (!$children.ContainsKey($parent)) { $children[$parent] = [System.Collections.Generic.List[int]]::new() }
    $children[$parent].Add([int]$row.ProcessId)
  }
  $ids = [System.Collections.Generic.HashSet[int]]::new()
  $queue = [System.Collections.Generic.Queue[int]]::new()
  $queue.Enqueue($RootId)
  while ($queue.Count -gt 0) {
    $id = $queue.Dequeue()
    if (!$ids.Add($id)) { continue }
    if ($children.ContainsKey($id)) {
      foreach ($child in $children[$id]) { $queue.Enqueue($child) }
    }
  }
  return $ids
}

$samples = [System.Collections.Generic.List[object]]::new()
$startedAt = Get-Date
$deadline = (Get-Date).AddMinutes([Math]::Max(1, $DurationMinutes))
$rootExitedEarly = $false
Write-Host "Sampling FileTree process tree rooted at PID $ProcessId"
Write-Host "Output: $OutputPath"

while ((Get-Date) -lt $deadline) {
  $now = Get-Date
  if ($null -eq (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
    $rootExitedEarly = $true
    break
  }
  $ids = Get-DescendantIds $ProcessId
  $appPrivate = 0L
  $appWorking = 0L
  $encoderPrivate = 0L
  $encoderWorking = 0L
  $appProcesses = 0
  $encoderProcesses = 0
  $appBreakdown = [System.Collections.Generic.List[string]]::new()

  foreach ($id in $ids) {
    $process = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($null -eq $process) { continue }
    $isEncoder = $process.ProcessName -match '^(HandBrakeCLI|ffmpeg|magick)$'
    if ($isEncoder) {
      $encoderPrivate += [int64]$process.PrivateMemorySize64
      $encoderWorking += [int64]$process.WorkingSet64
      $encoderProcesses++
    } else {
      $appPrivate += [int64]$process.PrivateMemorySize64
      $appWorking += [int64]$process.WorkingSet64
      $appProcesses++
      $privateMiB = [Math]::Round($process.PrivateMemorySize64 / 1MB, 1)
      $role = $script:ProcessRoles[$id]
      $appBreakdown.Add("$($process.ProcessName)[$role]:${id}:${privateMiB}MiB")
    }
  }

  $elapsedSeconds = ($now - $startedAt).TotalSeconds
  $samples.Add([pscustomobject]@{
    Timestamp = $now.ToString("o")
    RootPid = $ProcessId
    AppProcessCount = $appProcesses
    AppPrivateBytes = $appPrivate
    AppWorkingSetBytes = $appWorking
    EncoderProcessCount = $encoderProcesses
    EncoderPrivateBytes = $encoderPrivate
    EncoderWorkingSetBytes = $encoderWorking
    Warmup = ($elapsedSeconds -lt $WarmupSeconds)
    AppBreakdown = ($appBreakdown -join ";")
  })
  Write-Progress -Activity "FileTree memory harness" -Status ("App private: {0:N1} MiB; encoders: {1:N1} MiB" -f ($appPrivate / 1MB), ($encoderPrivate / 1MB))
  Start-Sleep -Seconds ([Math]::Max(1, $SampleSeconds))
}

$samples | Export-Csv -LiteralPath $OutputPath -NoTypeInformation -Encoding UTF8
$maxPrivate = ($samples | Measure-Object -Property AppPrivateBytes -Maximum).Maximum
$settledSamples = @($samples | Where-Object { -not $_.Warmup })
if ($settledSamples.Count -eq 0) { $settledSamples = @($samples) }
$maxSettledPrivate = ($settledSamples | Measure-Object -Property AppPrivateBytes -Maximum).Maximum
$lastPrivate = $samples[$samples.Count - 1].AppPrivateBytes
$summary = [pscustomobject]@{
  RootPid = $ProcessId
  Samples = $samples.Count
  StartupPeakAppPrivateMiB = [Math]::Round($maxPrivate / 1MB, 2)
  SettledPeakAppPrivateMiB = [Math]::Round($maxSettledPrivate / 1MB, 2)
  FinalAppPrivateMiB = [Math]::Round($lastPrivate / 1MB, 2)
  WarmupSeconds = $WarmupSeconds
  MaxAllowedMiB = $MaxMiB
  ProcessStayedAlive = (-not $rootExitedEarly)
  ExitCode = if ($launchedByHarness -and $launched.HasExited) { $launched.ExitCode } else { $null }
  Passed = (-not $rootExitedEarly -and ($MaxMiB -le 0 -or $maxSettledPrivate -le ($MaxMiB * 1MB)))
  Csv = $OutputPath
}
$summary | Format-List
if ($launchedByHarness -and !$KeepLaunchedProcess) {
  # Stop only the process tree rooted at the executable this harness launched.
  # Children first keeps WebView2 and encoder helpers from surviving a forced
  # root-process exit and contaminating the next aggregate sample.
  $ownedIds = @(Get-DescendantIds $ProcessId | Sort-Object -Descending)
  foreach ($ownedId in $ownedIds) {
    Stop-Process -Id $ownedId -Force -ErrorAction SilentlyContinue
  }
}
if ($rootExitedEarly) { throw "Memory gate invalid: FileTree exited before the sampling deadline (exit code $($summary.ExitCode))." }
if (!$summary.Passed) { throw "Memory gate failed: settled peak $($summary.SettledPeakAppPrivateMiB) MiB > $MaxMiB MiB" }
