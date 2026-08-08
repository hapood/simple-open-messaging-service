# TODO 08：冻结身份连续性、Identity Loss 与 Reset

状态：`OPEN`  
依赖：TODO 03、04、05

## 目标

对 root fingerprint、pairwise server ID、epoch、nonce、pinning、identity lock 和 destructive
reset 做最终安全审计并冻结 v1 行为。

## 工作内容

- 检查初次 `/init` 的双向 claim、nonce、domain 和 startChangeId binding。
- 确认已知 peer 通过 `/identity` 恢复，不自动重新 init。
- 检查 key/epoch/pairwise ID 改变、pre-upgrade migration 和 identity lock。
- 检查 reset preview、freeze、分批删除、崩溃恢复、tombstone、一次性 re-init。
- 检查本地 key 丢失或复制到两台服务器时 fail closed。
- 冻结 v1 是否完全不支持在线 key rotation。
- 保证裸删 peer 行不产生 re-init 权限，domain 换主不继承旧授权。

## 验收 Check

- [ ] 当前域名控制权不能继承历史服务器身份。
- [ ] 普通断线/demotion 不触发 fresh init。
- [ ] 身份矛盾原子进入 fail-closed。
- [ ] reset 前后无旧授权残留或提前可见窗口。
- [ ] reset 可在任意 crash point 恢复。
- [ ] re-init 权限一次性且不能靠裸删除重建。
- [ ] identity/reset 单元、数据库、双节点测试和 build 通过。
- [ ] 节点总结完整且没有未登记敞口。

## 节点总结

待执行时填写。
