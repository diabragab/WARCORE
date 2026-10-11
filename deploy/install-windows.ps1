# Installs or updates WARCORE on a Windows server that already hosts a website in Apache (Laragon) or IIS.
# Open PowerShell as Administrator and run:
#   $env:DOMAIN='war-core.online'; irm https://raw.githubusercontent.com/diabragab/tanks/main/deploy/install-windows.ps1 | iex
#
# What it does:
#   1. Uses Node.js from PATH or Laragon (installs it if missing), downloads the game to C:\warcore and builds it.
#   2. Runs the game server privately on 127.0.0.1:8787 as a startup task (restarts with Windows).
#   3. If Apache is running (for example Laragon): adds sites-enabled\DOMAIN.conf forwarding to the game with WebSockets,
#      checks the config and restarts Apache. Your other Apache sites are not changed.
#      With $env:ACME_EMAIL set, it also gets a free Let's Encrypt certificate with win-acme (auto-renewing).
#   4. Otherwise, if IIS is installed: adds an IIS site for DOMAIN that forwards to the game (URL Rewrite + ARR + WebSockets).
#      Your existing IIS sites are not changed. Each site answers only for its own domain name.
# Options: $env:WARCORE_PORT='8790' if 8787 is taken.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Domain = $env:DOMAIN
$Port = if ($env:WARCORE_PORT) { $env:WARCORE_PORT } else { '8787' }
$Root = 'C:\warcore'
$App = Join-Path $Root 'app'
$Site = Join-Path $Root 'site'
$Tmp = Join-Path $env:TEMP 'warcore-install'
New-Item -ItemType Directory -Force -Path $Root, $Site, $Tmp | Out-Null

function Install-Msi($url, $name) {
  $file = Join-Path $Tmp $name
  Write-Host "Downloading $name..."
  Invoke-WebRequest -UseBasicParsing $url -OutFile $file
  $p = Start-Process msiexec.exe -ArgumentList "/i `"$file`" /qn /norestart" -Wait -PassThru
  if ($p.ExitCode -notin 0, 3010) { throw "$name failed to install (exit code $($p.ExitCode))" }
}

# 1. Node.js
$laragonNode = Get-ChildItem 'C:\laragon\bin\nodejs\*\node.exe' -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
if (-not (Get-Command node -ErrorAction SilentlyContinue) -and $laragonNode) { $env:Path = (Split-Path $laragonNode.FullName) + ';' + $env:Path }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Install-Msi 'https://nodejs.org/dist/v22.11.0/node-v22.11.0-x64.msi' 'node.msi'
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
$Node = (Get-Command node).Source
$Npm = Join-Path (Split-Path $Node) 'npm.cmd'

# 2. Game files
Write-Host 'Downloading WARCORE...'
$zip = Join-Path $Tmp 'warcore.zip'
Invoke-WebRequest -UseBasicParsing 'https://github.com/diabragab/tanks/archive/refs/heads/main.zip' -OutFile $zip
$unz = Join-Path $Tmp 'src'
if (Test-Path $unz) { Remove-Item -Recurse -Force $unz }
Expand-Archive $zip $unz
$task = Get-ScheduledTask -TaskName 'WARCORE' -ErrorAction SilentlyContinue
if ($task) { Stop-ScheduledTask -TaskName 'WARCORE'; Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*warcore*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force } }
if (Test-Path $App) { Remove-Item -Recurse -Force $App }
Move-Item (Join-Path $unz 'tanks-main') $App
Push-Location $App
Write-Host 'Building the game (this takes a minute)...'
& $Npm ci --no-audit --no-fund
if ($LASTEXITCODE) { throw 'npm ci failed' }
& $Npm run build
if ($LASTEXITCODE) { throw 'Build failed' }
Pop-Location

# 3. Run at startup, private to this machine
$start = Join-Path $Root 'start.cmd'
Set-Content -Encoding ASCII $start "@echo off`r`nset PORT=$Port`r`nset HOST=127.0.0.1`r`n`"$Node`" `"$App\server\index.mjs`" >> `"$Root\server.log`" 2>&1`r`n"
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$start`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries
Register-ScheduledTask -TaskName 'WARCORE' -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName 'WARCORE'
Start-Sleep 3
try { Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/health" | Out-Null; Write-Host "WARCORE is running on 127.0.0.1:$Port." }
catch { Write-Warning "The game server didn't answer yet. Check $Root\server.log" }

if (-not $Domain) { Write-Host 'Run again with $env:DOMAIN set to add the website for the game.'; return }

# 4a. Apache site for the domain (Laragon or another Apache already serving ports 80/443)
$httpd = Get-CimInstance Win32_Process -Filter "Name='httpd.exe'" | Select-Object -First 1
if ($httpd) {
  $HttpdExe = $httpd.ExecutablePath
  $ApacheSvc = (Get-CimInstance Win32_Service | Where-Object { $_.PathName -like '*httpd.exe*' } | Select-Object -First 1).Name
  $SitesDir = if (Test-Path 'C:\laragon\etc\apache2\sites-enabled') { 'C:\laragon\etc\apache2\sites-enabled' } else { Join-Path (Split-Path (Split-Path $HttpdExe)) 'conf\extra' }
  $Acme = Join-Path $Root 'acme'
  $Ssl = Join-Path $Root 'ssl'
  New-Item -ItemType Directory -Force -Path (Join-Path $Acme '.well-known\acme-challenge'), $Ssl | Out-Null
  $cert = Join-Path $Ssl "$Domain-chain.pem"; $key = Join-Path $Ssl "$Domain-key.pem"
  if (-not (Test-Path $cert)) {
    # Until a real certificate exists, use Laragon's self-signed one (fine behind Cloudflare SSL mode "Full").
    $cert = 'C:\laragon\etc\ssl\laragon.crt'; $key = 'C:\laragon\etc\ssl\laragon.key'
  }
  $Conf = Join-Path $SitesDir "$Domain.conf"
  $Restart = Join-Path $Root 'apache-restart.cmd'
  $svcArg = if ($ApacheSvc) { " -n `"$ApacheSvc`"" } else { '' }
  Set-Content -Encoding ASCII $Restart "@echo off`r`n`"$HttpdExe`" -t && `"$HttpdExe`" -k restart$svcArg`r`n"

  function Write-Vhost($c, $k) {
    $tpl = Get-Content -Raw (Join-Path $App 'deploy\apache-vhost.conf')
    $tpl = $tpl.Replace('__DOMAIN__', $Domain).Replace('__PORT__', $Port).Replace('__ACME__', ($Acme -replace '\\', '/')).Replace('__CERT__', ($c -replace '\\', '/')).Replace('__KEY__', ($k -replace '\\', '/'))
    $old = if (Test-Path $Conf) { Get-Content -Raw $Conf } else { $null }
    Set-Content -Encoding ASCII $Conf $tpl
    & $HttpdExe -t
    if ($LASTEXITCODE) {
      if ($old) { Set-Content -Encoding ASCII $Conf $old } else { Remove-Item $Conf }
      throw 'Apache rejected the WARCORE site config, so it was rolled back. Nothing else was changed.'
    }
    & cmd.exe /c $Restart
  }
  Write-Vhost $cert $key
  Write-Host "Added Apache site $Conf for $Domain"

  if ($env:ACME_EMAIL -and -not (Test-Path (Join-Path $Ssl "$Domain-chain.pem"))) {
    $Wacs = Join-Path $Root 'win-acme'
    if (-not (Test-Path (Join-Path $Wacs 'wacs.exe'))) {
      Write-Host 'Downloading win-acme...'
      $wz = Join-Path $Tmp 'wacs.zip'
      $rel = Invoke-RestMethod -UseBasicParsing 'https://api.github.com/repos/win-acme/win-acme/releases/latest'
      $asset = $rel.assets | Where-Object { $_.name -like '*x64.pluggable.zip' } | Select-Object -First 1
      Invoke-WebRequest -UseBasicParsing $asset.browser_download_url -OutFile $wz
      Expand-Archive -Force $wz $Wacs
    }
    & (Join-Path $Wacs 'wacs.exe') --source manual --host "$Domain,www.$Domain" --validation filesystem --webroot $Acme `
      --store pemfiles --pemfilespath $Ssl --installation script --script $Restart `
      --accepttos --emailaddress $env:ACME_EMAIL
    if (Test-Path (Join-Path $Ssl "$Domain-chain.pem")) {
      Write-Vhost (Join-Path $Ssl "$Domain-chain.pem") (Join-Path $Ssl "$Domain-key.pem")
      Write-Host "HTTPS certificate installed. win-acme renews it automatically and restarts Apache."
    } else { Write-Warning 'win-acme did not produce a certificate. The site still works with the self-signed one behind Cloudflare.' }
  }
  Write-Host "Done. The game is at https://$Domain"
  return
}

# 4b. IIS site for the domain
if (-not (Get-Service W3SVC -ErrorAction SilentlyContinue)) {
  Write-Warning "IIS isn't installed. Point $Domain at http://127.0.0.1:$Port in the program that runs your website, with WebSockets enabled."
  return
}
if (Get-Command Install-WindowsFeature -ErrorAction SilentlyContinue) { Install-WindowsFeature Web-WebSockets | Out-Null }
else { Enable-WindowsOptionalFeature -Online -FeatureName IIS-WebSockets -All -NoRestart | Out-Null }
if (-not (Test-Path "$env:windir\System32\inetsrv\rewrite.dll")) {
  try { Install-Msi 'https://download.microsoft.com/download/1/2/8/128E2E22-C1B9-44A4-BE2A-5859ED1D4592/rewrite_amd64_en-US.msi' 'rewrite.msi' }
  catch { throw "Couldn't install IIS URL Rewrite automatically. Install it from https://www.iis.net/downloads/microsoft/url-rewrite and run this script again." }
}
if (-not (Test-Path "$env:ProgramFiles\IIS\Application Request Routing")) {
  try { Install-Msi 'https://download.microsoft.com/download/E/9/8/E9849D6A-020E-47E4-9FD0-A023E99B54EB/requestRouter_amd64.msi' 'arr.msi' }
  catch { throw "Couldn't install IIS Application Request Routing automatically. Install it from https://www.iis.net/downloads/microsoft/application-request-routing and run this script again." }
}
Import-Module WebAdministration
Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -Name 'enabled' -Value 'True'
Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -Name 'timeout' -Value '01:00:00'

Set-Content -Encoding UTF8 (Join-Path $Site 'web.config') @"
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <webSocket enabled="false" />
    <rewrite>
      <rules>
        <rule name="WARCORE" stopProcessing="true">
          <match url="(.*)" />
          <action type="Rewrite" url="http://127.0.0.1:$Port/{R:1}" />
        </rule>
      </rules>
    </rewrite>
  </system.webServer>
</configuration>
"@

if (-not (Get-Website -Name 'WARCORE')) {
  if (-not (Test-Path 'IIS:\AppPools\WARCORE')) { New-WebAppPool 'WARCORE' | Out-Null }
  New-Website -Name 'WARCORE' -PhysicalPath $Site -HostHeader $Domain -Port 80 -ApplicationPool 'WARCORE' | Out-Null
  Write-Host "Added IIS site WARCORE for http://$Domain"
}
Start-Website 'WARCORE' -ErrorAction SilentlyContinue

Write-Host ''
Write-Host "Done. The game is at http://$Domain"
Write-Host 'For HTTPS (the Windows app connects over wss://, so this is needed), get a free certificate with win-acme:'
Write-Host '  https://www.win-acme.com  ->  run wacs.exe, choose "Create certificate (default settings)", then pick the WARCORE site.'
