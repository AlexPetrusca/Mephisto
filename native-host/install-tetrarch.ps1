<#
    Enable four-player chess (Tetrarch) in Mephisto on Windows.

    Chrome finds native-messaging hosts through the REGISTRY on Windows, not through a directory of
    manifests the way macOS and Linux do -- which is the whole reason this exists alongside the shell
    installer rather than being a flag on it.

        powershell -ExecutionPolicy Bypass -File install-tetrarch.ps1 -ExtId <EXTENSION_ID> [-Tetrarch C:\path\to\Tetrarch]

    -ExtId    : your Mephisto extension id from chrome://extensions (Developer mode on). It is derived
                from the extension FOLDER PATH, so reloading does not change it (measured: the same
                folder loaded into two fresh profiles gets the same id). Re-run this only if you move
                or re-extract the extension somewhere else.
    -Tetrarch : the Tetrarch checkout. Looked for beside this repo's parent folder if omitted.

    Build the engine core first (MSYS2 / mingw-w64):  cd Tetrarch; ./setup.sh
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ExtId,
    [string]$Tetrarch = ''
)

$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $MyInvocation.MyCommand.Path

# --- locate the engine ---------------------------------------------------------------------------
if (-not $Tetrarch) { $Tetrarch = Join-Path (Split-Path -Parent (Split-Path -Parent $src)) 'Tetrarch' }
$Tetrarch = [System.IO.Path]::GetFullPath($Tetrarch)

if (-not (Test-Path (Join-Path $Tetrarch 'uci.py'))) {
    Write-Error "No uci.py in $Tetrarch -- pass -Tetrarch C:\path\to\Tetrarch"
}
# The DLL is the part people miss: without it core.py raises on import and the panel just says the
# engine is unavailable, with nothing to indicate the build step was skipped.
$dll = Join-Path $Tetrarch 'build\tetrarch.dll'
if (-not (Test-Path $dll)) {
    Write-Error @"
No build\tetrarch.dll in $Tetrarch.

The C core has to be built for Windows before any of this works. Under MSYS2 (mingw-w64 shell):
    cd '$Tetrarch'
    ./setup.sh
"@
}

# --- a python that can run the host --------------------------------------------------------------
$py = $null
foreach ($c in @('py', 'python')) {
    $found = Get-Command $c -ErrorAction SilentlyContinue
    if ($found) { $py = $found.Source; break }
}
if (-not $py) { Write-Error 'No Python found on PATH -- install Python 3 from python.org (tick "Add to PATH").' }

# --- deploy --------------------------------------------------------------------------------------
# Out of the repo and into the user profile, for the same reason as the Unix installer: a
# browser-spawned host should not depend on wherever the source tree happens to live.
$runtime = Join-Path $env:LOCALAPPDATA 'Mephisto'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null

Copy-Item (Join-Path $src 'tetrarch-host.py')  (Join-Path $runtime 'tetrarch-host.py')  -Force
Copy-Item (Join-Path $src 'tetrarch-host.bat') (Join-Path $runtime 'tetrarch-host.bat') -Force
Set-Content -Path (Join-Path $runtime 'tetrarch-path') -Value $Tetrarch -Encoding UTF8

$bat = Join-Path $runtime 'tetrarch-host.bat'
$manifestPath = Join-Path $runtime 'com.tetrarch.host.json'
# Built with ConvertTo-Json so the backslashes in the path are escaped correctly -- hand-written JSON
# with a Windows path in it is invalid far more often than it looks.
@{
    name           = 'com.tetrarch.host'
    description    = 'Tetrarch four-player chess engine bridge for the Mephisto extension (native messaging)'
    path           = $bat
    type           = 'stdio'
    allowed_origins = @("chrome-extension://$ExtId/")
} | ConvertTo-Json -Depth 4 | Set-Content -Path $manifestPath -Encoding UTF8

# --- register ------------------------------------------------------------------------------------
# HKCU, so no administrator rights are needed. The key is created whether or not the browser is
# installed; a key for a browser you do not have is inert.
$roots = @(
    'HKCU:\Software\Google\Chrome',
    'HKCU:\Software\Chromium',
    'HKCU:\Software\Microsoft\Edge',
    'HKCU:\Software\BraveSoftware\Brave-Browser',
    'HKCU:\Software\Vivaldi'
)
foreach ($root in $roots) {
    $key = "$root\NativeMessagingHosts\com.tetrarch.host"
    New-Item -Path $key -Force | Out-Null
    New-ItemProperty -Path $key -Name '(default)' -Value $manifestPath -PropertyType String -Force | Out-Null
    Write-Host "-> registered: $key"
}

Write-Host ''
Write-Host "-> engine:   $Tetrarch"
Write-Host "-> host:     $bat"
Write-Host "-> manifest: $manifestPath"
Write-Host ''
Write-Host 'Done. Reload the extension and the page, then pick "Tetrarch (4-player, Teams)".'
Write-Host 'If you move the extension to a different folder its id changes -- re-run this with the new -ExtId.'
