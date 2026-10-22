// API MovFit para MCP Pacto — Firebase Cloud Functions (mesmo projeto do login).
// Deploy: na pasta do repo, `firebase deploy --only functions`
// Não usa n8n para login nem para chamadas MCP.

const PACTO_MCP_FUNCTIONS_BASE = 'https://us-central1-mov-fit---gestao-de-carteira.cloudfunctions.net';

const PACTO_MCP_OAUTH_API_URL = `${PACTO_MCP_FUNCTIONS_BASE}/pactoMcpOAuth`;
const PACTO_MCP_RPC_API_URL = `${PACTO_MCP_FUNCTIONS_BASE}/pactoMcpRpc`;

async function pactoMcpApiAuthHeaders() {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  const usuario = typeof auth !== 'undefined' ? auth.currentUser : null;
  if (usuario && typeof usuario.getIdToken === 'function') {
    try {
      const idToken = await usuario.getIdToken(false);
      if (idToken) headers.Authorization = `Bearer ${idToken}`;
    } catch (e) {
      console.warn('[PACTO MCP API] Sessão Firebase indisponível.', e);
    }
  }
  return headers;
}
