-- Preserve admitted terminal cleanup while retiring its old task discriminator.
UPDATE "DurableTask"
SET "taskType" = 'FORCE_REVOKE_GROUP_MEMBER'
WHERE "taskType" = 'REVOKE_DISSOLVED_GROUP_MEMBER';

-- Canonicalize local addressed subjects to the same merge identity as account-ID commands.
UPDATE "DurableTask" task
SET payload = jsonb_set(task.payload, ARRAY[target.field], to_jsonb(identity.id))
FROM "Account" identity,
  (VALUES ('memberUserId'), ('targetUserId')) AS target(field)
WHERE task."scopeType" = 'GROUP'
  AND task.payload -> target.field ->> 'domain' = 'local'
  AND task.payload -> target.field ->> 'account' = identity.account;

UPDATE "DurableTask" task
SET "coalescingKey" = jsonb_build_array('GROUP_MEMBER_INTENT', 'GROUP',
  CASE jsonb_typeof(task.payload -> 'memberUserId')
    WHEN 'number' THEN task.payload -> 'memberUserId'
    ELSE jsonb_build_array(task.payload -> 'memberUserId' -> 'namespaceId',
      task.payload -> 'memberUserId' -> 'domain', task.payload -> 'memberUserId' -> 'account')
  END)::text
WHERE task."taskType" IN ('FORCE_REVOKE_GROUP_MEMBER', 'ACCEPT_GROUP_JOIN_REQUEST',
  'REJECT_GROUP_JOIN_REQUEST', 'REVOKE_GROUP_INVITATION');

UPDATE "DurableTask" task
SET "coalescingKey" = jsonb_build_array('GROUP_MEMBER_INTENT', 'GROUP',
  CASE jsonb_typeof(task.payload -> 'targetUserId')
    WHEN 'number' THEN task.payload -> 'targetUserId'
    ELSE jsonb_build_array(task.payload -> 'targetUserId' -> 'namespaceId',
      task.payload -> 'targetUserId' -> 'domain', task.payload -> 'targetUserId' -> 'account')
  END)::text
WHERE task."taskType" IN ('INVITE_GROUP_MEMBER', 'KICK_GROUP_MEMBER');

-- Match the compact JSON encoding used by admission, without introducing runtime legacy paths.
UPDATE "DurableTask"
SET "coalescingKey" = replace("coalescingKey", ', ', ',')
WHERE "scopeType" = 'GROUP' AND "coalescingKey" LIKE '["GROUP_MEMBER_INTENT",%';
