import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pool } from '../src/db/pool.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = resolve(currentDirectory, '../migrations');

const client = await pool.connect();

try {
  await client.query('SELECT pg_advisory_lock($1)', [20261022]);
  await client.query(`
    CREATE TABLE IF NOT EXISTS app_schema_migrations (
      arquivo text PRIMARY KEY,
      aplicado_em timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const alreadyApplied = await client.query(
      'SELECT 1 FROM app_schema_migrations WHERE arquivo = $1',
      [file],
    );

    if (alreadyApplied.rowCount) {
      console.log(`ignorada: ${file}`);
      continue;
    }

    const sql = await readFile(resolve(migrationsDirectory, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(
        'INSERT INTO app_schema_migrations (arquivo) VALUES ($1)',
        [file],
      );
      await client.query('COMMIT');
      console.log(`aplicada: ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally {
  await client.query('SELECT pg_advisory_unlock($1)', [20261022]).catch(() => {});
  client.release();
  await pool.end();
}
