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

function janelaTooltipMatricula(aluno) {
  const mat = aluno?.matricula;
  return mat ? `Matrícula: ${mat}` : 'Matrícula não informada';
}

function janelaRenderNomeAluno(aluno) {
  const nome = typeof esc === 'function' ? esc(aluno.nome_aluno || '—') : (aluno.nome_aluno || '—');
  const tip = typeof esc === 'function' ? esc(janelaTooltipMatricula(aluno)) : janelaTooltipMatricula(aluno);
  return `<span class="janela-nome-aluno" title="${tip}">${nome}</span>`;
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
  const cls = janelaClassificarFrequencia(iso);
  return { txt: `${dias} dias`, cor: cls.cor };
}

/** Faixas de frequência de acesso (último acesso). */
const JANELA_FREQ = {
  normal:       { id: 'normal',       label: 'Normal',                    faixa: '0–6 dias',   cor: '#34c47c', bg: 'rgba(52,196,124,.1)',  acao: 'Rotina normal' },
  acompanhar:   { id: 'acompanhar',   label: 'Acompanhar',                faixa: '7–15 dias',  cor: '#378add', bg: 'rgba(55,138,221,.1)',  acao: 'Mandar mensagem' },
  alerta:       { id: 'alerta',       label: 'Alerta — resgatar',         faixa: '16–30 dias', cor: '#f5a623', bg: 'rgba(245,166,35,.1)',  acao: 'Resgatar aluno' },
  critico:      { id: 'critico',      label: 'Crítico — ação imediata',   faixa: '31+ dias',   cor: '#f05c5c', bg: 'rgba(240,92,92,.1)',   acao: 'Ação imediata p/ retorno' },
  sem_registro: { id: 'sem_registro', label: 'Sem registro de acesso',    faixa: '—',          cor: 'var(--muted)', bg: 'transparent',     acao: 'Verificar cadastro' },
};

function janelaBucketId(iso) {
  const dias = janelaDiasSemAcessar(iso);
  if (dias === null) return 'sem_registro';
  if (dias <= 6) return 'normal';
  if (dias <= 15) return 'acompanhar';
  if (dias <= 30) return 'alerta';
  return 'critico';
}

function janelaClassificarFrequencia(iso) {
  return JANELA_FREQ[janelaBucketId(iso)] || JANELA_FREQ.sem_registro;
}

function janelaMontarFreqBuckets(alunos) {
  const b = { todos: alunos || [], normal: [], acompanhar: [], alerta: [], critico: [], sem_registro: [] };
  (alunos || []).forEach(a => b[janelaBucketId(a.ultimo_acesso)].push(a));
  return b;
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

const JANELA_DIAS_OPCOES = [
  { id: '', label: 'Dias s/ acessar (todos)' },
  { id: 'normal', label: '0–6 dias' },
  { id: 'acompanhar', label: '7–15 dias' },
  { id: 'alerta', label: '16–30 dias' },
  { id: 'critico', label: '31+ dias' },
  { id: 'sem_registro', label: 'Sem registro' },
];

function janelaRenderSelectDias(selecionado) {
  const opts = JANELA_DIAS_OPCOES.map(o => {
    const sel = selecionado === o.id ? ' selected' : '';
    return `<option value="${o.id}"${sel}>${o.label}</option>`;
  });
  return `<select class="janela-dias-select" onchange="janelaTrocarDias(this)">${opts.join('')}</select>`;
}

function janelaGetViewRoot(root) {
  const modulo = root.dataset.modulo || 'treino';
  return root.querySelector(modulo === 'frequencia' ? '.janela-view-frequencia' : '.janela-view-treino') || root;
}

function janelaAtualizarSelectProfessores(root, resetProfessor, resetDias) {
  const alunos = JSON.parse(root.dataset.alunos || '[]');
  const view = janelaGetViewRoot(root);
  const sel = view.querySelector('.janela-prof-select');
  const selDias = view.querySelector('.janela-dias-select');
  const atual = resetProfessor ? '' : (sel?.value || '');
  const diasAtual = resetDias ? '' : (selDias?.value || '');
  const wrap = view.querySelector('.janela-filtros');
  if (wrap) {
    const busca = wrap.querySelector('.janela-busca');
    const buscaVal = busca?.value || '';
    wrap.innerHTML =
      janelaRenderSelectProfessores(alunos, atual) +
      janelaRenderSelectDias(diasAtual) +
      `<input type="search" class="janela-busca" placeholder="Buscar aluno ou matrícula…" value="${typeof esc === 'function' ? esc(buscaVal) : buscaVal}" oninput="janelaFiltrarBusca(this)">`;
  }
}

function janelaGetFiltros(root) {
  const view = janelaGetViewRoot(root);
  const filtro = (view.querySelector('.janela-busca')?.value || '').trim();
  let professor = view.querySelector('.janela-prof-select')?.value || '';
  if (professor === '__sem__') professor = '— Sem professor';
  const diasFaixa = view.querySelector('.janela-dias-select')?.value || '';
  return { filtro, professor, diasFaixa };
}

function janelaFiltrarLista(alunos, filtro, professor, diasFaixa) {
  return (alunos || []).filter(a => {
    if (professor) {
      const nomeProf = (a.nome_professor || '').trim() || '— Sem professor';
      if (nomeProf !== professor) return false;
    }
    if (diasFaixa && janelaBucketId(a.ultimo_acesso) !== diasFaixa) return false;
    if (!filtro) return true;
    const q = filtro.toLowerCase();
    return (a.nome_aluno || '').toLowerCase().includes(q) ||
      (a.matricula || '').includes(q);
  });
}

function janelaThSort(col, label, sortCol, sortDir) {
  const on = sortCol === col;
  const arrow = !on ? '↕' : sortDir === 'asc' ? '↑' : '↓';
  return `<th class="janela-th-sort${on ? ' janela-th-sort-on' : ''}" onclick="janelaClicarOrdenacao(this,'${col}')" title="Ordenar coluna">${label} <span class="janela-sort-ico">${arrow}</span></th>`;
}

function janelaClicarOrdenacao(th, col) {
  const root = th.closest('.janela-card');
  if (!root) return;
  const prev = root.dataset.sortCol || '';
  const prevDir = root.dataset.sortDir || 'asc';
  root.dataset.sortCol = col;
  root.dataset.sortDir = prev === col && prevDir === 'asc' ? 'desc' : 'asc';
  janelaAtualizarTabela(root, true);
}

function janelaSortVal(a, col) {
  switch (col) {
    case 'aluno': return (a.nome_aluno || '').toLowerCase();
    case 'professor': return (a.nome_professor || '').toLowerCase();
    case 'programa': return (a.nome_programa || '').toLowerCase();
    case 'valido_ate': return a.treino_valido_ate ? new Date(a.treino_valido_ate).getTime() : null;
    case 'ultimo_acesso': return a.ultimo_acesso ? new Date(a.ultimo_acesso).getTime() : null;
    case 'dias': {
      const d = janelaDiasSemAcessar(a.ultimo_acesso);
      return d === null ? null : d;
    }
    case 'status': {
      const st = JANELA_STATUS[a.status_treino];
      return (st?.label || a.status_treino || '').toLowerCase();
    }
    case 'classificacao': {
      const c = janelaClassificarFrequencia(a.ultimo_acesso);
      return (c?.label || '').toLowerCase();
    }
    case 'acao': {
      const c = janelaClassificarFrequencia(a.ultimo_acesso);
      return (c?.acao || '').toLowerCase();
    }
    default: return null;
  }
}

function janelaCmpOrdenacao(a, b, col) {
  const va = janelaSortVal(a, col);
  const vb = janelaSortVal(b, col);
  if (va == null && vb == null) return 0;
  if (va == null) return 1;
  if (vb == null) return -1;
  if (typeof va === 'number' && typeof vb === 'number') return va - vb;
  return String(va).localeCompare(String(vb), 'pt-BR', { sensitivity: 'base' });
}

function janelaAplicarOrdenacao(lista, sortCol, sortDir, modulo) {
  if (sortCol) {
    const mul = sortDir === 'desc' ? -1 : 1;
    return [...(lista || [])].sort((a, b) => janelaCmpOrdenacao(a, b, sortCol) * mul);
  }
  if (modulo === 'frequencia') {
    return [...(lista || [])].sort((a, b) => janelaCmpOrdenacao(a, b, 'dias') * -1);
  }
  return lista || [];
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

function janelaRenderTabela(alunos, filtro, pagina, professor, diasFaixa, sortCol, sortDir) {
  const sc = sortCol || '';
  const sd = sortDir || 'asc';
  let lista = janelaFiltrarLista(alunos, filtro, professor, diasFaixa);
  lista = janelaAplicarOrdenacao(lista, sc, sd, 'treino');

  if (!lista.length) {
    return `<div class="janela-empty">Nenhum aluno nesta categoria.</div>`;
  }

  const totalPag = Math.max(1, Math.ceil(lista.length / JANELA_PAGE_SIZE));
  const pag = Math.min(Math.max(1, pagina || 1), totalPag);
  const slice = lista.slice((pag - 1) * JANELA_PAGE_SIZE, pag * JANELA_PAGE_SIZE);

  return `<div class="tw janela-tw"><table>
    <thead><tr>
      ${janelaThSort('aluno', 'Aluno', sc, sd)}
      ${janelaThSort('professor', 'Professor', sc, sd)}
      ${janelaThSort('programa', 'Programa', sc, sd)}
      ${janelaThSort('valido_ate', 'Válido até', sc, sd)}
      ${janelaThSort('ultimo_acesso', 'Último acesso', sc, sd)}
      ${janelaThSort('dias', 'Dias s/ acessar', sc, sd)}
      ${janelaThSort('status', 'Status', sc, sd)}
    </tr></thead>
    <tbody>${slice.map(a => {
      const st = JANELA_STATUS[a.status_treino] || { label: a.status_treino || '—', cor: 'var(--muted)', bg: 'transparent' };
      const diasNum = janelaDiasSemAcessar(a.ultimo_acesso);
      const dias = janelaFmtDiasSemAcessar(a.ultimo_acesso);
      const diasDest = a.status_treino === 'VENCIDO' && diasNum != null && diasNum > 30;
      return `<tr>
        <td style="font-weight:500;">${janelaRenderNomeAluno(a)}</td>
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

function janelaRenderTabelaFrequencia(alunos, filtro, pagina, professor, diasFaixa, sortCol, sortDir) {
  const sc = sortCol || '';
  const sd = sortDir || 'asc';
  let lista = janelaFiltrarLista(alunos, filtro, professor, diasFaixa);
  lista = janelaAplicarOrdenacao(lista, sc, sd, 'frequencia');

  if (!lista.length) {
    return `<div class="janela-empty">Nenhum aluno nesta faixa de frequência.</div>`;
  }

  const totalPag = Math.max(1, Math.ceil(lista.length / JANELA_PAGE_SIZE));
  const pag = Math.min(Math.max(1, pagina || 1), totalPag);
  const slice = lista.slice((pag - 1) * JANELA_PAGE_SIZE, pag * JANELA_PAGE_SIZE);

  return `<div class="tw janela-tw"><table>
    <thead><tr>
      ${janelaThSort('aluno', 'Aluno', sc, sd)}
      ${janelaThSort('professor', 'Professor', sc, sd)}
      ${janelaThSort('ultimo_acesso', 'Último acesso', sc, sd)}
      ${janelaThSort('dias', 'Dias s/ acessar', sc, sd)}
      ${janelaThSort('classificacao', 'Classificação', sc, sd)}
      ${janelaThSort('acao', 'Ação sugerida', sc, sd)}
    </tr></thead>
    <tbody>${slice.map(a => {
      const cls = janelaClassificarFrequencia(a.ultimo_acesso);
      const dias = janelaFmtDiasSemAcessar(a.ultimo_acesso);
      return `<tr>
        <td style="font-weight:500;">${janelaRenderNomeAluno(a)}</td>
        <td>${typeof esc === 'function' ? esc(a.nome_professor || '—') : (a.nome_professor || '—')}</td>
        <td style="font-family:'DM Mono',monospace;font-size:11px;">${janelaFmtDataCurta(a.ultimo_acesso)}</td>
        <td style="font-family:'DM Mono',monospace;font-size:11px;font-weight:600;color:${dias.cor};">${dias.txt}</td>
        <td><span class="pill" style="background:${cls.bg};color:${cls.cor};border:1px solid ${cls.cor}33;">${cls.label}</span></td>
        <td style="font-size:11px;color:var(--muted);">${cls.acao}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>${janelaRenderPaginador(lista.length, pag)}`;
}

function janelaGetAlunosLista(root) {
  try {
    return JSON.parse(root.dataset.alunos || '[]');
  } catch (_) {
    return [];
  }
}

function janelaAtualizarTabela(root, resetPage, resetProfessor, resetDias) {
  if (resetPage) root.dataset.pagina = '1';
  if (resetProfessor) janelaAtualizarSelectProfessores(root, true, !!resetDias);
  const alunos = janelaGetAlunosLista(root);
  const { filtro, professor, diasFaixa } = janelaGetFiltros(root);
  const modulo = root.dataset.modulo || 'treino';
  const sortCol = root.dataset.sortCol || '';
  const sortDir = root.dataset.sortDir || 'asc';
  const lista = janelaFiltrarLista(alunos, filtro, professor, diasFaixa);
  const totalPag = Math.max(1, Math.ceil(lista.length / JANELA_PAGE_SIZE));
  let pagina = parseInt(root.dataset.pagina || '1', 10);
  pagina = Math.min(Math.max(1, pagina), totalPag);
  root.dataset.pagina = String(pagina);
  const view = janelaGetViewRoot(root);
  const wrap = view.querySelector('.janela-alunos-wrap');
  if (wrap) {
    wrap.innerHTML = modulo === 'frequencia'
      ? janelaRenderTabelaFrequencia(alunos, filtro, pagina, professor, diasFaixa, sortCol, sortDir)
      : janelaRenderTabela(alunos, filtro, pagina, professor, diasFaixa, sortCol, sortDir);
  }
}

function janelaFiltrarBusca(input) {
  const root = input.closest('.janela-card');
  if (root) janelaAtualizarTabela(root, true);
}

function janelaTrocarProfessor(select) {
  const root = select.closest('.janela-card');
  if (root) janelaAtualizarTabela(root, true);
}

function janelaTrocarDias(select) {
  const root = select.closest('.janela-card');
  if (!root) return;
  const faixa = select.value;
  if ((root.dataset.modulo || 'treino') === 'frequencia') {
    const cat = faixa || 'todos';
    const btn = root.querySelector(`.janela-view-frequencia .janela-tab[data-faixa="${cat}"]`);
    if (btn) {
      janelaTrocarAbaFreq(btn, cat);
      return;
    }
  }
  janelaAtualizarTabela(root, true);
}

function janelaIrPagina(btn, delta) {
  const root = btn.closest('.janela-card');
  if (!root) return;
  const alunos = janelaGetAlunosLista(root);
  const { filtro, professor, diasFaixa } = janelaGetFiltros(root);
  const lista = janelaFiltrarLista(alunos, filtro, professor, diasFaixa);
  const totalPag = Math.max(1, Math.ceil(lista.length / JANELA_PAGE_SIZE));
  let pagina = parseInt(root.dataset.pagina || '1', 10) + delta;
  root.dataset.pagina = String(Math.min(Math.max(1, pagina), totalPag));
  janelaAtualizarTabela(root);
}

function janelaRenderResumoFrequencia(alunos) {
  const buckets = janelaMontarFreqBuckets(alunos);
  const total = (alunos || []).length;
  const pct = (n) => total > 0 ? Math.round(n / total * 100) : 0;

  const indicador = janelaTblCol('Frequência', [
    ['Total na lista', total],
    [JANELA_FREQ.normal.label, buckets.normal.length, JANELA_FREQ.normal.cor],
    [JANELA_FREQ.acompanhar.label, buckets.acompanhar.length, JANELA_FREQ.acompanhar.cor],
    [JANELA_FREQ.alerta.label, buckets.alerta.length, JANELA_FREQ.alerta.cor],
    [JANELA_FREQ.critico.label, buckets.critico.length, JANELA_FREQ.critico.cor],
    [JANELA_FREQ.sem_registro.label, buckets.sem_registro.length, JANELA_FREQ.sem_registro.cor],
  ]);

  const distribuicao = janelaTblCol('Distribuição', [
    [`Normal (${JANELA_FREQ.normal.faixa})`, `${buckets.normal.length} (${pct(buckets.normal.length)}%)`, JANELA_FREQ.normal.cor],
    [`Acompanhar (${JANELA_FREQ.acompanhar.faixa})`, `${buckets.acompanhar.length} (${pct(buckets.acompanhar.length)}%)`, JANELA_FREQ.acompanhar.cor],
    [`Alerta (${JANELA_FREQ.alerta.faixa})`, `${buckets.alerta.length} (${pct(buckets.alerta.length)}%)`, JANELA_FREQ.alerta.cor],
    [`Crítico (${JANELA_FREQ.critico.faixa})`, `${buckets.critico.length} (${pct(buckets.critico.length)}%)`, JANELA_FREQ.critico.cor],
    ['Sem registro', buckets.sem_registro.length, JANELA_FREQ.sem_registro.cor],
  ]);

  const acoes = janelaTblCol('Ações sugeridas', [
    ['Normal', JANELA_FREQ.normal.acao],
    ['Acompanhar', JANELA_FREQ.acompanhar.acao],
    ['Alerta', JANELA_FREQ.alerta.acao],
    ['Crítico', JANELA_FREQ.critico.acao],
    ['Sem registro', JANELA_FREQ.sem_registro.acao],
  ]);

  const pN = pct(buckets.normal.length);
  const pA = pct(buckets.acompanhar.length);
  const pAl = pct(buckets.alerta.length);
  const pC = pct(buckets.critico.length);
  const pS = pct(buckets.sem_registro.length);

  const bars = `<div class="janela-bars janela-bars-freq">
    <div class="janela-bar" style="width:${pN}%;background:${JANELA_FREQ.normal.cor};" title="Normal ${pN}%"></div>
    <div class="janela-bar" style="width:${pA}%;background:${JANELA_FREQ.acompanhar.cor};" title="Acompanhar ${pA}%"></div>
    <div class="janela-bar" style="width:${pAl}%;background:${JANELA_FREQ.alerta.cor};" title="Alerta ${pAl}%"></div>
    <div class="janela-bar" style="width:${pC}%;background:${JANELA_FREQ.critico.cor};" title="Crítico ${pC}%"></div>
    <div class="janela-bar" style="width:${pS}%;background:var(--muted);" title="Sem registro ${pS}%"></div>
  </div>
  <div class="janela-bar-legend">
    <span><i style="background:${JANELA_FREQ.normal.cor}"></i> Normal ${pN}%</span>
    <span><i style="background:${JANELA_FREQ.acompanhar.cor}"></i> Acompanhar ${pA}%</span>
    <span><i style="background:${JANELA_FREQ.alerta.cor}"></i> Alerta ${pAl}%</span>
    <span><i style="background:${JANELA_FREQ.critico.cor}"></i> Crítico ${pC}%</span>
    <span><i style="background:var(--muted)"></i> Sem registro ${pS}%</span>
  </div>`;

  return { indicador, distribuicao, acoes, bars, buckets };
}

function janelaTrocarModulo(btn, modulo) {
  const root = btn.closest('.janela-card');
  if (!root) return;
  root.dataset.modulo = modulo;
  root.dataset.pagina = '1';
  root.querySelectorAll('.janela-modulo-btn').forEach(b => b.classList.remove('janela-modulo-on'));
  btn.classList.add('janela-modulo-on');

  const viewTreino = root.querySelector('.janela-view-treino');
  const viewFreq = root.querySelector('.janela-view-frequencia');
  if (viewTreino) viewTreino.hidden = modulo !== 'treino';
  if (viewFreq) viewFreq.hidden = modulo !== 'frequencia';

  if (modulo === 'frequencia') {
    try {
      const porFreq = JSON.parse(root.dataset.alunosPorFreq || '{}');
      const freqAba = root.dataset.freqAba || 'todos';
      root.dataset.alunos = JSON.stringify(porFreq[freqAba] || []);
    } catch (_) { /* ignore */ }
  } else {
    try {
      const porAba = JSON.parse(root.dataset.alunosPorAba || '{}');
      const aba = root.dataset.aba || 'todos';
      root.dataset.alunos = JSON.stringify(porAba[aba] || []);
    } catch (_) { /* ignore */ }
  }

  janelaAtualizarSelectProfessores(root, false);
  janelaAtualizarTabela(root, true);
}

function janelaTrocarAbaFreq(btn, categoria) {
  const root = btn.closest('.janela-card');
  if (!root) return;
  root.querySelectorAll('.janela-view-frequencia .janela-tab').forEach(b => b.classList.remove('janela-tab-on'));
  btn.classList.add('janela-tab-on');
  root.dataset.freqAba = categoria;
  try {
    const porFreq = JSON.parse(root.dataset.alunosPorFreq || '{}');
    root.dataset.alunos = JSON.stringify(porFreq[categoria] || []);
  } catch (_) { /* ignore */ }
  janelaAtualizarSelectProfessores(root, true, categoria === 'todos');
  const diasSel = janelaGetViewRoot(root).querySelector('.janela-dias-select');
  if (diasSel) diasSel.value = categoria === 'todos' ? '' : categoria;
  janelaAtualizarTabela(root, true, false);
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

  const freqResumo = janelaRenderResumoFrequencia(alunosTodos);
  const alunosPorFreq = {
    todos: alunosTodos,
    normal: freqResumo.buckets.normal,
    acompanhar: freqResumo.buckets.acompanhar,
    alerta: freqResumo.buckets.alerta,
    critico: freqResumo.buckets.critico,
    sem_registro: freqResumo.buckets.sem_registro,
  };

  const freqTabs = [
    { id: 'todos', label: 'Todos', n: alunosTodos.length },
    { id: 'normal', label: '0–6', n: freqResumo.buckets.normal.length, cor: JANELA_FREQ.normal.cor },
    { id: 'acompanhar', label: '7–15', n: freqResumo.buckets.acompanhar.length, cor: JANELA_FREQ.acompanhar.cor },
    { id: 'alerta', label: '16–30', n: freqResumo.buckets.alerta.length, cor: JANELA_FREQ.alerta.cor },
    { id: 'critico', label: '31+', n: freqResumo.buckets.critico.length, cor: JANELA_FREQ.critico.cor },
    { id: 'sem_registro', label: 'Sem registro', n: freqResumo.buckets.sem_registro.length },
  ];

  const jsonAba = JSON.stringify(alunosPorAba).replace(/'/g, '&#39;');
  const jsonFreq = JSON.stringify(alunosPorFreq).replace(/'/g, '&#39;');
  const jsonAlunos = JSON.stringify(alunosTodos).replace(/'/g, '&#39;');

  return `<div class="janela-card" data-modulo="treino" data-aba="todos" data-freq-aba="todos" data-pagina="1"
    data-alunos-por-aba='${jsonAba}' data-alunos-por-freq='${jsonFreq}' data-alunos='${jsonAlunos}'>
    <div class="janela-card-head">
      <div>
        <div class="janela-title">Janela de Treino — ${typeof esc === 'function' ? esc(nomeUnidade) : nomeUnidade}</div>
        <div class="janela-sub">Dados ao vivo · ${sync.ultima_atualizacao ? 'Atualizado ' + janelaFmtData(sync.ultima_atualizacao) : 'Aguardando sincronização'}</div>
      </div>
      <button type="button" class="janela-refresh" onclick="renderJanelaTreino('${unidId}', true)" title="Atualizar">↻ Atualizar</button>
    </div>

    <div class="janela-modulo-nav">
      <button type="button" class="janela-modulo-btn janela-modulo-on" onclick="janelaTrocarModulo(this,'treino')">Situação do treino</button>
      <button type="button" class="janela-modulo-btn" onclick="janelaTrocarModulo(this,'frequencia')">Frequência de acesso</button>
    </div>

    <div class="janela-view-treino">
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
        <div class="sec" style="margin-bottom:8px;">Alunos por situação do treino</div>
        <div class="janela-toolbar">
          <div class="janela-tabs">${tabs.map(t =>
            `<button type="button" class="janela-tab${t.id === 'todos' ? ' janela-tab-on' : ''}" onclick="janelaTrocarAba(this,'${t.id}')">${t.label} <span class="janela-tab-n">${t.n}</span></button>`
          ).join('')}</div>
          <div class="janela-filtros">
            ${janelaRenderSelectProfessores(alunosTodos, '')}
            ${janelaRenderSelectDias('')}
            <input type="search" class="janela-busca" placeholder="Buscar aluno ou matrícula…" oninput="janelaFiltrarBusca(this)">
          </div>
        </div>
        <div class="janela-alunos-wrap">${janelaRenderTabela(alunosTodos, '', 1, '', '')}</div>
      </div>
    </div>

    <div class="janela-view-frequencia" hidden>
      <div class="janela-tables">${freqResumo.indicador}${freqResumo.distribuicao}${freqResumo.acoes}</div>
      ${freqResumo.bars}
      <div class="janela-alunos-sec">
        <div class="sec" style="margin-bottom:8px;">Alunos por frequência de acesso</div>
        <div class="janela-toolbar">
          <div class="janela-tabs">${freqTabs.map(t =>
            `<button type="button" class="janela-tab${t.id === 'todos' ? ' janela-tab-on' : ''}" data-faixa="${t.id}" onclick="janelaTrocarAbaFreq(this,'${t.id}')">${t.label} <span class="janela-tab-n"${t.cor ? ` style="color:${t.cor}"` : ''}>${t.n}</span></button>`
          ).join('')}</div>
          <div class="janela-filtros">
            ${janelaRenderSelectProfessores(alunosTodos, '')}
            ${janelaRenderSelectDias('')}
            <input type="search" class="janela-busca" placeholder="Buscar aluno ou matrícula…" oninput="janelaFiltrarBusca(this)">
          </div>
        </div>
        <div class="janela-alunos-wrap">${janelaRenderTabelaFrequencia(alunosTodos, '', 1, '', '')}</div>
      </div>
    </div>
  </div>`;
}

function janelaTrocarAba(btn, categoria) {
  const root = btn.closest('.janela-card');
  if (!root) return;
  root.querySelectorAll('.janela-view-treino .janela-tab').forEach(b => b.classList.remove('janela-tab-on'));
  btn.classList.add('janela-tab-on');
  root.dataset.aba = categoria;
  try {
    const porAba = JSON.parse(root.dataset.alunosPorAba || '{}');
    root.dataset.alunos = JSON.stringify(porAba[categoria] || []);
  } catch (_) { /* ignore */ }
  janelaAtualizarSelectProfessores(root, true, true);
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
