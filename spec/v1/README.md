# SOMS Federation v1

状态：`RELEASE CANDIDATE`
发布：`v1.0-rc.1`

本目录是 Federation Protocol v1.0-rc.1 的规范发布包。协议模型和必选功能已经闭合；v1.0 发布前仍可
进行编辑性澄清、一致性修正，以及对评审中发现的协议缺口作有记录的修复。正文只规定独立实现之间可观察的传输契约（wire contract）、
状态转换和安全边界；数据库表、工作进程（worker）、队列、用户界面（UI）、部署参数和本地产品限制
不属于协议，除非某项本地行为会改变对端可观察的结果并被正文明确约束。

中文稿是 v1.0-rc.1 的当前工作文本。未来发布中英文版本时，以英文版为准；在英文版正式发布前，
不得用尚未批准的英文翻译改变中文稿的规范含义。

规范词“必须（MUST）”“不得（MUST NOT）”“应该（SHOULD）”“不应该（SHOULD NOT）”和
“可以（MAY）”按 RFC 2119/RFC 8174 解释。正文中单独出现的大写 `MUST`、`MUST NOT`、`SHOULD`、
`SHOULD NOT` 和 `MAY` 具有相同效力。叙述性术语首次出现时采用“中文（English）”，后文使用
同一个中文术语；
wire 字段、枚举、HTTP header、标准名和稳定错误码（stable code）保持其原始拼写并使用反引号标识。
示例、图、TypeScript 记法和 `schema/` 制品用于说明或验证正文，不独立产生协议要求。

## 阅读顺序

1. [主协议](./protocol.md)：角色、版本、HTTP 接口面（HTTP surface）、共享类型、响应、持久状态和演进规则。
2. [传输与安全](./transport-security.md)：well-known、根密钥/签名密钥（root/signing key）、SRV、TLS、逻辑权威（authority）、摘要（digest）和 HTTP Message Signature。
3. [服务器认可](./recognition.md)：双向 Recognize、根公钥固定（root public key pinning）、Healthy 可用性查询、降级状态、时序和失败处理。
4. [状态源（State Feed）](./state-feed.md)：快照型压缩 feed、六种状态、member 引用顺序和 projection omission。
5. [消息源与查询（Message Feed and Query）](./message-feed.md)：索引型压缩 feed 与 thread 正文查询。
6. [消息墓碑源与查询（Message Tombstone Feed and Query）](./message-tombstone-feed.md)：墓碑索引、永久删除事实和竞态收敛。
7. [消息格式（Message）](./message.md)：消息 identity、正文类型、资源引用、引用回复与转发 closure。
8. [资源接口](./resources.md)：用户资料、媒体 bytes 与转发 closure 的参数、响应、授权和错误契约。
9. [语音与视频通话](./calls.md)：WebRTC 标准栈、S2S 帧（frame）、状态机与 AUDIO→VIDEO 升级。
10. [错误码注册表](./errors.md)：稳定错误码、HTTP 状态（status）、重试与身份动作（identity action）。
11. [机器可读发布包](./schema/README.md)：JSON Schema、HTTP 清单（manifest）、正反向量与一致性测试 CLI（conformance CLI）。

主协议定义共享规则；传输与安全文档定义所有操作（operation）共用的发现、TLS 和签名配置（profile）；
其余 operation 文档只定义自己的 body、授权、状态与幂等语义。operation 文档可以收紧共享规则，但不能
放宽传输或身份安全要求。若规范性正文之间冲突，应视为规范缺陷并按主协议的优先级规则处理，不应从
schema、示例或当前 SOMS 实现反推另一套语义。

同目录的 JSON Schema、HTTP manifest、正反向量和 conformance CLI 与规范性正文一起发布，作为
非规范性验证资源。它们不是节点运行时协商的一部分，也不能改变规范性正文；发现阶段只通过
`protocolVersions` 选择共同 major。

## 中英文编写与翻译规则

英文版将成为正式发布后的权威文本，因此中文稿应优先表达可直接翻译的单一含义：

- 一个术语只对应一个英文词。`publisher` 表示发布方；`source` 只表示 feed/query 的源节点；
  `consumer` 表示消费方；`peer` 表示对等节点。
- `recognition` 表示协议定义的双向服务器认可，不翻译成泛化的 `trust`。`authorization` 表示具体
  operation 的授权，不能由 recognition 自动推导。
- 规范要求必须使用带 RFC 2119/RFC 8174 关键词的完整句子。没有关键词的说明句不应暗含额外要求。
- 避免“适当”“正常”“尽快”“必要时”等无法独立验证的条件；确需使用时，必须在同一段定义触发条件、
  可观察结果或实现者可选择的范围。
- 代词必须能唯一指向前文对象。涉及两个服务器时优先使用 `A`、`B` 或角色名，不使用含义不明的
  “它”“对方”“本方”。
- wire 字段、枚举、HTTP method、path、header、media type 和稳定错误码保持原始拼写，不作意译。
- 示例和实现说明不得引入正文没有定义的新规则。翻译发现歧义时，应先修订中文稿并记录语义决定，
  再同步英文稿，而不是由译者选择一种解释。
