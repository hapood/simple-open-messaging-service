-- Greenfield schema baseline.
-- Future schema changes belong in new migration files.

--
-- PostgreSQL database dump
--



SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS '';


--
-- Name: AdminAuditStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."AdminAuditStatus" AS ENUM (
    'STARTED',
    'SUCCEEDED',
    'FAILED'
);


--
-- Name: AdminRole; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."AdminRole" AS ENUM (
    'SUPER_ADMIN',
    'ADMIN',
    'VIEWER'
);


--
-- Name: ContentType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ContentType" AS ENUM (
    'PURE_TEXT',
    'IMAGE',
    'VIDEO',
    'FILE',
    'AUDIO',
    'LINK',
    'CONTACT_CARD',
    'FORWARD',
    'GALLERY',
    'SYSTEM'
);


--
-- Name: DurableTaskKind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."DurableTaskKind" AS ENUM (
    'MUTATION',
    'PROJECTION'
);


--
-- Name: DurableTaskScopeType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."DurableTaskScopeType" AS ENUM (
    'THREAD',
    'USER_PAIR',
    'GROUP',
    'ACCOUNT_THREAD'
);


--
-- Name: DurableTaskStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."DurableTaskStatus" AS ENUM (
    'PENDING',
    'PROCESSING',
    'SUCCEEDED',
    'REJECTED',
    'FAILED',
    'SUPERSEDED'
);


--
-- Name: FileSyncDirection; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."FileSyncDirection" AS ENUM (
    'OUTBOUND',
    'INBOUND'
);


--
-- Name: FileSyncKind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."FileSyncKind" AS ENUM (
    'FILE',
    'IMAGE',
    'VIDEO',
    'AUDIO',
    'LINK_CARD',
    'BUNDLE'
);


--
-- Name: FileSyncStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."FileSyncStatus" AS ENUM (
    'PENDING',
    'DOWNLOADING',
    'SUCCEEDED',
    'FAILED',
    'TOMBSTONED'
);


--
-- Name: GroupMetaMemberOperation; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."GroupMetaMemberOperation" AS ENUM (
    'MEMBER_UPSERT',
    'MEMBER_DEPART',
    'GROUP_PROFILE'
);


--
-- Name: GroupRole; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."GroupRole" AS ENUM (
    'OWNER',
    'ADMIN',
    'MEMBER'
);


--
-- Name: MessageDeleteType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."MessageDeleteType" AS ENUM (
    'USER_RETRACTION',
    'MODERATION_REMOVAL'
);


--
-- Name: MessageLocalState; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."MessageLocalState" AS ENUM (
    'STUB',
    'FAILED',
    'READY'
);


--
-- Name: MessageThreadType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."MessageThreadType" AS ENUM (
    'P2P',
    'GROUP'
);


--
-- Name: PeerStateEventType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."PeerStateEventType" AS ENUM (
    'RELATIONSHIP_INTENT',
    'THREAD_CONTENT_HEAD'
);


--
-- Name: PushPlatform; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."PushPlatform" AS ENUM (
    'ANDROID',
    'WEB',
    'IOS'
);


--
-- Name: RelationshipIntentStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."RelationshipIntentStatus" AS ENUM (
    'REQUESTED',
    'ACCEPTED',
    'REVOKED'
);


--
-- Name: RequestProjectionStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."RequestProjectionStatus" AS ENUM (
    'REQUESTED',
    'ACCEPTED',
    'WITHDRAWN',
    'REJECTED',
    'EXPIRED'
);


--
-- Name: UploadSessionStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."UploadSessionStatus" AS ENUM (
    'UPLOADING',
    'COMPLETING',
    'COMPLETED',
    'ABORTED'
);


--
-- Name: attention_history_after_write(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.attention_history_after_write() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE s "AccountThreadState";
BEGIN
  IF NEW."clearedSeq" IS NOT DISTINCT FROM OLD."clearedSeq" THEN RETURN NULL; END IF;
  FOR s IN SELECT * FROM "AccountThreadState" WHERE "threadId" = NEW.id ORDER BY "accountId" FOR NO KEY UPDATE LOOP
    UPDATE "AccountThreadState" SET "unreadCount" =
      thread_unread_count(s, NEW."clearedSeq", s."lastReadSeq", s."messageEndSeq") WHERE id = s.id;
  END LOOP;
  RETURN NULL;
END;
$$;


--
-- Name: attention_message_before_write(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.attention_message_before_write() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW.seq = OLD.seq AND NEW."threadId" = OLD."threadId"
    AND NEW."localState" = OLD."localState" AND NEW."isDeleted" = OLD."isDeleted"
    AND NEW."creatorAccount" IS NOT DISTINCT FROM OLD."creatorAccount"
    AND NEW."creatorDomain" IS NOT DISTINCT FROM OLD."creatorDomain"
    AND NEW."creatorNamespaceId" = OLD."creatorNamespaceId"
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


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: AccountThreadState; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AccountThreadState" (
    id integer NOT NULL,
    "accountId" integer NOT NULL,
    "threadId" integer NOT NULL,
    role public."GroupRole",
    "lastReadSeq" integer DEFAULT 0 NOT NULL,
    muted boolean DEFAULT false NOT NULL,
    blocked boolean DEFAULT false NOT NULL,
    pinned boolean DEFAULT false NOT NULL,
    "pinnedAt" timestamp(3) with time zone,
    "messageVisibleThroughSeq" bigint,
    alias character varying(64),
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "threadFeedId" integer DEFAULT 0 NOT NULL,
    "unreadCount" integer DEFAULT 0 NOT NULL,
    "lastMentionSeq" integer,
    "messageEndSeq" integer DEFAULT 0 NOT NULL,
    "tombstoneEndSeq" integer DEFAULT 0 NOT NULL,
    "previewSeqs" integer[] DEFAULT '{}'::integer[] NOT NULL,
    "joinRequestEndFeedId" integer DEFAULT 0 NOT NULL,
    "joinRequestReadFeedId" integer DEFAULT '-1'::integer NOT NULL,
    "groupInviteEndFeedId" integer DEFAULT 0 NOT NULL,
    "groupMetaFeedEndId" integer,
    "announcementReadFeedId" integer DEFAULT 0 NOT NULL,
    "threadProfileRev" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "AccountThreadState_announcementReadFeedId_check" CHECK (("announcementReadFeedId" >= 0)),
    CONSTRAINT "AccountThreadState_groupInviteEndFeedId_check" CHECK (("groupInviteEndFeedId" >= 0)),
    CONSTRAINT "AccountThreadState_groupMetaFeedEndId_check" CHECK ((("groupMetaFeedEndId" IS NULL) OR ("groupMetaFeedEndId" >= 0))),
    CONSTRAINT "AccountThreadState_joinRequestEndFeedId_check" CHECK (("joinRequestEndFeedId" >= 0)),
    CONSTRAINT "AccountThreadState_joinRequestReadFeedId_check" CHECK ((("joinRequestReadFeedId" >= '-1'::integer) AND ("joinRequestReadFeedId" <= "joinRequestEndFeedId"))),
    CONSTRAINT "AccountThreadState_lastMentionSeq_check" CHECK ((("lastMentionSeq" IS NULL) OR ("lastMentionSeq" > 0))),
    CONSTRAINT "AccountThreadState_lastReadSeq_check" CHECK (("lastReadSeq" >= 0)),
    CONSTRAINT "AccountThreadState_messageEndSeq_check" CHECK (("messageEndSeq" >= 0)),
    CONSTRAINT "AccountThreadState_messageVisibleThroughSeq_check" CHECK ((("messageVisibleThroughSeq" IS NULL) OR ("messageVisibleThroughSeq" >= 0))),
    CONSTRAINT "AccountThreadState_threadFeedId_check" CHECK (("threadFeedId" > 0)),
    CONSTRAINT "AccountThreadState_threadProfileRev_check" CHECK (("threadProfileRev" >= 0)),
    CONSTRAINT "AccountThreadState_tombstoneEndSeq_check" CHECK (("tombstoneEndSeq" >= 0)),
    CONSTRAINT "AccountThreadState_unreadCount_check" CHECK (("unreadCount" >= 0))
);


--
-- Name: Message; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Message" (
    id bigint NOT NULL,
    seq integer NOT NULL,
    "contentType" public."ContentType" NOT NULL,
    content jsonb NOT NULL,
    "threadId" integer NOT NULL,
    "creatorAccount" character varying(31),
    "creatorDomain" character varying(63),
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone NOT NULL,
    "isDeleted" boolean DEFAULT false NOT NULL,
    "clientMessageId" character varying(36),
    "originSeq" integer,
    "originServerTime" timestamp(3) with time zone,
    "sourceNamespaceId" integer DEFAULT 0 NOT NULL,
    "localState" public."MessageLocalState" DEFAULT 'READY'::public."MessageLocalState" NOT NULL,
    "profileRev" integer DEFAULT 0 NOT NULL,
    "creatorNamespaceId" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "Message_creator_namespace_check" CHECK ((("creatorDomain" IS NULL) OR ((("creatorDomain")::text = 'local'::text) = ("creatorNamespaceId" = 0)))),
    CONSTRAINT "Message_origin_seq_check" CHECK ((("sourceNamespaceId" = 0) OR (("originSeq" IS NOT NULL) AND ("originSeq" > 0)))),
    CONSTRAINT "Message_profileRev_check" CHECK (("profileRev" >= 0)),
    CONSTRAINT "Message_seq_check" CHECK ((seq > 0)),
    CONSTRAINT "Message_system_creator_check" CHECK ((("creatorAccount" IS NOT NULL) AND ("creatorDomain" IS NOT NULL) AND ((("contentType" = 'SYSTEM'::public."ContentType") AND (("creatorAccount")::text = '$system'::text) AND (("creatorDomain")::text = 'local'::text) AND ("creatorNamespaceId" = 0) AND ("profileRev" = 0) AND ("sourceNamespaceId" = 0)) OR (("contentType" <> 'SYSTEM'::public."ContentType") AND (("creatorAccount")::text <> '$system'::text)))))
);


--
-- Name: attention_message_eligible(public."Message", public."AccountThreadState", integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.attention_message_eligible(m public."Message", s public."AccountThreadState", cleared integer) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT m."threadId" = s."threadId" AND m.seq > COALESCE(cleared, 0)
    AND (s."messageVisibleThroughSeq" IS NULL OR m.seq <= s."messageVisibleThroughSeq")
    AND NOT EXISTS (SELECT 1 FROM "Account" a WHERE a.id = s."accountId"
      AND a.account = m."creatorAccount" AND a.domain = m."creatorDomain"
      AND a."namespaceId" = m."creatorNamespaceId")
    AND NOT s.blocked;
$$;


--
-- Name: client_thread_state_after_pair(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.client_thread_state_after_pair() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE participant record;
BEGIN
  IF NEW."threadId" IS NULL OR NOT NEW.established THEN RETURN NEW; END IF;
  FOR participant IN
    SELECT s."accountId" FROM "AccountThreadState" s JOIN "Account" a ON a.id = s."accountId"
    WHERE s."threadId" = NEW."threadId"
      AND ((NEW."endpointAType" = 'USER' AND NEW."endpointAAccount" = a.account AND NEW."endpointADomain" = 'local')
        OR (NEW."endpointBType" = 'USER' AND NEW."endpointBAccount" = a.account AND NEW."endpointBDomain" = 'local'))
    ORDER BY s."accountId"
  LOOP
    PERFORM publish_client_thread_state(participant."accountId", NEW."threadId",
      CASE WHEN NEW.active AND (TG_OP = 'INSERT' OR NOT OLD.active)
        THEN floor(extract(epoch FROM CURRENT_TIMESTAMP) * 1000)::bigint ELSE NULL END);
  END LOOP;
  RETURN NEW;
END;
$$;


--
-- Name: client_thread_state_after_participant(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.client_thread_state_after_participant() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM publish_client_thread_state(NEW."accountId", NEW."threadId");
  RETURN NEW;
END;
$$;


--
-- Name: group_meta_member_namespace(integer, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.group_meta_member_namespace(p_thread_id integer, p_account text, p_domain text) RETURNS integer
    LANGUAGE sql STABLE
    AS $$
  SELECT CASE WHEN p_domain = 'local' THEN 0 ELSE COALESCE((
    SELECT pair."endpointBNamespaceId"
    FROM "RelationshipPair" pair
    WHERE pair.kind = 'GROUP_MEMBER' AND pair."threadId" = p_thread_id
      AND pair."endpointBType" = 'USER'
      AND pair."endpointBAccount" = p_account
      AND pair."endpointBDomain" = p_domain
    ORDER BY pair.active DESC, pair."updatedAt" DESC, pair.id DESC
    LIMIT 1
  ), (
    SELECT thread."authorityNamespaceId"
    FROM "MessageThread" thread WHERE thread.id = p_thread_id
  )) END;
$$;


--
-- Name: notify_durable_task_work(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_durable_task_work() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM pg_notify('durable_task_work', '');
  RETURN NULL;
END;
$$;


--
-- Name: publish_client_thread_state(integer, integer, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.publish_client_thread_state(owner_id integer, thread_id integer, activation_at bigint DEFAULT NULL::bigint) RETURNS void
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
      WHEN p."endpointAAccount" = a.account AND p."endpointADomain" = 'local' THEN p."endpointBAccount" ELSE p."endpointAAccount" END AS account,
    CASE WHEN t.type = 'GROUP' THEN t."groupDomain"
      WHEN p."endpointAAccount" = a.account AND p."endpointADomain" = 'local' THEN p."endpointBDomain" ELSE p."endpointADomain" END AS domain,
    CASE WHEN t.type = 'GROUP' THEN t."authorityNamespaceId"
      WHEN p."endpointAAccount" = a.account AND p."endpointADomain" = 'local' THEN p."endpointBNamespaceId" ELSE p."endpointANamespaceId" END AS namespace_id,
    COALESCE(i."profileRev", 0) AS profile_rev
  INTO facts
  FROM "AccountThreadState" s
  JOIN "Account" a ON a.id = s."accountId"
  JOIN "MessageThread" t ON t.id = s."threadId"
  JOIN "RelationshipPair" p ON p."threadId" = t.id AND p.established
    AND ((p."endpointAType" = 'USER' AND p."endpointAAccount" = a.account AND p."endpointADomain" = 'local')
      OR (p."endpointBType" = 'USER' AND p."endpointBAccount" = a.account AND p."endpointBDomain" = 'local'))
  LEFT JOIN "RelationshipIntent" i ON i."pairId" = p.id AND i."authorSide" =
    CASE WHEN p."endpointAType" = 'USER' AND p."endpointAAccount" = a.account AND p."endpointADomain" = 'local' THEN 'B' ELSE 'A' END
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


--
-- Name: relationship_establishment_before_write(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.relationship_establishment_before_write() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.established := NEW.established OR NEW.active;
  IF TG_OP = 'UPDATE' THEN NEW.established := NEW.established OR OLD.established; END IF;
  RETURN NEW;
END;
$$;


--
-- Name: thread_feed_before_write(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.thread_feed_before_write() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE c integer;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."accountId" <> OLD."accountId" OR NEW."threadId" <> OLD."threadId") THEN
    RAISE EXCEPTION 'attention owner and thread are immutable';
  END IF;
  -- Blocking still reconciles attention in the source transaction. Ordinary
  -- read/head updates already contain the signed delta computed by the writer.
  IF TG_OP = 'UPDATE' AND NEW.blocked IS DISTINCT FROM OLD.blocked THEN
    SELECT "clearedSeq" INTO c FROM "MessageThread" WHERE id = NEW."threadId" FOR NO KEY UPDATE;
    NEW."unreadCount" := thread_unread_count(NEW, c, NEW."lastReadSeq", NEW."messageEndSeq");
    NEW."previewSeqs" := ARRAY(SELECT seq FROM unnest(NEW."previewSeqs") seq
      WHERE seq >= NEW."lastReadSeq" AND seq > COALESCE(c, 0)
        AND seq <= COALESCE(NEW."messageVisibleThroughSeq", NEW."messageEndSeq") ORDER BY seq DESC);
  END IF;
  IF TG_OP = 'INSERT' OR NEW."threadFeedId" = 0
    OR NEW.alias IS DISTINCT FROM OLD.alias
    OR NEW."previewSeqs" IS DISTINCT FROM OLD."previewSeqs"
    OR NEW."unreadCount" IS DISTINCT FROM OLD."unreadCount"
    OR NEW."lastReadSeq" IS DISTINCT FROM OLD."lastReadSeq"
    OR NEW."announcementReadFeedId" IS DISTINCT FROM OLD."announcementReadFeedId"
    OR NEW."lastMentionSeq" IS DISTINCT FROM OLD."lastMentionSeq"
    OR NEW."messageEndSeq" IS DISTINCT FROM OLD."messageEndSeq"
    OR NEW."tombstoneEndSeq" IS DISTINCT FROM OLD."tombstoneEndSeq"
    OR NEW."joinRequestEndFeedId" IS DISTINCT FROM OLD."joinRequestEndFeedId"
    OR NEW."groupInviteEndFeedId" IS DISTINCT FROM OLD."groupInviteEndFeedId"
    OR NEW."joinRequestReadFeedId" IS DISTINCT FROM OLD."joinRequestReadFeedId"
    OR NEW."groupMetaFeedEndId" IS DISTINCT FROM OLD."groupMetaFeedEndId" THEN
    UPDATE "Account" SET "threadFeedEndId" = "threadFeedEndId" + 1
      WHERE id = NEW."accountId" RETURNING "threadFeedEndId" INTO NEW."threadFeedId";
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: thread_unread_count(public."AccountThreadState", integer, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.thread_unread_count(s public."AccountThreadState", cleared integer, after_seq integer, through_seq integer) RETURNS integer
    LANGUAGE sql STABLE
    AS $$
  SELECT count(*)::integer FROM "Message" m
  WHERE m."threadId" = s."threadId" AND m.seq > after_seq AND m.seq <= through_seq
    AND attention_message_eligible(m, s, cleared);
$$;


--
-- Name: Account; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Account" (
    id integer NOT NULL,
    "hashPwd" character varying(127),
    "mustChangePassword" boolean DEFAULT false NOT NULL,
    "disabledAt" timestamp(3) with time zone,
    "clientStateFeedEndId" integer DEFAULT 0 NOT NULL,
    "threadFeedEndId" integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    account character varying(31) NOT NULL,
    domain character varying(63) DEFAULT 'local'::character varying NOT NULL,
    "namespaceId" integer DEFAULT 0 NOT NULL,
    "defaultProfileRev" integer DEFAULT 0 NOT NULL,
    availability character varying(16) DEFAULT 'AVAILABLE'::character varying NOT NULL,
    kind character varying(16) DEFAULT 'USER'::character varying NOT NULL,
    CONSTRAINT "Account_account_check" CHECK (((account)::text !~~ '!%'::text)),
    CONSTRAINT "Account_availability_check" CHECK (((availability)::text = ANY (ARRAY[('AVAILABLE'::character varying)::text, ('REMOVED'::character varying)::text]))),
    CONSTRAINT "Account_clientStateFeedEndId_check" CHECK (("clientStateFeedEndId" >= 0)),
    CONSTRAINT "Account_defaultProfileRev_check" CHECK (("defaultProfileRev" >= 0)),
    CONSTRAINT "Account_kind_check" CHECK (((((kind)::text = 'USER'::text) AND ((account)::text <> '$system'::text)) OR (((kind)::text = 'SYSTEM'::text) AND ((account)::text = '$system'::text) AND ("hashPwd" IS NULL) AND ("disabledAt" IS NOT NULL) AND ("defaultProfileRev" = 0)))),
    CONSTRAINT "Account_local_identity_check" CHECK ((((domain)::text = 'local'::text) AND ("namespaceId" = 0))),
    CONSTRAINT "Account_threadFeedEndId_check" CHECK (("threadFeedEndId" >= 0))
);


--
-- Name: Account_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."Account_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: Account_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."Account_id_seq" OWNED BY public."Account".id;


--
-- Name: Admin; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Admin" (
    id integer NOT NULL,
    "userId" integer NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    "lastLoginIp" character varying(64),
    "lastLoginAt" timestamp(3) with time zone,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone NOT NULL,
    role public."AdminRole" DEFAULT 'SUPER_ADMIN'::public."AdminRole" NOT NULL,
    "twoFactorEnabled" boolean DEFAULT false NOT NULL,
    "twoFactorSecretCipher" character varying(255),
    "twoFactorEnabledAt" timestamp(3) with time zone,
    "twoFactorLastUsedCounter" integer,
    "webauthnEnabled" boolean DEFAULT false NOT NULL
);


--
-- Name: AdminActionLog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AdminActionLog" (
    id bigint NOT NULL,
    "adminId" integer NOT NULL,
    "adminRole" public."AdminRole" NOT NULL,
    action character varying(64) NOT NULL,
    "targetType" character varying(32),
    "targetId" character varying(64),
    ip character varying(64),
    "userAgent" character varying(255),
    route character varying(255),
    "errorMessage" character varying(255),
    meta jsonb,
    at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    status public."AdminAuditStatus" DEFAULT 'STARTED'::public."AdminAuditStatus" NOT NULL
);


--
-- Name: AdminActionLog_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."AdminActionLog_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: AdminActionLog_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."AdminActionLog_id_seq" OWNED BY public."AdminActionLog".id;


--
-- Name: AdminLoginChallenge; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AdminLoginChallenge" (
    jti character varying(36) NOT NULL,
    "adminId" integer NOT NULL,
    "consumedAt" timestamp(3) with time zone,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: AdminSession; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AdminSession" (
    id bigint NOT NULL,
    "adminId" integer NOT NULL,
    "tokenHash" text NOT NULL,
    "userAgent" character varying(255),
    ip character varying(64),
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "lastAccessedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "expiresAt" timestamp(3) with time zone NOT NULL,
    "revokedAt" timestamp(3) with time zone,
    "revokeReason" character varying(32)
);


--
-- Name: AdminSession_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."AdminSession_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: AdminSession_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."AdminSession_id_seq" OWNED BY public."AdminSession".id;


--
-- Name: Admin_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."Admin_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: Admin_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."Admin_id_seq" OWNED BY public."Admin".id;


--
-- Name: CallHistory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."CallHistory" (
    key text NOT NULL,
    "threadId" integer NOT NULL,
    snapshot jsonb NOT NULL,
    revision integer NOT NULL,
    terminal boolean DEFAULT false NOT NULL,
    "messageSeq" integer
);


--
-- Name: CallTombstone; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."CallTombstone" (
    "namespaceId" integer NOT NULL,
    "callSid" character varying(36) NOT NULL,
    "terminalOp" character varying(16) NOT NULL,
    "endReason" character varying(16),
    "initialCallType" character varying(8) NOT NULL,
    "finalCallType" character varying(8) NOT NULL,
    "signalIds" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "expiresAt" timestamp(3) with time zone NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT now() NOT NULL
);


--
-- Name: ClientStateFeed; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ClientStateFeed" (
    id bigint NOT NULL,
    "userId" integer NOT NULL,
    account character varying(31) NOT NULL,
    domain character varying(63) NOT NULL,
    "eventType" character varying(31) NOT NULL,
    "subjectAccount" character varying(31) DEFAULT ''::character varying NOT NULL,
    "subjectDomain" character varying(63) DEFAULT 'local'::character varying NOT NULL,
    "namespaceId" integer DEFAULT 0 NOT NULL,
    "feedId" integer NOT NULL,
    body jsonb NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "compactionKey" text NOT NULL,
    CONSTRAINT "ClientStateFeed_feedId_check" CHECK (("feedId" > 0))
);


--
-- Name: ClientStateFeed_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."ClientStateFeed_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ClientStateFeed_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."ClientStateFeed_id_seq" OWNED BY public."ClientStateFeed".id;


--
-- Name: DeletedMessage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."DeletedMessage" (
    "threadId" integer NOT NULL,
    "deletionSeq" integer NOT NULL,
    "messageSeq" integer NOT NULL,
    type public."MessageDeleteType" NOT NULL,
    "sourceNamespaceId" integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "DeletedMessage_deletionSeq_check" CHECK (("deletionSeq" > 0)),
    CONSTRAINT "DeletedMessage_messageSeq_check" CHECK (("messageSeq" > 0))
);


--
-- Name: DiagnosticsReport; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."DiagnosticsReport" (
    id integer NOT NULL,
    "reporterUserId" integer NOT NULL,
    "bundlePath" character varying(255) NOT NULL,
    "bundleBytes" integer NOT NULL,
    manifest jsonb NOT NULL,
    status character varying(16) DEFAULT 'new'::character varying NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone NOT NULL,
    "isDeleted" boolean DEFAULT false NOT NULL
);


--
-- Name: DiagnosticsReport_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."DiagnosticsReport_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: DiagnosticsReport_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."DiagnosticsReport_id_seq" OWNED BY public."DiagnosticsReport".id;


--
-- Name: DurableTask; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."DurableTask" (
    id bigint NOT NULL,
    kind public."DurableTaskKind" NOT NULL,
    "scopeType" public."DurableTaskScopeType" NOT NULL,
    "scopeKey" character varying(512) NOT NULL,
    "taskType" character varying(64) NOT NULL,
    "actorUserId" integer,
    payload jsonb NOT NULL,
    checkpoint jsonb DEFAULT '{}'::jsonb NOT NULL,
    "coalescingKey" character varying(512),
    status public."DurableTaskStatus" DEFAULT 'PENDING'::public."DurableTaskStatus" NOT NULL,
    "resultCode" integer,
    "lastError" character varying(1000),
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "startedAt" timestamp(3) with time zone,
    "completedAt" timestamp(3) with time zone,
    CONSTRAINT "DurableTask_actor_user_id_check" CHECK ((("actorUserId" IS NULL) OR ("actorUserId" > 0))),
    CONSTRAINT "DurableTask_checkpoint_check" CHECK ((jsonb_typeof(checkpoint) = 'object'::text)),
    CONSTRAINT "DurableTask_coalescing_key_check" CHECK ((("coalescingKey" IS NULL) OR (length(("coalescingKey")::text) > 0))),
    CONSTRAINT "DurableTask_error_check" CHECK ((("lastError" IS NULL) OR (status = 'FAILED'::public."DurableTaskStatus"))),
    CONSTRAINT "DurableTask_payload_check" CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT "DurableTask_result_check" CHECK ((("resultCode" IS NULL) OR (status = ANY (ARRAY['SUCCEEDED'::public."DurableTaskStatus", 'REJECTED'::public."DurableTaskStatus"])))),
    CONSTRAINT "DurableTask_scope_key_check" CHECK ((length(("scopeKey")::text) > 0)),
    CONSTRAINT "DurableTask_status_timestamps_check" CHECK ((((status = 'PENDING'::public."DurableTaskStatus") AND ("startedAt" IS NULL) AND ("completedAt" IS NULL)) OR ((status = 'PROCESSING'::public."DurableTaskStatus") AND ("startedAt" IS NOT NULL) AND ("completedAt" IS NULL)) OR ((status = ANY (ARRAY['SUCCEEDED'::public."DurableTaskStatus", 'REJECTED'::public."DurableTaskStatus", 'FAILED'::public."DurableTaskStatus"])) AND ("startedAt" IS NOT NULL) AND ("completedAt" IS NOT NULL)) OR ((status = 'SUPERSEDED'::public."DurableTaskStatus") AND ("startedAt" IS NULL) AND ("completedAt" IS NOT NULL)))),
    CONSTRAINT "DurableTask_supersession_check" CHECK (((status <> 'SUPERSEDED'::public."DurableTaskStatus") OR ("coalescingKey" IS NOT NULL))),
    CONSTRAINT "DurableTask_task_type_check" CHECK ((("taskType")::text ~ '^[A-Z][A-Z0-9_]*$'::text)),
    CONSTRAINT "DurableTask_timestamp_order_check" CHECK (((("startedAt" IS NULL) OR ("startedAt" >= "createdAt")) AND (("completedAt" IS NULL) OR ("completedAt" >= "createdAt")) AND (("completedAt" IS NULL) OR ("startedAt" IS NULL) OR ("completedAt" >= "startedAt"))))
);


--
-- Name: DurableTask_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."DurableTask_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: DurableTask_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."DurableTask_id_seq" OWNED BY public."DurableTask".id;


--
-- Name: FederatedMessageTombstone; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FederatedMessageTombstone" (
    id bigint NOT NULL,
    "threadId" integer NOT NULL,
    "messageSeq" integer NOT NULL,
    "sourceNamespaceId" integer NOT NULL,
    "remoteDeletionSeq" integer NOT NULL,
    type public."MessageDeleteType" NOT NULL,
    "authorityDeletedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "FederatedMessageTombstone_message_seq_check" CHECK (("messageSeq" > 0)),
    CONSTRAINT "FederatedMessageTombstone_remoteDeletionSeq_check" CHECK (("remoteDeletionSeq" > 0))
);


--
-- Name: FederatedMessageTombstone_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."FederatedMessageTombstone_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: FederatedMessageTombstone_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."FederatedMessageTombstone_id_seq" OWNED BY public."FederatedMessageTombstone".id;


--
-- Name: FederatedPeer; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FederatedPeer" (
    domain character varying(63) NOT NULL,
    "activeNamespaceId" integer,
    "trustLevel" character varying(31) DEFAULT 'unrecognized'::character varying NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "trustedAt" timestamp(3) with time zone,
    "lastSuccessAt" timestamp(3) with time zone,
    "degradedAt" timestamp(3) with time zone,
    "degradationReason" character varying(255),
    "degradationCount" integer DEFAULT 0 NOT NULL,
    "haltedAt" timestamp(3) with time zone,
    "haltCode" integer,
    "haltReason" character varying(255),
    "recognizesPeer" boolean DEFAULT false NOT NULL,
    "localServiceAvailable" boolean DEFAULT false NOT NULL,
    "remoteServiceReachable" boolean DEFAULT false NOT NULL,
    "resetAt" timestamp(3) with time zone,
    "peerAcceptanceConfirmed" boolean DEFAULT false NOT NULL,
    CONSTRAINT "FederatedPeer_trustLevel_check" CHECK ((("trustLevel")::text = ANY (ARRAY[('unrecognized'::character varying)::text, ('establishing'::character varying)::text, ('available'::character varying)::text, ('degraded'::character varying)::text, ('halted'::character varying)::text])))
);


--
-- Name: FederatedPeerEvent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FederatedPeerEvent" (
    id bigint NOT NULL,
    domain character varying(63) NOT NULL,
    type character varying(15) NOT NULL,
    reason character varying(255),
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: FederatedPeerEvent_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."FederatedPeerEvent_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: FederatedPeerEvent_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."FederatedPeerEvent_id_seq" OWNED BY public."FederatedPeerEvent".id;


--
-- Name: FederationMessageReceipt; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FederationMessageReceipt" (
    "namespaceId" integer NOT NULL,
    "threadId" integer NOT NULL,
    "peerSeq" integer NOT NULL,
    "messageId" bigint NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "FederationMessageReceipt_peerSeq_check" CHECK (("peerSeq" > 0))
);


--
-- Name: FederationThreadHistoryGap; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FederationThreadHistoryGap" (
    id bigint NOT NULL,
    "threadId" integer NOT NULL,
    "startSeq" integer NOT NULL,
    "endSeq" integer NOT NULL,
    recoverable boolean DEFAULT true NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "messageSeqOffset" integer DEFAULT 0 NOT NULL,
    "namespaceId" integer NOT NULL,
    CONSTRAINT "FederationThreadHistoryGap_interval_check" CHECK ((("startSeq" > 0) AND ("endSeq" >= "startSeq") AND ("messageSeqOffset" >= 0)))
);


--
-- Name: FederationThreadHistoryGap_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."FederationThreadHistoryGap_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: FederationThreadHistoryGap_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."FederationThreadHistoryGap_id_seq" OWNED BY public."FederationThreadHistoryGap".id;


--
-- Name: FederationThreadSyncState; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FederationThreadSyncState" (
    "threadId" integer NOT NULL,
    "messageTargetSeq" integer DEFAULT 0 NOT NULL,
    "deletionTargetSeq" integer DEFAULT 0 NOT NULL,
    "messageProcessedThroughSeq" integer DEFAULT 0 NOT NULL,
    "deletionProcessedThroughSeq" integer DEFAULT 0 NOT NULL,
    "deletionRecoveryThroughSeq" integer,
    "deletionRecoveryMaxMessageSeq" integer,
    "authorizationEpoch" integer DEFAULT 0 NOT NULL,
    "activeGapId" bigint,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "namespaceId" integer NOT NULL,
    CONSTRAINT "FederationThreadSyncState_deletionRecovery_check" CHECK (((("deletionRecoveryThroughSeq" IS NULL) AND ("deletionRecoveryMaxMessageSeq" IS NULL)) OR (("deletionRecoveryThroughSeq" IS NOT NULL) AND ("deletionRecoveryMaxMessageSeq" IS NOT NULL) AND ("deletionRecoveryThroughSeq" > "deletionProcessedThroughSeq") AND ("deletionRecoveryThroughSeq" <= "deletionTargetSeq") AND ("deletionRecoveryMaxMessageSeq" >= 0)))),
    CONSTRAINT "FederationThreadSyncState_messageSeqs_check" CHECK ((("messageTargetSeq" >= 0) AND ("deletionTargetSeq" >= 0) AND ("messageProcessedThroughSeq" >= 0) AND ("deletionProcessedThroughSeq" >= 0) AND ("messageProcessedThroughSeq" <= "messageTargetSeq") AND ("deletionProcessedThroughSeq" <= "deletionTargetSeq") AND ("authorizationEpoch" >= 0)))
);


--
-- Name: FileSyncProgress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FileSyncProgress" (
    id bigint NOT NULL,
    "batchId" uuid NOT NULL,
    "partId" uuid,
    "position" integer,
    digest character varying(64) NOT NULL,
    direction public."FileSyncDirection" NOT NULL,
    kind public."FileSyncKind" NOT NULL,
    status public."FileSyncStatus" DEFAULT 'PENDING'::public."FileSyncStatus" NOT NULL,
    "bytesTotal" bigint DEFAULT 0 NOT NULL,
    "bytesReceived" bigint DEFAULT 0 NOT NULL,
    "originDomain" character varying(63),
    "namespaceId" integer DEFAULT 0 NOT NULL,
    "errorKind" character varying(255),
    "quotaCounted" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    payload jsonb,
    CONSTRAINT "FileSyncProgress_outbound_part_check" CHECK (((direction <> 'OUTBOUND'::public."FileSyncDirection") OR (("partId" IS NOT NULL) AND ("position" IS NOT NULL)))),
    CONSTRAINT "FileSyncProgress_position_check" CHECK ((("position" IS NULL) OR (("position" >= 0) AND ("position" <= 9))))
);


--
-- Name: FileSyncProgress_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."FileSyncProgress_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: FileSyncProgress_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."FileSyncProgress_id_seq" OWNED BY public."FileSyncProgress".id;


--
-- Name: ForwardBundle; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ForwardBundle" (
    id character varying(26) NOT NULL,
    messages jsonb NOT NULL,
    "messageCount" integer NOT NULL,
    "assetCount" integer NOT NULL,
    "totalBytes" bigint NOT NULL,
    "sourceDomain" character varying(63),
    "sourceNamespaceId" integer,
    "sourceBundleId" character varying(26),
    "createdBy" integer,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "ForwardBundle_asset_count_check" CHECK (("assetCount" >= 0)),
    CONSTRAINT "ForwardBundle_message_count_check" CHECK ((("messageCount" >= 0) AND ("messageCount" <= 500))),
    CONSTRAINT "ForwardBundle_messages_shape_check" CHECK ((jsonb_typeof(messages) = 'array'::text)),
    CONSTRAINT "ForwardBundle_total_bytes_check" CHECK (("totalBytes" >= 0))
);


--
-- Name: ForwardBundleAsset; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ForwardBundleAsset" (
    "bundleId" character varying(26) NOT NULL,
    digest character varying(64) NOT NULL,
    ordinal integer NOT NULL,
    bytes bigint NOT NULL
);


--
-- Name: ForwardBundleDependency; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ForwardBundleDependency" (
    "parentBundleId" character varying(26) NOT NULL,
    "childBundleId" character varying(26) NOT NULL,
    ordinal integer NOT NULL
);


--
-- Name: ForwardMessage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ForwardMessage" (
    "messageId" bigint NOT NULL,
    "bundleId" character varying(26) NOT NULL
);


--
-- Name: GroupAccount; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."GroupAccount" (
    id integer NOT NULL,
    account character varying(31) NOT NULL,
    "defaultProfileRev" integer DEFAULT 0 NOT NULL,
    "dissolvedAt" timestamp(3) with time zone,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "GroupAccount_account_check" CHECK (((account)::text ~~ '!%'::text)),
    CONSTRAINT "GroupAccount_defaultProfileRev_check" CHECK (("defaultProfileRev" >= 0))
);


--
-- Name: GroupAccount_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."GroupAccount_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: GroupAccount_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."GroupAccount_id_seq" OWNED BY public."GroupAccount".id;


--
-- Name: GroupMeta; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."GroupMeta" (
    "metaEndId" integer DEFAULT 0 NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "threadId" integer NOT NULL,
    "applicationEndId" integer DEFAULT 0 NOT NULL,
    "invitationEndId" integer DEFAULT 0 NOT NULL,
    "profileRev" integer DEFAULT 0 NOT NULL,
    "metaTargetId" integer DEFAULT 0 NOT NULL,
    "metaProcessedThroughId" integer DEFAULT 0 NOT NULL,
    "metaRecoveryThroughId" integer,
    "announcementFeedId" integer,
    "announcementText" text,
    CONSTRAINT "GroupMeta_announcementFeedId_check" CHECK ((("announcementFeedId" IS NULL) OR ("announcementFeedId" > 0))),
    CONSTRAINT "GroupMeta_announcementText_check" CHECK ((("announcementText" IS NULL) OR (("announcementFeedId" IS NOT NULL) AND (char_length("announcementText") >= 1) AND (char_length("announcementText") <= 4096)))),
    CONSTRAINT "GroupMeta_applicationEndId_check" CHECK (("applicationEndId" >= 0)),
    CONSTRAINT "GroupMeta_invitationEndId_check" CHECK (("invitationEndId" >= 0)),
    CONSTRAINT "GroupMeta_metaEndId_check" CHECK (("metaEndId" >= 0)),
    CONSTRAINT "GroupMeta_metaProcessedThroughId_check" CHECK ((("metaProcessedThroughId" >= 0) AND ("metaProcessedThroughId" <= "metaTargetId"))),
    CONSTRAINT "GroupMeta_metaRecovery_check" CHECK ((("metaRecoveryThroughId" IS NULL) OR (("metaProcessedThroughId" < "metaRecoveryThroughId") AND ("metaRecoveryThroughId" <= "metaTargetId")))),
    CONSTRAINT "GroupMeta_metaTargetId_check" CHECK (("metaTargetId" >= 0)),
    CONSTRAINT "GroupMeta_profileRev_check" CHECK (("profileRev" >= 0))
);


--
-- Name: GroupMetaMemberFeed; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."GroupMetaMemberFeed" (
    "feedId" integer NOT NULL,
    operation public."GroupMetaMemberOperation" NOT NULL,
    body jsonb NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "threadId" integer NOT NULL,
    "memberAccount" character varying(31) NOT NULL,
    "memberDomain" character varying(63) NOT NULL,
    CONSTRAINT "GroupMetaMemberFeed_body_check" CHECK (((jsonb_typeof(body) = 'object'::text) AND (((operation = 'MEMBER_UPSERT'::public."GroupMetaMemberOperation") AND (body <> '{}'::jsonb)) OR ((operation = 'MEMBER_DEPART'::public."GroupMetaMemberOperation") AND (body = '{}'::jsonb)) OR ((operation = 'GROUP_PROFILE'::public."GroupMetaMemberOperation") AND (body <> '{}'::jsonb))))),
    CONSTRAINT "GroupMetaMemberFeed_feedId_check" CHECK (("feedId" > 0))
);


--
-- Name: GroupRequestProjection; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."GroupRequestProjection" (
    "threadId" integer NOT NULL,
    "memberAccount" character varying(31) NOT NULL,
    "memberDomain" character varying(63) NOT NULL,
    "memberNamespaceId" integer NOT NULL,
    "memberProfileRev" integer NOT NULL,
    direction character varying(15) NOT NULL,
    "feedId" integer NOT NULL,
    status public."RequestProjectionStatus" NOT NULL,
    note character varying(255) DEFAULT ''::character varying NOT NULL,
    "requestedAt" timestamp(3) with time zone NOT NULL,
    "expiresAt" timestamp(3) with time zone NOT NULL,
    CONSTRAINT "GroupRequestProjection_direction_check" CHECK (((direction)::text = ANY (ARRAY[('APPLICATION'::character varying)::text, ('INVITATION'::character varying)::text]))),
    CONSTRAINT "GroupRequestProjection_feedId_check" CHECK (("feedId" > 0)),
    CONSTRAINT "GroupRequestProjection_retention_check" CHECK ((("expiresAt" > "requestedAt") AND ("expiresAt" <= ("requestedAt" + '7 days'::interval))))
);


--
-- Name: IdentityNamespace; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."IdentityNamespace" (
    id integer NOT NULL,
    domain character varying(63) NOT NULL,
    "rootKeyFingerprint" character varying(80),
    "rootPublicKey" character varying(44),
    "identityPinnedAt" timestamp(3) with time zone,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "retiredAt" timestamp(3) with time zone,
    "stateFeedEndId" bigint DEFAULT 0 NOT NULL,
    "dailyMsgLimit" integer,
    "dailyRequestLimit" integer,
    "dailyFileLimit" integer,
    "dailyFileBytesLimit" bigint,
    CONSTRAINT "IdentityNamespace_retiredAt_check" CHECK ((("retiredAt" IS NULL) OR ("retiredAt" >= "createdAt"))),
    CONSTRAINT "IdentityNamespace_shape_check" CHECK ((((id = 0) AND ((domain)::text = 'local'::text) AND ("rootKeyFingerprint" IS NULL) AND ("rootPublicKey" IS NULL) AND ("identityPinnedAt" IS NULL) AND ("retiredAt" IS NULL)) OR ((id > 0) AND ((domain)::text <> 'local'::text) AND ("rootKeyFingerprint" IS NOT NULL) AND ("rootPublicKey" IS NOT NULL) AND ("identityPinnedAt" IS NOT NULL)))),
    CONSTRAINT "IdentityNamespace_stateFeedEndId_check" CHECK ((("stateFeedEndId" >= 0) AND ((id <> 0) OR ("stateFeedEndId" = 0))))
);


--
-- Name: IdentityNamespace_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."IdentityNamespace_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: IdentityNamespace_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."IdentityNamespace_id_seq" OWNED BY public."IdentityNamespace".id;


--
-- Name: LocalFederationIdentity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."LocalFederationIdentity" (
    domain character varying(63) NOT NULL,
    "rootKeyFingerprint" character varying(80) NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: LoginCode; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."LoginCode" (
    id integer NOT NULL,
    "userId" integer NOT NULL,
    "codeHash" character varying(127) NOT NULL,
    "issuedBy" integer NOT NULL,
    "issuedAt" timestamp(3) with time zone NOT NULL,
    "expiresAt" timestamp(3) with time zone NOT NULL,
    "consumedAt" timestamp(3) with time zone,
    "consumedIp" character varying(64),
    "consumedDevice" character varying(127),
    "producedSessionId" integer,
    "revokedAt" timestamp(3) with time zone
);


--
-- Name: LoginCode_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."LoginCode_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: LoginCode_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."LoginCode_id_seq" OWNED BY public."LoginCode".id;


--
-- Name: MediaAsset; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."MediaAsset" (
    digest character varying(64) NOT NULL,
    bytes bigint NOT NULL,
    "isDeleted" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: MessageAsset; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."MessageAsset" (
    "messageId" bigint NOT NULL,
    "threadId" integer NOT NULL,
    digest character varying(64) NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: MessageReport; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."MessageReport" (
    "threadId" integer NOT NULL,
    seq integer NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "isDeleted" boolean DEFAULT false NOT NULL
);


--
-- Name: MessageThread; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."MessageThread" (
    id integer NOT NULL,
    type public."MessageThreadType" NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone NOT NULL,
    "curSeq" integer DEFAULT 0 NOT NULL,
    "tombstoneEndSeq" integer DEFAULT 0 NOT NULL,
    "pullUntil" integer DEFAULT 0 NOT NULL,
    "authorityNamespaceId" integer DEFAULT 0 NOT NULL,
    "federationVersion" integer DEFAULT 0 NOT NULL,
    "authorizationEpoch" integer DEFAULT 0 NOT NULL,
    "clearedSeq" integer,
    "groupAccount" character varying(31),
    "groupDomain" character varying(63),
    "groupAccountId" integer,
    "groupDissolvedAt" timestamp(3) with time zone,
    "federationRoundsEnabled" boolean DEFAULT false NOT NULL,
    CONSTRAINT "MessageThread_authorizationEpoch_check" CHECK (("authorizationEpoch" >= 0)),
    CONSTRAINT "MessageThread_clearedSeq_check" CHECK ((("clearedSeq" IS NULL) OR (("clearedSeq" >= 0) AND ("clearedSeq" <= "curSeq")))),
    CONSTRAINT "MessageThread_federationVersion_check" CHECK (("federationVersion" >= 0)),
    CONSTRAINT "MessageThread_group_identity_check" CHECK (((type <> 'GROUP'::public."MessageThreadType") OR (((("groupDomain")::text = 'local'::text) = ("authorityNamespaceId" = 0)) AND ((("groupDomain")::text = 'local'::text) = ("groupAccountId" IS NOT NULL)) AND (("groupAccount")::text ~~ '!%'::text)))),
    CONSTRAINT "MessageThread_group_type_check" CHECK ((((type = 'GROUP'::public."MessageThreadType") AND ("groupAccount" IS NOT NULL) AND ("groupDomain" IS NOT NULL)) OR ((type = 'P2P'::public."MessageThreadType") AND ("groupAccount" IS NULL) AND ("groupDomain" IS NULL) AND ("groupAccountId" IS NULL) AND ("groupDissolvedAt" IS NULL)))),
    CONSTRAINT "MessageThread_tombstoneEndSeq_check" CHECK (("tombstoneEndSeq" >= 0))
);


--
-- Name: MessageThread_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."MessageThread_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: MessageThread_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."MessageThread_id_seq" OWNED BY public."MessageThread".id;


--
-- Name: Message_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."Message_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: Message_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."Message_id_seq" OWNED BY public."Message".id;


--
-- Name: PeerStateFeed; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."PeerStateFeed" (
    "peerDomain" character varying(63) NOT NULL,
    "namespaceId" integer NOT NULL,
    account character varying(31) NOT NULL,
    domain character varying(63) NOT NULL,
    "eventType" public."PeerStateEventType" NOT NULL,
    "subjectAccount" character varying(31) DEFAULT ''::character varying NOT NULL,
    "subjectDomain" character varying(63) DEFAULT 'local'::character varying NOT NULL,
    "feedId" bigint NOT NULL,
    body jsonb NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "PeerStateFeed_feedId_check" CHECK (("feedId" > 0)),
    CONSTRAINT "PeerStateFeed_subject_check" CHECK (((("eventType" = 'RELATIONSHIP_INTENT'::public."PeerStateEventType") AND (("subjectAccount")::text <> ''::text) AND (("subjectDomain")::text <> ''::text)) OR (("eventType" = 'THREAD_CONTENT_HEAD'::public."PeerStateEventType") AND ((((account)::text ~~ '!%'::text) AND (("subjectAccount")::text = ''::text) AND (("subjectDomain")::text = 'local'::text)) OR (((account)::text !~~ '!%'::text) AND (("subjectAccount")::text <> ''::text) AND (("subjectDomain")::text = ("peerDomain")::text))))))
);


--
-- Name: PeerStateFeedPullCursor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."PeerStateFeedPullCursor" (
    "peerDomain" character varying(63) NOT NULL,
    "namespaceId" integer NOT NULL,
    initialized boolean DEFAULT false NOT NULL,
    "committedThrough" bigint DEFAULT 0 NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "PeerStateFeedPullCursor_committedThrough_check" CHECK (("committedThrough" >= 0))
);


--
-- Name: PendingMedia; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."PendingMedia" (
    id bigint NOT NULL,
    "messageId" bigint,
    "threadId" integer,
    "creatorAccount" character varying(31),
    "creatorDomain" character varying(63),
    "contentType" public."ContentType",
    content text,
    digest character varying(64),
    "clientMessageId" character varying(36),
    status character varying(12) DEFAULT 'pending'::character varying NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone NOT NULL,
    "failReason" character varying(255),
    direction public."FileSyncDirection" DEFAULT 'OUTBOUND'::public."FileSyncDirection" NOT NULL,
    "batchId" uuid DEFAULT gen_random_uuid() NOT NULL,
    "fileCnt" integer DEFAULT 1 NOT NULL,
    "anyFailed" boolean DEFAULT false NOT NULL,
    "originDomain" character varying(63),
    "namespaceId" integer DEFAULT 0 NOT NULL,
    "expectedAuthorizationEpoch" integer,
    "dependsOnOriginSeq" integer,
    CONSTRAINT "PendingMedia_depends_on_origin_seq_check" CHECK ((("dependsOnOriginSeq" IS NULL) OR ("dependsOnOriginSeq" > 0))),
    CONSTRAINT "PendingMedia_direction_shape_check" CHECK ((((direction = 'OUTBOUND'::public."FileSyncDirection") AND ("messageId" IS NULL) AND ("threadId" IS NOT NULL) AND ("creatorAccount" IS NOT NULL) AND ("creatorDomain" IS NOT NULL) AND ("contentType" IS NOT NULL) AND (content IS NOT NULL) AND ("originDomain" IS NULL) AND ("expectedAuthorizationEpoch" IS NULL) AND ("dependsOnOriginSeq" IS NULL)) OR ((direction = 'INBOUND'::public."FileSyncDirection") AND ("messageId" IS NOT NULL) AND ("threadId" IS NULL) AND ("creatorAccount" IS NULL) AND ("creatorDomain" IS NULL) AND ("contentType" IS NULL) AND (content IS NULL) AND ("clientMessageId" IS NULL) AND ("originDomain" IS NOT NULL) AND ("expectedAuthorizationEpoch" IS NOT NULL)))),
    CONSTRAINT "PendingMedia_expectedAuthorizationEpoch_check" CHECK ((("expectedAuthorizationEpoch" IS NULL) OR ("expectedAuthorizationEpoch" >= 0)))
);


--
-- Name: PendingMedia_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."PendingMedia_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: PendingMedia_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."PendingMedia_id_seq" OWNED BY public."PendingMedia".id;


--
-- Name: Profile; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Profile" (
    account character varying(31) NOT NULL,
    domain character varying(63) NOT NULL,
    "namespaceId" integer NOT NULL,
    "profileRev" integer NOT NULL,
    "displayName" character varying(31) NOT NULL,
    avatar text DEFAULT ''::text NOT NULL,
    bio character varying(255) DEFAULT ''::character varying NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "Profile_profileRev_check" CHECK (("profileRev" > 0))
);


--
-- Name: QuotaDailyAllowance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."QuotaDailyAllowance" (
    "namespaceId" integer NOT NULL,
    date date NOT NULL,
    "extraMsg" integer DEFAULT 0 NOT NULL,
    "extraFile" integer DEFAULT 0 NOT NULL,
    "extraFileBytes" bigint DEFAULT 0 NOT NULL
);


--
-- Name: QuotaDailyUsage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."QuotaDailyUsage" (
    "namespaceId" integer NOT NULL,
    date date NOT NULL,
    category character varying(15) NOT NULL,
    count integer DEFAULT 0 NOT NULL
);


--
-- Name: QuotaFileByteUsage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."QuotaFileByteUsage" (
    "namespaceId" integer NOT NULL,
    date date NOT NULL,
    bytes bigint DEFAULT 0 NOT NULL
);


--
-- Name: RelationshipIntent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."RelationshipIntent" (
    id bigint NOT NULL,
    "pairId" bigint NOT NULL,
    "authorSide" character varying(1) NOT NULL,
    status public."RelationshipIntentStatus" NOT NULL,
    note character varying(255) DEFAULT ''::character varying NOT NULL,
    "requestedAt" timestamp(3) with time zone,
    "expiresAt" timestamp(3) with time zone,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "profileRev" integer DEFAULT 0 NOT NULL,
    "messageEndSeq" integer NOT NULL,
    "tombstoneEndSeq" integer NOT NULL,
    CONSTRAINT "RelationshipIntent_authorSide_check" CHECK ((("authorSide")::text = ANY (ARRAY[('A'::character varying)::text, ('B'::character varying)::text]))),
    CONSTRAINT "RelationshipIntent_expiry_check" CHECK ((((status = 'REQUESTED'::public."RelationshipIntentStatus") AND ("requestedAt" IS NOT NULL) AND ("expiresAt" IS NOT NULL) AND ("expiresAt" > "requestedAt") AND ("expiresAt" <= ("requestedAt" + '7 days'::interval))) OR ((status = 'ACCEPTED'::public."RelationshipIntentStatus") AND ("requestedAt" IS NOT NULL) AND ("expiresAt" IS NULL)) OR ((status = 'REVOKED'::public."RelationshipIntentStatus") AND ("expiresAt" IS NULL)))),
    CONSTRAINT "RelationshipIntent_head_check" CHECK ((("messageEndSeq" >= 0) AND ("tombstoneEndSeq" >= 0))),
    CONSTRAINT "RelationshipIntent_profileRev_check" CHECK (("profileRev" >= 0))
);


--
-- Name: RelationshipIntent_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."RelationshipIntent_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: RelationshipIntent_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."RelationshipIntent_id_seq" OWNED BY public."RelationshipIntent".id;


--
-- Name: RelationshipPair; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."RelationshipPair" (
    id bigint NOT NULL,
    kind character varying(16) NOT NULL,
    "endpointAType" character varying(8) NOT NULL,
    "endpointAAccount" character varying(31) NOT NULL,
    "endpointADomain" character varying(63) NOT NULL,
    "endpointANamespaceId" integer DEFAULT 0 NOT NULL,
    "endpointBType" character varying(8) NOT NULL,
    "endpointBAccount" character varying(31) NOT NULL,
    "endpointBDomain" character varying(63) NOT NULL,
    "endpointBNamespaceId" integer DEFAULT 0 NOT NULL,
    "threadId" integer,
    active boolean DEFAULT false NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    established boolean DEFAULT false NOT NULL,
    CONSTRAINT "RelationshipPair_distinct_endpoints_check" CHECK (((("endpointAType")::text <> ("endpointBType")::text) OR (("endpointAAccount")::text <> ("endpointBAccount")::text) OR (("endpointADomain")::text <> ("endpointBDomain")::text))),
    CONSTRAINT "RelationshipPair_endpoint_type_check" CHECK (((("endpointAType")::text = ANY (ARRAY[('USER'::character varying)::text, ('GROUP'::character varying)::text])) AND (("endpointBType")::text = ANY (ARRAY[('USER'::character varying)::text, ('GROUP'::character varying)::text])) AND ((((kind)::text = 'P2P'::text) AND (("endpointAType")::text = 'USER'::text) AND (("endpointBType")::text = 'USER'::text)) OR (((kind)::text = 'GROUP_MEMBER'::text) AND (("endpointAType")::text <> ("endpointBType")::text))))),
    CONSTRAINT "RelationshipPair_kind_check" CHECK (((kind)::text = ANY (ARRAY[('P2P'::character varying)::text, ('GROUP_MEMBER'::character varying)::text])))
);


--
-- Name: RelationshipPair_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."RelationshipPair_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: RelationshipPair_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."RelationshipPair_id_seq" OWNED BY public."RelationshipPair".id;


--
-- Name: S2SKeyCache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."S2SKeyCache" (
    domain character varying(63) NOT NULL,
    "namespaceId" integer NOT NULL,
    "keyId" character varying(127) NOT NULL,
    "publicKey" character varying(127) NOT NULL,
    "notBefore" timestamp(3) with time zone NOT NULL,
    "notAfter" timestamp(3) with time zone NOT NULL,
    "authorizationSignature" character varying(127) NOT NULL,
    "fetchedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: SessionToken; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."SessionToken" (
    id integer NOT NULL,
    "userId" integer NOT NULL,
    "tokenHash" character varying(127) NOT NULL,
    device character varying(127),
    "userAgent" character varying(255),
    ip character varying(64),
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "expiresAt" timestamp(3) with time zone NOT NULL,
    "lastSeenAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "revokedAt" timestamp(3) with time zone,
    "revokeReason" character varying(32),
    client character varying(16) NOT NULL,
    "lastSeenIp" character varying(64),
    "autoTerminateDays" integer DEFAULT 30 NOT NULL,
    "pushSubscriptionRev" integer DEFAULT 1 NOT NULL,
    "pushToken" character varying(512),
    "pushPlatform" public."PushPlatform",
    "pushDeviceId" character varying(127),
    "pushP256dh" character varying(255),
    "pushAuth" character varying(255),
    "pushRegisteredAt" timestamp(3) with time zone,
    CONSTRAINT "SessionToken_auto_terminate_days_check" CHECK (("autoTerminateDays" = ANY (ARRAY[7, 30, 90, 180, 365]))),
    CONSTRAINT "SessionToken_pushSubscriptionRev_check" CHECK (("pushSubscriptionRev" > 0)),
    CONSTRAINT "SessionToken_push_shape_check" CHECK (((("pushToken" IS NULL) AND ("pushPlatform" IS NULL) AND ("pushP256dh" IS NULL) AND ("pushAuth" IS NULL) AND ("pushRegisteredAt" IS NULL)) OR (("pushToken" IS NOT NULL) AND ("pushPlatform" IS NOT NULL) AND ("pushRegisteredAt" IS NOT NULL) AND ((("pushPlatform" = 'WEB'::public."PushPlatform") AND ("pushP256dh" IS NOT NULL) AND ("pushAuth" IS NOT NULL)) OR (("pushPlatform" <> 'WEB'::public."PushPlatform") AND ("pushP256dh" IS NULL) AND ("pushAuth" IS NULL))))))
);


--
-- Name: SessionToken_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."SessionToken_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: SessionToken_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."SessionToken_id_seq" OWNED BY public."SessionToken".id;


--
-- Name: SystemSetting; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."SystemSetting" (
    key character varying(63) NOT NULL,
    value text NOT NULL,
    "updatedAt" timestamp(3) with time zone NOT NULL
);


--
-- Name: ThreadAudience; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ThreadAudience" (
    id bigint NOT NULL,
    "targetDomain" character varying(63) NOT NULL,
    "targetNamespaceId" integer DEFAULT 0 NOT NULL,
    "localUserId" integer,
    "threadId" integer NOT NULL,
    "messageAccessAfterSeq" integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "groupMetaVisibleAfter" bigint DEFAULT 0 NOT NULL,
    CONSTRAINT "ThreadAudience_groupMetaVisibleAfter_check" CHECK (("groupMetaVisibleAfter" >= 0)),
    CONSTRAINT "ThreadAudience_messageAccessAfterSeq_check" CHECK (("messageAccessAfterSeq" >= 0)),
    CONSTRAINT "ThreadAudience_target_check" CHECK ((((("targetDomain")::text = 'local'::text) AND ("localUserId" IS NOT NULL) AND ("targetNamespaceId" = 0)) OR ((("targetDomain")::text <> 'local'::text) AND ("localUserId" IS NULL) AND ("targetNamespaceId" > 0))))
);


--
-- Name: ThreadAudience_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."ThreadAudience_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ThreadAudience_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."ThreadAudience_id_seq" OWNED BY public."ThreadAudience".id;


--
-- Name: AccountThreadState_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."AccountThreadState_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: AccountThreadState_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."AccountThreadState_id_seq" OWNED BY public."AccountThreadState".id;


--
-- Name: TwoFactorBackupCode; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."TwoFactorBackupCode" (
    id integer NOT NULL,
    "adminId" integer NOT NULL,
    "codeHash" character varying(64) NOT NULL,
    "consumedAt" timestamp(3) with time zone,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: TwoFactorBackupCode_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."TwoFactorBackupCode_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: TwoFactorBackupCode_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."TwoFactorBackupCode_id_seq" OWNED BY public."TwoFactorBackupCode".id;


--
-- Name: UploadSession; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."UploadSession" (
    id bigint NOT NULL,
    "uploadId" uuid DEFAULT gen_random_uuid() NOT NULL,
    "clientMessageId" character varying(36) NOT NULL,
    "partId" uuid NOT NULL,
    "position" integer NOT NULL,
    "partIntent" public."ContentType" NOT NULL,
    "creatorId" integer NOT NULL,
    "contentType" public."ContentType" NOT NULL,
    "originalName" character varying(100) NOT NULL,
    "mimeType" character varying(255) NOT NULL,
    "totalBytes" bigint NOT NULL,
    "receivedBytes" bigint DEFAULT 0 NOT NULL,
    status public."UploadSessionStatus" DEFAULT 'UPLOADING'::public."UploadSessionStatus" NOT NULL,
    "tmpKey" uuid DEFAULT gen_random_uuid() NOT NULL,
    digest character varying(64),
    result jsonb,
    "errorReason" character varying(255),
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "completedAt" timestamp(3) with time zone,
    "abortedAt" timestamp(3) with time zone,
    CONSTRAINT "UploadSession_partIntent_check" CHECK (("partIntent" <> 'GALLERY'::public."ContentType")),
    CONSTRAINT "UploadSession_position_check" CHECK ((("position" >= 0) AND ("position" <= 9)))
);


--
-- Name: UploadSession_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."UploadSession_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: UploadSession_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."UploadSession_id_seq" OWNED BY public."UploadSession".id;


--
-- Name: UserPreference; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."UserPreference" (
    "userId" integer NOT NULL,
    key character varying(100) NOT NULL,
    value jsonb NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "UserPreference_revision_check" CHECK ((revision >= 0)),
    CONSTRAINT "UserPreference_value_not_json_null_check" CHECK ((value <> 'null'::jsonb))
);


--
-- Name: UserQuotaDailyAllowance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."UserQuotaDailyAllowance" (
    "userId" integer NOT NULL,
    date date NOT NULL,
    "extraMsg" integer DEFAULT 0 NOT NULL,
    "extraFile" integer DEFAULT 0 NOT NULL,
    "extraFileBytes" bigint DEFAULT 0 NOT NULL
);


--
-- Name: UserQuotaDailyUsage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."UserQuotaDailyUsage" (
    "userId" integer NOT NULL,
    date date NOT NULL,
    category character varying(15) NOT NULL,
    count integer DEFAULT 0 NOT NULL
);


--
-- Name: UserQuotaFileByteUsage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."UserQuotaFileByteUsage" (
    "userId" integer NOT NULL,
    date date NOT NULL,
    bytes bigint DEFAULT 0 NOT NULL
);


--
-- Name: UserQuotaPolicy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."UserQuotaPolicy" (
    "userId" integer NOT NULL,
    "dailyMsgLimit" integer,
    "dailyRequestLimit" integer,
    "dailyFileLimit" integer,
    "dailyFileBytesLimit" bigint,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: WebAuthnCredential; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."WebAuthnCredential" (
    id integer NOT NULL,
    "adminId" integer NOT NULL,
    "credentialId" character varying(510) NOT NULL,
    "publicKey" bytea NOT NULL,
    counter integer DEFAULT 0 NOT NULL,
    transports text,
    "deviceType" character varying(32),
    backed boolean DEFAULT false NOT NULL,
    nickname character varying(64),
    "lastUsedAt" timestamp(3) with time zone,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: WebAuthnCredential_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."WebAuthnCredential_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: WebAuthnCredential_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."WebAuthnCredential_id_seq" OWNED BY public."WebAuthnCredential".id;


--
-- Name: Account id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Account" ALTER COLUMN id SET DEFAULT nextval('public."Account_id_seq"'::regclass);


--
-- Name: AccountThreadState id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AccountThreadState" ALTER COLUMN id SET DEFAULT nextval('public."AccountThreadState_id_seq"'::regclass);


--
-- Name: Admin id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Admin" ALTER COLUMN id SET DEFAULT nextval('public."Admin_id_seq"'::regclass);


--
-- Name: AdminActionLog id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AdminActionLog" ALTER COLUMN id SET DEFAULT nextval('public."AdminActionLog_id_seq"'::regclass);


--
-- Name: AdminSession id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AdminSession" ALTER COLUMN id SET DEFAULT nextval('public."AdminSession_id_seq"'::regclass);


--
-- Name: ClientStateFeed id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientStateFeed" ALTER COLUMN id SET DEFAULT nextval('public."ClientStateFeed_id_seq"'::regclass);


--
-- Name: DiagnosticsReport id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DiagnosticsReport" ALTER COLUMN id SET DEFAULT nextval('public."DiagnosticsReport_id_seq"'::regclass);


--
-- Name: DurableTask id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DurableTask" ALTER COLUMN id SET DEFAULT nextval('public."DurableTask_id_seq"'::regclass);


--
-- Name: FederatedMessageTombstone id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederatedMessageTombstone" ALTER COLUMN id SET DEFAULT nextval('public."FederatedMessageTombstone_id_seq"'::regclass);


--
-- Name: FederatedPeerEvent id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederatedPeerEvent" ALTER COLUMN id SET DEFAULT nextval('public."FederatedPeerEvent_id_seq"'::regclass);


--
-- Name: FederationThreadHistoryGap id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationThreadHistoryGap" ALTER COLUMN id SET DEFAULT nextval('public."FederationThreadHistoryGap_id_seq"'::regclass);


--
-- Name: FileSyncProgress id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FileSyncProgress" ALTER COLUMN id SET DEFAULT nextval('public."FileSyncProgress_id_seq"'::regclass);


--
-- Name: GroupAccount id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GroupAccount" ALTER COLUMN id SET DEFAULT nextval('public."GroupAccount_id_seq"'::regclass);


--
-- Name: IdentityNamespace id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."IdentityNamespace" ALTER COLUMN id SET DEFAULT nextval('public."IdentityNamespace_id_seq"'::regclass);


--
-- Name: LoginCode id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."LoginCode" ALTER COLUMN id SET DEFAULT nextval('public."LoginCode_id_seq"'::regclass);


--
-- Name: Message id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Message" ALTER COLUMN id SET DEFAULT nextval('public."Message_id_seq"'::regclass);


--
-- Name: MessageThread id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MessageThread" ALTER COLUMN id SET DEFAULT nextval('public."MessageThread_id_seq"'::regclass);


--
-- Name: PendingMedia id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PendingMedia" ALTER COLUMN id SET DEFAULT nextval('public."PendingMedia_id_seq"'::regclass);


--
-- Name: RelationshipIntent id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."RelationshipIntent" ALTER COLUMN id SET DEFAULT nextval('public."RelationshipIntent_id_seq"'::regclass);


--
-- Name: RelationshipPair id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."RelationshipPair" ALTER COLUMN id SET DEFAULT nextval('public."RelationshipPair_id_seq"'::regclass);


--
-- Name: SessionToken id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SessionToken" ALTER COLUMN id SET DEFAULT nextval('public."SessionToken_id_seq"'::regclass);


--
-- Name: ThreadAudience id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ThreadAudience" ALTER COLUMN id SET DEFAULT nextval('public."ThreadAudience_id_seq"'::regclass);


--
-- Name: TwoFactorBackupCode id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."TwoFactorBackupCode" ALTER COLUMN id SET DEFAULT nextval('public."TwoFactorBackupCode_id_seq"'::regclass);


--
-- Name: UploadSession id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UploadSession" ALTER COLUMN id SET DEFAULT nextval('public."UploadSession_id_seq"'::regclass);


--
-- Name: WebAuthnCredential id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."WebAuthnCredential" ALTER COLUMN id SET DEFAULT nextval('public."WebAuthnCredential_id_seq"'::regclass);


--
-- Name: AccountThreadState AccountThreadState_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AccountThreadState"
    ADD CONSTRAINT "AccountThreadState_pkey" PRIMARY KEY (id);


--
-- Name: Account Account_account_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Account"
    ADD CONSTRAINT "Account_account_key" UNIQUE (account);


--
-- Name: Account Account_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Account"
    ADD CONSTRAINT "Account_pkey" PRIMARY KEY (id);


--
-- Name: AdminActionLog AdminActionLog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AdminActionLog"
    ADD CONSTRAINT "AdminActionLog_pkey" PRIMARY KEY (id);


--
-- Name: AdminLoginChallenge AdminLoginChallenge_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AdminLoginChallenge"
    ADD CONSTRAINT "AdminLoginChallenge_pkey" PRIMARY KEY (jti);


--
-- Name: AdminSession AdminSession_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AdminSession"
    ADD CONSTRAINT "AdminSession_pkey" PRIMARY KEY (id);


--
-- Name: Admin Admin_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Admin"
    ADD CONSTRAINT "Admin_pkey" PRIMARY KEY (id);


--
-- Name: CallHistory CallHistory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CallHistory"
    ADD CONSTRAINT "CallHistory_pkey" PRIMARY KEY (key);


--
-- Name: CallTombstone CallTombstone_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CallTombstone"
    ADD CONSTRAINT "CallTombstone_pkey" PRIMARY KEY ("namespaceId", "callSid");


--
-- Name: ClientStateFeed ClientStateFeed_compaction_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientStateFeed"
    ADD CONSTRAINT "ClientStateFeed_compaction_key" UNIQUE ("userId", "compactionKey");


--
-- Name: ClientStateFeed ClientStateFeed_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientStateFeed"
    ADD CONSTRAINT "ClientStateFeed_pkey" PRIMARY KEY (id);


--
-- Name: DeletedMessage DeletedMessage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DeletedMessage"
    ADD CONSTRAINT "DeletedMessage_pkey" PRIMARY KEY ("threadId", "deletionSeq");


--
-- Name: DiagnosticsReport DiagnosticsReport_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DiagnosticsReport"
    ADD CONSTRAINT "DiagnosticsReport_pkey" PRIMARY KEY (id);


--
-- Name: DurableTask DurableTask_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DurableTask"
    ADD CONSTRAINT "DurableTask_pkey" PRIMARY KEY (id);


--
-- Name: FederatedMessageTombstone FederatedMessageTombstone_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederatedMessageTombstone"
    ADD CONSTRAINT "FederatedMessageTombstone_pkey" PRIMARY KEY (id);


--
-- Name: FederatedPeerEvent FederatedPeerEvent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederatedPeerEvent"
    ADD CONSTRAINT "FederatedPeerEvent_pkey" PRIMARY KEY (id);


--
-- Name: FederatedPeer FederatedPeer_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederatedPeer"
    ADD CONSTRAINT "FederatedPeer_pkey" PRIMARY KEY (domain);


--
-- Name: FederationMessageReceipt FederationMessageReceipt_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationMessageReceipt"
    ADD CONSTRAINT "FederationMessageReceipt_pkey" PRIMARY KEY ("namespaceId", "threadId", "peerSeq");


--
-- Name: FederationThreadHistoryGap FederationThreadHistoryGap_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationThreadHistoryGap"
    ADD CONSTRAINT "FederationThreadHistoryGap_pkey" PRIMARY KEY (id);


--
-- Name: FederationThreadHistoryGap FederationThreadHistoryGap_threadId_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationThreadHistoryGap"
    ADD CONSTRAINT "FederationThreadHistoryGap_threadId_id_key" UNIQUE ("threadId", "namespaceId", id);


--
-- Name: FederationThreadSyncState FederationThreadSyncState_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationThreadSyncState"
    ADD CONSTRAINT "FederationThreadSyncState_pkey" PRIMARY KEY ("threadId", "namespaceId");


--
-- Name: FileSyncProgress FileSyncProgress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FileSyncProgress"
    ADD CONSTRAINT "FileSyncProgress_pkey" PRIMARY KEY (id);


--
-- Name: ForwardBundleAsset ForwardBundleAsset_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ForwardBundleAsset"
    ADD CONSTRAINT "ForwardBundleAsset_pkey" PRIMARY KEY ("bundleId", ordinal);


--
-- Name: ForwardBundleDependency ForwardBundleDependency_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ForwardBundleDependency"
    ADD CONSTRAINT "ForwardBundleDependency_pkey" PRIMARY KEY ("parentBundleId", "childBundleId");


--
-- Name: ForwardBundle ForwardBundle_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ForwardBundle"
    ADD CONSTRAINT "ForwardBundle_pkey" PRIMARY KEY (id);


--
-- Name: ForwardMessage ForwardMessage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ForwardMessage"
    ADD CONSTRAINT "ForwardMessage_pkey" PRIMARY KEY ("messageId");


--
-- Name: GroupAccount GroupAccount_account_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GroupAccount"
    ADD CONSTRAINT "GroupAccount_account_key" UNIQUE (account);


--
-- Name: GroupAccount GroupAccount_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GroupAccount"
    ADD CONSTRAINT "GroupAccount_pkey" PRIMARY KEY (id);


--
-- Name: GroupMeta GroupMeta_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GroupMeta"
    ADD CONSTRAINT "GroupMeta_pkey" PRIMARY KEY ("threadId");


--
-- Name: GroupMetaMemberFeed GroupMetaMemberFeed_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GroupMetaMemberFeed"
    ADD CONSTRAINT "GroupMetaMemberFeed_pkey" PRIMARY KEY ("threadId", "feedId");


--
-- Name: GroupRequestProjection GroupRequestProjection_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GroupRequestProjection"
    ADD CONSTRAINT "GroupRequestProjection_pkey" PRIMARY KEY ("threadId", "memberAccount", "memberDomain", "memberNamespaceId", direction);


--
-- Name: IdentityNamespace IdentityNamespace_domain_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."IdentityNamespace"
    ADD CONSTRAINT "IdentityNamespace_domain_id_key" UNIQUE (domain, id);


--
-- Name: IdentityNamespace IdentityNamespace_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."IdentityNamespace"
    ADD CONSTRAINT "IdentityNamespace_pkey" PRIMARY KEY (id);


--
-- Name: LocalFederationIdentity LocalFederationIdentity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."LocalFederationIdentity"
    ADD CONSTRAINT "LocalFederationIdentity_pkey" PRIMARY KEY (domain);


--
-- Name: LoginCode LoginCode_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."LoginCode"
    ADD CONSTRAINT "LoginCode_pkey" PRIMARY KEY (id);


--
-- Name: MediaAsset MediaAsset_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MediaAsset"
    ADD CONSTRAINT "MediaAsset_pkey" PRIMARY KEY (digest);


--
-- Name: MessageAsset MessageAsset_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MessageAsset"
    ADD CONSTRAINT "MessageAsset_pkey" PRIMARY KEY ("messageId", digest);


--
-- Name: MessageReport MessageReport_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MessageReport"
    ADD CONSTRAINT "MessageReport_pkey" PRIMARY KEY ("threadId", seq);


--
-- Name: MessageThread MessageThread_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MessageThread"
    ADD CONSTRAINT "MessageThread_pkey" PRIMARY KEY (id);


--
-- Name: Message Message_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Message"
    ADD CONSTRAINT "Message_pkey" PRIMARY KEY (id);


--
-- Name: PeerStateFeedPullCursor PeerStateFeedPullCursor_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PeerStateFeedPullCursor"
    ADD CONSTRAINT "PeerStateFeedPullCursor_pkey" PRIMARY KEY ("namespaceId");


--
-- Name: PeerStateFeed PeerStateFeed_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PeerStateFeed"
    ADD CONSTRAINT "PeerStateFeed_pkey" PRIMARY KEY ("namespaceId", account, domain, "eventType", "subjectAccount", "subjectDomain");


--
-- Name: PendingMedia PendingMedia_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PendingMedia"
    ADD CONSTRAINT "PendingMedia_pkey" PRIMARY KEY (id);


--
-- Name: Profile Profile_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Profile"
    ADD CONSTRAINT "Profile_pkey" PRIMARY KEY (account, domain, "namespaceId", "profileRev");


--
-- Name: QuotaDailyAllowance QuotaDailyAllowance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."QuotaDailyAllowance"
    ADD CONSTRAINT "QuotaDailyAllowance_pkey" PRIMARY KEY ("namespaceId", date);


--
-- Name: QuotaDailyUsage QuotaDailyUsage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."QuotaDailyUsage"
    ADD CONSTRAINT "QuotaDailyUsage_pkey" PRIMARY KEY ("namespaceId", date, category);


--
-- Name: QuotaFileByteUsage QuotaFileByteUsage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."QuotaFileByteUsage"
    ADD CONSTRAINT "QuotaFileByteUsage_pkey" PRIMARY KEY ("namespaceId", date);


--
-- Name: RelationshipIntent RelationshipIntent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."RelationshipIntent"
    ADD CONSTRAINT "RelationshipIntent_pkey" PRIMARY KEY ("pairId", "authorSide");


--
-- Name: RelationshipPair RelationshipPair_endpoints_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."RelationshipPair"
    ADD CONSTRAINT "RelationshipPair_endpoints_key" UNIQUE ("endpointAType", "endpointAAccount", "endpointADomain", "endpointANamespaceId", "endpointBType", "endpointBAccount", "endpointBDomain", "endpointBNamespaceId");


--
-- Name: RelationshipPair RelationshipPair_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."RelationshipPair"
    ADD CONSTRAINT "RelationshipPair_pkey" PRIMARY KEY (id);


--
-- Name: S2SKeyCache S2SKeyCache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."S2SKeyCache"
    ADD CONSTRAINT "S2SKeyCache_pkey" PRIMARY KEY ("namespaceId", "keyId");


--
-- Name: SessionToken SessionToken_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SessionToken"
    ADD CONSTRAINT "SessionToken_pkey" PRIMARY KEY (id);


--
-- Name: SystemSetting SystemSetting_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SystemSetting"
    ADD CONSTRAINT "SystemSetting_pkey" PRIMARY KEY (key);


--
-- Name: ThreadAudience ThreadAudience_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ThreadAudience"
    ADD CONSTRAINT "ThreadAudience_pkey" PRIMARY KEY (id);


--
-- Name: TwoFactorBackupCode TwoFactorBackupCode_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."TwoFactorBackupCode"
    ADD CONSTRAINT "TwoFactorBackupCode_pkey" PRIMARY KEY (id);


--
-- Name: UploadSession UploadSession_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UploadSession"
    ADD CONSTRAINT "UploadSession_pkey" PRIMARY KEY (id);


--
-- Name: UserPreference UserPreference_userId_key_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserPreference"
    ADD CONSTRAINT "UserPreference_userId_key_pk" PRIMARY KEY ("userId", key);


--
-- Name: UserQuotaDailyAllowance UserQuotaDailyAllowance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserQuotaDailyAllowance"
    ADD CONSTRAINT "UserQuotaDailyAllowance_pkey" PRIMARY KEY ("userId", date);


--
-- Name: UserQuotaDailyUsage UserQuotaDailyUsage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserQuotaDailyUsage"
    ADD CONSTRAINT "UserQuotaDailyUsage_pkey" PRIMARY KEY ("userId", date, category);


--
-- Name: UserQuotaFileByteUsage UserQuotaFileByteUsage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserQuotaFileByteUsage"
    ADD CONSTRAINT "UserQuotaFileByteUsage_pkey" PRIMARY KEY ("userId", date);


--
-- Name: UserQuotaPolicy UserQuotaPolicy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserQuotaPolicy"
    ADD CONSTRAINT "UserQuotaPolicy_pkey" PRIMARY KEY ("userId");


--
-- Name: WebAuthnCredential WebAuthnCredential_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."WebAuthnCredential"
    ADD CONSTRAINT "WebAuthnCredential_pkey" PRIMARY KEY (id);


--
-- Name: AccountThreadState_accountId_pinned_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AccountThreadState_accountId_pinned_idx" ON public."AccountThreadState" USING btree ("accountId", pinned);


--
-- Name: AccountThreadState_accountId_threadFeedId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "AccountThreadState_accountId_threadFeedId_key" ON public."AccountThreadState" USING btree ("accountId", "threadFeedId");


--
-- Name: AccountThreadState_accountId_threadId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "AccountThreadState_accountId_threadId_key" ON public."AccountThreadState" USING btree ("accountId", "threadId");


--
-- Name: AccountThreadState_threadId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AccountThreadState_threadId_idx" ON public."AccountThreadState" USING btree ("threadId");


--
-- Name: AdminActionLog_action_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AdminActionLog_action_idx" ON public."AdminActionLog" USING btree (action);


--
-- Name: AdminActionLog_adminId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AdminActionLog_adminId_idx" ON public."AdminActionLog" USING btree ("adminId");


--
-- Name: AdminActionLog_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AdminActionLog_at_idx" ON public."AdminActionLog" USING btree (at);


--
-- Name: AdminLoginChallenge_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AdminLoginChallenge_createdAt_idx" ON public."AdminLoginChallenge" USING btree ("createdAt");


--
-- Name: AdminSession_adminId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AdminSession_adminId_idx" ON public."AdminSession" USING btree ("adminId");


--
-- Name: AdminSession_expiresAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AdminSession_expiresAt_idx" ON public."AdminSession" USING btree ("expiresAt");


--
-- Name: AdminSession_tokenHash_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "AdminSession_tokenHash_key" ON public."AdminSession" USING btree ("tokenHash");


--
-- Name: Admin_userId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Admin_userId_key" ON public."Admin" USING btree ("userId");


--
-- Name: CallHistory_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "CallHistory_pending_idx" ON public."CallHistory" USING btree (terminal) WHERE ("messageSeq" IS NULL);


--
-- Name: CallTombstone_expiresAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "CallTombstone_expiresAt_idx" ON public."CallTombstone" USING btree ("expiresAt");


--
-- Name: ClientStateFeed_user_feedId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ClientStateFeed_user_feedId_idx" ON public."ClientStateFeed" USING btree ("userId", "feedId");


--
-- Name: DeletedMessage_threadId_messageSeq_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "DeletedMessage_threadId_messageSeq_key" ON public."DeletedMessage" USING btree ("threadId", "messageSeq");


--
-- Name: DiagnosticsReport_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "DiagnosticsReport_createdAt_idx" ON public."DiagnosticsReport" USING btree ("createdAt");


--
-- Name: DiagnosticsReport_reporterUserId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "DiagnosticsReport_reporterUserId_idx" ON public."DiagnosticsReport" USING btree ("reporterUserId");


--
-- Name: DiagnosticsReport_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "DiagnosticsReport_status_idx" ON public."DiagnosticsReport" USING btree (status);


--
-- Name: DurableTask_blocking_scope_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "DurableTask_blocking_scope_id_idx" ON public."DurableTask" USING btree (kind, "scopeKey", id) WHERE (status = ANY (ARRAY['PENDING'::public."DurableTaskStatus", 'PROCESSING'::public."DurableTaskStatus"]));


--
-- Name: DurableTask_one_processing_per_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "DurableTask_one_processing_per_scope" ON public."DurableTask" USING btree (kind, "scopeKey") WHERE (status = 'PROCESSING'::public."DurableTaskStatus");


--
-- Name: DurableTask_pending_coalescing_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "DurableTask_pending_coalescing_key_idx" ON public."DurableTask" USING btree ("coalescingKey", id) WHERE ((status = 'PENDING'::public."DurableTaskStatus") AND ("coalescingKey" IS NOT NULL));


--
-- Name: DurableTask_pending_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "DurableTask_pending_id_idx" ON public."DurableTask" USING btree (id) WHERE (status = 'PENDING'::public."DurableTaskStatus");


--
-- Name: FederatedMessageTombstone_source_event_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "FederatedMessageTombstone_source_event_key" ON public."FederatedMessageTombstone" USING btree ("sourceNamespaceId", "threadId", "remoteDeletionSeq");


--
-- Name: FederatedMessageTombstone_target_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "FederatedMessageTombstone_target_key" ON public."FederatedMessageTombstone" USING btree ("threadId", "sourceNamespaceId", "messageSeq");


--
-- Name: FederatedPeerEvent_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "FederatedPeerEvent_createdAt_idx" ON public."FederatedPeerEvent" USING btree ("createdAt");


--
-- Name: FederatedPeerEvent_domain_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "FederatedPeerEvent_domain_createdAt_idx" ON public."FederatedPeerEvent" USING btree (domain, "createdAt");


--
-- Name: FederatedPeer_lastSuccessAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "FederatedPeer_lastSuccessAt_idx" ON public."FederatedPeer" USING btree ("lastSuccessAt");


--
-- Name: FederatedPeer_trustLevel_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "FederatedPeer_trustLevel_idx" ON public."FederatedPeer" USING btree ("trustLevel");


--
-- Name: FederationMessageReceipt_messageId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "FederationMessageReceipt_messageId_idx" ON public."FederationMessageReceipt" USING btree ("messageId");


--
-- Name: FederationThreadHistoryGap_interval_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "FederationThreadHistoryGap_interval_key" ON public."FederationThreadHistoryGap" USING btree ("threadId", "namespaceId", "startSeq", "endSeq");


--
-- Name: FederationThreadHistoryGap_recoverable_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "FederationThreadHistoryGap_recoverable_idx" ON public."FederationThreadHistoryGap" USING btree ("threadId", "namespaceId", "endSeq") WHERE (recoverable = true);


--
-- Name: FileSyncProgress_batchId_digest_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "FileSyncProgress_batchId_digest_idx" ON public."FileSyncProgress" USING btree ("batchId", digest);


--
-- Name: FileSyncProgress_batchId_partId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "FileSyncProgress_batchId_partId_key" ON public."FileSyncProgress" USING btree ("batchId", "partId") WHERE ("partId" IS NOT NULL);


--
-- Name: FileSyncProgress_batchId_position_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "FileSyncProgress_batchId_position_key" ON public."FileSyncProgress" USING btree ("batchId", "position") WHERE ("position" IS NOT NULL);


--
-- Name: FileSyncProgress_digest_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "FileSyncProgress_digest_idx" ON public."FileSyncProgress" USING btree (digest);


--
-- Name: FileSyncProgress_status_updatedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "FileSyncProgress_status_updatedAt_idx" ON public."FileSyncProgress" USING btree (status, "updatedAt");


--
-- Name: ForwardBundleAsset_bundleId_digest_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ForwardBundleAsset_bundleId_digest_key" ON public."ForwardBundleAsset" USING btree ("bundleId", digest);


--
-- Name: ForwardBundleAsset_digest_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ForwardBundleAsset_digest_idx" ON public."ForwardBundleAsset" USING btree (digest);


--
-- Name: ForwardBundleDependency_childBundleId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ForwardBundleDependency_childBundleId_idx" ON public."ForwardBundleDependency" USING btree ("childBundleId");


--
-- Name: ForwardBundleDependency_parentBundleId_ordinal_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ForwardBundleDependency_parentBundleId_ordinal_key" ON public."ForwardBundleDependency" USING btree ("parentBundleId", ordinal);


--
-- Name: ForwardBundle_createdBy_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ForwardBundle_createdBy_idx" ON public."ForwardBundle" USING btree ("createdBy");


--
-- Name: ForwardBundle_sourceNamespace_sourceBundleId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ForwardBundle_sourceNamespace_sourceBundleId_key" ON public."ForwardBundle" USING btree ("sourceNamespaceId", "sourceBundleId");


--
-- Name: ForwardMessage_bundleId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ForwardMessage_bundleId_idx" ON public."ForwardMessage" USING btree ("bundleId");


--
-- Name: GroupMetaMemberFeed_member_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "GroupMetaMemberFeed_member_key" ON public."GroupMetaMemberFeed" USING btree ("threadId", "memberAccount", "memberDomain");


--
-- Name: GroupRequestProjection_direction_feed_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "GroupRequestProjection_direction_feed_key" ON public."GroupRequestProjection" USING btree ("threadId", direction, "feedId");


--
-- Name: GroupRequestProjection_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "GroupRequestProjection_expiry_idx" ON public."GroupRequestProjection" USING btree ("expiresAt");


--
-- Name: GroupRequestProjection_thread_feed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "GroupRequestProjection_thread_feed_idx" ON public."GroupRequestProjection" USING btree ("threadId", "feedId");


--
-- Name: IdentityNamespace_one_live_per_domain_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IdentityNamespace_one_live_per_domain_key" ON public."IdentityNamespace" USING btree (domain) WHERE ((id > 0) AND ("retiredAt" IS NULL));


--
-- Name: LoginCode_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "LoginCode_userId_idx" ON public."LoginCode" USING btree ("userId");


--
-- Name: MediaAsset_isDeleted_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "MediaAsset_isDeleted_idx" ON public."MediaAsset" USING btree ("isDeleted");


--
-- Name: MessageAsset_digest_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "MessageAsset_digest_idx" ON public."MessageAsset" USING btree (digest);


--
-- Name: MessageAsset_threadId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "MessageAsset_threadId_idx" ON public."MessageAsset" USING btree ("threadId");


--
-- Name: MessageReport_isDeleted_updatedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "MessageReport_isDeleted_updatedAt_idx" ON public."MessageReport" USING btree ("isDeleted", "updatedAt" DESC);


--
-- Name: MessageThread_groupAccountId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "MessageThread_groupAccountId_key" ON public."MessageThread" USING btree ("groupAccountId");


--
-- Name: MessageThread_group_address_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "MessageThread_group_address_key" ON public."MessageThread" USING btree ("groupAccount", "groupDomain", "authorityNamespaceId");


--
-- Name: Message_clientMessageId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Message_clientMessageId_key" ON public."Message" USING btree ("clientMessageId");


--
-- Name: Message_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Message_createdAt_idx" ON public."Message" USING btree ("createdAt");


--
-- Name: Message_creator_address_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Message_creator_address_idx" ON public."Message" USING btree ("creatorAccount", "creatorDomain", "sourceNamespaceId");


--
-- Name: Message_threadId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Message_threadId_createdAt_idx" ON public."Message" USING btree ("threadId", "createdAt");


--
-- Name: Message_threadId_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Message_threadId_id_idx" ON public."Message" USING btree ("threadId", id);


--
-- Name: Message_threadId_ready_seq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Message_threadId_ready_seq_idx" ON public."Message" USING btree ("threadId", seq) WHERE ("localState" = 'READY'::public."MessageLocalState");


--
-- Name: Message_threadId_seq_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Message_threadId_seq_key" ON public."Message" USING btree ("threadId", seq);


--
-- Name: Message_threadId_source_originSeq_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Message_threadId_source_originSeq_key" ON public."Message" USING btree ("threadId", "sourceNamespaceId", "originSeq");


--
-- Name: PeerStateFeed_peerDomain_feedId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "PeerStateFeed_peerDomain_feedId_key" ON public."PeerStateFeed" USING btree ("namespaceId", "feedId");


--
-- Name: PendingMedia_batchId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PendingMedia_batchId_idx" ON public."PendingMedia" USING btree ("batchId");


--
-- Name: PendingMedia_clientMessageId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "PendingMedia_clientMessageId_key" ON public."PendingMedia" USING btree ("clientMessageId");


--
-- Name: PendingMedia_messageId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "PendingMedia_messageId_key" ON public."PendingMedia" USING btree ("messageId") WHERE ("messageId" IS NOT NULL);


--
-- Name: PendingMedia_quote_dependency_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PendingMedia_quote_dependency_idx" ON public."PendingMedia" USING btree ("threadId", "originDomain", "dependsOnOriginSeq");


--
-- Name: PendingMedia_status_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PendingMedia_status_createdAt_idx" ON public."PendingMedia" USING btree (status, "createdAt");


--
-- Name: PendingMedia_threadId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PendingMedia_threadId_idx" ON public."PendingMedia" USING btree ("threadId");


--
-- Name: QuotaDailyUsage_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "QuotaDailyUsage_date_idx" ON public."QuotaDailyUsage" USING btree (date);


--
-- Name: QuotaFileByteUsage_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "QuotaFileByteUsage_date_idx" ON public."QuotaFileByteUsage" USING btree (date);


--
-- Name: SessionToken_pushToken_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "SessionToken_pushToken_key" ON public."SessionToken" USING btree ("pushToken") WHERE ("pushToken" IS NOT NULL);


--
-- Name: RelationshipIntent_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "RelationshipIntent_id_key" ON public."RelationshipIntent" USING btree (id);


--
-- Name: RelationshipPair_endpointA_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "RelationshipPair_endpointA_idx" ON public."RelationshipPair" USING btree ("endpointAType", "endpointAAccount", "endpointADomain", "endpointANamespaceId", active);


--
-- Name: RelationshipPair_endpointB_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "RelationshipPair_endpointB_idx" ON public."RelationshipPair" USING btree ("endpointBType", "endpointBAccount", "endpointBDomain", "endpointBNamespaceId", active);


--
-- Name: RelationshipPair_p2p_threadId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "RelationshipPair_p2p_threadId_key" ON public."RelationshipPair" USING btree ("threadId") WHERE (((kind)::text = 'P2P'::text) AND ("threadId" IS NOT NULL));


--
-- Name: RelationshipPair_thread_kind_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "RelationshipPair_thread_kind_active_idx" ON public."RelationshipPair" USING btree ("threadId", kind, active);


--
-- Name: SessionToken_lastSeenAt_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SessionToken_lastSeenAt_active_idx" ON public."SessionToken" USING btree ("lastSeenAt") WHERE ("revokedAt" IS NULL);


--
-- Name: SessionToken_tokenHash_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "SessionToken_tokenHash_key" ON public."SessionToken" USING btree ("tokenHash");


--
-- Name: SessionToken_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SessionToken_userId_idx" ON public."SessionToken" USING btree ("userId");


--
-- Name: SessionToken_userId_lastSeenAt_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SessionToken_userId_lastSeenAt_active_idx" ON public."SessionToken" USING btree ("userId", "lastSeenAt") WHERE ("revokedAt" IS NULL);


--
-- Name: ThreadAudience_local_access_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ThreadAudience_local_access_idx" ON public."ThreadAudience" USING btree ("localUserId", "threadId") WHERE (("targetDomain")::text = 'local'::text);


--
-- Name: ThreadAudience_local_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ThreadAudience_local_key" ON public."ThreadAudience" USING btree ("targetDomain", "localUserId", "threadId") WHERE (("targetDomain")::text = 'local'::text);


--
-- Name: ThreadAudience_peer_access_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ThreadAudience_peer_access_idx" ON public."ThreadAudience" USING btree ("targetNamespaceId", "threadId") WHERE (("targetDomain")::text <> 'local'::text);


--
-- Name: ThreadAudience_peer_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ThreadAudience_peer_key" ON public."ThreadAudience" USING btree ("targetNamespaceId", "threadId") WHERE (("targetDomain")::text <> 'local'::text);


--
-- Name: TwoFactorBackupCode_adminId_codeHash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "TwoFactorBackupCode_adminId_codeHash_idx" ON public."TwoFactorBackupCode" USING btree ("adminId", "codeHash");


--
-- Name: UploadSession_clientMessageId_partId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "UploadSession_clientMessageId_partId_key" ON public."UploadSession" USING btree ("clientMessageId", "partId");


--
-- Name: UploadSession_clientMessageId_position_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "UploadSession_clientMessageId_position_key" ON public."UploadSession" USING btree ("clientMessageId", "position");


--
-- Name: UploadSession_creatorId_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "UploadSession_creatorId_status_idx" ON public."UploadSession" USING btree ("creatorId", status);


--
-- Name: UploadSession_digest_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "UploadSession_digest_idx" ON public."UploadSession" USING btree (digest);


--
-- Name: UploadSession_status_updatedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "UploadSession_status_updatedAt_idx" ON public."UploadSession" USING btree (status, "updatedAt");


--
-- Name: UploadSession_uploadId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "UploadSession_uploadId_key" ON public."UploadSession" USING btree ("uploadId");


--
-- Name: UserQuotaDailyUsage_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "UserQuotaDailyUsage_date_idx" ON public."UserQuotaDailyUsage" USING btree (date);


--
-- Name: UserQuotaFileByteUsage_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "UserQuotaFileByteUsage_date_idx" ON public."UserQuotaFileByteUsage" USING btree (date);


--
-- Name: WebAuthnCredential_adminId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "WebAuthnCredential_adminId_idx" ON public."WebAuthnCredential" USING btree ("adminId");


--
-- Name: WebAuthnCredential_credentialId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "WebAuthnCredential_credentialId_key" ON public."WebAuthnCredential" USING btree ("credentialId");


--
-- Name: DurableTask DurableTask_insert_wake; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "DurableTask_insert_wake" AFTER INSERT ON public."DurableTask" FOR EACH ROW WHEN ((new.status = 'PENDING'::public."DurableTaskStatus")) EXECUTE FUNCTION public.notify_durable_task_work();


--
-- Name: DurableTask DurableTask_update_wake; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "DurableTask_update_wake" AFTER UPDATE ON public."DurableTask" FOR EACH ROW WHEN (((old.status IS DISTINCT FROM new.status) OR ((new.status = 'PENDING'::public."DurableTaskStatus") AND (((old."taskType")::text IS DISTINCT FROM (new."taskType")::text) OR (old.payload IS DISTINCT FROM new.payload) OR (old.checkpoint IS DISTINCT FROM new.checkpoint))))) EXECUTE FUNCTION public.notify_durable_task_work();


--
-- Name: MessageThread attention_history_after_write; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER attention_history_after_write AFTER UPDATE OF "clearedSeq" ON public."MessageThread" FOR EACH ROW EXECUTE FUNCTION public.attention_history_after_write();


--
-- Name: Message attention_message_before_write; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER attention_message_before_write BEFORE INSERT OR DELETE OR UPDATE ON public."Message" FOR EACH ROW EXECUTE FUNCTION public.attention_message_before_write();


--
-- Name: RelationshipPair client_thread_state_after_pair; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER client_thread_state_after_pair AFTER INSERT OR UPDATE OF active, established, "threadId" ON public."RelationshipPair" FOR EACH ROW EXECUTE FUNCTION public.client_thread_state_after_pair();


--
-- Name: AccountThreadState client_thread_state_after_participant; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER client_thread_state_after_participant AFTER INSERT OR UPDATE OF blocked, role ON public."AccountThreadState" FOR EACH ROW EXECUTE FUNCTION public.client_thread_state_after_participant();


--
-- Name: RelationshipPair relationship_establishment_before_write; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER relationship_establishment_before_write BEFORE INSERT OR UPDATE ON public."RelationshipPair" FOR EACH ROW EXECUTE FUNCTION public.relationship_establishment_before_write();


--
-- Name: AccountThreadState thread_feed_before_write; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER thread_feed_before_write BEFORE INSERT OR UPDATE ON public."AccountThreadState" FOR EACH ROW EXECUTE FUNCTION public.thread_feed_before_write();


--
-- Name: AccountThreadState AccountThreadState_accountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AccountThreadState"
    ADD CONSTRAINT "AccountThreadState_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON DELETE RESTRICT;


--
-- Name: AccountThreadState AccountThreadState_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AccountThreadState"
    ADD CONSTRAINT "AccountThreadState_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON DELETE RESTRICT;


--
-- Name: AdminActionLog AdminActionLog_adminId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AdminActionLog"
    ADD CONSTRAINT "AdminActionLog_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES public."Admin"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: AdminLoginChallenge AdminLoginChallenge_adminId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AdminLoginChallenge"
    ADD CONSTRAINT "AdminLoginChallenge_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES public."Admin"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: AdminSession AdminSession_adminId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AdminSession"
    ADD CONSTRAINT "AdminSession_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES public."Admin"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Admin Admin_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Admin"
    ADD CONSTRAINT "Admin_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: CallHistory CallHistory_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CallHistory"
    ADD CONSTRAINT "CallHistory_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON DELETE CASCADE;


--
-- Name: CallTombstone CallTombstone_namespaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CallTombstone"
    ADD CONSTRAINT "CallTombstone_namespaceId_fkey" FOREIGN KEY ("namespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;


--
-- Name: ClientStateFeed ClientStateFeed_namespaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientStateFeed"
    ADD CONSTRAINT "ClientStateFeed_namespaceId_fkey" FOREIGN KEY ("namespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;


--
-- Name: ClientStateFeed ClientStateFeed_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientStateFeed"
    ADD CONSTRAINT "ClientStateFeed_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."Account"(id) ON DELETE CASCADE;


--
-- Name: DeletedMessage DeletedMessage_sourceNamespaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DeletedMessage"
    ADD CONSTRAINT "DeletedMessage_sourceNamespaceId_fkey" FOREIGN KEY ("sourceNamespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;


--
-- Name: DeletedMessage DeletedMessage_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DeletedMessage"
    ADD CONSTRAINT "DeletedMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: DiagnosticsReport DiagnosticsReport_reporterUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DiagnosticsReport"
    ADD CONSTRAINT "DiagnosticsReport_reporterUserId_fkey" FOREIGN KEY ("reporterUserId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: FederatedMessageTombstone FederatedMessageTombstone_sourceNamespaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederatedMessageTombstone"
    ADD CONSTRAINT "FederatedMessageTombstone_sourceNamespaceId_fkey" FOREIGN KEY ("sourceNamespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;


--
-- Name: FederatedMessageTombstone FederatedMessageTombstone_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederatedMessageTombstone"
    ADD CONSTRAINT "FederatedMessageTombstone_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: FederatedPeer FederatedPeer_activeNamespace_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederatedPeer"
    ADD CONSTRAINT "FederatedPeer_activeNamespace_fkey" FOREIGN KEY (domain, "activeNamespaceId") REFERENCES public."IdentityNamespace"(domain, id) ON DELETE RESTRICT;


--
-- Name: FederationMessageReceipt FederationMessageReceipt_messageId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationMessageReceipt"
    ADD CONSTRAINT "FederationMessageReceipt_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES public."Message"(id) ON DELETE CASCADE;


--
-- Name: FederationMessageReceipt FederationMessageReceipt_namespaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationMessageReceipt"
    ADD CONSTRAINT "FederationMessageReceipt_namespaceId_fkey" FOREIGN KEY ("namespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;


--
-- Name: FederationMessageReceipt FederationMessageReceipt_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationMessageReceipt"
    ADD CONSTRAINT "FederationMessageReceipt_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON DELETE CASCADE;


--
-- Name: FederationThreadHistoryGap FederationThreadHistoryGap_namespaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationThreadHistoryGap"
    ADD CONSTRAINT "FederationThreadHistoryGap_namespaceId_fkey" FOREIGN KEY ("namespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;


--
-- Name: FederationThreadHistoryGap FederationThreadHistoryGap_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationThreadHistoryGap"
    ADD CONSTRAINT "FederationThreadHistoryGap_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON DELETE CASCADE;


--
-- Name: FederationThreadSyncState FederationThreadSyncState_activeGap_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationThreadSyncState"
    ADD CONSTRAINT "FederationThreadSyncState_activeGap_fkey" FOREIGN KEY ("threadId", "namespaceId", "activeGapId") REFERENCES public."FederationThreadHistoryGap"("threadId", "namespaceId", id) ON DELETE RESTRICT;


--
-- Name: FederationThreadSyncState FederationThreadSyncState_namespaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationThreadSyncState"
    ADD CONSTRAINT "FederationThreadSyncState_namespaceId_fkey" FOREIGN KEY ("namespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;


--
-- Name: FederationThreadSyncState FederationThreadSyncState_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationThreadSyncState"
    ADD CONSTRAINT "FederationThreadSyncState_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON DELETE CASCADE;


--
-- Name: FileSyncProgress FileSyncProgress_namespaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FileSyncProgress"
    ADD CONSTRAINT "FileSyncProgress_namespaceId_fkey" FOREIGN KEY ("namespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;


--
-- Name: ForwardBundleAsset ForwardBundleAsset_bundleId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ForwardBundleAsset"
    ADD CONSTRAINT "ForwardBundleAsset_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES public."ForwardBundle"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: ForwardBundleDependency ForwardBundleDependency_childBundleId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ForwardBundleDependency"
    ADD CONSTRAINT "ForwardBundleDependency_childBundleId_fkey" FOREIGN KEY ("childBundleId") REFERENCES public."ForwardBundle"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: ForwardBundleDependency ForwardBundleDependency_parentBundleId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ForwardBundleDependency"
    ADD CONSTRAINT "ForwardBundleDependency_parentBundleId_fkey" FOREIGN KEY ("parentBundleId") REFERENCES public."ForwardBundle"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: ForwardBundle ForwardBundle_sourceNamespaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ForwardBundle"
    ADD CONSTRAINT "ForwardBundle_sourceNamespaceId_fkey" FOREIGN KEY ("sourceNamespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;


--
-- Name: ForwardMessage ForwardMessage_bundleId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ForwardMessage"
    ADD CONSTRAINT "ForwardMessage_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES public."ForwardBundle"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: ForwardMessage ForwardMessage_messageId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ForwardMessage"
    ADD CONSTRAINT "ForwardMessage_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES public."Message"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: GroupMetaMemberFeed GroupMetaMemberFeed_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GroupMetaMemberFeed"
    ADD CONSTRAINT "GroupMetaMemberFeed_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON DELETE CASCADE;


--
-- Name: GroupMeta GroupMeta_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GroupMeta"
    ADD CONSTRAINT "GroupMeta_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON DELETE CASCADE;


--
-- Name: GroupRequestProjection GroupRequestProjection_memberNamespaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GroupRequestProjection"
    ADD CONSTRAINT "GroupRequestProjection_memberNamespaceId_fkey" FOREIGN KEY ("memberNamespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE CASCADE;


--
-- Name: GroupRequestProjection GroupRequestProjection_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GroupRequestProjection"
    ADD CONSTRAINT "GroupRequestProjection_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON DELETE CASCADE;


--
-- Name: LoginCode LoginCode_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."LoginCode"
    ADD CONSTRAINT "LoginCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: MessageAsset MessageAsset_messageId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MessageAsset"
    ADD CONSTRAINT "MessageAsset_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES public."Message"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: MessageAsset MessageAsset_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MessageAsset"
    ADD CONSTRAINT "MessageAsset_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: MessageReport MessageReport_threadId_seq_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MessageReport"
    ADD CONSTRAINT "MessageReport_threadId_seq_fkey" FOREIGN KEY ("threadId", seq) REFERENCES public."Message"("threadId", seq) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: MessageThread MessageThread_authorityNamespaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MessageThread"
    ADD CONSTRAINT "MessageThread_authorityNamespaceId_fkey" FOREIGN KEY ("authorityNamespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;


--
-- Name: MessageThread MessageThread_groupAccountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MessageThread"
    ADD CONSTRAINT "MessageThread_groupAccountId_fkey" FOREIGN KEY ("groupAccountId") REFERENCES public."GroupAccount"(id) ON DELETE RESTRICT;


--
-- Name: Message Message_creatorNamespaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Message"
    ADD CONSTRAINT "Message_creatorNamespaceId_fkey" FOREIGN KEY ("creatorNamespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;


--
-- Name: Message Message_sourceNamespaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Message"
    ADD CONSTRAINT "Message_sourceNamespaceId_fkey" FOREIGN KEY ("sourceNamespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;


--
-- Name: Message Message_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Message"
    ADD CONSTRAINT "Message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: PeerStateFeedPullCursor PeerStateFeedPullCursor_namespace_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PeerStateFeedPullCursor"
    ADD CONSTRAINT "PeerStateFeedPullCursor_namespace_fkey" FOREIGN KEY ("peerDomain", "namespaceId") REFERENCES public."IdentityNamespace"(domain, id) ON DELETE RESTRICT;


--
-- Name: PeerStateFeed PeerStateFeed_namespace_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PeerStateFeed"
    ADD CONSTRAINT "PeerStateFeed_namespace_fkey" FOREIGN KEY ("peerDomain", "namespaceId") REFERENCES public."IdentityNamespace"(domain, id) ON DELETE RESTRICT;


--
-- Name: PendingMedia PendingMedia_messageId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PendingMedia"
    ADD CONSTRAINT "PendingMedia_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES public."Message"(id) ON DELETE CASCADE;


--
-- Name: PendingMedia PendingMedia_namespaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PendingMedia"
    ADD CONSTRAINT "PendingMedia_namespaceId_fkey" FOREIGN KEY ("namespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;


--
-- Name: PendingMedia PendingMedia_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PendingMedia"
    ADD CONSTRAINT "PendingMedia_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: Profile Profile_namespaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Profile"
    ADD CONSTRAINT "Profile_namespaceId_fkey" FOREIGN KEY ("namespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;


--
-- Name: QuotaDailyAllowance QuotaDailyAllowance_namespaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."QuotaDailyAllowance"
    ADD CONSTRAINT "QuotaDailyAllowance_namespaceId_fkey" FOREIGN KEY ("namespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE CASCADE;


--
-- Name: QuotaDailyUsage QuotaDailyUsage_namespaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."QuotaDailyUsage"
    ADD CONSTRAINT "QuotaDailyUsage_namespaceId_fkey" FOREIGN KEY ("namespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE CASCADE;


--
-- Name: QuotaFileByteUsage QuotaFileByteUsage_namespaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."QuotaFileByteUsage"
    ADD CONSTRAINT "QuotaFileByteUsage_namespaceId_fkey" FOREIGN KEY ("namespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE CASCADE;


--
-- Name: RelationshipIntent RelationshipIntent_pairId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."RelationshipIntent"
    ADD CONSTRAINT "RelationshipIntent_pairId_fkey" FOREIGN KEY ("pairId") REFERENCES public."RelationshipPair"(id) ON DELETE CASCADE;


--
-- Name: RelationshipPair RelationshipPair_endpointANamespaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."RelationshipPair"
    ADD CONSTRAINT "RelationshipPair_endpointANamespaceId_fkey" FOREIGN KEY ("endpointANamespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;


--
-- Name: RelationshipPair RelationshipPair_endpointBNamespaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."RelationshipPair"
    ADD CONSTRAINT "RelationshipPair_endpointBNamespaceId_fkey" FOREIGN KEY ("endpointBNamespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;


--
-- Name: RelationshipPair RelationshipPair_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."RelationshipPair"
    ADD CONSTRAINT "RelationshipPair_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON DELETE SET NULL;


--
-- Name: S2SKeyCache S2SKeyCache_namespace_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."S2SKeyCache"
    ADD CONSTRAINT "S2SKeyCache_namespace_fkey" FOREIGN KEY (domain, "namespaceId") REFERENCES public."IdentityNamespace"(domain, id) ON DELETE RESTRICT;


--
-- Name: SessionToken SessionToken_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SessionToken"
    ADD CONSTRAINT "SessionToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: ThreadAudience ThreadAudience_localUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ThreadAudience"
    ADD CONSTRAINT "ThreadAudience_localUserId_fkey" FOREIGN KEY ("localUserId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ThreadAudience ThreadAudience_targetNamespace_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ThreadAudience"
    ADD CONSTRAINT "ThreadAudience_targetNamespace_fkey" FOREIGN KEY ("targetDomain", "targetNamespaceId") REFERENCES public."IdentityNamespace"(domain, id) ON DELETE RESTRICT;


--
-- Name: ThreadAudience ThreadAudience_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ThreadAudience"
    ADD CONSTRAINT "ThreadAudience_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: TwoFactorBackupCode TwoFactorBackupCode_adminId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."TwoFactorBackupCode"
    ADD CONSTRAINT "TwoFactorBackupCode_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES public."Admin"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: UploadSession UploadSession_creatorId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UploadSession"
    ADD CONSTRAINT "UploadSession_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: UserPreference UserPreference_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserPreference"
    ADD CONSTRAINT "UserPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: UserQuotaDailyAllowance UserQuotaDailyAllowance_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserQuotaDailyAllowance"
    ADD CONSTRAINT "UserQuotaDailyAllowance_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."Account"(id) ON DELETE CASCADE;


--
-- Name: UserQuotaDailyUsage UserQuotaDailyUsage_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserQuotaDailyUsage"
    ADD CONSTRAINT "UserQuotaDailyUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."Account"(id) ON DELETE CASCADE;


--
-- Name: UserQuotaFileByteUsage UserQuotaFileByteUsage_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserQuotaFileByteUsage"
    ADD CONSTRAINT "UserQuotaFileByteUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."Account"(id) ON DELETE CASCADE;


--
-- Name: UserQuotaPolicy UserQuotaPolicy_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserQuotaPolicy"
    ADD CONSTRAINT "UserQuotaPolicy_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."Account"(id) ON DELETE CASCADE;


--
-- Name: WebAuthnCredential WebAuthnCredential_adminId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."WebAuthnCredential"
    ADD CONSTRAINT "WebAuthnCredential_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES public."Admin"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--


-- Required local identities.
INSERT INTO public."IdentityNamespace" (id, domain) VALUES (0, 'local');
INSERT INTO public."Account" (account, kind, "disabledAt")
VALUES ('$system', 'SYSTEM', CURRENT_TIMESTAMP);
