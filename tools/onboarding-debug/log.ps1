# noob-loop only -- PowerShell mirror of log.sh.
# Appends one JSON line to runtime/lab/install-session.jsonl.
#
# Usage:
#   pwsh tools/onboarding-debug/log.ps1 -Step step1 -Event install_launched -Message ""

param(
  [string]$Step = "unknown",
  [string]$Event = "unknown",
  [string]$Message = ""
)

$ErrorActionPreference = "Stop"

$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$LogDir = Join-Path $Repo "runtime\lab"
$LogFile = Join-Path $LogDir "install-session.jsonl"

if (-not (Test-Path $LogDir)) {
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
}

$Ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")

# Build object then ConvertTo-Json so quote/backslash escaping is correct.
$obj = [ordered]@{
  ts      = $Ts
  step    = $Step
  event   = $Event
  message = $Message
}
$line = $obj | ConvertTo-Json -Compress

# PS 5.1 writes UTF-8 with BOM by default for Add-Content / Out-File.
# Use .NET StreamWriter in append mode with UTF-8 (no BOM) so the
# parser side doesn't have to special-case BOM stripping.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$writer = New-Object System.IO.StreamWriter($LogFile, $true, $utf8NoBom)
try {
  $writer.WriteLine($line)
} finally {
  $writer.Close()
}

exit 0
