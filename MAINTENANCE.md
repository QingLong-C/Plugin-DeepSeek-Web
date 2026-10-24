# 安装与维护

## 来源与版本

本仓库独立维护，基于上游 `yuezengwu/dsh-tokenfree` 的 v0.2.0，提交 `6a57b2f9c512bacafe678868c08ef47bb7b484fe`。保留 MIT 许可。`README.upstream.md` 及其他上游设计、测试文档是继承资料，不能当作本维护版重新完成了全部实机验收。

当前源码发行号为 `0.2.0-qinglong.2`。原有 `0.2.0 + 外部兼容入口` 可以继续使用；不要因为出现自己的安装包而自动替换正在工作的环境。

## 下载和安装

下载 Release 中的 tgz 和 SHA256SUMS，在下载目录校验：

```sh
shasum -a 256 -c SHA256SUMS
```

DSH 的插件安装目标是 profile。CLI 可用且目标 profile 没有被桌面占用时，使用其原生安装命令，文件名替换成实际下载路径：

```sh
dsh plugin --profile desktop add /ABSOLUTE/PATH/dsh-tokenfree-0.2.0-qinglong.2.tgz
```

若客户端拒绝本地路径或 desktop 被独占，停止后按该 DSH 版本的本地包安装方式处理；不要改用 npm 上游同名版本冒充本版。维护者可把 tgz 固定进 profile 的 vendor，使用应用自带 pnpm 安装 `file:./vendor/dsh-tokenfree-0.2.0-qinglong.2.tgz`，并核对 `package.json` 的 `dsh.profile.bundles` 含 `dsh-tokenfree`。已有 pnpm store 或依赖冲突应单独修正，不全量重建 profile。

重启后核对实际安装版本、TokenFree 设置卡片、登录状态及唯一活动插件，再测试普通对话和真实工具往返。安装命令成功不等于业务验收通过。本版完整安装到新的真实桌面环境尚未验证。

## 从外部补丁入口迁移

`maintenance/legacy-compat/` 保存旧启动恢复入口，只匹配其 manifest 已知来源。它的 client.js 是指向原插件客户端的相对软链，只有放在 profile 的 `local-plugins/tokenfree-compat/` 后才有意义；不要直接在仓库运行它。

新版源码已经整合三个兼容修复，正常安装不需要旧包装入口。迁移前备份 vendor 包、锁文件、profile patch 和整个外部兼容目录；禁用旧包装条目，并恢复正常 `dsh-tokenfree` bundle 条目，确保只加载一份。不要将旧 payload 覆盖新源码；未知哈希应停止并重新适配。

前端入口依赖活动 package 的 `dsh.client`、client export 与客户端文件，不能只验证主机插件。若设置页消失但仍能对话，应核对这些元数据与活动入口。

## 后续升级

保持当前已验收版本，不自动跟随上游。需要升级时：对比提交和依赖；逐项判断 schema、输入限制、模型选择修复是否仍需要；在独立目录适配后运行完整检查。通过普通对话、工具往返、双向模型选择及长对话检查后，再安排真实环境迁移；失败恢复原包与对应入口。

兼容层会删去宿主不支持的 schema 约束，不是无损转换；工具实现须验证完整参数。字符上限不是额度或真实模型窗口。自然门槛自动压缩和精确网页模型快照仍不应标为已实测。

## 账号与请求

网页登录不代表后续请求来自真实浏览器。不要把改请求头、IP 或项目 star 数当作防封证据。限制并发、尊重服务端退避、限制重试、遇到账号限制停止请求，可以减少异常压力，但不能证明规避检测。没有已验证的安全调用频率；小号也不改变检测概率。

同类项目的封号与失效报告应按原始 issue 核验，区分作者陈述、用户反馈与官方说明。不要复制多账号轮换建议作为防封保证。服务端模型更新与插件升级独立，是否需要更新取决于协议兼容及实际修复。

## 发布

本仓库只发布自己的 GitHub Release，不冒充上游发布，不向 npm 发布同名包。每个版本使用新标签和新产物，保留来源、改动及校验值；不移动已公开标签。准备流程见 [RELEASING.md](RELEASING.md)。
