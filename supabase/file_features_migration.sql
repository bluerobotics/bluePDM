-- Additional File Features Migration
-- Run this in your Supabase SQL editor
-- Features: File Watchers, Review Due Dates, File Sharing Links

-- ===========================================
-- FILE WATCHERS (Watch/Subscribe to files)
-- ===========================================

CREATE TABLE file_watchers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- What to notify about
  notify_on_checkin BOOLEAN DEFAULT true,
  notify_on_checkout BOOLEAN DEFAULT false,
  notify_on_state_change BOOLEAN DEFAULT true,
  notify_on_review BOOLEAN DEFAULT true,
  
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- One watcher entry per user per file
  UNIQUE(file_id, user_id)
);

CREATE INDEX idx_file_watchers_file_id ON file_watchers(file_id);
CREATE INDEX idx_file_watchers_user_id ON file_watchers(user_id);
CREATE INDEX idx_file_watchers_org_id ON file_watchers(org_id);

-- ===========================================
-- FILE SHARE LINKS
-- ===========================================

CREATE TABLE file_share_links (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  
  -- Link token (short unique code for URL)
  token TEXT NOT NULL UNIQUE,
  
  -- Access control
  created_by UUID NOT NULL REFERENCES users(id),
  expires_at TIMESTAMPTZ,                    -- NULL = never expires
  max_downloads INTEGER,                      -- NULL = unlimited
  download_count INTEGER DEFAULT 0,
  password_hash TEXT,                         -- Optional password protection
  
  -- What version to share
  file_version INTEGER,                       -- NULL = latest version
  
  -- Permissions
  allow_download BOOLEAN DEFAULT true,
  require_auth BOOLEAN DEFAULT false,         -- Require BluePDM login to access
  
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_accessed_at TIMESTAMPTZ,
  
  -- Status
  is_active BOOLEAN DEFAULT true
);

CREATE INDEX idx_file_share_links_token ON file_share_links(token);
CREATE INDEX idx_file_share_links_file_id ON file_share_links(file_id);
CREATE INDEX idx_file_share_links_org_id ON file_share_links(org_id);
CREATE INDEX idx_file_share_links_created_by ON file_share_links(created_by);
CREATE INDEX idx_file_share_links_expires_at ON file_share_links(expires_at) WHERE expires_at IS NOT NULL;

-- ===========================================
-- ADD DUE DATE TO REVIEWS
-- ===========================================

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS due_date TIMESTAMPTZ;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'normal'; -- 'low', 'normal', 'high', 'urgent'

CREATE INDEX idx_reviews_due_date ON reviews(due_date) WHERE due_date IS NOT NULL;
CREATE INDEX idx_reviews_priority ON reviews(priority);

-- ===========================================
-- ROW LEVEL SECURITY
-- ===========================================

ALTER TABLE file_watchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_share_links ENABLE ROW LEVEL SECURITY;

-- File Watchers: Users can view watchers for files in their org
CREATE POLICY "Users can view file watchers in org"
  ON file_watchers FOR SELECT
  USING (org_id IN (SELECT org_id FROM users WHERE id = auth.uid()));

-- File Watchers: Users can create watchers for themselves
CREATE POLICY "Users can watch files"
  ON file_watchers FOR INSERT
  WITH CHECK (user_id = auth.uid() AND org_id IN (SELECT org_id FROM users WHERE id = auth.uid()));

-- File Watchers: Users can update their own watchers
CREATE POLICY "Users can update own watchers"
  ON file_watchers FOR UPDATE
  USING (user_id = auth.uid());

-- File Watchers: Users can delete their own watchers
CREATE POLICY "Users can unwatch files"
  ON file_watchers FOR DELETE
  USING (user_id = auth.uid());

-- File Share Links: Users can view share links they created or for files in their org
CREATE POLICY "Users can view share links in org"
  ON file_share_links FOR SELECT
  USING (org_id IN (SELECT org_id FROM users WHERE id = auth.uid()));

-- File Share Links: Engineers and admins can create share links
CREATE POLICY "Engineers can create share links"
  ON file_share_links FOR INSERT
  WITH CHECK (org_id IN (SELECT org_id FROM users WHERE id = auth.uid() AND role IN ('admin', 'engineer')));

-- File Share Links: Users can update their own share links
CREATE POLICY "Users can update own share links"
  ON file_share_links FOR UPDATE
  USING (created_by = auth.uid());

-- File Share Links: Users can delete their own share links, admins can delete any
CREATE POLICY "Users can delete share links"
  ON file_share_links FOR DELETE
  USING (created_by = auth.uid() OR auth.uid() IN (SELECT id FROM users WHERE org_id = file_share_links.org_id AND role = 'admin'));

-- ===========================================
-- FUNCTIONS
-- ===========================================

-- Function to notify file watchers on changes
CREATE OR REPLACE FUNCTION notify_file_watchers()
RETURNS TRIGGER AS $$
DECLARE
  watcher RECORD;
  change_type TEXT;
  notification_title TEXT;
  notification_message TEXT;
  actor_name TEXT;
BEGIN
  -- Determine what changed
  IF TG_OP = 'UPDATE' THEN
    -- Get actor name
    SELECT COALESCE(full_name, email) INTO actor_name 
    FROM users 
    WHERE id = COALESCE(NEW.updated_by, auth.uid());
    
    -- Check for checkin
    IF OLD.checked_out_by IS NOT NULL AND NEW.checked_out_by IS NULL THEN
      change_type := 'checkin';
      notification_title := 'File Checked In: ' || NEW.file_name;
      notification_message := actor_name || ' checked in ' || NEW.file_name;
    -- Check for checkout
    ELSIF OLD.checked_out_by IS NULL AND NEW.checked_out_by IS NOT NULL THEN
      change_type := 'checkout';
      notification_title := 'File Checked Out: ' || NEW.file_name;
      notification_message := actor_name || ' checked out ' || NEW.file_name;
    -- Check for state change
    ELSIF OLD.state IS DISTINCT FROM NEW.state THEN
      change_type := 'state_change';
      notification_title := 'File State Changed: ' || NEW.file_name;
      notification_message := NEW.file_name || ' changed from ' || OLD.state || ' to ' || NEW.state;
    ELSE
      -- No significant change for watchers
      RETURN NEW;
    END IF;
    
    -- Notify all watchers except the person who made the change
    FOR watcher IN 
      SELECT fw.user_id 
      FROM file_watchers fw 
      WHERE fw.file_id = NEW.id
      AND fw.user_id != COALESCE(NEW.updated_by, auth.uid())
      AND (
        (change_type = 'checkin' AND fw.notify_on_checkin = true) OR
        (change_type = 'checkout' AND fw.notify_on_checkout = true) OR
        (change_type = 'state_change' AND fw.notify_on_state_change = true)
      )
    LOOP
      INSERT INTO notifications (org_id, user_id, type, title, message, file_id, from_user_id)
      VALUES (
        NEW.org_id, 
        watcher.user_id, 
        'file_updated', 
        notification_title, 
        notification_message,
        NEW.id,
        COALESCE(NEW.updated_by, auth.uid())
      );
    END LOOP;
  END IF;
  
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Don't fail file operations if notification fails
  RAISE WARNING 'File watcher notification failed: %', SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger for file changes (only if not exists)
DROP TRIGGER IF EXISTS notify_watchers_on_file_change ON files;
CREATE TRIGGER notify_watchers_on_file_change
  AFTER UPDATE ON files
  FOR EACH ROW
  EXECUTE FUNCTION notify_file_watchers();

-- Function to generate a unique share token
CREATE OR REPLACE FUNCTION generate_share_token()
RETURNS TEXT AS $$
DECLARE
  chars TEXT := 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  result TEXT := '';
  i INTEGER;
BEGIN
  FOR i IN 1..12 LOOP
    result := result || substr(chars, floor(random() * length(chars) + 1)::int, 1);
  END LOOP;
  RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Function to create a share link
CREATE OR REPLACE FUNCTION create_file_share_link(
  p_org_id UUID,
  p_file_id UUID,
  p_created_by UUID,
  p_expires_in_days INTEGER DEFAULT NULL,
  p_max_downloads INTEGER DEFAULT NULL,
  p_require_auth BOOLEAN DEFAULT false
)
RETURNS TABLE (
  link_id UUID,
  token TEXT,
  expires_at TIMESTAMPTZ
) AS $$
DECLARE
  v_token TEXT;
  v_expires_at TIMESTAMPTZ;
  v_link_id UUID;
BEGIN
  -- Generate unique token
  LOOP
    v_token := generate_share_token();
    EXIT WHEN NOT EXISTS (SELECT 1 FROM file_share_links WHERE file_share_links.token = v_token);
  END LOOP;
  
  -- Calculate expiration
  IF p_expires_in_days IS NOT NULL THEN
    v_expires_at := NOW() + (p_expires_in_days || ' days')::interval;
  END IF;
  
  -- Create the link
  INSERT INTO file_share_links (org_id, file_id, token, created_by, expires_at, max_downloads, require_auth)
  VALUES (p_org_id, p_file_id, v_token, p_created_by, v_expires_at, p_max_downloads, p_require_auth)
  RETURNING id INTO v_link_id;
  
  RETURN QUERY SELECT v_link_id, v_token, v_expires_at;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to validate and increment download count for share link
CREATE OR REPLACE FUNCTION validate_share_link(p_token TEXT)
RETURNS TABLE (
  is_valid BOOLEAN,
  file_id UUID,
  org_id UUID,
  file_version INTEGER,
  error_message TEXT
) AS $$
DECLARE
  v_link RECORD;
BEGIN
  -- Get the link
  SELECT * INTO v_link FROM file_share_links WHERE token = p_token;
  
  IF NOT FOUND THEN
    RETURN QUERY SELECT false::boolean, NULL::uuid, NULL::uuid, NULL::integer, 'Link not found'::text;
    RETURN;
  END IF;
  
  -- Check if active
  IF NOT v_link.is_active THEN
    RETURN QUERY SELECT false::boolean, NULL::uuid, NULL::uuid, NULL::integer, 'Link has been deactivated'::text;
    RETURN;
  END IF;
  
  -- Check expiration
  IF v_link.expires_at IS NOT NULL AND v_link.expires_at < NOW() THEN
    RETURN QUERY SELECT false::boolean, NULL::uuid, NULL::uuid, NULL::integer, 'Link has expired'::text;
    RETURN;
  END IF;
  
  -- Check download limit
  IF v_link.max_downloads IS NOT NULL AND v_link.download_count >= v_link.max_downloads THEN
    RETURN QUERY SELECT false::boolean, NULL::uuid, NULL::uuid, NULL::integer, 'Download limit reached'::text;
    RETURN;
  END IF;
  
  -- Increment download count and update last accessed
  UPDATE file_share_links 
  SET download_count = download_count + 1, last_accessed_at = NOW()
  WHERE token = p_token;
  
  RETURN QUERY SELECT true::boolean, v_link.file_id, v_link.org_id, v_link.file_version, NULL::text;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ===========================================
-- OVERDUE REVIEW NOTIFICATIONS
-- ===========================================

-- Function to check for overdue reviews and notify
-- Call this periodically via cron or Edge Function
CREATE OR REPLACE FUNCTION notify_overdue_reviews()
RETURNS INTEGER AS $$
DECLARE
  overdue_review RECORD;
  notified_count INTEGER := 0;
BEGIN
  -- Find reviews that are past due and still pending
  FOR overdue_review IN
    SELECT r.id, r.org_id, r.file_id, r.requested_by, r.due_date, f.file_name,
           rr.reviewer_id
    FROM reviews r
    JOIN files f ON r.file_id = f.id
    JOIN review_responses rr ON r.id = rr.review_id
    WHERE r.status = 'pending'
    AND r.due_date IS NOT NULL
    AND r.due_date < NOW()
    AND rr.status = 'pending'
    -- Only notify once per day (check if we already notified today)
    AND NOT EXISTS (
      SELECT 1 FROM notifications n 
      WHERE n.review_id = r.id 
      AND n.user_id = rr.reviewer_id
      AND n.type = 'review_request'
      AND n.title LIKE '%OVERDUE%'
      AND n.created_at > NOW() - INTERVAL '1 day'
    )
  LOOP
    -- Notify the reviewer
    INSERT INTO notifications (org_id, user_id, type, title, message, review_id, file_id, from_user_id)
    VALUES (
      overdue_review.org_id,
      overdue_review.reviewer_id,
      'review_request',
      'OVERDUE: Review Request for ' || overdue_review.file_name,
      'This review was due ' || to_char(overdue_review.due_date, 'Mon DD, YYYY') || '. Please review as soon as possible.',
      overdue_review.id,
      overdue_review.file_id,
      overdue_review.requested_by
    );
    
    notified_count := notified_count + 1;
  END LOOP;
  
  RETURN notified_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

