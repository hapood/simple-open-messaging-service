-- Personal and group profiles both accept names of up to 31 characters.
ALTER TABLE "Profile" ALTER COLUMN "displayName" TYPE varchar(31);
