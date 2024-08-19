/*
  Warnings:

  - Changed the type of `contentType` on the `Message` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "ContentType" AS ENUM ('PURE_STRING');

-- AlterTable
ALTER TABLE "Message" DROP COLUMN "contentType",
ADD COLUMN     "contentType" "ContentType" NOT NULL;

-- DropEnum
DROP TYPE "UserType";
