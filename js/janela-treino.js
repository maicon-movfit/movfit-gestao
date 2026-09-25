// ════════════════════════════════════════════════════════════════════════
// JANELA DE TREINO — dados ao vivo via webhook n8n
// Config: js/n8n-config.js
// ════════════════════════════════════════════════════════════════════════

const _janelaCache = { data: null, at: 0 };
const JANELA_CACHE_TTL_MS = 3 * 60 * 1000;
const JANELA_PAGE_SIZE = 10;

/** Mapeamento unidId (app) → unidade do webhook. */
const JANELA_UNIDADE_MAP = {
  medicilandia: { codigo: 1, slug: 'medicilandia' },
  itaituba:     { codigo: 2, slug: 'itaituba' },
  premium24:    { codigo: 3, slug: 'santarem_24h' },
  nrexpress:    { codigo: 5, slug: 'santarem_nova_republica' },
};

const JANELA_STATUS = {
  EM_DIA:     { label: 'Em dia',     cor: '#34c47c', bg: 'rgba(52,196,124,.1)' },
  A_VENCER:   { label: 'A vencer',   cor: '#eab308', bg: 'rgba(234,179,8,.12)' },
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

function janelaDiasSemAcessar(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const hoje = new Date();
  const h = Date.UTC(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  const u = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const dias = Math.floor((h - u) / (1000 * 60 * 60 * 24));
  return dias >= 0 ? dias : 0;
}

function janelaFmtDiasSemAcessar(iso) {
  const dias = janelaDiasSemAcessar(iso);
  if (dias === null) return { txt: 'Sem registro', cor: 'var(--muted)' };
  if (dias === 0) return { txt: 'Hoje', cor: 'var(--muted)' };
  if (dias === 1) return { txt: '1 dia', cor: 'var(--muted)' };
  let cor = 'var(--text)';
  if (dias > 30) cor = '#f05c5c';
  else if (dias >= 22) cor = '#f5a623';
  return { txt: `${dias} dias`, cor };
}

/** Desembrulha resposta n8n: raiz direta ou legado dados[].resposta. */
function janelaNormalizarResposta(raw) {
  if (!raw) return null;
  if (raw.sucesso && raw.unidades) return raw;
  const item = raw.dados?.[0];
  if (item?.resposta?.unidades) return item.resposta;
  if (item?.unidades) return item;
  if (raw.unidades) return raw;
  return null;
}

function janelaMontarAlunosTodos(unidade) {
  const a = unidade.alunos || {};
  if (a.todos?.length) return a.todos;
  return [
    ...(a.em_dia || []),
    ...(a.a_vencer || []),
    ...(a.vencidos || []),
    ...(a.sem_treino || []),
  ];
}

function janelaContarAVencer(unidade) {
  const r = unidade.resumo || {};
  if (r.a_vencer != null) return Number(r.a_vencer);
  return (unidade.alunos?.a_vencer || []).length;
}

function janelaAtualizarCardsPainel(unidId, unidade) {
  const aVencer = janelaContarAVencer(unidade);
  const card = document.getElementById('dashMetricAVencer');
  if (!card) return;
  const mv = card.querySelector('.mv');
  const ml = card.querySelector('.ml');
  if (mv) mv.textContent = aVencer.toLocaleString('pt-BR');
  if (ml) ml.textContent = 'Treinos a vencer';
  while (mv && mv.nextElementSibling && !mv.nextElementSibling.classList.contains('md-live')) {
    mv.nextElementSibling.remove();
  }
  let live = card.querySelector('.md-live');
  if (!live) {
    live = document.createElement('div');
    live.className = 'md-live';
    live.style.cssText = 'font-size:11px;font-weight:600;color:var(--muted);margin-top:4px;';
    card.appendChild(live);
  }
  const when = janelaFmtData(unidade.sincronizacao?.ultima_atualizacao);
  live.textContent = when && when !== '—' ? `Ao vivo · ${when}` : 'Ao vivo';
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

function janelaExtrairProfessores(alunos) {
  const map = new Map();
  (alunos || []).forEach(a => {
    const nome = (a.nome_professor || '').trim() || '— Sem professor';
    map.set(nome, (map.get(nome) || 0) + 1);
  });
  return [...map.entries()]
    .map(([nome, n]) => ({ nome, n }))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

function janelaRenderSelectProfessores(alunos, selecionado) {
  const profs = janelaExtrairProfessores(alunos);
  const opts = [`<option value="">Todos os professores (${(alunos || []).length})</option>`]
    .concat(profs.map(p => {
      const val = p.nome === '— Sem professor' ? '__sem__' : p.nome;
      const sel = selecionado === val ? ' selected' : '';
      const lbl = typeof esc === 'function' ? esc(p.nome) : p.nome;
      return `<option value="${typeof esc === 'function' ? esc(val) : val}"${sel}>${lbl} (${p.n})</option>`;
    }));
  return `<select class="janela-prof-select" onchange="janelaTrocarProfessor(this)">${opts.join('')}</select>`;
}

function janelaAtualizarSelectProfessores(root, resetProfessor) {
  const alunos = JSON.parse(root.dataset.alunos || '[]');
  const sel = root.querySelector('.janela-prof-select');
  const atual = resetProfessor ? '' : (sel?.value || '');
  const wrap = root.querySelector('.janela-filtros');
  if (wrap) {
    const busca = wrap.querySelector('.janela-busca');
    const buscaVal = busca?.value || '';
    wrap.innerHTML =
      janelaRenderSelectProfessores(alunos, atual) +
      `<input type="search" class="janela-busca" placeholder="Buscar aluno…" value="${typeof esc === 'function' ? esc(buscaVal) : buscaVal}" oninput="janelaFiltrarBusca(this)">`;
  }
}

function janelaGetFiltros(root) {
  const filtro = (root.querySelector('.janela-busca')?.value || '').trim();
  let professor = root.querySelector('.janela-prof-select')?.value || '';
  if (professor === '__sem__') professor = '— Sem professor';
  return { filtro, professor };
}

function janelaFiltrarLista(alunos, filtro, professor) {
  return (alunos || []).filter(a => {
    if (professor) {
      const nomeProf = (a.nome_professor || '').trim() || '— Sem professor';
      if (nomeProf !== professor) return false;
    }
    if (!filtro) return true;
    const q = filtro.toLowerCase();
    return (a.nome_aluno || '').toLowerCase().includes(q) ||
      (a.matricula || '').includes(q);
  });
}

function janelaRenderPaginador(total, pagina) {
  const totalPag = Math.max(1, Math.ceil(total / JANELA_PAGE_SIZE));
  const pag = Math.min(Math.max(1, pagina || 1), totalPag);
  const inicio = total === 0 ? 0 : (pag - 1) * JANELA_PAGE_SIZE + 1;
  const fim = Math.min(pag * JANELA_PAGE_SIZE, total);

  return `<div class="janela-pag">
    <span class="janela-pag-info">Mostrando ${inicio.toLocaleString('pt-BR')}–${fim.toLocaleString('pt-BR')} de ${total.toLocaleString('pt-BR')}</span>
    <div class="janela-pag-btns">
      <button type="button" class="janela-pag-btn" onclick="janelaIrPagina(this,-1)" ${pag <= 1 ? 'disabled' : ''}>← Anterior</button>
      <span class="janela-pag-num">Página ${pag} de ${totalPag}</span>
      <button type="button" class="janela-pag-btn" onclick="janelaIrPagina(this,1)" ${pag >= totalPag ? 'disabled' : ''}>Próxima →</button>
    </div>
  </div>`;
}

function janelaRenderTabela(alunos, filtro, pagina, professor) {
  const lista = janelaFiltrarLista(alunos, filtro, professor);

  if (!lista.length) {
    return `<div class="janela-empty">Nenhum aluno nesta categoria.</div>`;
  }

  const totalPag = Math.max(1, Math.ceil(lista.length / JANELA_PAGE_SIZE));
  const pag = Math.min(Math.max(1, pagina || 1), totalPag);
  const slice = lista.slice((pag - 1) * JANELA_PAGE_SIZE, pag * JANELA_PAGE_SIZE);

  return `<div class="tw janela-tw"><table>
    <thead><tr>
      <th>Aluno</th>
      <th>Professor</th>
      <th>Programa</th>
      <th>Válido até</th>
      <th>Último acesso</th>
      <th>Dias s/ acessar</th>
      <th>Status</th>
    </tr></thead>
    <tbody>${slice.map(a => {
      const st = JANELA_STATUS[a.status_treino] || { label: a.status_treino || '—', cor: 'var(--muted)', bg: 'transparent' };
      const diasNum = janelaDiasSemAcessar(a.ultimo_acesso);
      const dias = janelaFmtDiasSemAcessar(a.ultimo_acesso);
      const diasDest = a.status_treino === 'VENCIDO' && diasNum != null && diasNum > 30;
      return `<tr>
        <td style="font-weight:500;">${typeof esc === 'function' ? esc(a.nome_aluno) : a.nome_aluno}</td>
        <td>${typeof esc === 'function' ? esc(a.nome_professor || '—') : (a.nome_professor || '—')}</td>
        <td style="max-width:180px;white-space:normal;">${typeof esc === 'function' ? esc(a.nome_programa || '—') : (a.nome_programa || '—')}</td>
        <td style="font-family:'DM Mono',monospace;font-size:11px;">${janelaFmtDataCurta(a.treino_valido_ate)}</td>
        <td style="font-family:'DM Mono',monospace;font-size:11px;">${janelaFmtDataCurta(a.ultimo_acesso)}</td>
        <td style="font-family:'DM Mono',monospace;font-size:11px;font-weight:${diasDest ? '700' : '600'};color:${dias.cor};">${dias.txt}</td>
        <td><span class="pill" style="background:${st.bg};color:${st.cor};border:1px solid ${st.cor}33;">${st.label}</span></td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>${janelaRenderPaginador(lista.length, pag)}`;
}

function janelaAtualizarTabela(root, resetPage, resetProfessor) {
  if (resetPage) root.dataset.pagina = '1';
  if (resetProfessor) janelaAtualizarSelectProfessores(root, true);
  const alunos = JSON.parse(root.dataset.alunos || '[]');
  const { filtro, professor } = janelaGetFiltros(root);
  const lista = janelaFiltrarLista(alunos, filtro, professor);
  const totalPag = Math.max(1, Math.ceil(lista.length / JANELA_PAGE_SIZE));
  let pagina = parseInt(root.dataset.pagina || '1', 10);
  pagina = Math.min(Math.max(1, pagina), totalPag);
  root.dataset.pagina = String(pagina);
  const wrap = root.querySelector('.janela-alunos-wrap');
  if (wrap) wrap.innerHTML = janelaRenderTabela(alunos, filtro, pagina, professor);
}

function janelaFiltrarBusca(input) {
  const root = input.closest('.janela-card');
  if (root) janelaAtualizarTabela(root, true);
}

function janelaTrocarProfessor(select) {
  const root = select.closest('.janela-card');
  if (root) janelaAtualizarTabela(root, true);
}

function janelaIrPagina(btn, delta) {
  const root = btn.closest('.janela-card');
  if (!root) return;
  const alunos = JSON.parse(root.dataset.alunos || '[]');
  const { filtro, professor } = janelaGetFiltros(root);
  const lista = janelaFiltrarLista(alunos, filtro, professor);
  const totalPag = Math.max(1, Math.ceil(lista.length / JANELA_PAGE_SIZE));
  let pagina = parseInt(root.dataset.pagina || '1', 10) + delta;
  root.dataset.pagina = String(Math.min(Math.max(1, pagina), totalPag));
  janelaAtualizarTabela(root);
}

function janelaRenderConteudo(unidade, unidId, totalAtivos) {
  const r = unidade.resumo || {};
  const total = totalAtivos ?? r.total_alunos_unicos ?? 0;
  const ident = r.treino_identificado || 0;
  const semIdent = Math.max(0, total - ident);
  const emDia = r.em_dia || 0;
  const aVencer = janelaContarAVencer(unidade);
  const venc = r.vencidos || 0;
  const sem = r.sem_treino || 0;
  const sync = unidade.sincronizacao || {};
  const nomeUnidade = (typeof UNIDADES !== 'undefined'
    ? UNIDADES.find(u => u.id === unidId)?.nome
    : null) || unidade.unidade_nome || unidId;

  const pctEm = total > 0 ? Math.round(emDia / total * 100) : 0;
  const pctAV = total > 0 ? Math.round(aVencer / total * 100) : 0;
  const pctVen = total > 0 ? Math.round(venc / total * 100) : 0;
  const pctSem = total > 0 ? Math.round(sem / total * 100) : 0;

  const alunosTodos = janelaMontarAlunosTodos(unidade);

  const indicador = janelaTblCol('Indicador', [
    [totalAtivos != null ? 'Alunos ativos' : 'Total de alunos', total],
    ['Treino identificado', ident, '#378add'],
    ['Sem treino identificado', semIdent, 'var(--muted)'],
    ['Em dia', emDia, '#34c47c'],
    ['A vencer', aVencer, '#eab308'],
    ['Vencidos', venc, '#f05c5c'],
    ['Sem treino', sem, '#f5a623'],
  ]);

  const distribuicao = janelaTblCol('Distribuição', [
    ['Em dia', `${emDia} (${pctEm}%)`, '#34c47c'],
    ['A vencer', `${aVencer} (${pctAV}%)`, '#eab308'],
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
    { id: 'a_vencer', label: 'A vencer', n: (unidade.alunos?.a_vencer || []).length || aVencer },
    { id: 'vencidos', label: 'Vencidos', n: (unidade.alunos?.vencidos || []).length },
    { id: 'sem_treino', label: 'Sem treino', n: (unidade.alunos?.sem_treino || []).length },
  ];

  const alunosPorAba = {
    todos: alunosTodos,
    em_dia: unidade.alunos?.em_dia || [],
    a_vencer: unidade.alunos?.a_vencer || [],
    vencidos: unidade.alunos?.vencidos || [],
    sem_treino: unidade.alunos?.sem_treino || [],
  };

  return `<div class="janela-card" data-aba="todos" data-pagina="1" data-alunos-por-aba='${JSON.stringify(alunosPorAba).replace(/'/g, '&#39;')}' data-alunos='${JSON.stringify(alunosTodos).replace(/'/g, '&#39;')}'>
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
      <div class="janela-bar" style="width:${pctAV}%;background:#eab308;" title="A vencer ${pctAV}%"></div>
      <div class="janela-bar" style="width:${pctVen}%;background:#f05c5c;" title="Vencidos ${pctVen}%"></div>
      <div class="janela-bar" style="width:${pctSem}%;background:#f5a623;" title="Sem treino ${pctSem}%"></div>
    </div>
    <div class="janela-bar-legend">
      <span><i style="background:#34c47c"></i> Em dia ${pctEm}%</span>
      <span><i style="background:#eab308"></i> A vencer ${pctAV}%</span>
      <span><i style="background:#f05c5c"></i> Vencidos ${pctVen}%</span>
      <span><i style="background:#f5a623"></i> Sem treino ${pctSem}%</span>
    </div>

    <div class="janela-alunos-sec">
      <div class="sec" style="margin-bottom:8px;">Alunos</div>
      <div class="janela-toolbar">
        <div class="janela-tabs">${tabs.map(t =>
          `<button type="button" class="janela-tab${t.id === 'todos' ? ' janela-tab-on' : ''}" onclick="janelaTrocarAba(this,'${t.id}')">${t.label} <span class="janela-tab-n">${t.n}</span></button>`
        ).join('')}</div>
        <div class="janela-filtros">
          ${janelaRenderSelectProfessores(alunosTodos, '')}
          <input type="search" class="janela-busca" placeholder="Buscar aluno…" oninput="janelaFiltrarBusca(this)">
        </div>
      </div>
      <div class="janela-alunos-wrap">${janelaRenderTabela(alunosTodos, '', 1, '')}</div>
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
  janelaAtualizarSelectProfessores(root, true);
  janelaAtualizarTabela(root, true);
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

  const fetchAtivos = typeof totalAtivosBuscarDados === 'function'
    ? totalAtivosBuscarDados(forceRefresh)
    : Promise.resolve(null);
  const [data] = await Promise.all([janelaBuscarDados(), fetchAtivos]);
  const totalAtivos = typeof totalAtivosGetUnidade === 'function'
    ? totalAtivosGetUnidade(unidId)
    : null;

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

  if (!unidade.resumo?.total_alunos_unicos &&
    !janelaMontarAlunosTodos(unidade).length &&
    !janelaContarAVencer(unidade)) {
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

  el.innerHTML = janelaRenderConteudo(unidade, unidId, totalAtivos);
  janelaAtualizarCardsPainel(unidId, unidade);
}
