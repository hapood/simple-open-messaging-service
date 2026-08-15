ALTER TABLE "PendingMedia"
ADD COLUMN "originServerTime" timestamp(3);

ALTER TABLE "PendingMedia"
ADD COLUMN "federationSourceDomain" varchar(255);
