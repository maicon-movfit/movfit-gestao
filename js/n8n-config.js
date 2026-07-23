// ════════════════════════════════════════════════════════════════════════
// CONFIG n8n — proxy Pacto (a key Bearer NÃO fica aqui nem no Firestore)
//
// 1) No n8n: Credentials → Header Auth (ou similar) com Authorization: Bearer <key Pacto>
// 2) Importe o workflow em n8n/movfit-pacto-proxy.json e ative
// 3) Preencha abaixo a URL pública do webhook e o mesmo token do nó "Check proxy"
// ════════════════════════════════════════════════════════════════════════

/** Base do webhook (sem barra no final). Ex.: https://n8n.seudominio.com/webhook/movfit/pacto */
const N8N_PACTO_BASE = 'https://n8n2.mov.pro.br/webhook/movfit/pacto';

/**
 * Token compartilhado com o workflow n8n (header X-Movfit-Proxy).
 * NÃO é a key da Pacto — só autoriza o webhook. Gere um valor longo e rotacione se vazar.
 */
const N8N_PROXY_TOKEN = 'movfit_proxy_k7x9m2pQ4wR9';

function n8nPactoConfigOk() {
  return !!(N8N_PACTO_BASE && N8N_PROXY_TOKEN);
}
