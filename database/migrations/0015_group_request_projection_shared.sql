-- All managers share one projection per (thread, member, direction). Per-manager
-- copies collapse into their newest row; manager-facing notification is the
-- projection fan-out task's watermark push, never a projection write.
CREATE TABLE public."GroupRequestProjection_new" (
    "threadId" integer NOT NULL,
    "memberAccount" character varying(31) NOT NULL,
    "memberDomain" character varying(63) NOT NULL,
    "memberNamespaceId" integer NOT NULL,
    "memberProfileRev" integer NOT NULL,
    direction character varying(15) NOT NULL,
    "feedId" integer NOT NULL,
    "requestId" bigint NOT NULL,
    status character varying(15) NOT NULL,
    note character varying(255) DEFAULT ''::character varying NOT NULL,
    "requestedAt" timestamp(3) with time zone NOT NULL,
    "expiresAt" timestamp(3) with time zone NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "GroupRequestProjection_new_pkey" PRIMARY KEY ("threadId", "memberAccount", "memberDomain", "memberNamespaceId", direction),
    CONSTRAINT "GroupRequestProjection_direction_check" CHECK (((direction)::text = ANY (ARRAY[('APPLICATION'::character varying)::text, ('INVITATION'::character varying)::text]))),
    CONSTRAINT "GroupRequestProjection_feedId_check" CHECK (("feedId" > 0)),
    CONSTRAINT "GroupRequestProjection_retention_check" CHECK ((("expiresAt" > "requestedAt") AND ("expiresAt" <= ("requestedAt" + '7 days'::interval)))),
    CONSTRAINT "GroupRequestProjection_status_check" CHECK (((status)::text = ANY (ARRAY[('REQUESTED'::character varying)::text, ('ACCEPTED'::character varying)::text, ('REVOKED'::character varying)::text]))),
    CONSTRAINT "GroupRequestProjection_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES public."MessageThread"("id") ON DELETE CASCADE,
    CONSTRAINT "GroupRequestProjection_memberNamespaceId_fkey" FOREIGN KEY ("memberNamespaceId") REFERENCES public."IdentityNamespace"("id") ON DELETE CASCADE
);

INSERT INTO public."GroupRequestProjection_new" (
    "threadId", "memberAccount", "memberDomain", "memberNamespaceId", "memberProfileRev",
    direction, "feedId", "requestId", status, note, "requestedAt", "expiresAt", "createdAt", "updatedAt"
)
SELECT DISTINCT ON (
    "threadId", "memberAccount", "memberDomain", "memberNamespaceId", direction)
  "threadId", "memberAccount", "memberDomain", "memberNamespaceId", "memberProfileRev",
  direction, "feedId", "requestId", status, note, "requestedAt", "expiresAt", "createdAt", "updatedAt"
FROM public."GroupRequestProjection"
ORDER BY "threadId", "memberAccount", "memberDomain", "memberNamespaceId", direction,
  "feedId" DESC, "updatedAt" DESC;

DROP TABLE public."GroupRequestProjection";
ALTER TABLE public."GroupRequestProjection_new" RENAME TO "GroupRequestProjection";
ALTER TABLE public."GroupRequestProjection"
  RENAME CONSTRAINT "GroupRequestProjection_new_pkey" TO "GroupRequestProjection_pkey";

CREATE UNIQUE INDEX "GroupRequestProjection_direction_feed_key"
  ON public."GroupRequestProjection" USING btree ("threadId", direction, "feedId");
CREATE INDEX "GroupRequestProjection_thread_feed_idx"
  ON public."GroupRequestProjection" USING btree ("threadId", "feedId");
CREATE INDEX "GroupRequestProjection_expiry_idx"
  ON public."GroupRequestProjection" USING btree ("expiresAt");
