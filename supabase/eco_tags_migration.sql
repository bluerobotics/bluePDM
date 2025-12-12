-- ECO Tags Column Migration
-- Adds a denormalized eco_tags array column to files table for quick display
-- Automatically kept in sync via triggers when ECOs are added/removed

-- ===========================================
-- ADD ECO_TAGS COLUMN TO FILES
-- ===========================================

ALTER TABLE files 
ADD COLUMN IF NOT EXISTS eco_tags TEXT[] DEFAULT '{}';

-- Add index for searching files by ECO tag
CREATE INDEX IF NOT EXISTS idx_files_eco_tags ON files USING GIN (eco_tags);

-- Add comment for documentation
COMMENT ON COLUMN files.eco_tags IS 'Denormalized array of ECO numbers associated with this file. Automatically synced via trigger.';

-- ===========================================
-- TRIGGER FUNCTION TO SYNC ECO TAGS
-- ===========================================

CREATE OR REPLACE FUNCTION sync_file_eco_tags()
RETURNS TRIGGER AS $$
DECLARE
  v_file_id UUID;
  v_eco_numbers TEXT[];
BEGIN
  -- Determine which file_id to update
  IF TG_OP = 'DELETE' THEN
    v_file_id := OLD.file_id;
  ELSE
    v_file_id := NEW.file_id;
  END IF;
  
  -- Get all ECO numbers for this file
  SELECT COALESCE(array_agg(e.eco_number ORDER BY e.eco_number), '{}')
  INTO v_eco_numbers
  FROM file_ecos fe
  INNER JOIN ecos e ON fe.eco_id = e.id
  WHERE fe.file_id = v_file_id;
  
  -- Update the files table
  UPDATE files
  SET eco_tags = v_eco_numbers
  WHERE id = v_file_id;
  
  RETURN NULL; -- For AFTER triggers, return value is ignored
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ===========================================
-- CREATE TRIGGERS
-- ===========================================

-- Drop existing triggers if they exist (for idempotent migrations)
DROP TRIGGER IF EXISTS trigger_sync_eco_tags_insert ON file_ecos;
DROP TRIGGER IF EXISTS trigger_sync_eco_tags_delete ON file_ecos;

-- Trigger when ECO is added to a file
CREATE TRIGGER trigger_sync_eco_tags_insert
  AFTER INSERT ON file_ecos
  FOR EACH ROW
  EXECUTE FUNCTION sync_file_eco_tags();

-- Trigger when ECO is removed from a file
CREATE TRIGGER trigger_sync_eco_tags_delete
  AFTER DELETE ON file_ecos
  FOR EACH ROW
  EXECUTE FUNCTION sync_file_eco_tags();

-- ===========================================
-- SYNC ECO TAGS WHEN ECO NUMBER CHANGES
-- ===========================================

CREATE OR REPLACE FUNCTION sync_eco_tags_on_eco_update()
RETURNS TRIGGER AS $$
BEGIN
  -- Only run if eco_number changed
  IF OLD.eco_number IS DISTINCT FROM NEW.eco_number THEN
    -- Update all files that have this ECO
    UPDATE files f
    SET eco_tags = (
      SELECT COALESCE(array_agg(e.eco_number ORDER BY e.eco_number), '{}')
      FROM file_ecos fe
      INNER JOIN ecos e ON fe.eco_id = e.id
      WHERE fe.file_id = f.id
    )
    WHERE f.id IN (
      SELECT file_id FROM file_ecos WHERE eco_id = NEW.id
    );
  END IF;
  
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop existing trigger if it exists
DROP TRIGGER IF EXISTS trigger_sync_eco_tags_on_eco_update ON ecos;

-- Trigger when ECO number changes
CREATE TRIGGER trigger_sync_eco_tags_on_eco_update
  AFTER UPDATE ON ecos
  FOR EACH ROW
  EXECUTE FUNCTION sync_eco_tags_on_eco_update();

-- ===========================================
-- INITIALIZE EXISTING DATA
-- ===========================================

-- Populate eco_tags for all files that already have ECO associations
UPDATE files f
SET eco_tags = (
  SELECT COALESCE(array_agg(e.eco_number ORDER BY e.eco_number), '{}')
  FROM file_ecos fe
  INNER JOIN ecos e ON fe.eco_id = e.id
  WHERE fe.file_id = f.id
)
WHERE EXISTS (
  SELECT 1 FROM file_ecos WHERE file_id = f.id
);

-- ===========================================
-- UPDATE FULL TEXT SEARCH TO INCLUDE ECO TAGS
-- ===========================================

-- Drop and recreate the search index to include ECO tags
DROP INDEX IF EXISTS idx_files_search;

CREATE INDEX idx_files_search ON files USING GIN (
  to_tsvector('english', 
    coalesce(file_name, '') || ' ' || 
    coalesce(part_number, '') || ' ' || 
    coalesce(description, '') || ' ' ||
    coalesce(array_to_string(eco_tags, ' '), '')
  )
);

