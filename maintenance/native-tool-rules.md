# 原生工具规则与网页桥接维护基线

## 登录方式与工具协议分开判断

DSH 的 `deepseek-account` 使用平台账号 grant，经 `x-dsh-auth-token` 交给 Messages provider；无需填写 API Key，并不等于调用网页版。已检查构建的默认 Messages 地址为 `https://api.deepseek.com/anthropic/v1/messages`，可被受信配置覆盖。其工具定义作为 `tools[].input_schema` 单独发送，返回工具块与 `input_json_delta`。

TokenFree 保留网页版 `chat.deepseek.com/api/v0/chat/completion`，工具目录与返回契约序列化在 prompt 中。复制请求字段、schema 转换函数或客户端解析器，不能证明网页后端执行了原生工具约束；不能把另一 OpenAI 适配器中的 strict 逻辑当作 DeepSeek Account 已开启 strict 的证据。

原生 Messages 也会在工具 JSON 非法、块未关闭、缺结束原因或流提前结束时报错。因此可借鉴的是统一的契约与生命周期，不存在已从客户端取得、可保证任意错误自动修好的规则集。平台账号与网页账号的额度来源也不得混同；不要为修格式错误自动切换渠道、账户或模型。

## 统一规则

| 规则 | TokenFree 执行位置 | 验证入口 |
| --- | --- | --- |
| 每步明确工具目录、参数声明和返回类型 | `src/core/codec.ts`；按当前声明生成契约 | `tests/strict-schema.test.mjs`、策略回归 |
| 请求身份、工具目录版本与原始规则不混用 | `src/core/codec.ts`、`src/dsh/tool-policy.ts` | identity 与目录变化回归 |
| 流式展示不作为可执行参数；完整响应和官网历史确认后再判断 | `src/core/session.ts`、`src/deepseek-web/sse.ts` | response-boundary、native 回归 |
| 字符串及参数值不改，不强转、不补默认、不删多余字段 | `src/core/json.ts`、`src/dsh/strict-schema.ts` | grammar-recovery、strict-schema 回归 |
| 损坏语法比较全部最低成本解释，原始 schema 决定唯一含义 | `src/core/json.ts`、`src/core/codec.ts` | 独立判定器、组合破坏、歧义拒绝 |
| 整批合格才交给宿主；执行前再次检查有效工具声明 | `src/dsh/adapter.ts`、`src/dsh/tool-policy.ts` | 真实 AgentLoop 受控传输与工具 guard 回归 |
| 剩余格式错误共用有界纠正；追加尝试必须有明确阶段进展 | `src/core/recovery.ts` | recovery-progress 与 unified-recovery 回归 |
| 使用真实工具结果续步，区分生成、交付、执行和持久提交 | `src/core/session.ts`、原生边界 | native、tool-policy、journal 回归 |
| 限流、登录、过滤、取消、执行错误分别处理，不进入无差别格式重试 | session、网页客户端与账号准入 | 既有限流、账号、取消和重试回归 |

这些规则已在 v1.0.5 的执行链中存在，本次对照不表示新增了一套生成端 strict，不修改原有 schema 语义，也不增加重复的纠正入口。

## 新问题的处理要求

先按传输、终态/身份、协议、参数、策略、交付、执行、提交定位实际失败层，再检查该层通用不变量。只有真实证据显示规则缺口时才修相应层，并把该类问题加入生成式回归；不要先追加某个字符串的正则、无条件重试或宣称穷举所有模型输出。

未知字段、缺失值、坏转义、不同合法含义和资源预算耗尽都不能猜着执行。重复生成同类错误不代表旧规则失效；需要核实该候选是否进入统一入口、能否唯一恢复、是否已完成工具或已耗尽有界额度。语法正确仍不能证明参数符合用户意图或外部动作成功。

## 证据边界

2026-10-25 对本机 DSH 0.2.1-rc.3 安装产物进行 REA 定向静态分析并读取相应提取源码，涉及 `dsh-llm-deepseek-account`、`dsh-deepseek-account-platform`、共享 `dsh-llm-deepseek` 和另外的 Responses/schema 转换模块。未选择的模块与服务端实现不在该分析覆盖内；静态读取不等于真实网络推理测试。本次未切换通道、未发送计费推理或重跑旧任务，保持 v1.0.5 发行包和设置。
