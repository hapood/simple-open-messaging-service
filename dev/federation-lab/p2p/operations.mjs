import {
  admitMessageOperation,
  messageOperationTypes,
} from './message-operations.mjs';
import { LabApiError } from './api-actors.mjs';
import { resolveWithRetry } from './execute.mjs';
import { requestIdFromWire } from '../../../shared/relationship-request.ts';
import { parseRequestSnapshot } from '../../../shared/request-snapshot.ts';

function profileSnapshot(profile) {
  return parseRequestSnapshot({
    displayName: profile?.name,
    avatar: profile?.avatar || null,
  });
}

function requestDecision(result, operationId) {
  if (!['OK', 'STALE_REQUEST', 'EXPIRED'].includes(result?.status))
    throw new Error(
      `${operationId}: invalid request decision result: ${JSON.stringify(result)}`,
    );
  return result;
}

function journalBody(body) {
  return body.avatar ? { ...body, avatar: '[present]' } : body;
}

export function journalError(error) {
  const redact = (value) => {
    if (Array.isArray(value)) return value.map(redact);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /(password|token|cookie|otp)$/i.test(key) ? '[redacted]' : redact(item),
      ]),
    );
  };
  return {
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof LabApiError ? { details: redact(error.details) } : {}),
  };
}

async function sendRequest(actor, peer, timeoutMs, actors) {
  const remote = actor.node.name !== peer.node.name;
  const resolved = remote
    ? await resolveWithRetry(actor, peer, timeoutMs)
    : undefined;
  const namespaceId = remote
    ? await peerNamespaceId(actors, actor, peer.domain, timeoutMs)
    : 0;
  const body = {
    account: peer.account,
    namespaceId,
    snapshot: profileSnapshot(
      resolved ? resolved.user : await peer.myProfile(),
    ),
  };
  const accepted = await actor.post(
    '/relationship/request',
    body,
    `request relationship with ${peer.address}`,
  );
  return {
    accepted,
    actor,
    request: {
      method: 'POST',
      endpoint: '/relationship/request',
      body: journalBody(body),
    },
    ...(resolved
      ? {
          preflight: {
            endpoint: '/user/resolve-federated-stream',
            target: peer.address,
          },
        }
      : {}),
  };
}

async function admitProfileOperation(operation, actors) {
  const actor = actors.user(operation.actor);
  if (operation.type === 'UPDATE_USER_PROFILE') {
    const body = {
      name: `user-${operation.id}`,
      bio: `Federation profile update ${operation.id}`,
      avatar: operation.avatarAction,
    };
    await actor.updateProfile(body);
    return {
      actor,
      request: {
        method: 'POST',
        endpoint: '/user/update-profile',
        body,
      },
    };
  }
  if (operation.type === 'UPDATE_GROUP_PROFILE') {
    const avatar =
      operation.avatarAction === 'SET'
        ? await actor.uploadAvatar()
        : operation.avatarAction === 'REMOVE'
          ? ''
          : undefined;
    const body = {
      groupId: operation.groupThreadId,
      name: `group-${operation.id}`,
      description: `Federation group update ${operation.id}`,
      ...(avatar !== undefined ? { avatar } : {}),
    };
    await actor.updateGroup(body);
    return {
      actor,
      request: {
        method: 'POST',
        endpoint: '/group/update',
        body: journalBody(body),
      },
    };
  }
  throw new Error(`unsupported profile operation ${operation.type}`);
}

/** Resolve the namespace coordinate a command DTO needs for `domain` as seen
 * by `actor`'s node. Local domains are namespace 0; federated domains use the
 * admin peer-namespace view because resolve streams return no coordinates. */
function peerNamespaceId(actors, actor, domain, timeoutMs) {
  return actors
    .node(actor.node.name)
    .admin.peerNamespaceId(domain, Math.min(timeoutMs, 30_000));
}

async function admitGroupOperation(operation, actors, timeoutMs) {
  const actor = actors.user(operation.actor);
  const separator = operation.group.lastIndexOf('@');
  const groupDomain = operation.group.slice(separator + 1);
  const address = {
    account: operation.group.slice(0, separator),
    namespaceId: 0,
  };
  const threadId = operation.groupThreadId;
  let endpoint;
  let body;
  let accepted;
  let decision;
  let preflight;
  if (operation.type === 'REQUEST_GROUP_JOIN') {
    endpoint = '/relationship/request';
    let snapshot = profileSnapshot(operation.observedFacts.group);
    if (groupDomain !== actor.node.domain) {
      const resolved = await resolveWithRetry(
        actor,
        operation.observedFacts.group,
        timeoutMs,
      );
      address.namespaceId = await peerNamespaceId(
        actors,
        actor,
        groupDomain,
        timeoutMs,
      );
      snapshot = profileSnapshot(resolved.user);
      preflight = {
        endpoint: '/user/resolve-federated-stream',
        target: operation.group,
      };
    }
    body = {
      account: address.account,
      namespaceId: address.namespaceId,
      note: operation.id,
      snapshot,
    };
    accepted = await actor.post(
      endpoint,
      body,
      `request to join ${operation.group}`,
    );
  } else if (operation.type === 'ACCEPT_GROUP_INVITATION') {
    endpoint = '/group/join-request';
    body = {
      requestId: requestIdFromWire(operation.observedFacts.groupRequestId),
    };
    accepted = await actor.post(
      endpoint,
      body,
      `accept invitation to ${operation.group}`,
    );
    decision = requestDecision(accepted, operation.id);
  } else if (operation.type === 'REVOKE_GROUP_APPLICATION') {
    endpoint = '/relationship/requests/withdraw';
    body = {
      requestId: requestIdFromWire(operation.observedFacts.userRequestId),
    };
    accepted = await actor.post(
      endpoint,
      body,
      `withdraw application for ${operation.group}`,
    );
    decision = requestDecision(accepted, operation.id);
  } else if (operation.type === 'LEAVE_GROUP') {
    endpoint = '/group/leave';
    body = { groupId: threadId };
    accepted = await actor.post(endpoint, body, `leave ${operation.group}`);
  } else if (operation.type === 'DISSOLVE_GROUP') {
    endpoint = '/group/dissolve';
    body = { groupId: threadId };
    accepted = await actor.post(endpoint, body, `dissolve ${operation.group}`);
  } else if (operation.type === 'INVITE_GROUP_MEMBER') {
    endpoint = '/group/invite';
    const targetNamespaceId =
      operation.target.namespaceId ??
      (operation.target.domain === actor.node.domain
        ? 0
        : await peerNamespaceId(
            actors,
            actor,
            operation.target.domain,
            timeoutMs,
          ));
    body = {
      groupId: threadId,
      users: [
        {
          account: operation.target.account,
          namespaceId: targetNamespaceId,
          snapshot: profileSnapshot(
            await actors.user(operation.target.address).myProfile(),
          ),
        },
      ],
    };
    const result = await actor.post(
      endpoint,
      body,
      `invite ${operation.target.address}`,
    );
    if (result.invited?.length !== 1 || result.skipped?.length !== 0) {
      throw new Error(
        `${operation.id}: group invite was not applied: ${JSON.stringify(result)}`,
      );
    }
    accepted = result;
  } else if (
    operation.type === 'ACCEPT_GROUP_APPLICATION' ||
    operation.type === 'REJECT_GROUP_APPLICATION' ||
    operation.type === 'REVOKE_GROUP_INVITATION'
  ) {
    endpoint = {
      ACCEPT_GROUP_APPLICATION: '/group/join-request/accept',
      REJECT_GROUP_APPLICATION: '/group/join-request/reject',
      REVOKE_GROUP_INVITATION: '/group/invitation/revoke',
    }[operation.type];
    body = {
      groupId: threadId,
      requestId: requestIdFromWire(operation.target.requestId),
    };
    accepted = await actor.post(
      endpoint,
      body,
      `${operation.type} in ${operation.group}`,
    );
    decision = requestDecision(accepted, operation.id);
  } else if (
    operation.type === 'KICK_GROUP_MEMBER' ||
    operation.type === 'TRANSFER_GROUP_OWNERSHIP' ||
    operation.type === 'SET_GROUP_ADMIN' ||
    operation.type === 'REMOVE_GROUP_ADMIN'
  ) {
    endpoint = {
      KICK_GROUP_MEMBER: '/group/kick',
      TRANSFER_GROUP_OWNERSHIP: '/group/transfer',
      SET_GROUP_ADMIN: '/group/set-role',
      REMOVE_GROUP_ADMIN: '/group/set-role',
    }[operation.type];
    body = {
      groupId: threadId,
      account: operation.target.account,
      namespaceId: operation.target.namespaceId,
      ...(operation.type === 'SET_GROUP_ADMIN'
        ? { role: 'ADMIN' }
        : operation.type === 'REMOVE_GROUP_ADMIN'
          ? { role: 'MEMBER' }
          : {}),
    };
    accepted = await actor.post(
      endpoint,
      body,
      `${operation.type} in ${operation.group}`,
    );
  } else if (messageOperationTypes.has(operation.type)) {
    return admitMessageOperation(operation, actor);
  } else if (operation.type === 'WITHDRAW_GROUP_MESSAGE') {
    endpoint = '/withdraw-message';
    body = { threadId, seq: operation.target.seq };
    const message = await actor.withdrawMessage(threadId, operation.target.seq);
    return {
      actor,
      request: { method: 'POST', endpoint, body },
      message,
      withdrawnClientMessageId: operation.target.clientMessageId,
    };
  } else {
    throw new Error(`unsupported group operation ${operation.type}`);
  }
  return {
    accepted,
    actor,
    request: { method: 'POST', endpoint, body: journalBody(body) },
    ...(preflight ? { preflight } : {}),
    ...(decision ? { decision } : {}),
  };
}

export async function admitOperation(operation, actors, timeoutMs) {
  let admission;
  if (
    operation.type === 'UPDATE_USER_PROFILE' ||
    operation.type === 'UPDATE_GROUP_PROFILE'
  ) {
    admission = await admitProfileOperation(operation, actors);
  } else if (operation.group) {
    admission = await admitGroupOperation(operation, actors, timeoutMs);
  } else if (operation.p2pPair && messageOperationTypes.has(operation.type)) {
    admission = await admitMessageOperation(
      operation,
      actors.user(operation.actor),
    );
  } else if (operation.type === 'WITHDRAW_P2P_MESSAGE') {
    const actor = actors.user(operation.actor);
    const body = { threadId: operation.threadId, seq: operation.target.seq };
    admission = {
      actor,
      request: { method: 'POST', endpoint: '/withdraw-message', body },
      message: await actor.withdrawMessage(body.threadId, body.seq),
      withdrawnClientMessageId: operation.target.clientMessageId,
    };
  } else if (operation.type === 'SEND_REQUEST') {
    admission = await sendRequest(
      actors.user(operation.actor),
      actors.user(operation.peer),
      timeoutMs,
      actors,
    );
  } else if (operation.type === 'REVERSE_REQUEST') {
    admission = await sendRequest(
      actors.user(operation.requestSubject),
      actors.user(operation.requestAuthor),
      timeoutMs,
      actors,
    );
  } else if (
    operation.type === 'ACCEPT_REQUEST' ||
    operation.type === 'REJECT_REQUEST' ||
    operation.type === 'WITHDRAW_REQUEST'
  ) {
    const withdraw = operation.type === 'WITHDRAW_REQUEST';
    const actor = actors.user(
      withdraw ? operation.requestAuthor : operation.requestSubject,
    );
    const endpoint = {
      ACCEPT_REQUEST: '/relationship/accept',
      REJECT_REQUEST: '/relationship/requests/reject',
      WITHDRAW_REQUEST: '/relationship/requests/withdraw',
    }[operation.type];
    const body = {
      requestId: requestIdFromWire(
        withdraw
          ? operation.observedFacts.outgoingRequestId
          : operation.observedFacts.incomingRequestId,
      ),
    };
    const accepted = await actor.post(
      endpoint,
      body,
      `${operation.type} ${body.requestId}`,
    );
    admission = {
      accepted,
      actor,
      decision: requestDecision(accepted, operation.id),
      request: { method: 'POST', endpoint, body },
    };
  } else if (operation.type === 'REVOKE_RELATIONSHIP') {
    const actor = actors.user(operation.actor);
    const peer = actors.user(operation.peer);
    if (
      operation.observedFacts?.state !== 'FRIEND' ||
      !Number.isSafeInteger(operation.observedFacts.threadId) ||
      operation.observedFacts.threadId <= 0
    )
      throw new Error(
        `${operation.id}: established relationship requires an observed active thread`,
      );
    const body = { threadId: operation.observedFacts.threadId };
    const accepted = await actor.post(
      '/relationship/revoke',
      body,
      `revoke relationship with ${peer.address}`,
    );
    admission = {
      accepted,
      actor,
      request: {
        method: 'POST',
        endpoint: '/relationship/revoke',
        body: journalBody(body),
      },
    };
  } else {
    throw new Error(`unsupported random operation ${operation.type}`);
  }
  const taskId = admission.accepted?.taskId;
  if (taskId !== undefined && typeof taskId !== 'string')
    throw new Error(
      `${operation.id}: admission returned an invalid durable task id`,
    );
  return {
    ...operation,
    actor: admission.actor.address,
    request: admission.request,
    ...(admission.preflight ? { preflight: admission.preflight } : {}),
    ...(admission.message ? { result: admission.message } : {}),
    ...(admission.decision ? { result: admission.decision } : {}),
    ...(admission.expected ? { expected: admission.expected } : {}),
    ...(admission.attempts ? { attempts: admission.attempts } : {}),
    ...(admission.withdrawnClientMessageId
      ? { withdrawnClientMessageId: admission.withdrawnClientMessageId }
      : {}),
    ...(taskId ? { taskId, taskNode: admission.actor.node.name } : {}),
    status:
      admission.decision && admission.decision.status !== 'OK'
        ? 'OBSERVED_UNAVAILABLE'
        : taskId
          ? 'ADMITTED'
          : 'SUCCEEDED',
    admittedAt: new Date().toISOString(),
  };
}
