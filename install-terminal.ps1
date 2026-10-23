# Installs the JAgents terminal app (the `jagents` command) from the latest
# GitHub release:
#
#   irm https://raw.githubusercontent.com/Josephivgi/JAgents/main/install-terminal.ps1 | iex
#
# It downloads the release's app package (JAgents-<tag>.tar.gz), puts it in
# %LOCALAPPDATA%\JAgents-Terminal\app, installs what the terminal app needs
# (node-pty, @xterm/headless), and adds %LOCALAPPDATA%\JAgents-Terminal\bin to
# your user PATH. Run it again to update. Needs Node.js 22 or newer.
#
# JAGENTS_HOME installs somewhere else. JAGENTS_SOURCE installs a local
# package instead of downloading one. JAGENTS_NO_PATH=1 leaves PATH alone.

& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $repo = 'Josephivgi/JAgents'

  function Fail($message) {
    Write-Host "JAgents install failed: $message" -ForegroundColor Red
    throw $message
  }

  $root = if ($env:JAGENTS_HOME) { $env:JAGENTS_HOME } else { Join-Path $env:LOCALAPPDATA 'JAgents-Terminal' }

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js is not installed. Get version 22 or newer from https://nodejs.org, then run this again.' }
  $major = [int](node -p "process.versions.node.split('.')[0]")
  if ($major -lt 22) { Fail "Node.js $(node -v) is too old. Install version 22 or newer from https://nodejs.org." }
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail 'npm is missing. It comes with Node.js from https://nodejs.org.' }

  if ($env:JAGENTS_SOURCE) {
    $package = $env:JAGENTS_SOURCE
    $tag = 'local package'
  } else {
    Write-Host 'Finding the latest JAgents release...'
    $release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers @{ 'User-Agent' = 'jagents-install' }
    $tag = $release.tag_name
    $asset = $release.assets | Where-Object { $_.name -like 'JAgents-*.tar.gz' } | Select-Object -First 1
    if (-not $asset) { Fail "Release $tag has no app package." }
    $package = Join-Path $env:TEMP $asset.name
    Write-Host "Downloading JAgents $tag..."
    Invoke-WebRequest $asset.browser_download_url -OutFile $package -UseBasicParsing
  }

  New-Item -ItemType Directory -Force $root | Out-Null
  $stage = Join-Path $root 'staging'
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
  New-Item -ItemType Directory $stage | Out-Null
  # Windows' own tar: Git's (when it is first on PATH) reads C: as a host name.
  $tarExe = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (-not (Test-Path $tarExe)) { $tarExe = 'tar' }
  & $tarExe -xzf $package -C $stage
  if ($LASTEXITCODE) { Fail "Could not unpack $package." }
  $src = Join-Path $stage 'JAgents'
  if (-not (Test-Path (Join-Path $src 'cli\jagents.cjs'))) {
    Remove-Item $stage -Recurse -Force
    Fail "JAgents $tag has no terminal app yet."
  }

  Write-Host 'Installing the terminal app''s packages...'
  Push-Location (Join-Path $src 'cli')
  try {
    npm install --omit=dev --no-audit --no-fund --loglevel=error
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($code) { Fail 'npm install failed. The output above says why.' }

  # A running jagents keeps its folder in use (node-pty's DLL is loaded), so
  # each install gets a new one. current.txt is written last: open windows
  # watch it and move to the new folder once it is complete.
  $name = 'app-' + (($tag -replace '[^\w.-]', '-') + '-' + (Get-Date -Format 'yyyyMMddHHmmss'))
  $app = Join-Path $root $name
  Move-Item $src $app
  Remove-Item $stage -Recurse -Force
  if (-not $env:JAGENTS_SOURCE) { Remove-Item $package -Force -ErrorAction SilentlyContinue }
  Set-Content (Join-Path $root 'current.txt') $app -Encoding Ascii -NoNewline

  # Older folders, and the single app folder from before versioned installs.
  # An open window still runs node-pty from its folder and marks it with
  # .running\<pid>; such a folder stays whole until the next install.
  function InUse($dir) {
    $marks = Join-Path $dir '.running'
    if (-not (Test-Path $marks)) { return $false }
    foreach ($m in Get-ChildItem $marks -File) {
      $p = Get-Process -Id ([int]$m.Name) -ErrorAction SilentlyContinue
      if ($p -and $p.ProcessName -eq 'node') { return $true }
    }
    return $false
  }
  Get-ChildItem $root -Directory | Where-Object { ($_.Name -eq 'app' -or $_.Name -like 'app-*') -and $_.FullName -ne $app } | ForEach-Object {
    if (-not (InUse $_.FullName)) {
      try { Remove-Item $_.FullName -Recurse -Force -ErrorAction Stop } catch { }
    }
  }

  $bin = Join-Path $root 'bin'
  New-Item -ItemType Directory -Force $bin | Out-Null
  Set-Content (Join-Path $bin 'jagents.cmd') "@node `"$app\cli\jagents.cjs`" %*" -Encoding Ascii

  if ($env:JAGENTS_NO_PATH -ne '1') {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @($userPath -split ';' | Where-Object { $_ })
    if ($parts -notcontains $bin) {
      [Environment]::SetEnvironmentVariable('Path', (($parts + $bin) -join ';'), 'User')
      Write-Host "Added $bin to your PATH."
    }
    if (($env:Path -split ';') -notcontains $bin) { $env:Path = "$env:Path;$bin" }
  }

  Write-Host ''
  node (Join-Path $app 'cli\jagents.cjs') --version
  Write-Host ''
  Write-Host 'Run  jagents  to start. New terminals pick up the PATH change.' -ForegroundColor Green
  Write-Host 'Open jagents windows switch to this version on their own.'
  Write-Host 'Run  jagents install-desktop  for the desktop app.'
}
