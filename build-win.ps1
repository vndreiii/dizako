# Dizako Windows Build Script
# Compiles WASM, builds Vite frontend, and produces BOTH:
#   1. Standalone / Portable self-contained .exe (No terminal window)
#   2. NSIS Installer .exe

$ErrorActionPreference = "Stop"

# Ensure environment PATH includes common Rust and Node paths in Windows
$PathsToAdd = @(
    "$env:USERPROFILE\.cargo\bin",
    "C:\Users\Luciel\node-dist",
    "$env:APPDATA\npm"
)
foreach ($P in $PathsToAdd) {
    if ((Test-Path $P) -and ($env:PATH -notlike "*$P*")) {
        $env:PATH = "$P;$env:PATH"
    }
}

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "==     Dizako Windows Build Engine      ==" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# 1. Dependency Validation
Write-Host "`n[1/4] Checking build dependencies..." -ForegroundColor Yellow

$MissingDeps = @()
if (-not (Get-Command "cargo" -ErrorAction SilentlyContinue)) { $MissingDeps += "cargo" }
if (-not (Get-Command "wasm-pack" -ErrorAction SilentlyContinue)) { $MissingDeps += "wasm-pack" }
if (-not (Get-Command "pnpm" -ErrorAction SilentlyContinue)) { $MissingDeps += "pnpm" }

if ($MissingDeps.Count -gt 0) {
    Write-Host "Error: Missing required tools: $($MissingDeps -join ', ')" -ForegroundColor Red
    exit 1
}

Write-Host "  -> All build tools verified (cargo, wasm-pack, pnpm)." -ForegroundColor Green

# 2. Compile WebAssembly Engine
Write-Host "`n[2/4] Compiling WebAssembly engine..." -ForegroundColor Yellow
wasm-pack build dither-wasm --release --target web --out-dir pkg
if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne $null) {
    throw "WASM compilation failed."
}
Write-Host "  -> WASM package compiled successfully." -ForegroundColor Green

# 3. Node Dependencies
Write-Host "`n[3/4] Installing Node dependencies..." -ForegroundColor Yellow
pnpm install
if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne $null) {
    throw "pnpm install failed."
}
Write-Host "  -> Node dependencies ready." -ForegroundColor Green

# 4. Build Tauri App & Bundles
Write-Host "`n[4/4] Building Tauri application & Windows bundles..." -ForegroundColor Yellow
pnpm tauri build
if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne $null) {
    throw "Tauri build failed."
}

# 5. Deploy Output Artifacts
$OutputDir = Join-Path $PSScriptRoot "release-win"
if (Test-Path $OutputDir) {
    Remove-Item -Path $OutputDir -Recurse -Force
}
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

$StandaloneExe = Join-Path $PSScriptRoot "src-tauri\target\release\dizako.exe"
$NsisDir = Join-Path $PSScriptRoot "src-tauri\target\release\bundle\nsis"

if (-not (Test-Path $StandaloneExe)) {
    throw "Standalone executable was not found at $StandaloneExe"
}

# Copy Standalone Executable
$DestStandalone = Join-Path $OutputDir "dizako.exe"
Copy-Item -Path $StandaloneExe -Destination $DestStandalone -Force

# Copy Installer Executable
$InstallerFiles = Get-ChildItem -Path $NsisDir -Filter "*.exe" -ErrorAction SilentlyContinue
if ($InstallerFiles.Count -eq 0) {
    throw "Installer executable (.exe) was not found in $NsisDir"
}

foreach ($Installer in $InstallerFiles) {
    Copy-Item -Path $Installer.FullName -Destination $OutputDir -Force
}

# Final Summary
Write-Host "`n==========================================" -ForegroundColor Green
Write-Host "==            BUILD SUCCESSFUL          ==" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Write-Host "`nOutput binaries deployed to: [release-win/]" -ForegroundColor Cyan

Get-ChildItem -Path $OutputDir | ForEach-Object {
    $SizeMB = [math]::Round($_.Length / 1MB, 2)
    Write-Host ("  - {0,-35} ({1} MB)" -f $_.Name, $SizeMB) -ForegroundColor Green
}

Write-Host "`n1. Standalone Executable: Direct GUI launch (no console/terminal window)." -ForegroundColor Gray
Write-Host "2. Installer Executable: Setup wizard for Windows installation.`n" -ForegroundColor Gray
