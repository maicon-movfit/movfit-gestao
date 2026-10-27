import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';

import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { checksumSnapshot, normalizeCompetence } from '../domain/monthly-closure.js';
import { authenticate } from '../middleware/auth.js';

const closureSchema = z.object({
  unitId: z.string().min(1).max(100),
  competence: z.string().min(7).max(10),
  snapshot: z.record(z.unknown()),
  collectedAt: z.string().datetime({ offset: true }).optional(),
  source: z.string().min(1).max(100).default('n8n'),
}).strict();

const historyQuerySchema = z.object({
  unitId: z.string().min(1).max(100).optional(),
  from: z.string().regex(/^\d{4}-\d{2}(?:-01)?$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}(?:-01)?$/).optional(),
  limit: z.coerce.number().int().min(1).max(120).default(24),
});

function hasValidIntegrationKey(receivedKey) {
  if (!config.INTEGRATION_API_KEY || typeof receivedKey !== 'string') return false;
  const expected = Buffer.from(config.INTEGRATION_API_KEY);
  const received = Buffer.from(receivedKey);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function requireIntegrationKey(request, response, next) {
  if (!config.INTEGRATION_API_KEY) {
    request.log?.error('INTEGRATION_API_KEY não configurada');
    return response.status(503).json({ error: 'monthly_closure_not_configured' });
  }
  if (!hasValidIntegrationKey(request.get('x-integration-key'))) {
    return response.status(401).json({ error: 'invalid_integration_key' });
  }
  return next();
}

export const monthlyClosuresRouter = Router();

monthlyClosuresRouter.get('/', authenticate, async (request, response, next) => {
  const validation = historyQuerySchema.safeParse(request.query);
  if (!validation.success) return response.status(400).json({ error: 'invalid_query', details: validation.error.flatten() });

  const { unitId, from, to, limit } = validation.data;
  const fromCompetence = from ? normalizeCompetence(from) : null;
  const toCompetence = to ? normalizeCompetence(to) : null;
  if ((from && !fromCompetence) || (to && !toCompetence)) {
    return response.status(400).json({ error: 'invalid_competence_filter' });
  }
  if (fromCompetence && toCompetence && fromCompetence > toCompetence) {
    return response.status(400).json({ error: 'invalid_competence_range' });
  }
  if (unitId && request.user.papel !== 'admin' && !request.user.unidades.includes(unitId)) {
    return response.status(403).json({ error: 'unit_access_denied' });
  }

  try {
    const result = await pool.query(
      `SELECT c.unidade_id AS "unitId", c.competencia, c.fechado_em AS "closedAt",
              m.nome, m.dados AS snapshot, m.origem AS source,
              m.coletado_em AS "collectedAt", m.checksum
         FROM app_competencias c
         JOIN app_meses m ON m.competencia_id = c.id
        WHERE c.status = 'fechada'
          AND ($1::text IS NULL OR c.unidade_id = $1)
          AND ($2::date IS NULL OR c.competencia >= $2::date)
          AND ($3::date IS NULL OR c.competencia <= $3::date)
          AND ($4::boolean OR c.unidade_id = ANY($5::text[]))
        ORDER BY c.competencia DESC, c.unidade_id
        LIMIT $6`,
      [unitId || null, fromCompetence, toCompetence,
        request.user.papel === 'admin', request.user.unidades, limit],
    );
    return response.json({ data: result.rows, count: result.rowCount });
  } catch (error) {
    return next(error);
  }
});

monthlyClosuresRouter.post('/', requireIntegrationKey, async (request, response, next) => {
  const validation = closureSchema.safeParse(request.body);
  if (!validation.success) {
    return response.status(400).json({ error: 'invalid_payload', details: validation.error.flatten() });
  }

  const competence = normalizeCompetence(validation.data.competence);
  if (!competence) return response.status(400).json({ error: 'invalid_competence' });

  const snapshot = {
    ...validation.data.snapshot,
    _monthlyClosure: {
      source: validation.data.source,
      collectedAt: validation.data.collectedAt || null,
    },
  };
  const checksum = checksumSnapshot(snapshot);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const unit = await client.query('SELECT id FROM app_unidades WHERE id = $1 AND ativa = true FOR SHARE', [validation.data.unitId]);
    if (!unit.rowCount) {
      await client.query('ROLLBACK');
      return response.status(404).json({ error: 'unit_not_found_or_inactive' });
    }

    const eligibility = await client.query(
      `SELECT $1::date < date_trunc('month', timezone('America/Sao_Paulo', now()))::date AS ended`,
      [competence],
    );
    if (!eligibility.rows[0].ended) {
      await client.query('ROLLBACK');
      return response.status(422).json({ error: 'competence_not_ended' });
    }

    const period = await client.query(
      `INSERT INTO app_competencias (unidade_id, competencia)
       VALUES ($1, $2::date)
       ON CONFLICT (unidade_id, competencia) DO NOTHING
       RETURNING id, status`,
      [validation.data.unitId, competence],
    );
    let competenceRow = period.rows[0];
    if (!competenceRow) {
      const existing = await client.query(
        'SELECT id, status FROM app_competencias WHERE unidade_id = $1 AND competencia = $2::date FOR UPDATE',
        [validation.data.unitId, competence],
      );
      competenceRow = existing.rows[0];
      if (!competenceRow) {
        await client.query('ROLLBACK');
        return next(new Error('Competência não encontrada após inserção.'));
      }
    }

    if (competenceRow.status === 'fechada') {
      const saved = await client.query('SELECT checksum FROM app_meses WHERE competencia_id = $1', [competenceRow.id]);
      await client.query('ROLLBACK');
      if (saved.rows[0]?.checksum === checksum) {
        return response.status(200).json({ status: 'already_closed', unitId: validation.data.unitId, competence });
      }
      return response.status(409).json({ error: 'competence_already_closed', unitId: validation.data.unitId, competence });
    }

    await client.query(
      `INSERT INTO app_meses (competencia_id, nome, dados, origem, checksum, coletado_em)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6::timestamptz)
       ON CONFLICT (competencia_id) DO UPDATE SET
         nome = EXCLUDED.nome, dados = EXCLUDED.dados, origem = EXCLUDED.origem,
         checksum = EXCLUDED.checksum, coletado_em = EXCLUDED.coletado_em, atualizado_em = now()`,
      [competenceRow.id, competence.slice(0, 7), JSON.stringify(snapshot), validation.data.source, checksum, validation.data.collectedAt || null],
    );
    await client.query(
      `UPDATE app_competencias
          SET status = 'fechada', fechado_em = now(), fechado_por = NULL, atualizado_em = now()
        WHERE id = $1`,
      [competenceRow.id],
    );
    await client.query(
      `INSERT INTO app_auditoria (unidade_id, entidade, entidade_id, acao, depois, ip)
       VALUES ($1, 'competencia', $2, 'fechamento_automatico', $3::jsonb, $4)`,
      [validation.data.unitId, competenceRow.id, JSON.stringify({ competencia: competence, source: validation.data.source, checksum }), request.ip],
    );
    await client.query('COMMIT');
    return response.status(201).json({ status: 'closed', unitId: validation.data.unitId, competence });
  } catch (error) {
    await client.query('ROLLBACK');
    return next(error);
  } finally {
    client.release();
  }
});
