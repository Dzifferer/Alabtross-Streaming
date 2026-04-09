#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Install the Albatross GPU conversion worker as a Windows service.

.DESCRIPTION
    Installs Node.js (if missing), an NVENC-enabled ffmpeg build (if missing),
    copies server.js to the install directory, and registers a Scheduled Task
    that runs the worker at boot under the SYSTEM account so it survives
    reboots and user logoff.

    Run this on the Windows PC that has the RTX card. Must be run from an
    elevated PowerShell prompt (right-click → Run as Administrator).

.PARAMETER InstallDir
    Where to install server.js. Defaults to C:\Tools\alabtross-worker.

.PARAMETER Port
    Port to listen on. Defaults to 8090. Make sure your Tailscale ACL allows
    this port from the Orin's tailnet identity.

.PARAMETER Secret
    Optional shared secret. If set, the worker requires the X-Worker-Secret
    header on every /transcode call. Tailscale already authenticates the
    tunnel, so this is belt-and-suspenders — leave empty unless paranoid.

.PARAMETER NvencPreset
    NVENC preset, p1 (fastest) .. p7 (best quality). Default p6.

.EXAMPLE
    .\install.ps1
    .\install.ps1 -Port 8090 -NvencPreset p6
#>
param(
    [string]$InstallDir = 'C:\Tools\alabtross-worker',
    [int]$Port = 8090,
    [string]$Secret = '',
    [string]$NvencPreset = 'p6',
    [string]$NvencCq = '21',
    [int]$MaxWidth = 1920
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "    $msg" -ForegroundColor Red }

function Test-Command($cmd) {
    $null = Get-Command $cmd -ErrorAction SilentlyContinue
    return $?
}

# ─── 1. NVIDIA GPU check ───────────────────────────────────────────────
Write-Step 'Checking for NVIDIA GPU and driver'
if (-not (Test-Command 'nvidia-smi')) {
    Write-Err 'nvidia-smi not found in PATH. This worker requires an NVIDIA GPU and driver.'
    Write-Err 'Install the latest NVIDIA Game Ready or Studio driver from https://www.nvidia.com/Download/index.aspx and re-run.'
    exit 1
}
$gpuLine = (nvidia-smi --query-gpu=name,driver_version --format=csv,noheader) -join ', '
Write-Ok "GPU: $gpuLine"

# ─── 2. Node.js ────────────────────────────────────────────────────────
Write-Step 'Checking for Node.js'
if (-not (Test-Command 'node')) {
    Write-Warn 'Node.js not found. Installing via winget...'
    if (-not (Test-Command 'winget')) {
        Write-Err 'winget not available. Install Node.js LTS manually from https://nodejs.org/ and re-run.'
        exit 1
    }
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    # winget installs into a per-user location that may not be in this shell's
    # PATH yet — pick it up from the registry.
    $env:PATH = [Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('PATH', 'User')
    if (-not (Test-Command 'node')) {
        Write-Err 'Node still not on PATH after install. Open a new PowerShell window and re-run.'
        exit 1
    }
}
$nodeVer = (node --version)
Write-Ok "Node $nodeVer"

# ─── 3. ffmpeg with NVENC ──────────────────────────────────────────────
Write-Step 'Checking for NVENC-enabled ffmpeg'
$needFfmpeg = $true
if (Test-Command 'ffmpeg') {
    $hasNvenc = (ffmpeg -hide_banner -h encoder=h264_nvenc 2>&1 | Out-String) -match 'h264_nvenc'
    if ($hasNvenc) {
        $needFfmpeg = $false
        Write-Ok 'ffmpeg with h264_nvenc already installed'
    } else {
        Write-Warn 'ffmpeg present but lacks h264_nvenc — replacing with NVIDIA-enabled build'
    }
}
if ($needFfmpeg) {
    if (-not (Test-Command 'winget')) {
        Write-Err 'winget not available. Manually install Gyan.dev ffmpeg "full" build and add to PATH.'
        Write-Err 'https://www.gyan.dev/ffmpeg/builds/'
        exit 1
    }
    Write-Warn 'Installing Gyan.dev ffmpeg full build via winget (this is the one with NVENC enabled)...'
    winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements
    $env:PATH = [Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('PATH', 'User')
    if (-not (Test-Command 'ffmpeg')) {
        Write-Err 'ffmpeg still not on PATH after install. Open a new PowerShell window and re-run.'
        exit 1
    }
    $hasNvenc = (ffmpeg -hide_banner -h encoder=h264_nvenc 2>&1 | Out-String) -match 'h264_nvenc'
    if (-not $hasNvenc) {
        Write-Err 'Installed ffmpeg still does not advertise h264_nvenc. Reinstall with the Gyan "full" build.'
        exit 1
    }
}

# ─── 4. Tailscale (info only) ──────────────────────────────────────────
Write-Step 'Checking Tailscale'
if (Test-Command 'tailscale') {
    $tsStatus = (tailscale status 2>&1 | Out-String).Trim()
    if ($tsStatus -match 'Logged out|not running') {
        Write-Warn 'Tailscale installed but not logged in. Run: tailscale up'
    } else {
        $first = ($tsStatus -split "`n")[0]
        Write-Ok "Tailscale up: $first"
    }
} else {
    Write-Warn 'Tailscale CLI not found in PATH. If you use the Tailscale tray app it still works,'
    Write-Warn 'but you should confirm the Orin can reach this PC via its tailnet hostname.'
}

# ─── 5. Install files ──────────────────────────────────────────────────
Write-Step "Installing worker to $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$src = Join-Path $PSScriptRoot 'server.js'
$dst = Join-Path $InstallDir 'server.js'
Copy-Item -Force -Path $src -Destination $dst
Write-Ok "Copied server.js → $dst"

# ─── 6. Firewall rule ──────────────────────────────────────────────────
Write-Step "Opening Windows Firewall for port $Port"
$ruleName = 'Albatross GPU Worker'
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Any | Out-Null
Write-Ok "Inbound TCP $Port allowed"

# ─── 7. Scheduled Task ─────────────────────────────────────────────────
Write-Step 'Registering Scheduled Task to run worker at boot'
$taskName = 'AlabtrossGPUWorker'
$nodePath = (Get-Command node).Source

$envBlock = @(
    "WORKER_PORT=$Port",
    "NVENC_PRESET=$NvencPreset",
    "NVENC_CQ=$NvencCq",
    "MAX_WIDTH=$MaxWidth"
)
if ($Secret) { $envBlock += "WORKER_SECRET=$Secret" }

# We wrap node in a small launcher .cmd that sets env vars and logs to a
# file. Easier than juggling -Argument quoting in the scheduled task XML.
$logDir = Join-Path $InstallDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$launcher = Join-Path $InstallDir 'launch-worker.cmd'
$launcherLines = @('@echo off')
foreach ($kv in $envBlock) { $launcherLines += "set $kv" }
$launcherLines += "cd /d `"$InstallDir`""
$launcherLines += "`"$nodePath`" `"$dst`" >> `"$logDir\worker.log`" 2>&1"
Set-Content -Path $launcher -Value $launcherLines -Encoding ASCII
Write-Ok "Wrote launcher → $launcher"

# Remove existing task if present, then re-create.
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

$action    = New-ScheduledTaskAction -Execute $launcher
$trigger   = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 365)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Write-Ok "Scheduled Task '$taskName' registered (runs at boot as SYSTEM)"

# Start it now too.
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 2
Write-Ok 'Worker started'

# ─── 8. Health check ───────────────────────────────────────────────────
Write-Step "Probing http://localhost:$Port/health"
try {
    $r = Invoke-RestMethod -Uri "http://localhost:$Port/health" -TimeoutSec 5
    Write-Ok "Worker responded: encoder=$($r.encoder) preset=$($r.preset) gpu=$($r.gpu)"
} catch {
    Write-Warn "Health check failed: $_"
    Write-Warn "Check the log: $logDir\worker.log"
}

Write-Host ''
Write-Host '─── Done ───' -ForegroundColor Green
Write-Host "Worker:    http://<this-pc-tailnet-name>:$Port" -ForegroundColor Green
Write-Host "Log:       $logDir\worker.log" -ForegroundColor Green
Write-Host "Stop:      Stop-ScheduledTask -TaskName $taskName" -ForegroundColor Green
Write-Host "Restart:   Stop-ScheduledTask -TaskName $taskName ; Start-ScheduledTask -TaskName $taskName" -ForegroundColor Green
Write-Host ''
Write-Host 'On the Orin, set:' -ForegroundColor Yellow
Write-Host "  WORKER_URL=http://<this-pc-tailnet-name>:$Port" -ForegroundColor Yellow
if ($Secret) {
    Write-Host "  WORKER_SECRET=$Secret" -ForegroundColor Yellow
}
Write-Host 'and restart the alabtross-mobile container/service.' -ForegroundColor Yellow
