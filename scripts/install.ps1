# MyLedger installer and launcher. Started by install.cmd / start.cmd.
#
#   install.cmd   install or update: checks Node.js, installs dependencies,
#                 prepares the database, builds the dashboard, then opens it.
#                 Safe to run again after downloading a new version.
#   start.cmd     just start the dashboard and open it in the browser.
#
# Console text is English on purpose: the Windows console does not lay out
# Hebrew right-to-left, so Hebrew here would read backwards. The dashboard,
# where the real onboarding happens, is Hebrew.
#   -Unattended   answer "no" to optional questions, stop a running copy when
#                 an update requires it, and do not open the browser
#                 (for scripted checks of the installer itself)
param([switch]$StartOnly, [switch]$Unattended)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$port = if ($env:API_PORT) { $env:API_PORT } else { '3010' }
$url = "http://127.0.0.1:$port"

function Step($text) { Write-Host ''; Write-Host "==> $text" -ForegroundColor Cyan }
function Fail($text) {
  Write-Host ''
  Write-Host "  $text" -ForegroundColor Red
  Write-Host ''
  if (-not $Unattended) { Read-Host 'Press Enter to close' }
  exit 1
}
function Ask($question) {
  if ($Unattended) { Write-Host "$question [y/N] n"; return $false }
  $answer = Read-Host "$question [y/N]"
  return $answer -match '^(y|yes)$'
}
function Run($what) {
  # npm writes progress to stderr; only the exit code means failure.
  $ErrorActionPreference = 'Continue'
  & cmd.exe /c $what
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($code -ne 0) { Fail "Failed: $what (exit $code). See the messages above; docs/INSTALL.md has a troubleshooting table." }
}
function IsRunning {
  try { Invoke-WebRequest "$url/api/meta" -UseBasicParsing -TimeoutSec 2 | Out-Null; return $true } catch { return $false }
}
$windowTitle = 'MyLedger - close this window to stop'
# Only this copy's processes: node started from this folder, the logon task's
# supervisor loop (scripts\api.cmd) and the minimized window start.cmd opens.
function Stop-MyLedger {
  $procs = Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq 'cmd.exe' -and ($_.CommandLine -like "*$root\scripts\api.cmd*" -or $_.CommandLine -like "*$windowTitle*")) -or
    ($_.Name -eq 'node.exe' -and $_.CommandLine -like "*$root*")
  }
  # Supervisors first, or they restart the server we are about to stop.
  foreach ($p in ($procs | Sort-Object { $_.Name -ne 'cmd.exe' })) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  for ($i = 0; $i -lt 15 -and (IsRunning); $i++) { Start-Sleep -Seconds 1 }
  if (IsRunning) { Fail 'Could not stop MyLedger. Restart the computer and run install.cmd again right away.' }
}
$stopped = $false
function Ensure-Stopped($why) {
  if ($script:stopped -or -not (IsRunning)) { return }
  Write-Host "  MyLedger is running, and $why."
  if (-not $Unattended -and -not (Ask '  Stop it now? It starts again at the end')) { Fail 'Update cancelled. Nothing was changed.' }
  Stop-MyLedger
  $script:stopped = $true
}
function Start-Dashboard {
  if (IsRunning) { Write-Host "  MyLedger is already running."; return }
  # The logon task serves the default port; a custom API_PORT means a separate copy.
  if (-not $env:API_PORT -and (Get-ScheduledTask -TaskName 'MyLedger dashboard' -ErrorAction SilentlyContinue)) {
    Start-ScheduledTask -TaskName 'MyLedger dashboard'
  } else {
    # A minimized window: closing it stops MyLedger, which is easy to understand.
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', "title $windowTitle && npm run api" -WorkingDirectory $root -WindowStyle Minimized
  }
  for ($i = 0; $i -lt 60; $i++) {
    if (IsRunning) { return }
    Start-Sleep -Seconds 1
  }
  Fail "The dashboard did not start. Run 'npm run api' in this folder to see why."
}

Write-Host ''
Write-Host '  MyLedger' -ForegroundColor Green
Write-Host '  Your cash flow, on your own computer.'

if ($StartOnly) {
  if (-not (Test-Path 'web\dist\index.html')) { Fail 'MyLedger is not installed yet. Run install.cmd first.' }
  Step 'Starting'
  Start-Dashboard
  Start-Process $url
  exit 0
}

# ------------------------------------------------------------------ Windows
if ($env:OS -ne 'Windows_NT') { Fail 'This installer is for Windows. On other systems follow docs/INSTALL.md.' }

# ------------------------------------------------------------------ Node.js
Step 'Checking Node.js'
function NodeVersion {
  try { return [version]((& node --version) -replace '^v', '') } catch { return $null }
}
$node = NodeVersion
if (-not $node -or $node -lt [version]'22.13.0' -or $node.Major -notin @(22, 24)) {
  $found = if ($node) { "version $node is too old" } else { 'it is not installed' }
  Write-Host "  MyLedger needs a current Node.js 22 or 24 LTS release, and $found."
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget -and (Ask '  Install Node.js LTS now with winget?')) {
    Run 'winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements'
    # The new PATH is only in the registry until a new window opens.
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    $node = NodeVersion
  }
  if (-not $node -or $node -lt [version]'22.13.0' -or $node.Major -notin @(22, 24)) {
    Start-Process 'https://nodejs.org/en/download'
    Fail 'Install Node.js LTS from the page that just opened, then run install.cmd again.'
  }
}
Write-Host "  Node.js $node"

# ------------------------------------------------------------ dependencies
# Skipped when the lockfiles have not changed, so re-running is quick and does
# not fight a running dashboard for its files.
Step 'Installing dependencies (the first time takes a few minutes)'
$lockHash = (Get-FileHash 'package-lock.json').Hash + (Get-FileHash 'web\package-lock.json').Hash
$stamp = 'node_modules\.myledger-install'
$current = (Test-Path $stamp) -and ((Get-Content $stamp -Raw).Trim() -eq $lockHash) -and (Test-Path 'web\node_modules')
if ($current) {
  Write-Host '  Already up to date.'
} else {
  Ensure-Stopped 'its libraries are being replaced'
  Run 'npm ci'
  Run 'npm run web:install'
  Set-Content -Path $stamp -Value $lockHash
}

# ---------------------------------------------------------------- database
Step 'Preparing the database'
if (-not (Test-Path '.env')) {
  Copy-Item '.env.example' '.env'
  Write-Host '  Created .env with the default settings.'
}
$fresh = -not (Test-Path 'prisma\myledger.db')
# Most updates change no schema. Checking first means the running dashboard
# only has to stop when a migration really needs the database to itself.
$ErrorActionPreference = 'Continue'
& cmd.exe /c 'npx prisma migrate status > NUL 2>&1'
$pending = $LASTEXITCODE -ne 0
$ErrorActionPreference = 'Stop'
if ($fresh -or $pending) {
  Ensure-Stopped 'the database needs an update'
  Run 'npx prisma migrate deploy'
} else {
  Write-Host '  Database is up to date.'
}

# --------------------------------------------------------------- dashboard
Step 'Building the dashboard'
Run 'npm run web:build'

# ------------------------------------------------------------------ extras
if ($fresh) {
  Write-Host ''
  if (Ask 'Load a fictional demo household, to look around before connecting a real account?') {
    Run 'npm run seed'
    Write-Host '  Demo data loaded. Before connecting real accounts, clear it with: npm run reset -- all'
  }
}

if (-not (Get-ScheduledTask -TaskName 'MyLedger daily sync' -ErrorAction SilentlyContinue)) {
  Write-Host ''
  Write-Host 'MyLedger can run by itself: sync every day at 10:00 and start with Windows.'
  if (Ask 'Set that up now? (you can do it later with "npm run schedule:install")') {
    Run 'npm run schedule:install'
  }
}

# ------------------------------------------------------------------- start
Step 'Starting MyLedger'
Start-Dashboard
Write-Host ''
Write-Host "  Ready: $url" -ForegroundColor Green
Write-Host '  The dashboard will guide you through connecting your bank and cards.'
Write-Host '  Next time, open it with start.cmd.'
if (-not $Unattended) {
  Start-Process $url
  Write-Host ''
  Read-Host 'Press Enter to close this window'
}
