-- Greenfield schema baseline, consolidated on 2026-08-29.
-- Keep this file in sync with src/database/schema.ts.

--
-- PostgreSQL database dump
--

-- Dumped from database version 18.4 (Debian 18.4-1.pgdg13+1)
-- Dumped by pg_dump version 18.4 (Debian 18.4-1.pgdg13+1)

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
    'CALL',
    'FORWARD',
    'GALLERY',
    'SYSTEM'
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
    'UPSERT',
    'DEPART'
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
-- Name: MessageReportStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."MessageReportStatus" AS ENUM (
    'PENDING',
    'UPHELD',
    'REJECTED'
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
    'PROFILE',
    'RELATIONSHIP_INTENT',
    'GROUP_META_FEED_HEAD',
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
-- Name: UploadSessionStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."UploadSessionStatus" AS ENUM (
    'UPLOADING',
    'COMPLETING',
    'COMPLETED',
    'ABORTED'
);


--
-- Name: soms_notify_federation_message_committed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.soms_notify_federation_message_committed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW."contentType" <> 'SYSTEM' THEN
    PERFORM pg_notify(
      'soms_federation_message_committed',
      json_build_object('threadId', NEW."threadId", 'seq', NEW.seq)::text
    );
  END IF;
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: Account; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Account" (
    id integer NOT NULL,
    "hashPwd" character varying(127),
    "mustChangePassword" boolean DEFAULT false NOT NULL,
    "disabledAt" timestamp(3) with time zone,
    "stateFeedAllocatedThrough" integer DEFAULT 0 NOT NULL,
    "readRevision" integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


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
    success boolean DEFAULT true NOT NULL,
    "errorMessage" character varying(255),
    meta jsonb,
    at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
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
-- Name: CallTombstone; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."CallTombstone" (
    "peerDomain" character varying(253) NOT NULL,
    "callSid" character varying(36) NOT NULL,
    "terminalOp" character varying(16) NOT NULL,
    "endReason" character varying(16),
    "initialCallType" character varying(8) NOT NULL,
    "finalCallType" character varying(8) NOT NULL,
    "signalIds" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ClientGroupMetaFeedTarget; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ClientGroupMetaFeedTarget" (
    "accountId" integer NOT NULL,
    "groupId" integer NOT NULL,
    "allocatedThrough" bigint DEFAULT 0 NOT NULL,
    "oldestAvailableAfter" bigint DEFAULT 0 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "ClientGroupMetaFeedTarget_allocatedThrough_check" CHECK (("allocatedThrough" >= 0)),
    CONSTRAINT "ClientGroupMetaFeedTarget_oldestAvailableAfter_check" CHECK ((("oldestAvailableAfter" >= 0) AND ("oldestAvailableAfter" <= "allocatedThrough")))
);


--
-- Name: ClientGroupMetaMemberFeed; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ClientGroupMetaMemberFeed" (
    "accountId" integer NOT NULL,
    "groupId" integer NOT NULL,
    "feedId" bigint NOT NULL,
    "memberAccount" character varying(31) NOT NULL,
    "memberDomain" character varying(63) NOT NULL,
    operation public."GroupMetaMemberOperation" NOT NULL,
    body jsonb NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "ClientGroupMetaMemberFeed_body_check" CHECK ((((operation = 'UPSERT'::public."GroupMetaMemberOperation") AND (body <> '{}'::jsonb)) OR ((operation = 'DEPART'::public."GroupMetaMemberOperation") AND (body = '{}'::jsonb)))),
    CONSTRAINT "ClientGroupMetaMemberFeed_feedId_check" CHECK (("feedId" > 0))
);


--
-- Name: ClientMessageFeed; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ClientMessageFeed" (
    "userId" integer NOT NULL,
    "threadId" integer NOT NULL,
    "feedId" integer NOT NULL,
    "messageEndSeq" integer NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "ClientMessageFeed_feedId_check" CHECK (("feedId" > 0)),
    CONSTRAINT "ClientMessageFeed_messageEndSeq_check" CHECK (("messageEndSeq" > 0))
);


--
-- Name: ClientMessageFeedTarget; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ClientMessageFeedTarget" (
    "userId" integer NOT NULL,
    "messageAllocatedThrough" integer DEFAULT 0 NOT NULL,
    "tombstoneAllocatedThrough" integer DEFAULT 0 NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "ClientMessageFeedTarget_messageAllocatedThrough_check" CHECK (("messageAllocatedThrough" >= 0)),
    CONSTRAINT "ClientMessageFeedTarget_tombstoneAllocatedThrough_check" CHECK (("tombstoneAllocatedThrough" >= 0))
);


--
-- Name: ClientMessageTombstoneFeed; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ClientMessageTombstoneFeed" (
    "userId" integer NOT NULL,
    "threadId" integer NOT NULL,
    "feedId" integer NOT NULL,
    "tombstoneEndSeq" integer NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "ClientMessageTombstoneFeed_feedId_check" CHECK (("feedId" > 0)),
    CONSTRAINT "ClientMessageTombstoneFeed_tombstoneEndSeq_check" CHECK (("tombstoneEndSeq" > 0))
);


--
-- Name: ClientStateFeed; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ClientStateFeed" (
    "userId" integer NOT NULL,
    account character varying(31) NOT NULL,
    domain character varying(63) NOT NULL,
    "eventType" character varying(31) NOT NULL,
    "subjectAccount" character varying(31) DEFAULT ''::character varying NOT NULL,
    "subjectDomain" character varying(63) DEFAULT 'local'::character varying NOT NULL,
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
    "messageSeq" integer CONSTRAINT "DeletedMessage_seq_not_null" NOT NULL,
    type public."MessageDeleteType" NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "federationSourceDomain" character varying(63),
    "deletionSeq" integer NOT NULL,
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
-- Name: FederatedFriendRequest; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FederatedFriendRequest" (
    "localUserId" integer NOT NULL,
    "remoteAccount" character varying(31) NOT NULL,
    "remoteDomain" character varying(63) NOT NULL,
    direction character varying(16) NOT NULL,
    status character varying(16) NOT NULL,
    note character varying(255) DEFAULT ''::character varying NOT NULL,
    "requestedAt" timestamp(3) with time zone,
    "expiresAt" timestamp(3) with time zone,
    "displayName" character varying(30),
    avatar text,
    "profileRevision" integer,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "FederatedFriendRequest_direction_check" CHECK (((direction)::text = ANY (ARRAY[('INCOMING'::character varying)::text, ('OUTGOING'::character varying)::text]))),
    CONSTRAINT "FederatedFriendRequest_expiry_check" CHECK (((((status)::text = 'REQUESTED'::text) AND ("requestedAt" IS NOT NULL) AND ("expiresAt" IS NOT NULL) AND ("expiresAt" > "requestedAt") AND ("expiresAt" <= ("requestedAt" + '7 days'::interval))) OR (((status)::text = 'ACCEPTED'::text) AND ("requestedAt" IS NOT NULL) AND ("expiresAt" IS NULL)) OR (((status)::text = 'REVOKED'::text) AND ("expiresAt" IS NULL)))),
    CONSTRAINT "FederatedFriendRequest_profileRevision_check" CHECK ((("profileRevision" IS NULL) OR ("profileRevision" >= 0))),
    CONSTRAINT "FederatedFriendRequest_status_check" CHECK (((status)::text = ANY (ARRAY[('REQUESTED'::character varying)::text, ('ACCEPTED'::character varying)::text, ('REVOKED'::character varying)::text])))
);


--
-- Name: FederatedMessageTombstone; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FederatedMessageTombstone" (
    id bigint NOT NULL,
    "threadId" integer NOT NULL,
    "messageSeq" integer NOT NULL,
    "authorityDomain" character varying(255) NOT NULL,
    "sourceDomain" character varying(255) NOT NULL,
    "remoteDeletionSeq" integer CONSTRAINT "FederatedMessageTombstone_remoteDeletedId_not_null" NOT NULL,
    type public."MessageDeleteType" NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "authorityDeletedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
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
    "trustLevel" character varying(31) DEFAULT 'unrecognized'::character varying NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "trustedAt" timestamp(3) with time zone,
    "lastSuccessAt" timestamp(3) with time zone,
    "degradedAt" timestamp(3) with time zone,
    "degradationReason" character varying(255),
    "degradationCount" integer DEFAULT 0 NOT NULL,
    "dailyMsgLimit" integer,
    "dailyRequestLimit" integer,
    "rootKeyFingerprint" character varying(80),
    "identityPinnedAt" timestamp(3) with time zone,
    "resetGeneration" integer DEFAULT 0 NOT NULL,
    "resetAt" timestamp(3) with time zone,
    "dailyFileLimit" integer,
    "dailyFileBytesLimit" bigint,
    "rootPublicKey" character varying(44),
    "recognizesPeer" boolean DEFAULT false NOT NULL,
    "outboundRecognitionConfirmed" boolean DEFAULT false NOT NULL,
    "inboundRecognitionConfirmed" boolean DEFAULT false NOT NULL,
    "lightweightInboundReady" boolean DEFAULT false NOT NULL,
    "localServiceAvailable" boolean DEFAULT false NOT NULL,
    "remoteServiceReachable" boolean DEFAULT false NOT NULL,
    "reverseRecognitionPending" boolean DEFAULT false NOT NULL,
    "outboundRecognizedAt" timestamp(3) with time zone,
    "inboundRecognizedAt" timestamp(3) with time zone,
    "haltedAt" timestamp(3) with time zone,
    "haltCode" integer,
    "haltReason" character varying(255),
    "resetInProgress" boolean DEFAULT false NOT NULL,
    CONSTRAINT "FederatedPeer_trustLevel_check" CHECK ((("trustLevel")::text = ANY (ARRAY[('unrecognized'::character varying)::text, ('establishing'::character varying)::text, ('available'::character varying)::text, ('degraded'::character varying)::text, ('halted'::character varying)::text])))
);


--
-- Name: COLUMN "FederatedPeer"."trustLevel"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public."FederatedPeer"."trustLevel" IS 'Federation trust state, including the reset_in_progress maintenance state.';


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
-- Name: FederatedPeerReset; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FederatedPeerReset" (
    domain character varying(63) NOT NULL,
    "resetGeneration" integer NOT NULL,
    "reinitPending" boolean DEFAULT false NOT NULL,
    "resetAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "FederatedPeerReset_resetGeneration_check" CHECK (("resetGeneration" > 0))
);


--
-- Name: TABLE "FederatedPeerReset"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public."FederatedPeerReset" IS 'Persistent tombstone preventing a reset federation domain from inheriting its former identity or authorization.';


--
-- Name: FederationDeletedCursor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FederationDeletedCursor" (
    id bigint NOT NULL,
    "threadId" integer NOT NULL,
    "peerDomain" character varying(255) NOT NULL,
    "streamAccount" character varying(255) DEFAULT ''::character varying NOT NULL,
    "streamKind" character varying(32) NOT NULL,
    "committedThrough" integer DEFAULT 0 CONSTRAINT "FederationDeletedCursor_deletedHwm_not_null" NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "FederationDeletedCursor_committedThrough_check" CHECK (("committedThrough" >= 0))
);


--
-- Name: FederationDeletedCursor_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."FederationDeletedCursor_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: FederationDeletedCursor_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."FederationDeletedCursor_id_seq" OWNED BY public."FederationDeletedCursor".id;


--
-- Name: FederationMessageReceipt; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FederationMessageReceipt" (
    "peerDomain" character varying(63) NOT NULL,
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
    CONSTRAINT "FederationThreadHistoryGap_interval_check" CHECK ((("startSeq" > 0) AND ("endSeq" >= "startSeq")))
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
    "peerDomain" character varying(63) NOT NULL,
    "messageTargetSeq" integer DEFAULT 0 NOT NULL,
    "deletionTargetSeq" integer DEFAULT 0 NOT NULL,
    "messageProcessedThroughSeq" integer DEFAULT 0 NOT NULL,
    "deletionProcessedThroughSeq" integer DEFAULT 0 NOT NULL,
    "historyBoundaryReached" boolean DEFAULT false NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "authorizationEpoch" integer DEFAULT 0 NOT NULL,
    "activeGapId" bigint,
    CONSTRAINT "FederationThreadSyncState_history_check" CHECK ((NOT ("historyBoundaryReached" AND ("activeGapId" IS NOT NULL)))),
    CONSTRAINT "FederationThreadSyncState_messageSeqs_check" CHECK ((("messageTargetSeq" >= 0) AND ("deletionTargetSeq" >= 0) AND ("messageProcessedThroughSeq" >= 0) AND ("deletionProcessedThroughSeq" >= 0) AND ("messageProcessedThroughSeq" <= "messageTargetSeq") AND ("deletionProcessedThroughSeq" <= "deletionTargetSeq") AND ("authorizationEpoch" >= 0)))
);


--
-- Name: FileSyncProgress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FileSyncProgress" (
    id bigint NOT NULL,
    "batchId" uuid NOT NULL,
    digest character varying(64) NOT NULL,
    direction public."FileSyncDirection" NOT NULL,
    kind public."FileSyncKind" NOT NULL,
    status public."FileSyncStatus" DEFAULT 'PENDING'::public."FileSyncStatus" NOT NULL,
    "bytesTotal" bigint DEFAULT 0 NOT NULL,
    "bytesReceived" bigint DEFAULT 0 NOT NULL,
    "originDomain" character varying(63),
    "errorKind" character varying(255),
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    payload jsonb,
    "quotaCounted" boolean DEFAULT false NOT NULL,
    "partId" uuid,
    "position" integer,
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
-- Name: Group; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Group" (
    id integer NOT NULL,
    account character varying(31) NOT NULL,
    domain character varying(63) DEFAULT 'local'::character varying NOT NULL,
    name character varying(30) NOT NULL,
    avatar text DEFAULT ''::text NOT NULL,
    description character varying(255) DEFAULT ''::character varying NOT NULL,
    "profileRev" integer DEFAULT 0 NOT NULL,
    "remoteGroupMetaFeedId" bigint,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "dissolvedAt" timestamp(3) with time zone,
    "federationAuthorized" boolean DEFAULT false NOT NULL,
    CONSTRAINT "Group_account_sigil_check" CHECK (((account)::text ~~ '!%'::text)),
    CONSTRAINT "Group_local_federationAuthorized_check" CHECK ((((domain)::text <> 'local'::text) OR ("federationAuthorized" = false))),
    CONSTRAINT "Group_profileRev_check" CHECK (("profileRev" >= 0))
);


--
-- Name: GroupAuditLog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."GroupAuditLog" (
    id bigint NOT NULL,
    "eventKey" character varying(191) NOT NULL,
    "groupId" integer,
    "groupAccount" character varying(31) NOT NULL,
    "groupDomain" character varying(63) NOT NULL,
    "actorType" character varying(24) NOT NULL,
    "actorUserId" integer,
    "actorAccount" character varying(31) NOT NULL,
    "actorDomain" character varying(63) NOT NULL,
    action character varying(64) NOT NULL,
    "targetType" character varying(32),
    "targetId" character varying(191),
    success boolean DEFAULT true NOT NULL,
    "errorMessage" character varying(255),
    meta jsonb,
    at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: GroupAuditLog_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."GroupAuditLog_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: GroupAuditLog_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."GroupAuditLog_id_seq" OWNED BY public."GroupAuditLog".id;


--
-- Name: GroupMetaFeedTarget; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."GroupMetaFeedTarget" (
    "targetPeerDomain" character varying(63) NOT NULL,
    "groupId" integer NOT NULL,
    "allocatedThrough" bigint DEFAULT 0 NOT NULL,
    "oldestAvailableAfter" bigint DEFAULT 0 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "GroupMetaFeedTarget_allocatedThrough_check" CHECK (("allocatedThrough" >= 0)),
    CONSTRAINT "GroupMetaFeedTarget_oldestAvailableAfter_check" CHECK ((("oldestAvailableAfter" >= 0) AND ("oldestAvailableAfter" <= "allocatedThrough")))
);


--
-- Name: GroupMetaMemberFeed; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."GroupMetaMemberFeed" (
    "targetPeerDomain" character varying(63) NOT NULL,
    "groupId" integer NOT NULL,
    "feedId" bigint NOT NULL,
    "memberAccount" character varying(31) NOT NULL,
    "memberDomain" character varying(63) NOT NULL,
    operation public."GroupMetaMemberOperation" NOT NULL,
    body jsonb NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "GroupMetaMemberFeed_body_check" CHECK ((body <> '{}'::jsonb)),
    CONSTRAINT "GroupMetaMemberFeed_feedId_check" CHECK (("feedId" > 0))
);


--
-- Name: GroupRequestProjection; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."GroupRequestProjection" (
    "managerUserId" integer CONSTRAINT "GroupJoinRequestProjection_managerUserId_not_null" NOT NULL,
    "threadId" integer CONSTRAINT "GroupJoinRequestProjection_threadId_not_null" NOT NULL,
    "memberUserId" integer CONSTRAINT "GroupJoinRequestProjection_applicantUserId_not_null" NOT NULL,
    "feedId" integer CONSTRAINT "GroupJoinRequestProjection_feedId_not_null" NOT NULL,
    "requestId" bigint CONSTRAINT "GroupJoinRequestProjection_requestId_not_null" NOT NULL,
    status character varying(15) CONSTRAINT "GroupJoinRequestProjection_status_not_null" NOT NULL,
    note character varying(255) DEFAULT ''::character varying CONSTRAINT "GroupJoinRequestProjection_note_not_null" NOT NULL,
    "requestedAt" timestamp(3) with time zone CONSTRAINT "GroupJoinRequestProjection_requestedAt_not_null" NOT NULL,
    "expiresAt" timestamp(3) with time zone CONSTRAINT "GroupJoinRequestProjection_expiresAt_not_null" NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP CONSTRAINT "GroupJoinRequestProjection_createdAt_not_null" NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP CONSTRAINT "GroupJoinRequestProjection_updatedAt_not_null" NOT NULL,
    direction character varying(15) NOT NULL,
    CONSTRAINT "GroupRequestProjection_direction_check" CHECK (((direction)::text = ANY ((ARRAY['APPLICATION'::character varying, 'INVITATION'::character varying])::text[]))),
    CONSTRAINT "GroupRequestProjection_feedId_check" CHECK (("feedId" > 0)),
    CONSTRAINT "GroupRequestProjection_retention_check" CHECK ((("expiresAt" > "requestedAt") AND ("expiresAt" <= ("requestedAt" + '7 days'::interval)))),
    CONSTRAINT "GroupRequestProjection_status_check" CHECK (((status)::text = ANY (ARRAY[('REQUESTED'::character varying)::text, ('ACCEPTED'::character varying)::text, ('REVOKED'::character varying)::text])))
);


--
-- Name: Group_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."Group_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: Group_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."Group_id_seq" OWNED BY public."Group".id;


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
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "isDeleted" boolean DEFAULT false NOT NULL
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
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone NOT NULL,
    "isDeleted" boolean DEFAULT false NOT NULL,
    "clientMessageId" character varying(36),
    "originSeq" integer,
    "originServerTime" timestamp(3) with time zone,
    "federationSourceDomain" character varying(255),
    "creatorAccount" character varying(31),
    "creatorDomain" character varying(63),
    "localState" public."MessageLocalState" DEFAULT 'READY'::public."MessageLocalState" NOT NULL,
    CONSTRAINT "Message_origin_seq_check" CHECK ((("originSeq" IS NULL) OR ("originSeq" > 0))),
    CONSTRAINT "Message_seq_check" CHECK ((seq > 0)),
    CONSTRAINT "Message_system_creator_check" CHECK (((("contentType" = 'SYSTEM'::public."ContentType") AND ("creatorAccount" IS NULL) AND ("creatorDomain" IS NULL)) OR (("contentType" <> 'SYSTEM'::public."ContentType") AND ("creatorAccount" IS NOT NULL) AND ("creatorDomain" IS NOT NULL))))
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
    id bigint NOT NULL,
    "messageId" bigint NOT NULL,
    "threadId" integer NOT NULL,
    "messageSeq" integer NOT NULL,
    "reporterId" integer NOT NULL,
    status public."MessageReportStatus" DEFAULT 'PENDING'::public."MessageReportStatus" NOT NULL,
    "reviewedByAdminId" integer,
    "reviewedAt" timestamp(3) with time zone,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: MessageReport_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."MessageReport_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: MessageReport_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."MessageReport_id_seq" OWNED BY public."MessageReport".id;


--
-- Name: MessageThread; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."MessageThread" (
    id integer NOT NULL,
    type public."MessageThreadType" NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone NOT NULL,
    "curSeq" integer DEFAULT 0 NOT NULL,
    "lastMessageSeq" integer,
    "lastMessagePreview" character varying(255),
    "lastMessageAt" timestamp(3) with time zone,
    "pullUntil" integer DEFAULT 0 NOT NULL,
    "federationTruncated" boolean DEFAULT false NOT NULL,
    "federationVersion" integer DEFAULT 0 NOT NULL,
    "groupId" integer,
    "deletionSeqAllocatedThrough" integer DEFAULT 0 NOT NULL,
    "authorizationEpoch" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "MessageThread_authorizationEpoch_check" CHECK (("authorizationEpoch" >= 0)),
    CONSTRAINT "MessageThread_deletionSeqAllocatedThrough_check" CHECK (("deletionSeqAllocatedThrough" >= 0)),
    CONSTRAINT "MessageThread_federationVersion_check" CHECK (("federationVersion" >= 0)),
    CONSTRAINT "MessageThread_groupId_type_check" CHECK (("federationTruncated" OR ((type = 'P2P'::public."MessageThreadType") = ("groupId" IS NULL))))
);


--
-- Name: COLUMN "MessageThread"."federationTruncated"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public."MessageThread"."federationTruncated" IS 'True after federation reset has removed the thread contents while retaining its identity shell.';


--
-- Name: COLUMN "MessageThread"."federationVersion"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public."MessageThread"."federationVersion" IS 'Incremented when federation truncation completes; stale asynchronous responses must not write across versions.';


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
    account character varying(31) NOT NULL,
    "eventType" public."PeerStateEventType" NOT NULL,
    "subjectAccount" character varying(31) DEFAULT ''::character varying NOT NULL,
    "feedId" bigint CONSTRAINT "PeerStateFeed_rev_not_null" NOT NULL,
    body jsonb NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    domain character varying(63) NOT NULL,
    "subjectDomain" character varying(63) DEFAULT 'local'::character varying NOT NULL,
    CONSTRAINT "PeerStateFeed_feedId_check" CHECK (("feedId" > 0)),
    CONSTRAINT "PeerStateFeed_subject_check" CHECK (((("eventType" = 'RELATIONSHIP_INTENT'::public."PeerStateEventType") AND (("subjectAccount")::text <> ''::text) AND (("subjectDomain")::text <> ''::text)) OR (("eventType" = 'THREAD_CONTENT_HEAD'::public."PeerStateEventType") AND ((((account)::text ~~ '!%'::text) AND (("subjectAccount")::text = ''::text) AND (("subjectDomain")::text = 'local'::text)) OR (((account)::text !~~ '!%'::text) AND (("subjectAccount")::text <> ''::text) AND (("subjectDomain")::text = ("peerDomain")::text)))) OR (("eventType" <> ALL (ARRAY['RELATIONSHIP_INTENT'::public."PeerStateEventType", 'THREAD_CONTENT_HEAD'::public."PeerStateEventType"])) AND (("subjectAccount")::text = ''::text) AND (("subjectDomain")::text = 'local'::text))))
);


--
-- Name: PeerStateFeedPullCursor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."PeerStateFeedPullCursor" (
    "peerDomain" character varying(63) NOT NULL,
    "committedThrough" bigint DEFAULT 0 NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    initialized boolean DEFAULT false NOT NULL,
    CONSTRAINT "PeerStateFeedPullCursor_committedThrough_check" CHECK (("committedThrough" >= 0))
);


--
-- Name: PeerStateFeedTarget; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."PeerStateFeedTarget" (
    "peerDomain" character varying(63) NOT NULL,
    "allocatedThrough" bigint DEFAULT 0 NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "PeerStateFeedTarget_allocatedThrough_check" CHECK (("allocatedThrough" >= 0))
);


--
-- Name: PendingMedia; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."PendingMedia" (
    id bigint NOT NULL,
    "threadId" integer,
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
    "dependsOnOriginSeq" integer,
    "creatorAccount" character varying(31),
    "creatorDomain" character varying(63),
    "messageId" bigint,
    "expectedAuthorizationEpoch" integer,
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
-- Name: PushToken; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."PushToken" (
    id integer NOT NULL,
    "userId" integer NOT NULL,
    token character varying(500) NOT NULL,
    "deviceId" character varying(127),
    platform public."PushPlatform" NOT NULL,
    "webP256dh" character varying(255),
    "webAuth" character varying(255),
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone NOT NULL,
    "lastSeenAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: PushToken_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."PushToken_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: PushToken_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."PushToken_id_seq" OWNED BY public."PushToken".id;


--
-- Name: QuotaDailyAllowance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."QuotaDailyAllowance" (
    domain character varying(63) NOT NULL,
    date date NOT NULL,
    "extraMsg" integer DEFAULT 0 NOT NULL,
    "extraFile" integer DEFAULT 0 NOT NULL,
    "extraFileBytes" bigint DEFAULT 0 NOT NULL
);


--
-- Name: QuotaDailyUsage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."QuotaDailyUsage" (
    domain character varying(63) NOT NULL,
    date date NOT NULL,
    category character varying(15) NOT NULL,
    count integer DEFAULT 0 NOT NULL
);


--
-- Name: QuotaFileByteUsage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."QuotaFileByteUsage" (
    domain character varying(63) NOT NULL,
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
    CONSTRAINT "RelationshipIntent_authorSide_check" CHECK ((("authorSide")::text = ANY ((ARRAY['A'::character varying, 'B'::character varying])::text[]))),
    CONSTRAINT "RelationshipIntent_expiry_check" CHECK ((((status = 'REQUESTED'::public."RelationshipIntentStatus") AND ("requestedAt" IS NOT NULL) AND ("expiresAt" IS NOT NULL) AND ("expiresAt" > "requestedAt") AND ("expiresAt" <= ("requestedAt" + '7 days'::interval))) OR ((status = 'ACCEPTED'::public."RelationshipIntentStatus") AND ("requestedAt" IS NOT NULL) AND ("expiresAt" IS NULL)) OR ((status = 'REVOKED'::public."RelationshipIntentStatus") AND ("expiresAt" IS NULL))))
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
    "endpointBType" character varying(8) NOT NULL,
    "endpointBAccount" character varying(31) NOT NULL,
    "endpointBDomain" character varying(63) NOT NULL,
    "threadId" integer,
    active boolean DEFAULT false NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "RelationshipPair_distinct_endpoints_check" CHECK (((("endpointAType")::text <> ("endpointBType")::text) OR (("endpointAAccount")::text <> ("endpointBAccount")::text) OR (("endpointADomain")::text <> ("endpointBDomain")::text))),
    CONSTRAINT "RelationshipPair_endpoint_type_check" CHECK (((("endpointAType")::text = ANY ((ARRAY['USER'::character varying, 'GROUP'::character varying])::text[])) AND (("endpointBType")::text = ANY ((ARRAY['USER'::character varying, 'GROUP'::character varying])::text[])) AND ((((kind)::text = 'P2P'::text) AND (("endpointAType")::text = 'USER'::text) AND (("endpointBType")::text = 'USER'::text)) OR (((kind)::text = 'GROUP_MEMBER'::text) AND (("endpointAType")::text <> ("endpointBType")::text))))),
    CONSTRAINT "RelationshipPair_kind_check" CHECK (((kind)::text = ANY ((ARRAY['P2P'::character varying, 'GROUP_MEMBER'::character varying])::text[]))),
    CONSTRAINT "RelationshipPair_revision_check" CHECK ((revision >= 0))
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
    "keyId" character varying(127) NOT NULL,
    "publicKey" character varying(127) NOT NULL,
    "fetchedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "notBefore" timestamp(3) with time zone NOT NULL,
    "notAfter" timestamp(3) with time zone NOT NULL,
    "authorizationSignature" character varying(127) NOT NULL
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
    CONSTRAINT "SessionToken_auto_terminate_days_check" CHECK (("autoTerminateDays" = ANY (ARRAY[7, 30, 90, 180, 365])))
);


--
-- Name: SessionToken_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."SessionToken_id_seq"
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
    "localUserId" integer,
    "threadId" integer NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "messageAccessAfterSeq" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "ThreadAudience_messageAccessAfterSeq_check" CHECK (("messageAccessAfterSeq" >= 0)),
    CONSTRAINT "ThreadAudience_target_check" CHECK ((((("targetDomain")::text = 'local'::text) AND ("localUserId" IS NOT NULL)) OR ((("targetDomain")::text <> 'local'::text) AND ("localUserId" IS NULL))))
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
-- Name: ThreadMember; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ThreadMember" (
    id integer NOT NULL,
    "threadId" integer NOT NULL,
    "userId" integer NOT NULL,
    role public."GroupRole",
    "left" boolean DEFAULT false NOT NULL,
    "lastSentSeq" integer,
    "joinedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "firstSentSeq" integer,
    CONSTRAINT "ThreadMember_firstSentSeq_check" CHECK ((("firstSentSeq" IS NULL) OR ("firstSentSeq" > 0))),
    CONSTRAINT "ThreadMember_lastSentSeq_check" CHECK ((("lastSentSeq" IS NULL) OR ("lastSentSeq" > 0)))
);


--
-- Name: ThreadMember_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."ThreadMember_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ThreadMember_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."ThreadMember_id_seq" OWNED BY public."ThreadMember".id;


--
-- Name: ThreadParticipant; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ThreadParticipant" (
    id integer NOT NULL,
    "accountId" integer NOT NULL,
    "threadId" integer NOT NULL,
    role public."GroupRole",
    "lastReadSeq" integer,
    "readRevision" integer DEFAULT 0 NOT NULL,
    muted boolean DEFAULT false NOT NULL,
    blocked boolean DEFAULT false NOT NULL,
    pinned boolean DEFAULT false NOT NULL,
    "pinnedAt" timestamp(3) with time zone,
    "clearedSeq" integer,
    "messageVisibleBeforeSeq" bigint,
    alias character varying(64),
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "ThreadParticipant_cleared_seq_check" CHECK ((("clearedSeq" IS NULL) OR ("clearedSeq" >= 0))),
    CONSTRAINT "ThreadParticipant_messageVisibleBeforeSeq_check" CHECK ((("messageVisibleBeforeSeq" IS NULL) OR ("messageVisibleBeforeSeq" > 1)))
);


--
-- Name: ThreadParticipant_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."ThreadParticipant_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ThreadParticipant_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."ThreadParticipant_id_seq" OWNED BY public."ThreadParticipant".id;


--
-- Name: TwoFactorBackupCode; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."TwoFactorBackupCode" (
    id bigint NOT NULL,
    "adminId" integer NOT NULL,
    "codeHash" character varying(64) NOT NULL,
    "consumedAt" timestamp(3) with time zone,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: TwoFactorBackupCode_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."TwoFactorBackupCode_id_seq"
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
    "partId" uuid NOT NULL,
    "position" integer NOT NULL,
    "partIntent" public."ContentType" NOT NULL,
    CONSTRAINT "UploadSession_partIntent_check" CHECK (("partIntent" <> 'GALLERY'::public."ContentType")),
    CONSTRAINT "UploadSession_position_check" CHECK ((("position" >= 0) AND ("position" <= 9))),
    CONSTRAINT "UploadSession_receivedBytes_check" CHECK ((("receivedBytes" >= 0) AND ("receivedBytes" <= "totalBytes"))),
    CONSTRAINT "UploadSession_totalBytes_check" CHECK (("totalBytes" > 0))
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
-- Name: User; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."User" (
    id integer NOT NULL,
    account character varying(31) NOT NULL,
    name text NOT NULL,
    avatar text DEFAULT ''::text NOT NULL,
    bio character varying(255) DEFAULT ''::character varying NOT NULL,
    domain character varying(63) DEFAULT 'local'::character varying NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone NOT NULL,
    "profileRev" integer DEFAULT 0 NOT NULL,
    "sourceDomain" character varying(63) DEFAULT 'local'::character varying NOT NULL,
    availability character varying(16) DEFAULT 'AVAILABLE'::character varying NOT NULL,
    CONSTRAINT "User_account_check" CHECK (((account)::text !~~ '!%'::text)),
    CONSTRAINT "User_availability_check" CHECK (((availability)::text = ANY ((ARRAY['AVAILABLE'::character varying, 'REMOVED'::character varying])::text[])))
);


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
    count integer DEFAULT 0 NOT NULL,
    CONSTRAINT "UserQuotaDailyUsage_category_check" CHECK (((category)::text = ANY (ARRAY[('messages'::character varying)::text, ('images'::character varying)::text, ('largeFiles'::character varying)::text, ('requests'::character varying)::text, ('files'::character varying)::text]))),
    CONSTRAINT "UserQuotaDailyUsage_count_check" CHECK ((count >= 0))
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
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "dailyFileLimit" integer,
    "dailyFileBytesLimit" bigint
);


--
-- Name: User_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."User_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: User_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."User_id_seq" OWNED BY public."User".id;


--
-- Name: WebAuthnCredential; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."WebAuthnCredential" (
    id bigint NOT NULL,
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
-- Name: FederatedMessageTombstone id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederatedMessageTombstone" ALTER COLUMN id SET DEFAULT nextval('public."FederatedMessageTombstone_id_seq"'::regclass);


--
-- Name: FederatedPeerEvent id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederatedPeerEvent" ALTER COLUMN id SET DEFAULT nextval('public."FederatedPeerEvent_id_seq"'::regclass);


--
-- Name: FederationDeletedCursor id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationDeletedCursor" ALTER COLUMN id SET DEFAULT nextval('public."FederationDeletedCursor_id_seq"'::regclass);


--
-- Name: FederationThreadHistoryGap id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationThreadHistoryGap" ALTER COLUMN id SET DEFAULT nextval('public."FederationThreadHistoryGap_id_seq"'::regclass);


--
-- Name: FileSyncProgress id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FileSyncProgress" ALTER COLUMN id SET DEFAULT nextval('public."FileSyncProgress_id_seq"'::regclass);


--
-- Name: Group id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Group" ALTER COLUMN id SET DEFAULT nextval('public."Group_id_seq"'::regclass);


--
-- Name: GroupAuditLog id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GroupAuditLog" ALTER COLUMN id SET DEFAULT nextval('public."GroupAuditLog_id_seq"'::regclass);


--
-- Name: LoginCode id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."LoginCode" ALTER COLUMN id SET DEFAULT nextval('public."LoginCode_id_seq"'::regclass);


--
-- Name: Message id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Message" ALTER COLUMN id SET DEFAULT nextval('public."Message_id_seq"'::regclass);


--
-- Name: MessageReport id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MessageReport" ALTER COLUMN id SET DEFAULT nextval('public."MessageReport_id_seq"'::regclass);


--
-- Name: MessageThread id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MessageThread" ALTER COLUMN id SET DEFAULT nextval('public."MessageThread_id_seq"'::regclass);


--
-- Name: PendingMedia id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PendingMedia" ALTER COLUMN id SET DEFAULT nextval('public."PendingMedia_id_seq"'::regclass);


--
-- Name: PushToken id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PushToken" ALTER COLUMN id SET DEFAULT nextval('public."PushToken_id_seq"'::regclass);


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
-- Name: ThreadMember id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ThreadMember" ALTER COLUMN id SET DEFAULT nextval('public."ThreadMember_id_seq"'::regclass);


--
-- Name: ThreadParticipant id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ThreadParticipant" ALTER COLUMN id SET DEFAULT nextval('public."ThreadParticipant_id_seq"'::regclass);


--
-- Name: TwoFactorBackupCode id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."TwoFactorBackupCode" ALTER COLUMN id SET DEFAULT nextval('public."TwoFactorBackupCode_id_seq"'::regclass);


--
-- Name: UploadSession id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UploadSession" ALTER COLUMN id SET DEFAULT nextval('public."UploadSession_id_seq"'::regclass);


--
-- Name: User id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."User" ALTER COLUMN id SET DEFAULT nextval('public."User_id_seq"'::regclass);


--
-- Name: WebAuthnCredential id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."WebAuthnCredential" ALTER COLUMN id SET DEFAULT nextval('public."WebAuthnCredential_id_seq"'::regclass);


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
-- Name: CallTombstone CallTombstone_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CallTombstone"
    ADD CONSTRAINT "CallTombstone_pkey" PRIMARY KEY ("peerDomain", "callSid");


--
-- Name: ClientGroupMetaFeedTarget ClientGroupMetaFeedTarget_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientGroupMetaFeedTarget"
    ADD CONSTRAINT "ClientGroupMetaFeedTarget_pkey" PRIMARY KEY ("accountId", "groupId");


--
-- Name: ClientGroupMetaMemberFeed ClientGroupMetaMemberFeed_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientGroupMetaMemberFeed"
    ADD CONSTRAINT "ClientGroupMetaMemberFeed_pkey" PRIMARY KEY ("accountId", "groupId", "feedId");


--
-- Name: ClientMessageFeedTarget ClientMessageFeedTarget_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientMessageFeedTarget"
    ADD CONSTRAINT "ClientMessageFeedTarget_pkey" PRIMARY KEY ("userId");


--
-- Name: ClientMessageFeed ClientMessageFeed_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientMessageFeed"
    ADD CONSTRAINT "ClientMessageFeed_pkey" PRIMARY KEY ("userId", "threadId");


--
-- Name: ClientMessageTombstoneFeed ClientMessageTombstoneFeed_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientMessageTombstoneFeed"
    ADD CONSTRAINT "ClientMessageTombstoneFeed_pkey" PRIMARY KEY ("userId", "threadId");


--
-- Name: ClientStateFeed ClientStateFeed_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientStateFeed"
    ADD CONSTRAINT "ClientStateFeed_pkey" PRIMARY KEY ("userId", account, domain, "eventType", "subjectAccount", "subjectDomain");


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
-- Name: FederatedFriendRequest FederatedFriendRequest_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederatedFriendRequest"
    ADD CONSTRAINT "FederatedFriendRequest_pkey" PRIMARY KEY ("localUserId", "remoteDomain", "remoteAccount", direction);


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
-- Name: FederatedPeerReset FederatedPeerReset_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederatedPeerReset"
    ADD CONSTRAINT "FederatedPeerReset_pkey" PRIMARY KEY (domain);


--
-- Name: FederatedPeer FederatedPeer_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederatedPeer"
    ADD CONSTRAINT "FederatedPeer_pkey" PRIMARY KEY (domain);


--
-- Name: FederationDeletedCursor FederationDeletedCursor_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationDeletedCursor"
    ADD CONSTRAINT "FederationDeletedCursor_pkey" PRIMARY KEY (id);


--
-- Name: FederationMessageReceipt FederationMessageReceipt_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationMessageReceipt"
    ADD CONSTRAINT "FederationMessageReceipt_pkey" PRIMARY KEY ("peerDomain", "threadId", "peerSeq");


--
-- Name: FederationThreadHistoryGap FederationThreadHistoryGap_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationThreadHistoryGap"
    ADD CONSTRAINT "FederationThreadHistoryGap_pkey" PRIMARY KEY (id);


--
-- Name: FederationThreadSyncState FederationThreadSyncState_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationThreadSyncState"
    ADD CONSTRAINT "FederationThreadSyncState_pkey" PRIMARY KEY ("threadId", "peerDomain");


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
-- Name: GroupAuditLog GroupAuditLog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GroupAuditLog"
    ADD CONSTRAINT "GroupAuditLog_pkey" PRIMARY KEY (id);


--
-- Name: GroupMetaFeedTarget GroupMetaFeedTarget_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GroupMetaFeedTarget"
    ADD CONSTRAINT "GroupMetaFeedTarget_pkey" PRIMARY KEY ("targetPeerDomain", "groupId");


--
-- Name: GroupMetaMemberFeed GroupMetaMemberFeed_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GroupMetaMemberFeed"
    ADD CONSTRAINT "GroupMetaMemberFeed_pkey" PRIMARY KEY ("targetPeerDomain", "groupId", "feedId");


--
-- Name: GroupRequestProjection GroupRequestProjection_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GroupRequestProjection"
    ADD CONSTRAINT "GroupRequestProjection_pkey" PRIMARY KEY ("managerUserId", "threadId", "memberUserId", direction);


--
-- Name: Group Group_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Group"
    ADD CONSTRAINT "Group_pkey" PRIMARY KEY (id);


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
    ADD CONSTRAINT "MessageReport_pkey" PRIMARY KEY (id);


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
    ADD CONSTRAINT "PeerStateFeedPullCursor_pkey" PRIMARY KEY ("peerDomain");


--
-- Name: PeerStateFeedTarget PeerStateFeedTarget_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PeerStateFeedTarget"
    ADD CONSTRAINT "PeerStateFeedTarget_pkey" PRIMARY KEY ("peerDomain");


--
-- Name: PeerStateFeed PeerStateFeed_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PeerStateFeed"
    ADD CONSTRAINT "PeerStateFeed_pkey" PRIMARY KEY ("peerDomain", account, domain, "eventType", "subjectAccount", "subjectDomain");


--
-- Name: PendingMedia PendingMedia_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PendingMedia"
    ADD CONSTRAINT "PendingMedia_pkey" PRIMARY KEY (id);


--
-- Name: PushToken PushToken_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PushToken"
    ADD CONSTRAINT "PushToken_pkey" PRIMARY KEY (id);


--
-- Name: QuotaDailyAllowance QuotaDailyAllowance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."QuotaDailyAllowance"
    ADD CONSTRAINT "QuotaDailyAllowance_pkey" PRIMARY KEY (domain, date);


--
-- Name: QuotaDailyUsage QuotaDailyUsage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."QuotaDailyUsage"
    ADD CONSTRAINT "QuotaDailyUsage_pkey" PRIMARY KEY (domain, date, category);


--
-- Name: QuotaFileByteUsage QuotaFileByteUsage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."QuotaFileByteUsage"
    ADD CONSTRAINT "QuotaFileByteUsage_pkey" PRIMARY KEY (domain, date);


--
-- Name: RelationshipIntent RelationshipIntent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."RelationshipIntent"
    ADD CONSTRAINT "RelationshipIntent_pkey" PRIMARY KEY ("pairId", "authorSide");


--
-- Name: RelationshipPair RelationshipPair_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."RelationshipPair"
    ADD CONSTRAINT "RelationshipPair_pkey" PRIMARY KEY (id);


--
-- Name: S2SKeyCache S2SKeyCache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."S2SKeyCache"
    ADD CONSTRAINT "S2SKeyCache_pkey" PRIMARY KEY (domain, "keyId");


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
-- Name: ThreadMember ThreadMember_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ThreadMember"
    ADD CONSTRAINT "ThreadMember_pkey" PRIMARY KEY (id);


--
-- Name: ThreadParticipant ThreadParticipant_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ThreadParticipant"
    ADD CONSTRAINT "ThreadParticipant_pkey" PRIMARY KEY (id);


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
-- Name: UserPreference UserPreference_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserPreference"
    ADD CONSTRAINT "UserPreference_pkey" PRIMARY KEY ("userId", key);


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
-- Name: User User_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."User"
    ADD CONSTRAINT "User_pkey" PRIMARY KEY (id);


--
-- Name: WebAuthnCredential WebAuthnCredential_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."WebAuthnCredential"
    ADD CONSTRAINT "WebAuthnCredential_pkey" PRIMARY KEY (id);


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
-- Name: CallTombstone_expiresAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "CallTombstone_expiresAt_idx" ON public."CallTombstone" USING btree ("expiresAt");


--
-- Name: ClientGroupMetaMemberFeed_member_feed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ClientGroupMetaMemberFeed_member_feed_idx" ON public."ClientGroupMetaMemberFeed" USING btree ("accountId", "groupId", "memberDomain", "memberAccount", "feedId");


--
-- Name: ClientMessageFeed_user_feedId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ClientMessageFeed_user_feedId_key" ON public."ClientMessageFeed" USING btree ("userId", "feedId");


--
-- Name: ClientMessageTombstoneFeed_user_feedId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ClientMessageTombstoneFeed_user_feedId_key" ON public."ClientMessageTombstoneFeed" USING btree ("userId", "feedId");


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
-- Name: FederatedFriendRequest_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "FederatedFriendRequest_pending_idx" ON public."FederatedFriendRequest" USING btree ("localUserId", direction, status, "expiresAt");


--
-- Name: FederatedMessageTombstone_source_event_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "FederatedMessageTombstone_source_event_key" ON public."FederatedMessageTombstone" USING btree ("sourceDomain", "threadId", "remoteDeletionSeq");


--
-- Name: FederatedMessageTombstone_target_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "FederatedMessageTombstone_target_key" ON public."FederatedMessageTombstone" USING btree ("threadId", "sourceDomain", "messageSeq");


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
-- Name: FederatedPeer_single_reset_in_progress_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "FederatedPeer_single_reset_in_progress_key" ON public."FederatedPeer" USING btree ((true)) WHERE ("resetInProgress" = true);


--
-- Name: FederatedPeer_trustLevel_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "FederatedPeer_trustLevel_idx" ON public."FederatedPeer" USING btree ("trustLevel");


--
-- Name: FederationDeletedCursor_stream_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "FederationDeletedCursor_stream_key" ON public."FederationDeletedCursor" USING btree ("threadId", "peerDomain", "streamAccount", "streamKind");


--
-- Name: FederationMessageReceipt_messageId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "FederationMessageReceipt_messageId_idx" ON public."FederationMessageReceipt" USING btree ("messageId");


--
-- Name: FederationThreadHistoryGap_interval_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "FederationThreadHistoryGap_interval_key" ON public."FederationThreadHistoryGap" USING btree ("threadId", "startSeq", "endSeq");


--
-- Name: FederationThreadHistoryGap_recoverable_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "FederationThreadHistoryGap_recoverable_idx" ON public."FederationThreadHistoryGap" USING btree ("threadId", "endSeq") WHERE (recoverable = true);


--
-- Name: FederationThreadHistoryGap_threadId_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "FederationThreadHistoryGap_threadId_id_key" ON public."FederationThreadHistoryGap" USING btree ("threadId", id);


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
-- Name: ForwardBundle_sourceDomain_sourceBundleId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ForwardBundle_sourceDomain_sourceBundleId_key" ON public."ForwardBundle" USING btree ("sourceDomain", "sourceBundleId");


--
-- Name: ForwardMessage_bundleId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ForwardMessage_bundleId_idx" ON public."ForwardMessage" USING btree ("bundleId");


--
-- Name: GroupAuditLog_action_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "GroupAuditLog_action_at_idx" ON public."GroupAuditLog" USING btree (action, at);


--
-- Name: GroupAuditLog_eventKey_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "GroupAuditLog_eventKey_key" ON public."GroupAuditLog" USING btree ("eventKey");


--
-- Name: GroupAuditLog_groupId_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "GroupAuditLog_groupId_at_idx" ON public."GroupAuditLog" USING btree ("groupId", at);


--
-- Name: GroupMetaMemberFeed_member_feed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "GroupMetaMemberFeed_member_feed_idx" ON public."GroupMetaMemberFeed" USING btree ("targetPeerDomain", "groupId", "memberDomain", "memberAccount", "feedId");


--
-- Name: GroupRequestProjection_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "GroupRequestProjection_expiry_idx" ON public."GroupRequestProjection" USING btree ("expiresAt");


--
-- Name: GroupRequestProjection_manager_feed_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "GroupRequestProjection_manager_feed_key" ON public."GroupRequestProjection" USING btree ("managerUserId", "feedId");


--
-- Name: GroupRequestProjection_thread_feed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "GroupRequestProjection_thread_feed_idx" ON public."GroupRequestProjection" USING btree ("managerUserId", "threadId", "feedId");


--
-- Name: Group_account_domain_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Group_account_domain_key" ON public."Group" USING btree (account, domain);


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
-- Name: MessageReport_messageId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "MessageReport_messageId_idx" ON public."MessageReport" USING btree ("messageId");


--
-- Name: MessageReport_reporterId_messageId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "MessageReport_reporterId_messageId_key" ON public."MessageReport" USING btree ("reporterId", "messageId");


--
-- Name: MessageReport_status_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "MessageReport_status_createdAt_idx" ON public."MessageReport" USING btree (status, "createdAt" DESC);


--
-- Name: MessageThread_groupId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "MessageThread_groupId_key" ON public."MessageThread" USING btree ("groupId");


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

CREATE INDEX "Message_creator_address_idx" ON public."Message" USING btree ("creatorAccount", "creatorDomain");


--
-- Name: Message_threadId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Message_threadId_createdAt_idx" ON public."Message" USING btree ("threadId", "createdAt");


--
-- Name: Message_threadId_creator_originSeq_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Message_threadId_creator_originSeq_key" ON public."Message" USING btree ("threadId", "creatorAccount", "creatorDomain", "originSeq");


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

CREATE UNIQUE INDEX "Message_threadId_source_originSeq_key" ON public."Message" USING btree ("threadId", "federationSourceDomain", "originSeq");


--
-- Name: PeerStateFeed_peerDomain_feedId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "PeerStateFeed_peerDomain_feedId_key" ON public."PeerStateFeed" USING btree ("peerDomain", "feedId");


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
-- Name: PushToken_token_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "PushToken_token_key" ON public."PushToken" USING btree (token);


--
-- Name: PushToken_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PushToken_userId_idx" ON public."PushToken" USING btree ("userId");


--
-- Name: QuotaDailyUsage_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "QuotaDailyUsage_date_idx" ON public."QuotaDailyUsage" USING btree (date);


--
-- Name: QuotaFileByteUsage_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "QuotaFileByteUsage_date_idx" ON public."QuotaFileByteUsage" USING btree (date);


--
-- Name: RelationshipIntent_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "RelationshipIntent_id_key" ON public."RelationshipIntent" USING btree (id);


--
-- Name: RelationshipPair_endpointA_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "RelationshipPair_endpointA_idx" ON public."RelationshipPair" USING btree ("endpointAType", "endpointAAccount", "endpointADomain", active);


--
-- Name: RelationshipPair_endpointB_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "RelationshipPair_endpointB_idx" ON public."RelationshipPair" USING btree ("endpointBType", "endpointBAccount", "endpointBDomain", active);


--
-- Name: RelationshipPair_endpoints_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "RelationshipPair_endpoints_key" ON public."RelationshipPair" USING btree ("endpointAType", "endpointAAccount", "endpointADomain", "endpointBType", "endpointBAccount", "endpointBDomain");


--
-- Name: SessionToken_lastSeenAt_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SessionToken_lastSeenAt_active_idx" ON public."SessionToken" USING btree ("lastSeenAt" DESC) WHERE ("revokedAt" IS NULL);


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

CREATE INDEX "SessionToken_userId_lastSeenAt_active_idx" ON public."SessionToken" USING btree ("userId", "lastSeenAt" DESC) WHERE ("revokedAt" IS NULL);


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

CREATE INDEX "ThreadAudience_peer_access_idx" ON public."ThreadAudience" USING btree ("targetDomain", "threadId") WHERE (("targetDomain")::text <> 'local'::text);


--
-- Name: ThreadAudience_peer_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ThreadAudience_peer_key" ON public."ThreadAudience" USING btree ("targetDomain", "threadId") WHERE (("targetDomain")::text <> 'local'::text);


--
-- Name: ThreadMember_id_threadId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ThreadMember_id_threadId_key" ON public."ThreadMember" USING btree (id, "threadId");


--
-- Name: ThreadMember_one_current_owner_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ThreadMember_one_current_owner_key" ON public."ThreadMember" USING btree ("threadId") WHERE ((role = 'OWNER'::public."GroupRole") AND ("left" = false));


--
-- Name: ThreadMember_threadId_left_firstSentSeq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ThreadMember_threadId_left_firstSentSeq_idx" ON public."ThreadMember" USING btree ("threadId", "left", "firstSentSeq");


--
-- Name: ThreadMember_threadId_left_lastSentSeq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ThreadMember_threadId_left_lastSentSeq_idx" ON public."ThreadMember" USING btree ("threadId", "left", "lastSentSeq");


--
-- Name: ThreadMember_threadId_userId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ThreadMember_threadId_userId_key" ON public."ThreadMember" USING btree ("threadId", "userId");


--
-- Name: ThreadParticipant_accountId_pinned_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ThreadParticipant_accountId_pinned_idx" ON public."ThreadParticipant" USING btree ("accountId", pinned);


--
-- Name: ThreadParticipant_accountId_readRevision_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ThreadParticipant_accountId_readRevision_idx" ON public."ThreadParticipant" USING btree ("accountId", "readRevision");


--
-- Name: ThreadParticipant_accountId_threadId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ThreadParticipant_accountId_threadId_key" ON public."ThreadParticipant" USING btree ("accountId", "threadId");


--
-- Name: ThreadParticipant_threadId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ThreadParticipant_threadId_idx" ON public."ThreadParticipant" USING btree ("threadId");


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

CREATE INDEX "UploadSession_digest_idx" ON public."UploadSession" USING btree (digest) WHERE (digest IS NOT NULL);


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
-- Name: User_account_domain_sourceDomain_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "User_account_domain_sourceDomain_key" ON public."User" USING btree (account, domain, "sourceDomain");


--
-- Name: User_address_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "User_address_idx" ON public."User" USING btree (account, domain);


--
-- Name: User_source_address_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "User_source_address_idx" ON public."User" USING btree ("sourceDomain", account, domain);


--
-- Name: WebAuthnCredential_adminId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "WebAuthnCredential_adminId_idx" ON public."WebAuthnCredential" USING btree ("adminId");


--
-- Name: WebAuthnCredential_credentialId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "WebAuthnCredential_credentialId_key" ON public."WebAuthnCredential" USING btree ("credentialId");


--
-- Name: Message Message_federation_feed_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "Message_federation_feed_notify" AFTER INSERT ON public."Message" FOR EACH ROW EXECUTE FUNCTION public.soms_notify_federation_message_committed();


--
-- Name: Account Account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Account"
    ADD CONSTRAINT "Account_id_fkey" FOREIGN KEY (id) REFERENCES public."User"(id) ON DELETE CASCADE;


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
-- Name: ClientGroupMetaFeedTarget ClientGroupMetaFeedTarget_accountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientGroupMetaFeedTarget"
    ADD CONSTRAINT "ClientGroupMetaFeedTarget_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON DELETE CASCADE;


--
-- Name: ClientGroupMetaFeedTarget ClientGroupMetaFeedTarget_groupId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientGroupMetaFeedTarget"
    ADD CONSTRAINT "ClientGroupMetaFeedTarget_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES public."Group"(id) ON DELETE CASCADE;


--
-- Name: ClientGroupMetaMemberFeed ClientGroupMetaMemberFeed_accountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientGroupMetaMemberFeed"
    ADD CONSTRAINT "ClientGroupMetaMemberFeed_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON DELETE CASCADE;


--
-- Name: ClientGroupMetaMemberFeed ClientGroupMetaMemberFeed_groupId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientGroupMetaMemberFeed"
    ADD CONSTRAINT "ClientGroupMetaMemberFeed_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES public."Group"(id) ON DELETE CASCADE;


--
-- Name: ClientMessageFeedTarget ClientMessageFeedTarget_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientMessageFeedTarget"
    ADD CONSTRAINT "ClientMessageFeedTarget_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."Account"(id) ON DELETE CASCADE;


--
-- Name: ClientMessageFeed ClientMessageFeed_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientMessageFeed"
    ADD CONSTRAINT "ClientMessageFeed_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON DELETE CASCADE;


--
-- Name: ClientMessageFeed ClientMessageFeed_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientMessageFeed"
    ADD CONSTRAINT "ClientMessageFeed_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."Account"(id) ON DELETE CASCADE;


--
-- Name: ClientMessageTombstoneFeed ClientMessageTombstoneFeed_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientMessageTombstoneFeed"
    ADD CONSTRAINT "ClientMessageTombstoneFeed_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON DELETE CASCADE;


--
-- Name: ClientMessageTombstoneFeed ClientMessageTombstoneFeed_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientMessageTombstoneFeed"
    ADD CONSTRAINT "ClientMessageTombstoneFeed_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."Account"(id) ON DELETE CASCADE;


--
-- Name: ClientStateFeed ClientStateFeed_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientStateFeed"
    ADD CONSTRAINT "ClientStateFeed_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."Account"(id) ON DELETE CASCADE;


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
-- Name: FederatedFriendRequest FederatedFriendRequest_localUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederatedFriendRequest"
    ADD CONSTRAINT "FederatedFriendRequest_localUserId_fkey" FOREIGN KEY ("localUserId") REFERENCES public."Account"(id) ON DELETE CASCADE;


--
-- Name: FederatedFriendRequest FederatedFriendRequest_remoteDomain_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederatedFriendRequest"
    ADD CONSTRAINT "FederatedFriendRequest_remoteDomain_fkey" FOREIGN KEY ("remoteDomain") REFERENCES public."FederatedPeer"(domain) ON DELETE CASCADE;


--
-- Name: FederatedMessageTombstone FederatedMessageTombstone_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederatedMessageTombstone"
    ADD CONSTRAINT "FederatedMessageTombstone_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: FederationDeletedCursor FederationDeletedCursor_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationDeletedCursor"
    ADD CONSTRAINT "FederationDeletedCursor_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: FederationMessageReceipt FederationMessageReceipt_messageId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationMessageReceipt"
    ADD CONSTRAINT "FederationMessageReceipt_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES public."Message"(id) ON DELETE CASCADE;


--
-- Name: FederationMessageReceipt FederationMessageReceipt_peerDomain_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationMessageReceipt"
    ADD CONSTRAINT "FederationMessageReceipt_peerDomain_fkey" FOREIGN KEY ("peerDomain") REFERENCES public."FederatedPeer"(domain) ON DELETE CASCADE;


--
-- Name: FederationMessageReceipt FederationMessageReceipt_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationMessageReceipt"
    ADD CONSTRAINT "FederationMessageReceipt_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON DELETE CASCADE;


--
-- Name: FederationThreadHistoryGap FederationThreadHistoryGap_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationThreadHistoryGap"
    ADD CONSTRAINT "FederationThreadHistoryGap_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON DELETE CASCADE;


--
-- Name: FederationThreadSyncState FederationThreadSyncState_activeGap_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationThreadSyncState"
    ADD CONSTRAINT "FederationThreadSyncState_activeGap_fkey" FOREIGN KEY ("threadId", "activeGapId") REFERENCES public."FederationThreadHistoryGap"("threadId", id) ON DELETE RESTRICT;


--
-- Name: FederationThreadSyncState FederationThreadSyncState_peerDomain_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationThreadSyncState"
    ADD CONSTRAINT "FederationThreadSyncState_peerDomain_fkey" FOREIGN KEY ("peerDomain") REFERENCES public."FederatedPeer"(domain) ON DELETE CASCADE;


--
-- Name: FederationThreadSyncState FederationThreadSyncState_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationThreadSyncState"
    ADD CONSTRAINT "FederationThreadSyncState_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON DELETE CASCADE;


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
-- Name: GroupMetaFeedTarget GroupMetaFeedTarget_groupId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GroupMetaFeedTarget"
    ADD CONSTRAINT "GroupMetaFeedTarget_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES public."Group"(id) ON DELETE CASCADE;


--
-- Name: GroupMetaFeedTarget GroupMetaFeedTarget_targetPeerDomain_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GroupMetaFeedTarget"
    ADD CONSTRAINT "GroupMetaFeedTarget_targetPeerDomain_fkey" FOREIGN KEY ("targetPeerDomain") REFERENCES public."FederatedPeer"(domain) ON DELETE CASCADE;


--
-- Name: GroupMetaMemberFeed GroupMetaMemberFeed_groupId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GroupMetaMemberFeed"
    ADD CONSTRAINT "GroupMetaMemberFeed_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES public."Group"(id) ON DELETE CASCADE;


--
-- Name: GroupMetaMemberFeed GroupMetaMemberFeed_targetPeerDomain_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GroupMetaMemberFeed"
    ADD CONSTRAINT "GroupMetaMemberFeed_targetPeerDomain_fkey" FOREIGN KEY ("targetPeerDomain") REFERENCES public."FederatedPeer"(domain) ON DELETE CASCADE;


--
-- Name: GroupRequestProjection GroupRequestProjection_managerUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GroupRequestProjection"
    ADD CONSTRAINT "GroupRequestProjection_managerUserId_fkey" FOREIGN KEY ("managerUserId") REFERENCES public."Account"(id) ON DELETE CASCADE;


--
-- Name: GroupRequestProjection GroupRequestProjection_memberUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GroupRequestProjection"
    ADD CONSTRAINT "GroupRequestProjection_memberUserId_fkey" FOREIGN KEY ("memberUserId") REFERENCES public."User"(id) ON DELETE CASCADE;


--
-- Name: GroupRequestProjection GroupRequestProjection_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GroupRequestProjection"
    ADD CONSTRAINT "GroupRequestProjection_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON DELETE CASCADE;


--
-- Name: LoginCode LoginCode_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."LoginCode"
    ADD CONSTRAINT "LoginCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE CASCADE;


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
-- Name: MessageReport MessageReport_messageId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MessageReport"
    ADD CONSTRAINT "MessageReport_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES public."Message"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: MessageReport MessageReport_reporterId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MessageReport"
    ADD CONSTRAINT "MessageReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: MessageReport MessageReport_reviewedByAdminId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MessageReport"
    ADD CONSTRAINT "MessageReport_reviewedByAdminId_fkey" FOREIGN KEY ("reviewedByAdminId") REFERENCES public."Admin"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: MessageReport MessageReport_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MessageReport"
    ADD CONSTRAINT "MessageReport_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: MessageThread MessageThread_groupId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MessageThread"
    ADD CONSTRAINT "MessageThread_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES public."Group"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Message Message_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Message"
    ADD CONSTRAINT "Message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: PeerStateFeedPullCursor PeerStateFeedPullCursor_peerDomain_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PeerStateFeedPullCursor"
    ADD CONSTRAINT "PeerStateFeedPullCursor_peerDomain_fkey" FOREIGN KEY ("peerDomain") REFERENCES public."FederatedPeer"(domain) ON DELETE CASCADE;


--
-- Name: PeerStateFeedTarget PeerStateFeedTarget_peerDomain_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PeerStateFeedTarget"
    ADD CONSTRAINT "PeerStateFeedTarget_peerDomain_fkey" FOREIGN KEY ("peerDomain") REFERENCES public."FederatedPeer"(domain) ON DELETE CASCADE;


--
-- Name: PeerStateFeed PeerStateFeed_peerDomain_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PeerStateFeed"
    ADD CONSTRAINT "PeerStateFeed_peerDomain_fkey" FOREIGN KEY ("peerDomain") REFERENCES public."FederatedPeer"(domain) ON DELETE CASCADE;


--
-- Name: PendingMedia PendingMedia_messageId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PendingMedia"
    ADD CONSTRAINT "PendingMedia_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES public."Message"(id) ON DELETE CASCADE;


--
-- Name: PendingMedia PendingMedia_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PendingMedia"
    ADD CONSTRAINT "PendingMedia_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: PushToken PushToken_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PushToken"
    ADD CONSTRAINT "PushToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: RelationshipIntent RelationshipIntent_pairId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."RelationshipIntent"
    ADD CONSTRAINT "RelationshipIntent_pairId_fkey" FOREIGN KEY ("pairId") REFERENCES public."RelationshipPair"(id) ON DELETE CASCADE;


--
-- Name: RelationshipPair RelationshipPair_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."RelationshipPair"
    ADD CONSTRAINT "RelationshipPair_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON DELETE SET NULL;


--
-- Name: SessionToken SessionToken_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SessionToken"
    ADD CONSTRAINT "SessionToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ThreadAudience ThreadAudience_localUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ThreadAudience"
    ADD CONSTRAINT "ThreadAudience_localUserId_fkey" FOREIGN KEY ("localUserId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ThreadAudience ThreadAudience_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ThreadAudience"
    ADD CONSTRAINT "ThreadAudience_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ThreadMember ThreadMember_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ThreadMember"
    ADD CONSTRAINT "ThreadMember_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON DELETE RESTRICT;


--
-- Name: ThreadMember ThreadMember_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ThreadMember"
    ADD CONSTRAINT "ThreadMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON DELETE RESTRICT;


--
-- Name: ThreadParticipant ThreadParticipant_accountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ThreadParticipant"
    ADD CONSTRAINT "ThreadParticipant_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON DELETE RESTRICT;


--
-- Name: ThreadParticipant ThreadParticipant_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ThreadParticipant"
    ADD CONSTRAINT "ThreadParticipant_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON DELETE RESTRICT;


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
