# ============================================================
#  Lennart Terminal - portable zip builder
#  Stages the app with ONLY runtime dependencies, trims
#  Electron down to what is actually loaded, and produces
#  dist/LennartTerminal-portable-<version>.zip
#
#  Usage:  pwsh ./scripts/build-portable.ps1 [-OutDir dist]
#  Requires: npm install / npm ci to have been run first.
# ============================================================
param(
  [string]$OutDir = "dist",
  [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

if (-not $Version) {
  $pkg = Get-Content (Join-Path $Root "package.json") -Raw | ConvertFrom-Json
  $Version = $pkg.version
}

$StageRoot = Join-Path $OutDir "stage"
$Stage = Join-Path $StageRoot "LennartTerminal"
$Zip = Join-Path $OutDir ("LennartTerminal-portable-" + $Version + ".zip")

Write-Host "Building Lennart Terminal portable v$Version ..."

# --- clean previous output -----------------------------------
if (Test-Path $StageRoot) { Remove-Item $StageRoot -Recurse -Force }
if (Test-Path $Zip)       { Remove-Item $Zip -Force }
New-Item -ItemType Directory -Force -Path $Stage | Out-Null

function Copy-IfExists([string]$src, [string]$dst) {
  if (Test-Path $src) { Copy-Item $src $dst -Recurse -Force }
  else { Write-Warning "missing (skipped): $src" }
}

# --- app files ------------------------------------------------
foreach ($f in @("package.json", "package-lock.json", "README.md", "LICENSE", "start-lennart-terminal.cmd")) {
  Copy-IfExists (Join-Path $Root $f) (Join-Path $Stage $f)
}
foreach ($d in @("src", "test")) {
  Copy-IfExists (Join-Path $Root $d) (Join-Path $Stage $d)
}

# --- runtime dependencies only (no dev tooling) ---------------
$nm = Join-Path $Stage "node_modules"
New-Item -ItemType Directory -Force -Path $nm | Out-Null
Copy-IfExists (Join-Path $Root "node_modules\electron")       $nm
Copy-IfExists (Join-Path $Root "node_modules\node-pty")       $nm
Copy-IfExists (Join-Path $Root "node_modules\node-addon-api") $nm

$xtermSrc = Join-Path $Root "node_modules\@xterm"
$xtermDst = Join-Path $nm "@xterm"
if (Test-Path $xtermSrc) {
  New-Item -ItemType Directory -Force -Path $xtermDst | Out-Null
  Get-ChildItem $xtermSrc -Directory | ForEach-Object {
    Copy-Item $_.FullName $xtermDst -Recurse -Force
  }
}

# --- trim Electron: languages + huge legal file ---------------
# NOTE: resources/default_app.asar must STAY - electron.exe uses it as the
# bootstrap that loads a directory-based app (i.e. this portable layout).
$keepLocales = @("en-US.pak", "en-GB.pak", "da.pak")
$locales = Join-Path $Stage "node_modules\electron\dist\locales"
if (Test-Path $locales) {
  Get-ChildItem $locales -File |
    Where-Object { $keepLocales -notcontains $_.Name } |
    Remove-Item -Force
}
$chromLic = Join-Path $Stage "node_modules\electron\dist\LICENSES.chromium.html"
if (Test-Path $chromLic) { Remove-Item $chromLic -Force }

# --- zip ------------------------------------------------------
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Compress-Archive -Path (Join-Path $StageRoot "LennartTerminal") -DestinationPath $Zip -CompressionLevel Optimal

$size = [math]::Round((Get-Item $Zip).Length / 1MB, 1)
Write-Host ""
Write-Host "Done: $Zip ($size MB)"
