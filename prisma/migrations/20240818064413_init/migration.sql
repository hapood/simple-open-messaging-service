-- CreateEnum
CREATE TYPE "UserType" AS ENUM ('PURE_STRING');

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "uniqName" VARCHAR(31) NOT NULL,
    "password" VARCHAR(31),
    "isForeigner" BOOLEAN NOT NULL,
    "domain" VARCHAR(63) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Friend" (
    "id" SERIAL NOT NULL,
    "hostUserId" INTEGER NOT NULL,
    "selfId" INTEGER NOT NULL,

    CONSTRAINT "Friend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" BIGSERIAL NOT NULL,
    "contentType" "UserType" NOT NULL,
    "content" TEXT NOT NULL,
    "firendUserId" INTEGER NOT NULL,
    "isHostSent" BOOLEAN NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_uniqName_key" ON "User"("uniqName");

-- AddForeignKey
ALTER TABLE "Friend" ADD CONSTRAINT "Friend_hostUserId_fkey" FOREIGN KEY ("hostUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_firendUserId_fkey" FOREIGN KEY ("firendUserId") REFERENCES "Friend"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
