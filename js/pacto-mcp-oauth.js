// OAuth MCP Pacto (PKCE + DCR) — login com e-mail/senha na Pacto
// Espelha o fluxo do Movchat; tokens ficam em Firestore configuracoes/pacto_mcp

const PACTO_MCP_OAUTH_SESS = 'movfit_pacto_mcp_oauth_pending';
const PACTO_MCP_OAUTH_CLIENT = 'movfit_pacto_mcp_oauth_client';

function pactoMcpOAuthRedirectUri() {
  const path = window.location.pathname.replace(/[^/]+$/, '');
  const base = `${window.location.origin}${path}`;
  return `${base}pacto-mcp-oauth.html`;
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
  const mcp = new URL(urlMcp);
  const origem = `${mcp.protocol}//${mcp.host}`;
  const caminho = mcp.pathname === '/' ? '' : mcp.pathname;
  let recurso = await pactoMcpOAuthFetchJson(`${origem}/.well-known/oauth-protected-resource${caminho}`).catch(() => null);
  if (!recurso) {
    recurso = await pactoMcpOAuthFetchJson(`${origem}/.well-known/oauth-protected-resource`).catch(() => null);
  }
  if (!recurso?.authorization_servers?.length) {
    throw new Error('Este MCP não oferece login OAuth. Use token manual.');
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
  const resp = await fetch(endpointRegistro, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(corpo),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Registro OAuth falhou (${resp.status})${t ? `: ${t.slice(0, 80)}` : ''}`);
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
  const urlMcp = String(urlInformada || PACTO_MCP_DEFAULT_URL).trim();
  if (!urlMcp.startsWith('https://')) throw new Error('URL do MCP inválida.');
  const redirectUri = pactoMcpOAuthRedirectUri();
  const descoberta = await pactoMcpOAuthDescobrir(urlMcp);
  const clientId = await pactoMcpOAuthObterClientId(descoberta, redirectUri, urlMcp);
  const estado = pactoMcpOAuthAleatorio();
  const verificador = pactoMcpOAuthAleatorio();
  const desafio = await pactoMcpOAuthDesafio(verificador);
  sessionStorage.setItem(PACTO_MCP_OAUTH_SESS, JSON.stringify({
    estado,
    verificador,
    urlMcp,
    redirectUri,
    clientId,
    tokenEndpoint: descoberta.token,
    userinfoEndpoint: descoberta.userinfo,
    recurso: descoberta.recurso,
    expira: Date.now() + 10 * 60 * 1000,
  }));
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
  window.location.assign(`${descoberta.autorizacao}?${params.toString()}`);
}

async function pactoMcpOAuthTrocarCodigo(pending, codigo) {
  const form = new URLSearchParams();
  form.set('grant_type', 'authorization_code');
  form.set('code', codigo);
  form.set('redirect_uri', pending.redirectUri);
  form.set('client_id', pending.clientId);
  form.set('code_verifier', pending.verificador);
  form.set('resource', pending.recurso);

  if (typeof N8N_PACTO_MCP_OAUTH_TOKEN_URL !== 'undefined' && N8N_PACTO_MCP_OAUTH_TOKEN_URL) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (typeof N8N_PROXY_TOKEN !== 'undefined' && N8N_PROXY_TOKEN) {
      headers['X-Movfit-Proxy'] = N8N_PROXY_TOKEN;
    }
    const resp = await fetch(N8N_PACTO_MCP_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        token_endpoint: pending.tokenEndpoint,
        client_id: pending.clientId,
        code: codigo,
        redirect_uri: pending.redirectUri,
        code_verifier: pending.verificador,
        resource: pending.recurso,
      }),
    });
    if (!resp.ok) throw new Error(`Proxy OAuth HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.erro || data.error) throw new Error(data.erro || data.error);
    return data;
  }

  const resp = await fetch(pending.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Troca do código falhou (${resp.status}).${/cors|failed/i.test(t) ? ' Configure N8N_PACTO_MCP_OAUTH_TOKEN_URL no n8n.' : ''}`);
  }
  return resp.json();
}

async function pactoMcpOAuthRenovar(cfg) {
  if (!cfg.refresh_token || !cfg.oauth_token_endpoint) {
    throw new Error('Refresh token ausente — conecte de novo.');
  }
  const form = new URLSearchParams();
  form.set('grant_type', 'refresh_token');
  form.set('refresh_token', cfg.refresh_token);
  form.set('client_id', cfg.oauth_client_id);
  form.set('resource', cfg.oauth_recurso || cfg.url);

  const resp = await fetch(cfg.oauth_token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(),
  });
  if (!resp.ok) throw new Error('Renovação OAuth falhou — conecte de novo.');
  return resp.json();
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
    sessionStorage.removeItem(PACTO_MCP_OAUTH_SESS);
    window.location.assign(`${window.location.origin}${window.location.pathname.replace(/[^/]+$/, '')}index.html?pactoMcp=erro&motivo=${encodeURIComponent(msg)}`);
  };

  if (erro || !codigo || !estado) {
    falha('Login cancelado ou recusado na Pacto.');
    return;
  }
  const raw = sessionStorage.getItem(PACTO_MCP_OAUTH_SESS);
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
  const tokens = await pactoMcpOAuthTrocarCodigo(pending, codigo);
  const quem = await pactoMcpOAuthQuemEntrou(pending.userinfoEndpoint, tokens.access_token);
  await pactoMcpOAuthPersistirTokens(pending.urlMcp, pending, tokens, quem);
  sessionStorage.removeItem(PACTO_MCP_OAUTH_SESS);
  destino();
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
