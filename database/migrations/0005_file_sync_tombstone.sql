-- A source-message deletion is a protocol terminal, not an operator-retryable transfer failure.
ALTER TYPE "FileSyncStatus" ADD VALUE IF NOT EXISTS 'TOMBSTONED';
