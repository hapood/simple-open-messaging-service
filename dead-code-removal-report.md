# 死代码删除清单(供 review)

生成时间: 2026-09-15 · 基线: HEAD (414fc329) + 你的未提交 WIP 之上

每一项均为 knip 标记 + 编译器/eslint 确认零引用的双重命中;恢复项不在本清单。


## A. 整个声明删除(根 workspace)

| 符号 | 文件 | 种类 | 校验 |
|---|---|---|---|
| `waitForP2pFriendConvergence` | dev/federation-lab/p2p/audit.mjs | async function | DELETED |
| `readP2pPairSnapshot` | dev/federation-lab/p2p/audit.mjs | async function | DELETED |
| `UserIntentLocatorRow` | src/user/business/p2p-intent/authored/user-intent-authorization-sql.ts | interface | DELETED |
| `FederationV1WireErrorCode` | src/common/business-code.ts | enum | DELETED |
| `ALL_MENTION_ID` | src/common/message-entity.ts | const | DELETED |
| `RemoteMessageCursorUnavailableError` | src/federation/federation-feed-cursor-error.ts | class | DELETED |
| `FederationPeerHttpLifecycle` | src/federation/federation-peer-http.ts | interface | DELETED |
| `UnreadMentionState` | src/message/message.service.ts | type | DELETED |
| `parseVideoContent` | src/upload/file-content.ts | function | DELETED |
| `parseAudioContent` | src/upload/file-content.ts | function | DELETED |
| `VideoContent` | src/upload/file-content.ts | interface | DELETED |
| `AudioContent` | src/upload/file-content.ts | interface | DELETED |
| `parseFinitePos` | src/upload/file-content.ts | function | DELETED |

## B. 整个声明删除(admin-web shadcn 未使用子组件)

| 组件 | 文件 | 校验 |
|---|---|---|
| `CardAction` | admin-web/src/components/ui/card.tsx | DELETED |
| `CardFooter` | admin-web/src/components/ui/card.tsx | DELETED |
| `DialogTrigger` | admin-web/src/components/ui/dialog.tsx | DELETED |
| `DropdownMenuPortal` | admin-web/src/components/ui/dropdown-menu.tsx | DELETED |
| `DropdownMenuGroup` | admin-web/src/components/ui/dropdown-menu.tsx | DELETED |
| `DropdownMenuLabel` | admin-web/src/components/ui/dropdown-menu.tsx | DELETED |
| `DropdownMenuSub` | admin-web/src/components/ui/dropdown-menu.tsx | DELETED |
| `DropdownMenuSubTrigger` | admin-web/src/components/ui/dropdown-menu.tsx | DELETED |
| `DropdownMenuSubContent` | admin-web/src/components/ui/dropdown-menu.tsx | DELETED |
| `DropdownMenuCheckboxItem` | admin-web/src/components/ui/dropdown-menu.tsx | DELETED |
| `DropdownMenuRadioGroup` | admin-web/src/components/ui/dropdown-menu.tsx | DELETED |
| `DropdownMenuRadioItem` | admin-web/src/components/ui/dropdown-menu.tsx | DELETED |
| `DropdownMenuSeparator` | admin-web/src/components/ui/dropdown-menu.tsx | DELETED |
| `DropdownMenuShortcut` | admin-web/src/components/ui/dropdown-menu.tsx | DELETED |
| `SelectGroup` | admin-web/src/components/ui/select.tsx | DELETED |
| `SelectLabel` | admin-web/src/components/ui/select.tsx | DELETED |
| `SelectSeparator` | admin-web/src/components/ui/select.tsx | DELETED |
| `TableFooter` | admin-web/src/components/ui/table.tsx | DELETED |
| `TableCaption` | admin-web/src/components/ui/table.tsx | DELETED |

另:dropdown-menu.tsx 删除 2 个孤儿 import(`React`、`ChevronRightIcon, CheckIcon`)。


## C. 死 re-export 行删除(转发定义仍存在于原文件)

| 转发的符号 | 所在文件 | 校验 |
|---|---|---|
| `CALL_SID_RE` | src/dto/call.dto.ts | DELETED |
| `admitOperation` | dev/federation-lab/p2p/random-execute.mjs | DELETED |
| `S2SQuoteTarget` | src/federation/federation.service.ts | DELETED |
| `InlineProfileAvatar` | src/federation/federation.service.ts | DELETED |
| `SystemMessageContent(转发行)` | src/message/system-message.ts | 见备注 |
| `MessageTomb(转发行)` | web/src/app/services/model.ts | 见备注 |

> 恢复说明:`deriveLocalGroupSystemEvents`/`type LocalGroupSystemEvent`/`FederationMessageContextError` 三个转发因 spec 消费已恢复,不在清单。


## D. import 列表孤儿成员移除

| 符号 | 文件 | 校验 |
|---|---|---|
| `GroupMetaFeedPage` | src/federation/federation-thread-meta-round-executor.service.ts | DELETED |

## E. 仅剥离 export 关键字(符号保留为模块内部,共 157 项)

knip 报告的这些导出无任何外部导入者;同文件内部有使用的只去 `export`,内部也无使用的在 A/B 节删除。

- **admin-web/src/api/media.ts** (1): `FederationDownloadFile`
- **admin-web/src/api/message-reports.ts** (2): `MessageReportListItem`, `deleteMessage`
- **admin-web/src/api/rate-limits.ts** (2): `RateLimitSample`, `RateLimitStats`
- **admin-web/src/components/layout/nav-config.tsx** (2): `NavGroupKey`, `NavKey`
- **admin-web/src/hooks/use-log-stream.ts** (2): `parseFrame`, `readFrames`
- **admin-web/src/i18n/index.ts** (2): `FALLBACK_LANG`, `LANG_STORAGE_KEY`
- **admin-web/src/lib/constants.ts** (1): `LoginMode`
- **admin-web/src/types/api.ts** (16): `AdminSessionListItem`, `ConnectionClient`, `DashboardAction`, `DurableTaskEntry`, `DurableTaskKind`, `FederationPeerEventType`, `FirebaseConfigDescriptor`, `GroupRow`, `QuotaCategoryUsage`, `SelfCheckSummary`, `SessionListItem`, `UserDetailGroup`, `UserDetailPushToken`, `UserDetailUser`, `UserQuotaSummary`, `VapidDescriptor`
- **dev/federation-lab/p2p/audit.mjs** (1): `normalizeNodeIntentRows`
- **dev/federation-lab/p2p/message-evidence.mjs** (1): `messageAuthor`
- **shared/message-preview.ts** (1): `MESSAGE_PREVIEW_MAX_LENGTH`
- **src/auth/media-token.ts** (3): `LOGGED_IN_COOKIE`, `LOGGED_IN_COOKIE_OPTIONS`, `MEDIA_COOKIE_OPTIONS`
- **src/auth/qr-login.service.ts** (1): `QrPollStatus`
- **src/auth/session-cookie.interceptor.ts** (1): `SessionSlideRequest`
- **src/group/business/membership-intent/received/mirror-group-membership-intent.service.ts** (2): `InvalidMirrorItemError`, `MirrorGroupMembershipIntentBody`
- **src/group/business/membership-intent/received/remote-member-membership-intent.service.ts** (1): `RemoteMemberMembershipIntentBody`
- **src/group/business/meta/group-meta-page.ts** (1): `GroupMetaFeedItem`
- **src/group/business/meta/mirror-meta-shared.ts** (2): `assertMirrorRosterOwnersInTx`, `readMirrorMetaInTx`
- **src/common/business/relationship-intent-state.ts** (1): `RelationshipIntentTransition`
- **src/user/business/p2p-intent/received/received-user-intent.service.ts** (1): `ReceivedUserIntentBody`
- **src/calls/federated-call-protocol.ts** (3): `SdpText`, `SerializedIceCandidate`, `SerializedVideoState`
- **src/calls/turn-credentials.ts** (1): `TurnRestCredential`
- **src/common/account.ts** (1): `SOMFP_USER_ACCOUNT_RE`
- **src/common/message-entity.ts** (1): `MessageTextSegment`
- **src/common/sse-stream.ts** (1): `SSE_HEARTBEAT_MS`
- **src/common/validators.ts** (1): `DISPLAY_NAME_MAX`
- **src/database/database-error.ts** (1): `hasPostgresErrorCode`
- **src/database/enums.ts** (3): `FileSyncDirection`, `FileSyncKind`, `FileSyncStatus`
- **src/database/json.ts** (1): `JsonPrimitive`
- **src/dto/call.dto.ts** (1): `CallSidDto`
- **src/durable-task/durable-task-error.ts** (2): `UnexpectedTaskDatabaseDiagnostics`, `UnexpectedTaskErrorCauseDiagnostics`
- **src/durable-task/durable-task-queue.service.ts** (1): `DurableTaskScope`
- **src/durable-task/durable-task.types.ts** (1): `DurableTaskRejected`
- **src/federation/federated-message-types.ts** (1): `FederatedContentType`
- **src/federation/federation-inbound-message-store.service.ts** (1): `S2SQuoteTarget`
- **src/federation/federation-message-feed.service.ts** (3): `FEDERATION_MESSAGE_FEED_DEFAULT_PAGE_SIZE`, `FEDERATION_MESSAGE_FEED_MAX_PAGE_SIZE`, `FederationMessageFeedAsset`
- **src/federation/federation-message-tombstone-feed.service.ts** (1): `FederationMessageTombstoneItem`
- **src/federation/federation-profile.ts** (1): `InlineProfileAvatar`
- **src/federation/federation-state-event.ts** (1): `FEDERATION_STATE_EVENT_TYPES`
- **src/federation/federation-thread-fanout-task.handler.ts** (1): `readFederationFanoutProgress`
- **src/federation/federation-thread-meta-round-executor.service.ts** (1): `isMirrorGroupDenied`
- **src/federation/peer-state-feed.service.ts** (1): `PeerStateBody`
- **src/federation/signature.service.ts** (2): `ALLOWED_FUTURE_SKEW_SEC`, `ALLOWED_PAST_SKEW_SEC`
- **src/forward/forward-bundle.service.ts** (8): `FORWARD_MAX_ASSETS`, `FORWARD_MAX_CLOSURE_BUNDLES`, `FORWARD_MAX_MESSAGES`, `FORWARD_SUMMARY_CHARS`, `FORWARD_SUMMARY_LINES`, `ForwardAuthor`, `ForwardProfileSnapshot`, `ForwardWireChild`
- **src/link-preview/link-preview.service.ts** (2): `LinkCardGenerationStatus`, `LinkPreviewGenerationError`
- **src/logger/log-rotator.ts** (1): `CURRENT_LOG_FILE`
- **src/message/message.service.ts** (1): `ClientMessageTomb`
- **src/message/thread-fanout-progress.service.ts** (1): `readThreadFanoutProgress`
- **src/message/thread-fanout-task.ts** (1): `mergeThreadFanoutTargets`
- **src/message/thread-feed.service.ts** (2): `ThreadFeedPreview`, `ThreadFeedState`
- **src/rate-limit/rate-limit-monitoring.ts** (1): `RateLimitAdviceLevel`
- **src/upload/avatar-path.ts** (1): `isAvatarUrlOrEmpty`
- **src/upload/file-content.ts** (3): `FileContent`, `GalleryItem`, `isUploadUrl`
- **src/upload/media-sig.ts** (1): `MediaFamily`
- **src/upload/upload.service.ts** (1): `ConsumedPartFile`
- **web/src/app/components/debug-log/debug-log-merge.ts** (1): `LogSource`
- **web/src/app/components/forward-detail/forward-bundle.model.ts** (1): `ForwardAssetDocument`
- **web/src/app/components/message-cards/chat-item.ts** (2): `AlbumMedia`, `ChatTextSegment`
- **web/src/app/components/message-cards/media-row/layout.ts** (3): `AlbumRect`, `VOICE_BAR_MAX_W`, `VOICE_BAR_MIN_W`
- **web/src/app/components/message-thread/http-item-source.ts** (1): `MessagePageLoadError`
- **web/src/app/components/message-thread/message-copy.ts** (1): `formatCopyTimestamp`
- **web/src/app/components/message-thread/message-scroll-state.ts** (1): `MESSAGE_BOTTOM_THRESHOLD_PX`
- **web/src/app/components/message-thread/message-selection.ts** (1): `MessageSelectionState`
- **web/src/app/components/message-thread/message-thread-adapter.ts** (1): `ProductionMessageThreadAdapter`
- **web/src/app/lib/chat-input/emoji-data.ts** (1): `EMOJIS_FLAT`
- **web/src/app/lib/chat-input/voice-recording-state.ts** (1): `MIN_VOICE_RECORD_MS`
- **web/src/app/lib/message-entity.ts** (3): `MessageEntitySegment`, `MessageSegment`, `MessageTextSegment`
- **web/src/app/lib/status-ring.ts** (1): `createStatusRing`
- **web/src/app/lib/sticky-avatar.ts** (4): `STICKY_AVATAR_SIZE_PX`, `STICKY_AVATAR_TOP_GAP_PX`, `StickyAvatarPlacement`, `StickyAvatarRow`
- **web/src/app/services/friend-request-state.ts** (3): `FriendRequestBucket`, `FriendRequestPeer`, `FriendRequestProjectionStatus`
- **web/src/app/services/group.service.ts** (2): `GroupRosterRoleResult`, `MembershipIntentResult`
- **web/src/app/services/image-download.adapter.ts** (1): `WebImageDownloadAdapter`
- **web/src/app/services/image-download.service.ts** (1): `ImageDownloadStatus`
- **web/src/app/services/keyboard-inset.service.ts** (1): `ImeGeometryEvent`
- **web/src/app/services/log-buffer.ts** (1): `clearConsoleBuffer`
- **web/src/app/services/media-transfer.service.ts** (1): `MediaTransferStatus`
- **web/src/app/services/message-range.ts** (2): `MESSAGE_RANGE_STATES`, `MessageRangeState`
- **web/src/app/services/message.service.ts** (3): `MessageHistoryBackendData`, `MessageHistoryGap`, `UploadPartIntent`
- **web/src/app/services/model.ts** (4): `Group`, `MessageThreadType`, `PendingThreadListItem`, `PersonalQuotaBreaker`
- **web/src/app/services/native-composer.service.ts** (4): `NativeComposerBounds`, `NativeComposerLinkMarker`, `NativeComposerMention`, `NativeMentionCandidate`
- **web/src/app/services/native-upload.service.ts** (1): `NativeUploadKind`
- **web/src/app/services/runtime.ts** (2): `MEDIA_SCHEME`, `syncApiOriginSecondarySignal`
- **web/src/app/services/sse-worker-protocol.ts** (2): `SseEventPayload`, `WorkerState`
- **web/src/app/services/user.service.ts** (1): `ClientIntentUser`
- **web/src/app/services/web-call.adapter.ts** (5): `LocalTrackEndAction`, `WEB_CALLEE_RECONNECT_BACKSTOP_MS`, `WEB_RECONNECT_BACKSTOP_MS`, `WEB_RECONNECT_BACKSTOP_SHORT_MS`, `WebReconnectAction`
- **web/src/app/services/webdb-storage.ts** (3): `CachedMessage`, `CachedMessageTombstone`, `MetaRecord`

## F. 导出已恢复(测试专用 API,非死代码,共 106 项)

spec 文件被 knip 配置排除,这类"仅测试消费"的导出被刻意保留。

- **admin-web/src/api/client.ts** (1): `rateLimitConfig`
- **admin-web/src/routes/users/user-quota-panel.tsx** (1): `userQuotaStatus`
- **dev/federation-lab/p2p/api-actors.mjs** (1): `LabUserActor`
- **dev/federation-lab/p2p/audit.mjs** (1): `normalizeNodePairRows`
- **dev/federation-lab/p2p/final-audit.mjs** (4): `profileKey`, `readAssetBytes`, `readNodeMessageAudit`, `readNodeProfileAudit`
- **dev/federation-lab/p2p/fixed-scenarios.mjs** (2): `selectScenarioMembers`, `waitForScenarioSnapshot`
- **dev/federation-lab/p2p/forward-relay-scenario.mjs** (1): `assertRelaySnapshot`
- **dev/federation-lab/p2p/message-operations.mjs** (1): `submitMessage`
- **dev/federation-lab/p2p/profile-resolution.mjs** (1): `resolveUntilReady`
- **dev/federation-lab/p2p/random-execute.mjs** (9): `chooseRandomRound`, `chooseStateWindow`, `createAdmissionPacer`, `executeBatch`, `finalizeTasks`, `observeGroupMessageAvailability`, `scheduledAdmissionAt`, `settleWorkloadOperations`, `unsubmittedGroupRequests`
- **dev/federation-lab/p2p/state-machine.mjs** (2): `groupIntentActionOptions`, `groupMutationCategories`
- **shared/call-ended-content.ts** (1): `CALL_OUTCOMES`
- **shared/message-tomb.ts** (1): `messageTomb`
- **src/admin/two-factor.service.ts** (1): `hashBackupCode`
- **src/admin/webauthn.config.ts** (1): `loadWebAuthnConfig`
- **src/auth/throttle.guard.ts** (1): `THROTTLE_KEY`
- **src/bootstrap.ts** (2): `GLOBAL_PREFIX_EXCLUSIONS`, `uploadCacheControl`
- **src/group/business/membership-intent/shared/group-membership-projection-fanout.ts** (1): `groupMembershipProjectionFanoutKey`
- **src/common/business/locks/relationship-pair-business-lock.ts** (1): `relationshipPairBusinessKey`
- **src/common/business/relationship-intent-state.ts** (1): `deriveRelationshipIntentTransition`
- **src/calls/federated-call-protocol.ts** (2): `S2S_CALL_OPERATIONS`, `assertS2SCallFrame`
- **src/calls/turn-credentials.ts** (2): `DEFAULT_TURN_TTL_SECONDS`, `mintTurnCredential`
- **src/common/account.ts** (2): `GROUP_ACCOUNT_RE`, `isGroupAccount`
- **src/common/api-result.ts** (1): `ApiResult`
- **src/common/message-entity.ts** (1): `escapePlainText`
- **src/database/database-error.ts** (1): `isRetryableTransactionError`
- **src/database/raw-result.ts** (1): `rawBigInt`
- **src/diagnostics/diagnostics.service.ts** (1): `DIAGNOSTICS_DIR`
- **src/federation/federation.service.ts** (1): `clientGroupIntentEndpoints`
- **src/forward/forward-bundle.service.ts** (1): `localizeForwardMediaContent`
- **src/logger/log-viewer.service.ts** (1): `matchesLogFilters`
- **src/message/message.service.ts** (2): `derivePreview`, `stripMessageId`
- **src/message/thread-feed-head.writer.ts** (2): `mentionsAccount`, `messageAdvanceInterval`
- **src/quota/user-quota.service.ts** (1): `quotaSummaryStatus`
- **src/rate-limit/fixed-window-policy.service.ts** (1): `FIXED_WINDOW_DEFAULTS`
- **src/settings/firebase.ts** (6): `EXPECTED_ANDROID_PACKAGE`, `assertValidFirebaseConfig`, `isValidApiKey`, `isValidAppId`, `isValidProjectId`, `isValidSenderId`
- **src/upload/cas-url.ts** (1): `contextualCasUrl`
- **src/upload/file-content.ts** (1): `parseFileContent`
- **web/src/app/components/home-shell/home-shell.component.ts** (3): `crossesExpandedLayout`, `nextConversationListWidth`, `shouldCloseChatOnThreadSelect`
- **web/src/app/components/message-cards/chat-item.ts** (2): `AuthoredMessageItem`, `SystemMessageItem`
- **web/src/app/components/message-cards/create-item.ts** (1): `applyMessageListItemSemantics`
- **web/src/app/components/message-cards/date-format.ts** (1): `sameDay`
- **web/src/app/components/message-cards/media-row/layout.ts** (4): `ALBUM_MAX_ROW_H_RATIO`, `ALBUM_MIN_ROW_H_RATIO`, `ALBUM_SINGLE_MAX_H`, `ALBUM_W`
- **web/src/app/components/message-cards/merge-items.ts** (2): `ALBUM_MAX`, `mergeAlbumItems`
- **web/src/app/components/message-thread/message-selection.ts** (1): `messageSelectionState`
- **web/src/app/components/settings/settings-connection.component.ts** (1): `classifyProbeError`
- **web/src/app/directives/focused-input-reveal.directive.ts** (1): `focusedInputScrollDelta`
- **web/src/app/directives/kbd-offset.directive.ts** (1): `shouldResizeChatHost`
- **web/src/app/lib/chat-box/chat-box-scroller.ts** (1): `fullyVisibleIndexes`
- **web/src/app/lib/chat-input/voice-recording-state.ts** (3): `CANCEL_ENTER_PX`, `CANCEL_EXIT_PX`, `nextVoiceCancelState`
- **web/src/app/lib/message-entity.ts** (1): `parseMessageEntities`
- **web/src/app/lib/sticky-avatar.ts** (1): `pickStickyAvatarPlacement`
- **web/src/app/services/active-page.ts** (1): `ACTIVE_PAGE_LOCK`
- **web/src/app/services/api-types.ts** (4): `$defs`, `operations`, `paths`, `webhooks`
- **web/src/app/services/friend-request-state.ts** (1): `FRIEND_INTENT_RETENTION_MS`
- **web/src/app/services/group.service.ts** (1): `GrpCreateInfo`
- **web/src/app/services/image-download.adapter.ts** (1): `NativeImageDownloadAdapter`
- **web/src/app/services/keyboard-inset.service.ts** (2): `KeyboardInsetAnimation`, `browserKbdInset`
- **web/src/app/services/native-upload.service.ts** (1): `isSuccessfulUploadResponse`
- **web/src/app/services/user.service.ts** (1): `CACHE_REBUILD_RELOAD`
- **web/src/app/services/web-call.adapter.ts** (4): `callMediaErrorStep`, `iceServersFromResponse`, `localTrackEndAction`, `webReconnectDecision`
- **web/src/app/services/webdb-storage.ts** (4): `CACHE_SCHEMA_VERSION`, `LocalCacheUnavailableError`, `LocalCacheVersionMismatchError`, `MESSAGE_CACHE_SCHEMA_VERSION`
- **web/src/app/services/webdb.service.ts** (1): `STATE_FEED_WORKER_FACTORY`

## G. 导出列表成员移除(声明保留、内部使用中)

| 符号 | 文件 | 说明 |
|---|---|---|
| `badgeVariants` | admin-web/src/components/ui/badge.tsx | 导出列表改为 `export { Badge }`;cva 定义保留(badge 内部使用) |
| `tabsListVariants` | admin-web/src/components/ui/tabs.tsx | 从导出列表移除;cva 定义保留(TabsList 内部使用) |

## H. 记录核对备注

- `databaseSchema`(database.service.ts):knip flag 时该行已被并行改动移走,sed 未命中任何内容(良性 no-op);真实定义在 database-schema.ts,导出完好。
- 全部条目已逐项对照当前文件校验:无一项"声明仍在却报告已删"。
- 删除总数:**A 13 + B 19 + C 6 + D 1 = 39 个声明级删除**,另剥离 157 个 export 关键字。
