# End-to-end check for a rendered installer script on Windows.
# Runs as a standalone -File script under both powershell.exe (5.1) and pwsh:
#   powershell -NoProfile -ExecutionPolicy Bypass -File test/e2e/windows.ps1
#   pwsh -NoProfile -File test/e2e/windows.ps1
# Failing assertions throw, leaving a non-zero process exit code.
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingInvokeExpression', '',
    Justification = 'Exercises the documented irm | iex installation path.')]
param()

$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition }
$repoRoot = [IO.Path]::GetFullPath((Join-Path $scriptDir '..\..'))
$srcPath = Join-Path $repoRoot 'dist\kobe.ps1'

$d = Join-Path $env:TEMP ('sh-e2e-' + [Guid]::NewGuid())
$env:KOBE_NO_MODIFY_PATH = '1'
$env:KOBE_INSTALL_DIR = $d
$receipt = Join-Path $env:LOCALAPPDATA 'qntx\receipts\kobe.json'
$src = Get-Content -Raw $srcPath
$sb = [scriptblock]::Create($src)

# Locked version from -Check, like the Unix job.
$global:LASTEXITCODE = 0
$v = & $sb -Check
if ($LASTEXITCODE -ne 0 -or -not $v) { throw "-Check failed (exit $LASTEXITCODE)" }
$vpat = [regex]::Escape($v)

# irm-style invocation (env-driven).
$global:LASTEXITCODE = 0
Invoke-Expression $src
if ($LASTEXITCODE -ne 0) { throw "iex install failed (exit $LASTEXITCODE)" }
if (-not (Test-Path "$d/kobe.exe")) { throw 'kobe.exe missing after install' }
if (-not ((& "$d/kobe.exe" --version) -match $vpat)) { throw 'installed version mismatch' }
if (-not (Test-Path $receipt)) { throw 'receipt missing' }

# Session survived iex; the idempotent rerun skips work.
$global:LASTEXITCODE = 0
Invoke-Expression $src
if ($LASTEXITCODE -ne 0) { throw 'idempotent rerun failed' }

# scriptblock form with parameters: --force then --version pin.
$global:LASTEXITCODE = 0
& $sb -InstallDir $d -Force
if ($LASTEXITCODE -ne 0) { throw '-Force reinstall failed' }
$global:LASTEXITCODE = 0
& $sb -InstallDir $d -Version 5.0.0
if ($LASTEXITCODE -ne 0) { throw '-Version pin failed' }
if (-not ((& "$d/kobe.exe" --version) -match '5\.0\.0')) { throw 'pinned version mismatch' }
$global:LASTEXITCODE = 0
$ck = & $sb -Check
if ($LASTEXITCODE -ne 0 -or $ck -ne $v) { throw "-Check returned $ck, expected $v" }

# Tamper (scriptblock form): corrupt every embedded hash.
$zeros = '0' * 64
$bad = $src -replace "'[0-9a-f]{64}'", "'$zeros'"
$binHash = (Get-FileHash "$d/kobe.exe").Hash
$rcptHash = (Get-FileHash $receipt).Hash
$global:LASTEXITCODE = 0
& ([scriptblock]::Create($bad)) -InstallDir $d -Force
if ($LASTEXITCODE -eq 0) { throw 'tampered scriptblock install succeeded' }
# Tamper (irm form): must also fail and the session must stay alive.
$global:LASTEXITCODE = 0
Invoke-Expression $bad
if ($LASTEXITCODE -eq 0) { throw 'tampered iex install succeeded' }
$alive = 'session-alive'
if ((Get-FileHash "$d/kobe.exe").Hash -ne $binHash) { throw 'binary changed by tampered run' }
if ((Get-FileHash $receipt).Hash -ne $rcptHash) { throw 'receipt changed by tampered run' }
if ($alive -ne 'session-alive') { throw 'session died after tampered run' }

$global:LASTEXITCODE = 0
& $sb -InstallDir $d -Uninstall
if (Test-Path "$d/kobe.exe") { throw 'binary left after uninstall' }
if (Test-Path $receipt) { throw 'receipt left after uninstall' }

Write-Output "e2e ok: kobe $v"
exit 0
