$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'FEAGLE WxBot.lnk'
$shortcut = $ws.CreateShortcut($shortcutPath)
$shortcut.TargetPath = 'C:\Users\Administrator\FEAGLEwxbot\apps\desktop\src-tauri\target\release\feagle-desktop.exe'
$shortcut.WorkingDirectory = 'C:\Users\Administrator\FEAGLEwxbot'
$shortcut.Description = 'FEAGLE WxBot Desktop Client'
$shortcut.IconLocation = 'C:\Users\Administrator\FEAGLEwxbot\apps\desktop\src-tauri\icons\icon.ico'
$shortcut.Save()
Write-Host "[OK] Desktop shortcut created: $shortcutPath"
