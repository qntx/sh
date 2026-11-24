# qntx installer for one tool, rendered by src/render.ts and served by
# sh.qntx.org. Windows PowerShell 5.1 compatible.
#
# Usage:
#   irm https://sh.qntx.org/<tool>/ps | iex                                  # install locked latest
#   & ([scriptblock]::Create((irm https://sh.qntx.org/<tool>/ps))) -Version 1.2.3 -NoModifyPath
#
# This script never calls `exit`: failures throw and are caught once at the
# bottom, which writes "error: ..." to stderr and sets $LASTEXITCODE
# (1 failure, 2 bad arguments, 3 unsupported platform; 0 on success,
# including "up to date"). Callers that need a real process exit code must
# add `; exit $LASTEXITCODE` themselves, e.g.:
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command `
#     "& ([scriptblock]::Create((irm https://sh.qntx.org/<tool>/ps))) <params>; exit $LASTEXITCODE"
#
# Public contract (additive-only): parameter names, environment variables,
# exit codes and the receipt format must never change incompatibly.

[CmdletBinding()]
param(
    # -Version binds here via alias; the embedded $Version constant below
    # holds the locked latest version.
    [Alias('Version')]
    [string]$Pin,
    [string]$Variant,
    [string]$InstallDir,
    [switch]$NoModifyPath,
    [switch]$Force,
    [switch]$Check,
    [switch]$Uninstall,
    [switch]$DryRun,
    [switch]$Quiet,
    [switch]$Help
)

# @qntx-constants

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Exit code carried through a thrown exception's TargetObject.
function Get-InstallError([int]$Code, [string]$Message) {
    [Management.Automation.ErrorRecord]::new(
        [Exception]::new($Message), 'qntx', 'NotSpecified', $Code)
}

function Get-PlatformError([string]$Message) {
    $hint = if ($Package) {
        "install from source: cargo install $Package --locked"
    }
    else {
        "build from source: https://github.com/$Repo"
    }
    Get-InstallError 3 "$Message`n$hint"
}

function Write-Status([string]$Verb, [string]$Msg) {
    if ($script:IsQuiet) { return }
    $line = ' {0,11} {1}' -f $Verb, $Msg
    if ($Host.UI.SupportsVirtualTerminal -and -not $env:NO_COLOR) {
        [Console]::Error.WriteLine("$([char]27)[32m$line$([char]27)[0m")
    }
    else {
        [Console]::Error.WriteLine($line)
    }
}

function Show-Usage {
    Write-Output @"
Installer for $Tool ($Repo), locked at $Version.

Usage:
  irm https://sh.qntx.org/$Tool/ps | iex
  & ([scriptblock]::Create((irm https://sh.qntx.org/$Tool/ps))) [parameters]

Parameters:
  -Version <x.y.z>    Install a specific version (default: $Version)
  -Variant <name>     Install a build variant$(if ($Variants.Count -gt 0) { " (available: $($Variants -join ' '))" } else { ' (none)' })
  -InstallDir <dir>   Install directory (default: `$env:USERPROFILE\.local\bin)
  -NoModifyPath       Do not add the install dir to user PATH
  -Force              Reinstall even when up to date
  -Check              Print the target version and exit
  -Uninstall          Remove the binary, receipt and PATH entry
  -DryRun             Print what would happen
  -Quiet              Print only errors
  -Help               Show this text

Environment:
  ${EnvPrefix}_VERSION         Same as -Version
  ${EnvPrefix}_INSTALL_DIR     Same as -InstallDir
  ${EnvPrefix}_NO_MODIFY_PATH  1 = same as -NoModifyPath
  ${EnvPrefix}_VARIANT         Same as -Variant
  NO_COLOR                     Disable colored output
"@
}

function Resolve-InstallDir([string]$Dir) {
    # A user-supplied dir that fails validation is bad arguments (exit 2);
    # a default-derived dir failing them is an environment failure (1).
    $code = if ($Dir) { 2 } else { 1 }
    if (-not $Dir) { $Dir = Join-Path $env:USERPROFILE '.local\bin' }
    if (-not [IO.Path]::IsPathRooted($Dir)) {
        throw (Get-InstallError $code "install dir must be an absolute path: $Dir")
    }
    if ($Dir -match '\.\.' -or $Dir -match '[\x00-\x1F]') {
        throw (Get-InstallError $code "unsafe install dir: $Dir")
    }
    $Dir
}

function Get-Target {
    $arch = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture
    switch ($arch) {
        'X64' { $t = 'x86_64-pc-windows-msvc' }
        'Arm64' { $t = 'aarch64-pc-windows-msvc' }
        default { throw (Get-PlatformError "unsupported architecture: $arch") }
    }
    if (-not $script:Pinned) {
        $sumKey = if ($Variant) { "$Variant/$t" } else { $t }
        if (-not $Sha256.Contains($sumKey)) {
            $what = if ($Variant) { "$Variant binary" } else { 'binary' }
            throw (Get-PlatformError "$Tool has no prebuilt $what for $t")
        }
    }
    $t
}

function Read-Receipt {
    if (-not (Test-Path -LiteralPath $script:Receipt -PathType Leaf)) { return $null }
    try {
        Get-Content -LiteralPath $script:Receipt -Raw | ConvertFrom-Json
    }
    catch {
        $null
    }
}

function Write-Receipt([string]$Dir, [string]$Ver) {
    New-Item -ItemType Directory -Force -Path $script:Receipts | Out-Null
    # "variant" is written only for variant installs; default receipts are
    # byte-identical to the schema that predates variants.
    $fields = [ordered]@{
        schema = 1
        tool = $Tool
        version = $Ver
    }
    if ($Variant) { $fields['variant'] = $Variant }
    $fields['install_dir'] = $Dir
    $json = $fields | ConvertTo-Json -Compress
    $tmp = Join-Path $script:Receipts ".$Tool.tmp.$PID"
    [IO.File]::WriteAllText($tmp, $json + "`n")
    Move-Item -LiteralPath $tmp -Destination $script:Receipt -Force
}

function Send-SettingChange {
    if (-not ('Win32.NativeMethods' -as [type])) {
        Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
    }
    $r = [UIntPtr]::Zero
    [void][Win32.NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 0x2, 5000, [ref]$r)
}

function Edit-UserPath([string]$Dir, [switch]$Remove) {
    $reg = 'registry::HKEY_CURRENT_USER\Environment'
    $cur = @((Get-Item -LiteralPath $reg).GetValue('Path', '', 'DoNotExpandEnvironmentNames') -split ';' | Where-Object { $_ })
    if ($Remove) {
        if ($cur -notcontains $Dir) { return }
        $new = @($cur | Where-Object { $_ -ne $Dir })
        $verb = 'Removed'; $prep = 'from'
    }
    else {
        if ($cur -contains $Dir) { return }
        $new = $cur + @($Dir)
        $verb = 'Added'; $prep = 'to'
    }
    Set-ItemProperty -LiteralPath $reg -Name Path -Type ExpandString -Value ($new -join ';')
    Send-SettingChange
    Write-Status $verb "$Dir $prep user PATH"
}

function Install-Tool {
    param([string]$Ver, [string]$Dir, [bool]$Pinned, [bool]$DoForce, [bool]$DoDry)

    if (-not $DoForce) {
        $r = Read-Receipt
        if ($r -and $r.version -eq $Ver -and $r.install_dir -eq $Dir `
                -and ([string]$r.variant) -eq ([string]$Variant) `
                -and (Test-Path -LiteralPath (Join-Path $Dir "$Tool.exe") -PathType Leaf)) {
            Write-Status 'Skipping' "$Tool $Ver is up to date"
            return
        }
    }

    $t = Get-Target
    $vsuffix = if ($Variant) { "-$Variant" } else { '' }
    $asset = "$Tool-$Ver$vsuffix-$t.zip"
    $base = "https://github.com/$Repo/releases/download/v$Ver"

    if ($DoDry) {
        Write-Status 'Downloading' "$base/$asset"
        Write-Status 'Installing' "$(Join-Path $Dir "$Tool.exe")"
        return
    }

    $exePath = Join-Path $Dir "$Tool.exe"
    $oldPath = Join-Path $Dir "$Tool.old.exe"
    # Stale rename left by a previous run.
    if (Test-Path -LiteralPath $oldPath) {
        Remove-Item -LiteralPath $oldPath -Force -ErrorAction SilentlyContinue
    }

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("$Tool-" + [Guid]::NewGuid())
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        if ($Pinned) {
            $sumPath = Join-Path $tmp 'sum'
            try {
                Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset.sha256" -OutFile $sumPath | Out-Null
            }
            catch {
                throw (Get-InstallError 1 "no $Ver asset for this platform")
            }
            $line = (Get-Content -LiteralPath $sumPath -TotalCount 1).TrimEnd()
            # Same forms as the sh template: `<hash>  <name>`,
            # `<hash> *<name>`, and `dist/<name>` in place of `<name>`.
            if ($line -notmatch "^([0-9a-f]{64}) [ *](\S+)$") {
                throw (Get-InstallError 1 "malformed .sha256 file for $asset")
            }
            $hash = $Matches[1]
            $name = $Matches[2]
            if ($name -ne $asset -and $name -ne "dist/$asset") {
                throw (Get-InstallError 1 "bad .sha256 file for $asset")
            }
        }
        else {
            $sumKey = if ($Variant) { "$Variant/$t" } else { $t }
            $hash = $Sha256[$sumKey]
            if (-not $hash) { throw (Get-InstallError 1 "no embedded sha256 for $sumKey") }
        }

        Write-Status 'Downloading' "$Tool $Ver$(if ($Variant) { " $Variant" }) ($t)"
        $ap = Join-Path $tmp $asset
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $ap | Out-Null

        $got = (Get-FileHash -LiteralPath $ap -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($got -ne $hash) { throw (Get-InstallError 1 "sha256 mismatch for $asset") }
        Write-Status 'Verified' "sha256 $($got.Substring(0, 12))...$($got.Substring($got.Length - 8))"

        # Same layout rule as the sh template: $Tool.exe at the zip root
        # or under a single <stem>/ directory (stem = asset minus .zip).
        $stem = $asset -replace '\.zip$', ''
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip = [IO.Compression.ZipFile]::OpenRead($ap)
        try {
            $members = @($zip.Entries | Where-Object {
                $_.FullName -eq "$Tool.exe" -or $_.FullName -eq "$stem/$Tool.exe" })
            if ($members.Count -gt 1) {
                throw (Get-InstallError 1 "archive has ambiguous layout: both $Tool.exe and $stem/$Tool.exe")
            }
            if ($members.Count -eq 0) {
                throw (Get-InstallError 1 "archive has no $Tool.exe or $stem/$Tool.exe member")
            }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($members[0], (Join-Path $tmp "$Tool.exe"), $true)
        }
        finally {
            $zip.Dispose()
        }

        $out = & (Join-Path $tmp "$Tool.exe") --version 2>&1 | Out-String
        if ($out -notmatch "(^|[^0-9.])$([regex]::Escape($Ver))([^0-9.]|$)") {
            throw (Get-InstallError 1 "self-check failed: $Tool --version did not report $Ver")
        }
        Write-Status 'Verified' "runs $Ver"

        # Replace order keeps a tool on disk at every step: stage the new
        # exe, move the old aside, then promote the stage; on failure the
        # previous exe is moved back first.
        New-Item -ItemType Directory -Force -Path $Dir | Out-Null
        $stage = Join-Path $Dir ".$Tool.tmp.$PID.exe"
        Copy-Item -LiteralPath (Join-Path $tmp "$Tool.exe") -Destination $stage
        if (Test-Path -LiteralPath $exePath) {
            Move-Item -LiteralPath $exePath -Destination $oldPath -Force
        }
        try {
            Move-Item -LiteralPath $stage -Destination $exePath -Force
        }
        catch {
            if (Test-Path -LiteralPath $oldPath) {
                Move-Item -LiteralPath $oldPath -Destination $exePath -Force
            }
            throw
        }
        Remove-Item -LiteralPath $oldPath -Force -ErrorAction SilentlyContinue
    }
    finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }

    Write-Receipt -Dir $Dir -Ver $Ver
    Write-Status 'Installed' $exePath

    if (-not $NoModifyPath) {
        if ($env:GITHUB_PATH) {
            [IO.File]::AppendAllText($env:GITHUB_PATH, "$Dir`r`n")
        }
        else {
            Edit-UserPath -Dir $Dir
        }
    }
}

function Uninstall-Tool([string]$Dir, [bool]$DoDry) {
    $exePath = Join-Path $Dir "$Tool.exe"
    # Touch the binary only when our receipt says we put it there.
    $r = Read-Receipt
    if (-not $r -or $r.install_dir -ne $Dir) {
        [Console]::Error.WriteLine("error: not installed by sh.qntx.org at $Dir")
        $global:LASTEXITCODE = 1
        return
    }
    if ($DoDry) {
        Write-Status 'Removing' "$exePath and $script:Receipt"
        return
    }
    foreach ($p in @($exePath, (Join-Path $Dir "$Tool.old.exe"), $script:Receipt)) {
        if (Test-Path -LiteralPath $p) {
            Remove-Item -LiteralPath $p -Force
            Write-Status 'Removed' $p
        }
    }
    $left = @(Get-ChildItem -LiteralPath $script:Receipts -Filter '*.json' -ErrorAction SilentlyContinue)
    if ($left.Count -eq 0) {
        Edit-UserPath -Dir $Dir -Remove
    }
}

$global:LASTEXITCODE = 0
try {
    if ($Help) { Show-Usage; return }

    $envVersion = [Environment]::GetEnvironmentVariable("${EnvPrefix}_VERSION")
    $envDir = [Environment]::GetEnvironmentVariable("${EnvPrefix}_INSTALL_DIR")
    $envNoPath = [Environment]::GetEnvironmentVariable("${EnvPrefix}_NO_MODIFY_PATH")
    $envVariant = [Environment]::GetEnvironmentVariable("${EnvPrefix}_VARIANT")

    $script:Pinned = $false
    $target = $Version
    if ($Pin) { $target = $Pin; $script:Pinned = $true }
    elseif ($envVersion) { $target = $envVersion; $script:Pinned = $true }
    if ($target -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') {
        throw (Get-InstallError 2 "version must be x.y.z[-suffix]: $target")
    }
    if (-not $Variant) { $Variant = $envVariant }
    if ($Variant) {
        if ($Variants.Count -eq 0) {
            throw (Get-InstallError 2 "$Tool has no variants")
        }
        if ($Variants -cnotcontains $Variant) {
            throw (Get-InstallError 2 "unknown variant: $Variant (available: $($Variants -join ' '))")
        }
    }
    if (-not $InstallDir) { $InstallDir = $envDir }
    if ($envNoPath -eq '1') { $NoModifyPath = [switch]::Present }

    $script:IsQuiet = [bool]$Quiet

    if ($Check) { Write-Output $target; return }

    $dir = Resolve-InstallDir $InstallDir
    $script:Receipts = Join-Path $env:LOCALAPPDATA 'qntx\receipts'
    $script:Receipt = Join-Path $script:Receipts "$Tool.json"

    if ($Uninstall) {
        Uninstall-Tool -Dir $dir -DoDry ([bool]$DryRun)
        return
    }

    Install-Tool -Ver $target -Dir $dir -Pinned $script:Pinned -DoForce ([bool]$Force) -DoDry ([bool]$DryRun)
    $global:LASTEXITCODE = 0
}
catch {
    $err = $_
    $code = 1
    if ($err -is [Management.Automation.ErrorRecord] -and $err.TargetObject -is [int]) {
        $code = [int]$err.TargetObject
        [Console]::Error.WriteLine("error: $($err.Exception.Message)")
    }
    else {
        [Console]::Error.WriteLine("error: $err")
    }
    $global:LASTEXITCODE = $code
}
