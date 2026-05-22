# PBX Stratos bootstrap (Windows). Ensures Node, then runs setup.mjs.
# No admin rights. Everything lands under .\.tooling\.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$root = (Get-Location).Path
$tooling = Join-Path $root '.tooling'
$nodeVersion = 'v22.11.0'

function Test-HaveNode {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { return $false }
  # Read the full version and split in PowerShell — passing a JS string
  # with embedded double-quotes through Windows PowerShell 5.1 to node.exe
  # mangles the quotes and breaks the eval.
  $ver = (& node -p process.versions.node) 2>$null
  if (-not $ver) { return $false }
  $major = ($ver -split '\.')[0]
  return ([int]$major -ge 18)
}

$nodeBin = $null
$bundledNode = Join-Path $tooling 'node\node.exe'
if (Test-HaveNode) {
  Write-Host "[bootstrap] using existing Node $(& node -v)"
  $nodeBin = (Get-Command node).Source
} elseif (Test-Path $bundledNode) {
  Write-Host '[bootstrap] using bundled Node'
  $nodeBin = $bundledNode
} else {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $url = "https://nodejs.org/dist/$nodeVersion/node-$nodeVersion-win-$arch.zip"
  Write-Host "[bootstrap] downloading Node from $url"
  New-Item -ItemType Directory -Force -Path $tooling | Out-Null
  $zip = Join-Path $tooling 'node.zip'
  try {
    Invoke-WebRequest -Uri $url -OutFile $zip
  } catch {
    Write-Error '[bootstrap] Node download failed — check your internet connection'
    exit 1
  }
  Expand-Archive -Force -LiteralPath $zip -DestinationPath $tooling
  Remove-Item $zip
  $extracted = Get-ChildItem -Path $tooling -Directory -Filter "node-$nodeVersion-*" | Select-Object -First 1
  Rename-Item $extracted.FullName 'node'
  $nodeBin = $bundledNode
  Write-Host "[bootstrap] bundled Node $(& $nodeBin -v)"
}

$env:PATH = "$(Split-Path $nodeBin);$env:PATH"
& $nodeBin (Join-Path $root 'scripts\setup.mjs')
exit $LASTEXITCODE
