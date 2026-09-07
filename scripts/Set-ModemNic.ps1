<#
.SYNOPSIS
    Restrict a NIC to talking only to the modem, never to the internet.

.DESCRIPTION
    When a machine is cabled directly into a fibre ONT for diagnostics, Windows
    treats that connection as a second route to the internet. If its interface
    metric happens to be lower than the Wi-Fi adapter's, general traffic and DNS
    silently start flowing through the modem being investigated -- which is both
    the wrong path and, when the modem is the thing that is broken, an
    intermittent one.

    Raising the interface metric is not sufficient. That only deprioritises the
    route; the default gateway still exists and Windows may still choose it,
    for example if the preferred adapter briefly drops. This script removes the
    gateway from the interface altogether, so the only route it offers is the
    on-link subnet containing the modem.

    After running, the adapter can reach the modem and nothing else. All
    internet traffic goes via the other adapter.

    Everything is captured to a backup file first, and -Revert restores it.

.PARAMETER InterfaceAlias
    The adapter cabled to the modem. Defaults to 'Ethernet'.

.PARAMETER IPAddress
    Static address to assign, on the modem's subnet. Note that the modem's DHCP
    pool typically covers the entire subnet, so once this machine stops renewing
    its lease the address could in principle be handed to another device. These
    servers allocate from the bottom of the range, so a high address is the
    safer choice; hence the default.

.PARAMETER Metric
    Interface metric. Belt and braces alongside removing the gateway.

.PARAMETER Revert
    Restore DHCP and the saved settings.

.EXAMPLE
    .\Set-ModemNic.ps1
    .\Set-ModemNic.ps1 -Revert
#>
[CmdletBinding()]
param(
    [string] $InterfaceAlias = 'Ethernet',
    [string] $IPAddress = '192.168.0.250',
    [int]    $PrefixLength = 24,
    [int]    $Metric = 9000,
    [switch] $Revert
)

$ErrorActionPreference = 'Stop'

function Test-Elevated {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
}

if (-not (Test-Elevated)) {
    Write-Error "This script changes network configuration and must run as Administrator. Right-click PowerShell and choose 'Run as administrator'."
    exit 1
}

$adapter = Get-NetAdapter -Name $InterfaceAlias -ErrorAction SilentlyContinue
if ($null -eq $adapter) {
    Write-Error "No adapter named '$InterfaceAlias'. Available: $((Get-NetAdapter | Select-Object -ExpandProperty Name) -join ', ')"
    exit 1
}
$idx = $adapter.ifIndex
$backupFile = Join-Path $PSScriptRoot "nic-backup-$InterfaceAlias.json"

function Get-CurrentConfig {
    $ipif = Get-NetIPInterface -InterfaceIndex $idx -AddressFamily IPv4
    $addr = Get-NetIPAddress -InterfaceIndex $idx -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1
    $gw = Get-NetRoute -InterfaceIndex $idx -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Select-Object -First 1
    $dns = Get-DnsClientServerAddress -InterfaceIndex $idx -AddressFamily IPv4

    $gwHop = ''
    if ($null -ne $gw) { $gwHop = $gw.NextHop }
    $ip = ''
    $plen = 0
    if ($null -ne $addr) { $ip = $addr.IPAddress; $plen = $addr.PrefixLength }

    return [pscustomobject]@{
        InterfaceAlias  = $InterfaceAlias
        Dhcp            = [string]$ipif.Dhcp
        AutomaticMetric = [string]$ipif.AutomaticMetric
        InterfaceMetric = $ipif.InterfaceMetric
        IPAddress       = $ip
        PrefixLength    = $plen
        Gateway         = $gwHop
        DnsServers      = @($dns.ServerAddresses)
        SavedAt         = (Get-Date).ToString('o')
    }
}

function Show-Config {
    param([string] $Label)
    $c = Get-CurrentConfig
    Write-Host ""
    Write-Host "  $Label" -ForegroundColor Cyan
    Write-Host ("    DHCP            : {0}" -f $c.Dhcp)
    Write-Host ("    IPv4            : {0}/{1}" -f $c.IPAddress, $c.PrefixLength)
    if ([string]::IsNullOrEmpty($c.Gateway)) {
        Write-Host "    Default gateway : (none)" -ForegroundColor Green
    } else {
        Write-Host ("    Default gateway : {0}" -f $c.Gateway) -ForegroundColor Yellow
    }
    Write-Host ("    Interface metric: {0}" -f $c.InterfaceMetric)
    if ($c.DnsServers.Count -eq 0) {
        Write-Host "    DNS servers     : (none)" -ForegroundColor Green
    } else {
        Write-Host ("    DNS servers     : {0}" -f ($c.DnsServers -join ', '))
    }
}

# ---------------------------------------------------------------- revert ----
if ($Revert) {
    if (-not (Test-Path $backupFile)) {
        Write-Warning "No backup at $backupFile. Restoring plain DHCP defaults instead."
        $saved = $null
    } else {
        $saved = Get-Content $backupFile -Raw | ConvertFrom-Json
    }

    Show-Config -Label "Before revert"

    Get-NetIPAddress -InterfaceIndex $idx -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue
    Get-NetRoute -InterfaceIndex $idx -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
        Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue

    Set-NetIPInterface -InterfaceIndex $idx -AddressFamily IPv4 -Dhcp Enabled
    Set-NetIPInterface -InterfaceIndex $idx -AddressFamily IPv4 -AutomaticMetric Enabled
    Set-DnsClientServerAddress -InterfaceIndex $idx -ResetServerAddresses
    Set-DnsClient -InterfaceIndex $idx -RegisterThisConnectionsAddress $true

    ipconfig /renew "$InterfaceAlias" | Out-Null
    Start-Sleep -Seconds 3

    Show-Config -Label "After revert (DHCP restored)"
    Write-Host ""
    Write-Host "  Reverted." -ForegroundColor Green
    exit 0
}

# ----------------------------------------------------------------- apply ----
$before = Get-CurrentConfig
$before | ConvertTo-Json -Depth 4 | Set-Content -Path $backupFile -Encoding utf8
Write-Host "  Saved current configuration to $backupFile"

Show-Config -Label "Before"

# Confirm the modem is on the subnet we are about to pin ourselves to, so a
# typo in -IPAddress does not silently strand the adapter.
$network = ($IPAddress -split '\.')[0..2] -join '.'
if ($before.Gateway -and -not $before.Gateway.StartsWith($network)) {
    Write-Warning "Current gateway $($before.Gateway) is not on $network.0/$PrefixLength. Check -IPAddress."
}

Write-Host ""
Write-Host "  Applying modem-only configuration..." -ForegroundColor Cyan

# Order matters: drop the existing address and gateway, disable DHCP so it
# cannot put them back on the next renewal, then assign a static address with
# no gateway of its own.
Get-NetRoute -InterfaceIndex $idx -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
    Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue
Get-NetIPAddress -InterfaceIndex $idx -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue

Set-NetIPInterface -InterfaceIndex $idx -AddressFamily IPv4 -Dhcp Disabled

# No -DefaultGateway. This is the whole point: the adapter gets an on-link
# route to the modem's subnet and no route to anywhere else.
New-NetIPAddress -InterfaceIndex $idx -IPAddress $IPAddress -PrefixLength $PrefixLength | Out-Null

# Without this the modem's DNS servers, including the ISP resolver it hands
# out, stay configured and queries would follow the modem instead of the router.
Set-DnsClientServerAddress -InterfaceIndex $idx -ServerAddresses @()

# Defence in depth: even if a gateway reappears, this adapter should lose.
Set-NetIPInterface -InterfaceIndex $idx -AddressFamily IPv4 -AutomaticMetric Disabled
Set-NetIPInterface -InterfaceIndex $idx -AddressFamily IPv4 -InterfaceMetric $Metric

# Keep this connection out of DNS registration; it is a diagnostic link.
Set-DnsClient -InterfaceIndex $idx -RegisterThisConnectionsAddress $false

Start-Sleep -Seconds 2
Show-Config -Label "After"

# ------------------------------------------------------------ verification --
Write-Host ""
Write-Host "  Verification" -ForegroundColor Cyan

$modemRoute = Find-NetRoute -RemoteIPAddress '192.168.0.1' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -ne $modemRoute) {
    Write-Host ("    modem 192.168.0.1 -> via {0}" -f $modemRoute.InterfaceAlias)
} else {
    Write-Host "    modem 192.168.0.1 -> NO ROUTE" -ForegroundColor Red
}

$netRoute = Find-NetRoute -RemoteIPAddress '8.8.8.8' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -ne $netRoute) {
    if ($netRoute.InterfaceAlias -eq $InterfaceAlias) {
        Write-Host ("    internet 8.8.8.8 -> via {0}  <-- STILL VIA THE MODEM" -f $netRoute.InterfaceAlias) -ForegroundColor Red
    } else {
        Write-Host ("    internet 8.8.8.8 -> via {0}" -f $netRoute.InterfaceAlias) -ForegroundColor Green
    }
}

$ping = Test-Connection -ComputerName '192.168.0.1' -Count 2 -Quiet -ErrorAction SilentlyContinue
if ($ping) {
    Write-Host "    modem reachable   -> yes" -ForegroundColor Green
} else {
    Write-Host "    modem reachable   -> NO (the modem may simply be rebooting)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  Done. Revert at any time with:  .\Set-ModemNic.ps1 -Revert" -ForegroundColor Green
