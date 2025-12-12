// Workflow Types for BluePDM
// Visual workflow builder for managing file states, gates, and reviews

// ===========================================
// WORKFLOW TEMPLATE (Org-wide workflow definition)
// ===========================================

export interface WorkflowTemplate {
  id: string
  org_id: string
  name: string
  description: string | null
  is_default: boolean
  is_active: boolean
  canvas_config: CanvasConfig
  created_at: string
  created_by: string | null
  updated_at: string
  updated_by: string | null
}

export interface CanvasConfig {
  zoom: number
  panX: number
  panY: number
}

// ===========================================
// WORKFLOW STATE (Node in the workflow)
// ===========================================

export type WorkflowStateType = 'initial' | 'intermediate' | 'final' | 'rejected'
export type FileStateMapping = 'not_tracked' | 'wip' | 'in_review' | 'released' | 'obsolete'

export interface WorkflowState {
  id: string
  workflow_id: string
  name: string
  label: string | null
  description: string | null
  color: string
  icon: string
  position_x: number
  position_y: number
  state_type: WorkflowStateType
  maps_to_file_state: FileStateMapping
  is_editable: boolean
  requires_checkout: boolean
  auto_increment_revision: boolean
  sort_order: number
  created_at: string
}

// For the visual builder - includes computed UI state
export interface WorkflowStateNode extends WorkflowState {
  isSelected?: boolean
  isDragging?: boolean
  isHovered?: boolean
}

// ===========================================
// WORKFLOW TRANSITION (Connection between states)
// ===========================================

export type TransitionLineStyle = 'solid' | 'dashed' | 'dotted'
export type UserRole = 'admin' | 'engineer' | 'viewer'

export interface WorkflowTransition {
  id: string
  workflow_id: string
  from_state_id: string
  to_state_id: string
  name: string | null
  description: string | null
  line_style: TransitionLineStyle
  line_color: string | null
  allowed_roles: UserRole[]
  auto_conditions: Record<string, unknown> | null
  created_at: string
}

// For the visual builder
export interface WorkflowTransitionEdge extends WorkflowTransition {
  isSelected?: boolean
  isHovered?: boolean
  fromState?: WorkflowState
  toState?: WorkflowState
}

// ===========================================
// WORKFLOW GATE (Approval requirement)
// ===========================================

export type GateType = 'approval' | 'checklist' | 'condition' | 'notification'
export type ApprovalMode = 'any' | 'all' | 'sequential'

export interface ChecklistItem {
  id: string
  label: string
  required: boolean
}

export interface WorkflowGate {
  id: string
  transition_id: string
  name: string
  description: string | null
  gate_type: GateType
  required_approvals: number
  approval_mode: ApprovalMode
  checklist_items: ChecklistItem[]
  conditions: Record<string, unknown> | null
  is_blocking: boolean
  can_be_skipped_by: UserRole[]
  sort_order: number
  created_at: string
}

// ===========================================
// GATE REVIEWERS (Who can approve)
// ===========================================

export type ReviewerType = 'user' | 'role' | 'group' | 'file_owner' | 'checkout_user'

export interface GateReviewer {
  id: string
  gate_id: string
  reviewer_type: ReviewerType
  user_id: string | null
  role: UserRole | null
  group_name: string | null
  created_at: string
  // Joined user data
  user?: {
    id: string
    email: string
    full_name: string | null
    avatar_url: string | null
  } | null
}

// ===========================================
// FILE WORKFLOW ASSIGNMENT
// ===========================================

export interface FileWorkflowAssignment {
  id: string
  file_id: string
  workflow_id: string
  current_state_id: string | null
  assigned_at: string
  assigned_by: string | null
  // Joined data
  current_state?: WorkflowState | null
  workflow?: WorkflowTemplate | null
}

// ===========================================
// PENDING REVIEW (Active review request)
// ===========================================

export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'cancelled'

export interface PendingReview {
  id: string
  org_id: string
  file_id: string
  transition_id: string
  gate_id: string
  requested_by: string
  requested_at: string
  status: ReviewStatus
  assigned_to: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  review_comment: string | null
  checklist_responses: Record<string, boolean>
  expires_at: string | null
  created_at: string
  // Joined data
  file?: {
    file_name: string
    file_path: string
  } | null
  gate?: WorkflowGate | null
  requester?: {
    email: string
    full_name: string | null
    avatar_url: string | null
  } | null
  assignee?: {
    email: string
    full_name: string | null
    avatar_url: string | null
  } | null
}

// ===========================================
// REVIEW HISTORY (Audit trail)
// ===========================================

export interface ReviewHistoryEntry {
  id: string
  org_id: string
  file_id: string | null
  file_path: string
  file_name: string
  workflow_id: string | null
  workflow_name: string
  transition_id: string | null
  from_state_name: string
  to_state_name: string
  gate_id: string | null
  gate_name: string
  requested_by: string | null
  requested_by_email: string
  requested_at: string
  reviewed_by: string | null
  reviewed_by_email: string
  reviewed_at: string
  decision: 'approved' | 'rejected'
  comment: string | null
  checklist_responses: Record<string, boolean> | null
  created_at: string
}

// ===========================================
// VISUAL BUILDER TYPES
// ===========================================

// Drag and drop types
export interface DragItem {
  type: 'state' | 'transition'
  id: string
}

// Canvas interaction modes
export type CanvasMode = 'select' | 'pan' | 'connect'

// Visual builder state
export interface WorkflowBuilderState {
  workflow: WorkflowTemplate | null
  states: WorkflowStateNode[]
  transitions: WorkflowTransitionEdge[]
  gates: Record<string, WorkflowGate[]> // keyed by transition_id
  reviewers: Record<string, GateReviewer[]> // keyed by gate_id
  
  // Selection
  selectedStateId: string | null
  selectedTransitionId: string | null
  selectedGateId: string | null
  
  // Canvas state
  canvasMode: CanvasMode
  zoom: number
  panX: number
  panY: number
  
  // Editing state
  isCreatingTransition: boolean
  transitionStartStateId: string | null
  
  // UI state
  isDirty: boolean
  isSaving: boolean
  showGatePanel: boolean
}

// ===========================================
// FORM/DIALOG TYPES
// ===========================================

export interface CreateStateForm {
  name: string
  label: string
  description: string
  color: string
  icon: string
  state_type: WorkflowStateType
  maps_to_file_state: FileStateMapping
  is_editable: boolean
  requires_checkout: boolean
  auto_increment_revision: boolean
}

export interface CreateTransitionForm {
  from_state_id: string
  to_state_id: string
  name: string
  description: string
  line_style: TransitionLineStyle
  allowed_roles: UserRole[]
}

export interface CreateGateForm {
  name: string
  description: string
  gate_type: GateType
  required_approvals: number
  approval_mode: ApprovalMode
  checklist_items: ChecklistItem[]
  is_blocking: boolean
  can_be_skipped_by: UserRole[]
}

export interface ReviewDecisionForm {
  decision: 'approved' | 'rejected'
  comment: string
  checklist_responses: Record<string, boolean>
}

// ===========================================
// AVAILABLE TRANSITIONS (for file context menu)
// ===========================================

export interface AvailableTransition {
  transition_id: string
  transition_name: string | null
  to_state_id: string
  to_state_name: string
  to_state_color: string
  has_gates: boolean
  user_can_transition: boolean
}

// ===========================================
// ICONS FOR STATES
// ===========================================

export const STATE_ICONS = [
  'circle',
  'pencil',
  'eye',
  'check-circle',
  'x-circle',
  'archive',
  'clock',
  'alert-triangle',
  'star',
  'flag',
  'lock',
  'unlock',
  'send',
  'inbox',
  'file-check',
  'file-x',
  'thumbs-up',
  'thumbs-down',
  'user-check',
  'users',
  'shield-check',
  'badge-check',
  'clipboard-check',
  'list-checks',
] as const

export type StateIcon = typeof STATE_ICONS[number]

// ===========================================
// COLOR PRESETS FOR STATES
// ===========================================

export const STATE_COLORS = [
  { name: 'Gray', value: '#6B7280' },
  { name: 'Red', value: '#EF4444' },
  { name: 'Orange', value: '#F97316' },
  { name: 'Amber', value: '#EAB308' },
  { name: 'Yellow', value: '#FACC15' },
  { name: 'Lime', value: '#84CC16' },
  { name: 'Green', value: '#22C55E' },
  { name: 'Emerald', value: '#10B981' },
  { name: 'Teal', value: '#14B8A6' },
  { name: 'Cyan', value: '#06B6D4' },
  { name: 'Sky', value: '#0EA5E9' },
  { name: 'Blue', value: '#3B82F6' },
  { name: 'Indigo', value: '#6366F1' },
  { name: 'Violet', value: '#8B5CF6' },
  { name: 'Purple', value: '#A855F7' },
  { name: 'Fuchsia', value: '#D946EF' },
  { name: 'Pink', value: '#EC4899' },
  { name: 'Rose', value: '#F43F5E' },
] as const

// Helper to get contrasting text color
export function getContrastColor(hexColor: string): string {
  // Remove # if present
  const hex = hexColor.replace('#', '')
  
  // Convert to RGB
  const r = parseInt(hex.substring(0, 2), 16)
  const g = parseInt(hex.substring(2, 4), 16)
  const b = parseInt(hex.substring(4, 6), 16)
  
  // Calculate luminance
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  
  return luminance > 0.5 ? '#000000' : '#FFFFFF'
}

