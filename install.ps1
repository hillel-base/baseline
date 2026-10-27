# Baseline installer for Windows (PowerShell 5 or newer). Research use only, not a medical device.
#   irm https://raw.githubusercontent.com/hillel-base/baseline/main/install.ps1 | iex
# Gets the code, runs lung.ps1 setup (uv and Python 3.11, the local page, the packages, the model weights, three practice patients),
# starts the engine on http://localhost:8000 and opens the hosted page, which uses that engine. Safe to run again: it updates the code and
# starts the engine; steps already done are skipped.
#   BASELINE_DIR      the folder (default: %USERPROFILE%\Baseline)
#   BASELINE_NO_OPEN  1: do not open the browser
#   BASELINE_SOURCE   git address of the code (default: this repository on GitHub)
#   BASELINE_ZIP      .zip of the code, used when git is missing (default: the main branch on GitHub)
& {  # a script block, so nothing is left behind in the caller's session
    $ErrorActionPreference = "Stop"
    $Dir = if ($env:BASELINE_DIR) { $env:BASELINE_DIR } else { Join-Path $env:USERPROFILE "Baseline" }
    $Source = if ($env:BASELINE_SOURCE) { $env:BASELINE_SOURCE } else { "https://github.com/hillel-base/baseline" }
    $Zip = if ($env:BASELINE_ZIP) { $env:BASELINE_ZIP } else { "https://github.com/hillel-base/baseline/archive/refs/heads/main.zip" }
    function Say($m) { Write-Host ""; Write-Host "==> $m" }
    function Get-Code {  # the .zip, unpacked over the folder; data, runs and the engine's packages are not in it, so they stay
        $tmp = Join-Path ([IO.Path]::GetTempPath()) ("baseline-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Force $tmp | Out-Null
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest $Zip -OutFile (Join-Path $tmp "code.zip") -UseBasicParsing
            Expand-Archive (Join-Path $tmp "code.zip") (Join-Path $tmp "code") -Force
            $top = Get-ChildItem (Join-Path $tmp "code") -Directory | Select-Object -First 1
            New-Item -ItemType Directory -Force $Dir | Out-Null
            Copy-Item (Join-Path $top.FullName "*") $Dir -Recurse -Force
        } finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }

    Say "Baseline: lung nodule measurement on CT, a research aid. Folder: $Dir"
    if (Test-Path (Join-Path $Dir ".git")) {
        Say "Updating the code (git pull)"
        git -C $Dir pull --ff-only
        if ($LASTEXITCODE -ne 0) { Write-Host "Could not update the code. Going on with the copy you have." }
    } elseif (Test-Path (Join-Path $Dir "lung.ps1")) {
        Say "Updating the code (download)"; Get-Code
    } else {
        Say "Getting the code"
        $cloned = $false
        if (Get-Command git -ErrorAction SilentlyContinue) { git clone --depth 1 $Source $Dir; $cloned = $LASTEXITCODE -eq 0 }
        if (-not $cloned) { Write-Host "git is missing or the clone failed, so the code is downloaded as an archive instead."; Get-Code }
    }

    Say "Installing what is missing, then starting the engine (lung.ps1 setup). The first run downloads about 2 GB; later runs download nothing."
    if ($env:BASELINE_NO_OPEN -eq "1") { $env:LUNG_NO_OPEN = "1" }
    # Bypass for this one script only: PowerShell's default policy refuses to run a .ps1 file.
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Dir "lung.ps1") setup
    if ($LASTEXITCODE -ne 0) { throw "Setup stopped with exit code $LASTEXITCODE. Read the messages above." }
}
