# SOCFP Security Policy

## 支持范围

当前仅 `v1.0-rc.2` 接受协议安全修订。Release candidate 可能通过新的 RC 发布不兼容修复；协议不得为了
保持 RC 兼容而保留已确认的安全缺陷。

## 报告

普通安全问题通过 GitHub Issue 提交。涉及可直接利用的身份冒充、签名绕过、重放或授权泄漏时，报告者
应使用 GitHub 的 private vulnerability reporting，避免先在公开 Issue 披露攻击细节。仓库启用该功能前，
本文件只说明限制，不要求报告者改用邮件或其他平台。

非敏感协议问题和修改统一通过 GitHub Issues 和 Pull Requests 处理。

## 处理原则

维护者应确认报告、区分协议缺陷与实现缺陷，并在必要时协调受影响实现。协议修复必须同步规范正文、
changelog、Schema、向量和 conformance；实现修复不能静默改变 wire contract。
