CREATE TABLE "CallTombstone" (
  "peerDomain" varchar(253) NOT NULL,
  "callSid" varchar(36) NOT NULL,
  "terminalOp" varchar(16) NOT NULL,
  "endReason" varchar(16),
  "initialCallType" varchar(8) NOT NULL,
  "finalCallType" varchar(8) NOT NULL,
  "signalIds" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "expiresAt" timestamp with time zone NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "CallTombstone_pkey" PRIMARY KEY ("peerDomain", "callSid")
);

CREATE INDEX "CallTombstone_expiresAt_idx" ON "CallTombstone" ("expiresAt");
