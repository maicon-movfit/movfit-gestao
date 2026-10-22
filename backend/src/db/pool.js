import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl: config.DATABASE_SSL ? { rejectUnauthorized: true } : false,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000
});

pool.on('error', error => {
  console.error('Erro inesperado no pool PostgreSQL:', error);
});

export async function query(text, values = []) {
  return pool.query(text, values);
}
