-- Breaking profile-coordinate cutover. Existing profile-bearing rows are not
-- reinterpreted or backfilled because old namespace columns were ambiguous.
-- Reset the database before applying this migration to a populated instance.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Profile" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "Message" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "RelationshipIntent" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "RelationshipPair" LIMIT 1) THEN
    RAISE EXCEPTION '0004_profile_publisher_namespace requires an empty Profile, Message, RelationshipIntent, and RelationshipPair cutover; reset old data instead of backfilling ambiguous namespaces';
  END IF;
END $$;

ALTER TABLE "Profile"
  DROP CONSTRAINT "Profile_pkey";

ALTER TABLE "Profile"
  DROP CONSTRAINT "Profile_namespaceId_fkey";

ALTER TABLE "Profile"
  DROP COLUMN "namespaceId";

ALTER TABLE "Profile"
  ADD COLUMN "publisherNamespaceId" integer NOT NULL,
  ADD COLUMN "profileNamespaceId" integer NOT NULL;

ALTER TABLE "Profile"
  ADD CONSTRAINT "Profile_publisherNamespaceId_fkey"
  FOREIGN KEY ("publisherNamespaceId") REFERENCES "IdentityNamespace"(id)
  ON DELETE RESTRICT;

ALTER TABLE "Profile"
  ADD CONSTRAINT "Profile_pkey"
  PRIMARY KEY (
    "publisherNamespaceId",
    account,
    domain,
    "profileNamespaceId",
    "profileRev"
  );

ALTER TABLE "Message"
  ADD COLUMN "profileNamespaceId" integer DEFAULT 0 NOT NULL;

ALTER TABLE "Message"
  ADD CONSTRAINT "Message_profileNamespaceId_fkey"
  FOREIGN KEY ("profileNamespaceId") REFERENCES "IdentityNamespace"(id)
  ON DELETE RESTRICT;

-- Replace functions which depend on the old composite Message row before the
-- old column is removed. This is a schema cutover, not a compatibility path.
CREATE OR REPLACE FUNCTION public.attention_message_before_write() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW.seq = OLD.seq AND NEW."threadId" = OLD."threadId"
    AND NEW."localState" = OLD."localState" AND NEW."isDeleted" = OLD."isDeleted"
    AND NEW."creatorAccount" IS NOT DISTINCT FROM OLD."creatorAccount"
    AND NEW."creatorDomain" IS NOT DISTINCT FROM OLD."creatorDomain"
    AND NEW."profileNamespaceId" = OLD."profileNamespaceId"
    AND NEW."contentType" = OLD."contentType"
    AND (NEW."contentType" <> 'PURE_TEXT' OR NEW.content IS NOT DISTINCT FROM OLD.content)
    THEN RETURN NEW; END IF;
  PERFORM 1 FROM "MessageThread" WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD."threadId" ELSE NEW."threadId" END FOR NO KEY UPDATE;
  IF TG_OP = 'UPDATE' AND (NEW.seq <> OLD.seq OR NEW."threadId" <> OLD."threadId") THEN
    RAISE EXCEPTION 'message sequence and thread are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.attention_message_eligible(m public."Message", s public."AccountThreadState", cleared integer) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT m."threadId" = s."threadId" AND m.seq > COALESCE(cleared, 0)
    AND (s."messageVisibleThroughSeq" IS NULL OR m.seq <= s."messageVisibleThroughSeq")
    AND NOT EXISTS (SELECT 1 FROM "Account" a WHERE a.id = s."accountId"
      AND a.account = m."creatorAccount" AND a.domain = m."creatorDomain"
      AND a."namespaceId" = m."profileNamespaceId")
    AND NOT s.blocked;
$$;

ALTER TABLE "Message"
  DROP CONSTRAINT "Message_creatorNamespaceId_fkey";

ALTER TABLE "Message"
  DROP CONSTRAINT "Message_creator_namespace_check";

ALTER TABLE "Message"
  DROP CONSTRAINT "Message_system_creator_check";

ALTER TABLE "Message"
  DROP COLUMN "creatorNamespaceId";

ALTER TABLE "Message"
  ADD CONSTRAINT "Message_profile_namespace_check"
  CHECK (
    "creatorDomain" IS NULL
    OR (("creatorDomain" = 'local') = ("profileNamespaceId" = 0))
  );

ALTER TABLE "Message"
  ADD CONSTRAINT "Message_system_creator_check"
  CHECK (
    "creatorAccount" IS NOT NULL
    AND "creatorDomain" IS NOT NULL
    AND (
      (
        "contentType" = 'SYSTEM'
        AND "creatorAccount" = '$system'
        AND "creatorDomain" = 'local'
        AND "profileNamespaceId" = 0
        AND "profileRev" = 0
        AND "sourceNamespaceId" = 0
      )
      OR (
        "contentType" <> 'SYSTEM'
        AND "creatorAccount" <> '$system'
      )
    )
  );

ALTER TABLE "RelationshipIntent"
  DROP CONSTRAINT "RelationshipIntent_pkey",
  DROP CONSTRAINT "RelationshipIntent_authorSide_check",
  DROP CONSTRAINT "RelationshipIntent_pairId_fkey";

-- A request fact is independent of the relationship pair: initiator and
-- receiver carry their own coordinates and no pairId foreign key exists.
-- The pair is matched by endpoint coordinates (local side A is always
-- namespace zero, the remote side carries endpointBNamespaceId).
ALTER TABLE "RelationshipIntent"
  DROP COLUMN "authorSide",
  DROP COLUMN "pairId",
  ADD COLUMN "authorAccount" varchar(31) NOT NULL,
  ADD COLUMN "authorNamespaceId" integer NOT NULL,
  ADD COLUMN "receiverAccount" varchar(31) NOT NULL,
  ADD COLUMN "receiverNamespaceId" integer NOT NULL,
  ADD COLUMN "profileNamespaceId" integer NOT NULL,
  ADD CONSTRAINT "RelationshipIntent_author_namespace_check"
  CHECK ("authorNamespaceId" >= 0),
  ADD CONSTRAINT "RelationshipIntent_receiver_namespace_check"
  CHECK ("receiverNamespaceId" >= 0),
  ADD CONSTRAINT "RelationshipIntent_profileNamespaceId_check"
  CHECK ("profileNamespaceId" >= 0),
  ADD CONSTRAINT "RelationshipIntent_authorNamespaceId_fkey"
  FOREIGN KEY ("authorNamespaceId") REFERENCES "IdentityNamespace"(id)
  ON DELETE RESTRICT,
  ADD CONSTRAINT "RelationshipIntent_receiverNamespaceId_fkey"
  FOREIGN KEY ("receiverNamespaceId") REFERENCES "IdentityNamespace"(id)
  ON DELETE RESTRICT;

ALTER TABLE "RelationshipIntent"
  ADD CONSTRAINT "RelationshipIntent_pkey"
  PRIMARY KEY ("authorAccount", "authorNamespaceId", "receiverAccount", "receiverNamespaceId");

-- The surrogate id is gone: the four-coordinate primary key is the identity of
-- a request fact, and sequencing concerns live with the owning flow.
DROP INDEX "RelationshipIntent_id_key";
ALTER TABLE "RelationshipIntent" DROP COLUMN id;

-- RelationshipPair no longer stores endpoint domains. Endpoint A is always the
-- local endpoint at namespace zero; endpoint B stores the peer endpoint's own
-- namespace, or zero for local-local pairs.
ALTER TABLE "RelationshipPair"
  DROP CONSTRAINT "RelationshipPair_endpoints_key",
  DROP CONSTRAINT "RelationshipPair_distinct_endpoints_check",
  DROP CONSTRAINT "RelationshipPair_endpointANamespaceId_fkey",
  DROP CONSTRAINT "RelationshipPair_endpointBNamespaceId_fkey";

DROP INDEX "RelationshipPair_endpointA_idx";
DROP INDEX "RelationshipPair_endpointB_idx";

ALTER TABLE "RelationshipPair"
  DROP COLUMN "endpointADomain",
  DROP COLUMN "endpointANamespaceId",
  DROP COLUMN "endpointBDomain",
  DROP COLUMN "endpointBNamespaceId",
  ADD COLUMN "endpointANamespaceId" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "endpointBNamespaceId" integer DEFAULT 0 NOT NULL,
  ADD CONSTRAINT "RelationshipPair_endpointANamespaceId_fkey"
  FOREIGN KEY ("endpointANamespaceId") REFERENCES "IdentityNamespace"(id)
  ON DELETE RESTRICT,
  ADD CONSTRAINT "RelationshipPair_endpointBNamespaceId_fkey"
  FOREIGN KEY ("endpointBNamespaceId") REFERENCES "IdentityNamespace"(id)
  ON DELETE RESTRICT,
  ADD CONSTRAINT "RelationshipPair_local_side_check"
  CHECK ("endpointANamespaceId" = 0),
  ADD CONSTRAINT "RelationshipPair_endpoint_namespace_check"
  CHECK ("endpointBNamespaceId" >= 0);

ALTER TABLE "RelationshipPair"
  ADD CONSTRAINT "RelationshipPair_endpoints_key"
  UNIQUE ("endpointAType", "endpointAAccount", "endpointBType", "endpointBAccount", "endpointBNamespaceId");

CREATE INDEX "RelationshipPair_endpointA_idx" ON public."RelationshipPair" USING btree ("endpointAType", "endpointAAccount", active);
CREATE INDEX "RelationshipPair_endpointB_idx" ON public."RelationshipPair" USING btree ("endpointBType", "endpointBAccount", active);

ALTER TABLE "RelationshipPair"
  ADD CONSTRAINT "RelationshipPair_distinct_endpoints_check"
  CHECK (("endpointAType", "endpointAAccount") <> ("endpointBType", "endpointBAccount"));

-- Pair endpoints no longer carry domains or per-endpoint namespaces, and
-- intents reference their pair by endpoint coordinates instead of pairId.
-- The stored functions below are redefined against the new shapes before any
-- runtime trigger can observe the dropped columns.

CREATE OR REPLACE FUNCTION public.client_thread_state_after_pair() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE participant record;
BEGIN
  IF NEW."threadId" IS NULL OR NOT NEW.established THEN RETURN NEW; END IF;
  FOR participant IN
    SELECT s."accountId" FROM "AccountThreadState" s JOIN "Account" a ON a.id = s."accountId"
    WHERE s."threadId" = NEW."threadId"
      AND ((NEW."endpointAType" = 'USER' AND NEW."endpointAAccount" = a.account)
        OR (NEW."endpointBType" = 'USER' AND NEW."endpointBAccount" = a.account))
    ORDER BY s."accountId"
  LOOP
    PERFORM publish_client_thread_state(participant."accountId", NEW."threadId",
      CASE WHEN NEW.active AND (TG_OP = 'INSERT' OR NOT OLD.active)
        THEN floor(extract(epoch FROM CURRENT_TIMESTAMP) * 1000)::bigint ELSE NULL END);
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.group_meta_member_namespace(p_thread_id integer, p_account text, p_domain text) RETURNS integer
    LANGUAGE sql STABLE
    AS $$
  SELECT CASE WHEN p_domain = 'local' THEN 0 ELSE COALESCE((
    SELECT pair."endpointBNamespaceId"
    FROM "RelationshipPair" pair
    WHERE pair.kind = 'GROUP_MEMBER' AND pair."threadId" = p_thread_id
      AND pair."endpointBType" = 'USER'
      AND pair."endpointBAccount" = p_account
    ORDER BY pair.active DESC, pair."updatedAt" DESC, pair.id DESC
    LIMIT 1
  ), (
    SELECT thread."authorityNamespaceId"
    FROM "MessageThread" thread WHERE thread.id = p_thread_id
  )) END;
$$;

CREATE OR REPLACE FUNCTION public.publish_client_thread_state(owner_id integer, thread_id integer, activation_at bigint DEFAULT NULL::bigint) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE facts record;
DECLARE previous jsonb;
DECLARE snapshot jsonb;
DECLARE profile_ref jsonb;
DECLARE compact_key text;
DECLARE position integer;
DECLARE activated boolean;
BEGIN
  PERFORM 1 FROM "Account" WHERE id = owner_id FOR NO KEY UPDATE;
  SELECT t.type, t."authorityNamespaceId", s.blocked, s.role, s."createdAt", p.active,
    CASE WHEN t.type = 'GROUP' THEN t."groupAccount"
      WHEN p."endpointAAccount" = a.account THEN p."endpointBAccount" ELSE p."endpointAAccount" END AS account,
    CASE WHEN t.type = 'GROUP' THEN t."groupDomain"
      WHEN p."endpointAAccount" = a.account THEN ns.domain ELSE 'local' END AS domain,
    CASE WHEN t.type = 'GROUP' THEN t."authorityNamespaceId"
      WHEN p."endpointAAccount" = a.account THEN p."endpointBNamespaceId" ELSE 0 END AS namespace_id,
    COALESCE(i."profileRev", 0) AS profile_rev
  INTO facts
  FROM "AccountThreadState" s
  JOIN "Account" a ON a.id = s."accountId"
  JOIN "MessageThread" t ON t.id = s."threadId"
  JOIN "RelationshipPair" p ON p."threadId" = t.id AND p.established
    AND ((p."endpointAType" = 'USER' AND p."endpointAAccount" = a.account)
      OR (p."endpointBType" = 'USER' AND p."endpointBAccount" = a.account))
  JOIN "IdentityNamespace" ns ON ns.id = p."endpointBNamespaceId"
  LEFT JOIN LATERAL (
    SELECT i."profileRev" AS "profileRev"
    FROM "RelationshipIntent" i
    WHERE i."authorAccount" = CASE WHEN p."endpointAAccount" = a.account
        THEN p."endpointBAccount" ELSE p."endpointAAccount" END
      AND i."authorNamespaceId" = CASE WHEN p."endpointAAccount" = a.account
        THEN p."endpointBNamespaceId" ELSE 0 END
      AND i."receiverAccount" = CASE WHEN p."endpointAAccount" = a.account
        THEN p."endpointAAccount" ELSE p."endpointBAccount" END
      AND i."receiverNamespaceId" = CASE WHEN p."endpointAAccount" = a.account
        THEN 0 ELSE p."endpointBNamespaceId" END
    LIMIT 1
  ) i ON true
  WHERE s."accountId" = owner_id AND s."threadId" = thread_id;
  IF NOT FOUND THEN RETURN; END IF;
  compact_key := '["THREAD_STATE",0,"","local","' || thread_id::text || '","local"]';
  SELECT body INTO previous FROM "ClientStateFeed" WHERE "userId" = owner_id AND "compactionKey" = compact_key;
  activated := facts.active AND (previous IS NULL OR previous->>'conversationState' <> 'ACTIVE');
  profile_ref := CASE WHEN previous IS NOT NULL AND NOT activated THEN previous->'profile'
    ELSE jsonb_build_object('account', facts.account, 'domain', facts.domain,
      'namespaceId', CASE WHEN facts.domain = 'local' THEN 0 ELSE facts.namespace_id END,
      'profileRev', facts.profile_rev) END;
  snapshot := jsonb_build_object('threadId', thread_id, 'type', facts.type,
    'authorityNamespaceId', facts."authorityNamespaceId", 'blocked', facts.blocked,
    'role', CASE WHEN facts.active THEN facts.role ELSE NULL END,
    'conversationState', CASE WHEN facts.active THEN 'ACTIVE' ELSE 'READ_ONLY' END,
    'establishedAt', CASE WHEN activated AND activation_at IS NOT NULL THEN activation_at
      ELSE COALESCE((previous->>'establishedAt')::bigint, floor(extract(epoch FROM facts."createdAt") * 1000)::bigint) END,
    'profile', profile_ref);
  IF snapshot IS NOT DISTINCT FROM previous THEN RETURN; END IF;
  UPDATE "Account" SET "clientStateFeedEndId" = "clientStateFeedEndId" + 1
    WHERE id = owner_id RETURNING "clientStateFeedEndId" INTO position;
  INSERT INTO "ClientStateFeed" ("userId", account, domain, "eventType", "subjectAccount", "subjectDomain", "namespaceId", "feedId", body, "compactionKey")
    VALUES (owner_id, '', 'local', 'THREAD_STATE', thread_id::text, 'local', 0, position, snapshot, compact_key)
    ON CONFLICT ("userId", "compactionKey") DO UPDATE SET body = EXCLUDED.body, "feedId" = EXCLUDED."feedId", "updatedAt" = CURRENT_TIMESTAMP;
END;
$$;

CREATE OR REPLACE FUNCTION public.thread_feed_after_pair() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE participant record;
DECLARE seed_revision boolean;
BEGIN
  IF NEW."threadId" IS NULL OR NOT NEW.established THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    seed_revision := NEW.kind = 'P2P';
  ELSE
    IF OLD.active IS NOT DISTINCT FROM NEW.active
      AND OLD.established IS NOT DISTINCT FROM NEW.established
      AND OLD."threadId" IS NOT DISTINCT FROM NEW."threadId" THEN RETURN NEW; END IF;
    seed_revision := NEW.kind = 'P2P'
      AND (NOT OLD.established OR (NOT OLD.active AND NEW.active));
  END IF;
  FOR participant IN
    SELECT s."accountId", intent."profileRev" AS "profileRev"
    FROM "AccountThreadState" s
    JOIN "Account" a ON a.id = s."accountId"
    LEFT JOIN LATERAL (
      SELECT intent."profileRev" AS "profileRev"
      FROM "RelationshipIntent" intent
      WHERE NEW.kind = 'P2P'
        AND intent."authorAccount" = CASE WHEN NEW."endpointAAccount" = a.account
          THEN NEW."endpointBAccount" ELSE NEW."endpointAAccount" END
        AND intent."authorNamespaceId" = CASE WHEN NEW."endpointAAccount" = a.account
          THEN NEW."endpointBNamespaceId" ELSE 0 END
        AND intent."receiverAccount" = CASE WHEN NEW."endpointAAccount" = a.account
          THEN NEW."endpointAAccount" ELSE NEW."endpointBAccount" END
        AND intent."receiverNamespaceId" = CASE WHEN NEW."endpointAAccount" = a.account
          THEN 0 ELSE NEW."endpointBNamespaceId" END
      LIMIT 1
    ) intent ON true
    WHERE s."threadId" = NEW."threadId"
      AND ((NEW."endpointAType" = 'USER' AND NEW."endpointAAccount" = a.account)
        OR (NEW."endpointBType" = 'USER' AND NEW."endpointBAccount" = a.account))
    ORDER BY s."accountId"
  LOOP
    PERFORM 1 FROM "Account" WHERE id = participant."accountId" FOR NO KEY UPDATE;
    UPDATE "AccountThreadState" s
    SET "threadFeedId" = 0,
        "threadProfileRev" = CASE WHEN seed_revision AND participant."profileRev" IS NOT NULL
          THEN participant."profileRev" ELSE s."threadProfileRev" END,
        "profileSourceId" = CASE WHEN seed_revision AND participant."profileRev" IS NOT NULL
          THEN NULL ELSE s."profileSourceId" END
    WHERE s."accountId" = participant."accountId" AND s."threadId" = NEW."threadId";
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.thread_feed_after_participant() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE initial_rev integer;
BEGIN
  SELECT intent."profileRev" INTO initial_rev
  FROM "RelationshipPair" pair
  JOIN "Account" self ON self.id = NEW."accountId"
  LEFT JOIN LATERAL (
    SELECT i."profileRev" AS "profileRev"
    FROM "RelationshipIntent" i
    WHERE pair.kind = 'P2P'
      AND i."authorAccount" = CASE WHEN pair."endpointAAccount" = self.account
        THEN pair."endpointBAccount" ELSE pair."endpointAAccount" END
      AND i."authorNamespaceId" = CASE WHEN pair."endpointAAccount" = self.account
        THEN pair."endpointBNamespaceId" ELSE 0 END
      AND i."receiverAccount" = CASE WHEN pair."endpointAAccount" = self.account
        THEN pair."endpointAAccount" ELSE pair."endpointBAccount" END
      AND i."receiverNamespaceId" = CASE WHEN pair."endpointAAccount" = self.account
        THEN 0 ELSE pair."endpointBNamespaceId" END
    LIMIT 1
  ) intent ON true
  WHERE pair."threadId" = NEW."threadId" AND pair.established
    AND ((pair."endpointAType" = 'USER' AND pair."endpointAAccount" = self.account)
      OR (pair."endpointBType" = 'USER' AND pair."endpointBAccount" = self.account));
  IF initial_rev IS NOT NULL AND (initial_rev IS DISTINCT FROM NEW."threadProfileRev"
    OR NEW."profileSourceId" IS NOT NULL) THEN
    UPDATE "AccountThreadState" SET "threadProfileRev" = initial_rev,
      "profileSourceId" = NULL
    WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
