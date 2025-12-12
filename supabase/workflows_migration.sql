-- BluePDM Workflows Migration
-- Visual workflow builder for managing file states, gates, and reviews
-- Run this in your Supabase SQL editor after the main schema.sql

-- ===========================================
-- WORKFLOW TEMPLATES (Org-wide workflow definitions)
-- ===========================================

CREATE TABLE workflow_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  
  name TEXT NOT NULL,                    -- "Engineering Release Process"
  description TEXT,
  is_default BOOLEAN DEFAULT false,      -- Default workflow for new files
  is_active BOOLEAN DEFAULT true,        -- Can be disabled without deletion
  
  -- Visual layout (for workflow builder)
  canvas_config JSONB DEFAULT '{
    "zoom": 1,
    "panX": 0,
    "panY": 0
  }'::jsonb,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by UUID REFERENCES users(id),
  
  UNIQUE(org_id, name)
);

CREATE INDEX idx_workflow_templates_org_id ON workflow_templates(org_id);
CREATE INDEX idx_workflow_templates_is_default ON workflow_templates(is_default) WHERE is_default = true;

-- ===========================================
-- WORKFLOW STATES (Custom states in a workflow)
-- ===========================================

CREATE TABLE workflow_states (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workflow_id UUID NOT NULL REFERENCES workflow_templates(id) ON DELETE CASCADE,
  
  -- State identity
  name TEXT NOT NULL,                    -- "In Review", "Released"
  label TEXT,                            -- Display label (optional, defaults to name)
  description TEXT,
  
  -- Visual styling
  color TEXT DEFAULT '#6B7280',          -- Hex color for node
  icon TEXT DEFAULT 'circle',            -- Icon name (lucide)
  
  -- Position on canvas (for visual builder)
  position_x INTEGER DEFAULT 0,
  position_y INTEGER DEFAULT 0,
  
  -- State type
  state_type TEXT NOT NULL DEFAULT 'intermediate',  -- 'initial', 'intermediate', 'final', 'rejected'
  
  -- Maps to built-in file_state enum for compatibility
  maps_to_file_state file_state DEFAULT 'wip',
  
  -- Behavior flags
  is_editable BOOLEAN DEFAULT true,      -- Can files be edited in this state?
  requires_checkout BOOLEAN DEFAULT true, -- Must checkout to edit?
  auto_increment_revision BOOLEAN DEFAULT false,  -- Auto-bump revision on transition to this state
  
  sort_order INTEGER DEFAULT 0,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(workflow_id, name)
);

CREATE INDEX idx_workflow_states_workflow_id ON workflow_states(workflow_id);

-- ===========================================
-- WORKFLOW TRANSITIONS (Valid state changes)
-- ===========================================

CREATE TABLE workflow_transitions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workflow_id UUID NOT NULL REFERENCES workflow_templates(id) ON DELETE CASCADE,
  
  from_state_id UUID NOT NULL REFERENCES workflow_states(id) ON DELETE CASCADE,
  to_state_id UUID NOT NULL REFERENCES workflow_states(id) ON DELETE CASCADE,
  
  -- Transition info
  name TEXT,                             -- "Submit for Review", "Approve"
  description TEXT,
  
  -- Visual styling for connection line
  line_style TEXT DEFAULT 'solid',       -- 'solid', 'dashed', 'dotted'
  line_color TEXT,                       -- Optional override color
  
  -- Who can trigger this transition
  allowed_roles user_role[] DEFAULT ARRAY['admin', 'engineer']::user_role[],
  
  -- Auto-transition conditions (JSON logic)
  auto_conditions JSONB,                 -- Auto-transition when conditions met
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(workflow_id, from_state_id, to_state_id)
);

CREATE INDEX idx_workflow_transitions_workflow_id ON workflow_transitions(workflow_id);
CREATE INDEX idx_workflow_transitions_from_state ON workflow_transitions(from_state_id);
CREATE INDEX idx_workflow_transitions_to_state ON workflow_transitions(to_state_id);

-- ===========================================
-- WORKFLOW GATES (Approval requirements for transitions)
-- ===========================================

CREATE TABLE workflow_gates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transition_id UUID NOT NULL REFERENCES workflow_transitions(id) ON DELETE CASCADE,
  
  name TEXT NOT NULL,                    -- "Engineering Review", "QA Sign-off"
  description TEXT,
  
  -- Gate type
  gate_type TEXT NOT NULL DEFAULT 'approval',  -- 'approval', 'checklist', 'condition', 'notification'
  
  -- For approval gates: who needs to approve
  required_approvals INTEGER DEFAULT 1,   -- How many approvals needed
  approval_mode TEXT DEFAULT 'any',       -- 'any', 'all', 'sequential'
  
  -- For checklist gates: items that must be checked
  checklist_items JSONB DEFAULT '[]'::jsonb,  -- Array of {id, label, required}
  
  -- For condition gates: automatic checks
  conditions JSONB,                       -- JSON logic conditions
  
  -- Gate behavior
  is_blocking BOOLEAN DEFAULT true,       -- Must pass to proceed
  can_be_skipped_by user_role[] DEFAULT '{}'::user_role[],  -- Roles that can bypass
  
  sort_order INTEGER DEFAULT 0,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_workflow_gates_transition_id ON workflow_gates(transition_id);

-- ===========================================
-- WORKFLOW REVIEWERS (Users/groups assigned to gates)
-- ===========================================

CREATE TABLE workflow_gate_reviewers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gate_id UUID NOT NULL REFERENCES workflow_gates(id) ON DELETE CASCADE,
  
  -- Reviewer type: specific user or role-based
  reviewer_type TEXT NOT NULL DEFAULT 'user',  -- 'user', 'role', 'group', 'file_owner', 'checkout_user'
  
  -- For user type
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  
  -- For role type
  role user_role,
  
  -- For group type (future: user groups)
  group_name TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Ensure either user_id or role is set
  CONSTRAINT valid_reviewer CHECK (
    (reviewer_type = 'user' AND user_id IS NOT NULL) OR
    (reviewer_type = 'role' AND role IS NOT NULL) OR
    (reviewer_type IN ('file_owner', 'checkout_user', 'group'))
  )
);

CREATE INDEX idx_workflow_gate_reviewers_gate_id ON workflow_gate_reviewers(gate_id);
CREATE INDEX idx_workflow_gate_reviewers_user_id ON workflow_gate_reviewers(user_id);

-- ===========================================
-- FILE WORKFLOW ASSIGNMENTS (Which workflow a file uses)
-- ===========================================

CREATE TABLE file_workflow_assignments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  workflow_id UUID NOT NULL REFERENCES workflow_templates(id) ON DELETE CASCADE,
  current_state_id UUID REFERENCES workflow_states(id),
  
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  assigned_by UUID REFERENCES users(id),
  
  UNIQUE(file_id)
);

CREATE INDEX idx_file_workflow_assignments_file_id ON file_workflow_assignments(file_id);
CREATE INDEX idx_file_workflow_assignments_workflow_id ON file_workflow_assignments(workflow_id);
CREATE INDEX idx_file_workflow_assignments_current_state ON file_workflow_assignments(current_state_id);

-- ===========================================
-- PENDING REVIEWS (Active review requests)
-- ===========================================

CREATE TABLE pending_reviews (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  
  -- What's being reviewed
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  transition_id UUID NOT NULL REFERENCES workflow_transitions(id) ON DELETE CASCADE,
  gate_id UUID NOT NULL REFERENCES workflow_gates(id) ON DELETE CASCADE,
  
  -- Review request info
  requested_by UUID NOT NULL REFERENCES users(id),
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Status
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'approved', 'rejected', 'cancelled'
  
  -- Optional: specific reviewer requested (NULL = any valid reviewer)
  assigned_to UUID REFERENCES users(id),
  
  -- Response
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  review_comment TEXT,
  
  -- For checklist gates: completed items
  checklist_responses JSONB DEFAULT '{}'::jsonb,
  
  expires_at TIMESTAMPTZ,                 -- Optional deadline
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_pending_reviews_org_id ON pending_reviews(org_id);
CREATE INDEX idx_pending_reviews_file_id ON pending_reviews(file_id);
CREATE INDEX idx_pending_reviews_status ON pending_reviews(status);
CREATE INDEX idx_pending_reviews_assigned_to ON pending_reviews(assigned_to);
CREATE INDEX idx_pending_reviews_requested_by ON pending_reviews(requested_by);

-- ===========================================
-- REVIEW HISTORY (Completed reviews audit trail)
-- ===========================================

CREATE TABLE review_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  
  -- What was reviewed
  file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  file_path TEXT NOT NULL,               -- Preserved even if file deleted
  file_name TEXT NOT NULL,
  
  -- Workflow context
  workflow_id UUID REFERENCES workflow_templates(id) ON DELETE SET NULL,
  workflow_name TEXT NOT NULL,
  transition_id UUID REFERENCES workflow_transitions(id) ON DELETE SET NULL,
  from_state_name TEXT NOT NULL,
  to_state_name TEXT NOT NULL,
  gate_id UUID REFERENCES workflow_gates(id) ON DELETE SET NULL,
  gate_name TEXT NOT NULL,
  
  -- Review info
  requested_by UUID REFERENCES users(id),
  requested_by_email TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL,
  
  reviewed_by UUID REFERENCES users(id),
  reviewed_by_email TEXT NOT NULL,
  reviewed_at TIMESTAMPTZ NOT NULL,
  
  -- Outcome
  decision TEXT NOT NULL,                -- 'approved', 'rejected'
  comment TEXT,
  checklist_responses JSONB,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_review_history_org_id ON review_history(org_id);
CREATE INDEX idx_review_history_file_id ON review_history(file_id);
CREATE INDEX idx_review_history_reviewed_at ON review_history(reviewed_at DESC);
CREATE INDEX idx_review_history_reviewed_by ON review_history(reviewed_by);

-- ===========================================
-- ROW LEVEL SECURITY
-- ===========================================

ALTER TABLE workflow_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_gates ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_gate_reviewers ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_workflow_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_history ENABLE ROW LEVEL SECURITY;

-- Workflow templates: All org members can view, only admins can modify
CREATE POLICY "Users can view org workflow templates"
  ON workflow_templates FOR SELECT
  USING (org_id IN (SELECT org_id FROM users WHERE id = auth.uid()));

CREATE POLICY "Admins can insert workflow templates"
  ON workflow_templates FOR INSERT
  WITH CHECK (org_id IN (SELECT org_id FROM users WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "Admins can update workflow templates"
  ON workflow_templates FOR UPDATE
  USING (org_id IN (SELECT org_id FROM users WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "Admins can delete workflow templates"
  ON workflow_templates FOR DELETE
  USING (org_id IN (SELECT org_id FROM users WHERE id = auth.uid() AND role = 'admin'));

-- Workflow states: Same as templates (inherit from workflow)
CREATE POLICY "Users can view workflow states"
  ON workflow_states FOR SELECT
  USING (workflow_id IN (
    SELECT id FROM workflow_templates WHERE org_id IN (SELECT org_id FROM users WHERE id = auth.uid())
  ));

CREATE POLICY "Admins can manage workflow states"
  ON workflow_states FOR ALL
  USING (workflow_id IN (
    SELECT id FROM workflow_templates WHERE org_id IN (SELECT org_id FROM users WHERE id = auth.uid() AND role = 'admin')
  ));

-- Workflow transitions: Same pattern
CREATE POLICY "Users can view workflow transitions"
  ON workflow_transitions FOR SELECT
  USING (workflow_id IN (
    SELECT id FROM workflow_templates WHERE org_id IN (SELECT org_id FROM users WHERE id = auth.uid())
  ));

CREATE POLICY "Admins can manage workflow transitions"
  ON workflow_transitions FOR ALL
  USING (workflow_id IN (
    SELECT id FROM workflow_templates WHERE org_id IN (SELECT org_id FROM users WHERE id = auth.uid() AND role = 'admin')
  ));

-- Workflow gates: Inherit from transition
CREATE POLICY "Users can view workflow gates"
  ON workflow_gates FOR SELECT
  USING (transition_id IN (
    SELECT t.id FROM workflow_transitions t
    JOIN workflow_templates wt ON t.workflow_id = wt.id
    WHERE wt.org_id IN (SELECT org_id FROM users WHERE id = auth.uid())
  ));

CREATE POLICY "Admins can manage workflow gates"
  ON workflow_gates FOR ALL
  USING (transition_id IN (
    SELECT t.id FROM workflow_transitions t
    JOIN workflow_templates wt ON t.workflow_id = wt.id
    WHERE wt.org_id IN (SELECT org_id FROM users WHERE id = auth.uid() AND role = 'admin')
  ));

-- Gate reviewers: Same pattern
CREATE POLICY "Users can view gate reviewers"
  ON workflow_gate_reviewers FOR SELECT
  USING (gate_id IN (
    SELECT g.id FROM workflow_gates g
    JOIN workflow_transitions t ON g.transition_id = t.id
    JOIN workflow_templates wt ON t.workflow_id = wt.id
    WHERE wt.org_id IN (SELECT org_id FROM users WHERE id = auth.uid())
  ));

CREATE POLICY "Admins can manage gate reviewers"
  ON workflow_gate_reviewers FOR ALL
  USING (gate_id IN (
    SELECT g.id FROM workflow_gates g
    JOIN workflow_transitions t ON g.transition_id = t.id
    JOIN workflow_templates wt ON t.workflow_id = wt.id
    WHERE wt.org_id IN (SELECT org_id FROM users WHERE id = auth.uid() AND role = 'admin')
  ));

-- File workflow assignments: Users can view, admins can manage
CREATE POLICY "Users can view file workflow assignments"
  ON file_workflow_assignments FOR SELECT
  USING (file_id IN (
    SELECT id FROM files WHERE org_id IN (SELECT org_id FROM users WHERE id = auth.uid())
  ));

CREATE POLICY "Admins and engineers can manage assignments"
  ON file_workflow_assignments FOR ALL
  USING (file_id IN (
    SELECT id FROM files WHERE org_id IN (SELECT org_id FROM users WHERE id = auth.uid() AND role IN ('admin', 'engineer'))
  ));

-- Pending reviews: Org members can view, reviewers can update
CREATE POLICY "Users can view org pending reviews"
  ON pending_reviews FOR SELECT
  USING (org_id IN (SELECT org_id FROM users WHERE id = auth.uid()));

CREATE POLICY "Users can create review requests"
  ON pending_reviews FOR INSERT
  WITH CHECK (org_id IN (SELECT org_id FROM users WHERE id = auth.uid()));

CREATE POLICY "Reviewers and admins can update pending reviews"
  ON pending_reviews FOR UPDATE
  USING (
    org_id IN (SELECT org_id FROM users WHERE id = auth.uid()) AND
    (assigned_to = auth.uid() OR assigned_to IS NULL OR 
     auth.uid() IN (SELECT id FROM users WHERE org_id = pending_reviews.org_id AND role = 'admin'))
  );

CREATE POLICY "Admins can delete pending reviews"
  ON pending_reviews FOR DELETE
  USING (org_id IN (SELECT org_id FROM users WHERE id = auth.uid() AND role = 'admin'));

-- Review history: Read-only for org members
CREATE POLICY "Users can view org review history"
  ON review_history FOR SELECT
  USING (org_id IN (SELECT org_id FROM users WHERE id = auth.uid()));

CREATE POLICY "System can insert review history"
  ON review_history FOR INSERT
  WITH CHECK (org_id IN (SELECT org_id FROM users WHERE id = auth.uid()));

-- ===========================================
-- HELPER FUNCTIONS
-- ===========================================

-- Get available transitions for a file based on current state
CREATE OR REPLACE FUNCTION get_available_transitions(p_file_id UUID)
RETURNS TABLE (
  transition_id UUID,
  transition_name TEXT,
  to_state_id UUID,
  to_state_name TEXT,
  to_state_color TEXT,
  has_gates BOOLEAN,
  user_can_transition BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    t.id AS transition_id,
    t.name AS transition_name,
    ts.id AS to_state_id,
    ts.name AS to_state_name,
    ts.color AS to_state_color,
    EXISTS(SELECT 1 FROM workflow_gates g WHERE g.transition_id = t.id) AS has_gates,
    (SELECT role FROM users WHERE id = auth.uid()) = ANY(t.allowed_roles) AS user_can_transition
  FROM file_workflow_assignments fwa
  JOIN workflow_transitions t ON t.workflow_id = fwa.workflow_id 
    AND t.from_state_id = fwa.current_state_id
  JOIN workflow_states ts ON ts.id = t.to_state_id
  WHERE fwa.file_id = p_file_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get pending reviews for current user
CREATE OR REPLACE FUNCTION get_my_pending_reviews()
RETURNS TABLE (
  review_id UUID,
  file_id UUID,
  file_name TEXT,
  file_path TEXT,
  gate_name TEXT,
  requested_by_name TEXT,
  requested_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    pr.id AS review_id,
    pr.file_id,
    f.file_name,
    f.file_path,
    g.name AS gate_name,
    COALESCE(u.full_name, u.email) AS requested_by_name,
    pr.requested_at
  FROM pending_reviews pr
  JOIN files f ON f.id = pr.file_id
  JOIN workflow_gates g ON g.id = pr.gate_id
  JOIN users u ON u.id = pr.requested_by
  WHERE pr.status = 'pending'
    AND (
      pr.assigned_to = auth.uid() OR
      pr.assigned_to IS NULL AND EXISTS (
        SELECT 1 FROM workflow_gate_reviewers gr
        WHERE gr.gate_id = pr.gate_id
          AND (
            (gr.reviewer_type = 'user' AND gr.user_id = auth.uid()) OR
            (gr.reviewer_type = 'role' AND gr.role = (SELECT role FROM users WHERE id = auth.uid())) OR
            (gr.reviewer_type = 'file_owner' AND f.created_by = auth.uid())
          )
      )
    )
  ORDER BY pr.requested_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ===========================================
-- DEFAULT WORKFLOW TEMPLATE SEED
-- ===========================================
-- Creates a standard engineering release workflow when an org is created

CREATE OR REPLACE FUNCTION create_default_workflow(p_org_id UUID, p_created_by UUID)
RETURNS UUID AS $$
DECLARE
  workflow_id UUID;
  draft_state_id UUID;
  review_state_id UUID;
  released_state_id UUID;
  obsolete_state_id UUID;
  transition_id UUID;
BEGIN
  -- Create the workflow template
  INSERT INTO workflow_templates (org_id, name, description, is_default, created_by)
  VALUES (
    p_org_id,
    'Standard Release Process',
    'Default engineering release workflow with draft, review, and release states',
    true,
    p_created_by
  )
  RETURNING id INTO workflow_id;
  
  -- Create states
  INSERT INTO workflow_states (workflow_id, name, label, description, color, icon, position_x, position_y, state_type, maps_to_file_state, is_editable, requires_checkout, sort_order)
  VALUES 
    (workflow_id, 'Draft', 'Draft', 'Work in progress', '#EAB308', 'pencil', 100, 200, 'initial', 'wip', true, true, 1)
  RETURNING id INTO draft_state_id;
  
  INSERT INTO workflow_states (workflow_id, name, label, description, color, icon, position_x, position_y, state_type, maps_to_file_state, is_editable, requires_checkout, sort_order)
  VALUES 
    (workflow_id, 'In Review', 'In Review', 'Pending approval', '#3B82F6', 'eye', 350, 200, 'intermediate', 'in_review', false, false, 2)
  RETURNING id INTO review_state_id;
  
  INSERT INTO workflow_states (workflow_id, name, label, description, color, icon, position_x, position_y, state_type, maps_to_file_state, is_editable, requires_checkout, auto_increment_revision, sort_order)
  VALUES 
    (workflow_id, 'Released', 'Released', 'Approved for production', '#22C55E', 'check-circle', 600, 200, 'final', 'released', false, false, true, 3)
  RETURNING id INTO released_state_id;
  
  INSERT INTO workflow_states (workflow_id, name, label, description, color, icon, position_x, position_y, state_type, maps_to_file_state, is_editable, requires_checkout, sort_order)
  VALUES 
    (workflow_id, 'Obsolete', 'Obsolete', 'No longer active', '#6B7280', 'archive', 600, 350, 'final', 'obsolete', false, false, 4)
  RETURNING id INTO obsolete_state_id;
  
  -- Create transitions
  -- Draft -> In Review
  INSERT INTO workflow_transitions (workflow_id, from_state_id, to_state_id, name, allowed_roles)
  VALUES (workflow_id, draft_state_id, review_state_id, 'Submit for Review', ARRAY['admin', 'engineer']::user_role[])
  RETURNING id INTO transition_id;
  
  -- Add a review gate
  INSERT INTO workflow_gates (transition_id, name, description, gate_type, required_approvals)
  VALUES (transition_id, 'Engineering Review', 'Requires engineering approval before release', 'approval', 1);
  
  -- In Review -> Released
  INSERT INTO workflow_transitions (workflow_id, from_state_id, to_state_id, name, allowed_roles)
  VALUES (workflow_id, review_state_id, released_state_id, 'Approve & Release', ARRAY['admin']::user_role[]);
  
  -- In Review -> Draft (rejection)
  INSERT INTO workflow_transitions (workflow_id, from_state_id, to_state_id, name, description, line_style, allowed_roles)
  VALUES (workflow_id, review_state_id, draft_state_id, 'Reject', 'Return to draft for revisions', 'dashed', ARRAY['admin']::user_role[]);
  
  -- Released -> Obsolete
  INSERT INTO workflow_transitions (workflow_id, from_state_id, to_state_id, name, allowed_roles)
  VALUES (workflow_id, released_state_id, obsolete_state_id, 'Mark Obsolete', ARRAY['admin']::user_role[]);
  
  -- Released -> Draft (new revision)
  INSERT INTO workflow_transitions (workflow_id, from_state_id, to_state_id, name, description, line_style, allowed_roles)
  VALUES (workflow_id, released_state_id, draft_state_id, 'New Revision', 'Start new revision of released file', 'dashed', ARRAY['admin', 'engineer']::user_role[]);
  
  RETURN workflow_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

