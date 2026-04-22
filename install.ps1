# Installer for a GitHub-hosted CLI, served via sh.qntx.fun.
#
# Usage:
#   irm <url> | iex
#   $env:UNINSTALL=1; irm <url> | iex
#   $env:DRY_RUN=1;   irm <url> | iex
#   $env:HELP=1;      irm <url> | iex
#
# Environment (uppercased $Bin prefix, dashes to underscores):
#   <BIN>_VERSION       Install a specific version (no 'v' prefix)
#   <BIN>_INSTALL_DIR   Install directory (default: %LOCALAPPDATA%\<bin>)
#   UNINSTALL=1         Remove the installed binary
#   DRY_RUN=1           Print planned actions without executing
#   HELP=1              Show usage and exit

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$InformationPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$Repo = '__REPO__'
$Bin = '__BIN__'

$BinUpper = ($Bin -replace '-', '_').ToUpper()
$VerEnv = "${BinUpper}_VERSION"
$DirEnv = "${BinUpper}_INSTALL_DIR"
$MaxRetries = 3

function Get-TargetArch {
    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
    switch ($arch) {
        'X64' { return 'x86_64-pc-windows-msvc' }
        'Arm64' { return 'aarch64-pc-windows-msvc' }
    }
    throw "unsupported architecture: $arch"
}

# HTTP GET with up to $MaxRetries attempts and exponential backoff.
function Invoke-HttpGet {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [string]$OutFile
    )
    $attempt = 0
    $delay = 1
    while ($true) {
        try {
            if ($OutFile) {
                $null = Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing -UserAgent "$Bin-installer"
                return
            }
            return Invoke-RestMethod -Uri $Uri -UserAgent "$Bin-installer"
        }
        catch {
            $attempt++
            if ($attempt -ge $MaxRetries) { throw }
            Start-Sleep -Seconds $delay
            $delay *= 2
        }
    }
}

function Get-LatestVersion {
    $tag = (Invoke-HttpGet -Uri "https://api.github.com/repos/$Repo/releases/latest").tag_name
    if (-not $tag) { throw 'failed to detect latest version (network error or rate limited)' }
    if ($tag.StartsWith('v')) { $tag = $tag.Substring(1) }
    return $tag
}

function Test-Sha256 {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Expected
    )
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    if ($actual -ne $Expected) {
        throw "checksum mismatch: expected $Expected, got $actual"
    }
}

# Locate $Bin.exe inside an extracted archive, allowing an optional top-level folder.
function Find-Binary {
    param([Parameter(Mandatory)][string]$Root)
    $exe = "$Bin.exe"
    $direct = Join-Path $Root $exe
    if (Test-Path -LiteralPath $direct -PathType Leaf) { return $direct }
    $found = Get-ChildItem -LiteralPath $Root -Recurse -Filter $exe -File -ErrorAction SilentlyContinue |
    Select-Object -First 1
    if (-not $found) { throw "binary '$exe' not found in archive" }
    return $found.FullName
}

# Broadcast WM_SETTINGCHANGE so Explorer / new shells pick up PATH changes.
function Send-SettingChange {
    if (-not ('Win32.NativeMethods' -as [type])) {
        Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(
    IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
    uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
    }
    $HWND_BROADCAST = [IntPtr]0xffff
    $WM_SETTINGCHANGE = 0x1A
    $SMTO_ABORTIFHUNG = 0x2
    $r = [UIntPtr]::Zero
    [void][Win32.NativeMethods]::SendMessageTimeout(
        $HWND_BROADCAST, $WM_SETTINGCHANGE, [UIntPtr]::Zero, 'Environment',
        $SMTO_ABORTIFHUNG, 5000, [ref]$r)
}

function Get-UserPath {
    $reg = 'registry::HKEY_CURRENT_USER\Environment'
    @((Get-Item -LiteralPath $reg).GetValue('Path', '', 'DoNotExpandEnvironmentNames') -split ';' |
        Where-Object { $_ })
}

function Set-UserPath {
    param([Parameter(Mandatory)][string[]]$Entries)
    $reg = 'registry::HKEY_CURRENT_USER\Environment'
    Set-ItemProperty -LiteralPath $reg -Name Path -Type ExpandString -Value ($Entries -join ';')
    Send-SettingChange
}

function Add-ToUserPath {
    param([Parameter(Mandatory)][string]$Dir)
    $current = Get-UserPath
    if ($current -contains $Dir) { return }
    # Append to tail to avoid shadowing user's existing tools.
    Set-UserPath -Entries ($current + @($Dir))
    Write-Information "  added $Dir to user PATH"
}

function Remove-FromUserPath {
    param([Parameter(Mandatory)][string]$Dir)
    $current = Get-UserPath
    if ($current -notcontains $Dir) { return }
    Set-UserPath -Entries @($current | Where-Object { $_ -ne $Dir })
    Write-Information "  removed $Dir from user PATH"
}

function Get-InstallDir {
    $v = [Environment]::GetEnvironmentVariable($DirEnv)
    if ($v) { $v } else { Join-Path $env:LOCALAPPDATA $Bin }
}

function Install-Cli {
    param([switch]$DryRun)
    $target = Get-TargetArch
    $envVer = [Environment]::GetEnvironmentVariable($VerEnv)
    $ver = if ($envVer) { $envVer } else { Get-LatestVersion }
    $dir = Get-InstallDir

    $archive = "$Bin-$ver-$target.zip"
    $url = "https://github.com/$Repo/releases/download/v$ver/$archive"

    Write-Information "Installing $Bin v$ver ($target)"
    if ($DryRun) {
        Write-Information "[dry-run] would download: $url"
        Write-Information "[dry-run] would install:  $(Join-Path $dir "$Bin.exe")"
        return
    }

    $tmp = New-Item -ItemType Directory -Path (Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid()))
    try {
        $archivePath = Join-Path $tmp.FullName $archive
        $sumPath = "$archivePath.sha256"
        Invoke-HttpGet -Uri $url -OutFile $archivePath

        try {
            Invoke-HttpGet -Uri "$url.sha256" -OutFile $sumPath
            $expected = (Get-Content -LiteralPath $sumPath -TotalCount 1).Split()[0]
            Test-Sha256 -Path $archivePath -Expected $expected
            Write-Information '  checksum verified'
        }
        catch {
            Write-Warning '  no published checksum, skipping verification'
        }

        Expand-Archive -LiteralPath $archivePath -DestinationPath $tmp.FullName -Force
        $binPath = Find-Binary -Root $tmp.FullName

        $null = New-Item -ItemType Directory -Force -Path $dir
        Copy-Item -LiteralPath $binPath -Destination (Join-Path $dir "$Bin.exe") -Force
        Write-Information "  installed $(Join-Path $dir "$Bin.exe")"
    }
    finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }

    if ($env:GITHUB_PATH) {
        $dir | Out-File -FilePath $env:GITHUB_PATH -Encoding utf8 -Append
    }
    elseif (($env:Path -split ';') -notcontains $dir) {
        Add-ToUserPath -Dir $dir
        Write-Information '  restart your shell to pick up the new PATH'
    }

    Write-Information ''
    Write-Information "$Bin v$ver installed."
}

function Uninstall-Cli {
    $dir = Get-InstallDir
    $target = Join-Path $dir "$Bin.exe"
    if (Test-Path -LiteralPath $target -PathType Leaf) {
        Remove-Item -LiteralPath $target -Force
        Write-Information "removed $target"
    }
    else {
        Write-Information "$target not found; nothing to remove"
    }
    Remove-FromUserPath -Dir $dir
}

function Show-Usage {
    @"
Installer for $Bin.

Usage:
  irm <url> | iex
  `$env:UNINSTALL=1; irm <url> | iex
  `$env:DRY_RUN=1;   irm <url> | iex
  `$env:HELP=1;      irm <url> | iex

Environment:
  ${BinUpper}_VERSION       Install a specific version (no 'v' prefix)
  ${BinUpper}_INSTALL_DIR   Install directory (default: %LOCALAPPDATA%\$Bin)
  UNINSTALL=1             Remove the installed binary
  DRY_RUN=1               Show planned actions without executing
"@
}

try {
    if ($env:HELP) { Show-Usage; return }
    if ($env:UNINSTALL) {
        Uninstall-Cli
    }
    else {
        Install-Cli -DryRun:([bool]$env:DRY_RUN)
    }
}
catch {
    Write-Error $_
    exit 1
}
