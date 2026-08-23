-- Greenfield schema baseline, consolidated on 2026-08-14.
-- Keep this file in sync with src/database/schema.ts.


-- Dumped from database version 16.14
-- Dumped by pg_dump version 18.4 (Debian 18.4-1.pgdg13+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- *not* creating schema, since initdb creates it


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
    'INVITE',
    'IMAGE',
    'VIDEO',
    'FILE',
    'AUDIO',
    'LINK',
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
-- Name: FriendRequestStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."FriendRequestStatus" AS ENUM (
    'REQUESTED',
    'FRIEND',
    'NOT_FRIEND'
);


--
-- Name: GroupMembershipDirection; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."GroupMembershipDirection" AS ENUM (
    'INVITE',
    'JOIN'
);


--
-- Name: GroupMembershipRequestStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."GroupMembershipRequestStatus" AS ENUM (
    'REQUESTED',
    'MEMBER',
    'NOT_MEMBER'
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
    'WITHDRAW',
    'REPORT'
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
    'MEMBER_PROFILE',
    'P2P_INTENT',
    'GROUP_META',
    'GROUP_INVITE_INTENT',
    'GROUP_JOIN_INTENT'
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
-- Name: ThreadRevisionDirection; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ThreadRevisionDirection" AS ENUM (
    'ADD',
    'DELETE'
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
-- Name: Admin; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Admin" (
    id integer NOT NULL,
    "userId" integer NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    "lastLoginIp" character varying(64),
    "lastLoginAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    role public."AdminRole" DEFAULT 'SUPER_ADMIN'::public."AdminRole" NOT NULL,
    "twoFactorEnabled" boolean DEFAULT false NOT NULL,
    "twoFactorSecretCipher" character varying(255),
    "twoFactorEnabledAt" timestamp(3) without time zone,
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
    at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
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
    "consumedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
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
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "lastAccessedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "expiresAt" timestamp(3) without time zone NOT NULL,
    "revokedAt" timestamp(3) without time zone,
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
-- Name: DeletedMessage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."DeletedMessage" (
    id bigint NOT NULL,
    "threadId" integer NOT NULL,
    seq integer NOT NULL,
    type public."MessageDeleteType" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "federationSourceDomain" character varying(63),
    CONSTRAINT "DeletedMessage_seq_check" CHECK ((seq > 0))
);


--
-- Name: DeletedMessage_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."DeletedMessage_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: DeletedMessage_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."DeletedMessage_id_seq" OWNED BY public."DeletedMessage".id;


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
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
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
    revision integer DEFAULT 0 NOT NULL,
    "requestedAt" timestamp(3) without time zone,
    "expiresAt" timestamp(3) without time zone,
    "displayName" character varying(30),
    avatar text,
    "profileRevision" integer,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "FederatedFriendRequest_direction_check" CHECK (((direction)::text = ANY ((ARRAY['INCOMING'::character varying, 'OUTGOING'::character varying])::text[]))),
    CONSTRAINT "FederatedFriendRequest_expiry_check" CHECK (((((status)::text = 'REQUESTED'::text) AND ("requestedAt" IS NOT NULL) AND ("expiresAt" IS NOT NULL) AND ("expiresAt" > "requestedAt") AND ("expiresAt" <= ("requestedAt" + '7 days'::interval))) OR (((status)::text = 'REVOKED'::text) AND ("expiresAt" IS NULL)))),
    CONSTRAINT "FederatedFriendRequest_revision_check" CHECK (((revision >= 0) AND (("profileRevision" IS NULL) OR ("profileRevision" >= 0)))),
    CONSTRAINT "FederatedFriendRequest_status_check" CHECK (((status)::text = ANY ((ARRAY['REQUESTED'::character varying, 'REVOKED'::character varying])::text[])))
);


--
-- Name: FederatedMemberProfile; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FederatedMemberProfile" (
    "sourcePeerDomain" character varying(63) NOT NULL,
    "memberAccount" character varying(31) NOT NULL,
    "memberDomain" character varying(63) NOT NULL,
    revision integer NOT NULL,
    availability character varying(16) NOT NULL,
    "displayName" character varying(30),
    avatar character varying(255),
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "FederatedMemberProfile_availability_check" CHECK (((availability)::text = ANY ((ARRAY['AVAILABLE'::character varying, 'REMOVED'::character varying])::text[]))),
    CONSTRAINT "FederatedMemberProfile_body_check" CHECK (((((availability)::text = 'AVAILABLE'::text) AND ("displayName" IS NOT NULL)) OR (((availability)::text = 'REMOVED'::text) AND ("displayName" IS NULL) AND (avatar IS NULL)))),
    CONSTRAINT "FederatedMemberProfile_revision_check" CHECK ((revision >= 0))
);


--
-- Name: FederatedMessageTombstone; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FederatedMessageTombstone" (
    id bigint NOT NULL,
    "threadId" integer NOT NULL,
    "creatorId" integer NOT NULL,
    "originSeq" integer NOT NULL,
    "authorityDomain" character varying(255) NOT NULL,
    "sourceDomain" character varying(255) NOT NULL,
    "remoteDeletedId" bigint NOT NULL,
    type public."MessageDeleteType" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "authorityDeletedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "FederatedMessageTombstone_origin_seq_check" CHECK (("originSeq" > 0))
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
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "trustedAt" timestamp(3) without time zone,
    "lastSuccessAt" timestamp(3) without time zone,
    "degradedAt" timestamp(3) without time zone,
    "degradationReason" character varying(255),
    "degradationCount" integer DEFAULT 0 NOT NULL,
    "dailyMsgLimit" integer,
    "dailyRequestLimit" integer,
    "rootKeyFingerprint" character varying(80),
    "identityPinnedAt" timestamp(3) without time zone,
    "resetGeneration" integer DEFAULT 0 NOT NULL,
    "resetAt" timestamp(3) without time zone,
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
    "outboundRecognizedAt" timestamp(3) without time zone,
    "inboundRecognizedAt" timestamp(3) without time zone,
    "haltedAt" timestamp(3) without time zone,
    "haltCode" integer,
    "haltReason" character varying(255),
    "resetInProgress" boolean DEFAULT false NOT NULL,
    CONSTRAINT "FederatedPeer_trustLevel_check" CHECK ((("trustLevel")::text = ANY ((ARRAY['unrecognized'::character varying, 'establishing'::character varying, 'available'::character varying, 'degraded'::character varying, 'halted'::character varying])::text[])))
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
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
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
    "resetAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "FederatedPeerReset_resetGeneration_check" CHECK (("resetGeneration" > 0))
);


--
-- Name: TABLE "FederatedPeerReset"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public."FederatedPeerReset" IS 'Persistent tombstone preventing a reset federation domain from inheriting its former identity or authorization.';


--
-- Name: FederatedProfile; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FederatedProfile" (
    domain character varying(63) NOT NULL,
    account character varying(31) NOT NULL,
    revision integer NOT NULL,
    "displayName" character varying(30) NOT NULL,
    bio character varying(255) DEFAULT ''::character varying NOT NULL,
    avatar character varying(255),
    deleted boolean DEFAULT false NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "FederatedProfile_revision_check" CHECK ((revision >= 0))
);


--
-- Name: FederationDeletedCursor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FederationDeletedCursor" (
    id bigint NOT NULL,
    "threadId" integer NOT NULL,
    "peerDomain" character varying(255) NOT NULL,
    "streamAccount" character varying(255) DEFAULT ''::character varying NOT NULL,
    "streamKind" character varying(32) NOT NULL,
    "deletedHwm" bigint DEFAULT 0 NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
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
-- Name: FederationMemberProfilePublication; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FederationMemberProfilePublication" (
    "targetPeerDomain" character varying(63) NOT NULL,
    "memberAccount" character varying(31) NOT NULL,
    "memberDomain" character varying(63) NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    availability character varying(16) NOT NULL,
    "bodyHash" character varying(64) NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "FederationMemberProfilePublication_availability_check" CHECK (((availability)::text = ANY ((ARRAY['AVAILABLE'::character varying, 'REMOVED'::character varying])::text[]))),
    CONSTRAINT "FederationMemberProfilePublication_revision_check" CHECK ((revision >= 0))
);


--
-- Name: FederationMemberProfileSource; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FederationMemberProfileSource" (
    "targetPeerDomain" character varying(63) NOT NULL,
    "memberAccount" character varying(31) NOT NULL,
    "memberDomain" character varying(63) NOT NULL,
    "threadId" integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: FederationMessageFeedIndex; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FederationMessageFeedIndex" (
    "peerDomain" character varying(63) NOT NULL,
    "threadId" integer NOT NULL,
    "feedId" bigint NOT NULL,
    "messageEndSeq" integer NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "FederationMessageFeedIndex_feedId_check" CHECK (("feedId" > 0)),
    CONSTRAINT "FederationMessageFeedIndex_messageEndSeq_check" CHECK (("messageEndSeq" > 0))
);


--
-- Name: FederationMessageQueryCursor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FederationMessageQueryCursor" (
    "peerDomain" character varying(63) NOT NULL,
    "threadKey" character varying(255) NOT NULL,
    "committedThrough" integer NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "FederationMessageQueryCursor_committedThrough_check" CHECK (("committedThrough" >= 0))
);


--
-- Name: FederationPullCursor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FederationPullCursor" (
    "peerDomain" character varying(63) NOT NULL,
    "committedThrough" bigint DEFAULT 0 NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "retainedAfter" bigint DEFAULT 0 NOT NULL,
    initialized boolean DEFAULT false NOT NULL,
    CONSTRAINT "FederationPullCursor_committedThrough_check" CHECK (("committedThrough" >= "retainedAfter")),
    CONSTRAINT "FederationPullCursor_retainedAfter_check" CHECK (("retainedAfter" >= 0))
);


--
-- Name: FederationServeCursor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FederationServeCursor" (
    "peerDomain" character varying(63) NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "allocatedThrough" bigint DEFAULT 0 NOT NULL,
    CONSTRAINT "FederationServeCursor_allocatedThrough_check" CHECK (("allocatedThrough" >= 0))
);


--
-- Name: FederationTombstoneFeedIndex; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FederationTombstoneFeedIndex" (
    "peerDomain" character varying(63) NOT NULL,
    "threadId" integer NOT NULL,
    "feedId" bigint NOT NULL,
    "tombstoneEndSeq" bigint NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "FederationTombstoneFeedIndex_feedId_check" CHECK (("feedId" > 0)),
    CONSTRAINT "FederationTombstoneFeedIndex_tombstoneEndSeq_check" CHECK (("tombstoneEndSeq" > 0))
);


--
-- Name: FederationTombstonePullCursor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FederationTombstonePullCursor" (
    "peerDomain" character varying(63) NOT NULL,
    "committedThrough" bigint DEFAULT 0 NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    initialized boolean DEFAULT false NOT NULL,
    CONSTRAINT "FederationTombstonePullCursor_committedThrough_check" CHECK (("committedThrough" >= 0))
);


--
-- Name: FederationTombstoneQueryCursor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FederationTombstoneQueryCursor" (
    "peerDomain" character varying(63) NOT NULL,
    "threadKey" character varying(255) NOT NULL,
    "committedThrough" bigint NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "FederationTombstoneQueryCursor_committedThrough_check" CHECK (("committedThrough" >= 0))
);


--
-- Name: FederationTombstoneServeCursor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FederationTombstoneServeCursor" (
    "peerDomain" character varying(63) NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "allocatedThrough" bigint DEFAULT 0 NOT NULL,
    "sourceScannedThrough" bigint DEFAULT 0 NOT NULL,
    CONSTRAINT "FederationTombstoneServeCursor_order_check" CHECK ((("sourceScannedThrough" >= 0) AND ("allocatedThrough" >= 0)))
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
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
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
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "ForwardBundle_asset_count_check" CHECK (("assetCount" >= 0)),
    CONSTRAINT "ForwardBundle_messages_shape_check" CHECK ((jsonb_typeof(messages) = 'array'::text)),
    CONSTRAINT "ForwardBundle_message_count_check" CHECK ((("messageCount" >= 0) AND ("messageCount" <= 500))),
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
-- Name: FriendPair; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FriendPair" (
    "userLowId" integer NOT NULL,
    "userHighId" integer NOT NULL,
    "threadId" integer,
    active boolean DEFAULT false NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "FriendPair_order_check" CHECK (("userLowId" < "userHighId")),
    CONSTRAINT "FriendPair_revision_check" CHECK ((revision >= 0))
);


--
-- Name: FriendRequest; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FriendRequest" (
    "requesterUserId" integer NOT NULL,
    "targetUserId" integer NOT NULL,
    status public."FriendRequestStatus" NOT NULL,
    note character varying(255) DEFAULT ''::character varying NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    "requestedAt" timestamp(3) without time zone,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    id bigint NOT NULL,
    "expiresAt" timestamp(3) without time zone,
    CONSTRAINT "FriendRequest_expiry_check" CHECK ((((status = 'REQUESTED'::public."FriendRequestStatus") AND ("requestedAt" IS NOT NULL) AND ("expiresAt" IS NOT NULL) AND ("expiresAt" > "requestedAt") AND ("expiresAt" <= ("requestedAt" + '7 days'::interval))) OR ((status <> 'REQUESTED'::public."FriendRequestStatus") AND ("expiresAt" IS NULL)))),
    CONSTRAINT "FriendRequest_revision_check" CHECK (((revision >= 0) AND ("requesterUserId" <> "targetUserId")))
);


--
-- Name: FriendRequest_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."FriendRequest_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: FriendRequest_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."FriendRequest_id_seq" OWNED BY public."FriendRequest".id;


--
-- Name: Group; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Group" (
    id integer NOT NULL,
    "groupUserId" integer NOT NULL,
    "ownerId" integer NOT NULL,
    "rosterRev" integer DEFAULT 0 NOT NULL,
    "remoteRosterRev" integer,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "dissolvedAt" timestamp(3) without time zone,
    "membersCanInvite" boolean DEFAULT true NOT NULL
);


--
-- Name: GroupMembershipPair; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."GroupMembershipPair" (
    "groupUserId" integer NOT NULL,
    "memberUserId" integer NOT NULL,
    active boolean DEFAULT false NOT NULL,
    role public."GroupRole" DEFAULT 'MEMBER'::public."GroupRole" NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "GroupMembershipPair_revision_check" CHECK ((revision >= 0))
);


--
-- Name: GroupMembershipRequest; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."GroupMembershipRequest" (
    "groupUserId" integer NOT NULL,
    "memberUserId" integer NOT NULL,
    direction public."GroupMembershipDirection" NOT NULL,
    status public."GroupMembershipRequestStatus" NOT NULL,
    note character varying(255) DEFAULT ''::character varying NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    "requestedAt" timestamp(3) without time zone,
    "expiresAt" timestamp(3) without time zone,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    id bigint NOT NULL,
    CONSTRAINT "GroupMembershipRequest_expiry_check" CHECK ((((status = 'REQUESTED'::public."GroupMembershipRequestStatus") AND ("requestedAt" IS NOT NULL) AND ("expiresAt" IS NOT NULL) AND ("expiresAt" > "requestedAt") AND ("expiresAt" <= ("requestedAt" + '7 days'::interval))) OR ((status <> 'REQUESTED'::public."GroupMembershipRequestStatus") AND ("expiresAt" IS NULL)))),
    CONSTRAINT "GroupMembershipRequest_revision_check" CHECK (((revision >= 0) AND ("groupUserId" <> "memberUserId")))
);


--
-- Name: GroupMembershipRequest_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."GroupMembershipRequest_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: GroupMembershipRequest_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."GroupMembershipRequest_id_seq" OWNED BY public."GroupMembershipRequest".id;


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
-- Name: LinkCardRule; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."LinkCardRule" (
    id integer NOT NULL,
    hostname character varying(255) NOT NULL,
    note character varying(100),
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "imageSelection" character varying(5) DEFAULT 'first'::character varying NOT NULL,
    "descriptionSelection" character varying(5) DEFAULT 'first'::character varying NOT NULL,
    CONSTRAINT "LinkCardRule_descriptionSelection_check" CHECK ((("descriptionSelection")::text = ANY ((ARRAY['first'::character varying, 'last'::character varying])::text[]))),
    CONSTRAINT "LinkCardRule_imageSelection_check" CHECK ((("imageSelection")::text = ANY ((ARRAY['first'::character varying, 'last'::character varying])::text[])))
);


--
-- Name: LinkCardRule_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."LinkCardRule_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: LinkCardRule_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."LinkCardRule_id_seq" OWNED BY public."LinkCardRule".id;


--
-- Name: LocalFederationIdentity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."LocalFederationIdentity" (
    domain character varying(63) NOT NULL,
    "rootKeyFingerprint" character varying(80) NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: LoginCode; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."LoginCode" (
    id integer NOT NULL,
    "userId" integer NOT NULL,
    "codeHash" character varying(127) NOT NULL,
    "issuedBy" integer NOT NULL,
    "issuedAt" timestamp(3) without time zone NOT NULL,
    "expiresAt" timestamp(3) without time zone NOT NULL,
    "consumedAt" timestamp(3) without time zone,
    "consumedIp" character varying(64),
    "consumedDevice" character varying(127),
    "producedSessionId" integer,
    "revokedAt" timestamp(3) without time zone
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
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "isDeleted" boolean DEFAULT false NOT NULL
);


--
-- Name: MemberProfileStateRevision; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."MemberProfileStateRevision" (
    "userId" integer NOT NULL,
    "sourcePeerDomain" character varying(63) NOT NULL,
    "memberAccount" character varying(31) NOT NULL,
    "memberDomain" character varying(63) NOT NULL,
    revision integer NOT NULL,
    CONSTRAINT "MemberProfileStateRevision_revision_check" CHECK ((revision > 0))
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
    creator integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "isDeleted" boolean DEFAULT false NOT NULL,
    "clientMessageId" character varying(36),
    "originSeq" integer,
    "originServerTime" timestamp(3) without time zone,
    "federationAuthoredSnapshot" jsonb,
    CONSTRAINT "Message_origin_seq_check" CHECK (("originSeq" IS NULL OR "originSeq" > 0)),
    CONSTRAINT "Message_seq_check" CHECK ((seq > 0))
);


--
-- Name: MessageAsset; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."MessageAsset" (
    "messageId" bigint NOT NULL,
    "threadId" integer NOT NULL,
    digest character varying(64) NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
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
    "reviewedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
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
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "curSeq" integer DEFAULT 0 NOT NULL,
    "lastMessageSeq" integer,
    "lastMessagePreview" character varying(255),
    "lastMessageAt" timestamp(3) without time zone,
    "groupUserId" integer,
    "pullUntil" integer DEFAULT 0 NOT NULL,
    "federationTruncated" boolean DEFAULT false NOT NULL,
    "federationVersion" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "MessageThread_federationVersion_check" CHECK (("federationVersion" >= 0)),
    CONSTRAINT "MessageThread_groupUserId_type_check" CHECK (("federationTruncated" OR ((type = 'P2P'::public."MessageThreadType") = ("groupUserId" IS NULL))))
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
-- Name: CONSTRAINT "MessageThread_groupUserId_type_check" ON "MessageThread"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON CONSTRAINT "MessageThread_groupUserId_type_check" ON public."MessageThread" IS 'A truncated federation thread is an inert retained shell and no longer owns a group user.';


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
    revision integer NOT NULL,
    rev bigint NOT NULL,
    body jsonb NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    domain character varying(63) NOT NULL,
    "subjectDomain" character varying(63) DEFAULT ''::character varying NOT NULL,
    CONSTRAINT "PeerStateFeed_rev_check" CHECK ((rev > 0)),
    CONSTRAINT "PeerStateFeed_revision_check" CHECK ((revision >= 0)),
    CONSTRAINT "PeerStateFeed_subject_check" CHECK (((("eventType" = ANY (ARRAY['P2P_INTENT'::public."PeerStateEventType", 'GROUP_INVITE_INTENT'::public."PeerStateEventType", 'GROUP_JOIN_INTENT'::public."PeerStateEventType"])) AND (("subjectAccount")::text <> ''::text) AND (("subjectDomain")::text <> ''::text)) OR (("eventType" <> ALL (ARRAY['P2P_INTENT'::public."PeerStateEventType", 'GROUP_INVITE_INTENT'::public."PeerStateEventType", 'GROUP_JOIN_INTENT'::public."PeerStateEventType"])) AND (("subjectAccount")::text = ''::text) AND (("subjectDomain")::text = ''::text))))
);


--
-- Name: PeerStateFeedPullCursor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."PeerStateFeedPullCursor" (
    "peerDomain" character varying(63) NOT NULL,
    "committedThrough" bigint DEFAULT 0 NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    initialized boolean DEFAULT false NOT NULL,
    CONSTRAINT "PeerStateFeedPullCursor_committedThrough_check" CHECK (("committedThrough" >= 0))
);


--
-- Name: PeerStateFeedTarget; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."PeerStateFeedTarget" (
    "peerDomain" character varying(63) NOT NULL,
    "allocatedThrough" bigint DEFAULT 0 NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "PeerStateFeedTarget_allocatedThrough_check" CHECK (("allocatedThrough" >= 0))
);


--
-- Name: PendingMedia; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."PendingMedia" (
    id bigint NOT NULL,
    "threadId" integer NOT NULL,
    "creatorId" integer NOT NULL,
    "contentType" public."ContentType" NOT NULL,
    content text NOT NULL,
    digest character varying(64),
    "clientMessageId" character varying(36),
    "originSeq" integer,
    status character varying(12) DEFAULT 'pending'::character varying NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "failReason" character varying(255),
    direction public."FileSyncDirection" DEFAULT 'OUTBOUND'::public."FileSyncDirection" NOT NULL,
    "batchId" uuid DEFAULT gen_random_uuid() NOT NULL,
    "fileCnt" integer DEFAULT 1 NOT NULL,
    "anyFailed" boolean DEFAULT false NOT NULL,
    "originDomain" character varying(63),
    "expectedFederationVersion" integer,
    "federationAuthoredSnapshot" jsonb,
    CONSTRAINT "PendingMedia_origin_seq_check" CHECK (("originSeq" IS NULL OR "originSeq" > 0))
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
-- Name: ProfileStateRevision; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ProfileStateRevision" (
    "userId" integer NOT NULL,
    "subjectUserId" integer NOT NULL,
    revision integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "ProfileStateRevision_revision_check" CHECK ((revision > 0))
);


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
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "lastSeenAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
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
-- Name: S2SKeyCache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."S2SKeyCache" (
    domain character varying(63) NOT NULL,
    "keyId" character varying(127) NOT NULL,
    "publicKey" character varying(127) NOT NULL,
    "fetchedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "notBefore" timestamp(3) without time zone NOT NULL,
    "notAfter" timestamp(3) without time zone NOT NULL,
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
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "expiresAt" timestamp(3) without time zone NOT NULL,
    "lastSeenAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "revokedAt" timestamp(3) without time zone,
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
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: ThreadAudience; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ThreadAudience" (
    id bigint NOT NULL,
    "targetDomain" character varying(63) NOT NULL,
    "localUserId" integer,
    "threadId" integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "messageScannedThroughSeq" integer,
    CONSTRAINT "ThreadAudience_messageScannedThroughSeq_check" CHECK ((("messageScannedThroughSeq" IS NULL) OR ("messageScannedThroughSeq" >= 0))),
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
-- Name: ThreadParticipant; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ThreadParticipant" (
    id integer NOT NULL,
    "userId" integer NOT NULL,
    "threadId" integer NOT NULL,
    "lastReadSeq" integer,
    role public."GroupRole",
    "joinedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    muted boolean DEFAULT false NOT NULL,
    pinned boolean DEFAULT false NOT NULL,
    "pinnedAt" timestamp(3) without time zone,
    alias character varying(64),
    "leftAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "clearedSeq" integer,
    "readRevision" integer DEFAULT 0 NOT NULL,
    "recognizesFriend" boolean DEFAULT true NOT NULL,
    "relationshipRev" integer DEFAULT 0 NOT NULL,
    blocked boolean DEFAULT false NOT NULL,
    CONSTRAINT "ThreadParticipant_cleared_seq_check" CHECK ((("clearedSeq" IS NULL) OR ("clearedSeq" >= 0))),
    CONSTRAINT "ThreadParticipant_relationship_rev_check" CHECK (("relationshipRev" >= 0))
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
-- Name: ThreadRevision; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ThreadRevision" (
    id bigint NOT NULL,
    "userId" integer NOT NULL,
    "threadId" integer NOT NULL,
    direction public."ThreadRevisionDirection" NOT NULL,
    revision integer NOT NULL,
    "isDelete" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: ThreadRevision_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."ThreadRevision_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ThreadRevision_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."ThreadRevision_id_seq" OWNED BY public."ThreadRevision".id;


--
-- Name: TwoFactorBackupCode; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."TwoFactorBackupCode" (
    id bigint NOT NULL,
    "adminId" integer NOT NULL,
    "codeHash" character varying(64) NOT NULL,
    "consumedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
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
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "completedAt" timestamp(3) without time zone,
    "abortedAt" timestamp(3) without time zone,
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
    "hashPwd" character varying(127),
    name text NOT NULL,
    avatar text DEFAULT ''::text NOT NULL,
    bio character varying(255) DEFAULT ''::character varying NOT NULL,
    "isForeigner" boolean NOT NULL,
    "isGroup" boolean DEFAULT false NOT NULL,
    domain character varying(63) DEFAULT 'local'::character varying NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "isDeleted" boolean DEFAULT false NOT NULL,
    "profileRev" integer DEFAULT 0 NOT NULL,
    "remoteProfileRev" integer,
    "threadRevision" integer DEFAULT 0 NOT NULL,
    "mustChangePassword" boolean DEFAULT false NOT NULL,
    "readRevision" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "User_isGroup_sigil_check" CHECK ((((account)::text ~~ '!%'::text) = "isGroup"))
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
    "subjectDomain" character varying(63) DEFAULT ''::character varying NOT NULL,
    "businessRevision" integer NOT NULL,
    revision integer NOT NULL,
    body jsonb NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "ClientStateFeed_pkey" PRIMARY KEY ("userId", account, domain, "eventType", "subjectAccount", "subjectDomain"),
    CONSTRAINT "ClientStateFeed_business_revision_check" CHECK (("businessRevision" >= 0)),
    CONSTRAINT "ClientStateFeed_revision_check" CHECK ((revision > 0))
);

CREATE INDEX "ClientStateFeed_user_revision_idx" ON public."ClientStateFeed" USING btree ("userId", revision);


--
-- Name: UserPreference; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."UserPreference" (
    "userId" integer NOT NULL,
    key character varying(100) NOT NULL,
    value jsonb NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
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
    CONSTRAINT "UserQuotaDailyUsage_category_check" CHECK (((category)::text = ANY ((ARRAY['messages'::character varying, 'images'::character varying, 'largeFiles'::character varying, 'requests'::character varying, 'files'::character varying])::text[]))),
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
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
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
    "lastUsedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
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
-- Name: DeletedMessage id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DeletedMessage" ALTER COLUMN id SET DEFAULT nextval('public."DeletedMessage_id_seq"'::regclass);


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
-- Name: FileSyncProgress id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FileSyncProgress" ALTER COLUMN id SET DEFAULT nextval('public."FileSyncProgress_id_seq"'::regclass);


--
-- Name: FriendRequest id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FriendRequest" ALTER COLUMN id SET DEFAULT nextval('public."FriendRequest_id_seq"'::regclass);


--
-- Name: Group id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Group" ALTER COLUMN id SET DEFAULT nextval('public."Group_id_seq"'::regclass);


--
-- Name: GroupMembershipRequest id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GroupMembershipRequest" ALTER COLUMN id SET DEFAULT nextval('public."GroupMembershipRequest_id_seq"'::regclass);


--
-- Name: LinkCardRule id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."LinkCardRule" ALTER COLUMN id SET DEFAULT nextval('public."LinkCardRule_id_seq"'::regclass);


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
-- Name: SessionToken id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SessionToken" ALTER COLUMN id SET DEFAULT nextval('public."SessionToken_id_seq"'::regclass);


--
-- Name: ThreadAudience id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ThreadAudience" ALTER COLUMN id SET DEFAULT nextval('public."ThreadAudience_id_seq"'::regclass);


--
-- Name: ThreadParticipant id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ThreadParticipant" ALTER COLUMN id SET DEFAULT nextval('public."ThreadParticipant_id_seq"'::regclass);


--
-- Name: ThreadRevision id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ThreadRevision" ALTER COLUMN id SET DEFAULT nextval('public."ThreadRevision_id_seq"'::regclass);


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
-- Name: DeletedMessage DeletedMessage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DeletedMessage"
    ADD CONSTRAINT "DeletedMessage_pkey" PRIMARY KEY (id);


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
-- Name: FederatedMemberProfile FederatedMemberProfile_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederatedMemberProfile"
    ADD CONSTRAINT "FederatedMemberProfile_pkey" PRIMARY KEY ("sourcePeerDomain", "memberAccount", "memberDomain");


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
-- Name: FederatedProfile FederatedProfile_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederatedProfile"
    ADD CONSTRAINT "FederatedProfile_pkey" PRIMARY KEY (domain, account);


--
-- Name: FederationDeletedCursor FederationDeletedCursor_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationDeletedCursor"
    ADD CONSTRAINT "FederationDeletedCursor_pkey" PRIMARY KEY (id);


--
-- Name: FederationMemberProfilePublication FederationMemberProfilePublication_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationMemberProfilePublication"
    ADD CONSTRAINT "FederationMemberProfilePublication_pkey" PRIMARY KEY ("targetPeerDomain", "memberAccount", "memberDomain");


--
-- Name: FederationMemberProfileSource FederationMemberProfileSource_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationMemberProfileSource"
    ADD CONSTRAINT "FederationMemberProfileSource_pkey" PRIMARY KEY ("targetPeerDomain", "memberAccount", "memberDomain", "threadId");


--
-- Name: FederationMessageFeedIndex FederationMessageFeedIndex_peerDomain_feedId_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationMessageFeedIndex"
    ADD CONSTRAINT "FederationMessageFeedIndex_peerDomain_feedId_key" UNIQUE ("peerDomain", "feedId");


--
-- Name: FederationMessageFeedIndex FederationMessageFeedIndex_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationMessageFeedIndex"
    ADD CONSTRAINT "FederationMessageFeedIndex_pkey" PRIMARY KEY ("peerDomain", "threadId");


--
-- Name: FederationMessageQueryCursor FederationMessageQueryCursor_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationMessageQueryCursor"
    ADD CONSTRAINT "FederationMessageQueryCursor_pkey" PRIMARY KEY ("peerDomain", "threadKey");


--
-- Name: FederationPullCursor FederationPullCursor_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationPullCursor"
    ADD CONSTRAINT "FederationPullCursor_pkey" PRIMARY KEY ("peerDomain");


--
-- Name: FederationServeCursor FederationServeCursor_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationServeCursor"
    ADD CONSTRAINT "FederationServeCursor_pkey" PRIMARY KEY ("peerDomain");


--
-- Name: FederationTombstoneFeedIndex FederationTombstoneFeedIndex_peerDomain_feedId_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationTombstoneFeedIndex"
    ADD CONSTRAINT "FederationTombstoneFeedIndex_peerDomain_feedId_key" UNIQUE ("peerDomain", "feedId");


--
-- Name: FederationTombstoneFeedIndex FederationTombstoneFeedIndex_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationTombstoneFeedIndex"
    ADD CONSTRAINT "FederationTombstoneFeedIndex_pkey" PRIMARY KEY ("peerDomain", "threadId");


--
-- Name: FederationTombstonePullCursor FederationTombstonePullCursor_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationTombstonePullCursor"
    ADD CONSTRAINT "FederationTombstonePullCursor_pkey" PRIMARY KEY ("peerDomain");


--
-- Name: FederationTombstoneQueryCursor FederationTombstoneQueryCursor_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationTombstoneQueryCursor"
    ADD CONSTRAINT "FederationTombstoneQueryCursor_pkey" PRIMARY KEY ("peerDomain", "threadKey");


--
-- Name: FederationTombstoneServeCursor FederationTombstoneServeCursor_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationTombstoneServeCursor"
    ADD CONSTRAINT "FederationTombstoneServeCursor_pkey" PRIMARY KEY ("peerDomain");


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
-- Name: FriendPair FriendPair_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FriendPair"
    ADD CONSTRAINT "FriendPair_pkey" PRIMARY KEY ("userLowId", "userHighId");


--
-- Name: FriendRequest FriendRequest_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FriendRequest"
    ADD CONSTRAINT "FriendRequest_pkey" PRIMARY KEY ("requesterUserId", "targetUserId");


--
-- Name: GroupMembershipPair GroupMembershipPair_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GroupMembershipPair"
    ADD CONSTRAINT "GroupMembershipPair_pkey" PRIMARY KEY ("groupUserId", "memberUserId");


--
-- Name: GroupMembershipRequest GroupMembershipRequest_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GroupMembershipRequest"
    ADD CONSTRAINT "GroupMembershipRequest_pkey" PRIMARY KEY ("groupUserId", "memberUserId", direction);


--
-- Name: Group Group_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Group"
    ADD CONSTRAINT "Group_pkey" PRIMARY KEY (id);


--
-- Name: LinkCardRule LinkCardRule_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."LinkCardRule"
    ADD CONSTRAINT "LinkCardRule_pkey" PRIMARY KEY (id);


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
-- Name: MemberProfileStateRevision MemberProfileStateRevision_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MemberProfileStateRevision"
    ADD CONSTRAINT "MemberProfileStateRevision_pkey" PRIMARY KEY ("userId", "sourcePeerDomain", "memberAccount", "memberDomain");


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
-- Name: ProfileStateRevision ProfileStateRevision_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ProfileStateRevision"
    ADD CONSTRAINT "ProfileStateRevision_pkey" PRIMARY KEY ("userId", "subjectUserId");


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
-- Name: ThreadParticipant ThreadParticipant_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ThreadParticipant"
    ADD CONSTRAINT "ThreadParticipant_pkey" PRIMARY KEY (id);


--
-- Name: ThreadRevision ThreadRevision_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ThreadRevision"
    ADD CONSTRAINT "ThreadRevision_pkey" PRIMARY KEY (id);


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
-- Name: DeletedMessage_threadId_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "DeletedMessage_threadId_id_idx" ON public."DeletedMessage" USING btree ("threadId", id);


--
-- Name: DeletedMessage_threadId_seq_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "DeletedMessage_threadId_seq_key" ON public."DeletedMessage" USING btree ("threadId", seq);


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

CREATE UNIQUE INDEX "FederatedMessageTombstone_source_event_key" ON public."FederatedMessageTombstone" USING btree ("sourceDomain", "remoteDeletedId");


--
-- Name: FederatedMessageTombstone_target_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "FederatedMessageTombstone_target_key" ON public."FederatedMessageTombstone" USING btree ("threadId", "creatorId", "originSeq");


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
-- Name: FederationMemberProfileSource_member_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "FederationMemberProfileSource_member_idx" ON public."FederationMemberProfileSource" USING btree ("targetPeerDomain", "memberDomain", "memberAccount");


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
-- Name: FriendRequest_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "FriendRequest_id_key" ON public."FriendRequest" USING btree (id);


--
-- Name: GroupMembershipRequest_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "GroupMembershipRequest_id_key" ON public."GroupMembershipRequest" USING btree (id);


--
-- Name: Group_groupUserId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Group_groupUserId_key" ON public."Group" USING btree ("groupUserId");


--
-- Name: Group_ownerId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Group_ownerId_idx" ON public."Group" USING btree ("ownerId");


--
-- Name: LinkCardRule_hostname_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "LinkCardRule_hostname_key" ON public."LinkCardRule" USING btree (hostname);


--
-- Name: LoginCode_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "LoginCode_userId_idx" ON public."LoginCode" USING btree ("userId");


--
-- Name: MediaAsset_isDeleted_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "MediaAsset_isDeleted_idx" ON public."MediaAsset" USING btree ("isDeleted");


--
-- Name: MemberProfileStateRevision_user_revision_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "MemberProfileStateRevision_user_revision_idx" ON public."MemberProfileStateRevision" USING btree ("userId", revision);


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
-- Name: MessageThread_groupUserId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "MessageThread_groupUserId_key" ON public."MessageThread" USING btree ("groupUserId");


--
-- Name: Message_clientMessageId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Message_clientMessageId_key" ON public."Message" USING btree ("clientMessageId");


--
-- Name: Message_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Message_createdAt_idx" ON public."Message" USING btree ("createdAt");


--
-- Name: Message_creator_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Message_creator_idx" ON public."Message" USING btree (creator);


--
-- Name: Message_threadId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Message_threadId_createdAt_idx" ON public."Message" USING btree ("threadId", "createdAt");


--
-- Name: Message_threadId_creator_originSeq_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Message_threadId_creator_originSeq_key" ON public."Message" USING btree ("threadId", creator, "originSeq");


--
-- Name: Message_threadId_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Message_threadId_id_idx" ON public."Message" USING btree ("threadId", id);


--
-- Name: Message_threadId_seq_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Message_threadId_seq_key" ON public."Message" USING btree ("threadId", seq);


--
-- Name: PeerStateFeed_peerDomain_rev_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "PeerStateFeed_peerDomain_rev_key" ON public."PeerStateFeed" USING btree ("peerDomain", rev);


--
-- Name: PendingMedia_batchId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PendingMedia_batchId_idx" ON public."PendingMedia" USING btree ("batchId");


--
-- Name: PendingMedia_clientMessageId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "PendingMedia_clientMessageId_key" ON public."PendingMedia" USING btree ("clientMessageId");


--
-- Name: PendingMedia_status_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PendingMedia_status_createdAt_idx" ON public."PendingMedia" USING btree (status, "createdAt");


--
-- Name: PendingMedia_threadId_creatorId_originSeq_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "PendingMedia_threadId_creatorId_originSeq_key" ON public."PendingMedia" USING btree ("threadId", "creatorId", "originSeq");


--
-- Name: PendingMedia_threadId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PendingMedia_threadId_idx" ON public."PendingMedia" USING btree ("threadId");


--
-- Name: ProfileStateRevision_userId_revision_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ProfileStateRevision_userId_revision_idx" ON public."ProfileStateRevision" USING btree ("userId", revision);


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
-- Name: ThreadParticipant_one_active_group_owner_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ThreadParticipant_one_active_group_owner_key" ON public."ThreadParticipant" USING btree ("threadId") WHERE ((role = 'OWNER'::public."GroupRole") AND ("leftAt" IS NULL));


--
-- Name: ThreadParticipant_threadId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ThreadParticipant_threadId_idx" ON public."ThreadParticipant" USING btree ("threadId");


--
-- Name: ThreadParticipant_threadId_joinedAt_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ThreadParticipant_threadId_joinedAt_active_idx" ON public."ThreadParticipant" USING btree ("threadId", "joinedAt") WHERE ("leftAt" IS NULL);


--
-- Name: ThreadParticipant_userId_pinned_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ThreadParticipant_userId_pinned_idx" ON public."ThreadParticipant" USING btree ("userId", pinned);


--
-- Name: ThreadParticipant_userId_readRevision_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ThreadParticipant_userId_readRevision_idx" ON public."ThreadParticipant" USING btree ("userId", "readRevision");


--
-- Name: ThreadParticipant_userId_threadId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ThreadParticipant_userId_threadId_key" ON public."ThreadParticipant" USING btree ("userId", "threadId");


--
-- Name: ThreadRevision_userId_revision_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ThreadRevision_userId_revision_idx" ON public."ThreadRevision" USING btree ("userId", revision);


--
-- Name: ThreadRevision_userId_threadId_direction_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ThreadRevision_userId_threadId_direction_key" ON public."ThreadRevision" USING btree ("userId", "threadId", direction);


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
-- Name: User_account_domain_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "User_account_domain_key" ON public."User" USING btree (account, domain);


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
    ADD CONSTRAINT "Admin_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: DeletedMessage DeletedMessage_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DeletedMessage"
    ADD CONSTRAINT "DeletedMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: DiagnosticsReport DiagnosticsReport_reporterUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DiagnosticsReport"
    ADD CONSTRAINT "DiagnosticsReport_reporterUserId_fkey" FOREIGN KEY ("reporterUserId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: FederatedFriendRequest FederatedFriendRequest_localUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederatedFriendRequest"
    ADD CONSTRAINT "FederatedFriendRequest_localUserId_fkey" FOREIGN KEY ("localUserId") REFERENCES public."User"(id) ON DELETE CASCADE;


--
-- Name: FederatedFriendRequest FederatedFriendRequest_remoteDomain_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederatedFriendRequest"
    ADD CONSTRAINT "FederatedFriendRequest_remoteDomain_fkey" FOREIGN KEY ("remoteDomain") REFERENCES public."FederatedPeer"(domain) ON DELETE CASCADE;


--
-- Name: FederatedMemberProfile FederatedMemberProfile_sourcePeerDomain_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederatedMemberProfile"
    ADD CONSTRAINT "FederatedMemberProfile_sourcePeerDomain_fkey" FOREIGN KEY ("sourcePeerDomain") REFERENCES public."FederatedPeer"(domain) ON DELETE CASCADE;


--
-- Name: FederatedMessageTombstone FederatedMessageTombstone_creatorId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederatedMessageTombstone"
    ADD CONSTRAINT "FederatedMessageTombstone_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: FederatedMessageTombstone FederatedMessageTombstone_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederatedMessageTombstone"
    ADD CONSTRAINT "FederatedMessageTombstone_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: FederatedProfile FederatedProfile_domain_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederatedProfile"
    ADD CONSTRAINT "FederatedProfile_domain_fkey" FOREIGN KEY (domain) REFERENCES public."FederatedPeer"(domain) ON DELETE CASCADE;


--
-- Name: FederationDeletedCursor FederationDeletedCursor_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationDeletedCursor"
    ADD CONSTRAINT "FederationDeletedCursor_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: FederationMemberProfilePublication FederationMemberProfilePublication_targetPeerDomain_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationMemberProfilePublication"
    ADD CONSTRAINT "FederationMemberProfilePublication_targetPeerDomain_fkey" FOREIGN KEY ("targetPeerDomain") REFERENCES public."FederatedPeer"(domain) ON DELETE CASCADE;


--
-- Name: FederationMemberProfileSource FederationMemberProfileSource_targetPeerDomain_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationMemberProfileSource"
    ADD CONSTRAINT "FederationMemberProfileSource_targetPeerDomain_fkey" FOREIGN KEY ("targetPeerDomain") REFERENCES public."FederatedPeer"(domain) ON DELETE CASCADE;


--
-- Name: FederationMemberProfileSource FederationMemberProfileSource_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationMemberProfileSource"
    ADD CONSTRAINT "FederationMemberProfileSource_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON DELETE CASCADE;


--
-- Name: FederationMessageFeedIndex FederationMessageFeedIndex_peerDomain_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationMessageFeedIndex"
    ADD CONSTRAINT "FederationMessageFeedIndex_peerDomain_fkey" FOREIGN KEY ("peerDomain") REFERENCES public."FederatedPeer"(domain) ON DELETE CASCADE;


--
-- Name: FederationMessageFeedIndex FederationMessageFeedIndex_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationMessageFeedIndex"
    ADD CONSTRAINT "FederationMessageFeedIndex_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON DELETE RESTRICT;


--
-- Name: FederationMessageQueryCursor FederationMessageQueryCursor_peerDomain_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationMessageQueryCursor"
    ADD CONSTRAINT "FederationMessageQueryCursor_peerDomain_fkey" FOREIGN KEY ("peerDomain") REFERENCES public."FederatedPeer"(domain) ON DELETE CASCADE;


--
-- Name: FederationPullCursor FederationPullCursor_peerDomain_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationPullCursor"
    ADD CONSTRAINT "FederationPullCursor_peerDomain_fkey" FOREIGN KEY ("peerDomain") REFERENCES public."FederatedPeer"(domain) ON DELETE CASCADE;


--
-- Name: FederationServeCursor FederationServeCursor_peerDomain_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationServeCursor"
    ADD CONSTRAINT "FederationServeCursor_peerDomain_fkey" FOREIGN KEY ("peerDomain") REFERENCES public."FederatedPeer"(domain) ON DELETE CASCADE;


--
-- Name: FederationTombstoneFeedIndex FederationTombstoneFeedIndex_peerDomain_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationTombstoneFeedIndex"
    ADD CONSTRAINT "FederationTombstoneFeedIndex_peerDomain_fkey" FOREIGN KEY ("peerDomain") REFERENCES public."FederatedPeer"(domain) ON DELETE CASCADE;


--
-- Name: FederationTombstoneFeedIndex FederationTombstoneFeedIndex_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationTombstoneFeedIndex"
    ADD CONSTRAINT "FederationTombstoneFeedIndex_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON DELETE RESTRICT;


--
-- Name: FederationTombstonePullCursor FederationTombstonePullCursor_peerDomain_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationTombstonePullCursor"
    ADD CONSTRAINT "FederationTombstonePullCursor_peerDomain_fkey" FOREIGN KEY ("peerDomain") REFERENCES public."FederatedPeer"(domain) ON DELETE CASCADE;


--
-- Name: FederationTombstoneQueryCursor FederationTombstoneQueryCursor_peerDomain_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationTombstoneQueryCursor"
    ADD CONSTRAINT "FederationTombstoneQueryCursor_peerDomain_fkey" FOREIGN KEY ("peerDomain") REFERENCES public."FederatedPeer"(domain) ON DELETE CASCADE;


--
-- Name: FederationTombstoneServeCursor FederationTombstoneServeCursor_peerDomain_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FederationTombstoneServeCursor"
    ADD CONSTRAINT "FederationTombstoneServeCursor_peerDomain_fkey" FOREIGN KEY ("peerDomain") REFERENCES public."FederatedPeer"(domain) ON DELETE CASCADE;


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
-- Name: FriendPair FriendPair_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FriendPair"
    ADD CONSTRAINT "FriendPair_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON DELETE SET NULL;


--
-- Name: FriendPair FriendPair_userHighId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FriendPair"
    ADD CONSTRAINT "FriendPair_userHighId_fkey" FOREIGN KEY ("userHighId") REFERENCES public."User"(id) ON DELETE CASCADE;


--
-- Name: FriendPair FriendPair_userLowId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FriendPair"
    ADD CONSTRAINT "FriendPair_userLowId_fkey" FOREIGN KEY ("userLowId") REFERENCES public."User"(id) ON DELETE CASCADE;


--
-- Name: FriendRequest FriendRequest_requesterUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FriendRequest"
    ADD CONSTRAINT "FriendRequest_requesterUserId_fkey" FOREIGN KEY ("requesterUserId") REFERENCES public."User"(id) ON DELETE CASCADE;


--
-- Name: FriendRequest FriendRequest_targetUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FriendRequest"
    ADD CONSTRAINT "FriendRequest_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES public."User"(id) ON DELETE CASCADE;


--
-- Name: GroupMembershipPair GroupMembershipPair_groupUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GroupMembershipPair"
    ADD CONSTRAINT "GroupMembershipPair_groupUserId_fkey" FOREIGN KEY ("groupUserId") REFERENCES public."User"(id) ON DELETE CASCADE;


--
-- Name: GroupMembershipPair GroupMembershipPair_memberUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GroupMembershipPair"
    ADD CONSTRAINT "GroupMembershipPair_memberUserId_fkey" FOREIGN KEY ("memberUserId") REFERENCES public."User"(id) ON DELETE CASCADE;


--
-- Name: GroupMembershipRequest GroupMembershipRequest_groupUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GroupMembershipRequest"
    ADD CONSTRAINT "GroupMembershipRequest_groupUserId_fkey" FOREIGN KEY ("groupUserId") REFERENCES public."User"(id) ON DELETE CASCADE;


--
-- Name: GroupMembershipRequest GroupMembershipRequest_memberUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GroupMembershipRequest"
    ADD CONSTRAINT "GroupMembershipRequest_memberUserId_fkey" FOREIGN KEY ("memberUserId") REFERENCES public."User"(id) ON DELETE CASCADE;


--
-- Name: Group Group_groupUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Group"
    ADD CONSTRAINT "Group_groupUserId_fkey" FOREIGN KEY ("groupUserId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: LoginCode LoginCode_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."LoginCode"
    ADD CONSTRAINT "LoginCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: MemberProfileStateRevision MemberProfileStateRevision_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MemberProfileStateRevision"
    ADD CONSTRAINT "MemberProfileStateRevision_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON DELETE CASCADE;


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
    ADD CONSTRAINT "MessageReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


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
-- Name: MessageThread MessageThread_groupUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MessageThread"
    ADD CONSTRAINT "MessageThread_groupUserId_fkey" FOREIGN KEY ("groupUserId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Message Message_creator_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Message"
    ADD CONSTRAINT "Message_creator_fkey" FOREIGN KEY (creator) REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


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
-- Name: PendingMedia PendingMedia_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PendingMedia"
    ADD CONSTRAINT "PendingMedia_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: ProfileStateRevision ProfileStateRevision_subjectUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ProfileStateRevision"
    ADD CONSTRAINT "ProfileStateRevision_subjectUserId_fkey" FOREIGN KEY ("subjectUserId") REFERENCES public."User"(id) ON DELETE CASCADE;


--
-- Name: ProfileStateRevision ProfileStateRevision_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ProfileStateRevision"
    ADD CONSTRAINT "ProfileStateRevision_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON DELETE CASCADE;


--
-- Name: PushToken PushToken_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PushToken"
    ADD CONSTRAINT "PushToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: SessionToken SessionToken_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SessionToken"
    ADD CONSTRAINT "SessionToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: ThreadAudience ThreadAudience_localUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ThreadAudience"
    ADD CONSTRAINT "ThreadAudience_localUserId_fkey" FOREIGN KEY ("localUserId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ThreadAudience ThreadAudience_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ThreadAudience"
    ADD CONSTRAINT "ThreadAudience_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ThreadParticipant ThreadParticipant_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ThreadParticipant"
    ADD CONSTRAINT "ThreadParticipant_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: ThreadParticipant ThreadParticipant_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ThreadParticipant"
    ADD CONSTRAINT "ThreadParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: ThreadRevision ThreadRevision_threadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ThreadRevision"
    ADD CONSTRAINT "ThreadRevision_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ThreadRevision ThreadRevision_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ThreadRevision"
    ADD CONSTRAINT "ThreadRevision_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: TwoFactorBackupCode TwoFactorBackupCode_adminId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."TwoFactorBackupCode"
    ADD CONSTRAINT "TwoFactorBackupCode_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES public."Admin"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: UploadSession UploadSession_creatorId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UploadSession"
    ADD CONSTRAINT "UploadSession_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: ClientStateFeed ClientStateFeed_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientStateFeed"
    ADD CONSTRAINT "ClientStateFeed_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON DELETE CASCADE;


--
-- Name: UserPreference UserPreference_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserPreference"
    ADD CONSTRAINT "UserPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: UserQuotaDailyAllowance UserQuotaDailyAllowance_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserQuotaDailyAllowance"
    ADD CONSTRAINT "UserQuotaDailyAllowance_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON DELETE CASCADE;


--
-- Name: UserQuotaDailyUsage UserQuotaDailyUsage_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserQuotaDailyUsage"
    ADD CONSTRAINT "UserQuotaDailyUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON DELETE CASCADE;


--
-- Name: UserQuotaFileByteUsage UserQuotaFileByteUsage_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserQuotaFileByteUsage"
    ADD CONSTRAINT "UserQuotaFileByteUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON DELETE CASCADE;


--
-- Name: UserQuotaPolicy UserQuotaPolicy_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserQuotaPolicy"
    ADD CONSTRAINT "UserQuotaPolicy_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON DELETE CASCADE;


--
-- Name: WebAuthnCredential WebAuthnCredential_adminId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."WebAuthnCredential"
    ADD CONSTRAINT "WebAuthnCredential_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES public."Admin"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--
