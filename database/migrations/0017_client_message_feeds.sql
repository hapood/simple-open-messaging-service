CREATE TABLE "ClientMessageFeedTarget" (
  "userId" integer PRIMARY KEY NOT NULL,
  "messageAllocatedThrough" integer DEFAULT 0 NOT NULL,
  "tombstoneAllocatedThrough" integer DEFAULT 0 NOT NULL,
  "updatedAt" timestamptz(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "ClientMessageFeedTarget_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE,
  CONSTRAINT "ClientMessageFeedTarget_messageAllocatedThrough_check" CHECK ("messageAllocatedThrough" >= 0),
  CONSTRAINT "ClientMessageFeedTarget_tombstoneAllocatedThrough_check" CHECK ("tombstoneAllocatedThrough" >= 0)
);

CREATE TABLE "ClientMessageFeed" (
  "userId" integer NOT NULL,
  "threadId" integer NOT NULL,
  "feedId" integer NOT NULL,
  "messageEndSeq" integer NOT NULL,
  "updatedAt" timestamptz(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "ClientMessageFeed_pkey" PRIMARY KEY ("userId", "threadId"),
  CONSTRAINT "ClientMessageFeed_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE,
  CONSTRAINT "ClientMessageFeed_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE CASCADE,
  CONSTRAINT "ClientMessageFeed_feedId_check" CHECK ("feedId" > 0),
  CONSTRAINT "ClientMessageFeed_messageEndSeq_check" CHECK ("messageEndSeq" > 0)
);
CREATE UNIQUE INDEX "ClientMessageFeed_user_feedId_key" ON "ClientMessageFeed" ("userId", "feedId");

CREATE TABLE "ClientMessageTombstoneFeed" (
  "userId" integer NOT NULL,
  "threadId" integer NOT NULL,
  "feedId" integer NOT NULL,
  "tombstoneEndSeq" bigint NOT NULL,
  "updatedAt" timestamptz(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "ClientMessageTombstoneFeed_pkey" PRIMARY KEY ("userId", "threadId"),
  CONSTRAINT "ClientMessageTombstoneFeed_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE,
  CONSTRAINT "ClientMessageTombstoneFeed_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE CASCADE,
  CONSTRAINT "ClientMessageTombstoneFeed_feedId_check" CHECK ("feedId" > 0),
  CONSTRAINT "ClientMessageTombstoneFeed_tombstoneEndSeq_check" CHECK ("tombstoneEndSeq" > 0)
);
CREATE UNIQUE INDEX "ClientMessageTombstoneFeed_user_feedId_key" ON "ClientMessageTombstoneFeed" ("userId", "feedId");
