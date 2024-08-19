/*
  Warnings:

  - A unique constraint covering the columns `[hostUserId,selfId]` on the table `Friend` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "Friend_hostUserId_selfId_key" ON "Friend"("hostUserId", "selfId");
