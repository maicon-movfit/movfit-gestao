import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';

import { pool, query } from '../db/pool.js';
import { canAccessDocument, parseDocumentPath } from '../domain/document-path.js';
import { authenticate } from '../middleware/auth.js';

const writeSchema = z.object({
  path: z.string().min(3),
  data: z.record(z.unknown()),
  expectedVersion: z.number().int().positive().optional(),
});
const deleteSchema = z.object({
  path: z.string().min(3),
  expectedVersion: z.coerce.number().int().positive().optional(),
});

export const documentsRouter = Router();
documentsRouter.use(authenticate);

function authorize(request, response, path) {
  const parsed = parseDocumentPath(path);
  if (!canAccessDocument(request.user, parsed)) {
    response.status(403).json({ error: 'document_access_denied' });
    return null;
  }
  return parsed;
}

documentsRouter.get('/', async (request, response, next) => {
  try {
    const parsed = authorize(request, response, request.query.path);
    if (!parsed) return;
    const result = await query(
      `SELECT caminho AS path, dados AS data, versao AS version,
              origem_criado_em AS "sourceCreatedAt",
              origem_atualizado_em AS "sourceUpdatedAt", atualizado_em AS "updatedAt"
         FROM app_documentos_legados
        WHERE caminho = $1 AND excluido = false`,
      [parsed.path],
    );
    if (!result.rows[0]) return response.status(404).json({ error: 'document_not_found' });
    response.json(result.rows[0]);
  } catch (error) {
    if (error.code === 'invalid_document_path') return response.status(400).json({ error: error.code });
    next(error);
  }
});

documentsRouter.get('/children', async (request, response, next) => {
  try {
    const syntheticPath = `${String(request.query.parent || '').replace(/\/$/, '')}/${request.query.collection}/_permission_check`;
    const parsed = authorize(request, response, syntheticPath);
    if (!parsed) return;
    const limit = Math.min(Math.max(Number(request.query.limit) || 500, 1), 2000);
    const result = await query(
      `SELECT caminho AS path, documento_id AS id, dados AS data, versao AS version,
              atualizado_em AS "updatedAt"
         FROM app_documentos_legados
        WHERE caminho_pai IS NOT DISTINCT FROM $1
          AND colecao = $2 AND excluido = false
        ORDER BY documento_id
        LIMIT $3`,
      [parsed.parentPath, parsed.collection, limit],
    );
    response.json({ data: result.rows, count: result.rowCount });
  } catch (error) {
    if (error.code === 'invalid_document_path') return response.status(400).json({ error: error.code });
    next(error);
  }
});

documentsRouter.put('/', async (request, response, next) => {
  const validation = writeSchema.safeParse(request.body);
  if (!validation.success) return response.status(400).json({ error: 'invalid_payload', details: validation.error.flatten() });
  const client = await pool.connect();
  try {
    const parsed = authorize(request, response, validation.data.path);
    if (!parsed) return;
    const dataJson = JSON.stringify(validation.data.data);
    const checksum = createHash('sha256').update(dataJson).digest('hex');
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT versao FROM app_documentos_legados WHERE caminho = $1 FOR UPDATE',
      [parsed.path],
    );
    const currentVersion = existing.rows[0]?.versao;
    if (validation.data.expectedVersion && currentVersion !== validation.data.expectedVersion) {
      await client.query('ROLLBACK');
      return response.status(409).json({ error: 'version_conflict', currentVersion: currentVersion || null });
    }
    const result = await client.query(
      `INSERT INTO app_documentos_legados
        (caminho, colecao, documento_id, caminho_pai, unidade_id, dados, checksum)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (caminho) DO UPDATE SET
         dados = EXCLUDED.dados, checksum = EXCLUDED.checksum,
         versao = CASE WHEN app_documentos_legados.checksum <> EXCLUDED.checksum
                       THEN app_documentos_legados.versao + 1
                       ELSE app_documentos_legados.versao END,
         excluido = false, atualizado_em = now()
       RETURNING caminho AS path, dados AS data, versao AS version, atualizado_em AS "updatedAt"`,
      [parsed.path, parsed.collection, parsed.documentId, parsed.parentPath, parsed.unitId, dataJson, checksum],
    );
    await client.query(
      `INSERT INTO app_auditoria (usuario_id, entidade, entidade_id, acao, depois, ip)
       VALUES ($1, 'documento', $2, 'salvar', $3::jsonb, $4)`,
      [request.user.id, parsed.path, dataJson, request.ip],
    );
    await client.query('COMMIT');
    response.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === 'invalid_document_path') return response.status(400).json({ error: error.code });
    next(error);
  } finally {
    client.release();
  }
});

documentsRouter.delete('/', async (request, response, next) => {
  const validation = deleteSchema.safeParse(request.query);
  if (!validation.success) return response.status(400).json({ error: 'invalid_payload' });
  try {
    const parsed = authorize(request, response, validation.data.path);
    if (!parsed) return;
    const parameters = [parsed.path];
    let versionClause = '';
    if (validation.data.expectedVersion) {
      parameters.push(validation.data.expectedVersion);
      versionClause = 'AND versao = $2';
    }
    const result = await query(
      `UPDATE app_documentos_legados
          SET excluido = true, versao = versao + 1, atualizado_em = now()
        WHERE caminho = $1 AND excluido = false ${versionClause}
        RETURNING caminho`,
      parameters,
    );
    if (!result.rowCount) return response.status(409).json({ error: 'document_not_found_or_version_conflict' });
    response.status(204).end();
  } catch (error) {
    if (error.code === 'invalid_document_path') return response.status(400).json({ error: error.code });
    next(error);
  }
});
