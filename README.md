# TokenFree · 个人维护版

让 DSH 使用你自己的 DeepSeek 网页账号进行对话、调用 DSH 工具和处理长对话，无需填写付费 API Key。模型在 DeepSeek 服务器运行，插件不新增代理监听端口。

这是在 [yuezengwu/dsh-tokenfree](https://github.com/yuezengwu/dsh-tokenfree) 上整合兼容修复的独立维护仓库，保留原项目 MIT 许可与贡献者署名。当前版本 **0.2.0-qinglong.2**，基线为上游 **v0.2.0**。

## 整合了什么

- 兼容 DSH 工具的 JSON Schema，修复工具装配阶段的报错；部分约束不能由兼容层完整表达，工具执行端仍须验证输入。
- 将默认输入上限与构造器上限统一为 **2,621,440 字符**，避免长对话被旧的本地限制提前拒绝；这不是 token 数或模型窗口保证。
- 压缩路由优先读取最新模型选择，修复切换模型后仍使用旧请求配置的问题。
- 修复已进入源码，重新构建会保留；旧安装的启动恢复入口和前端元数据保存在 `maintenance/legacy-compat/`，供维护者迁移。

## 怎么用

支持基线：macOS、DSH **0.2.1-rc.3**、已安装 Google Chrome。

1. 在 [Releases](https://github.com/QingLong-C/Plugin-TokenFree/releases) 下载本仓库发布的 `.tgz` 与 `SHA256SUMS`，校验后按 [安装与迁移说明](MAINTENANCE.md) 安装到目标 DSH profile。这个版本只发布 GitHub 安装包，没有发布到 npm。
2. 重启 DSH，打开「设置 → TokenFree」，在专用 Chrome 窗口中登录自己的 DeepSeek 账号。
3. 点击「使用」，或选择 **TokenFree · DeepSeek Web**。点击「使用」也会设为当前 profile 的默认模型。

已有旧版补丁包装入口的安装，迁移前应先看维护说明，避免新旧入口同时加载。只下载本发行包不会改动正在使用的插件。

## 使用边界

网页版接入是实验性方案。浏览器用于登录，生成请求由程序发送；不承诺防封、无限额度或长期兼容。网页协议、账号限制和服务端模型可能变化，固定插件版本不会固定官网模型快照。

工具调用通过文本协议桥接，不等同于官方 API 的原生 function calling。对话、相关文件和工具结果会发送到 DeepSeek；本地诊断可能包含任务内容，不能提交账号凭据或运行日志。

自动压缩按官网计数和有效预算的 50% 判断；预算不是模型总窗口。压缩后可以在原 DSH 对话继续，但摘要可能遗漏细节。自然达到门槛的整条真实链路尚未完成实测。

## 开发

```sh
pnpm install --frozen-lockfile
pnpm check
```

完整检查包含构建、类型、离线回归和实际打包检查；不会自动登录或发送真实模型请求。本维护版目前使用本地检查，没有配置远程 CI。源码结构和上游历史说明见 [原项目 README](README.upstream.md)，当前维护与发布规则见 [MAINTENANCE.md](MAINTENANCE.md)。

## 许可

[MIT](LICENSE)。原项目来源及本版改动见 [NOTICE.md](NOTICE.md) 与 [CHANGELOG.md](CHANGELOG.md)。本项目与 DeepSeek 官方没有隶属或背书关系。
