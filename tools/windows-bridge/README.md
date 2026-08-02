# Windows Bridge Tunnel Tools

这组脚本用于在 Windows 本机后台建立 Dashboard 与 AstrBot WebUI 的 SSH 隧道。

从仓库根目录运行：

```powershell
.\feagle.cmd bridge start
.\feagle.cmd bridge status
.\feagle.cmd bridge exit
```

首次安装为全局 `wxbot bridge` 命令时，仍可使用本目录的 `install.ps1`。工具不会保存
SSH 密码或私钥，也不会终止不属于自身管理的 SSH 进程。
