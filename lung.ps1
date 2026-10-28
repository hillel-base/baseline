# Lung tumour measurement tool (research use only): .\lung.ps1 setup | start | fetch --all   (Windows PowerShell 5+)
# setup installs what is missing, then starts. Each phase is skipped when already done. Log: runs\setup-<UTC>.jsonl
# fetch --all adds the other 20 practice patients (28 in all).
param([Parameter(Position = 0)][string]$Command = "", [Parameter(Position = 1)][string]$Option = "")
$ErrorActionPreference = "Stop"

$Root = $PSScriptRoot
if (-not $env:LUNG_DATA_DIR) { $env:LUNG_DATA_DIR = Join-Path $Root "data\rider" }
$Runs = if ($env:LUNG_RUNS_DIR) { $env:LUNG_RUNS_DIR } else { Join-Path $Root "runs" }
$Weights = if ($env:NNINTERACTIVE_MODEL_DIR) { $env:NNINTERACTIVE_MODEL_DIR } else { Join-Path $HOME ".nninteractive" }
$Log = if ($env:LUNG_SETUP_LOG) { $env:LUNG_SETUP_LOG } else { Join-Path $Runs ("setup-{0}.jsonl" -f (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ", [Globalization.CultureInfo]::InvariantCulture)) }
$Port = if ($env:LUNG_PORT) { $env:LUNG_PORT } else { 8000 }
$env:Path = "$HOME\.local\bin;$env:Path"  # where Astral's installer puts uv

function Fmt($d) { $d.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture) }
function Iso { Fmt (Get-Date) }
function Bytes($p) { if (Test-Path $p) { [long](Get-ChildItem $p -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum } else { 0 } }
$Utf8 = New-Object Text.UTF8Encoding $false  # no BOM: PowerShell 5 Add-Content -Encoding UTF8 writes one and breaks json.loads
function Append($o) { [IO.File]::AppendAllText($Log, (($o | ConvertTo-Json -Compress) + "`n"), $Utf8) }
function Run($exe) {  # run a native command, stop on a non-zero exit
    & $exe @args
    if ($LASTEXITCODE -ne 0) { throw "$exe failed with exit code $LASTEXITCODE" }
}

function Log-Machine {
    $os = Get-CimInstance Win32_OperatingSystem
    $free = 0; try { $free = (Get-PSDrive -Name ((Get-Item $Root).PSDrive.Name)).Free } catch { }
    Append ([ordered]@{ type = "machine"; cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name.Trim()
        machine = $env:PROCESSOR_ARCHITECTURE; memory_gb = [int][math]::Round($os.TotalVisibleMemorySize / 1MB)
        os = $os.Caption + " " + $os.Version; free_disk_gb = [int][math]::Floor($free / 1GB) })
}

function Log-Phase($name, $skipped, $bytes, $t0) {
    $end = Get-Date
    Append ([ordered]@{ type = "phase"; phase = $name; start = (Fmt $t0); end = Iso
        seconds = [int][math]::Round(($end - $t0).TotalSeconds); bytes_downloaded = [long]$bytes; skipped = [bool]$skipped })
}

function Node-Ok {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $false }
    $v = [version]((node -v).TrimStart("v"))
    return ($v.Major -gt 22) -or ($v.Major -eq 22 -and $v.Minor -ge 12)
}

function Api-Up { try { Invoke-WebRequest "http://localhost:$Port/api/scans" -UseBasicParsing -TimeoutSec 3 | Out-Null; $true } catch { $false } }

function Phase-Prerequisites {
    $t0 = Get-Date; $skipped = $true
    if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
        $skipped = $false; Write-Host "Installing uv (Astral's installer)..."
        Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression
        $env:Path = "$HOME\.local\bin;$env:Path"
    }
    $pageBytes = 0
    if (Page-Stale) {
        $skipped = $false
        if (Node-Ok) { Build-Page } else { $pageBytes = Get-Page }
    }
    Log-Phase prerequisites $skipped $pageBytes $t0
}

# The local page carries the version it was built or downloaded for (web\dist\.page-version), so an update to a new
# version builds or downloads it again; a page with no stamp (an install before 0.1.3) counts as old.
function Page-Stale {
    if (-not (Test-Path (Join-Path $Root "web\dist\index.html"))) { return $true }
    $version = Join-Path $Root "VERSION"
    if (-not (Test-Path $version)) { return $false }
    $want = Get-Content $version -Raw
    if ([string]::IsNullOrWhiteSpace($want)) { return $false }
    $stamp = Join-Path $Root "web\dist\.page-version"
    $have = if (Test-Path $stamp) { Get-Content $stamp -Raw } else { $null }
    if ([string]::IsNullOrWhiteSpace($have)) { return $true }  # no stamp, or an empty one: an install before 0.1.3
    return ($have.Trim() -ne $want.Trim())
}
function Stamp-Page {
    $version = Join-Path $Root "VERSION"; $dist = Join-Path $Root "web\dist"
    if ((Test-Path $version) -and (Test-Path $dist)) { Copy-Item $version (Join-Path $dist ".page-version") -Force }
}

# With Node: the page is built here. A page already here (an update) is set aside first, so a failed build (npm down for a
# while) keeps it and the tool still starts; on a first install a failed build stops setup, as before.
function Build-Page {
    $web = Join-Path $Root "web"; $dist = Join-Path $web "dist"; $old = Join-Path $web "dist.old"
    if (Test-Path $old) { Remove-Item $old -Recurse -Force }
    $had = Test-Path (Join-Path $dist "index.html")
    if ($had) { Move-Item $dist $old }  # the same folder: a rename
    $err = $null
    Push-Location $web
    try { Run npm.cmd ci; Run npm.cmd run build } catch { $err = $_.Exception.Message } finally { Pop-Location }  # npm_config_registry, if set, is passed through
    if (-not $err) {
        Stamp-Page
        if (Test-Path $old) { Remove-Item $old -Recurse -Force }
    } elseif ($had) {
        if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
        Move-Item $old $dist
        Write-Host "Could not rebuild the local page ($err); the old one stays. Run the same command again later."
    } else { throw "Could not build the local page: $err" }
}

# Without Node: the built page from the release of this version. A failed download is not fatal: the hosted page still works.
function Get-Page {
    $version = (Get-Content (Join-Path $Root "VERSION") -ErrorAction SilentlyContinue | Select-Object -First 1)
    $url = if ($env:BASELINE_PAGE_URL) { $env:BASELINE_PAGE_URL } else { "https://github.com/hillel-base/baseline/releases/download/v$version/baseline-page.zip" }
    Write-Host "Node 22.12 or newer was not found, so the local page is downloaded instead: $url"
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("baseline-page-" + [guid]::NewGuid())
    try {
        New-Item -ItemType Directory -Force $tmp | Out-Null
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest $url -OutFile (Join-Path $tmp "page.zip") -UseBasicParsing
        Expand-Archive (Join-Path $tmp "page.zip") (Join-Path $tmp "x") -Force
        if (-not (Test-Path (Join-Path $tmp "x\dist\index.html"))) { throw "the file holds no page" }
        $dist = Join-Path $Root "web\dist"; $old = Join-Path $Root "web\dist.old"
        if (Test-Path $old) { Remove-Item $old -Recurse -Force }
        if (Test-Path $dist) { Move-Item $dist $old }  # the old page is set aside, not deleted, until the new one is in place
        try { Copy-Item (Join-Path $tmp "x\dist") $dist -Recurse }  # a copy: TEMP can be on another drive, where Move-Item fails
        catch {
            if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
            if (Test-Path $old) { Move-Item $old $dist }
            throw
        }
        if (Test-Path $old) { Remove-Item $old -Recurse -Force }
        Stamp-Page
        Write-Host "Local page: downloaded."
        return (Get-Item (Join-Path $tmp "page.zip")).Length
    } catch {
        if (Test-Path (Join-Path $Root "web\dist\index.html")) {
            Write-Host "Could not download the new local page ($($_.Exception.Message)), so the old one stays. The hosted page works without it. Run .\lung.ps1 setup again later, or install Node 22.12 or newer from https://nodejs.org (or: winget install OpenJS.NodeJS)."
        } else {
            Write-Host "Could not download the local page ($($_.Exception.Message)), so http://localhost:$Port shows no page. The hosted page works without it. Run .\lung.ps1 setup again later, or install Node 22.12 or newer from https://nodejs.org (or: winget install OpenJS.NodeJS)."
        }
        return 0
    } finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}

function Phase-PythonEngine {
    $t0 = Get-Date; $venv = Join-Path $Root "engine\.venv"
    $skipped = Test-Path (Join-Path $venv "pyvenv.cfg"); $b0 = Bytes $venv
    Run uv sync --directory (Join-Path $Root "engine")  # a no-op when up to date; uv fetches Python 3.11 itself
    Log-Phase python_engine $skipped ((Bytes $venv) - $b0) $t0  # bytes = size added to engine\.venv
}

function Phase-ModelWeights {
    $t0 = Get-Date; $b0 = Bytes $Weights; $m = Join-Path $Weights "models"
    $skipped = (Test-Path $m) -and (Get-ChildItem $m -Force | Select-Object -First 1)
    if (-not $skipped) { Write-Host "Fetching the model weights (about 400 MB)..."; Run uv run --directory (Join-Path $Root "engine") python -m lung_engine.fetch --weights }
    Log-Phase model_weights $skipped ((Bytes $Weights) - $b0) $t0
}

function Phase-Scans {
    $t0 = Get-Date; $b0 = Bytes $env:LUNG_DATA_DIR
    & uv run --directory (Join-Path $Root "engine") python -m lung_engine.fetch --data $env:LUNG_DATA_DIR | Tee-Object -Variable lines | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Fetching the practice scans failed." }
    Log-Phase scans (($lines -join "`n") -match "nothing to download") ((Bytes $env:LUNG_DATA_DIR) - $b0) $t0
}

function Start-Tool {
    New-Item -ItemType Directory -Force $Runs | Out-Null
    if (-not (Test-Path $Log)) { [IO.File]::WriteAllText($Log, "", $Utf8) }
    $t0 = Get-Date; $skipped = $true; $proc = $null
    if (-not (Api-Up)) {
        $skipped = $false
        $proc = Start-Process uv -ArgumentList "run", "uvicorn", "lung_engine.app:create_app", "--factory", "--port", $Port, "--no-access-log" `
            -WorkingDirectory (Join-Path $Root "engine") -NoNewWindow -PassThru
        while (-not (Api-Up)) {
            if ($proc.HasExited) { throw "The engine stopped before it was ready; see the messages above." }
            Start-Sleep -Seconds 1
        }
    }
    Log-Phase engine_start $skipped 0 $t0
    Write-Host "Tool is running at http://localhost:$Port"
    # LUNG_PAGE_URL if set; else the hosted page, which then uses this engine by itself (the local page is http://localhost:$Port).
    $url = if ($env:LUNG_PAGE_URL) { $env:LUNG_PAGE_URL } else { "https://lung-measure.base44.app/?engine=local" }
    $t0 = Get-Date; $open = $env:LUNG_NO_OPEN -ne "1"
    if ($open) { Write-Host "Opening $url"; Start-Process $url } else { Write-Host "The page: $url" }
    Log-Phase page_open (-not $open) 0 $t0
    Write-Host "Setup log: $Log"
    if ($proc) { $proc.WaitForExit() }
}

switch ($Command) {
    "setup" {
        New-Item -ItemType Directory -Force $Runs | Out-Null; [IO.File]::WriteAllText($Log, "", $Utf8)
        Log-Machine; Phase-Prerequisites; Phase-PythonEngine; Phase-ModelWeights; Phase-Scans
        Write-Host "The nodule finder is off on Windows: it uses process calls that only macOS and Linux have. Everything else works."
        Start-Tool
    }
    "start" { Start-Tool }
    "fetch" {
        $all = @(); if ($Option -eq "--all") { $all = @("--all") } elseif ($Option) { Write-Host "Usage: .\lung.ps1 fetch [--all]"; exit 2 }
        Run uv run --directory (Join-Path $Root "engine") python -m lung_engine.fetch --data $env:LUNG_DATA_DIR @all
    }
    default { Write-Host "Usage: .\lung.ps1 setup | start | fetch --all"; exit 2 }
}
