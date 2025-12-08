-- BluePDM Database Reset Script
-- WARNING: This will DELETE ALL DATA from your BluePDM database!
-- Run this in Supabase SQL Editor to wipe everything before re-running schema.sql

-- ===========================================
-- DROP TRIGGERS
-- ===========================================
DROP TRIGGER IF EXISTS log_file_changes ON files;
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

-- ===========================================
-- DROP TABLES (in order due to foreign keys)
-- ===========================================
DROP TABLE IF EXISTS activity CASCADE;
DROP TABLE IF EXISTS file_references CASCADE;
DROP TABLE IF EXISTS file_versions CASCADE;
DROP TABLE IF EXISTS files CASCADE;
DROP TABLE IF EXISTS vaults CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS organizations CASCADE;

-- ===========================================
-- DROP TYPES
-- ===========================================
DROP TYPE IF EXISTS activity_action;
DROP TYPE IF EXISTS revision_scheme;
DROP TYPE IF EXISTS user_role;
DROP TYPE IF EXISTS reference_type;
DROP TYPE IF EXISTS file_type;
DROP TYPE IF EXISTS file_state;

-- ===========================================
-- DROP FUNCTIONS
-- ===========================================
DROP FUNCTION IF EXISTS handle_new_user();
DROP FUNCTION IF EXISTS log_file_activity();

-- ===========================================
-- DROP STORAGE POLICIES
-- ===========================================
DROP POLICY IF EXISTS "Authenticated users can upload to vault" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can read from vault" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can update vault files" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can delete from vault" ON storage.objects;

-- ===========================================
-- NOTES
-- ===========================================
-- This script does NOT delete:
-- - auth.users (Supabase Auth manages these separately)
-- - Storage bucket files (delete manually in Storage dashboard)
--
-- After running this, run schema.sql to recreate everything.

