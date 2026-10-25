# TokenFree

让 DSH 使用你自己的 DeepSeek 网页账号完成对话、工具任务和长对话处理，无需配置 API Key。模型在 DeepSeek 服务器运行，工具由 DSH 在本机按原有权限执行。

当前版本：**v1.2.0** · [下载安装包](https://github.com/QingLong-C/Plugin-TokenFree/releases/latest) · [版本记录](CHANGELOG.md) · [维护指南](MAINTENANCE.md)

本仓库基于 [yuezengwu/dsh-tokenfree](https://github.com/yuezengwu/dsh-tokenfree) v0.2.0 独立维护，整合兼容性与可靠性修复，保留 MIT 许可及原作者署名。

## 项目用途

- 将 DeepSeek 网页对话接入 DSH，支持原生工具审批、执行结果和会话历史。
- 提供工具协议解析、原始参数规则校验及交付前按错误类型自动格式纠正。
- 保存格式错误和通过校验的处理方式，重启后可复用对应格式提示；未解决问题保留待处理状态和本地日志关联。
- 可选多模型格式修复接力：当前网页纠正失败后顺序调用配置的其他渠道，通过原始校验才继续；正常响应不调用后备模型。
- 同账号请求排队；明确限流且确认没有被接受时，等待冷却并继续当前请求。
- 根据官网分支用量处理长对话压缩，保留模型路由与设置入口兼容修复。

## 怎么用

1. 按下方部署步骤安装并重启 DSH。
2. 打开「设置 → TokenFree」，在插件专用 Chrome 窗口登录自己的 DeepSeek 账号。
3. 点击「使用」，或选择 **TokenFree · DeepSeek Web**；点击「使用」也会设为当前 profile 的默认模型。
4. 在 DSH 中正常对话和调用工具。当前任务仍运行时，符合恢复条件的官网限流会自动等待后继续，无需手动发送“继续”。

## 注意事项

| 项目 | 说明 |
| --- | --- |
| 兼容基线 | macOS、DSH 0.2.1-rc.3、Google Chrome；其他宿主版本需重新验证 |
| 网页服务 | 使用网页协议，属于实验性接入；不是官方 API，也不保证同等稳定性或账号安全 |
| 自动等待 | 默认 60 秒冷却，连续限流逐级退避，最高 15 分钟；有效 Retry-After 作为下限，最长记录 24 小时 |
| 防止重复 | 仅重试明确未接受且无输出的当前生成；需要时核对新鲜完整历史及原父分支，保留已完成工具结果 |
| 无法自动恢复 | 部分输出、接受状态不明、父分支变化、登录失效和官网过滤需分别处理，不盲目重发 |
| 任务生命周期 | 用户取消、退出账号或关闭宿主会终止等待；重新打开只保留冷却，不自动唤醒已结束任务 |
| 格式纠正 | 本地 strict 是提示约束与返回后校验，先本地恢复；通常一次模型纠正，仅协议收敛为明确参数错误时再定点纠正一次，不保证模型永不出错 |
| 后备修复 | 默认关闭，须配置已登录渠道；免费优先，可显式开启官方账号限额兜底。只处理已确认的格式失败，详见维护指南 |
| 模型和用量 | 固定插件不固定官网默认模型；用量是当前网页分支计数，不是账号余额；压缩摘要可能遗漏细节 |

保持已验证版本，按实际协议或兼容性变化决定升级；升级前备份 profile、vendor 包、账号数据及其他插件补丁。详细恢复边界和排障见 [维护指南](MAINTENANCE.md)。

## 部署步骤

### 安装发行包

1. 从本仓库 [Releases](https://github.com/QingLong-C/Plugin-TokenFree/releases) 下载对应版本的 `.tgz` 和 `SHA256SUMS`。本维护版只通过 GitHub 发布，不使用 npm 上游同名包代替。
2. 在下载目录校验完整性：

```sh
shasum -a 256 -c SHA256SUMS
```

3. 备份后退出占用目标 profile 的 DSH。CLI 可用且该版本支持本地包安装时执行：

```sh
dsh plugin --profile desktop add /ABSOLUTE/PATH/dsh-tokenfree-1.2.0.tgz
```

如宿主不支持该本地路径形式，按 [profile vendor 安装说明](MAINTENANCE.md#下载和安装) 固定安装包及依赖，保留正常 `dsh-tokenfree` bundle；旧兼容包装入口需先迁移，避免重复加载。

4. 重启后检查实际版本、设置页与登录状态，再验证一次普通对话和工具往返。安装退出码为零不等于运行验收通过。

### 从源码构建

需要 Node.js `^22.19.0 || >=24`、pnpm `10.12.1`，以及可安装的 DSH SDK 依赖：

```sh
git clone https://github.com/QingLong-C/Plugin-TokenFree.git
cd Plugin-TokenFree
pnpm install --frozen-lockfile
pnpm check
```

发布安装包遵循 [发布流程](RELEASING.md)，使用最终提交、新标签和冻结产物。不要将源码目录直接覆盖正在运行的 profile。

## 许可

[MIT](LICENSE)。来源、原作者和第三方说明见 [NOTICE](NOTICE.md) 与 [第三方许可](THIRD_PARTY_NOTICES.md)。
