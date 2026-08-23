param (
    [switch]$NoBundle
)

$ErrorActionPreference = "Stop"

Write-Host "== Dizako Windows Build ==" -ForegroundColor Cyan

# Check dependencies
if (-not (Get-Command "wasm-pack" -ErrorAction SilentlyContinue)) {
    Write-Host "Error: wasm-pack is not installed. Run 'cargo install wasm-pack'." -ForegroundColor Red
    exit 1
}
if (-not (Get-Command "pnpm" -ErrorAction SilentlyContinue)) {
    Write-Host "Error: pnpm is not installed. Run 'corepack enable' or install via get.pnpm.io." -ForegroundColor Red
    exit 1
}

Write-Host "`n[1/3] Compiling WebAssembly engine..." -ForegroundColor Yellow
wasm-pack build dither-wasm --release --target web --out-dir pkg
if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne $null) { throw "wasm-pack failed" }

Write-Host "`n[2/3] Installing Node dependencies..." -ForegroundColor Yellow
pnpm install
if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne $null) { throw "pnpm install failed" }

Write-Host "`n[3/3] Building Tauri application..." -ForegroundColor Yellow
if ($NoBundle) {
    pnpm tauri build --no-bundle
} else {
    pnpm tauri build --bundles nsis
}
if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne $null) { throw "tauri build failed" }

Write-Host "`nBuild Complete!" -ForegroundColor Green
if (-not $NoBundle) {
    Write-Host "Output installer is located at: src-tauri\target\release\bundle\nsis\" -ForegroundColor Cyan
} else {
    Write-Host "Raw executable is located at: src-tauri\target\release\dizako.exe" -ForegroundColor Cyan
}
