import { Router } from 'express';
import { query } from '../db/pool.js';

export const healthRouter = Router();

healthRouter.get('/', async (_request, response, next) => {
  try {
    await query('SELECT 1');
    response.json({ status: 'ok', database: 'ok', timestamp: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
});
