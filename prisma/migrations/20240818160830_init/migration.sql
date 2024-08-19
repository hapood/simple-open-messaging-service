/*
  Warnings:

  - Added the required column `selfUserId` to the `Message` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Message" DROP CONSTRAINT "Message_firendUserId_fkey";

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "selfUserId" INTEGER NOT NULL,
ADD COLUMN     "sentDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
