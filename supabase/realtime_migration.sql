-- Realtime Migration for BluePDM
-- Enables real-time subscriptions for file changes across all connected clients
-- 
-- This allows instant updates when:
-- - Someone checks out/in a file
-- - A file version changes
-- - A file state changes (WIP → Released)
-- - New files are added or deleted

-- ===========================================
-- ENABLE REPLICA IDENTITY FOR REALTIME
-- ===========================================
-- Supabase Realtime needs REPLICA IDENTITY FULL to send the old record on UPDATE/DELETE
-- This is required for the client to know what changed

ALTER TABLE files REPLICA IDENTITY FULL;
ALTER TABLE activity REPLICA IDENTITY FULL;

-- ===========================================
-- ADD TABLES TO REALTIME PUBLICATION
-- ===========================================
-- Supabase uses a publication called 'supabase_realtime' to broadcast changes
-- Tables must be explicitly added to this publication

-- First, check if supabase_realtime publication exists and create if not
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;

-- Add files table to realtime publication (if not already added)
ALTER PUBLICATION supabase_realtime ADD TABLE files;
-- Note: If you get "relation already member of publication" error, that's fine - it means it's already enabled

-- Add activity table to realtime publication
ALTER PUBLICATION supabase_realtime ADD TABLE activity;

-- ===========================================
-- VERIFY CONFIGURATION
-- ===========================================
-- Run this query to verify tables are in the publication:
-- SELECT * FROM pg_publication_tables WHERE pubname = 'supabase_realtime';

-- ===========================================
-- ALTERNATIVE: ENABLE VIA SUPABASE DASHBOARD
-- ===========================================
-- If the SQL above fails (some Supabase plans restrict publication access),
-- you can enable realtime via the Dashboard:
-- 
-- 1. Go to your Supabase project
-- 2. Navigate to Database → Replication
-- 3. Under "Source", find "supabase_realtime" publication
-- 4. Click on it and add the "files" and "activity" tables
-- 
-- Or via Table Editor:
-- 1. Go to Table Editor → files table
-- 2. Click the dropdown menu (⋮)
-- 3. Enable "Realtime" 
-- 4. Repeat for "activity" table

