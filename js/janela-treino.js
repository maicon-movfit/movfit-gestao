// ════════════════════════════════════════════════════════════════════════
// JANELA DE TREINO — dados ao vivo via webhook n8n
// Config: js/n8n-config.js
// ════════════════════════════════════════════════════════════════════════

const _janelaCache = { data: null, at: 0 };
const JANELA_CACHE_TTL_MS = 3 * 60 * 1000;

/** Mapeamento unidId (app) → unidade do webhook. */
const JANELA_UNIDADE_MAP = {
  medicilandia: { codigo: 1, slug: 'medicilandia' },
  itaituba:     { codigo: 2, slug: 'itaituba' },
  premium24:    { codigo: 3, slug: 'santarem_24h' },
  nrexpress:    { codigo: 5, slug: 'santarem_nova_republica' },
};

const JANELA_STATUS = {
  EM_DIA:     { label: 'Em dia',     cor: '#34c47c', bg: 'rgba(52,196,124,.1)' },
  VENCIDO:    { label: 'Vencido',    cor: '#f05c5c', bg: 'rgba(240,92,92,.1)' },
  SEM_TREINO: { label: 'Sem treino', cor: '#f5a623', bg: 'rgba(245,166,35,.1)' },
};

function janelaFmtData(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function janelaFmtDataCurta(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('pt-BR');
}

/** Desembrulha resposta n8n: pode vir direta ou em dados[].resposta. */
function janelaNormalizarResposta(raw) {
  if (!raw) return null;
  if (raw.unidades) return raw;
  const item = raw.dados?.[0];
  if (item?.resposta?.unidades) return item.resposta;
  if (item?.unidades) return item;
  return null;
}

function janelaEncontrarUnidade(data, unidId) {
  const ref = JANELA_UNIDADE_MAP[unidId];
  if (!ref || !data?.unidades) return null;
  return data.unidades.find(u =>
    u.unidade_codigo === ref.codigo ||
    u.unidade_nome === ref.slug
  ) || null;
}

async function janelaBuscarDados() {
  if (typeof N8N_JANELA_URL === 'undefined' || !N8N_JANELA_URL) {
    console.warn('[JANELA] Configure N8N_JANELA_URL em js/n8n-config.js');
    return null;
  }
  if (_janelaCache.data && (Date.now() - _janelaCache.at) < JANELA_CACHE_TTL_MS) {
    return _janelaCache.data;
  }
  if (window._janelaInflightPromise) return window._janelaInflightPromise;

  window._janelaInflightPromise = (async () => {
    try {
      const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      };
      if (typeof N8N_PROXY_TOKEN === 'string' && N8N_PROXY_TOKEN) {
        headers['X-Movfit-Proxy'] = N8N_PROXY_TOKEN;
      }
      const resp = await fetch(N8N_JANELA_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });
      if (!resp.ok) {
        console.error('[JANELA] Webhook HTTP', resp.status);
        return null;
      }
      const raw = await resp.json();
      const data = janelaNormalizarResposta(raw);
      if (!data?.sucesso || !data?.unidades) {
        console.warn('[JANELA] Resposta inválida ou sem unidades');
        return null;
      }
      _janelaCache.data = data;
      _janelaCache.at = Date.now();
      return data;
    } catch (e) {
      console.error('[JANELA] Erro de conexão:', e.message);
      return null;
    } finally {
      window._janelaInflightPromise = null;
    }
  })();

  return window._janelaInflightPromise;
}

function janelaTblCol(titulo, linhas) {
  return `<div class="janela-tbl">
    <div class="janela-tbl-hd">${titulo}</div>
    ${linhas.map(([lbl, val, cor]) => {
      const fmt = typeof val === 'number' ? val.toLocaleString('pt-BR') : val;
      return `<div class="janela-tbl-row">
        <span>${lbl}</span>
        <span class="janela-tbl-val" style="${cor ? `color:${cor}` : ''}">${fmt}</span>
      </div>`;
    }).join('')}
  </div>`;
}

function janelaRenderTabela(alunos, filtro) {
  const lista = (alunos || []).filter(a => {
    if (!filtro) return true;
    const q = filtro.toLowerCase();
    return (a.nome_aluno || '').toLowerCase().includes(q) ||
      (a.nome_professor || '').toLowerCase().includes(q) ||
      (a.matricula || '').includes(q);
  });

  if (!lista.length) {
    return `<div class="janela-empty">Nenhum aluno nesta categoria.</div>`;
  }

  return `<div class="tw janela-tw"><table>
    <thead><tr>
      <th>Aluno</th>
      <th>Professor</th>
      <th>Programa</th>
      <th>Válido até</th>
      <th>Último acesso</th>
      <th>Status</th>
    </tr></thead>
    <tbody>${lista.map(a => {
      const st = JANELA_STATUS[a.status_treino] || { label: a.status_treino || '—', cor: 'var(--muted)', bg: 'transparent' };
      return `<tr>
        <td style="font-weight:500;">${typeof esc === 'function' ? esc(a.nome_aluno) : a.nome_aluno}</td>
        <td>${typeof esc === 'function' ? esc(a.nome_professor || '—') : (a.nome_professor || '—')}</td>
        <td style="max-width:180px;white-space:normal;">${typeof esc === 'function' ? esc(a.nome_programa || '—') : (a.nome_programa || '—')}</td>
        <td style="font-family:'DM Mono',monospace;font-size:11px;">${janelaFmtDataCurta(a.treino_valido_ate)}</td>
        <td style="font-family:'DM Mono',monospace;font-size:11px;">${janelaFmtDataCurta(a.ultimo_acesso)}</td>
        <td><span class="pill" style="background:${st.bg};color:${st.cor};border:1px solid ${st.cor}33;">${st.label}</span></td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

function janelaAtualizarTabela(root) {
  const alunos = JSON.parse(root.dataset.alunos || '[]');
  const aba = root.dataset.aba || 'todos';
  const filtro = (root.querySelector('.janela-busca')?.value || '').trim();
  const wrap = root.querySelector('.janela-alunos-wrap');
  if (wrap) wrap.innerHTML = janelaRenderTabela(alunos, filtro);
}

function janelaFiltrarBusca(input) {
  const root = input.closest('.janela-card');
  if (root) janelaAtualizarTabela(root);
}

function janelaRenderConteudo(unidade, unidId) {
  const r = unidade.resumo || {};
  const total = r.total_alunos_unicos || 0;
  const ident = r.treino_identificado || 0;
  const semIdent = Math.max(0, total - ident);
  const emDia = r.em_dia || 0;
  const venc = r.vencidos || 0;
  const sem = r.sem_treino || 0;
  const sync = unidade.sincronizacao || {};
  const nomeUnidade = (typeof UNIDADES !== 'undefined'
    ? UNIDADES.find(u => u.id === unidId)?.nome
    : null) || unidade.unidade_nome || unidId;

  const pctEm = total > 0 ? Math.round(emDia / total * 100) : 0;
  const pctVen = total > 0 ? Math.round(venc / total * 100) : 0;
  const pctSem = total > 0 ? Math.round(sem / total * 100) : 0;

  const alunosTodos = unidade.alunos?.todos || [
    ...(unidade.alunos?.em_dia || []),
    ...(unidade.alunos?.vencidos || []),
    ...(unidade.alunos?.sem_treino || []),
  ];

  const indicador = janelaTblCol('Indicador', [
    ['Total de alunos', total],
    ['Treino identificado', ident, '#378add'],
    ['Sem treino identificado', semIdent, 'var(--muted)'],
    ['Em dia', emDia, '#34c47c'],
    ['Vencidos', venc, '#f05c5c'],
    ['Sem treino', sem, '#f5a623'],
  ]);

  const distribuicao = janelaTblCol('Distribuição', [
    ['Em dia', `${emDia} (${pctEm}%)`, '#34c47c'],
    ['Vencidos', `${venc} (${pctVen}%)`, '#f05c5c'],
    ['Sem treino', `${sem} (${pctSem}%)`, '#f5a623'],
    ['Com treino', ident, '#378add'],
    ['Sem identificação', semIdent, 'var(--muted)'],
  ]);

  const sinc = janelaTblCol('Sincronização', [
    ['Última coleta', sync.ultima_coleta ? janelaFmtData(sync.ultima_coleta) : '—'],
    ['Atualizado em', sync.ultima_atualizacao ? janelaFmtData(sync.ultima_atualizacao) : '—'],
    ['Alunos na lista', alunosTodos.length],
  ]);

  const tabs = [
    { id: 'todos', label: 'Todos', n: alunosTodos.length },
    { id: 'em_dia', label: 'Em dia', n: (unidade.alunos?.em_dia || []).length },
    { id: 'vencidos', label: 'Vencidos', n: (unidade.alunos?.vencidos || []).length },
    { id: 'sem_treino', label: 'Sem treino', n: (unidade.alunos?.sem_treino || []).length },
  ];

  const alunosPorAba = {
    todos: alunosTodos,
    em_dia: unidade.alunos?.em_dia || [],
    vencidos: unidade.alunos?.vencidos || [],
    sem_treino: unidade.alunos?.sem_treino || [],
  };

  return `<div class="janela-card" data-aba="todos" data-alunos-por-aba='${JSON.stringify(alunosPorAba).replace(/'/g, '&#39;')}' data-alunos='${JSON.stringify(alunosTodos).replace(/'/g, '&#39;')}'>
    <div class="janela-card-head">
      <div>
        <div class="janela-title">Janela de Treino — ${typeof esc === 'function' ? esc(nomeUnidade) : nomeUnidade}</div>
        <div class="janela-sub">Dados ao vivo · ${sync.ultima_atualizacao ? 'Atualizado ' + janelaFmtData(sync.ultima_atualizacao) : 'Aguardando sincronização'}</div>
      </div>
      <button type="button" class="janela-refresh" onclick="renderJanelaTreino('${unidId}', true)" title="Atualizar">↻ Atualizar</button>
    </div>

    <div class="janela-tables">${indicador}${distribuicao}${sinc}</div>

    <div class="janela-bars">
      <div class="janela-bar" style="width:${pctEm}%;background:#34c47c;" title="Em dia ${pctEm}%"></div>
      <div class="janela-bar" style="width:${pctVen}%;background:#f05c5c;" title="Vencidos ${pctVen}%"></div>
      <div class="janela-bar" style="width:${pctSem}%;background:#f5a623;" title="Sem treino ${pctSem}%"></div>
    </div>
    <div class="janela-bar-legend">
      <span><i style="background:#34c47c"></i> Em dia ${pctEm}%</span>
      <span><i style="background:#f05c5c"></i> Vencidos ${pctVen}%</span>
      <span><i style="background:#f5a623"></i> Sem treino ${pctSem}%</span>
    </div>

    <div class="janela-alunos-sec">
      <div class="sec" style="margin-bottom:8px;">Alunos</div>
      <div class="janela-toolbar">
        <div class="janela-tabs">${tabs.map(t =>
          `<button type="button" class="janela-tab${t.id === 'todos' ? ' janela-tab-on' : ''}" onclick="janelaTrocarAba(this,'${t.id}')">${t.label} <span class="janela-tab-n">${t.n}</span></button>`
        ).join('')}</div>
        <input type="search" class="janela-busca" placeholder="Buscar aluno ou professor…" oninput="janelaFiltrarBusca(this)">
      </div>
      <div class="janela-alunos-wrap">${janelaRenderTabela(alunosTodos, '')}</div>
    </div>
  </div>`;
}

function janelaTrocarAba(btn, categoria) {
  const root = btn.closest('.janela-card');
  if (!root) return;
  root.querySelectorAll('.janela-tab').forEach(b => b.classList.remove('janela-tab-on'));
  btn.classList.add('janela-tab-on');
  root.dataset.aba = categoria;
  try {
    const porAba = JSON.parse(root.dataset.alunosPorAba || '{}');
    root.dataset.alunos = JSON.stringify(porAba[categoria] || []);
  } catch (_) { /* ignore */ }
  janelaAtualizarTabela(root);
}

async function renderJanelaTreino(unidId, forceRefresh) {
  const el = document.getElementById('dashJanelaTreino');
  if (!el) return;

  if (!unidId) {
    el.innerHTML = '';
    return;
  }

  if (forceRefresh) {
    _janelaCache.data = null;
    _janelaCache.at = 0;
  }

  el.innerHTML = `<div class="janela-card janela-loading">
    <div class="janela-title">Janela de Treino</div>
    <div class="janela-sub">Carregando dados…</div>
  </div>`;

  const data = await janelaBuscarDados();

  if (!data) {
    el.innerHTML = `<div class="janela-card janela-erro">
      <div class="janela-title">Janela de Treino</div>
      <div class="janela-sub">Não foi possível carregar os dados. Verifique o webhook ou tente novamente.</div>
      <button type="button" class="btn primary" style="margin-top:12px;" onclick="renderJanelaTreino('${unidId}', true)">Tentar novamente</button>
    </div>`;
    return;
  }

  const unidade = janelaEncontrarUnidade(data, unidId);

  if (!unidade) {
    el.innerHTML = `<div class="janela-card janela-erro">
      <div class="janela-title">Janela de Treino</div>
      <div class="janela-sub">Unidade não encontrada nos dados do webhook.</div>
    </div>`;
    return;
  }

  if (!unidade.resumo?.total_alunos_unicos && !(unidade.alunos?.todos || []).length) {
    el.innerHTML = `<div class="janela-card">
      <div class="janela-card-head">
        <div>
          <div class="janela-title">Janela de Treino — ${typeof UNIDADES !== 'undefined' ? (UNIDADES.find(u => u.id === unidId)?.nome || unidId) : unidId}</div>
          <div class="janela-sub">Sem dados sincronizados para esta unidade.</div>
        </div>
      </div>
      <div class="janela-empty">Aguardando a primeira coleta de dados.</div>
    </div>`;
    return;
  }

  el.innerHTML = janelaRenderConteudo(unidade, unidId);
}
