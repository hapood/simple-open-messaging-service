# TODO 03：关闭网络发现、SSRF 与 DNS Rebinding 敞口

状态：`OPEN`  
依赖：TODO 01

## 目标

让 SRV/apex 发现到实际连接的全过程只能到达允许的公网目标，禁止 DNS rebinding、内网 SSRF
和 redirect 绕过。

## 当前缺口

`DiscoveryService.resolveBase()` 当前直接接受 SRV target 并交给 `fetch()`，尚无公网 IP 校验、
解析与连接绑定、redirect 复核等完整保证。

## 工作内容

- 冻结 domain/IDN/尾点/大小写/端口 grammar 与 SRV fallback。
- 拒绝 private、loopback、link-local、multicast、unspecified 和 IPv4-mapped 绕过。
- 解析结果固定到实际连接，消除 resolve/connect TOCTOU。
- redirect 禁止，或每一跳执行完整复核。
- 对齐 TLS SNI、证书 hostname、HTTP authority、SRV target 和 federation domain。
- 所有 well-known、identity、JSON、media 请求共用安全 connector。
- 严格隔离开发环境 insecure HTTP。

## 验收 Check

- [ ] 不存在解析到连接之间的重绑定窗口。
- [ ] 混合 DNS 答案策略明确且有反例测试。
- [ ] redirect 不能绕过目标验证。
- [ ] SRV、TLS、authority 与签名绑定一致。
- [ ] 所有 S2S 请求复用相同网络策略。
- [ ] 测试例外不会进入生产。
- [ ] build 与安全测试通过。
- [ ] 节点总结完整且没有未登记敞口。

## 节点总结

待执行时填写。
