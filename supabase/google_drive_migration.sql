-- Google Drive Integration Settings
-- Allows admins to configure Google Drive OAuth credentials for their organization

-- Add Google Drive settings columns to organizations table
ALTER TABLE organizations 
ADD COLUMN IF NOT EXISTS google_drive_client_id TEXT,
ADD COLUMN IF NOT EXISTS google_drive_client_secret TEXT,
ADD COLUMN IF NOT EXISTS google_drive_enabled BOOLEAN DEFAULT FALSE;

-- Add comment for documentation
COMMENT ON COLUMN organizations.google_drive_client_id IS 'Google OAuth Client ID for Google Drive integration';
COMMENT ON COLUMN organizations.google_drive_client_secret IS 'Google OAuth Client Secret for Google Drive integration';
COMMENT ON COLUMN organizations.google_drive_enabled IS 'Whether Google Drive integration is enabled for this organization';

-- Create a function to get Google Drive settings (only returns if user is in the org)
CREATE OR REPLACE FUNCTION get_google_drive_settings(p_org_id UUID)
RETURNS TABLE (
  client_id TEXT,
  client_secret TEXT,
  enabled BOOLEAN
) 
SECURITY DEFINER
AS $$
BEGIN
  -- Check if user is in the organization
  IF NOT EXISTS (
    SELECT 1 FROM users 
    WHERE id = auth.uid() 
    AND org_id = p_org_id
  ) THEN
    RAISE EXCEPTION 'User not authorized to access this organization';
  END IF;
  
  RETURN QUERY
  SELECT 
    o.google_drive_client_id,
    o.google_drive_client_secret,
    o.google_drive_enabled
  FROM organizations o
  WHERE o.id = p_org_id;
END;
$$ LANGUAGE plpgsql;

-- Create a function to update Google Drive settings (admin only)
CREATE OR REPLACE FUNCTION update_google_drive_settings(
  p_org_id UUID,
  p_client_id TEXT,
  p_client_secret TEXT,
  p_enabled BOOLEAN
)
RETURNS BOOLEAN
SECURITY DEFINER
AS $$
DECLARE
  v_user_role TEXT;
BEGIN
  -- Check if user is an admin in the organization
  SELECT role INTO v_user_role
  FROM users 
  WHERE id = auth.uid() 
  AND org_id = p_org_id;
  
  IF v_user_role IS NULL THEN
    RAISE EXCEPTION 'User not found in organization';
  END IF;
  
  IF v_user_role != 'admin' THEN
    RAISE EXCEPTION 'Only admins can update Google Drive settings';
  END IF;
  
  -- Update the settings
  UPDATE organizations
  SET 
    google_drive_client_id = p_client_id,
    google_drive_client_secret = p_client_secret,
    google_drive_enabled = p_enabled
  WHERE id = p_org_id;
  
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION get_google_drive_settings(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION update_google_drive_settings(UUID, TEXT, TEXT, BOOLEAN) TO authenticated;

