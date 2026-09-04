ALTER TABLE "ThreadParticipant" RENAME TO "AccountThreadState";

ALTER TABLE "AccountThreadState"
  RENAME CONSTRAINT "ThreadParticipant_accountId_fkey"
  TO "AccountThreadState_accountId_fkey";
ALTER TABLE "AccountThreadState"
  RENAME CONSTRAINT "ThreadParticipant_threadId_fkey"
  TO "AccountThreadState_threadId_fkey";
ALTER TABLE "AccountThreadState"
  RENAME CONSTRAINT "ThreadParticipant_cleared_seq_check"
  TO "AccountThreadState_cleared_seq_check";
ALTER TABLE "AccountThreadState"
  RENAME CONSTRAINT "ThreadParticipant_messageVisibleThroughSeq_check"
  TO "AccountThreadState_messageVisibleThroughSeq_check";

ALTER INDEX "ThreadParticipant_pkey"
  RENAME TO "AccountThreadState_pkey";
ALTER INDEX "ThreadParticipant_accountId_threadId_key"
  RENAME TO "AccountThreadState_accountId_threadId_key";
ALTER INDEX "ThreadParticipant_threadId_idx"
  RENAME TO "AccountThreadState_threadId_idx";
ALTER INDEX "ThreadParticipant_accountId_pinned_idx"
  RENAME TO "AccountThreadState_accountId_pinned_idx";
ALTER INDEX "ThreadParticipant_accountId_readRevision_idx"
  RENAME TO "AccountThreadState_accountId_readRevision_idx";
