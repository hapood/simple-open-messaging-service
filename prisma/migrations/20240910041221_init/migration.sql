/*
  Warnings:

  - You are about to drop the column `hasUrFriendReq` on the `UserExtra` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[userNotiBoxId]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `updatedAt` to the `GroupExtra` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `Notify` table without a default value. This is not possible if the table is not empty.
  - Added the required column `userNotiBoxId` to the `User` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `UserExtra` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "GroupExtra" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "Notify" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "userNotiBoxId" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "UserExtra" DROP COLUMN "hasUrFriendReq",
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- CreateTable
CREATE TABLE "userNotiBox" (
    "id" SERIAL NOT NULL,
    "hasUrFriendReq" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "userNotiBox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_userNotiBoxId_key" ON "User"("userNotiBoxId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_userNotiBoxId_fkey" FOREIGN KEY ("userNotiBoxId") REFERENCES "userNotiBox"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
