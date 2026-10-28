# Installs the House PC helper for this Windows user: copies it to %USERPROFILE%\HousePC and
# starts it at sign-in (a small launcher in the Startup folder, no window). Run again to update.
# Remove: delete %USERPROFILE%\HousePC and "House PC helper.vbs" from the Startup folder.

$ErrorActionPreference = "Stop"
$dir = Join-Path $env:USERPROFILE "HousePC"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Copy-Item -Force (Join-Path $PSScriptRoot "house-pc.js") $dir

$node = (Get-Command node.exe -ErrorAction Stop).Source
$startup = [Environment]::GetFolderPath("Startup")
$vbs = Join-Path $startup "House PC helper.vbs"
$js = Join-Path $dir "house-pc.js"
# 0 = no window, False = don't wait.
Set-Content -Encoding ASCII -Path $vbs -Value "CreateObject(""WScript.Shell"").Run """"""$node"""" """"$js"""""", 0, False"

# Restart it now.
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like "*house-pc.js*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Process wscript.exe -ArgumentList "`"$vbs`""
Write-Output "Installed: $dir (starts at sign-in)"
