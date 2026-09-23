import {
  admitMessageOperation,
  messageOperationTypes,
} from './message-operations.mjs';
import { LabApiError } from './api-actors.mjs';
import { resolveWithRetry } from './execute.mjs';

function relationshipAddress(actor, peer) {
  return {
    account: peer.account,
    domain: actor.node.name === peer.node.name ? 'local' : peer.domain,
  };
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

async function sendRequest(actor, peer, timeoutMs) {
  let resolved;
  const body = relationshipAddress(actor, peer);
  if (actor.node.name !== peer.node.name) {
    resolved = await resolveWithRetry(actor, peer, timeoutMs);
    body.displayName = resolved.user.name;
    if (resolved.user.avatar) body.avatar = resolved.user.avatar;
  }
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

function groupAddress(actor, address) {
  const separator = address.lastIndexOf('@');
  const domain = address.slice(separator + 1);
  return {
    account: address.slice(0, separator),
    domain: domain === actor.domain ? 'local' : domain,
  };
}

async function admitGroupOperation(operation, actors, timeoutMs) {
  const actor = actors.user(operation.actor);
  const address = groupAddress(actor, operation.group);
  const threadId = operation.groupThreadId;
  let endpoint;
  let body;
  let accepted;
  let preflight;
  if (operation.type === 'REQUEST_GROUP_JOIN') {
    endpoint = '/relationship/request';
    let displayName = operation.observedFacts.group.name;
    if (address.domain !== 'local') {
      const resolved = await resolveWithRetry(
        actor,
        operation.observedFacts.group,
        timeoutMs,
      );
      displayName = resolved.user.name;
      preflight = {
        endpoint: '/user/resolve-federated-stream',
        target: operation.group,
      };
    }
    body = {
      ...address,
      note: operation.id,
      displayName,
    };
    accepted = await actor.post(
      endpoint,
      body,
      `request to join ${operation.group}`,
    );
  } else if (operation.type === 'ACCEPT_GROUP_INVITATION') {
    endpoint = '/relationship/accept';
    body = address;
    accepted = await actor.post(
      endpoint,
      body,
      `accept invitation to ${operation.group}`,
    );
  } else if (operation.type === 'REVOKE_GROUP_APPLICATION') {
    endpoint = '/relationship/revoke';
    body = address;
    accepted = await actor.post(
      endpoint,
      body,
      `revoke group intent for ${operation.group}`,
    );
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
    body = {
      groupId: threadId,
      users: [
        { account: operation.target.account, domain: operation.target.domain },
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
      account: operation.target.memberAccount,
      domain: operation.target.memberDomain,
    };
    accepted = await actor.post(
      endpoint,
      body,
      `${operation.type} in ${operation.group}`,
    );
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
      domain: operation.target.domain,
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
    );
  } else if (operation.type === 'REVERSE_REQUEST') {
    admission = await sendRequest(
      actors.user(operation.requestSubject),
      actors.user(operation.requestAuthor),
      timeoutMs,
    );
  } else if (
    operation.type === 'ACCEPT_REQUEST' ||
    operation.type === 'REJECT_REQUEST'
  ) {
    const actor = actors.user(operation.requestSubject);
    const initiator = actors.user(operation.requestAuthor);
    const endpoint =
      operation.type === 'ACCEPT_REQUEST'
        ? '/relationship/accept'
        : '/relationship/revoke';
    const body = relationshipAddress(actor, initiator);
    const accepted = await actor.post(
      endpoint,
      body,
      `${operation.type === 'ACCEPT_REQUEST' ? 'accept' : 'reject'} relationship request from ${initiator.address}`,
    );
    admission = {
      accepted,
      actor,
      request: { method: 'POST', endpoint, body: journalBody(body) },
    };
  } else if (operation.type === 'REVOKE_RELATIONSHIP') {
    const actor = actors.user(operation.actor);
    const peer = actors.user(operation.peer);
    const body = relationshipAddress(actor, peer);
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
    ...(admission.expected ? { expected: admission.expected } : {}),
    ...(admission.attempts ? { attempts: admission.attempts } : {}),
    ...(admission.withdrawnClientMessageId
      ? { withdrawnClientMessageId: admission.withdrawnClientMessageId }
      : {}),
    ...(taskId ? { taskId, taskNode: admission.actor.node.name } : {}),
    status: taskId ? 'ADMITTED' : 'SUCCEEDED',
    admittedAt: new Date().toISOString(),
  };
}
