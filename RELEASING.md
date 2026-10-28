# 发布流程

## 仅更新维护文档

纯维护说明或排障指引更新可以只提交并推送文档，保持插件版本、锁文件、源码和已验收安装不变。先审查完整差异，运行 `pnpm check:repo` 验证仓库与文档引用；默认完整离线检查仍按 AGENTS.md 执行。不运行 `release:prepare`、不重新打包、不移动既有标签或覆盖 Release 资产；GitHub main 的文档可以新于发行标签，用户安装仍以原 Release 包及其校验值为准。

## 发布新的插件版本

本维护版只发布 GitHub Release；不执行 npm publish。使用与 package.json 一致的新版本，更新 CHANGELOG、README 与维护说明，保留 MIT 来源。

1. 运行 `pnpm install --frozen-lockfile`、`pnpm check`，审查源码和打包内容，不提交凭据、日志、浏览器资料及私有证据。
2. 提交到干净 main，推送本仓库，创建对应 `v<版本>` 标签。本版未配置远程 CI，不能把本地检查描述为远程 CI 通过。
3. 执行 `pnpm release:prepare`。脚本核对本地标签、HEAD、远程 main，运行完整本地检查与生产依赖审计（明确使用官方 npm registry，避免镜像没有审计接口），生成 `.local/releases/<版本>/` 下的 tgz、SHA256SUMS、release.json 和 notes.md；存在的产物不覆盖。
4. 在独立目录核对实际包的入口和原生宿主挂载；不自动登录或发送真实模型请求。将标签推送到 `QingLong-C/Plugin-DeepSeek-Web`，创建草稿 Release 并上传生成资产。
5. 从草稿下载资产，核对 SHA-256、版本、commit、目标标签与字节；全部相符后发布。发布状态、离线验证与真实功能验收分别记录，未验证的部分在说明中写明。

`npm pack` 只生成安装包，不是发布到 npm。安装本维护版应从本仓库 Release 获取 tgz，不使用上游 npm 的同名版本冒充。失败时保留已有包和证据；已公开版本需修复时发新版本。
