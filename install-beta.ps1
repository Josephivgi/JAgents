<#
  JSystems beta installer: the same installer as install.ps1, with the apps
  still in beta testing added (JMCP), and pre-releases when they are newer.

    Ask:           irm https://raw.githubusercontent.com/Josephivgi/JAgents/main/install-beta.ps1 | iex
    No questions:  $env:JSYSTEMS_APPS='all'; irm <same url> | iex
    Some apps:     $env:JSYSTEMS_APPS='JMCP'; irm <same url> | iex

  It runs install.ps1 from the same place, so both commands install the
  same way. install.ps1 clears JSYSTEMS_BETA when it starts.
#>
$env:JSYSTEMS_BETA = '1'
try {
  Invoke-Expression (Invoke-RestMethod 'https://raw.githubusercontent.com/Josephivgi/JAgents/main/install.ps1' -Headers @{ 'User-Agent' = 'jsystems-install' })
} finally {
  Remove-Item Env:JSYSTEMS_BETA -ErrorAction SilentlyContinue
}
