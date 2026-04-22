# Installer for a GitHub-hosted CLI, served via sh.qntx.fun.
#
# Usage:
#   irm <url> | iex                              # install
#   $env:UNINSTALL=1; irm <url> | iex            # uninstall
#   $env:DRY_RUN=1;   irm <url> | iex            # preview
#   $env:HELP=1;      irm <url> | iex            # show usage
#
# Environment (uppercased $Bin, '-' -> '_'):
#   <BIN>_VERSION       Pin a version (default: latest)
#   <BIN>_INSTALL_DIR   Install directory (default: %LOCALAPPDATA%\<bin>)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$InformationPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$Repo = '__REPO__'
$Bin = '__BIN__'
$Up = ($Bin -replace '-', '_').ToUpper()

function Get-Target {
    $a = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    switch ($a) {
        'X64' { return 'x86_64-pc-windows-msvc' }
        'Arm64' { return 'aarch64-pc-windows-msvc' }
        default { throw "unsupported architecture: $a" }
    }
}

# HTTP GET with 3 attempts and exponential backoff.
function Invoke-Http {
    param([string]$Uri, [string]$OutFile)
    $i = 0; $d = 1
    while ($true) {
        try {
            if ($OutFile) {
                $null = Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing -UserAgent "$Bin-installer"
                return
            }
            return Invoke-RestMethod -Uri $Uri -UserAgent "$Bin-installer"
        }
        catch {
            if (++$i -ge 3) { throw }
            Start-Sleep -Seconds $d; $d *= 2
        }
    }
}

function Get-Latest {
    $tag = (Invoke-Http -Uri "https://api.github.com/repos/$Repo/releases/latest").tag_name
    if (-not $tag) { throw 'failed to detect latest version' }
    $tag -replace '^v', ''
}

# Locate $Bin.exe in an extracted archive, tolerating an optional top-level folder.
function Find-Bin {
    param([string]$Root)
    $exe = "$Bin.exe"
    $p = Join-Path $Root $exe
    if (Test-Path -LiteralPath $p -PathType Leaf) { return $p }
    $f = Get-ChildItem -LiteralPath $Root -Recurse -Filter $exe -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $f) { throw "binary '$exe' not found in archive" }
    $f.FullName
}

# Broadcast WM_SETTINGCHANGE via P/Invoke so new shells see the PATH change.
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

function Edit-UserPath {
    param([string]$Dir, [switch]$Remove)
    $reg = 'registry::HKEY_CURRENT_USER\Environment'
    $cur = @((Get-Item -LiteralPath $reg).GetValue('Path', '', 'DoNotExpandEnvironmentNames') -split ';' | Where-Object { $_ })

    if ($Remove) {
        if ($cur -notcontains $Dir) { return }
        $new = @($cur | Where-Object { $_ -ne $Dir })
        $verb = 'removed'; $prep = 'from'
    }
    else {
        if ($cur -contains $Dir) { return }
        $new = $cur + @($Dir)   # append to tail; avoid shadowing existing tools
        $verb = 'added'; $prep = 'to'
    }

    Set-ItemProperty -LiteralPath $reg -Name Path -Type ExpandString -Value ($new -join ';')
    Send-SettingChange
    Write-Information "  $verb $Dir $prep user PATH"
}

function Get-Dir {
    $v = [Environment]::GetEnvironmentVariable("${Up}_INSTALL_DIR")
    if ($v) { $v } else { Join-Path $env:LOCALAPPDATA $Bin }
}

function Install-Cli {
    param([switch]$DryRun)
    $t = Get-Target
    $v = [Environment]::GetEnvironmentVariable("${Up}_VERSION")
    if (-not $v) { $v = Get-Latest }
    $d = Get-Dir
    $archive = "$Bin-$v-$t.zip"
    $url = "https://github.com/$Repo/releases/download/v$v/$archive"

    Write-Information "Installing $Bin v$v ($t)"
    if ($DryRun) {
        Write-Information "[dry-run] download: $url"
        Write-Information "[dry-run] install:  $(Join-Path $d "$Bin.exe")"
        return
    }

    $tmp = New-Item -ItemType Directory -Path (Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid()))
    try {
        $ap = Join-Path $tmp.FullName $archive
        $sp = "$ap.sha256"
        Invoke-Http -Uri $url -OutFile $ap

        try {
            Invoke-Http -Uri "$url.sha256" -OutFile $sp
            $exp = (Get-Content -LiteralPath $sp -TotalCount 1).Split()[0]
            $act = (Get-FileHash -LiteralPath $ap -Algorithm SHA256).Hash
            if ($act -ne $exp) { throw "checksum mismatch: expected $exp, got $act" }
            Write-Information '  checksum verified'
        }
        catch {
            Write-Warning '  no published checksum, skipping verification'
        }

        Expand-Archive -LiteralPath $ap -DestinationPath $tmp.FullName -Force
        $src = Find-Bin -Root $tmp.FullName
        $null = New-Item -ItemType Directory -Force -Path $d
        Copy-Item -LiteralPath $src -Destination (Join-Path $d "$Bin.exe") -Force
        Write-Information "  installed $(Join-Path $d "$Bin.exe")"
    }
    finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }

    if ($env:GITHUB_PATH) {
        $d | Out-File -FilePath $env:GITHUB_PATH -Encoding utf8 -Append
    }
    elseif (($env:Path -split ';') -notcontains $d) {
        Edit-UserPath -Dir $d
        Write-Information '  restart your shell to pick up the new PATH'
    }

    Write-Information "`n$Bin v$v installed."
}

function Uninstall-Cli {
    $d = Get-Dir
    $t = Join-Path $d "$Bin.exe"
    if (Test-Path -LiteralPath $t -PathType Leaf) {
        Remove-Item -LiteralPath $t -Force
        Write-Information "removed $t"
    }
    else {
        Write-Information "$t not found"
    }
    Edit-UserPath -Dir $d -Remove
}

function Show-Usage {
    @"
Installer for $Bin.

Usage:
  irm <url> | iex                              # install
  `$env:UNINSTALL=1; irm <url> | iex           # uninstall
  `$env:DRY_RUN=1;   irm <url> | iex           # preview
  `$env:HELP=1;      irm <url> | iex           # this message

Environment:
  ${Up}_VERSION       Pin a version (default: latest)
  ${Up}_INSTALL_DIR   Install directory (default: %LOCALAPPDATA%\$Bin)
"@
}

try {
    if ($env:HELP) { Show-Usage; return }
    if ($env:UNINSTALL) { Uninstall-Cli; return }
    Install-Cli -DryRun:([bool]$env:DRY_RUN)
}
catch {
    Write-Error $_
    exit 1
}
