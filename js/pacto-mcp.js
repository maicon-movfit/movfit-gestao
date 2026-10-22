// ════════════════════════════════════════════════════════════════════════
// PACTO REPORTS — MCP (Conversa Labs / Streamable HTTP)
// URL padrão: https://mcp-reports.conversas.ai/mcp
// Token Bearer (mcp_...) gravado em Firestore — não commitar no código.
// Proxy opcional: N8N_PACTO_MCP_PROXY_URL em js/n8n-config.js (CORS)
// ════════════════════════════════════════════════════════════════════════

const PACTO_MCP_DEFAULT_URL = 'https://mcp-reports.conversas.ai/mcp';
const PACTO_MCP_PROTOCOL = '2024-11-05';

const _pactoMcpState = {
  sessionId: null,
  serverInfo: null,
  tools: [],
  lastTest: null,
  config: null,
};

function pactoMcpIsAdmin() {
  return typeof usuarioLogado !== 'undefined'
    && usuarioLogado
    && usuarioLogado.papel === 'admin';
}

function pactoMcpColConfig() {
  if (typeof db === 'undefined') return null;
  return db.collection('configuracoes').doc('pacto_mcp');
}

async function pactoMcpCarregarConfig() {
  const col = pactoMcpColConfig();
  if (!col) return null;
  try {
    const doc = await col.get();
    if (!doc.exists) {
      return {
        url: PACTO_MCP_DEFAULT_URL,
        token: '',
        tokenHint: '',
        ativo: false,
        ultimo_teste: null,
        ultimo_teste_ok: null,
        tools_count: 0,
      };
    }
    const d = doc.data();
    _pactoMcpState.config = d;
    return d;
  } catch (e) {
    console.warn('[PACTO MCP] Erro ao carregar config', e.message);
    return null;
  }
}

async function pactoMcpSalvarConfig(url, token) {
  if (!pactoMcpIsAdmin()) {
    if (typeof mostrarToast === 'function') mostrarToast('Somente administradores podem salvar a conexão MCP.');
    return false;
  }
  const col = pactoMcpColConfig();
  if (!col) return false;
  const u = String(url || PACTO_MCP_DEFAULT_URL).trim();
  const t = String(token || '').trim();
  const prev = _pactoMcpState.config || {};
  const tokenFinal = t || prev.token || '';
  if (!tokenFinal) {
    alert('Informe o token Bearer do perfil MCP (formato mcp_...) ou use Conectar com a Pacto.');
    return false;
  }
  const hint = tokenFinal.length >= 4 ? `••••${tokenFinal.slice(-4)}` : '••••';
  try {
    await col.set({
      url: u,
      token: tokenFinal,
      tokenHint: hint,
      autenticacao: 'TOKEN',
      ativo: true,
      atualizado_em: new Date().toISOString(),
      atualizado_por: usuarioLogado?.email || usuarioLogado?.uid || null,
    }, { merge: true });
    if (typeof mostrarToast === 'function') mostrarToast('Conexão MCP salva.');
    await pactoMcpCarregarConfig();
    return true;
  } catch (e) {
    console.warn('[PACTO MCP] Erro ao salvar', e.message);
    if (typeof mostrarToast === 'function') mostrarToast('Erro ao salvar MCP.');
    return false;
  }
}

function pactoMcpParseSseBody(text) {
  const lines = String(text || '').split(/\r?\n/);
  let lastJson = null;
  lines.forEach(line => {
    if (!line.startsWith('data:')) return;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') return;
    try {
      lastJson = JSON.parse(raw);
    } catch (_) { /* ignore partial */ }
  });
  return lastJson;
}

async function pactoMcpRpcDirect(url, token, method, params, sessionId) {
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

  if (!resp.ok) {
    const errTxt = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}${errTxt ? `: ${errTxt.slice(0, 120)}` : ''}`);
  }

  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  let data;
  if (ct.includes('text/event-stream')) {
    data = pactoMcpParseSseBody(await resp.text());
  } else {
    data = await resp.json();
  }
  if (!data) throw new Error('Resposta MCP vazia');
  if (data.error) {
    throw new Error(data.error.message || JSON.stringify(data.error));
  }
  return { result: data.result, sessionId: newSession };
}

async function pactoMcpRpcProxy(url, token, method, params, sessionId) {
  if (typeof N8N_PACTO_MCP_PROXY_URL === 'undefined' || !N8N_PACTO_MCP_PROXY_URL) {
    throw new Error('Proxy n8n não configurado (N8N_PACTO_MCP_PROXY_URL).');
  }
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (typeof N8N_PROXY_TOKEN !== 'undefined' && N8N_PROXY_TOKEN) {
    headers['X-Movfit-Proxy'] = N8N_PROXY_TOKEN;
  }
  const resp = await fetch(N8N_PACTO_MCP_PROXY_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ url, token, method, params: params || {}, sessionId }),
  });
  if (!resp.ok) throw new Error(`Proxy n8n HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.erro || data.error) throw new Error(data.erro || data.error);
  return {
    result: data.result,
    sessionId: data.sessionId || sessionId || null,
  };
}

async function pactoMcpRpc(url, token, method, params, sessionId) {
  const useProxy = typeof N8N_PACTO_MCP_PROXY_URL !== 'undefined' && N8N_PACTO_MCP_PROXY_URL;
  try {
    if (useProxy) return await pactoMcpRpcProxy(url, token, method, params, sessionId);
    return await pactoMcpRpcDirect(url, token, method, params, sessionId);
  } catch (e) {
    if (!useProxy && /failed to fetch|network|cors/i.test(String(e.message))) {
      throw new Error(
        'Navegador bloqueou a conexão (CORS). Configure o proxy n8n (N8N_PACTO_MCP_PROXY_URL) ou teste pelo Cursor com o mesmo URL e token.'
      );
    }
    throw e;
  }
}

async function pactoMcpSessaoCompleta(url, token) {
  const init = await pactoMcpRpc(url, token, 'initialize', {
    protocolVersion: PACTO_MCP_PROTOCOL,
    capabilities: {},
    clientInfo: { name: 'movfit-gestao', version: '1.0.0' },
  }, null);

  const sessionId = init.sessionId;
  _pactoMcpState.sessionId = sessionId;
  _pactoMcpState.serverInfo = init.result?.serverInfo || null;

  try {
    await pactoMcpRpc(url, token, 'notifications/initialized', {}, sessionId);
  } catch (_) { /* alguns servidores não exigem resposta */ }

  const listed = await pactoMcpRpc(url, token, 'tools/list', {}, sessionId);
  const tools = listed.result?.tools || [];
  _pactoMcpState.tools = tools;
  return { sessionId, serverInfo: _pactoMcpState.serverInfo, tools };
}

async function pactoMcpTestarConexao() {
  const cfg = _pactoMcpState.config || await pactoMcpCarregarConfig();
  const token = typeof pactoMcpResolverToken === 'function'
    ? await pactoMcpResolverToken(cfg)
    : cfg?.token;
  if (!token) {
    throw new Error('Conecte com a Pacto antes de testar.');
  }
  const url = cfg.url || PACTO_MCP_DEFAULT_URL;
  const pack = await pactoMcpSessaoCompleta(url, token);
  const agora = new Date().toISOString();
  _pactoMcpState.lastTest = { ok: true, at: agora, tools: pack.tools.length };

  const col = pactoMcpColConfig();
  if (col) {
    await col.set({
      ultimo_teste: agora,
      ultimo_teste_ok: true,
      tools_count: pack.tools.length,
      server_name: pack.serverInfo?.name || null,
    }, { merge: true });
  }
  return pack;
}

function pactoMcpEsc(s) {
  return typeof esc === 'function' ? esc(String(s ?? '')) : String(s ?? '').replace(/[<>&"]/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;',
  }[c]));
}

function pactoMcpRenderToolsList(tools) {
  if (!tools?.length) {
    return '<div class="pacto-mcp-tools-empty">Nenhuma ferramenta listada.</div>';
  }
  return `<ul class="pacto-mcp-tools">${tools.slice(0, 40).map(t => {
    const rawDesc = t.description || '';
    const desc = rawDesc ? pactoMcpEsc(rawDesc.slice(0, 140)) : '';
    return `<li><strong>${pactoMcpEsc(t.name)}</strong>${desc ? `<span>${desc}${rawDesc.length > 140 ? '…' : ''}</span>` : ''}</li>`;
  }).join('')}${tools.length > 40 ? `<li class="pacto-mcp-tools-more">+ ${tools.length - 40} ferramentas</li>` : ''}</ul>`;
}

function pactoMcpRenderPainel(cfg, unidId) {
  const c = cfg || {};
  const url = c.url || PACTO_MCP_DEFAULT_URL;
  const admin = pactoMcpIsAdmin();
  const ok = c.ultimo_teste_ok === true;
  const temCredencial = !!(c.token || c.autenticacao === 'OAUTH');
  const statusCor = ok ? '#34c47c' : (temCredencial ? '#f5a623' : 'var(--muted)');
  const oauthOk = c.autenticacao === 'OAUTH' && c.token;
  const statusTxt = ok
    ? `Conectado · ${c.tools_count ?? _pactoMcpState.tools.length} ferramentas`
    : (oauthOk
      ? `Login Pacto${c.conectado_como ? ` (${c.conectado_como})` : ''} · teste pendente`
      : (c.token ? 'Token salvo · teste pendente ou falhou' : 'Não conectado'));
  const testeLbl = c.ultimo_teste
    ? (typeof pactoMcpFmtData === 'function' ? pactoMcpFmtData(c.ultimo_teste) : c.ultimo_teste)
    : '—';

  const nomeUnidade = (typeof UNIDADES !== 'undefined'
    ? UNIDADES.find(u => u.id === unidId)?.nome
    : null) || unidId || '—';

  const btnConectar = admin
    ? `<button type="button" class="btn primary pacto-mcp-btn" onclick="pactoMcpUiConectar()">Conectar com a Pacto</button>`
    : '';
  const avancado = admin
    ? `<details class="pacto-mcp-avancado">
      <summary>Token manual (mcp_…)</summary>
      <label class="pacto-mcp-lbl">Token Bearer</label>
      <input type="password" class="pacto-mcp-input" id="pactoMcpToken" placeholder="Opcional — perfil MCP Conversa Labs" autocomplete="off" />
      <button type="button" class="btn pacto-mcp-btn" onclick="pactoMcpUiSalvar()">Salvar token manual</button>
    </details>`
    : `<input type="text" class="pacto-mcp-input" disabled placeholder="${c.tokenHint ? `Credencial ${pactoMcpEsc(c.tokenHint)}` : 'Somente admin conecta'}" />`;

  return `<div class="janela-card pacto-mcp-card" data-unid-id="${unidId || ''}">
    <div class="janela-card-head">
      <div>
        <div class="janela-title">Pacto Reports — MCP</div>
        <div class="janela-sub">${pactoMcpEsc(nomeUnidade)} · Relatórios Conversa Labs · Streamable HTTP</div>
      </div>
      <div class="matric-head-actions">
        <button type="button" class="janela-refresh" onclick="pactoMcpUiTestar()" title="Initialize + tools/list">↻ Testar conexão</button>
      </div>
    </div>
    <div class="pacto-mcp-status" style="border-color:${statusCor}33;color:${statusCor};">
      <span class="pacto-mcp-dot" style="background:${statusCor};"></span>
      <span>${pactoMcpEsc(statusTxt)}</span>
      <span class="pacto-mcp-status-meta">Último teste: ${pactoMcpEsc(testeLbl)}</span>
    </div>
    <div class="pacto-mcp-form">
      <label class="pacto-mcp-lbl">URL do servidor MCP</label>
      <input type="url" class="pacto-mcp-input" id="pactoMcpUrl" value="${pactoMcpEsc(url)}" ${admin ? '' : 'readonly'} />
      <p class="pacto-mcp-hint"><strong>Conectar com a Pacto</strong> — login OAuth do MCP (<code>${pactoMcpEsc(PACTO_MCP_DEFAULT_URL)}</code>). Depois de autorizar, o n8n só troca o código por token (CORS). Indicadores do painel são outro fluxo.</p>
      <div class="pacto-mcp-acoes">${btnConectar}<button type="button" class="btn pacto-mcp-btn" onclick="pactoMcpUiCopiarCursor()">Copiar config Cursor</button></div>
      ${avancado}
    </div>
    <div class="sec" style="margin:14px 0 8px;">Ferramentas disponíveis</div>
    <div id="pactoMcpToolsWrap">${pactoMcpRenderToolsList(_pactoMcpState.tools)}</div>
  </div>`;
}

function pactoMcpFmtData(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function pactoMcpUiQueryRetorno() {
  try {
    const q = new URLSearchParams(window.location.search);
    const st = q.get('pactoMcp');
    if (!st) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('pactoMcp');
    url.searchParams.delete('motivo');
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    if (st === 'conectado' && typeof mostrarToast === 'function') {
      mostrarToast('Pacto conectada — teste a conexão.');
    }
    if (st === 'erro' && typeof mostrarToast === 'function') {
      mostrarToast(`Pacto: ${q.get('motivo') || 'falha no login'}`);
    }
  } catch (_) { /* ignore */ }
}

async function renderPactoMcp(unidId) {
  const el = document.getElementById('dashPactoMcp');
  if (!el) return;
  if (!unidId) {
    el.innerHTML = '';
    return;
  }
  pactoMcpUiQueryRetorno();
  el.innerHTML = `<div class="janela-card janela-loading"><div class="janela-title">Pacto Reports — MCP</div><div class="janela-sub">Carregando…</div></div>`;
  const cfg = await pactoMcpCarregarConfig();
  el.innerHTML = pactoMcpRenderPainel(cfg, unidId);
}

async function pactoMcpUiConectar() {
  const url = document.getElementById('pactoMcpUrl')?.value;
  try {
    if (typeof pactoMcpOAuthIniciar !== 'function') {
      throw new Error('Módulo OAuth não carregado.');
    }
    await pactoMcpOAuthIniciar(url);
  } catch (e) {
    console.warn('[PACTO MCP] OAuth', e.message);
    if (typeof mostrarToast === 'function') mostrarToast(e.message);
    else alert(e.message);
  }
}

async function pactoMcpUiSalvar() {
  const url = document.getElementById('pactoMcpUrl')?.value;
  const token = document.getElementById('pactoMcpToken')?.value;
  const ok = await pactoMcpSalvarConfig(url, token);
  if (ok) {
    const unid = document.querySelector('.pacto-mcp-card')?.dataset?.unidId;
    await renderPactoMcp(unid || (typeof unidadeAtual !== 'undefined' ? unidadeAtual?.id : null));
  }
}

async function pactoMcpUiTestar() {
  const wrap = document.getElementById('pactoMcpToolsWrap');
  if (wrap) wrap.innerHTML = '<div class="pacto-mcp-tools-empty">Testando conexão…</div>';
  try {
    const urlInput = document.getElementById('pactoMcpUrl')?.value;
    const tokenInput = document.getElementById('pactoMcpToken')?.value;
    if (pactoMcpIsAdmin() && (urlInput || tokenInput)) {
      await pactoMcpSalvarConfig(urlInput, tokenInput);
    }
    const pack = await pactoMcpTestarConexao();
    if (wrap) wrap.innerHTML = pactoMcpRenderToolsList(pack.tools);
    if (typeof mostrarToast === 'function') {
      mostrarToast(`MCP OK — ${pack.tools.length} ferramenta(s).`);
    }
    const unid = document.querySelector('.pacto-mcp-card')?.dataset?.unidId;
    await renderPactoMcp(unid || (typeof unidadeAtual !== 'undefined' ? unidadeAtual?.id : null));
  } catch (e) {
    console.warn('[PACTO MCP] Teste falhou', e.message);
    if (wrap) wrap.innerHTML = `<div class="pacto-mcp-tools-empty" style="color:#f05c5c;">${pactoMcpEsc(e.message)}</div>`;
    const col = pactoMcpColConfig();
    if (col) {
      await col.set({
        ultimo_teste: new Date().toISOString(),
        ultimo_teste_ok: false,
      }, { merge: true }).catch(() => {});
    }
    if (typeof mostrarToast === 'function') mostrarToast('Falha na conexão MCP.');
  }
}

function pactoMcpUiCopiarCursor() {
  const cfg = _pactoMcpState.config || {};
  const url = document.getElementById('pactoMcpUrl')?.value || cfg.url || PACTO_MCP_DEFAULT_URL;
  const snippet = {
    mcpServers: {
      'pacto-reports': {
        url,
        headers: { Authorization: 'Bearer SEU_TOKEN_mcp_...' },
      },
    },
  };
  const txt = JSON.stringify(snippet, null, 2);
  navigator.clipboard.writeText(txt).then(() => {
    if (typeof mostrarToast === 'function') mostrarToast('JSON Cursor copiado — substitua o token.');
  }).catch(() => alert(txt));
}
