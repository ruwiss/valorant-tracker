
# Build Release Script for Valorant Helper
# Usage: ./scripts/build_release.ps1

$ErrorActionPreference = "Stop"

# WinForms needs STA. pwsh starts MTA, so hand off before any other work.
if ([System.Threading.Thread]::CurrentThread.ApartmentState -ne "STA") {
    $hostExe = (Get-Process -Id $PID).Path
    & $hostExe -STA -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath
    exit $LASTEXITCODE
}

function Escape-ChangelogString([string]$Value) {
    if ([string]::IsNullOrEmpty($Value)) { return "" }
    return $Value.Replace('\', '\\').Replace('"', '\"').Replace("`r`n", '\n').Replace("`n", '\n').Replace("`r", '\n')
}

function Read-ReleaseChangelog {
    param([string]$Version, [string]$NotesFile)

    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    $existingTr = ""
    $existingEn = ""
    if (Test-Path -LiteralPath $NotesFile) {
        try {
            $existing = Get-Content -LiteralPath $NotesFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $existingTr = [string]$existing.tr
            $existingEn = [string]$existing.en
        } catch {
            Write-Host "Could not read previous changelog notes. Starting blank." -ForegroundColor Yellow
        }
    }

    $form = New-Object System.Windows.Forms.Form
    $form.Text = "Yenilikler $Version"
    $form.ClientSize = New-Object System.Drawing.Size(460, 400)
    $form.StartPosition = "CenterScreen"
    $form.FormBorderStyle = "FixedDialog"
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $form.TopMost = $true
    $form.Font = New-Object System.Drawing.Font("Segoe UI", 9)

    $labelTr = New-Object System.Windows.Forms.Label
    $labelTr.Text = "Türkçe"
    $labelTr.Location = New-Object System.Drawing.Point(12, 10)
    $labelTr.AutoSize = $true

    $boxTr = New-Object System.Windows.Forms.TextBox
    $boxTr.Multiline = $true
    $boxTr.ScrollBars = "Vertical"
    $boxTr.AcceptsReturn = $true
    $boxTr.Location = New-Object System.Drawing.Point(12, 30)
    $boxTr.Size = New-Object System.Drawing.Size(436, 120)
    $boxTr.Text = $existingTr

    $labelEn = New-Object System.Windows.Forms.Label
    $labelEn.Text = "English"
    $labelEn.Location = New-Object System.Drawing.Point(12, 158)
    $labelEn.AutoSize = $true

    $boxEn = New-Object System.Windows.Forms.TextBox
    $boxEn.Multiline = $true
    $boxEn.ScrollBars = "Vertical"
    $boxEn.AcceptsReturn = $true
    $boxEn.Location = New-Object System.Drawing.Point(12, 178)
    $boxEn.Size = New-Object System.Drawing.Size(436, 120)
    $boxEn.Text = $existingEn

    $hint = New-Object System.Windows.Forms.Label
    $hint.Text = "Satır satır yaz. Boş bırakırsan kart çıkmaz."
    $hint.Location = New-Object System.Drawing.Point(12, 308)
    $hint.Size = New-Object System.Drawing.Size(436, 32)

    $ok = New-Object System.Windows.Forms.Button
    $ok.Text = "Tamam"
    $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $ok.Location = New-Object System.Drawing.Point(268, 352)
    $ok.Size = New-Object System.Drawing.Size(84, 28)

    $cancel = New-Object System.Windows.Forms.Button
    $cancel.Text = "İptal"
    $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $cancel.Location = New-Object System.Drawing.Point(360, 352)
    $cancel.Size = New-Object System.Drawing.Size(84, 28)

    $form.CancelButton = $cancel
    $form.Controls.AddRange(@($labelTr, $boxTr, $labelEn, $boxEn, $hint, $ok, $cancel))

    $dialogResult = $form.ShowDialog()
    $tr = $boxTr.Text
    $en = $boxEn.Text
    $form.Dispose()

    if ($dialogResult -ne [System.Windows.Forms.DialogResult]::OK) {
        return $null
    }

    return @{
        tr = ($tr -replace "`r`n", "`n" -replace "`r", "`n").Trim()
        en = ($en -replace "`r`n", "`n" -replace "`r", "`n").Trim()
    }
}

function Write-ReleaseChangelog {
    param($Notes, [string]$ProjectRoot)

    $jsonPath = Join-Path $ProjectRoot "src\changelog.notes.json"
    $tsPath = Join-Path $ProjectRoot "src\changelog.ts"
    $utf8 = New-Object System.Text.UTF8Encoding $false

    $json = (@{ tr = $Notes.tr; en = $Notes.en } | ConvertTo-Json -Compress)
    [System.IO.File]::WriteAllText($jsonPath, $json, $utf8)

    $raw = [System.IO.File]::ReadAllText($tsPath)
    $tr = Escape-ChangelogString $Notes.tr
    $en = Escape-ChangelogString $Notes.en
    $block = "export const changelogNotes: Record<Locale, string> = {`n  tr: `"$tr`",`n  en: `"$en`",`n};"
    # Regex replacement treats $ as a backreference, so double it.
    $replacement = ("// changelog-notes:start`n$block`n// changelog-notes:end").Replace('$', '$$')
    $updated = [regex]::Replace(
        $raw,
        '(?s)// changelog-notes:start\r?\n.*?// changelog-notes:end',
        $replacement
    )
    if ($updated -eq $raw) {
        throw "Could not find changelog note markers in src/changelog.ts"
    }
    [System.IO.File]::WriteAllText($tsPath, $updated, $utf8)
}

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

# 2. Changelog, before anything destructive. Cancel aborts the build.
$changelog = Read-ReleaseChangelog -Version $version -NotesFile (Join-Path $ProjectRoot "src\changelog.notes.json")
if ($null -eq $changelog) {
    Write-Host "Build cancelled." -ForegroundColor Yellow
    exit 1
}
Write-ReleaseChangelog -Notes $changelog -ProjectRoot $ProjectRoot
Write-Host "Changelog saved." -ForegroundColor Green

# 3. Check Signing Keys
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

# 3. Wipe src-tauri/target before release so debug/incremental/old
#    bundles cannot accumulate (was 50GB+ after a project move).
$TargetDir = Join-Path $ProjectRoot "src-tauri\target"
if (Test-Path -LiteralPath $TargetDir) {
    Write-Host "Removing src-tauri/target before build..." -ForegroundColor Yellow
    cmd /c "rmdir /s /q `"$TargetDir`"" | Out-Null
    if (Test-Path -LiteralPath $TargetDir) {
        Remove-Item -LiteralPath $TargetDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $TargetDir) {
        Write-Error "Could not remove src-tauri/target. Close the app if it is running and retry."
        exit 1
    }
    Write-Host "src-tauri/target removed." -ForegroundColor Green
}

$ReleaseOutputDir = Join-Path $ProjectRoot $RELEASE_DIR
if (Test-Path -LiteralPath $ReleaseOutputDir) {
    Write-Host "Removing $RELEASE_DIR before build..." -ForegroundColor Yellow
    Remove-Item -LiteralPath $ReleaseOutputDir -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $ReleaseOutputDir) {
        cmd /c "rmdir /s /q `"$ReleaseOutputDir`"" | Out-Null
    }
    if (Test-Path -LiteralPath $ReleaseOutputDir) {
        Write-Error "Could not remove $RELEASE_DIR. Close anything using those files and retry."
        exit 1
    }
    Write-Host "$RELEASE_DIR removed." -ForegroundColor Green
}

# bindgen (boring-sys) needs libclang.dll on a cold cache
if (-not $env:LIBCLANG_PATH) {
    $clangCandidates = @(
        "C:\Program Files\LLVM\bin",
        "C:\Program Files (x86)\LLVM\bin",
        "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\Llvm\x64\bin",
        "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\Llvm\x64\bin",
        "C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Tools\Llvm\x64\bin",
        "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Tools\Llvm\x64\bin"
    )
    foreach ($candidate in $clangCandidates) {
        if (Test-Path -LiteralPath (Join-Path $candidate "libclang.dll")) {
            $env:LIBCLANG_PATH = $candidate
            Write-Host "LIBCLANG_PATH set to: $candidate" -ForegroundColor Gray
            break
        }
    }
}

# 4. Build App
Write-Host "Building Tauri App..." -ForegroundColor Cyan
pnpm tauri build

if ($LASTEXITCODE -ne 0) {
    Write-Error "Build failed!"
    exit 1
}

# 5. Prepare Release Files
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

# 6. Generate latest.json
Write-Host "Generating latest.json..." -ForegroundColor Cyan

# Update URL for GitHub Releases
# Using 'latest' tag allows consistent URL structure without hardcoding version number in URL
$updateUrl = "https://github.com/$GITHUB_REPO/releases/latest/download/$safeSetupName"
$pubDate = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssZ")
$notes = "Update for version $version"
if ($changelog.tr -or $changelog.en) {
    $noteParts = @($changelog.tr, $changelog.en) | Where-Object { $_ }
    $notes = $noteParts -join "`n`n"
}

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
