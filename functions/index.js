const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

admin.initializeApp();

const ORIGENS = [
  'https://maicon-movfit.github.io',
  'https://mov-fit---gestao-de-carteira.web.app',
  'https://mov-fit---gestao-de-carteira.firebaseapp.com',
];

function cors(req, res) {
  const origin = req.get('Origin') || '';
  if (ORIGENS.some((o) => origin === o || origin.startsWith(`${o}/`))) {
    res.set('Access-Control-Allow-Origin', origin);
  }
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
}

exports.pactoMcpOAuthToken = onRequest(
  { region: 'us-central1', invoker: 'public' },
  async (req, res) => {
    cors(req, res);
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Use POST' });
      return;
    }

    const authHeader = req.get('Authorization') || '';
    const idToken = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!idToken) {
      res.status(401).json({ error: 'Faça login no MovFit e tente conectar de novo.' });
      return;
    }
    try {
      await admin.auth().verifyIdToken(idToken);
    } catch (_) {
      res.status(401).json({ error: 'Sessão MovFit inválida. Entre de novo no gestão.' });
      return;
    }

    const body = req.body || {};
    const endpoint = body.token_endpoint || 'https://mcp-auth.conversas.ai/oauth/token';
    const params = new URLSearchParams();

    if (body.grant_type === 'refresh_token') {
      params.set('grant_type', 'refresh_token');
      params.set('refresh_token', String(body.refresh_token || ''));
      params.set('client_id', String(body.client_id || ''));
      if (body.resource) params.set('resource', String(body.resource));
    } else {
      params.set('grant_type', 'authorization_code');
      params.set('code', String(body.code || ''));
      params.set('redirect_uri', String(body.redirect_uri || ''));
      params.set('client_id', String(body.client_id || ''));
      params.set('code_verifier', String(body.code_verifier || ''));
      if (body.resource) params.set('resource', String(body.resource));
    }

    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: params.toString(),
      });
      const text = await r.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (_) {
        data = { error: text.slice(0, 200) };
      }
      if (!r.ok) {
        res.status(r.status).json(data);
        return;
      }
      res.json(data);
    } catch (e) {
      res.status(502).json({ error: e.message || 'Falha ao falar com a Pacto' });
    }
  },
);
