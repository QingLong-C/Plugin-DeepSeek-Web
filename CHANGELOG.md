# Personal maintained edition

## 0.2.0-qinglong.9 (2026-10-25)

- 把外壳、参数、整段协议、工具选择与结构化输出失败统一接入按阶段/交付状态判断的恢复控制器；取消坏格式前缀准入，所有策略共用一次纠正额度及原生提交检查。
- 流式预览不再因坏转义或重复字段提前终止官网收集；确认终态和身份后统一判定，已经显示正文时保持不重发。
- 从原生上下文标识中区分真实用户任务与环境/技能/时间快照，避免快照遮蔽已交付调用；补齐纠正未发送时的冷恢复及操作日志完整性校验，兼容旧合法记录。
- 新增结构变异语料、分块预览、准入矩阵、六策略生命周期与二次失败零派发测试；保留全部既有补丁、模型路由和设置，无新依赖。

## 0.2.0-qinglong.8 (2026-10-25)

- 对已核实完成、未交付的损坏 DSML 或可识别 JSON 工具协议，按真实 DSH 上下文重新生成一次；不从损坏文本提取命令或采信模型自行生成的工具结果。
- 与外壳/参数修正共用一次新生成预算；整批经过原始 schema、目录、策略和宿主检查，拦截无工具的成功叙述及本任务内完全相同的已交付调用。
- 保留同响应恢复、取消、准备失败与持久提交边界；二次仍错显示已自动纠正一次，不扩大上游过滤、身份或权限错误的重试范围。
- 无新增依赖或设置，保留全部已有兼容修复；该恢复不保证任意语义变化都可自动识别。

## 0.2.0-qinglong.7 (2026-10-25)

- 已识别的工具参数规则错误，在交付前自动反馈给模型纠正一次，再做完整批次/策略/宿主校验。
- 与外壳格式修正共用一次生成预算；不改变工具名、顺序、数量或已合格调用，不重跑已执行工具。
- 覆盖二次失败、无效候选、改名/增删/重排、取消、准备拒绝、断流恢复、持久提交与原生目录变更。保留全部 `.6` strict、格式恢复和配置。
- 无新增依赖或设置；失败时说明已经自动纠正一次。

## 0.2.0-qinglong.6 (2026-10-25)

- 每步发送绑定请求/工具目录的本地 strict 返回契约，完整执行原始工具与最终输出 JSON Schema。
- 新增固定版本 Ajv/ajv-formats，支持三种常见方言；生成前拒绝不能完整校验的规则。保留宿主校验、有限格式恢复和全部已有兼容补丁。
- 不补默认、不强转、不删参数；非法混合批次全部拒绝，不为参数错误额外生成。规则错误显示直观中文原因。
- 该能力属于本地校验，不是官网服务端 strict 开关。

## 0.2.0-qinglong.5 (2026-10-25)

- Recover bounded JSON punctuation defects in complete DSML parameters and JSON response envelopes: redundant root closers, trailing commas, missing closing delimiters after complete values, and whole-response fences. Decode one encoded arguments object where the schema does not declare a literal arguments property.
- Preserve scalar tokens and command string bytes; retain duplicate-key detection, tool catalogue, schema, identity, policy and host approval checks. Validate the complete batch before exposing executable blocks. No additional model generation is used for local syntax recovery.
- Record a content-free local-syntax repair event. Show readable “工具参数格式错误” for unrecoverable cases, retaining WEB_TOOL_FORMAT and explaining that the failed step was not executed and earlier actions remain.
- Add recovery/rejection cases, generated nested-value regression coverage and real adapter checks, including composition with the existing bounded wrapper repair. Freeze the retired legacy wrapper payload instead of applying new code to its old installation baseline.
- Preserve the existing schema, input, compaction/model-routing, DSML and content-filter-display fixes. This improves known format families, not arbitrary missing values or future website protocols.

## 0.2.0-qinglong.4 (2026-10-25)

- Show “官网内容过滤” for explicit upstream CONTENT_FILTER responses, and “官网撤回了回答” for withdrawal without a reported reason. Preserve CONTENT_RETRACTED for diagnostics and existing recovery behavior.
- Replace the affected terminal error heading through DSH's public keyed Chat slot. Recognize persisted older errors without regenerating content; delegate unrelated errors to the live native renderer and release the override on unload.
- Add readable host/CLI error messages and regression coverage for filtering, unknown withdrawal, original fallback, late renderer registration and unload. Do not retry filtered requests or treat them as successful responses or tools.
- Keep the existing schema, long-input, model-selection and DSML compatibility fixes. No website protocol or model routing change is included.

## 0.2.0-qinglong.3 (2026-10-25)

- Decode complete DeepSeek DSML tool batches into the existing JSON/native tool pipeline without an extra formatting request.
- Preserve exact names and typed arguments; reject malformed, ambiguous, duplicate, mixed-prose and oversized batches before dispatch. Keep existing schema, policy, catalogue and host execution checks.
- Add focused DSML regression cases and exercise DSML tool/result exchange through the actual DSH LlmRuntime with mocked official HTTP.
- Add codec.js as the fifth hash-checked legacy startup recovery target while retaining the v0.2.0 installation baseline.
- Validate live DSML dispatch and a completed 1080p video download on the existing macOS DSH 0.2.1-rc.3 installation. One malformed parameter batch was rejected; the subsequent verification turn completed. Full video/audio decode passed. This does not imply arbitrary malformed-response recovery or installation of the full new tgz into Desktop.

## 0.2.0-qinglong.2 (2026-10-25)

- Integrate DSH tool schema subset compatibility into TypeScript sources.
- Align the default and maximum local input guard at 2,621,440 characters, with runtime configuration diagnostics.
- Prefer the latest pending model selection when choosing compaction routes.
- Preserve a standalone installable package and legacy startup recovery materials, including client metadata.
- Align repository links and active contribution/release documentation with this maintained edition.
- The earlier qinglong.1 source tag remains as an initial snapshot; no release assets were published for it.
- Base: upstream v0.2.0, commit 6a57b2f9c512bacafe678868c08ef47bb7b484fe.

The following entries describe upstream releases.

# 变更记录

## 0.2.0 (2026-10-24)

首个可安装的公开版本。支持 macOS、DSH 0.2.1-rc.3 和 Google Chrome；网页适配器仍为实验性。

- 专用官方窗口登录，桌面、CLI、本机 Web 共用本人单账号；插件无新增端口。
- 会话独立并发，复用网页 chat、增量上下文、流式思考/正文、精确停止及断流恢复。
- 工具 auto/none/required/named、目录版本与原生执行前校验、JSON/schema 最终输出；权限与执行继续由 DSH 管理。
- 官网 C/B 达 50% 时触发原生压缩/checkpoint，在原 chat 生成摘要后新建 chat 续聊；缺 B 使用标明来源的 890,880 默认预算，缺 C 不估算。
- 最少状态单卡片、官网计量、本地请求与恢复诊断；日志本地保留，不自动清理。
- 发布采用精确提交 CI、冻结 tgz、SHA-256/integrity、npm 与 GitHub 同一包，并进行公开安装核对。
- 发布前升级 Zod 至 4.6.6，修复 GHSA-mrhx-c7xc-m3w5；同步客户端完整许可，并将生产依赖高危审计纳入发行门槛。

已知限制：网页工具是文本桥接；搜索关闭，文件/图片/音频输入未接入。自然 50% 自动压缩、新策略/JSON 的完整真人组合及部分跨宿主场景仍未验收；官网撤回后历史缺失可能使原会话保持待核实，独立分叉可继续。不能据本次发布声称全部已确认规格已完成实机验收。

## 内部开发记录（首次公开前）

- DSH 兼容基线与整套 SDK 依赖升级至 0.2.1-rc.3，重新解析锁文件以移除残留 rc.2 间接 peer；补齐 README 两张截图的分发清单及包检查。

- 补齐会话级工具 auto/none/required/named 与 text/JSON/schema 最终输出，提供本地 CLI 和 owner Remote；一次性要求在原生持久保存后原子消费，恢复、取消、修正及摘要不提前消耗。
- 固定目录版本与执行快照，在生成前、完整交付前和原生审批后校验，拒绝失效定义及嵌套搜索；卸载时已保存的未完成调用继续拒绝，重载不阻塞新调用。结构化结果完整验证后交付，复用 DSH schema 子集。

- 修复标准模式自动压缩接线：主插件通过公开生命周期接入现有 Basic 槽位，不要求用户配置；保留其他模型策略、自定义后端及卸载恢复，普通请求联网前检查完整链路。卡片收敛为账号三态、DSH 四态，用量只显示官网数值或 `—`。

- 压缩门槛调整为有效预算 B 的 50%，整数向上取整。B 优先使用当前模式官网值，读取不到时使用用户指定默认 890,880（门槛 445,440）；持久状态、Remote 与辅助详情区分官网和默认来源。C 继续只使用官网原值，缺 C 不触发，认证、网页验证和取消不走预算兜底。

- 实现多会话并发：删除账号生成队列/全局 active/全局收尾链；各会话原子保存 confirmed/active，生成、停止、恢复、压缩和官方计量独立。
- 旧活动状态备份后按原 store/session 迁移；同会话双写明确返回忙，迟到核实/停止按 operationId 和 compactionId 拒绝。
- 登录窗口不阻塞可用凭据；旧 AUTH 不覆盖新登录，替换登录失败保留有效账号；撤销仍同步影响三端。
- 日志按操作收尾，PoW 资源原子发布；补充并发重叠、独立取消/恢复、原生压缩、认证竞态、损坏文件、日志等待及跨进程锁验证。桌面双会话真实生成重叠、独立停止与上下文/官网用量隔离已通过；其他并发组合仍待实测。

- TokenFree 设置收敛为两行单卡片，官网地址和右侧操作同高，账号/DSH/用量横排；“使用”接入 DSH 原生选择并分别核实默认状态。
- 真实短文本对话已验证官网用量刷新；详情仅在当前指标失效时标记旧观测，避免把已确认值重复称为旧值。

- 修正 Node 22 跨入口撤销测试中模拟流的存活与清理，保留真实撤销和停止断言；生产计时器与退出逻辑不变。
- usage UI 测试自行准备临时目录，去除对其他测试先创建目录的依赖。
- 客户端及 npm 包保留 Zod 完整许可；补齐随包文档及其公开源码引用，打包检查改为解包后核对许可和本地链接，并补充拒绝缺失内容的回归。

- 恢复插件专用 Chrome 官方窗口登录，移除浏览器扩展及 Native Messaging；三端共用凭据，退出清除专用资料，不读取日常 Chrome。保留跨入口迟到登录提交保护，并串行浏览器关闭和资料清理。

- usage 面板增加“停止摘要”，复用 DSH 原生取消；先停止已接受的精确响应，再在独立期限内完整核实，避免 ready 后首次历史核实失败而漏发 stop。增加脱敏停止核实错误分类与历史滞后回归。
- 真实摘要 SSE/JSON 22、取消、显式手动重试及新版空闲退出同步已覆盖，详见[第三轮复测](RECOVERY_TEST_RESULTS.md)；完整本地检查 79 项通过。

- 实机修复 CLI JSON stdout、正常退出前原生结算等待、崩溃/取消缺 assistant 的精确中断核对、ABORTED/TIMEOUT 日志与空闲账号状态同步。
- 独立 CLI/Web、真实 SSE/JSON 22、离线停止及核实、宿主崩溃、分叉、官网旁支与 Web 原生压缩已有[复测证据](FOLLOWUP_TEST_RESULTS.md)；完整本地检查 78 项通过。自然 80% 与其余列明子项仍未验收。

- 修复插件子作用域核实原生提交时的 sessions 服务访问，保留 public flush 与游标提交顺序。
- 工具文本桥接在引用上下文后附独立响应契约，减少真实网页模型返回 DSML 的格式失败；仍严格拒绝非法工具输出。
- 首轮桌面实机结果：多轮/工具/流式/停止/重启和手动压缩闭环通过；当时未覆盖的 CLI/Web 后续结果见复测记录。

- 官网 C/B、模式/配置来源/观测时间、80% 精确门槛、会话 usage 面板和只读 CLI usage；不估算或虚构单次 usage。
- 同包导出 Basic 派生压缩后端，在原 profile/preset 位置选择；复用原生摘要、缩短校验、checkpoint 和 flush，其他路由交回原生。
- 在原 chat 独立根分支生成准确摘要，原生提交后新 chat 续聊；失败/取消阻断、同响应恢复、初始化失败不重复摘要。

- 第一阶段主链：一个 npm 包内落地 dsh/core/deepseek-web/local 四组。
- 同 DSH session 持久复用官网 chat；增量消息、真实工具结果与指令/目录替换；历史编辑/分叉从有效上下文建新 chat。
- 正文/思考流式；同响应 SSE/完整消息恢复，最多两次；独立停止与历史确认，未知状态暂停。
- 账号级跨进程生成锁、原子状态、撤销代次；原生保存/flush 后才确认游标；取消缺 replayState 与提交中断可恢复。
- 完整协议、身份与工具 schema 校验、原始逻辑 SSE/停止/恢复/提交追加日志；不添加端口。
- 增加 owner 核实/停止遗留请求、CLI inspect/rebuild。后续补齐官网计量与压缩；该实现阶段仅离线验证。

- 已有本地实验 MVP：本人官网登录、文本对话、工具文本桥接与本地诊断。版本字段 0.2.0 不代表已经公开发布。
- 产品与技术方案完成 Review 修订：一个包四组模块、原生默认选择、停止与修正归属、原子状态提交。目标功能尚未按整体方案实现。
- 准备固定 pnpm、默认离线检查、显式 Chrome 夹具、npm 包检查、GitHub CI 及开源协作文档。
- 第二轮复核明确 headless 原生入口与 profile 边界；修正干净 checkout 的构建/类型检查顺序，私有证据保留并从公开文档移除标识。

公开发布后才新增带版本与日期的发行条目，分别记录功能、修复、兼容和迁移变化。
