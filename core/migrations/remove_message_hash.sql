-- Migration to remove message_hash column and index
-- Run this after deploying the code changes that removed message_hash references

-- Drop the index first
DROP INDEX IF EXISTS idx_messages_hash;

-- Drop the message_hash column
ALTER TABLE messages DROP COLUMN IF EXISTS message_hash;