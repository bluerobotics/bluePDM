/**
 * File JSON Schemas
 *
 * Schemas for file and activity responses.
 */

export const fileSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    file_path: { type: 'string' },
    file_name: { type: 'string' },
    extension: { type: 'string' },
    file_type: { type: 'string', enum: ['part', 'assembly', 'drawing', 'document', 'other'] },
    part_number: { type: ['string', 'null'] },
    description: { type: ['string', 'null'] },
    revision: { type: 'string' },
    version: { type: 'integer' },
    content_hash: { type: 'string' },
    file_size: { type: 'integer' },
    state: { type: 'string', enum: ['not_tracked', 'wip', 'in_review', 'released', 'obsolete'] },
    checked_out_by: { type: ['string', 'null'] },
    checked_out_at: { type: ['string', 'null'] },
    checked_out_file_path: { type: ['string', 'null'] },
    checked_out_file_name: { type: ['string', 'null'] },
  },
} as const
