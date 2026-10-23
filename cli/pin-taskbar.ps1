# Pins JAgents Desktop to the Windows taskbar. `jagents install-desktop` runs
# this when you answer yes; `jagents pin` runs it any time.
#
# Windows has no "pin to taskbar" call for scripts, so this uses Microsoft's
# taskbar layout file: a per-user policy points Explorer at a layout that adds
# JAgents to the existing pins (PinListPlacement="Append" keeps yours),
# Explorer restarts to read it, and once the pin shows up the policy is
# removed again so nothing stays managed. You can unpin it like any app.

param([string]$Shortcut = (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\JAgents.lnk'))

$ErrorActionPreference = 'Stop'
$pinned = Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
$policy = 'HKCU:\Software\Policies\Microsoft\Windows\Explorer'
$wsh = New-Object -ComObject WScript.Shell

if (-not (Test-Path $Shortcut)) { Write-Output "No JAgents shortcut at $Shortcut. Install JAgents Desktop first."; exit 2 }
$target = $wsh.CreateShortcut($Shortcut).TargetPath

function Test-Pinned {
  if (-not (Test-Path $pinned)) { return $false }
  foreach ($lnk in Get-ChildItem $pinned -Filter *.lnk) {
    if ($wsh.CreateShortcut($lnk.FullName).TargetPath -ieq $target) { return $true }
  }
  return $false
}

if (Test-Pinned) { Write-Output 'JAgents is already pinned to the taskbar.'; exit 0 }

# Someone (or an admin) already manages the layout: leave it alone.
$existing = Get-ItemProperty $policy -ErrorAction SilentlyContinue
if ($existing -and ($existing.StartLayoutFile -or $existing.LockedStartLayout)) {
  Write-Output 'Your taskbar layout is managed by a policy, so JAgents did not change it. Right-click JAgents in Start and choose Pin to taskbar.'
  exit 3
}

$dir = Join-Path $env:LOCALAPPDATA 'JAgents'
New-Item -ItemType Directory -Force $dir | Out-Null
$xml = Join-Path $dir 'taskbar-pin.xml'
@"
<?xml version="1.0" encoding="utf-8"?>
<LayoutModificationTemplate xmlns="http://schemas.microsoft.com/Start/2014/LayoutModification" xmlns:defaultlayout="http://schemas.microsoft.com/Start/2014/FullDefaultLayout" xmlns:start="http://schemas.microsoft.com/Start/2014/StartLayout" xmlns:taskbar="http://schemas.microsoft.com/Start/2014/TaskbarLayout" Version="1">
  <CustomTaskbarLayoutCollection PinListPlacement="Append">
    <defaultlayout:TaskbarLayout>
      <taskbar:TaskbarPinList>
        <taskbar:DesktopApp DesktopApplicationLinkPath="$Shortcut" />
      </taskbar:TaskbarPinList>
    </defaultlayout:TaskbarLayout>
  </CustomTaskbarLayoutCollection>
</LayoutModificationTemplate>
"@ | Set-Content $xml -Encoding UTF8

function Restart-Explorer {
  Get-Process explorer -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
  if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }
}

$ok = $false
try {
  New-Item -Path $policy -Force | Out-Null
  New-ItemProperty $policy -Name StartLayoutFile -Value $xml -PropertyType ExpandString -Force | Out-Null
  New-ItemProperty $policy -Name LockedStartLayout -Value 1 -PropertyType DWord -Force | Out-Null
  Restart-Explorer
  for ($i = 0; $i -lt 30 -and -not $ok; $i++) {
    Start-Sleep -Milliseconds 500
    $ok = Test-Pinned
  }
} finally {
  # The pin is a normal user pin now; drop the policy so the taskbar is yours again.
  Remove-ItemProperty $policy -Name StartLayoutFile, LockedStartLayout -ErrorAction SilentlyContinue
  if (-not (Get-Item $policy).Property) { Remove-Item $policy -ErrorAction SilentlyContinue }
  Remove-Item $xml -Force -ErrorAction SilentlyContinue
}

if ($ok) {
  Write-Output 'Pinned JAgents to the taskbar.'
  exit 0
}
Write-Output 'Windows did not take the pin. Right-click JAgents in Start and choose Pin to taskbar.'
exit 1
