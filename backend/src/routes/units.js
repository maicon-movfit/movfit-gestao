import { Router } from 'express';
import { query } from '../db/pool.js';
import { authenticate, requireUnitAccess } from '../middleware/auth.js';

export const unitsRouter = Router();

unitsRouter.use(authenticate);

unitsRouter.get('/', async (request, response, next) => {
  try {
    const admin = request.user.papel === 'admin';
    const result = await query(
      `SELECT id, nome, codigo_pacto, slug_pacto, ativa
         FROM app_unidades
        WHERE ativa = true AND ($1::boolean OR id = ANY($2::text[]))
        ORDER BY nome`,
      [admin, request.user.unidades]
    );
    response.json({ data: result.rows });
  } catch (error) {
    next(error);
  }
});

unitsRouter.get('/:unidadeId', requireUnitAccess, async (request, response, next) => {
  try {
    const result = await query(
      'SELECT id, nome, codigo_pacto, slug_pacto, ativa FROM app_unidades WHERE id = $1',
      [request.params.unidadeId]
    );
    if (!result.rows[0]) return response.status(404).json({ error: 'unit_not_found' });
    response.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});
