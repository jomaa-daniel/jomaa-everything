<#
.SYNOPSIS
Set up this Windows machine to reach jerry over SSH through Cloudflare: `ssh jerry`.

.DESCRIPTION
If cloudflared is missing, downloads the pinned release to
%LOCALAPPDATA%\cloudflared, refusing it unless it matches GitHub's SHA-256
digest. Then pins jerry's tunnel host key from known_hosts next to this script
and adds a `jerry` entry to ~\.ssh\config. Safe to rerun; it replaces its own
entry. Uses the OpenSSH client built into Windows 10 and 11.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File jomaa-ssh\setup_client.ps1
#>
param(
    [string]$Alias = "jerry",
    [string]$HostName = "ssh.jomaa.org",
    [string]$User = "jerry"
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"  # the progress bar slows Invoke-WebRequest down a lot
Set-StrictMode -Version Latest
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# The version the hub's native setup uses.
$Version = "2026.10.7"
$Begin = "# BEGIN jomaa-ssh"
$End = "# END jomaa-ssh"
# ssh can't read files that start with a byte order mark, which Windows PowerShell's UTF8 adds.
$Utf8 = New-Object System.Text.UTF8Encoding $false

function Get-Cloudflared {
    $found = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
    $dest = Join-Path $env:LOCALAPPDATA "cloudflared\cloudflared.exe"
    if (Test-Path $dest) { return $dest }
    # 64-bit Arm runs the amd64 build under emulation.
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "x86") { "386" } else { "amd64" }
    $name = "cloudflared-windows-$arch.exe"
    $release = Invoke-RestMethod -Headers @{ "User-Agent" = "jomaa-ssh-setup" } `
        -Uri "https://api.github.com/repos/cloudflare/cloudflared/releases/tags/$Version"
    $asset = $release.assets | Where-Object { $_.name -eq $name } | Select-Object -First 1
    if (-not $asset -or -not "$($asset.digest)".StartsWith("sha256:")) {
        throw "cloudflared $Version has no verified $name download"
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
    $tmp = "$dest.download"
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $tmp
        $hash = (Get-FileHash -Algorithm SHA256 $tmp).Hash.ToLowerInvariant()
        if ($hash -ne $asset.digest.Substring("sha256:".Length)) { throw "checksum mismatch for $name" }
        Move-Item -Force $tmp $dest
    } finally {
        Remove-Item -Force -ErrorAction SilentlyContinue $tmp
    }
    return $dest
}

try {
    $cloudflared = Get-Cloudflared
    $ssh = Join-Path $HOME ".ssh"
    New-Item -ItemType Directory -Force -Path $ssh | Out-Null

    $known = Join-Path $ssh "known_hosts"
    $existing = if (Test-Path $known) { [IO.File]::ReadAllText($known) } else { "" }
    $have = $existing -split "`r?`n"
    $add = @(Get-Content (Join-Path $PSScriptRoot "known_hosts") | Where-Object { $_.Trim() -and ($have -notcontains $_) })
    if ($add.Count -gt 0) {
        $prefix = if ($existing -and -not $existing.EndsWith("`n")) { "`n" } else { "" }
        [IO.File]::AppendAllText($known, $prefix + ($add -join "`n") + "`n", $Utf8)
    }

    # Forward slashes and quotes keep a path with spaces or backslashes intact in ssh_config.
    $exe = $cloudflared -replace "\\", "/"
    $block = "$Begin`nHost $Alias`n  HostName $HostName`n  User $User`n  ProxyCommand `"$exe`" access ssh --hostname %h`n$End`n"
    $configPath = Join-Path $ssh "config"
    $current = if (Test-Path $configPath) { [IO.File]::ReadAllText($configPath) } else { "" }
    $start = $current.IndexOf($Begin)
    $stop = $current.IndexOf($End)
    if ($start -ge 0 -and $stop -ge 0) {
        $rest = $current.Substring($stop + $End.Length) -replace "^\r?\n", ""
        $updated = $current.Substring(0, $start) + $block + $rest
    } elseif ($current) {
        # At the top, so a later `Host *` can't override it.
        $updated = $block + "`n" + $current
    } else {
        $updated = $block
    }
    [IO.File]::WriteAllText($configPath, $updated, $Utf8)
    Write-Host "Ready: ssh $Alias"
} catch {
    Write-Error "setup failed: $_"
    exit 1
}
