Set ws = CreateObject("WScript.Shell")
desktop = ws.SpecialFolders("Desktop")
Set shortcut = ws.CreateShortcut(desktop & "\FEAGLE WxBot.lnk")
shortcut.TargetPath = "C:\Users\Administrator\FEAGLEwxbot\apps\desktop\src-tauri\target\debug\feagle-desktop.exe"
shortcut.WorkingDirectory = "C:\Users\Administrator\FEAGLEwxbot"
shortcut.Description = "FEAGLE WxBot 微信智能中枢桌面客户端"
shortcut.IconLocation = "C:\Users\Administrator\FEAGLEwxbot\apps\desktop\src-tauri\icons\icon.ico"
shortcut.Save
WScript.Echo "[成功] 已成功在桌面创建快捷方式: " & desktop & "\FEAGLE WxBot.lnk"
