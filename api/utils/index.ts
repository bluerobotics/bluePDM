/**
 * Utils Barrel Export
 */

// Error responses
export { sendError, ErrorCode } from './errors.js'

// Crypto utilities
export { computeHash, generateWebhookSecret, signWebhookPayload } from './crypto.js'

// File utilities
export { getFileTypeFromExtension } from './files.js'

// LIKE pattern escaping (copy of src/lib/utils/likePattern.ts - see that file)
export { escapeLikePattern, folderPrefixLikePattern } from './likePattern.js'

// Odoo integration.
// The unguarded transport (odooXmlRpc) is deliberately not re-exported here:
// reaching it requires importing './odoo.js' directly, so the guarded wrapper
// is the path of least resistance for new code.
export {
  odooReadOnlyCall,
  assertOdooReadOnly,
  ODOO_ALLOWED_ORM_METHODS,
  ODOO_ALLOWED_MODELS,
  ODOO_ALLOWED_SERVICE_METHODS,
  normalizeOdooUrl,
  testOdooConnection,
  fetchOdooSuppliers,
  getLastXmlResponses,
  clearLastXmlResponses,
} from './odoo.js'

// Webhooks
export { webhooks, triggerWebhooks } from './webhooks.js'

// Workflow engine
export { changeFileStateViaWorkflow, stateChangeErrorResponse } from './workflow.js'
export type { LegacyFileState, StateChangeResult } from './workflow.js'
