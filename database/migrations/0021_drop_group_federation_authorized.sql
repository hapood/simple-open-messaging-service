ALTER TABLE "Group" DROP CONSTRAINT "Group_local_federationAuthorized_check";
--> statement-breakpoint
ALTER TABLE "Group" DROP COLUMN "federationAuthorized";
