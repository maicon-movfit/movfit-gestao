const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

admin.initializeApp();

function applyCors(req, res) {
  const origin = req.get('Origin') || '';
  if (
    origin.includes('maicon-movfit.github.io')
    || origin.includes('mov-fit---gestao-de-carteira')
    || origin.startsWith('http://localhost')
    || origin.startsWith('http://127.0.0.1')
  ) {
    res.set('Access-Control-Allow-Origin', origin);
  }
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return true;
  }
  return false;
}

async function verifyFirebaseUser(req) {
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    const err = new Error('Faça login no MovFit antes de conectar a Pacto.');
    err.status = 401;
    throw err;
  }
  return admin.auth().verifyIdToken(match[1]);
}

function flattenPactoAuth(data) {
  if (data == null) return { error: 'empty_response', error_description: 'Resposta vazia do mcp-auth' };
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return { error: 'parse_error', error_description: data }; }
  }
  if (data.detail && typeof data.detail === 'object') return { ...data, ...data.detail };
  return data;
}

function formUrlEncoded(pairs) {
  const enc = (s) => encodeURIComponent(String(s ?? ''));
  return pairs.filter(([, v]) => v != null && v !== '').map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');
}

async function pactoTokenExchange(body) {
  const acao = String(body.acao || 'token').toLowerCase();
  const endpoint = body.token_endpoint || 'https://mcp-auth.conversas.ai/oauth/token';
  let pairs;
  if (acao === 'refresh') {
    pairs = [
      ['grant_type', 'refresh_token'],
      ['refresh_token', body.refresh_token],
      ['client_id', body.client_id],
      ['resource', body.resource],
    ];
  } else {
    pairs = [
      ['grant_type', 'authorization_code'],
      ['code', body.code],
      ['redirect_uri', body.redirect_uri],
      ['client_id', body.client_id],
      ['code_verifier', body.code_verifier],
      ['resource', body.resource],
    ];
  }
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: formUrlEncoded(pairs),
  });
  const text = await resp.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: 'parse_error', error_description: text }; }
  return flattenPactoAuth(data);
}

function parseSseBody(text) {
  const lines = String(text || '').split(/\r?\n/);
  let lastJson = null;
  lines.forEach((line) => {
    if (!line.startsWith('data:')) return;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') return;
    try { lastJson = JSON.parse(raw); } catch (_) { /* ignore */ }
  });
  return lastJson;
}

async function mcpForward({ url, token, method, params, sessionId }) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${token}`,
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: Math.floor(Math.random() * 1e9),
    method,
    params: params || {},
  });

  const resp = await fetch(url, { method: 'POST', headers, body });
  const newSession = resp.headers.get('Mcp-Session-Id') || sessionId || null;
  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  let data;
  if (ct.includes('text/event-stream')) {
    data = parseSseBody(await resp.text());
  } else {
    data = await resp.json();
  }
  if (!resp.ok) {
    const err = new Error(data?.error?.message || `MCP HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  if (!data) {
    const err = new Error('Resposta MCP vazia');
    err.status = 502;
    throw err;
  }
  if (data.error) {
    const err = new Error(data.error.message || JSON.stringify(data.error));
    err.status = 502;
    throw err;
  }
  return { result: data.result, sessionId: newSession };
}

exports.pactoMcpOAuth = onRequest({ region: 'us-central1', cors: false }, async (req, res) => {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  try {
    await verifyFirebaseUser(req);
    const data = await pactoTokenExchange(req.body || {});
    res.status(200).json(data);
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.code || 'oauth_failed',
      error_description: e.message || String(e),
    });
  }
});

exports.pactoMcpRpc = onRequest({ region: 'us-central1', cors: false }, async (req, res) => {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  try {
    await verifyFirebaseUser(req);
    const { url, token, method, params, sessionId } = req.body || {};
    if (!url || !token || !method) {
      res.status(400).json({ error: 'invalid_request', error_description: 'url, token e method obrigatórios' });
      return;
    }
    const out = await mcpForward({ url, token, method, params, sessionId });
    res.status(200).json(out);
  } catch (e) {
    res.status(e.status || 500).json({
      error: 'mcp_proxy_failed',
      error_description: e.message || String(e),
    });
  }
});
