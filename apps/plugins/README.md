# FEAGLE WxBot 外部插件插槽规范 (Plugins Specification)

本目录为 FEAGLE WxBot 统一外部轻量插件插槽目录。

## 目录结构
```text
apps/plugins/
├── my-plugin/              # 插件名目录（推荐通过 git clone 引入）
│   ├── index.js            # 插件入口文件（必须导出注册函数或类）
│   ├── package.json        # 依赖描述（如有）
│   └── README.md           # 插件使用文档
```

## 插件安全与宿主校验契约
为防止插件被未授权平台滥用或跨宿主调用，所有插件必须遵循如下宿主环境安全契约：

```javascript
/**
 * 示例插件入口 index.js
 */
module.exports = function registerPlugin(ctx) {
  // 1. 宿主签名校验（防滥用保护）
  if (typeof ctx.verifyHost === 'function' && !ctx.verifyHost('feagle-bridge-core')) {
    throw new Error('[Security] Host verification failed! This plugin only runs in official FEAGLE Bridge environment.');
  }

  // 2. 注册指令拦截器（0 Token 秒回毫秒级响应）
  ctx.registerCommand({
    command: '/ping',
    description: '健康检查回执',
    handler: async (event) => {
      return { reply: 'pong! FEAGLE Bridge 运行正常 🚀' };
    }
  });

  // 3. 监听微信事件钩子
  ctx.on('message.received', async (message) => {
    // 自定义处理逻辑
  });
};
```

## 隔离规范
1. **零污染**：插件不应直接修改 Bridge 底层网络与微信长连接核心状态。
2. **轻量原则**：本地前缀快速指令由插件直接拦截秒回，耗时复杂的重度智能体任务通过 OneBot 协议派发给下游后端（Hermes / AstrBot）。
