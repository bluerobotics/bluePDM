-- ============================================
-- REVIEWS & NOTIFICATIONS SYSTEM
-- ============================================
-- This migration adds tables for file review requests and user notifications
-- Run this in your Supabase SQL editor

-- ===========================================
-- ENUMS
-- ===========================================

CREATE TYPE review_status AS ENUM ('pending', 'approved', 'rejected', 'cancelled');
CREATE TYPE notification_type AS ENUM ('review_request', 'review_approved', 'review_rejected', 'review_comment', 'mention', 'file_updated', 'checkout_request');

-- ===========================================
-- REVIEWS TABLE
-- ===========================================
-- Stores review requests for files

CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  vault_id UUID REFERENCES vaults(id) ON DELETE CASCADE,
  
  -- Request info
  requested_by UUID NOT NULL REFERENCES users(id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Review details
  title TEXT,                        -- Optional title for the review
  message TEXT,                      -- Message from requester
  file_version INTEGER NOT NULL,     -- Version of file being reviewed
  
  -- Status
  status review_status NOT NULL DEFAULT 'pending',
  completed_at TIMESTAMPTZ,          -- When review was completed (all approved or cancelled)
  
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_reviews_org_id ON reviews(org_id);
CREATE INDEX idx_reviews_file_id ON reviews(file_id);
CREATE INDEX idx_reviews_vault_id ON reviews(vault_id);
CREATE INDEX idx_reviews_requested_by ON reviews(requested_by);
CREATE INDEX idx_reviews_status ON reviews(status);
CREATE INDEX idx_reviews_created_at ON reviews(created_at DESC);

-- ===========================================
-- REVIEW RESPONSES TABLE
-- ===========================================
-- Stores individual reviewer responses

CREATE TABLE review_responses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  review_id UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  
  -- Reviewer info
  reviewer_id UUID NOT NULL REFERENCES users(id),
  
  -- Response
  status review_status NOT NULL DEFAULT 'pending',  -- pending, approved, rejected
  comment TEXT,
  responded_at TIMESTAMPTZ,                         -- When reviewer responded
  
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(review_id, reviewer_id)
);

CREATE INDEX idx_review_responses_review_id ON review_responses(review_id);
CREATE INDEX idx_review_responses_reviewer_id ON review_responses(reviewer_id);
CREATE INDEX idx_review_responses_status ON review_responses(status);

-- ===========================================
-- NOTIFICATIONS TABLE
-- ===========================================
-- Stores user notifications

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- Notification content
  type notification_type NOT NULL,
  title TEXT NOT NULL,
  message TEXT,
  
  -- Related entities (nullable based on type)
  review_id UUID REFERENCES reviews(id) ON DELETE CASCADE,
  file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  
  -- Sender (who triggered this notification)
  from_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  
  -- Status
  read BOOLEAN NOT NULL DEFAULT false,
  read_at TIMESTAMPTZ,
  
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notifications_user_id ON notifications(user_id);
CREATE INDEX idx_notifications_org_id ON notifications(org_id);
CREATE INDEX idx_notifications_read ON notifications(user_id, read);
CREATE INDEX idx_notifications_created_at ON notifications(created_at DESC);
CREATE INDEX idx_notifications_review_id ON notifications(review_id) WHERE review_id IS NOT NULL;

-- ===========================================
-- ROW LEVEL SECURITY
-- ===========================================

ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Reviews: Users can view reviews in their org
CREATE POLICY "Users can view org reviews"
  ON reviews FOR SELECT
  USING (org_id IN (SELECT org_id FROM users WHERE id = auth.uid()));

-- Reviews: Authenticated users in org can create reviews
CREATE POLICY "Users can create reviews"
  ON reviews FOR INSERT
  WITH CHECK (org_id IN (SELECT org_id FROM users WHERE id = auth.uid()));

-- Reviews: Only requester can update their own review
CREATE POLICY "Users can update own reviews"
  ON reviews FOR UPDATE
  USING (requested_by = auth.uid());

-- Reviews: Only requester can delete (cancel) their own review
CREATE POLICY "Users can delete own reviews"
  ON reviews FOR DELETE
  USING (requested_by = auth.uid());

-- Review Responses: Users can view responses in their org
CREATE POLICY "Users can view org review responses"
  ON review_responses FOR SELECT
  USING (
    review_id IN (
      SELECT id FROM reviews WHERE org_id IN (
        SELECT org_id FROM users WHERE id = auth.uid()
      )
    )
  );

-- Review Responses: Users can create responses (when invited to review)
CREATE POLICY "Users can create review responses"
  ON review_responses FOR INSERT
  WITH CHECK (reviewer_id = auth.uid());

-- Review Responses: Users can update their own responses
CREATE POLICY "Users can update own responses"
  ON review_responses FOR UPDATE
  USING (reviewer_id = auth.uid());

-- Notifications: Users can only view their own notifications
CREATE POLICY "Users can view own notifications"
  ON notifications FOR SELECT
  USING (user_id = auth.uid());

-- Notifications: Users in org can create notifications for others in org
CREATE POLICY "Users can create notifications"
  ON notifications FOR INSERT
  WITH CHECK (org_id IN (SELECT org_id FROM users WHERE id = auth.uid()));

-- Notifications: Users can update their own notifications (mark as read)
CREATE POLICY "Users can update own notifications"
  ON notifications FOR UPDATE
  USING (user_id = auth.uid());

-- Notifications: Users can delete their own notifications
CREATE POLICY "Users can delete own notifications"
  ON notifications FOR DELETE
  USING (user_id = auth.uid());

-- ===========================================
-- FUNCTIONS
-- ===========================================

-- Function to create a review request and notify reviewers
CREATE OR REPLACE FUNCTION create_review_request(
  p_org_id UUID,
  p_file_id UUID,
  p_vault_id UUID,
  p_requested_by UUID,
  p_reviewer_ids UUID[],
  p_title TEXT DEFAULT NULL,
  p_message TEXT DEFAULT NULL,
  p_file_version INTEGER DEFAULT 1
)
RETURNS UUID AS $$
DECLARE
  v_review_id UUID;
  v_reviewer_id UUID;
  v_file_name TEXT;
  v_requester_name TEXT;
BEGIN
  -- Get file name for notification
  SELECT file_name INTO v_file_name FROM files WHERE id = p_file_id;
  
  -- Get requester name
  SELECT COALESCE(full_name, email) INTO v_requester_name FROM users WHERE id = p_requested_by;
  
  -- Create review
  INSERT INTO reviews (org_id, file_id, vault_id, requested_by, title, message, file_version)
  VALUES (p_org_id, p_file_id, p_vault_id, p_requested_by, p_title, p_message, p_file_version)
  RETURNING id INTO v_review_id;
  
  -- Create review responses for each reviewer (pending status)
  FOREACH v_reviewer_id IN ARRAY p_reviewer_ids
  LOOP
    -- Create pending response entry
    INSERT INTO review_responses (review_id, reviewer_id, status)
    VALUES (v_review_id, v_reviewer_id, 'pending');
    
    -- Create notification for reviewer
    INSERT INTO notifications (org_id, user_id, type, title, message, review_id, file_id, from_user_id)
    VALUES (
      p_org_id,
      v_reviewer_id,
      'review_request',
      'Review Requested: ' || COALESCE(v_file_name, 'File'),
      v_requester_name || ' requested your review' || COALESCE(': ' || p_message, ''),
      v_review_id,
      p_file_id,
      p_requested_by
    );
  END LOOP;
  
  RETURN v_review_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to respond to a review
CREATE OR REPLACE FUNCTION respond_to_review(
  p_review_id UUID,
  p_reviewer_id UUID,
  p_status review_status,
  p_comment TEXT DEFAULT NULL
)
RETURNS BOOLEAN AS $$
DECLARE
  v_review RECORD;
  v_all_responded BOOLEAN;
  v_all_approved BOOLEAN;
  v_any_rejected BOOLEAN;
  v_requester_id UUID;
  v_file_name TEXT;
  v_reviewer_name TEXT;
BEGIN
  -- Get review info
  SELECT r.*, f.file_name INTO v_review
  FROM reviews r
  JOIN files f ON r.file_id = f.id
  WHERE r.id = p_review_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Review not found';
  END IF;
  
  -- Update the response
  UPDATE review_responses
  SET 
    status = p_status,
    comment = p_comment,
    responded_at = NOW(),
    updated_at = NOW()
  WHERE review_id = p_review_id AND reviewer_id = p_reviewer_id;
  
  -- Get reviewer name for notification
  SELECT COALESCE(full_name, email) INTO v_reviewer_name FROM users WHERE id = p_reviewer_id;
  
  -- Notify the requester
  INSERT INTO notifications (org_id, user_id, type, title, message, review_id, file_id, from_user_id)
  VALUES (
    v_review.org_id,
    v_review.requested_by,
    CASE 
      WHEN p_status = 'approved' THEN 'review_approved'::notification_type
      WHEN p_status = 'rejected' THEN 'review_rejected'::notification_type
      ELSE 'review_comment'::notification_type
    END,
    CASE 
      WHEN p_status = 'approved' THEN 'Review Approved: ' || v_review.file_name
      WHEN p_status = 'rejected' THEN 'Review Rejected: ' || v_review.file_name
      ELSE 'Review Comment: ' || v_review.file_name
    END,
    v_reviewer_name || 
    CASE 
      WHEN p_status = 'approved' THEN ' approved the review'
      WHEN p_status = 'rejected' THEN ' rejected the review'
      ELSE ' commented on the review'
    END ||
    COALESCE(': ' || p_comment, ''),
    p_review_id,
    v_review.file_id,
    p_reviewer_id
  );
  
  -- Check if all reviewers have responded
  SELECT 
    NOT EXISTS (SELECT 1 FROM review_responses WHERE review_id = p_review_id AND status = 'pending'),
    NOT EXISTS (SELECT 1 FROM review_responses WHERE review_id = p_review_id AND status NOT IN ('approved', 'pending')),
    EXISTS (SELECT 1 FROM review_responses WHERE review_id = p_review_id AND status = 'rejected')
  INTO v_all_responded, v_all_approved, v_any_rejected;
  
  -- If all responded, update review status
  IF v_all_responded THEN
    UPDATE reviews
    SET 
      status = CASE WHEN v_any_rejected THEN 'rejected'::review_status ELSE 'approved'::review_status END,
      completed_at = NOW(),
      updated_at = NOW()
    WHERE id = p_review_id;
  END IF;
  
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get unread notification count
CREATE OR REPLACE FUNCTION get_unread_notification_count(p_user_id UUID)
RETURNS INTEGER AS $$
  SELECT COUNT(*)::INTEGER 
  FROM notifications 
  WHERE user_id = p_user_id AND read = false;
$$ LANGUAGE sql SECURITY DEFINER;

-- Function to mark notifications as read
CREATE OR REPLACE FUNCTION mark_notifications_read(p_notification_ids UUID[])
RETURNS INTEGER AS $$
DECLARE
  v_updated INTEGER;
BEGIN
  UPDATE notifications
  SET read = true, read_at = NOW()
  WHERE id = ANY(p_notification_ids) AND user_id = auth.uid();
  
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to mark all notifications as read for a user
CREATE OR REPLACE FUNCTION mark_all_notifications_read(p_user_id UUID)
RETURNS INTEGER AS $$
DECLARE
  v_updated INTEGER;
BEGIN
  UPDATE notifications
  SET read = true, read_at = NOW()
  WHERE user_id = p_user_id AND read = false;
  
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

