# `INVITE` Message

状态：`RELEASE CANDIDATE`（`v1.0.0-rc.0`）

本文定义 P2P timeline 中的群邀请展示卡片。它是发送时的 snapshot，不是 membership authority；群成员
权威状态由 state-feed 收敛。共用消息外层结构见 [Message Envelope](./envelope.md)。

## 1. Content schema

```ts
interface GroupInviteContent {
  group: GroupAccount;
  groupName: string;
  groupDomain: Domain;
}
```

这是没有可选字段的 closed schema。

## 2. 联合约束

- 消息外层结构的 thread 必须是 inviter 与 invitee 组成的 P2P thread。
- 消息外层结构的 `author` 表示 inviter；content 不重复传输 inviter。
- `group` 必须是以 `!` 开头的合法 `GroupAccount`。
- `group/groupDomain` 必须组成合法 GROUP `ThreadAddress` identity。
- `groupName` 是不可信的展示 snapshot。v1 只要求它是 string，不要求非空。
- 消息外层结构的 `assets` 必须为空；群头像必须从权威 group state/profile 解析。
- 接受或拒绝邀请必须通过 state-feed 的 membership intent 和 origin `GROUP_META` 收敛，不能通过修改
  INVITE message 表达。

## 3. 完整示例

```json
{
  "thread": {
    "type": "P2P",
    "participants": [
      { "account": "alice", "domain": "a.example" },
      { "account": "bob", "domain": "b.example" }
    ]
  },
  "author": { "account": "alice", "domain": "a.example" },
  "seq": 73,
  "originSeq": null,
  "originCreatedAt": null,
  "createdAt": 1770000020000,
  "contentType": "INVITE",
  "content": "{\"group\":\"!engineering\",\"groupName\":\"Engineering\",\"groupDomain\":\"groups.example\"}",
  "assets": []
}
```

## 4. 必须拒绝

consumer MUST 拒绝至少以下情况：

- 消息位于 GROUP thread；
- P2P participants 不包含 inviter，或不是恰好两个不同 Address；
- content 重复携带 inviter、invitee、头像 locator 或其他未知字段；
- `group` 不是合法 `GroupAccount`；
- `groupDomain` 不是规范化 Domain；
- `groupName` 不是 string；
- 消息外层结构的 `assets` 非空。
