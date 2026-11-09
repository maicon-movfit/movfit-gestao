import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { config } from '../config.js';
import { query } from '../db/pool.js';

if (!getApps().length) {
  const credential = config.FIREBASE_SERVICE_ACCOUNT_BASE64
    ? cert(JSON.parse(Buffer.from(config.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')))
    : applicationDefault();
  initializeApp({ credential, projectId: config.FIREBASE_PROJECT_ID });
}

function bearerToken(header = '') {
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export async function authenticate(request, response, next) {
  const token = bearerToken(request.headers.authorization);
  if (!token) return response.status(401).json({ error: 'authentication_required' });

  try {
    const identity = await getAuth().verifyIdToken(token, true);
    const result = await query(
      `SELECT u.id, u.email, u.nome, u.papel, u.ativo,
              COALESCE(array_agg(uu.unidade_id) FILTER (WHERE uu.unidade_id IS NOT NULL), '{}') AS unidades
         FROM app_usuarios u
         LEFT JOIN app_usuario_unidades uu ON uu.usuario_id = u.id
        WHERE lower(u.email) = lower($1)
        GROUP BY u.id`,
      [identity.email || '']
    );
    const user = result.rows[0];
    if (!user?.ativo) return response.status(403).json({ error: 'user_not_authorized' });
    request.user = { ...user, firebaseUid: identity.uid };
    next();
  } catch (error) {
    request.log?.warn({ err: error }, 'Falha ao autenticar usuário');
    return response.status(401).json({ error: 'invalid_or_expired_token' });
  }
}

export function requireUnitAccess(request, response, next) {
  const unidadeId = request.params.unidadeId || request.body?.unidadeId || request.query?.unidadeId;
  if (!unidadeId) return response.status(400).json({ error: 'unit_required' });
  if (request.user.papel === 'admin' || request.user.unidades.includes(unidadeId)) return next();
  return response.status(403).json({ error: 'unit_access_denied' });
}
