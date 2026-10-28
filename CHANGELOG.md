# Personal maintained edition

## 1.3.2 (2026-10-28)

- 插件设置入口、模型提供方与登录提示统一为 DeepSeek Web。
- 维护仓库改为 Plugin-DeepSeek-Web，更新安装与发布链接。
- 保留已有安装包标识、账号目录、配置与模型路由，原作者及项目来源集中列于 README 末尾。

## 1.3.1 (2026-10-28)

- 使用宿主真实的 `sha256:<hex>` 附件身份，保持身份前缀传入原生附件存储；修正实机验收发现的图片预检误拒绝。v1.3.0 草稿未正式发布。
- 兼容官网文件的 `PARSING` 中间状态，处理期间保留文件身份并等待，避免把尚在解析误报为协议失败。
- 新增原生 DSH 图片附件读取、官网上传和生成引用；支持 PNG、JPEG、WebP、GIF，保留 `DeepSeek Web` 显示名、模型路由和全部配置结构。
- 图片上传与生成共享账号队列、请求间隔和限流冷却；按账号及思考模式保存上传记录，多轮对话和重启复用已确认文件，不重复上传历史图片。
- 接受状态不明、损坏记录、官网缺失文件或处理失败时暂停；取消后保留文件身份，后续手动请求继续查询。压缩、格式纠正和网页历史校验包含图片身份，避免错图或跨账号复用。
- 新增 20 项图片专项回归，覆盖正常链路、压缩、账号隔离、取消、重启、429、损坏记录及身份不匹配。未声称轮询账号、固定请求间隔或本地兼容修复能保证免封。

## 1.2.3 (2026-10-28)

- 包含 v1.2.2 的取消清理和损坏状态校验修复，保留 `DeepSeek Web` 显示名及原有配置结构。
- 修复工具规则中重复的 `type` 与同类型 `oneOf` 分支被宿主拒绝、进而阻塞整个工具目录的问题；仅移除可证明重复的外层类型，不改变分支含义或原始严格参数校验。
- 增加同类型联合、异类型/未知分支拒绝、原规则保留及整批工具目录正常交付回归，完整本地检查 300 项通过。

## 1.2.2 (2026-10-28)

- 修复取消任务时停止状态写入失败可能遗留账号租约和会话锁的问题；清理失败仍释放两种锁，保留原错误和未确认操作，不重发原请求。
- 状态文件仅在不存在时初始化；损坏的账号或会话根结构、空 confirmed 对象值统一报告存储错误并保留原文件，避免误重置或普通类型异常。
- 网页模型显示名统一为 `DeepSeek Web`，保留原 provider/model 路由、配置结构、账号与已有恢复策略；正常请求节奏不变。
- 新增 13 项异常边界回归，完整本地检查 297 项通过；损坏文件及写入失败使用隔离故障注入，未对真实用户数据实施破坏测试。

## 1.2.1 (2026-10-26)

- 修复网页纠错结果类型不符或改动原合格调用时遗漏备用模型接力的问题；保留原步骤的工具/最终回答类型，避免被拒候选覆盖原意图。
- 备用模型获得原始整批调用和允许修改的位置，修好后仍经完整规则校验再交付；保留整批执行和已完成步骤去重，不先执行部分调用。
- 可确定的缺失协议元数据、单层整体 JSON 编码及 DSML 冗余同名工具字段直接在本地归一，减少额外请求；显式身份冲突、歧义和无关正文继续拒绝。
- 修复经验仅在完整恢复约束通过后记为已解决，保留重启后复用、原账号排队、限流续跑、免费优先、预算和已有设置。
- 补充纠错接力、原冻结批次、最终回答保护与记忆复用回归，并新增桌面重启循环、本地认证 Cookie 和 profile 恢复排查说明。

验证：完整本地检查 284 项通过，修复安装包关键回归 51 项通过；真实桌面工具仅执行一次、退出码 0，并正常返回最终回答。故障接力使用 DSH 原生 AgentLoop 与受控响应验证，未故意触发真实付费兜底。适配基线为 macOS、DSH 0.2.1-rc.3；本版不修改宿主 Cookie 生命周期。

## 1.2.0 (2026-10-26)

- 增加可选多模型格式修复接力：本地恢复及网页自身纠正仍失败后，顺序尝试已配置渠道；正常响应直接交付，校验通过即停止接力。
- 修复模型只返回候选，不执行工具；保留原始参数、回答类型及整批提交检查，成功后由原任务执行一次，再携带真实结果返回网页继续。
- 接力成功复用持久格式经验，后续请求应用已验证提示和本地规则；不复用旧命令、不自动安装模型生成的补丁，失败仍标为待处理。
- 官方账号付费兜底默认关闭，可显式设置累计不超过 6 元的保守预算；增加跨任务预留、未知用量保留、价格核验期限、取消和超时控制。

## 1.1.0 (2026-10-25)

- 增加持久化格式恢复记录：按工具目录和输出策略隔离，自动记录待解决问题、出现次数、校验通过的处理方式与原始日志关联；重启后保留，修复再次失败会重新标为待解决。
- 生成和纠正请求可复用曾通过校验的固定格式提示，已有本地恢复仍优先执行；不存储或重放旧命令，不自动加载模型编写的补丁，不增加模型纠正次数。
- 协议纠正请求在输入预算允许时附上本次失败响应和校验原因，作为待修复数据；保留权威任务上下文、原始参数校验及已完成步骤。
- 增加持久化、并发写入、再次失败、当前 schema 拒绝、错误回答类型、损坏记录与输入预算回归。记录中的已解决仅表示格式通过校验，不能代替工具执行或整个任务成功。

## 1.0.6 (2026-10-25)

- 完整 JSON 对象或数组之后的多余结束符统一按语法恢复，支持 `}`、`]` 的混合组合；沿用 8 次编辑预算，保留字符串和参数值，不删除容器内部错配或额外数据。
- DSML 参数与普通响应、模型纠正结果复用该规则，减少可本地恢复的问题触发额外模型纠正；保留工具/最终回答类型检查和原始 schema、身份、策略及整批提交门。
- 新增全组合根结束符测试、DSML 适配器与原生 AgentLoop 单次执行回归，补充错误分类及恢复规则维护方法；保留账号排队、限流续跑、设置和此前补丁。

## 1.0.5 (2026-10-25)

- 包含 v1.0.4 的统一语法恢复与全部既有补丁；结构、参数和最终回答共用有界校验与恢复流程。
- 身份不符在所有语法候选中均为终止错误，不会被候选筛选降为格式错误或触发额外模型请求。
- 增加“结构损坏与错误身份同时出现”的适配器回归：零工具派发、仅一次上游生成、保留原始 WEB_IDENTITY；保留已完成步骤与设置。

## 1.0.4 (2026-10-25)

- 用有界 JSON 语法搜索统一恢复对象、数组和多调用之间缺失的结束符、逗号与冒号；完整字符串和数值不改，保留控制字符编码、围栏和错层字段兼容。
- 用同一套原始工具契约比较所有最低修改成本候选；字段归位后含义相同可交付，不同含义、缺值、重复键及搜索超预算不猜着执行，整批校验后才进入原生工具。
- 首次响应和模型纠正共用恢复入口，向纠正流程提供固定的歧义、预算或语法原因；保留阶段进展判断、账号排队、限流等待、取消与持久提交规则。
- 增加独立单符号修复判定、组合损坏、资源上限和真实 AgentLoop 双调用单次执行测试；维护文档说明官方 API 约束与网页文本桥接的实际差别，不承诺任意错误或未知协议永久兼容。

## 1.0.3 (2026-10-25)

- 统一 JSON 字符串控制字符的无损转义与流式解码，覆盖换行、回车、制表符等完整范围；正文与工具参数保留解码后的原值，不修改命令或放宽 schema。
- 最终回答已进入流式预览但完整协议校验失败时，核实官网终态与身份后可用共享额度纠正一次；只能返回完整回答替换预览，禁止转为工具调用或重放已完成步骤。
- 将通用协议故障显示为“响应协议格式错误”，与原始参数规则、官网限流、内容过滤和鉴权错误区分，避免最后总结失败被误报成工具参数错误。
- 增加原生 AgentLoop 完整正文落盘、预览替换及零工具派发验证，覆盖控制字符与标点的组合破坏、取消、鉴权、过滤、身份及限流边界；现场响应只离线重放，既有补丁、账号和设置保留。

## 1.0.2 (2026-10-25)

- 格式恢复先判断进展，再决定是否继续：通常只纠正一次；仅协议已完整恢复且剩余错误为明确参数规则时，再允许一次定点纠参，不再重建整轮任务。
- 无进展、重复损坏、策略不符或额度耗尽时停止；追加纠参冻结工具名称、顺序、数量及已合格调用，保留已执行动作去重。
- 追加纠参仍共用账号排队、限流退避、取消与持久提交边界；兼容旧单次纠正记录，错误提示按实际次数显示。
- 包含 v1.0.1 的无损结构归一，补齐阶段进展、无进展拒绝、混合批次冻结、取消/限流、状态兼容及原生工具单次执行验证。

## 1.0.1 (2026-10-25)

- 在每次响应（含自动纠正结果）进入严格校验前，恢复单个 JSON 根外有限的格式符号；按当前工具原始声明把放错层级的字段无损归入 arguments，不补值、不改命令、不覆盖冲突字段。
- 可确定的本地恢复不增加官网请求、不占用一次模型纠正额度；其他格式失败继续共用统一恢复层，纠正提示携带本次校验原因与正确参数层级。
- 增加 3,840 组跨工具声明、字段分布与组合损坏测试，覆盖连续损坏、冲突/未知字段、原始校验拒绝及原生工具只执行一次。有限测试不等于穷举任意模型文本。
- 保留账号排队、限流自动等待续跑、strict、压缩、模型路由和现有设置；无法确定的缺值或歧义仍整批拒绝，不把已完成动作重新执行。

## 1.0.0 (2026-10-25)

- 官网明确限流且请求未被接受时，自动等待账号冷却后继续当前生成；保留同一原生任务、请求内容、父分支和已完成的工具结果。
- 正常用量查询与明确拒绝的建会话请求也遵守冷却；等待不占用随后生成超时，支持取消、退出账号和宿主销毁。
- 保留原始参数校验、统一格式恢复、摘要、模型路由及设置修复；部分输出、接受状态不明或分支变化时不自动重复提交。
- 采用 v1.0.0 数字版本基线，完善用途、使用、注意事项、部署和版本维护说明；历史发布保持不变。

## 0.2.0-qinglong.11 (2026-10-25)

- 同一官网账号共享跨进程生成队列，普通生成、摘要及格式纠正统一间隔；等待不消耗后续生成超时，取消与账号撤销正常释放票据。
- 限流后持久暂停并指数退避，保留 HTTP Retry-After；停止核实改为最多三次有间隔观测，减少无效查询。
- 对有精确限流与原生失败证据、官网确认请求未落地的遗留操作安全结算，保持原确认分支及已完成工具，不再被旧 PENDING_OPERATION 永久阻塞。
- 保留 strict、统一格式恢复、压缩、模型路由、中文错误提示及原有配置；不增加账号轮换或限流自动重新生成。


## 0.2.0-qinglong.10 (2026-10-25)

- 识别官网 SSE hint 的明确 `rate_limit_reached`，保留清空输出动作并传递 RATE_LIMIT，避免误报未知撤回；没有清空标志时也直接保留限流原因。
- 客户端对本插件的明确限流及 HTTP 429 显示“官网限流”，提示稍后继续未完成步骤；其他提供方限流沿用原生界面，未知撤回、内容过滤和已有格式提示保持区分。
- 限流不触发格式纠正或断流恢复，不增加模型重试、账号轮换、队列或新设置；清空后的正文预览不回流。保留全部既有补丁。
- 增加原始控制帧形状的离线回归，覆盖清空/不清空、流式预览、HTTP 429、普通正文误判和客户端插槽卸载回退。

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
