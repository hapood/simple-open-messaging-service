/*
  Warnings:

  - Added the required column `info` to the `ChatThread` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "ChatThread" ADD COLUMN     "info" JSONB NOT NULL;
