
# Build Release Script for Valorant Helper
# Usage: ./scripts/build_release.ps1

$ErrorActionPreference = "Stop"

# Set working directory to project root
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot
Write-Host "Working Directory set to: $pwd" -ForegroundColor Gray
$TAURI_CONF_PATH = "src-tauri/tauri.conf.json"
$OUTPUT_DIR = "src-tauri/target/release/bundle/nsis"
$RELEASE_DIR = "release_output"
$GITHUB_REPO = "ruwiss/valorant-tracker" # Release Repo

# 1. Read Version
Write-Host "Reading version from tauri.conf.json..." -ForegroundColor Cyan
$tauriConf = Get-Content $TAURI_CONF_PATH | ConvertFrom-Json
$version = $tauriConf.version
Write-Host "Current Version: $version" -ForegroundColor Green

# 2. Check Signing Keys
$DefaultKeyPath = Join-Path $ProjectRoot "valorant-tracker.key"
$DefaultPassword = "omergundogar"

if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    if (Test-Path $DefaultKeyPath) {
        Write-Host "Using default private key: valorant-tracker.key" -ForegroundColor Gray
        $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $DefaultKeyPath -Raw
    } else {
        Write-Warning "TAURI_SIGNING_PRIVATE_KEY not found and default key file missing."
        $env:TAURI_SIGNING_PRIVATE_KEY = Read-Host "Paste your Private Key content here"
    }
}

if (-not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -and -not $env:TAURI_SIGNING_KEY_PASSWORD) {
    Write-Host "Using configuration password." -ForegroundColor Gray
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $DefaultPassword
    $env:TAURI_SIGNING_KEY_PASSWORD = $DefaultPassword
}

# 3. Build App
Write-Host "Building Tauri App..." -ForegroundColor Cyan
pnpm tauri build

if ($LASTEXITCODE -ne 0) {
    Write-Error "Build failed!"
    exit 1
}

# 4. Prepare Release Files
Write-Host "Preparing Release Files..." -ForegroundColor Cyan
if (-not (Test-Path $RELEASE_DIR)) { mkdir $RELEASE_DIR | Out-Null }

# Find generated files matching current version
Write-Host "Searching for artifacts for version $version..." -ForegroundColor Gray
$setupFile = Get-ChildItem "$OUTPUT_DIR/*.exe" | Where-Object { $_.Name -like "*$version*" -and $_.Name -notlike "*.sig" } | Select-Object -First 1
$sigFile = Get-ChildItem "$OUTPUT_DIR/*.exe.sig" | Where-Object { $_.Name -like "*$version*" } | Select-Object -First 1

if (-not $setupFile -or -not $sigFile) {
    Write-Error "Could not find setup file or signature file for version $version in $OUTPUT_DIR"
    exit 1
}

$setupName = $setupFile.Name
# Sanitize filename (replace spaces with underscores for safer URLs)
$safeSetupName = $setupName.Replace(" ", "_")
$sigContent = Get-Content $sigFile.FullName -Raw

# Copy to release dir with safe name
Copy-Item $setupFile.FullName -Destination "$RELEASE_DIR/$safeSetupName"
Write-Host "Copied $setupName to $RELEASE_DIR/$safeSetupName"

# 5. Generate latest.json
Write-Host "Generating latest.json..." -ForegroundColor Cyan

# Update URL for GitHub Releases
# Using 'latest' tag allows consistent URL structure without hardcoding version number in URL
$updateUrl = "https://github.com/$GITHUB_REPO/releases/latest/download/$safeSetupName"
$pubDate = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssZ")
$notes = "Update for version $version"

$latestJson = @{
    version = $version
    notes = $notes
    pub_date = $pubDate
    platforms = @{
        "windows-x86_64" = @{
            signature = $sigContent
            url = $updateUrl
        }
    }
}

try {
    Write-Host "Converting data to JSON..." -ForegroundColor Gray
    $jsonContent = ConvertTo-Json -InputObject $latestJson -Depth 10

    $jsonPath = Join-Path $RELEASE_DIR "latest.json"
    $absoluteJsonPath = "$pwd\$jsonPath"
    Write-Host "Writing JSON to $absoluteJsonPath..." -ForegroundColor Gray

    # Use .NET method for reliable UTF-8 writing without BOM
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($absoluteJsonPath, $jsonContent, $utf8NoBom)

    if (Test-Path $absoluteJsonPath) {
        Write-Host "Successfully created latest.json in $RELEASE_DIR" -ForegroundColor Green
    } else {
        throw "File verification failed: $absoluteJsonPath was not found after writing."
    }
} catch {
    Write-Error "CRITICAL ERROR: Failed to generate latest.json"
    Write-Error $_.Exception.ToString()
    exit 1
}

Write-Host "Build & Release preparation complete!" -ForegroundColor Magenta
Write-Host "Files are ready in: $RELEASE_DIR"
