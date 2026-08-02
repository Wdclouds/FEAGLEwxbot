# Windows Android Tools

这组 PowerShell 工具负责 ADB 检查、固定工具链准备、微信安装指纹验证、Android Agent
构建/安装、状态检查和一次性配对。

建议从仓库根目录使用统一入口：

```powershell
.\feagle.cmd android doctor
```

第一次部署请从
[`docs/android/quickstart.md`](../../docs/android/quickstart.md)开始；命令参考见
[`docs/android/index.md`](../../docs/android/index.md)。运行时下载、APK、设备
状态和诊断输出只保存在被 Git 忽略的本地目录中。
