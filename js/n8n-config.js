// ════════════════════════════════════════════════════════════════════════
// CONFIG n8n — proxy Pacto (a key Bearer NÃO fica aqui nem no Firestore)
//
// 1) No n8n: Credentials → Header Auth com Authorization: Bearer <key Pacto>
// 2) Importe o workflow em n8n/movfit-pacto-proxy.json e ative
//    Body: action=stmpremium24 (academia) + tipo=bi|professores|carteira
// 3) Preencha abaixo a URL pública do webhook e o mesmo token do nó "Check proxy"
// ════════════════════════════════════════════════════════════════════════

/** Base do webhook (sem barra no final). Ex.: https://n8n.seudominio.com/webhook/movfit/pacto */
const N8N_PACTO_BASE = 'https://n8n2.mov.pro.br/webhook/movfit/pacto';

/**
 * Versão Firebase em validação. Mantida desativada no painel de produção até
 * comprovarmos que a resposta preserva integralmente o contrato do BI legado.
 */
const N8N_PACTO_FIREBASE_URL = '';

/**
 * Token compartilhado com o workflow n8n (header X-Movfit-Proxy).
 * NÃO é a key da Pacto — só autoriza o webhook. Gere um valor longo e rotacione se vazar.
 */
const N8N_PROXY_TOKEN = 'movfit_proxy_k7x9m2pQ4wR9';

/** Webhook da Janela de Treino (POST — retorna todas as unidades). */
const N8N_JANELA_URL = 'https://n8n2.mov.pro.br/webhook/janela_de_treino';

/** Webhook de alunos ativos por unidade (POST). */
// Legado descontinuado: alunos ativos agora vêm de N8N_PACTO_INDICADORES_URL.
const N8N_TOTAL_ATIVOS_URL = '';

/** Webhook de matriculados no mês por unidade (POST). */
const N8N_MATRICULADOS_URL = 'https://n8n2.mov.pro.br/webhook/matriculados_mes';

/** Indicadores gerenciais oficiais consultados pelo MCP da Pacto. */
const N8N_PACTO_INDICADORES_URL = 'https://n8n2.mov.pro.br/webhook/pacto_indicadores';

/** Webhook de avaliações físicas atrasadas por unidade (POST). */
const N8N_AVALIACOES_ATRASADAS_URL = 'https://n8n2.mov.pro.br/webhook/avaliacoes_atrasadas';

/** Webhook de avaliações físicas realizadas por unidade (POST). */
const N8N_AVALIACOES_REALIZADAS_URL = 'https://n8n2.mov.pro.br/webhook/avaliacoes_realizadas';

/**
 * Cabeçalhos usados nas chamadas ao n8n.
 * Durante a migração, envia a sessão Firebase e mantém o token legado para que
 * os webhooks ainda não migrados continuem funcionando sem interrupção.
 */
async function n8nAuthHeaders() {
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
      console.warn('[AUTH N8N] Não foi possível obter a sessão Firebase.', e);
    }
  }

  if (typeof N8N_PROXY_TOKEN === 'string' && N8N_PROXY_TOKEN) {
    headers['X-Movfit-Proxy'] = N8N_PROXY_TOKEN;
  }

  return headers;
}

function n8nPactoConfigOk() {
  return !!(N8N_PACTO_BASE && N8N_PROXY_TOKEN);
}
