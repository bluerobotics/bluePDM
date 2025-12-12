-- ECO (Engineering Change Order) Management System Migration
-- Run this in your Supabase SQL editor to add ECO support

-- ===========================================
-- ECO TABLE
-- ===========================================

CREATE TABLE ecos (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  
  -- ECO identity
  eco_number TEXT NOT NULL,              -- e.g., "ECO-001", "ECR-2024-0042"
  title TEXT,                            -- Short description/title
  description TEXT,                      -- Detailed description
  
  -- Status
  status TEXT DEFAULT 'open',            -- 'open', 'in_progress', 'completed', 'cancelled'
  
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by UUID REFERENCES users(id),
  completed_at TIMESTAMPTZ,              -- When the ECO was completed/closed
  
  -- Custom properties for flexibility
  custom_properties JSONB DEFAULT '{}'::jsonb,
  
  -- Unique ECO number per organization
  UNIQUE(org_id, eco_number)
);

-- Indexes for common queries
CREATE INDEX idx_ecos_org_id ON ecos(org_id);
CREATE INDEX idx_ecos_eco_number ON ecos(eco_number);
CREATE INDEX idx_ecos_status ON ecos(status);
CREATE INDEX idx_ecos_created_at ON ecos(created_at DESC);
CREATE INDEX idx_ecos_created_by ON ecos(created_by);

-- Full text search index for ECOs
CREATE INDEX idx_ecos_search ON ecos USING GIN (
  to_tsvector('english', 
    coalesce(eco_number, '') || ' ' || 
    coalesce(title, '') || ' ' || 
    coalesce(description, '')
  )
);

-- ===========================================
-- FILE-ECO JUNCTION TABLE (Many-to-Many)
-- ===========================================

CREATE TABLE file_ecos (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  eco_id UUID NOT NULL REFERENCES ecos(id) ON DELETE CASCADE,
  
  -- When/who tagged this file with the ECO
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID NOT NULL REFERENCES users(id),
  
  -- Optional notes about why this file is part of the ECO
  notes TEXT,
  
  -- Prevent duplicate file-eco associations
  UNIQUE(file_id, eco_id)
);

-- Indexes for efficient queries
CREATE INDEX idx_file_ecos_file_id ON file_ecos(file_id);
CREATE INDEX idx_file_ecos_eco_id ON file_ecos(eco_id);
CREATE INDEX idx_file_ecos_created_at ON file_ecos(created_at DESC);

-- ===========================================
-- ROW LEVEL SECURITY
-- ===========================================

ALTER TABLE ecos ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_ecos ENABLE ROW LEVEL SECURITY;

-- ECOs: Authenticated users can view ECOs in their org
CREATE POLICY "Users can view org ECOs"
  ON ecos FOR SELECT
  USING (org_id IN (SELECT org_id FROM users WHERE id = auth.uid()));

-- ECOs: Engineers and admins can create ECOs
CREATE POLICY "Engineers can create ECOs"
  ON ecos FOR INSERT
  WITH CHECK (org_id IN (SELECT org_id FROM users WHERE id = auth.uid() AND role IN ('admin', 'engineer')));

-- ECOs: Engineers and admins can update ECOs
CREATE POLICY "Engineers can update ECOs"
  ON ecos FOR UPDATE
  USING (org_id IN (SELECT org_id FROM users WHERE id = auth.uid() AND role IN ('admin', 'engineer')));

-- ECOs: Only admins can delete ECOs
CREATE POLICY "Admins can delete ECOs"
  ON ecos FOR DELETE
  USING (org_id IN (SELECT org_id FROM users WHERE id = auth.uid() AND role = 'admin'));

-- File-ECOs: Authenticated users can view file-eco associations in their org
CREATE POLICY "Users can view file-eco associations"
  ON file_ecos FOR SELECT
  USING (
    eco_id IN (SELECT id FROM ecos WHERE org_id IN (SELECT org_id FROM users WHERE id = auth.uid()))
  );

-- File-ECOs: Engineers and admins can tag files with ECOs
CREATE POLICY "Engineers can create file-eco associations"
  ON file_ecos FOR INSERT
  WITH CHECK (
    eco_id IN (SELECT id FROM ecos WHERE org_id IN (SELECT org_id FROM users WHERE id = auth.uid() AND role IN ('admin', 'engineer')))
  );

-- File-ECOs: Engineers and admins can update file-eco associations
CREATE POLICY "Engineers can update file-eco associations"
  ON file_ecos FOR UPDATE
  USING (
    eco_id IN (SELECT id FROM ecos WHERE org_id IN (SELECT org_id FROM users WHERE id = auth.uid() AND role IN ('admin', 'engineer')))
  );

-- File-ECOs: Engineers and admins can remove file-eco associations
CREATE POLICY "Engineers can delete file-eco associations"
  ON file_ecos FOR DELETE
  USING (
    eco_id IN (SELECT id FROM ecos WHERE org_id IN (SELECT org_id FROM users WHERE id = auth.uid() AND role IN ('admin', 'engineer')))
  );

-- ===========================================
-- USEFUL VIEWS
-- ===========================================

-- View to get ECO with file counts
CREATE OR REPLACE VIEW eco_summary AS
SELECT 
  e.*,
  COUNT(fe.id) as file_count,
  u.full_name as created_by_name,
  u.email as created_by_email
FROM ecos e
LEFT JOIN file_ecos fe ON e.id = fe.eco_id
LEFT JOIN users u ON e.created_by = u.id
GROUP BY e.id, u.full_name, u.email;

-- ===========================================
-- FUNCTIONS
-- ===========================================

-- Function to get all ECOs for a file
CREATE OR REPLACE FUNCTION get_file_ecos(p_file_id UUID)
RETURNS TABLE (
  eco_id UUID,
  eco_number TEXT,
  title TEXT,
  status TEXT,
  created_at TIMESTAMPTZ,
  tagged_at TIMESTAMPTZ,
  notes TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    e.id as eco_id,
    e.eco_number,
    e.title,
    e.status,
    e.created_at,
    fe.created_at as tagged_at,
    fe.notes
  FROM ecos e
  INNER JOIN file_ecos fe ON e.id = fe.eco_id
  WHERE fe.file_id = p_file_id
  ORDER BY fe.created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get all files for an ECO
CREATE OR REPLACE FUNCTION get_eco_files(p_eco_id UUID)
RETURNS TABLE (
  file_id UUID,
  file_name TEXT,
  file_path TEXT,
  part_number TEXT,
  revision TEXT,
  tagged_at TIMESTAMPTZ,
  tagged_by UUID,
  notes TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    f.id as file_id,
    f.file_name,
    f.file_path,
    f.part_number,
    f.revision,
    fe.created_at as tagged_at,
    fe.created_by as tagged_by,
    fe.notes
  FROM files f
  INNER JOIN file_ecos fe ON f.id = fe.file_id
  WHERE fe.eco_id = p_eco_id
  AND f.deleted_at IS NULL
  ORDER BY f.file_path;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ===========================================
-- UPDATE FULL TEXT SEARCH ON FILES
-- ===========================================

-- Drop existing index and recreate with ECO support
-- Note: This adds ECO numbers to the file search index via a join
-- For now, we'll handle ECO search in the application layer for simplicity

-- Add eco_numbers array column to files for denormalized search (optional optimization)
-- ALTER TABLE files ADD COLUMN IF NOT EXISTS eco_numbers TEXT[] DEFAULT '{}';

-- ===========================================
-- ACTIVITY LOGGING FOR ECO ACTIONS
-- ===========================================

-- Add ECO-related actions to activity_action enum if not exists
-- Note: Run this only if you want to track ECO activity separately
-- DO $$ 
-- BEGIN
--   ALTER TYPE activity_action ADD VALUE IF NOT EXISTS 'eco_create';
--   ALTER TYPE activity_action ADD VALUE IF NOT EXISTS 'eco_update';
--   ALTER TYPE activity_action ADD VALUE IF NOT EXISTS 'eco_complete';
--   ALTER TYPE activity_action ADD VALUE IF NOT EXISTS 'eco_tag_file';
--   ALTER TYPE activity_action ADD VALUE IF NOT EXISTS 'eco_untag_file';
-- EXCEPTION
--   WHEN duplicate_object THEN null;
-- END $$;

