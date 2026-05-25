# noob-loop only -- PowerShell wrapper around export.py.

$ErrorActionPreference = "Stop"

$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

$Candidates = @(
  (Join-Path $Repo ".venv\Scripts\python.exe"),
  (Join-Path $Repo ".tooling\python\python.exe")
)

$Py = $null
foreach ($c in $Candidates) {
  if (Test-Path $c) { $Py = $c; break }
}
if (-not $Py) {
  $found = Get-Command python -ErrorAction SilentlyContinue
  if ($found) { $Py = $found.Source }
}
if (-not $Py) {
  Write-Error "no python interpreter found"
  exit 1
}

& $Py (Join-Path $Repo "tools\onboarding-debug\export.py") @args
exit $LASTEXITCODE
