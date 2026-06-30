/**
 * 业务码段定义（P1b 状态码对齐）。
 *
 * 设计对标 WhatsApp Cloud API 的「按域前缀分组」独立码空间：
 * - 0       成功
 * - 10xxx   通用业务（参数校验 / 资源不存在 / 冲突 / 未认证 / 限流 / 服务器）
 * - 20xxx   好友·会话状态机
 * - 30xxx   消息域
 * - 40xxx   群组域
 *
 * 原则（见 protocol-plan §5.2）：业务结果一律走 HTTP 200 + 业务码；仅未认证(401) /
 * 资源不存在(404) / 冲突(409) / 服务器异常(500) 这类协议·系统层保留 HTTP 状态码给大类，
 * body.code 仍映射到对应 10xxx 段。
 */
export enum BusinessCode {
  OK = 0,

  // 10xxx 通用
  VALIDATION_FAILED = 10000, // 参数校验失败（原 ValidationPipe 400）
  NOT_FOUND = 10001, // 资源不存在
  ALREADY_EXISTS = 10002, // 资源已存在（冲突）
  UNAUTHENTICATED = 10003, // 未认证
  FORBIDDEN = 10004, // 无权限
  RATE_LIMITED = 10005, // 限流 / IP 封禁
  REFRESH_REUSE_DETECTED = 10006, // refresh token 重用 → 前端强制重登（家族已连根吊销）
  SESSION_REVOKED = 10007, // 会话已被吊销（全设备登出/改密/单设备踢出）
  INTERNAL = 10999, // 服务器异常

  // 20xxx 好友·会话状态机
  FRIEND_SELF = 20001, // 不能加自己为好友
  FRIEND_UNKNOWN_STATE = 20002, // 好友状态机未知状态
  FRIEND_NO_INCOMING = 20003, // 无待处理好友请求

  // 30xxx 消息域
  MESSAGE_EMPTY = 30001, // 消息无内容
  THREAD_NOT_APPROVED = 30002, // 会话未建立 / 未批准
  THREAD_NOT_FOUND = 30003, // 无此会话

  // 40xxx 群组域
  GROUP_NOT_MEMBER = 40001, // 非群成员
  GROUP_NOT_FRIEND = 40002, // 非好友不可邀请
  GROUP_INVALID_TOKEN = 40003, // 无效邀请 token
}
