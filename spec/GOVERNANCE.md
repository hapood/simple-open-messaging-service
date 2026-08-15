# SOCFP Governance

Simple Open Chat Federation Protocol（SOCFP）由本仓库维护，但协议与任何单一实现相互独立。SOMS 是
参考实现，不拥有改变规范含义的特殊权力。

## 变更入口

协议问题和修改只通过本仓库的 GitHub Issues 和 Pull Requests 接收。贡献者不需要提交标准组织申请、
登记表或额外流程文档；能说明问题和修改内容即可。维护者在 Pull Request 中审查兼容性、安全影响、规范
正文和测试是否需要同步。实现代码的行为不能单独构成协议变更。

编辑性修订可以在同一 release candidate 内合并；任何新增、删除或改变可观察 wire 行为的修订都必须发布
新的 release candidate，并写入该版本的 changelog。`FINAL` 后的不兼容变更必须进入新的 major URL
版本。

## 决策与发布

维护者通过 GitHub Pull Request 的可审查历史决定修改和发布。RC 按可冻结协议的质量要求维护，但不会
因此自动升级为 `FINAL`。发布时保持以下内容同版本：

- 规范正文及其状态；
- JSON Schema、HTTP manifest 和测试向量；
- changelog；
- conformance 工具版本或可重现运行说明。

`spec/` 必须可以作为独立目录分发，至少自带版本元数据、许可证、规范入口、机器可读制品和验证说明；
不得要求接收者读取 SOMS 源码才能解释 wire contract。

发布包是最小状态单位。普通章节没有独立成熟度；可独立实现和测试的扩展规范可以拥有自己的版本、状态、
依赖与 conformance 要求。

## 实现中立性

规范正文只能约束对端可观察行为。SOMS 特有的数据库、配置、部署、客户端和迁移策略属于 `docs/`。
参考实现可以提供协议之外的兼容入口，但不得把这些入口发布为 SOCFP v1 的协商能力或合规要求。

## 许可与安全

规范文本和验证制品按发布包内的 [MIT License](./LICENSE) 发布。安全问题按
[Security Policy](./SECURITY.md) 处理。
