-- Attachment content stores canonical CAS paths, not coordinates of the message
-- that currently authorizes a download. Existing messages (including media in
-- pending batches and forward snapshots) must use the same representation.
UPDATE "Message"
SET content = to_jsonb(regexp_replace(
  content #>> '{}',
  '(/uploads/msg-assets/[0-9a-f]{2}/[0-9a-f]{2}/[0-9a-f]{64})\?threadId=[0-9]+&seq=[0-9]+',
  '\1', 'g'
))
WHERE content #>> '{}' LIKE '%?threadId=%&seq=%';

UPDATE "PendingMedia"
SET content = regexp_replace(
  content,
  '(/uploads/msg-assets/[0-9a-f]{2}/[0-9a-f]{2}/[0-9a-f]{64})\?threadId=[0-9]+&seq=[0-9]+',
  '\1', 'g'
)
WHERE content LIKE '%?threadId=%&seq=%';

UPDATE "ForwardBundle"
SET messages = regexp_replace(
  messages::text,
  '(/uploads/msg-assets/[0-9a-f]{2}/[0-9a-f]{2}/[0-9a-f]{64})\?threadId=[0-9]+&seq=[0-9]+',
  '\1', 'g'
)::jsonb
WHERE messages::text LIKE '%?threadId=%&seq=%';
