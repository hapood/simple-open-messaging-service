-- Every federated profile operation now returns the same complete snapshot.
-- ProfileVersion is therefore the sole immutable profile-version store.
DROP TABLE "ReferencedUserProfileVersion";
--> statement-breakpoint
ALTER TABLE "User"
  DROP CONSTRAINT "User_sourceNamespace_fkey";
--> statement-breakpoint
ALTER TABLE "User"
  DROP CONSTRAINT "User_namespace_check";
--> statement-breakpoint
ALTER TABLE "User"
  DROP CONSTRAINT "User_account_domain_sourceDomain_namespaceId_key";
--> statement-breakpoint
DROP INDEX "User_source_address_idx";
--> statement-breakpoint
ALTER TABLE "User"
  DROP COLUMN "sourceDomain";
--> statement-breakpoint
ALTER TABLE "User"
  ADD CONSTRAINT "User_account_domain_namespaceId_key"
  UNIQUE ("account", "domain", "namespaceId");
--> statement-breakpoint
CREATE INDEX "User_namespace_address_idx"
  ON "User" USING btree ("namespaceId", "account", "domain");
--> statement-breakpoint
ALTER TABLE "User"
  ADD CONSTRAINT "User_namespaceId_fkey"
  FOREIGN KEY ("namespaceId") REFERENCES "IdentityNamespace"("id")
  ON DELETE restrict ON UPDATE no action;
