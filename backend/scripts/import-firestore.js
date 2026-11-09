import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { pool } from '../src/db/pool.js';

const sourceFile = process.argv[2];
const dryRun = process.argv.includes('--dry-run');

if (!sourceFile) {
  throw new Error('Uso: npm run import:firestore -- caminho/export.json [--dry-run]');
}

function validateDocument(document, index) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`Documento ${index} inválido.`);
  }
  const path = String(document.path || '').replace(/^\/+|\/+$/g, '');
  const segments = path.split('/').filter(Boolean);
  if (!path || segments.length < 2 || segments.length % 2 !== 0) {
    throw new Error(`Caminho Firestore inválido no documento ${index}: ${path || '(vazio)'}`);
  }
  if (!document.data || typeof document.data !== 'object' || Array.isArray(document.data)) {
    throw new Error(`O documento ${path} precisa conter um objeto data.`);
  }

  const unitIndex = segments.indexOf('unidades');
  return {
    path,
    collection: segments.at(-2),
    documentId: segments.at(-1),
    parentPath: segments.slice(0, -2).join('/') || null,
    unitId: unitIndex >= 0 ? segments[unitIndex + 1] || null : null,
    data: document.data,
    createdAt: document.createdAt || null,
    updatedAt: document.updatedAt || null,
  };
}

const absoluteFile = resolve(sourceFile);
const raw = await readFile(absoluteFile, 'utf8');
const parsed = JSON.parse(raw);
const documents = Array.isArray(parsed) ? parsed : parsed.documents;

if (!Array.isArray(documents)) {
  throw new Error('O JSON precisa ser um array ou conter a propriedade documents.');
}

const normalized = documents.map(validateDocument);
const duplicatePaths = normalized
  .map((document) => document.path)
  .filter((path, index, paths) => paths.indexOf(path) !== index);
if (duplicatePaths.length) {
  throw new Error(`Caminhos duplicados no arquivo: ${[...new Set(duplicatePaths)].join(', ')}`);
}

if (dryRun) {
  console.log(JSON.stringify({ valido: true, documentos: normalized.length }, null, 2));
  process.exit(0);
}

const client = await pool.connect();
let importId;

try {
  await client.query('BEGIN');
  const batch = await client.query(
    `INSERT INTO app_importacoes (origem, arquivo, status, total_documentos, checksum, detalhes)
     VALUES ('firestore', $1, 'iniciada', $2, $3, $4::jsonb)
     RETURNING id`,
    [absoluteFile, normalized.length, createHash('sha256').update(raw).digest('hex'), JSON.stringify({ exportedAt: parsed.exportedAt || null })],
  );
  importId = batch.rows[0].id;

  for (const document of normalized) {
    const dataJson = JSON.stringify(document.data);
    const checksum = createHash('sha256').update(dataJson).digest('hex');
    await client.query(
      `INSERT INTO app_documentos_legados
        (caminho, colecao, documento_id, caminho_pai, unidade_id, dados, checksum,
         importacao_id, origem_criado_em, origem_atualizado_em)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
       ON CONFLICT (caminho) DO UPDATE SET
         colecao = EXCLUDED.colecao,
         documento_id = EXCLUDED.documento_id,
         caminho_pai = EXCLUDED.caminho_pai,
         unidade_id = EXCLUDED.unidade_id,
         dados = EXCLUDED.dados,
         checksum = EXCLUDED.checksum,
         importacao_id = EXCLUDED.importacao_id,
         versao = CASE
           WHEN app_documentos_legados.checksum <> EXCLUDED.checksum
           THEN app_documentos_legados.versao + 1
           ELSE app_documentos_legados.versao
         END,
         excluido = false,
         origem_criado_em = COALESCE(EXCLUDED.origem_criado_em, app_documentos_legados.origem_criado_em),
         origem_atualizado_em = EXCLUDED.origem_atualizado_em,
         atualizado_em = now()
       RETURNING caminho, versao, dados, checksum`,
      [document.path, document.collection, document.documentId, document.parentPath,
       document.unitId, dataJson, checksum, importId, document.createdAt, document.updatedAt],
    );
  }

  await client.query(
    `UPDATE app_importacoes
        SET status = 'concluida', concluida_em = now()
      WHERE id = $1`,
    [importId],
  );
  await client.query('COMMIT');
  console.log(JSON.stringify({ sucesso: true, importacaoId: importId, documentos: normalized.length }, null, 2));
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
