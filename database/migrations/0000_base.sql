--
-- PostgreSQL database dump
--


-- Dumped from database version 18.4 (Debian 18.4-1.pgdg13+1)
-- Dumped by pg_dump version 18.6 (Ubuntu 18.6-1.pgdg24.04+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET search_path TO public, pg_catalog;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--



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
    'GROUP_PROFILE',
    'GROUP_ANNOUNCEMENT'
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

-- Verification of a federated payload is independent from local materialization state.
CREATE TYPE public."FederationPayloadVerification" AS ENUM (
    'UNVERIFIED',
    'VERIFIED',
    'CONFLICT'
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
    UPDATE "AccountThreadState" SET "updatedAt" = CURRENT_TIMESTAMP, "unreadCount" =
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
    "announcementReadFeedId" integer DEFAULT 0 NOT NULL,
    "threadFeedId" integer DEFAULT 0 NOT NULL,
    "messageEndSeq" integer DEFAULT 0 NOT NULL,
    "tombstoneEndSeq" integer DEFAULT 0 NOT NULL,
    "unreadCount" integer DEFAULT 0 NOT NULL,
    "previewSeqs" integer[] DEFAULT '{}'::integer[] NOT NULL,
    "lastMentionSeq" integer,
    "joinRequestEndFeedId" integer DEFAULT 0 NOT NULL,
    "groupInviteEndFeedId" integer DEFAULT 0 NOT NULL,
    "joinRequestReadFeedId" integer DEFAULT '-1'::integer NOT NULL,
    "groupMetaFeedEndId" integer,
    "threadProfileRev" integer DEFAULT 0 NOT NULL,
    "profileSourceId" integer,
    muted boolean DEFAULT false NOT NULL,
    blocked boolean DEFAULT false NOT NULL,
    pinned boolean DEFAULT false NOT NULL,
    "pinnedAt" timestamp(3) with time zone,
    "messageVisibleThroughSeq" bigint,
    alias character varying(64),
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "AccountThreadState_announcementReadFeedId_check" CHECK (("announcementReadFeedId" >= 0)),
    CONSTRAINT "AccountThreadState_groupInviteEndFeedId_check" CHECK (("groupInviteEndFeedId" >= 0)),
    CONSTRAINT "AccountThreadState_groupMetaFeedEndId_check" CHECK ((("groupMetaFeedEndId" IS NULL) OR ("groupMetaFeedEndId" >= 0))),
    CONSTRAINT "AccountThreadState_joinRequestEndFeedId_check" CHECK (("joinRequestEndFeedId" >= 0)),
    CONSTRAINT "AccountThreadState_joinRequestReadFeedId_check" CHECK ((("joinRequestReadFeedId" >= '-1'::integer) AND ("joinRequestReadFeedId" <= "joinRequestEndFeedId"))),
    CONSTRAINT "AccountThreadState_lastMentionSeq_check" CHECK ((("lastMentionSeq" IS NULL) OR ("lastMentionSeq" > 0))),
    CONSTRAINT "AccountThreadState_lastReadSeq_check" CHECK (("lastReadSeq" >= 0)),
    CONSTRAINT "AccountThreadState_messageEndSeq_check" CHECK (("messageEndSeq" >= 0)),
    CONSTRAINT "AccountThreadState_messageVisibleThroughSeq_check" CHECK ((("messageVisibleThroughSeq" IS NULL) OR ("messageVisibleThroughSeq" >= 0))),
    CONSTRAINT "AccountThreadState_profileSourceId_check" CHECK ((("profileSourceId" IS NULL) OR ("profileSourceId" > 0))),
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
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "isDeleted" boolean DEFAULT false NOT NULL,
    "clientMessageId" character varying(36),
    "originSeq" integer,
    "originServerTime" timestamp(3) with time zone,
    "publisherNamespaceId" integer DEFAULT 0 CONSTRAINT "Message_sourceNamespaceId_not_null" NOT NULL,
    "localState" public."MessageLocalState" DEFAULT 'READY'::public."MessageLocalState" NOT NULL,
    "profileRev" integer DEFAULT 0 NOT NULL,
    "profileNamespaceId" integer DEFAULT 0 NOT NULL,
    "payloadDigest" character varying(64),
    "federationPayloadVerification" public."FederationPayloadVerification" DEFAULT 'UNVERIFIED'::public."FederationPayloadVerification" NOT NULL,
    "federationEnvelopeDigest" character varying(64),
    CONSTRAINT "Message_payload_digest_check" CHECK (("contentType" = 'SYSTEM'::public."ContentType") OR ("payloadDigest" IS NOT NULL)),
    CONSTRAINT "Message_origin_seq_check" CHECK ((("publisherNamespaceId" = 0) OR (("originSeq" IS NOT NULL) AND ("originSeq" > 0)))),
    CONSTRAINT "Message_profileRev_check" CHECK (("profileRev" >= 0)),
    CONSTRAINT "Message_seq_check" CHECK ((seq > 0)),
    CONSTRAINT "Message_system_creator_check" CHECK ((("creatorAccount" IS NOT NULL) AND ((("contentType" = 'SYSTEM'::public."ContentType") AND (("creatorAccount")::text = '$system'::text) AND ("profileNamespaceId" = 0) AND ("profileRev" = 0) AND ("publisherNamespaceId" = 0)) OR (("contentType" <> 'SYSTEM'::public."ContentType") AND (("creatorAccount")::text <> '$system'::text)))))
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
      AND a.account = m."creatorAccount"
      AND a."namespaceId" = m."profileNamespaceId")
    AND NOT s.blocked;
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
-- Name: thread_feed_after_pair(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.thread_feed_after_pair() RETURNS trigger
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
    SET "updatedAt" = CURRENT_TIMESTAMP, "threadFeedId" = 0,
        "threadProfileRev" = CASE WHEN seed_revision AND participant."profileRev" IS NOT NULL
          THEN participant."profileRev" ELSE s."threadProfileRev" END,
        "profileSourceId" = CASE WHEN seed_revision AND participant."profileRev" IS NOT NULL
          THEN NULL ELSE s."profileSourceId" END
    WHERE s."accountId" = participant."accountId" AND s."threadId" = NEW."threadId";
  END LOOP;
  RETURN NEW;
END;
$$;


--
-- Name: thread_feed_after_participant(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.thread_feed_after_participant() RETURNS trigger
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
    UPDATE "AccountThreadState" SET "updatedAt" = CURRENT_TIMESTAMP, "threadProfileRev" = initial_rev,
      "profileSourceId" = NULL
    WHERE id = NEW.id;
  END IF;
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
    OR NEW."groupMetaFeedEndId" IS DISTINCT FROM OLD."groupMetaFeedEndId"
    OR NEW."threadProfileRev" IS DISTINCT FROM OLD."threadProfileRev"
    OR NEW.blocked IS DISTINCT FROM OLD.blocked
    OR NEW.role IS DISTINCT FROM OLD.role THEN
    UPDATE "Account" SET "updatedAt" = CURRENT_TIMESTAMP, "threadFeedEndId" = "threadFeedEndId" + 1
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
    account character varying(31) NOT NULL,
    kind character varying(16) DEFAULT 'USER'::character varying NOT NULL,
    "namespaceId" integer DEFAULT 0 NOT NULL,
    "defaultProfileRev" integer DEFAULT 0 NOT NULL,
    availability character varying(16) DEFAULT 'AVAILABLE'::character varying NOT NULL,
    "hashPwd" character varying(127),
    "mustChangePassword" boolean DEFAULT false NOT NULL,
    "disabledAt" timestamp(3) with time zone,
    "clientStateFeedEndId" integer DEFAULT 0 NOT NULL,
    "requestEndId" bigint DEFAULT 0 NOT NULL,
    "requestReadId" bigint DEFAULT 0 NOT NULL,
    "threadFeedEndId" integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "Account_account_check" CHECK (((account)::text !~~ '!%'::text)),
    CONSTRAINT "Account_availability_check" CHECK (((availability)::text = ANY (ARRAY[('AVAILABLE'::character varying)::text, ('REMOVED'::character varying)::text]))),
    CONSTRAINT "Account_request_head_check" CHECK ("requestReadId" >= 0 AND "requestReadId" <= "requestEndId"),
    CONSTRAINT "Account_clientStateFeedEndId_check" CHECK (("clientStateFeedEndId" >= 0)),
    CONSTRAINT "Account_defaultProfileRev_check" CHECK (("defaultProfileRev" >= 0)),
    CONSTRAINT "Account_namespace_check" CHECK (("namespaceId" = 0)),
    CONSTRAINT "Account_kind_check" CHECK (((((kind)::text = 'USER'::text) AND ((account)::text <> '$system'::text)) OR (((kind)::text = 'SYSTEM'::text) AND ((account)::text = '$system'::text) AND ("hashPwd" IS NULL) AND ("disabledAt" IS NOT NULL) AND ("defaultProfileRev" = 0)))),
    CONSTRAINT "Account_threadFeedEndId_check" CHECK (("threadFeedEndId" >= 0))
);


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
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
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
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
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
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    jti character varying(36) NOT NULL,
    "adminId" integer NOT NULL,
    "consumedAt" timestamp(3) with time zone,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: AdminSession; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AdminSession" (
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
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
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    key text NOT NULL,
    "threadId" integer NOT NULL,
    snapshot jsonb NOT NULL,
    revision integer NOT NULL,
    terminal boolean DEFAULT false NOT NULL,
    "messageSeq" integer
);


--
-- Name: ClientStateFeed; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ClientStateFeed" (
    "userId" integer NOT NULL,
    "feedId" integer NOT NULL,
    body jsonb NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "ClientStateFeed_feedId_check" CHECK (("feedId" > 0))
);


--
-- Name: DeletedMessage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."DeletedMessage" (
    "threadId" integer NOT NULL,
    "deletionSeq" integer NOT NULL,
    "messageSeq" integer NOT NULL,
    type public."MessageDeleteType" NOT NULL,
    "publisherNamespaceId" integer DEFAULT 0 CONSTRAINT "DeletedMessage_sourceNamespaceId_not_null" NOT NULL,
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
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
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
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
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
    "publisherNamespaceId" integer CONSTRAINT "FederatedMessageTombstone_sourceNamespaceId_not_null" NOT NULL,
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
-- Name: FederationIdentityReview; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FederationIdentityReview" (
    id integer NOT NULL,
    kind character varying(15) NOT NULL,
    "matchedNamespaceId" integer NOT NULL,
    "nextDomain" character varying(63) NOT NULL,
    "claimedRoot" character varying(44) NOT NULL,
    claim jsonb NOT NULL,
    status character varying(15) DEFAULT 'pending'::character varying NOT NULL,
    "reviewedAt" timestamp(3) with time zone,
    "verifiedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "FederationIdentityReview_kind_check" CHECK (((kind)::text = ANY ((ARRAY['domain-rebind'::character varying, 'root-rotation'::character varying, 'identity-reset'::character varying])::text[]))),
    CONSTRAINT "FederationIdentityReview_matchedNamespace_check" CHECK (("matchedNamespaceId" > 0)),
    CONSTRAINT "FederationIdentityReview_reviewed_check" CHECK ((((status)::text = 'pending'::text) = ("reviewedAt" IS NULL))),
    CONSTRAINT "FederationIdentityReview_status_check" CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'approved'::character varying, 'rejected'::character varying])::text[])))
);


--
-- Name: FederationIdentityReview_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."FederationIdentityReview_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: FederationIdentityReview_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."FederationIdentityReview_id_seq" OWNED BY public."FederationIdentityReview".id;


--
-- Name: FederationIdentityConflict; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FederationIdentityConflict" (
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    id integer NOT NULL,
    domain character varying(63) NOT NULL,
    "rootPublicKey" character varying(44) NOT NULL,
    "namespaceId" integer NOT NULL,
    "namespaceDomain" character varying(63) NOT NULL,
    "namespaceRoot" character varying(44) NOT NULL,
    code integer NOT NULL,
    reason character varying(255) NOT NULL,
    "verifiedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: FederationIdentityConflict_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."FederationIdentityConflict_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: FederationIdentityConflict_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."FederationIdentityConflict_id_seq" OWNED BY public."FederationIdentityConflict".id;


--
-- Name: FederationIdentityConflict; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationIdentityConflict" ALTER COLUMN id SET DEFAULT nextval('public."FederationIdentityConflict_id_seq"'::regclass);


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
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
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
    digest character varying(64) NOT NULL,
    kind public."FileSyncKind" NOT NULL,
    status public."FileSyncStatus" DEFAULT 'PENDING'::public."FileSyncStatus" NOT NULL,
    "bytesTotal" bigint DEFAULT 0 NOT NULL,
    "bytesReceived" bigint DEFAULT 0 NOT NULL,
    "originDomain" character varying(63),
    "publisherNamespaceId" integer DEFAULT 0 CONSTRAINT "FileSyncProgress_namespaceId_not_null" NOT NULL,
    "errorKind" character varying(255),
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    payload jsonb
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
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    id bigserial NOT NULL,
    messages jsonb NOT NULL,
    "messageCount" integer NOT NULL,
    "assetCount" integer NOT NULL,
    "totalBytes" bigint NOT NULL,
    "sourceDomain" character varying(63),
    "publisherNamespaceId" integer,
    "sourceBundleId" character varying(64),
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
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "bundleId" bigint NOT NULL,
    digest character varying(64) NOT NULL,
    ordinal integer NOT NULL,
    bytes bigint NOT NULL
);


--
-- Name: ForwardBundleDependency; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ForwardBundleDependency" (
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "parentBundleId" bigint NOT NULL,
    "childBundleId" bigint NOT NULL,
    ordinal integer NOT NULL
);


--
-- Name: ForwardMessage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ForwardMessage" (
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "messageId" bigint NOT NULL,
    "bundleId" bigint NOT NULL
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
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "metaEndId" integer DEFAULT 0 NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "threadId" integer NOT NULL,
    "applicationEndId" integer DEFAULT 0 NOT NULL,
    "invitationEndId" integer DEFAULT 0 NOT NULL,
    "profileRev" integer DEFAULT 0 NOT NULL,
    "metaTargetId" integer DEFAULT 0 NOT NULL,
    "metaProcessedThroughId" integer DEFAULT 0 NOT NULL,
    "metaRecoveryThroughId" integer,
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
    "originCreatedAt" timestamp(3) with time zone,
    "feedId" integer NOT NULL,
    operation public."GroupMetaMemberOperation" NOT NULL,
    body jsonb NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "threadId" integer NOT NULL,
    "profileSourceSeq" integer,
    CONSTRAINT "GroupMetaMemberFeed_announcement_check" CHECK (operation <> 'GROUP_ANNOUNCEMENT' OR COALESCE(
      body ? 'text' AND (body - 'text') = '{}'::jsonb
      AND (body -> 'text' = 'null'::jsonb OR (
        jsonb_typeof(body -> 'text') = 'string'
        AND char_length(body ->> 'text') BETWEEN 1 AND 4096)), false)),
    CONSTRAINT "GroupMetaMemberFeed_time_check" CHECK (
      "createdAt" >= '1970-01-01'::timestamptz AND (
        "originCreatedAt" IS NULL OR "originCreatedAt" >= '1970-01-01'::timestamptz)),
    CONSTRAINT "GroupMetaMemberFeed_body_check" CHECK (((jsonb_typeof(body) = 'object'::text) AND (body <> '{}'::jsonb))),
    CONSTRAINT "GroupMetaMemberFeed_feedId_check" CHECK (("feedId" > 0)),
    CONSTRAINT "GroupMetaMemberFeed_profileSourceSeq_check" CHECK ((("profileSourceSeq" IS NULL) OR ("profileSourceSeq" > 0)))
);


--
-- Name: IdentityNamespace; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."IdentityNamespace" (
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    id integer NOT NULL,
    domain character varying(63) NOT NULL,
    "rootPublicKey" character varying(44),
    "identityPinnedAt" timestamp(3) with time zone,
    "peerAssignedLocalNamespaceId" integer,
    "signingKeyCreatedAt" bigint NOT NULL,
    active boolean DEFAULT false NOT NULL,
    "trustLevel" character varying(31) DEFAULT 'unrecognized'::character varying NOT NULL,
    "trustedAt" timestamp(3) with time zone,
    "lastSuccessAt" timestamp(3) with time zone,
    "degradedAt" timestamp(3) with time zone,
    "degradationReason" character varying(255),
    "degradationCount" integer DEFAULT 0 NOT NULL,
    "haltedAt" timestamp(3) with time zone,
    "haltCode" integer,
    "haltReason" character varying(255),
    "peerAcceptanceConfirmed" boolean DEFAULT false NOT NULL,
    "localServiceAvailable" boolean DEFAULT false NOT NULL,
    "remoteServiceReachable" boolean DEFAULT false NOT NULL,
    "resetAt" timestamp(3) with time zone,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "retiredAt" timestamp(3) with time zone,
    CONSTRAINT "IdentityNamespace_signingKeyCreatedAt_check" CHECK ((id = 0 AND "signingKeyCreatedAt" = 0) OR (id > 0 AND "signingKeyCreatedAt" BETWEEN 1 AND 9007199254740991)),
    CONSTRAINT "IdentityNamespace_active_check" CHECK (((active = false) OR ((id > 0) AND ("retiredAt" IS NULL)))),
    CONSTRAINT "IdentityNamespace_retiredAt_check" CHECK ((("retiredAt" IS NULL) OR ("retiredAt" >= "createdAt"))),
    CONSTRAINT "IdentityNamespace_shape_check" CHECK ((((id = 0) AND ("rootPublicKey" IS NULL) AND ("identityPinnedAt" IS NULL) AND ("peerAssignedLocalNamespaceId" IS NULL) AND ("retiredAt" IS NULL) AND (active = false) AND (("trustLevel")::text = 'unrecognized'::text) AND ("trustedAt" IS NULL) AND ("lastSuccessAt" IS NULL) AND ("degradedAt" IS NULL) AND ("degradationReason" IS NULL) AND ("degradationCount" = 0) AND ("haltedAt" IS NULL) AND ("haltCode" IS NULL) AND ("haltReason" IS NULL) AND ("peerAcceptanceConfirmed" = false) AND ("localServiceAvailable" = false) AND ("remoteServiceReachable" = false) AND ("resetAt" IS NULL)) OR ((id > 0) AND ("rootPublicKey" IS NOT NULL) AND ("identityPinnedAt" IS NOT NULL) AND (("peerAssignedLocalNamespaceId" IS NULL) OR ("peerAssignedLocalNamespaceId" > 0))))),
    CONSTRAINT "IdentityNamespace_trustLevel_check" CHECK ((("trustLevel")::text = ANY (ARRAY[('unrecognized'::character varying)::text, ('establishing'::character varying)::text, ('pending'::character varying)::text, ('available'::character varying)::text, ('degraded'::character varying)::text, ('halted'::character varying)::text])))
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
-- Name: LocalFederationRoot; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."LocalFederationRoot" (
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    id integer NOT NULL,
    "rootPublicKey" character varying(44) NOT NULL,
    "rootPrivateKey" character varying(44) NOT NULL,
    "notBefore" timestamp(3) with time zone NOT NULL,
    "notAfter" timestamp(3) with time zone NOT NULL,
    claimable boolean DEFAULT false NOT NULL,
    "unpublishedAt" timestamp(3) with time zone,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "LocalFederationRoot_claimable_check" CHECK (((claimable = false) OR ("unpublishedAt" IS NULL))),
    CONSTRAINT "LocalFederationRoot_validity_check" CHECK (("notBefore" < "notAfter"))
);


--
-- Name: LocalFederationRoot_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."LocalFederationRoot_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: LocalFederationRoot_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."LocalFederationRoot_id_seq" OWNED BY public."LocalFederationRoot".id;


--
-- Name: LocalFederationSigningKey; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."LocalFederationSigningKey" (
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "keyName" character varying(64) NOT NULL,
    "publicKey" character varying(44) NOT NULL,
    "privateKey" character varying(44) NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "notBefore" timestamp(3) with time zone NOT NULL,
    "notAfter" timestamp(3) with time zone NOT NULL,
    "rootId" integer NOT NULL,
    CONSTRAINT "LocalFederationSigningKey_name_check" CHECK ((("keyName")::text ~ '^[A-Za-z0-9._-]{1,64}$'::text)),
    CONSTRAINT "LocalFederationSigningKey_validity_check" CHECK (("notBefore" < "notAfter"))
);


--
-- Name: LocalFederationSigningState; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."LocalFederationSigningState" (
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    id integer DEFAULT 0 NOT NULL,
    "currentKeyName" character varying(64) NOT NULL,
    "plannedSwitchAt" timestamp(3) with time zone,
    "plannedSuccessorKeyName" character varying(64),
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "LocalFederationSigningState_id_check" CHECK ((id = 0)),
    CONSTRAINT "LocalFederationSigningState_plan_check" CHECK ((("plannedSwitchAt" IS NULL) = ("plannedSuccessorKeyName" IS NULL)))
);


--
-- Name: LoginCode; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."LoginCode" (
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    id integer NOT NULL,
    "userId" integer NOT NULL,
    "codeHash" character varying(127) NOT NULL,
    "issuedBy" integer NOT NULL,
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
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
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
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "curSeq" integer DEFAULT 0 NOT NULL,
    "tombstoneEndSeq" integer DEFAULT 0 NOT NULL,
    "pullUntil" integer DEFAULT 0 NOT NULL,
    "authorityNamespaceId" integer DEFAULT 0 NOT NULL,
    "authorizationEpoch" integer DEFAULT 0 NOT NULL,
    "clearedSeq" integer,
    "groupAccount" character varying(31),
    "groupAccountId" integer,
    "groupDissolvedAt" timestamp(3) with time zone,
    "federationRoundsEnabled" boolean DEFAULT false NOT NULL,
    CONSTRAINT "MessageThread_authorizationEpoch_check" CHECK (("authorizationEpoch" >= 0)),
    CONSTRAINT "MessageThread_clearedSeq_check" CHECK ((("clearedSeq" IS NULL) OR (("clearedSeq" >= 0) AND ("clearedSeq" <= "curSeq")))),
    CONSTRAINT "MessageThread_group_identity_check" CHECK (((type <> 'GROUP'::public."MessageThreadType") OR ((("authorityNamespaceId" = 0) = ("groupAccountId" IS NOT NULL)) AND (("groupAccount")::text ~~ '!%'::text)))),
    CONSTRAINT "MessageThread_group_type_check" CHECK ((((type = 'GROUP'::public."MessageThreadType") AND ("groupAccount" IS NOT NULL)) OR ((type = 'P2P'::public."MessageThreadType") AND ("groupAccount" IS NULL) AND ("groupAccountId" IS NULL) AND ("groupDissolvedAt" IS NULL)))),
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
    "namespaceId" integer NOT NULL,
    account character varying(31) NOT NULL,
    "eventType" public."PeerStateEventType" NOT NULL,
    "subjectAccount" character varying(31) DEFAULT ''::character varying NOT NULL,
    "subjectNamespaceId" integer DEFAULT 0 NOT NULL,
    "feedId" bigint NOT NULL,
    body jsonb NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "PeerStateFeed_feedId_check" CHECK (("feedId" > 0)),
    CONSTRAINT "PeerStateFeed_subject_check" CHECK (((("eventType" = 'RELATIONSHIP_INTENT'::public."PeerStateEventType") AND (("subjectAccount")::text <> ''::text) AND ("subjectNamespaceId" > 0)) OR (("eventType" = 'THREAD_CONTENT_HEAD'::public."PeerStateEventType") AND ((((account)::text ~~ '!%'::text) AND (("subjectAccount")::text = ''::text) AND ("subjectNamespaceId" = 0)) OR (((account)::text !~~ '!%'::text) AND (("subjectAccount")::text <> ''::text) AND ("subjectNamespaceId" = "namespaceId"))))))
);


--
-- Name: PendingMedia; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."PendingMedia" (
    id bigint NOT NULL,
    "messageId" bigint,
    "threadId" integer,
    "creatorAccount" character varying(31),
    "contentType" public."ContentType",
    content text,
    "clientMessageId" character varying(36),
    status character varying(12) DEFAULT 'pending'::character varying NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "failReason" character varying(255),
    direction public."FileSyncDirection" DEFAULT 'OUTBOUND'::public."FileSyncDirection" NOT NULL,
    "batchId" uuid DEFAULT gen_random_uuid() NOT NULL,
    "fileCnt" integer DEFAULT 1 NOT NULL,
    "anyFailed" boolean DEFAULT false NOT NULL,
    "originDomain" character varying(63),
    "publisherNamespaceId" integer DEFAULT 0 CONSTRAINT "PendingMedia_namespaceId_not_null" NOT NULL,
    "expectedAuthorizationEpoch" integer,
    "dependsOnOriginSeq" integer,
    CONSTRAINT "PendingMedia_depends_on_origin_seq_check" CHECK ((("dependsOnOriginSeq" IS NULL) OR ("dependsOnOriginSeq" > 0))),
    CONSTRAINT "PendingMedia_direction_shape_check" CHECK ((((direction = 'OUTBOUND'::public."FileSyncDirection") AND ("messageId" IS NULL) AND ("threadId" IS NOT NULL) AND ("creatorAccount" IS NOT NULL) AND ("contentType" IS NOT NULL) AND (content IS NOT NULL) AND ("originDomain" IS NULL) AND ("expectedAuthorizationEpoch" IS NULL) AND ("dependsOnOriginSeq" IS NULL)) OR ((direction = 'INBOUND'::public."FileSyncDirection") AND ("messageId" IS NOT NULL) AND ("threadId" IS NULL) AND ("creatorAccount" IS NULL) AND ("contentType" IS NULL) AND (content IS NULL) AND ("clientMessageId" IS NULL) AND ("originDomain" IS NOT NULL) AND ("expectedAuthorizationEpoch" IS NOT NULL)))),
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
    "generatedAt" bigint NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    account character varying(31) NOT NULL,
    "profileRev" integer NOT NULL,
    "displayName" character varying(31) NOT NULL,
    avatar text DEFAULT ''::text NOT NULL,
    bio character varying(255) DEFAULT ''::character varying NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "publisherNamespaceId" integer NOT NULL,
    "profileNamespaceId" integer NOT NULL,
    CONSTRAINT "Profile_profileRev_check" CHECK (("profileRev" > 0)),
    CONSTRAINT "Profile_generatedAt_check" CHECK (("generatedAt" >= 0 AND "generatedAt" <= 9007199254740991))
);


--
-- Name: ProfileNamespaceChangeFeed; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ProfileNamespaceChangeFeed" (
    "publisherNamespaceId" integer NOT NULL,
    "profileNamespaceId" integer NOT NULL,
    "changeId" bigint NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "ProfileNamespaceChangeFeed_changeId_check" CHECK (("changeId" > 0))
);


--
-- Name: ProfileNamespaceChangeFeedHead; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ProfileNamespaceChangeFeedHead" (
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    id integer NOT NULL,
    "endId" bigint DEFAULT 0 NOT NULL,
    CONSTRAINT "ProfileNamespaceChangeFeedHead_endId_check" CHECK (("endId" >= 0)),
    CONSTRAINT "ProfileNamespaceChangeFeedHead_id_check" CHECK ((id = 0))
);


--
-- Name: ProfileNamespaceFeed; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ProfileNamespaceFeed" (
    "namespaceId" integer NOT NULL,
    "feedId" bigint NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "ProfileNamespaceFeed_feedId_check" CHECK (("feedId" > 0))
);


--
-- Name: ProfileNamespace; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ProfileNamespace" (
    "publisherNamespaceId" integer NOT NULL,
    "profileNamespaceId" integer NOT NULL,
    domain character varying(63),
    "rootPublicKey" character varying(44),
    "sourceGeneratedAt" bigint DEFAULT 0 NOT NULL,
    "updateFeedId" bigint DEFAULT 0 NOT NULL,
    expired boolean DEFAULT true NOT NULL,
    status text DEFAULT 'ACTIVE' NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "ProfileNamespace_bindings_check" CHECK ((((domain IS NULL) AND ("rootPublicKey" IS NULL)) OR ((domain IS NOT NULL) AND ("rootPublicKey" IS NOT NULL)))),
    CONSTRAINT "ProfileNamespace_source_time_check" CHECK ("sourceGeneratedAt" BETWEEN 0 AND 9007199254740991),
    CONSTRAINT "ProfileNamespace_updateFeedId_check" CHECK (("updateFeedId" >= 0)),
    CONSTRAINT "ProfileNamespace_status_check" CHECK ((status IN ('ACTIVE', 'ARCHIVED')))
);


--
-- Name: ProfileNamespaceTombstone; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ProfileNamespaceTombstone" (
    "publisherNamespaceId" integer NOT NULL,
    "profileNamespaceId" integer NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "ProfileNamespaceTombstone_pkey" PRIMARY KEY ("publisherNamespaceId", "profileNamespaceId")
);


--
-- Name: ProfileTombstone; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ProfileTombstone" (
    "publisherNamespaceId" integer NOT NULL,
    "profileNamespaceId" integer NOT NULL,
    account character varying(31) NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "ProfileTombstone_pkey" PRIMARY KEY ("publisherNamespaceId", "profileNamespaceId", account)
);


--
-- Name: RelationshipIntent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."RelationshipIntent" (
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "requestId" bigint,
    "authorAccount" character varying(31) NOT NULL,
    "authorNamespaceId" integer NOT NULL,
    "receiverAccount" character varying(31) NOT NULL,
    "receiverNamespaceId" integer NOT NULL,
    status public."RelationshipIntentStatus" NOT NULL,
    "profileNamespaceId" integer NOT NULL,
    "profileRev" integer DEFAULT 0 NOT NULL,
    "messageEndSeq" integer NOT NULL,
    "tombstoneEndSeq" integer NOT NULL,
    note character varying(255) DEFAULT ''::character varying NOT NULL,
    "statusChangedAt" timestamp(3) with time zone NOT NULL,
    "expiresAt" timestamp(3) with time zone,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "RelationshipIntent_author_namespace_check" CHECK (("authorNamespaceId" >= 0)),
    CONSTRAINT "RelationshipIntent_expiry_check" CHECK (((status = 'REQUESTED'::public."RelationshipIntentStatus") AND ("expiresAt" IS NOT NULL) AND ("expiresAt" > "statusChangedAt") AND ("expiresAt" <= ("statusChangedAt" + '7 days'::interval))) OR ((status IN ('ACCEPTED'::public."RelationshipIntentStatus", 'REVOKED'::public."RelationshipIntentStatus")) AND ("expiresAt" IS NULL))),
    CONSTRAINT "RelationshipIntent_statusChangedAt_check" CHECK ("statusChangedAt" >= '1970-01-01'::timestamptz),
    CONSTRAINT "RelationshipIntent_head_check" CHECK ((("messageEndSeq" >= 0) AND ("tombstoneEndSeq" >= 0))),
    CONSTRAINT "RelationshipIntent_profileNamespaceId_check" CHECK (("profileNamespaceId" >= 0)),
    CONSTRAINT "RelationshipIntent_profileRev_check" CHECK (("profileRev" >= 0)),
    CONSTRAINT "RelationshipIntent_receiver_namespace_check" CHECK (("receiverNamespaceId" >= 0))
);


-- Permanent request history is independent of thread lifetime.
CREATE TABLE public."RelationshipRequest" (
    id bigserial PRIMARY KEY,
    kind varchar(31) NOT NULL,
    "authorAccount" varchar(31) NOT NULL,
    "authorNamespaceId" integer NOT NULL,
    "receiverAccount" varchar(31) NOT NULL,
    "receiverNamespaceId" integer NOT NULL,
    status public."RequestProjectionStatus" NOT NULL,
    "authorProfileNamespaceId" integer NOT NULL,
    "authorProfileRev" integer NOT NULL,
    snapshot jsonb,
    note varchar(255) NOT NULL,
    "requestedAt" timestamptz(3) NOT NULL,
    "expiresAt" timestamptz(3) NOT NULL,
    "createdAt" timestamptz(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamptz(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "RelationshipRequest_kind_check" CHECK (
      (kind = 'FRIEND' AND "authorAccount" NOT LIKE '!%' AND "receiverAccount" NOT LIKE '!%') OR
      (kind = 'GROUP_APPLICATION' AND "authorAccount" NOT LIKE '!%' AND "receiverAccount" LIKE '!%') OR
      (kind = 'GROUP_INVITATION' AND "authorAccount" LIKE '!%' AND "receiverAccount" NOT LIKE '!%')),
    CONSTRAINT "RelationshipRequest_endpoints_check" CHECK (
      "authorAccount" <> '' AND "receiverAccount" <> '' AND
      ("authorAccount" <> "receiverAccount" OR "authorNamespaceId" <> "receiverNamespaceId") AND
      "authorNamespaceId" >= 0 AND "receiverNamespaceId" >= 0 AND
      ("authorNamespaceId" = 0 OR "receiverNamespaceId" = 0)),
    CONSTRAINT "RelationshipRequest_profile_check" CHECK ("authorProfileNamespaceId" >= 0 AND "authorProfileRev" >= 0),
    CONSTRAINT "RelationshipRequest_expiry_check" CHECK ("expiresAt" > "requestedAt"),
    CONSTRAINT "RelationshipRequest_snapshot_check" CHECK (
      ("authorNamespaceId" <> 0 AND snapshot IS NULL) OR
      ("authorNamespaceId" = 0 AND snapshot IS NOT NULL AND COALESCE(
        jsonb_typeof(snapshot) = 'object' AND (snapshot - 'displayName' - 'avatar') = '{}'::jsonb
        AND jsonb_typeof(snapshot->'displayName') = 'string'
        AND char_length(btrim(snapshot->>'displayName')) > 0
        AND char_length(snapshot->>'displayName') <= 31
        AND (snapshot->'avatar' = 'null'::jsonb OR (jsonb_typeof(snapshot->'avatar') = 'string'
          AND char_length(btrim(snapshot->>'avatar')) > 0)), false)))
);
CREATE INDEX "RelationshipRequest_author_page_idx" ON public."RelationshipRequest" ("authorNamespaceId", "authorAccount", "createdAt" DESC, id DESC);
CREATE INDEX "RelationshipRequest_receiver_page_idx" ON public."RelationshipRequest" ("receiverNamespaceId", "receiverAccount", "createdAt" DESC, id DESC);

--
-- Name: RelationshipPair; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."RelationshipPair" (
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    id bigint NOT NULL,
    kind character varying(16) NOT NULL,
    "endpointAType" character varying(8) NOT NULL,
    "endpointAAccount" character varying(31) NOT NULL,
    "endpointBType" character varying(8) NOT NULL,
    "endpointBAccount" character varying(31) NOT NULL,
    "threadId" integer,
    active boolean DEFAULT false NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    established boolean DEFAULT false NOT NULL,
    "endpointANamespaceId" integer DEFAULT 0 NOT NULL,
    "endpointBNamespaceId" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "RelationshipPair_distinct_endpoints_check" CHECK (((("endpointAType")::text <> ("endpointBType")::text) OR (("endpointAAccount")::text <> ("endpointBAccount")::text))),
    CONSTRAINT "RelationshipPair_endpoint_namespace_check" CHECK (("endpointBNamespaceId" >= 0)),
    CONSTRAINT "RelationshipPair_endpoint_type_check" CHECK (((("endpointAType")::text = ANY (ARRAY[('USER'::character varying)::text, ('GROUP'::character varying)::text])) AND (("endpointBType")::text = ANY (ARRAY[('USER'::character varying)::text, ('GROUP'::character varying)::text])) AND ((((kind)::text = 'P2P'::text) AND (("endpointAType")::text = 'USER'::text) AND (("endpointBType")::text = 'USER'::text)) OR (((kind)::text = 'GROUP_MEMBER'::text) AND (("endpointAType")::text <> ("endpointBType")::text))))),
    CONSTRAINT "RelationshipPair_kind_check" CHECK (((kind)::text = ANY (ARRAY[('P2P'::character varying)::text, ('GROUP_MEMBER'::character varying)::text]))),
    CONSTRAINT "RelationshipPair_local_side_check" CHECK (("endpointANamespaceId" = 0))
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
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    domain character varying(63) NOT NULL,
    "namespaceId" integer NOT NULL,
    "keyId" character varying(127) NOT NULL,
    "publicKey" character varying(127) NOT NULL,
    "notBefore" timestamp(3) with time zone NOT NULL,
    "notAfter" timestamp(3) with time zone NOT NULL,
    "authorizationSignature" character varying(127) NOT NULL,
    root character varying(44) DEFAULT ''::character varying NOT NULL
);


--
-- Name: SessionToken; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."SessionToken" (
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
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
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    key character varying(63) NOT NULL,
    value text NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: ThreadAudience; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ThreadAudience" (
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    id bigint NOT NULL,
    "targetNamespaceId" integer DEFAULT 0 NOT NULL,
    "localUserId" integer,
    "threadId" integer NOT NULL,
    "messageAccessAfterSeq" integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "groupMetaVisibleAfter" bigint DEFAULT 0 NOT NULL,
    CONSTRAINT "ThreadAudience_groupMetaVisibleAfter_check" CHECK (("groupMetaVisibleAfter" >= 0)),
    CONSTRAINT "ThreadAudience_messageAccessAfterSeq_check" CHECK (("messageAccessAfterSeq" >= 0)),
    CONSTRAINT "ThreadAudience_target_check" CHECK (((("localUserId" IS NOT NULL) AND ("targetNamespaceId" = 0)) OR (("localUserId" IS NULL) AND ("targetNamespaceId" > 0))))
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
-- Name: TwoFactorBackupCode; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."TwoFactorBackupCode" (
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
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
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "userId" integer NOT NULL,
    key character varying(100) NOT NULL,
    value jsonb NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "UserPreference_revision_check" CHECK ((revision >= 0)),
    CONSTRAINT "UserPreference_value_not_json_null_check" CHECK ((value <> 'null'::jsonb))
);


--
-- Name: WebAuthnCredential; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."WebAuthnCredential" (
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
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
-- Name: FederationIdentityReview id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationIdentityReview" ALTER COLUMN id SET DEFAULT nextval('public."FederationIdentityReview_id_seq"'::regclass);


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
-- Name: LocalFederationRoot id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."LocalFederationRoot" ALTER COLUMN id SET DEFAULT nextval('public."LocalFederationRoot_id_seq"'::regclass);


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
-- Name: ClientStateFeed ClientStateFeed_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientStateFeed"
    ADD CONSTRAINT "ClientStateFeed_pkey" PRIMARY KEY ("userId", "feedId");


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
-- Name: FederationIdentityReview FederationIdentityReview_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationIdentityReview"
    ADD CONSTRAINT "FederationIdentityReview_pkey" PRIMARY KEY (id);


--
-- Name: FederationIdentityConflict FederationIdentityConflict_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationIdentityConflict"
    ADD CONSTRAINT "FederationIdentityConflict_pkey" PRIMARY KEY (id);


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
-- Name: GroupMetaMemberFeed GroupMetaMemberFeed_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GroupMetaMemberFeed"
    ADD CONSTRAINT "GroupMetaMemberFeed_pkey" PRIMARY KEY ("threadId", "feedId");


--
-- Name: GroupMeta GroupMeta_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GroupMeta"
    ADD CONSTRAINT "GroupMeta_pkey" PRIMARY KEY ("threadId");


--
-- Name: IdentityNamespace IdentityNamespace_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."IdentityNamespace"
    ADD CONSTRAINT "IdentityNamespace_pkey" PRIMARY KEY (id);


--
-- Name: LocalFederationRoot LocalFederationRoot_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."LocalFederationRoot"
    ADD CONSTRAINT "LocalFederationRoot_pkey" PRIMARY KEY (id);


--
-- Name: LocalFederationRoot LocalFederationRoot_rootPublicKey_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."LocalFederationRoot"
    ADD CONSTRAINT "LocalFederationRoot_rootPublicKey_key" UNIQUE ("rootPublicKey");


--
-- Name: LocalFederationSigningKey LocalFederationSigningKey_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."LocalFederationSigningKey"
    ADD CONSTRAINT "LocalFederationSigningKey_pkey" PRIMARY KEY ("keyName");


--
-- Name: LocalFederationSigningState LocalFederationSigningState_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."LocalFederationSigningState"
    ADD CONSTRAINT "LocalFederationSigningState_pkey" PRIMARY KEY (id);


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
-- Name: PeerStateFeed PeerStateFeed_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PeerStateFeed"
    ADD CONSTRAINT "PeerStateFeed_pkey" PRIMARY KEY ("namespaceId", account, "eventType", "subjectAccount", "subjectNamespaceId");


--
-- Name: PendingMedia PendingMedia_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PendingMedia"
    ADD CONSTRAINT "PendingMedia_pkey" PRIMARY KEY (id);


--
-- Name: ProfileNamespaceChangeFeedHead ProfileNamespaceChangeFeedHead_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ProfileNamespaceChangeFeedHead"
    ADD CONSTRAINT "ProfileNamespaceChangeFeedHead_pkey" PRIMARY KEY (id);


--
-- Name: ProfileNamespaceChangeFeed ProfileNamespaceChangeFeed_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ProfileNamespaceChangeFeed"
    ADD CONSTRAINT "ProfileNamespaceChangeFeed_pkey" PRIMARY KEY ("publisherNamespaceId", "profileNamespaceId");


--
-- Name: ProfileNamespaceFeed ProfileNamespaceFeed_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ProfileNamespaceFeed"
    ADD CONSTRAINT "ProfileNamespaceFeed_pkey" PRIMARY KEY ("namespaceId");


--
-- Name: ProfileNamespace ProfileNamespace_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ProfileNamespace"
    ADD CONSTRAINT "ProfileNamespace_pkey" PRIMARY KEY ("publisherNamespaceId", "profileNamespaceId");


--
-- Name: Profile Profile_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Profile"
    ADD CONSTRAINT "Profile_pkey" PRIMARY KEY ("publisherNamespaceId", account, "profileNamespaceId", "profileRev");


--
-- Name: RelationshipIntent RelationshipIntent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."RelationshipIntent"
    ADD CONSTRAINT "RelationshipIntent_pkey" PRIMARY KEY ("authorAccount", "authorNamespaceId", "receiverAccount", "receiverNamespaceId");


--
-- Name: RelationshipPair RelationshipPair_endpoints_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."RelationshipPair"
    ADD CONSTRAINT "RelationshipPair_endpoints_key" UNIQUE ("endpointAType", "endpointAAccount", "endpointBType", "endpointBAccount", "endpointBNamespaceId");


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

CREATE INDEX "AdminActionLog_createdAt_idx" ON public."AdminActionLog" USING btree ("createdAt");


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

CREATE UNIQUE INDEX "FederatedMessageTombstone_source_event_key" ON public."FederatedMessageTombstone" USING btree ("publisherNamespaceId", "threadId", "remoteDeletionSeq");


--
-- Name: FederatedMessageTombstone_target_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "FederatedMessageTombstone_target_key" ON public."FederatedMessageTombstone" USING btree ("threadId", "publisherNamespaceId", "messageSeq");


--
-- Name: FederationIdentityReview_one_pending_per_namespace_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "FederationIdentityReview_one_pending_per_namespace_key" ON public."FederationIdentityReview" USING btree ("matchedNamespaceId") WHERE ((status)::text = 'pending'::text);

--
-- Name: FederationIdentityConflict_domain_root_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "FederationIdentityConflict_domain_root_key" ON public."FederationIdentityConflict" USING btree (domain, "rootPublicKey");


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
-- Name: ForwardBundle_publisherNamespace_sourceBundleId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ForwardBundle_publisherNamespace_sourceBundleId_key" ON public."ForwardBundle" USING btree ("publisherNamespaceId", "sourceBundleId");


--
-- Name: ForwardMessage_bundleId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ForwardMessage_bundleId_idx" ON public."ForwardMessage" USING btree ("bundleId");


--
-- Name: GroupMetaMemberFeed_member_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "GroupMetaMemberFeed_announcement_key" ON public."GroupMetaMemberFeed" ("threadId") WHERE operation = 'GROUP_ANNOUNCEMENT';

CREATE UNIQUE INDEX "GroupMetaMemberFeed_member_key" ON public."GroupMetaMemberFeed" USING btree ("threadId", ((body ->> 'account'::text)), ((body -> 'namespaceId'::text))) WHERE (operation <> 'GROUP_ANNOUNCEMENT'::public."GroupMetaMemberOperation");


--
-- Name: IdentityNamespace_lastSuccessAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IdentityNamespace_lastSuccessAt_idx" ON public."IdentityNamespace" USING btree ("lastSuccessAt");


--
-- Name: IdentityNamespace_one_active_per_domain_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IdentityNamespace_one_active_per_domain_key" ON public."IdentityNamespace" USING btree (domain) WHERE ((id > 0) AND (active = true));


--
-- Name: IdentityNamespace_one_epoch_per_root_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IdentityNamespace_one_epoch_per_root_key" ON public."IdentityNamespace" USING btree ("rootPublicKey") WHERE ((id > 0) AND ("retiredAt" IS NULL) AND ("rootPublicKey" IS NOT NULL));


--
-- Name: IdentityNamespace_trustLevel_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IdentityNamespace_trustLevel_idx" ON public."IdentityNamespace" USING btree ("trustLevel");


--
-- Name: LocalFederationRoot_one_claimable_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "LocalFederationRoot_one_claimable_key" ON public."LocalFederationRoot" USING btree (claimable) WHERE (claimable = true);


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

CREATE UNIQUE INDEX "MessageThread_group_address_key" ON public."MessageThread" USING btree ("groupAccount", "authorityNamespaceId");


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

CREATE INDEX "Message_creator_address_idx" ON public."Message" USING btree ("creatorAccount", "profileNamespaceId", "publisherNamespaceId");


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

CREATE INDEX "Message_threadId_seq_payloadDigest_idx" ON public."Message" USING btree ("threadId", seq, "payloadDigest") WHERE ("payloadDigest" IS NOT NULL);


--
-- Name: Message_threadId_seq_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Message_threadId_seq_key" ON public."Message" USING btree ("threadId", seq);


--
-- Name: Message_threadId_source_originSeq_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Message_threadId_source_originSeq_key" ON public."Message" USING btree ("threadId", "publisherNamespaceId", "originSeq");


--
-- Name: PeerStateFeed_namespace_feedId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "PeerStateFeed_namespace_feedId_key" ON public."PeerStateFeed" USING btree ("namespaceId", "feedId");


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
-- Name: ProfileNamespaceChangeFeed_changeId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ProfileNamespaceChangeFeed_changeId_key" ON public."ProfileNamespaceChangeFeed" USING btree ("changeId");


--
-- Name: ProfileNamespaceFeed_feedId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ProfileNamespaceFeed_feedId_key" ON public."ProfileNamespaceFeed" USING btree ("feedId");


--
-- Name: RelationshipPair_endpointA_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "RelationshipPair_endpointA_idx" ON public."RelationshipPair" USING btree ("endpointAType", "endpointAAccount", active);


--
-- Name: RelationshipPair_endpointB_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "RelationshipPair_endpointB_idx" ON public."RelationshipPair" USING btree ("endpointBType", "endpointBAccount", active);


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
-- Name: SessionToken_pushToken_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "SessionToken_pushToken_key" ON public."SessionToken" USING btree ("pushToken") WHERE ("pushToken" IS NOT NULL);


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

CREATE INDEX "ThreadAudience_local_access_idx" ON public."ThreadAudience" USING btree ("localUserId", "threadId") WHERE ("localUserId" IS NOT NULL);


--
-- Name: ThreadAudience_local_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ThreadAudience_local_key" ON public."ThreadAudience" USING btree ("localUserId", "threadId") WHERE ("localUserId" IS NOT NULL);


--
-- Name: ThreadAudience_peer_access_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ThreadAudience_peer_access_idx" ON public."ThreadAudience" USING btree ("targetNamespaceId", "threadId") WHERE ("localUserId" IS NULL);


--
-- Name: ThreadAudience_peer_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ThreadAudience_peer_key" ON public."ThreadAudience" USING btree ("targetNamespaceId", "threadId") WHERE ("localUserId" IS NULL);


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
-- Name: UploadSession_status_updatedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "UploadSession_status_updatedAt_idx" ON public."UploadSession" USING btree (status, "updatedAt");


--
-- Name: UploadSession_uploadId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "UploadSession_uploadId_key" ON public."UploadSession" USING btree ("uploadId");


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
-- Name: RelationshipPair relationship_establishment_before_write; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER relationship_establishment_before_write BEFORE INSERT OR UPDATE ON public."RelationshipPair" FOR EACH ROW EXECUTE FUNCTION public.relationship_establishment_before_write();


--
-- Name: RelationshipPair thread_feed_after_pair; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER thread_feed_after_pair AFTER INSERT OR UPDATE OF active, established, "threadId" ON public."RelationshipPair" FOR EACH ROW EXECUTE FUNCTION public.thread_feed_after_pair();


--
-- Name: AccountThreadState thread_feed_after_participant; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER thread_feed_after_participant AFTER INSERT ON public."AccountThreadState" FOR EACH ROW EXECUTE FUNCTION public.thread_feed_after_participant();


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
-- Request namespace foreign keys are installed after namespace primary keys.
ALTER TABLE ONLY public."RelationshipRequest"
    ADD CONSTRAINT "RelationshipRequest_authorNamespaceId_fkey" FOREIGN KEY ("authorNamespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."RelationshipRequest"
    ADD CONSTRAINT "RelationshipRequest_receiverNamespaceId_fkey" FOREIGN KEY ("receiverNamespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;

-- Name: ClientStateFeed ClientStateFeed_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientStateFeed"
    ADD CONSTRAINT "ClientStateFeed_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."Account"(id) ON DELETE CASCADE;


--
-- Name: DeletedMessage DeletedMessage_publisherNamespaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DeletedMessage"
    ADD CONSTRAINT "DeletedMessage_publisherNamespaceId_fkey" FOREIGN KEY ("publisherNamespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;


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
-- Name: FederatedMessageTombstone FederatedMessageTombstone_publisherNamespaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederatedMessageTombstone"
    ADD CONSTRAINT "FederatedMessageTombstone_publisherNamespaceId_fkey" FOREIGN KEY ("publisherNamespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;


--
-- Name: FederatedMessageTombstone FederatedMessageTombstone_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederatedMessageTombstone"
    ADD CONSTRAINT "FederatedMessageTombstone_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: FederationIdentityReview FederationIdentityReview_matchedNamespace_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationIdentityReview"
    ADD CONSTRAINT "FederationIdentityReview_matchedNamespace_fkey" FOREIGN KEY ("matchedNamespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE CASCADE;


--
-- Name: FederationIdentityConflict FederationIdentityConflict_namespace_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationIdentityConflict"
    ADD CONSTRAINT "FederationIdentityConflict_namespace_fkey" FOREIGN KEY ("namespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE CASCADE;


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
-- Name: FileSyncProgress FileSyncProgress_publisherNamespaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FileSyncProgress"
    ADD CONSTRAINT "FileSyncProgress_publisherNamespaceId_fkey" FOREIGN KEY ("publisherNamespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;


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
-- Name: ForwardBundle ForwardBundle_publisherNamespaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ForwardBundle"
    ADD CONSTRAINT "ForwardBundle_publisherNamespaceId_fkey" FOREIGN KEY ("publisherNamespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;


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
-- Name: LocalFederationSigningKey LocalFederationSigningKey_root_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."LocalFederationSigningKey"
    ADD CONSTRAINT "LocalFederationSigningKey_root_fkey" FOREIGN KEY ("rootId") REFERENCES public."LocalFederationRoot"(id) ON DELETE RESTRICT;


--
-- Name: LocalFederationSigningState LocalFederationSigningState_current_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."LocalFederationSigningState"
    ADD CONSTRAINT "LocalFederationSigningState_current_key_fkey" FOREIGN KEY ("currentKeyName") REFERENCES public."LocalFederationSigningKey"("keyName") ON DELETE RESTRICT;


--
-- Name: LocalFederationSigningState LocalFederationSigningState_successor_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."LocalFederationSigningState"
    ADD CONSTRAINT "LocalFederationSigningState_successor_key_fkey" FOREIGN KEY ("plannedSuccessorKeyName") REFERENCES public."LocalFederationSigningKey"("keyName") ON DELETE SET NULL;


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
-- Name: Message Message_publisherNamespaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Message"
    ADD CONSTRAINT "Message_publisherNamespaceId_fkey" FOREIGN KEY ("publisherNamespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;


--
-- Name: Message Message_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Message"
    ADD CONSTRAINT "Message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: PeerStateFeed PeerStateFeed_namespace_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PeerStateFeed"
    ADD CONSTRAINT "PeerStateFeed_namespace_fkey" FOREIGN KEY ("namespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;


--
-- Name: PendingMedia PendingMedia_messageId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PendingMedia"
    ADD CONSTRAINT "PendingMedia_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES public."Message"(id) ON DELETE CASCADE;


--
-- Name: PendingMedia PendingMedia_publisherNamespaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PendingMedia"
    ADD CONSTRAINT "PendingMedia_publisherNamespaceId_fkey" FOREIGN KEY ("publisherNamespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;


--
-- Name: PendingMedia PendingMedia_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PendingMedia"
    ADD CONSTRAINT "PendingMedia_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: ProfileNamespaceChangeFeed ProfileNamespaceChangeFeed_publisher_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ProfileNamespaceChangeFeed"
    ADD CONSTRAINT "ProfileNamespaceChangeFeed_publisher_fkey" FOREIGN KEY ("publisherNamespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;


--
-- Name: ProfileNamespaceFeed ProfileNamespaceFeed_namespace_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ProfileNamespaceFeed"
    ADD CONSTRAINT "ProfileNamespaceFeed_namespace_fkey" FOREIGN KEY ("namespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;


--
-- Name: ProfileNamespace ProfileNamespace_publisher_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ProfileNamespace"
    ADD CONSTRAINT "ProfileNamespace_publisher_fkey" FOREIGN KEY ("publisherNamespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;


--
-- Name: ProfileNamespaceTombstone ProfileNamespaceTombstone_publisher_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ProfileNamespaceTombstone"
    ADD CONSTRAINT "ProfileNamespaceTombstone_publisher_fkey" FOREIGN KEY ("publisherNamespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;


--
-- Name: ProfileTombstone ProfileTombstone_publisher_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ProfileTombstone"
    ADD CONSTRAINT "ProfileTombstone_publisher_fkey" FOREIGN KEY ("publisherNamespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;


--
-- Name: Profile Profile_publisherNamespaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Profile"
    ADD CONSTRAINT "Profile_publisherNamespaceId_fkey" FOREIGN KEY ("publisherNamespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;


--
-- Name: RelationshipIntent RelationshipIntent_authorNamespaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."RelationshipIntent"
    ADD CONSTRAINT "RelationshipIntent_authorNamespaceId_fkey" FOREIGN KEY ("authorNamespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;


--
-- The nullable reference belongs to the intent, not the permanent request row.
CREATE INDEX "RelationshipIntent_requestId_idx" ON public."RelationshipIntent" ("requestId");

ALTER TABLE ONLY public."RelationshipIntent"
    ADD CONSTRAINT "RelationshipIntent_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES public."RelationshipRequest"(id) ON DELETE SET NULL;

-- Name: RelationshipIntent RelationshipIntent_receiverNamespaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."RelationshipIntent"
    ADD CONSTRAINT "RelationshipIntent_receiverNamespaceId_fkey" FOREIGN KEY ("receiverNamespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;


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
    ADD CONSTRAINT "S2SKeyCache_namespace_fkey" FOREIGN KEY ("namespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;


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
    ADD CONSTRAINT "ThreadAudience_targetNamespace_fkey" FOREIGN KEY ("targetNamespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT;


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
-- Name: WebAuthnCredential WebAuthnCredential_adminId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."WebAuthnCredential"
    ADD CONSTRAINT "WebAuthnCredential_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES public."Admin"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


-- Independent federation feed state and latest received observations.
CREATE TABLE public."FederationFeedState" (
    "namespaceId" integer PRIMARY KEY,
    "lastHandshakeAt" timestamp(3) with time zone,
    "latestHealthCheck" jsonb,
    "outboundStateFeedEndId" bigint DEFAULT 0 NOT NULL,
    "inboundStateFeedPulledThrough" bigint,
    "inboundProfileNamespaceFeedPulledThrough" bigint DEFAULT 0 NOT NULL,
    "stateFeedSourceGeneratedAt" bigint DEFAULT 0 NOT NULL,
    "profileNamespaceFeedSourceGeneratedAt" bigint DEFAULT 0 NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "FederationFeedState_namespace_fkey" FOREIGN KEY ("namespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT,
    CONSTRAINT "FederationFeedState_namespace_check" CHECK ("namespaceId" > 0),
    CONSTRAINT "FederationFeedState_source_times_check" CHECK (
        "stateFeedSourceGeneratedAt" BETWEEN 0 AND 9007199254740991
        AND "profileNamespaceFeedSourceGeneratedAt" BETWEEN 0 AND 9007199254740991
    ),
    CONSTRAINT "FederationFeedState_coordinates_check" CHECK (
        "outboundStateFeedEndId" >= 0
        AND ("inboundStateFeedPulledThrough" IS NULL OR "inboundStateFeedPulledThrough" >= 0)
        AND "inboundProfileNamespaceFeedPulledThrough" >= 0
    )
);

CREATE TABLE public."ProfileNamespaceFeedHead" (
    id integer PRIMARY KEY,
    "endId" bigint DEFAULT 0 NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "ProfileNamespaceFeedHead_shape_check" CHECK (id = 0 AND "endId" >= 0)
);

CREATE TABLE public."FederationFeedHeadReceipt" (
    "namespaceId" integer PRIMARY KEY,
    "stateFeedEndId" text NOT NULL,
    "profileNamespaceFeedEndId" text NOT NULL,
    "generatedAt" bigint NOT NULL,
    "sentAt" bigint NOT NULL,
    "receivedAt" timestamp(3) with time zone NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "FederationFeedHeadReceipt_namespace_fkey"
        FOREIGN KEY ("namespaceId") REFERENCES public."IdentityNamespace"(id) ON DELETE RESTRICT,
    CONSTRAINT "FederationFeedHeadReceipt_namespace_check" CHECK ("namespaceId" > 0),
    CONSTRAINT "FederationFeedHeadReceipt_heads_check" CHECK (
        "stateFeedEndId" ~ '^(0|[1-9][0-9]*)$'
        AND "profileNamespaceFeedEndId" ~ '^(0|[1-9][0-9]*)$'
    ),
    CONSTRAINT "FederationFeedHeadReceipt_times_check" CHECK (
        "generatedAt" BETWEEN 0 AND 9007199254740991
        AND "sentAt" BETWEEN 0 AND 9007199254740991
    )
);

-- Every new remote identity starts with independent feed coordinates. Identity
-- rebinding within an existing namespace preserves its publication and progress.
CREATE FUNCTION public.initialize_federation_feed_state() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id > 0 THEN
        INSERT INTO public."FederationFeedState" ("namespaceId") VALUES (NEW.id);
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER "IdentityNamespace_initialize_feed_state"
AFTER INSERT ON public."IdentityNamespace"
FOR EACH ROW EXECUTE FUNCTION public.initialize_federation_feed_state();

CREATE TABLE public."FederationQuotaPolicy" (
    "maxFileBytes" bigint,
    CONSTRAINT "FederationQuotaPolicy_maxFileBytes_check" CHECK ("maxFileBytes" IS NULL OR "maxFileBytes" BETWEEN 0 AND 9007199254740991),
    "nsid" integer NOT NULL,
    "dailyMsgLimit" integer,
    "dailyRequestLimit" integer,
    "dailySignalLimit" integer,
    "dailyFileLimit" integer,
    "dailyFileBytesLimit" bigint,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "FederationQuotaPolicy_pkey" PRIMARY KEY ("nsid"),
    CONSTRAINT "FederationQuotaPolicy_nsid_fkey" FOREIGN KEY ("nsid") REFERENCES public."IdentityNamespace"(id) ON DELETE CASCADE,
    CONSTRAINT "FederationQuotaPolicy_limits_check" CHECK (
      ("dailyMsgLimit" IS NULL OR "dailyMsgLimit" >= 0) AND
      ("dailyRequestLimit" IS NULL OR "dailyRequestLimit" >= 0) AND
      ("dailySignalLimit" IS NULL OR "dailySignalLimit" >= 0) AND
      ("dailyFileLimit" IS NULL OR "dailyFileLimit" >= 0) AND
      ("dailyFileBytesLimit" IS NULL OR "dailyFileBytesLimit" BETWEEN 0 AND 9007199254740991)
    )
);

CREATE TABLE public."UserQuotaPolicy" (
    "maxFileBytes" bigint,
    CONSTRAINT "UserQuotaPolicy_maxFileBytes_check" CHECK ("maxFileBytes" IS NULL OR "maxFileBytes" BETWEEN 0 AND 9007199254740991),
    "account" character varying(31) NOT NULL,
    "dailyMsgLimit" integer,
    "dailyRequestLimit" integer,
    "dailySignalLimit" integer,
    "dailyFileLimit" integer,
    "dailyFileBytesLimit" bigint,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "UserQuotaPolicy_pkey" PRIMARY KEY ("account"),
    CONSTRAINT "UserQuotaPolicy_account_fkey" FOREIGN KEY ("account") REFERENCES public."Account"(account) ON DELETE CASCADE,
    CONSTRAINT "UserQuotaPolicy_limits_check" CHECK (
      ("dailyMsgLimit" IS NULL OR "dailyMsgLimit" >= 0) AND
      ("dailyRequestLimit" IS NULL OR "dailyRequestLimit" >= 0) AND
      ("dailySignalLimit" IS NULL OR "dailySignalLimit" >= 0) AND
      ("dailyFileLimit" IS NULL OR "dailyFileLimit" >= 0) AND
      ("dailyFileBytesLimit" IS NULL OR "dailyFileBytesLimit" BETWEEN 0 AND 9007199254740991)
    )
);

--
-- PostgreSQL database dump complete
--


-- Required local identities and feed head sentinels.
-- Namespace 0 is initialized with SOMS_DOMAIN by KeypairService on first boot.
-- The system account is initialized with SOMS_DOMAIN by systemAccountIdInTx.

INSERT INTO public."ProfileNamespaceFeedHead" (id, "endId") VALUES (0, 0);
INSERT INTO public."ProfileNamespaceChangeFeedHead" ("id", "endId") VALUES (0, 0);
