/**
 * Trash Routes
 *
 * List and restore deleted files.
 */

import { FastifyPluginAsync } from 'fastify'
import { triggerWebhooks } from '../utils/index.js'

const trashRoutes: FastifyPluginAsync = async (fastify) => {
  // List deleted files
  fastify.get(
    '/trash',
    {
      schema: {
        description: 'List deleted files',
        tags: ['Trash'],
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            vault_id: { type: 'string', format: 'uuid' },
          },
        },
      },
      preHandler: fastify.authenticate,
    },
    async (request) => {
      const { vault_id } = request.query as { vault_id?: string }

      let query = request
        .supabase!.from('files')
        .select(
          `
        id, file_path, file_name, extension, deleted_at, deleted_by,
        deleted_by_user:users!deleted_by(email, full_name)
      `,
        )
        .eq('org_id', request.user!.org_id)
        .not('deleted_at', 'is', null)
        .order('deleted_at', { ascending: false })

      if (vault_id) query = query.eq('vault_id', vault_id)

      const { data, error } = await query
      if (error) throw error

      return { files: data }
    },
  )

  // Restore file from trash
  fastify.post(
    '/trash/:id/restore',
    {
      schema: {
        description: 'Restore file from trash',
        tags: ['Trash'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
      preHandler: fastify.authenticate,
    },
    async (request) => {
      const { id } = request.params as { id: string }

      const { data: file } = await request
        .supabase!.from('files')
        .select('file_path, file_name')
        .eq('id', id)
        .single()

      // Also bump updated_at so the watermark-based delta sync (get_vault_files_delta)
      // surfaces the restore to other clients even if the deployed RPC keys off
      // updated_at. Without this, other machines keep the row cached as trashed.
      const { data, error } = await request
        .supabase!.from('files')
        .update({ deleted_at: null, deleted_by: null, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('org_id', request.user!.org_id)
        .select()
        .single()

      if (error) throw error

      // Trigger webhook
      await triggerWebhooks(
        request.user!.org_id!,
        'file.restore',
        {
          file_id: id,
          file_path: file?.file_path,
          file_name: file?.file_name,
          user_id: request.user!.id,
          user_email: request.user!.email,
        },
        fastify.log,
      )

      return { success: true, file: data }
    },
  )
}

export default trashRoutes
