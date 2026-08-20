CREATE TABLE "FederationMessageReceipt" (
  "peerDomain" varchar(63) NOT NULL,
  "threadId" integer NOT NULL,
  "peerSeq" integer NOT NULL,
  "messageId" bigint NOT NULL,
  "createdAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "FederationMessageReceipt_pkey" PRIMARY KEY ("peerDomain", "threadId", "peerSeq"),
  CONSTRAINT "FederationMessageReceipt_peerSeq_check" CHECK ("peerSeq" > 0),
  CONSTRAINT "FederationMessageReceipt_peerDomain_fkey" FOREIGN KEY ("peerDomain") REFERENCES "FederatedPeer"("domain") ON DELETE CASCADE,
  CONSTRAINT "FederationMessageReceipt_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE CASCADE,
  CONSTRAINT "FederationMessageReceipt_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE
);

CREATE INDEX "FederationMessageReceipt_messageId_idx"
ON "FederationMessageReceipt" ("messageId");
