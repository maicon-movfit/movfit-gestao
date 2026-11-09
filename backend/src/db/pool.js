import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

const connection = config.DATABASE_URL
  ? { connectionString: config.DATABASE_URL }
  : {
      host: config.DB_HOST,
      port: config.DB_PORT,
      database: config.DB_NAME,
      user: config.DB_USER,
      password: config.DB_PASSWORD
    };

export const pool = new Pool({
  ...connection,
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
