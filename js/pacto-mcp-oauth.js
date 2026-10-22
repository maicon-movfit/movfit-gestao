// OAuth MCP Pacto (PKCE + DCR) — login com e-mail/senha na Pacto (mesma ideia do Movchat).
// Tokens OAuth ficam em Firestore (configuracoes/pacto_mcp).

const PACTO_MCP_OAUTH_SESS = 'movfit_pacto_mcp_oauth_pending';
const PACTO_MCP_OAUTH_CLIENT = 'movfit_pacto_mcp_oauth_client';
const PACTO_MCP_OAUTH_JANELA = 'movfit_pacto_mcp_login';

function pactoMcpOAuthGravarSessao(dados) {
  const raw = JSON.stringify(dados);
  try { localStorage.setItem(PACTO_MCP_OAUTH_SESS, raw); } catch (_) { /* ignore */ }
  try { sessionStorage.setItem(PACTO_MCP_OAUTH_SESS, raw); } catch (_) { /* ignore */ }
}

function pactoMcpOAuthLerSessao() {
  try {
    return localStorage.getItem(PACTO_MCP_OAUTH_SESS) || sessionStorage.getItem(PACTO_MCP_OAUTH_SESS);
  } catch (_) {
    return sessionStorage.getItem(PACTO_MCP_OAUTH_SESS);
  }
}

function pactoMcpOAuthLimparSessao() {
  try { localStorage.removeItem(PACTO_MCP_OAUTH_SESS); } catch (_) { /* ignore */ }
  try { sessionStorage.removeItem(PACTO_MCP_OAUTH_SESS); } catch (_) { /* ignore */ }
}

function pactoMcpOAuthNotificarOpener(payload) {
  if (!window.opener || window.opener.closed) return false;
  try {
    window.opener.postMessage({ type: 'pactoMcpOAuth', ...payload }, window.location.origin);
    return true;
  } catch (_) {
    return false;
  }
}

/** Endpoints oficiais do MCP Pacto Reports (Conversa Labs). */
const PACTO_MCP_OAUTH_CONVERSAS = {
  recurso: 'https://mcp-reports.conversas.ai/mcp',
  autorizacao: 'https://mcp-auth.conversas.ai/oauth/authorize',
  token: 'https://mcp-auth.conversas.ai/oauth/token',
  registro: 'https://mcp-auth.conversas.ai/register',
  userinfo: 'https://mcp-auth.conversas.ai/userinfo',
  escopos: 'openid email mcp:relatorios',
};

/** DCR feito uma vez no servidor — o navegador não consegue POST em /register (CORS). */
const PACTO_MCP_OAUTH_GITHUB_CLIENT = 'dcr-VNNiD7rLIuzkQOnspFSLh9TtjnXD2vo6';

const PACTO_MCP_OAUTH_CLIENTE_POR_REDIRECT = {
  'https://maicon-movfit.github.io/movfit-gestao/pacto-mcp-oauth.html': PACTO_MCP_OAUTH_GITHUB_CLIENT,
  'https://mov-fit---gestao-de-carteira.web.app/pacto-mcp-oauth.html': 'dcr-vOg9ihP1Z_OaLEEYvKtLIr5GEVJ5hvM1',
  'https://mov-fit---gestao-de-carteira.firebaseapp.com/pacto-mcp-oauth.html': 'dcr-cCEMVCzEqVdwIMrYNfQiis7u52KG6L7P',
};

function pactoMcpOAuthClientIdPreRegistrado(redirectUri) {
  const direto = PACTO_MCP_OAUTH_CLIENTE_POR_REDIRECT[redirectUri];
  if (direto) return direto;
  try {
    const u = new URL(redirectUri);
    const canonKey = `${u.origin}${u.pathname.replace(/\/+$/, '')}/pacto-mcp-oauth.html`;
    if (PACTO_MCP_OAUTH_CLIENTE_POR_REDIRECT[canonKey]) return PACTO_MCP_OAUTH_CLIENTE_POR_REDIRECT[canonKey];
    if (u.hostname === 'maicon-movfit.github.io' && u.pathname.includes('/movfit-gestao')) {
      return PACTO_MCP_OAUTH_GITHUB_CLIENT;
    }
  } catch (_) { /* ignore */ }
  return null;
}

function pactoMcpOAuthAvisoAmbiente() {
  const { protocol, hostname } = window.location;
  if (protocol === 'file:') {
    return 'Abra o gestão publicado (GitHub Pages / HTTPS), não o arquivo HTML local.';
  }
  if (protocol !== 'https:' && hostname !== 'localhost' && hostname !== '127.0.0.1') {
    return 'Login Pacto exige o site em HTTPS (domínio publicado).';
  }
  return null;
}

function pactoMcpOAuthEhConversas(urlMcp) {
  try {
    return new URL(urlMcp).hostname === 'mcp-reports.conversas.ai';
  } catch (_) {
    return false;
  }
}

function pactoMcpOAuthRedirectUri() {
  const path = window.location.pathname;
  const basePath = /\.html$/i.test(path)
    ? path.replace(/[^/]+$/, '')
    : (path.endsWith('/') ? path : `${path}/`);
  return `${window.location.origin}${basePath}pacto-mcp-oauth.html`;
}

function pactoMcpOAuthAleatorio() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pactoMcpOAuthDesafio(verificador) {
  const data = new TextEncoder().encode(verificador);
  const hash = await crypto.subtle.digest('SHA-256', data);
  let bin = '';
  new Uint8Array(hash).forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pactoMcpOAuthFetchJson(url) {
  const resp = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!resp.ok) throw new Error(`Discovery HTTP ${resp.status}`);
  return resp.json();
}

async function pactoMcpOAuthDescobrir(urlMcp) {
  if (pactoMcpOAuthEhConversas(urlMcp)) {
    return { ...PACTO_MCP_OAUTH_CONVERSAS, recurso: urlMcp };
  }
  const mcp = new URL(urlMcp);
  const origem = `${mcp.protocol}//${mcp.host}`;
  const caminho = mcp.pathname === '/' ? '' : mcp.pathname;
  let recurso = await pactoMcpOAuthFetchJson(`${origem}/.well-known/oauth-protected-resource${caminho}`).catch(() => null);
  if (!recurso) {
    recurso = await pactoMcpOAuthFetchJson(`${origem}/.well-known/oauth-protected-resource`).catch(() => null);
  }
  if (!recurso?.authorization_servers?.length) {
    if (pactoMcpOAuthEhConversas(urlMcp)) {
      return { ...PACTO_MCP_OAUTH_CONVERSAS, recurso: urlMcp };
    }
    throw new Error('Este servidor não oferece login OAuth da Pacto.');
  }
  const emissor = String(recurso.authorization_servers[0]).replace(/\/+$/, '');
  const uriEmissor = new URL(emissor);
  const raiz = `${uriEmissor.protocol}//${uriEmissor.host}`;
  const caminhoEmissor = uriEmissor.pathname === '/' ? '' : uriEmissor.pathname;
  let servidor = await pactoMcpOAuthFetchJson(`${raiz}/.well-known/oauth-authorization-server${caminhoEmissor}`).catch(() => null);
  if (!servidor) {
    servidor = await pactoMcpOAuthFetchJson(`${raiz}/.well-known/openid-configuration${caminhoEmissor}`).catch(() => null);
  }
  if (!servidor?.authorization_endpoint || !servidor?.token_endpoint) {
    if (/mcp-auth\.conversas\.ai/i.test(emissor) || pactoMcpOAuthEhConversas(urlMcp)) {
      return {
        ...PACTO_MCP_OAUTH_CONVERSAS,
        recurso: recurso.resource || urlMcp,
      };
    }
    throw new Error('Servidor de login da Pacto indisponível.');
  }
  const metodos = servidor.code_challenge_methods_supported || [];
  if (metodos.length && !metodos.includes('S256')) {
    throw new Error('Login da Pacto não aceita PKCE S256.');
  }
  const escopos = (servidor.scopes_supported || [])
    .filter(s => String(s).startsWith('mcp') || s === 'openid' || s === 'email')
    .join(' ');
  return {
    recurso: recurso.resource || urlMcp,
    autorizacao: servidor.authorization_endpoint,
    token: servidor.token_endpoint,
    registro: servidor.registration_endpoint || null,
    userinfo: servidor.userinfo_endpoint || null,
    escopos,
  };
}

async function pactoMcpOAuthRegistrar(endpointRegistro, redirectUri) {
  if (!endpointRegistro) {
    throw new Error('Login da Pacto não permite registrar aplicativo (DCR).');
  }
  const corpo = {
    client_name: 'MovFit Gestão',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
  let resp;
  try {
    resp = await fetch(endpointRegistro, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(corpo),
    });
  } catch (e) {
    const amb = pactoMcpOAuthAvisoAmbiente();
    throw new Error(amb || 'Atualize a página (Ctrl+Shift+R) e tente Conectar com a Pacto de novo.');
  }
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Registro na Pacto falhou (${resp.status})${t ? `: ${t.slice(0, 100)}` : ''}`);
  }
  const data = await resp.json();
  if (!data.client_id) throw new Error('Pacto não devolveu client_id.');
  return data.client_id;
}

function pactoMcpOAuthLerClientCache(redirectUri, urlMcp) {
  try {
    const raw = localStorage.getItem(PACTO_MCP_OAUTH_CLIENT);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (o.redirectUri === redirectUri && o.urlMcp === urlMcp && o.clientId) return o.clientId;
  } catch (_) { /* ignore */ }
  return null;
}

function pactoMcpOAuthGravarClientCache(redirectUri, urlMcp, clientId) {
  localStorage.setItem(PACTO_MCP_OAUTH_CLIENT, JSON.stringify({ redirectUri, urlMcp, clientId }));
}

async function pactoMcpOAuthObterClientId(descoberta, redirectUri, urlMcp) {
  const pre = pactoMcpOAuthClientIdPreRegistrado(redirectUri);
  if (pre) return pre;
  const cfg = typeof _pactoMcpState !== 'undefined' ? _pactoMcpState.config : null;
  if (cfg?.oauth_client_id && cfg.oauth_redirect_uri === redirectUri) {
    return cfg.oauth_client_id;
  }
  const cached = pactoMcpOAuthLerClientCache(redirectUri, urlMcp);
  if (cached) return cached;
  const clientId = await pactoMcpOAuthRegistrar(descoberta.registro, redirectUri);
  pactoMcpOAuthGravarClientCache(redirectUri, urlMcp, clientId);
  return clientId;
}

/** Abre a página de login da Pacto (e-mail/senha). */
async function pactoMcpOAuthIniciar(urlInformada) {
  if (typeof pactoMcpIsAdmin === 'function' && !pactoMcpIsAdmin()) {
    throw new Error('Somente administradores conectam a Pacto.');
  }
  const aviso = pactoMcpOAuthAvisoAmbiente();
  if (aviso) throw new Error(aviso);
  if (typeof pactoMcpCarregarConfig === 'function') await pactoMcpCarregarConfig();
  const urlMcp = String(urlInformada || PACTO_MCP_DEFAULT_URL).trim();
  if (!urlMcp.startsWith('https://')) throw new Error('URL do MCP inválida.');
  const redirectUri = pactoMcpOAuthRedirectUri();
  const descoberta = await pactoMcpOAuthDescobrir(urlMcp);
  const clientId = await pactoMcpOAuthObterClientId(descoberta, redirectUri, urlMcp);
  const estado = pactoMcpOAuthAleatorio();
  const verificador = pactoMcpOAuthAleatorio();
  const desafio = await pactoMcpOAuthDesafio(verificador);
  pactoMcpOAuthGravarSessao({
    estado,
    verificador,
    urlMcp,
    redirectUri,
    clientId,
    tokenEndpoint: descoberta.token,
    userinfoEndpoint: descoberta.userinfo,
    recurso: descoberta.recurso,
    expira: Date.now() + 10 * 60 * 1000,
  });
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state: estado,
    code_challenge: desafio,
    code_challenge_method: 'S256',
    resource: descoberta.recurso,
  });
  if (descoberta.escopos) params.set('scope', descoberta.escopos);
  const loginUrl = `${descoberta.autorizacao}?${params.toString()}`;
  const pop = window.open(loginUrl, PACTO_MCP_OAUTH_JANELA, 'width=540,height=780,scrollbars=yes,resizable=yes');
  if (!pop) {
    window.location.assign(loginUrl);
    return;
  }
  pop.focus();
  if (typeof mostrarToast === 'function') {
    mostrarToast('Login da Pacto aberto em outra aba — o gestão continua aqui.');
  }
}

async function pactoMcpOAuthHeadersN8n() {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (typeof N8N_PROXY_TOKEN !== 'undefined' && N8N_PROXY_TOKEN) {
    headers['X-Movfit-Proxy'] = N8N_PROXY_TOKEN;
  }
  return headers;
}

async function pactoMcpOAuthTrocarViaServidor(payload) {
  const url = typeof N8N_PACTO_MCP_OAUTH_URL !== 'undefined' && N8N_PACTO_MCP_OAUTH_URL;
  if (!url) {
    throw new Error('Login da Pacto não está configurado neste ambiente. Avise o suporte MovFit.');
  }
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: await pactoMcpOAuthHeadersN8n(),
      body: JSON.stringify({ acao: payload.grant_type === 'refresh_token' ? 'refresh' : 'token', ...payload }),
    });
  } catch (e) {
    const det = String(e?.message || '');
    throw new Error(
      det.includes('Failed to fetch') || det.includes('NetworkError')
        ? 'Não foi possível concluir o login na Pacto (rede). Tente de novo em alguns minutos.'
        : 'Não foi possível concluir o login na Pacto depois de autorizar. Tente conectar de novo.'
    );
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    if (resp.status === 404) {
      throw new Error('Serviço de login da Pacto temporariamente indisponível. Avise o suporte MovFit.');
    }
    const msg = data.error_description || data.error || data.erro || `HTTP ${resp.status}`;
    throw new Error(typeof msg === 'string' ? msg : 'Troca do código falhou.');
  }
  return data;
}

async function pactoMcpOAuthTrocarCodigo(pending, codigo) {
  return pactoMcpOAuthTrocarViaServidor({
    token_endpoint: pending.tokenEndpoint,
    code: codigo,
    redirect_uri: pending.redirectUri,
    client_id: pending.clientId,
    code_verifier: pending.verificador,
    resource: pending.recurso,
  });
}

async function pactoMcpOAuthRenovar(cfg) {
  if (!cfg.refresh_token || !cfg.oauth_token_endpoint) {
    throw new Error('Refresh token ausente — conecte de novo.');
  }
  return pactoMcpOAuthTrocarViaServidor({
    grant_type: 'refresh_token',
    token_endpoint: cfg.oauth_token_endpoint,
    refresh_token: cfg.refresh_token,
    client_id: cfg.oauth_client_id,
    resource: cfg.oauth_recurso || cfg.url,
  });
}

async function pactoMcpOAuthQuemEntrou(userinfoEndpoint, accessToken) {
  if (!userinfoEndpoint || !accessToken) return null;
  try {
    const resp = await fetch(userinfoEndpoint, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!resp.ok) return null;
    const j = await resp.json();
    return j.email || j.name || null;
  } catch (_) {
    return null;
  }
}

async function pactoMcpOAuthAguardarAuth() {
  if (typeof auth === 'undefined') return;
  if (auth.currentUser) return;
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Abra o MovFit, faça login e conecte de novo.')), 20000);
    const unsub = auth.onAuthStateChanged(u => {
      if (u) {
        clearTimeout(t);
        unsub();
        resolve();
      }
    });
  });
}

async function pactoMcpOAuthPersistirTokens(urlMcp, pending, tokens, quem) {
  await pactoMcpOAuthAguardarAuth();
  const col = typeof pactoMcpColConfig === 'function' ? pactoMcpColConfig() : null;
  if (!col) throw new Error('Firestore indisponível.');
  const access = tokens.access_token;
  if (!access) throw new Error('Pacto não devolveu access_token.');
  const expiraEm = tokens.expires_in
    ? new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString()
    : null;
  const hint = access.length >= 4 ? `••••${access.slice(-4)}` : '••••';
  await col.set({
    url: urlMcp,
    autenticacao: 'OAUTH',
    token: access,
    tokenHint: hint,
    refresh_token: tokens.refresh_token || null,
    token_expira_em: expiraEm,
    oauth_client_id: pending.clientId,
    oauth_redirect_uri: pending.redirectUri,
    oauth_token_endpoint: pending.tokenEndpoint,
    oauth_recurso: pending.recurso,
    conectado_como: quem,
    conectado_em: new Date().toISOString(),
    precisa_reconectar: false,
    ativo: true,
    atualizado_em: new Date().toISOString(),
    atualizado_por: (typeof usuarioLogado !== 'undefined' && usuarioLogado)
      ? (usuarioLogado.email || usuarioLogado.uid)
      : (typeof auth !== 'undefined' && auth.currentUser ? auth.currentUser.email || auth.currentUser.uid : null),
  }, { merge: true });
}

/** Chamado em pacto-mcp-oauth.html após redirect da Pacto. */
async function pactoMcpOAuthFinalizarRetorno() {
  const params = new URLSearchParams(window.location.search);
  const estado = params.get('state');
  const codigo = params.get('code');
  const erro = params.get('error');
  const destino = () => {
    const path = window.location.pathname.replace(/[^/]+$/, '');
    window.location.assign(`${window.location.origin}${path}index.html?pactoMcp=conectado`);
  };
  const falha = (msg) => {
    pactoMcpOAuthLimparSessao();
    const el = document.getElementById('msg');
    if (pactoMcpOAuthNotificarOpener({ status: 'erro', motivo: msg })) {
      if (el) el.textContent = msg;
      return;
    }
    window.location.assign(`${window.location.origin}${window.location.pathname.replace(/[^/]+$/, '')}index.html?pactoMcp=erro&motivo=${encodeURIComponent(msg)}`);
  };

  if (erro || !codigo || !estado) {
    falha('Login cancelado ou recusado na Pacto.');
    return;
  }
  const raw = pactoMcpOAuthLerSessao();
  if (!raw) {
    falha('Sessão OAuth expirada. Tente conectar de novo.');
    return;
  }
  const pending = JSON.parse(raw);
  if (pending.estado !== estado) {
    falha('Estado OAuth inválido.');
    return;
  }
  if (pending.expira && Date.now() > pending.expira) {
    falha('Login demorou demais. Tente de novo.');
    return;
  }
  await pactoMcpOAuthAguardarAuth();
  const tokens = await pactoMcpOAuthTrocarCodigo(pending, codigo);
  const quem = await pactoMcpOAuthQuemEntrou(pending.userinfoEndpoint, tokens.access_token);
  await pactoMcpOAuthPersistirTokens(pending.urlMcp, pending, tokens, quem);
  pactoMcpOAuthLimparSessao();
  const el = document.getElementById('msg');
  if (pactoMcpOAuthNotificarOpener({ status: 'conectado' })) {
    if (el) el.textContent = 'Pacto conectada. Pode fechar esta aba.';
    setTimeout(() => { try { window.close(); } catch (_) { /* ignore */ } }, 1200);
    return;
  }
  destino();
}

function pactoMcpOAuthEscutarRetorno() {
  if (window.__pactoMcpOAuthListen) return;
  window.__pactoMcpOAuthListen = true;
  window.addEventListener('message', (e) => {
    if (e.origin !== window.location.origin) return;
    if (!e.data || e.data.type !== 'pactoMcpOAuth') return;
    if (e.data.status === 'conectado' && typeof mostrarToast === 'function') {
      mostrarToast('Pacto conectada — validando relatórios…');
      if (typeof pactoMcpUiTestar === 'function') pactoMcpUiTestar().catch(() => {});
    }
    if (e.data.status === 'erro' && typeof mostrarToast === 'function') {
      mostrarToast(`Pacto: ${e.data.motivo || 'falha no login'}`);
    }
    const unid = typeof unidadeAtual !== 'undefined' ? unidadeAtual?.id : null;
    if (unid && typeof renderPactoMcp === 'function') renderPactoMcp(unid);
  });
}

async function pactoMcpResolverToken(cfg) {
  const c = cfg || _pactoMcpState?.config || {};
  if (!c.token) throw new Error('Conecte com a Pacto primeiro.');
  if (c.autenticacao !== 'OAUTH') return c.token;
  if (c.precisa_reconectar) {
    throw new Error('Acesso Pacto expirou — use Conectar com a Pacto.');
  }
  if (!c.token_expira_em) return c.token;
  const expira = new Date(c.token_expira_em).getTime();
  if (expira > Date.now() + 60_000) return c.token;
  if (!c.refresh_token) throw new Error('Token expirado — conecte de novo.');
  const tokens = await pactoMcpOAuthRenovar(c);
  const col = pactoMcpColConfig();
  if (col) {
    const expiraEm = tokens.expires_in
      ? new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString()
      : null;
    await col.set({
      token: tokens.access_token,
      refresh_token: tokens.refresh_token || c.refresh_token,
      token_expira_em: expiraEm,
      precisa_reconectar: false,
    }, { merge: true });
    c.token = tokens.access_token;
  }
  return tokens.access_token || c.token;
}
