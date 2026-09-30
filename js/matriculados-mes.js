// ════════════════════════════════════════════════════════════════════════
// MATRICULADOS NO MÊS — webhook n8n
// Config: js/n8n-config.js
// ════════════════════════════════════════════════════════════════════════

const _matriculadosCache = { data: null, at: 0 };
const MATRICULADOS_CACHE_TTL_MS = 3 * 60 * 1000;
const MATRICULADOS_PAGE_SIZE = 10;

const MATRICULADOS_UNIDADE_MAP = {
  medicilandia: { codigo: 1, slug: 'medicilandia' },
  itaituba:     { codigo: 2, slug: 'itaituba' },
  premium24:    { codigo: 3, slug: 'santarem_24h' },
  nrexpress:    { codigo: 5, slug: 'santarem_nova_republica' },
};

function matriculadosFmtData(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function matriculadosFmtDataCurta(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('pt-BR');
}

function matriculadosFmtCompetencia(comp) {
  if (!comp) return '—';
  const [y, m] = String(comp).split('-');
  if (!y || !m) return comp;
  const d = new Date(Number(y), Number(m) - 1, 1);
  if (Number.isNaN(d.getTime())) return comp;
  return d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
}

/** Aceita payload agrupado ou item único legado. */
function matriculadosNormalizarResposta(raw) {
  if (!raw) return null;
  if (raw.sucesso && raw.unidades) return raw;
  if (raw.unidade_codigo != null && raw.nome_aluno != null) {
    return {
      sucesso: true,
      competencia: raw.competencia_coleta || null,
      gerado_em: raw.coletado_em || null,
      resumo_geral: { total_alunos_unicos: 1, total_contratos: 1, total_unidades: 1 },
      unidades: [{
        unidade_codigo: raw.unidade_codigo,
        unidade_nome: raw.unidade_nome,
        matriculados: [raw],
      }],
    };
  }
  const item = raw.dados?.[0];
  if (item?.resposta?.unidades) return item.resposta;
  if (item?.unidades) return item;
  return null;
}

function matriculadosEncontrarUnidade(data, unidId) {
  const ref = MATRICULADOS_UNIDADE_MAP[unidId];
  if (!ref || !data?.unidades) return null;
  return data.unidades.find(u =>
    u.unidade_codigo === ref.codigo ||
    u.unidade_nome === ref.slug
  ) || null;
}

function matriculadosLista(unidade) {
  return unidade?.matriculados || unidade?.alunos || unidade?.contratos || [];
}

function matriculadosUnidIdPorCodigo(codigo, nome) {
  for (const [id, ref] of Object.entries(MATRICULADOS_UNIDADE_MAP)) {
    if (ref.codigo === codigo || ref.slug === nome) return id;
  }
  return null;
}

function matriculadosAlunoDocId(m) {
  if (m.codigo_contrato != null && m.codigo_contrato !== '') {
    return String(m.codigo_contrato);
  }
  const mat = String(m.matricula || 'sem_matricula');
  const dt = String(m.data_lancamento || '').slice(0, 10);
  return `${mat}_${dt}`;
}

function matriculadosColCompetencias(unidId) {
  if (typeof db === 'undefined' || !unidId) return null;
  return db.collection('unidades').doc(unidId).collection('matriculados_competencias');
}

function matriculadosColAlunos(unidId) {
  if (typeof db === 'undefined' || !unidId) return null;
  return db.collection('unidades').doc(unidId).collection('matriculados_alunos');
}

/** Grava snapshot mensal + ficha de cada aluno (data_lancamento preservada). */
async function matriculadosPersistir(data) {
  if (typeof db === 'undefined' || !data?.unidades || !data.competencia) return;
  const competencia = data.competencia;
  const agora = new Date().toISOString();

  for (const u of data.unidades) {
    const unidId = matriculadosUnidIdPorCodigo(u.unidade_codigo, u.unidade_nome);
    if (!unidId) continue;
    const lista = matriculadosLista(u);

    try {
      await matriculadosColCompetencias(unidId).doc(competencia).set({
        competencia,
        unidade_codigo: u.unidade_codigo,
        unidade_nome: u.unidade_nome,
        sincronizado_em: agora,
        gerado_em: data.gerado_em || null,
        total: lista.length,
        matriculados: lista,
      }, { merge: true });
    } catch (e) {
      console.warn('[MATRICULADOS] Erro ao salvar competência', unidId, competencia, e.message);
    }

    if (!lista.length) continue;
    const col = matriculadosColAlunos(unidId);
    for (let i = 0; i < lista.length; i += 400) {
      const batch = db.batch();
      lista.slice(i, i + 400).forEach(m => {
        batch.set(col.doc(matriculadosAlunoDocId(m)), {
          ...m,
          competencia,
          data_matricula: m.data_lancamento || null,
          unidadeId: unidId,
          atualizado_em: agora,
        }, { merge: true });
      });
      try {
        await batch.commit();
      } catch (e) {
        console.warn('[MATRICULADOS] Erro ao salvar alunos', unidId, e.message);
        break;
      }
    }
  }
}

async function matriculadosListarCompetencias(unidId) {
  const col = matriculadosColCompetencias(unidId);
  if (!col) return [];
  try {
    const snap = await col.orderBy('competencia', 'desc').get();
    return snap.docs.map(d => {
      const x = d.data();
      return {
        competencia: d.id,
        total: x.total ?? (x.matriculados || []).length,
        sincronizado_em: x.sincronizado_em || null,
      };
    });
  } catch (e) {
    console.warn('[MATRICULADOS] Erro ao listar histórico', e.message);
    return [];
  }
}

async function matriculadosCarregarCompetencia(unidId, competencia) {
  const col = matriculadosColCompetencias(unidId);
  if (!col || !competencia) return null;
  try {
    const doc = await col.doc(competencia).get();
    if (!doc.exists) return null;
    return doc.data();
  } catch (e) {
    console.warn('[MATRICULADOS] Erro ao carregar competência', competencia, e.message);
    return null;
  }
}

function matriculadosRenderSelectCompetencias(unidId, competencias, aoVivo, selecionada) {
  const opts = [`<option value="__live__"${selecionada === '__live__' ? ' selected' : ''}>${aoVivo ? matriculadosFmtCompetencia(aoVivo) + ' (ao vivo)' : 'Mês atual (ao vivo)'}</option>`];
  (competencias || []).forEach(c => {
    if (c.competencia === aoVivo) return;
    const sel = selecionada === c.competencia ? ' selected' : '';
    opts.push(`<option value="${c.competencia}"${sel}>${matriculadosFmtCompetencia(c.competencia)} — ${c.total} alunos (histórico)</option>`);
  });
  return `<select class="janela-prof-select matric-comp-select" onchange="matriculadosTrocarCompetencia(this,'${unidId}')">${opts.join('')}</select>`;
}

async function matriculadosBuscarDados(forceRefresh) {
  if (typeof N8N_MATRICULADOS_URL === 'undefined' || !N8N_MATRICULADOS_URL) {
    console.warn('[MATRICULADOS] Configure N8N_MATRICULADOS_URL em js/n8n-config.js');
    return null;
  }
  if (!forceRefresh && _matriculadosCache.data &&
    (Date.now() - _matriculadosCache.at) < MATRICULADOS_CACHE_TTL_MS) {
    return _matriculadosCache.data;
  }
  if (window._matriculadosInflightPromise) return window._matriculadosInflightPromise;

  window._matriculadosInflightPromise = (async () => {
    try {
      const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      };
      if (typeof N8N_PROXY_TOKEN === 'string' && N8N_PROXY_TOKEN) {
        headers['X-Movfit-Proxy'] = N8N_PROXY_TOKEN;
      }
      const resp = await fetch(N8N_MATRICULADOS_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });
      if (!resp.ok) {
        console.error('[MATRICULADOS] Webhook HTTP', resp.status);
        return null;
      }
      const text = await resp.text();
      if (!text || !text.trim()) {
        console.warn('[MATRICULADOS] Resposta vazia');
        return null;
      }
      const raw = JSON.parse(text);
      const data = matriculadosNormalizarResposta(raw);
      if (!data?.sucesso || !Array.isArray(data.unidades)) {
        console.warn('[MATRICULADOS] Resposta inválida');
        return null;
      }
      _matriculadosCache.data = data;
      _matriculadosCache.at = Date.now();
      return data;
    } catch (e) {
      console.error('[MATRICULADOS] Erro:', e.message);
      return null;
    } finally {
      window._matriculadosInflightPromise = null;
    }
  })();

  return window._matriculadosInflightPromise;
}

function matriculadosGetTotal(unidId, data) {
  const src = data || _matriculadosCache.data;
  if (!src || !unidId) return null;
  const unidade = matriculadosEncontrarUnidade(src, unidId);
  if (!unidade) return 0;
  const n = matriculadosLista(unidade).length;
  return n;
}

function matriculadosTblCol(titulo, linhas) {
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

function matriculadosFiltrarLista(lista, filtro) {
  if (!filtro) return lista || [];
  const q = filtro.toLowerCase();
  return (lista || []).filter(m =>
    (m.nome_aluno || '').toLowerCase().includes(q) ||
    (m.matricula || '').includes(q) ||
    (m.plano || '').toLowerCase().includes(q)
  );
}

function matriculadosRenderPaginador(total, pagina) {
  const totalPag = Math.max(1, Math.ceil(total / MATRICULADOS_PAGE_SIZE));
  const pag = Math.min(Math.max(1, pagina || 1), totalPag);
  const inicio = total === 0 ? 0 : (pag - 1) * MATRICULADOS_PAGE_SIZE + 1;
  const fim = Math.min(pag * MATRICULADOS_PAGE_SIZE, total);
  return `<div class="janela-pag">
    <span class="janela-pag-info">Mostrando ${inicio.toLocaleString('pt-BR')}–${fim.toLocaleString('pt-BR')} de ${total.toLocaleString('pt-BR')}</span>
    <div class="janela-pag-btns">
      <button type="button" class="janela-pag-btn" onclick="matriculadosIrPagina(this,-1)" ${pag <= 1 ? 'disabled' : ''}>← Anterior</button>
      <span class="janela-pag-num">Página ${pag} de ${totalPag}</span>
      <button type="button" class="janela-pag-btn" onclick="matriculadosIrPagina(this,1)" ${pag >= totalPag ? 'disabled' : ''}>Próxima →</button>
    </div>
  </div>`;
}

function matriculadosPillStatus(txt, tipo) {
  const map = {
    ok: { cor: '#34c47c', bg: 'rgba(52,196,124,.1)' },
    warn: { cor: '#f5a623', bg: 'rgba(245,166,35,.1)' },
    alert: { cor: '#f05c5c', bg: 'rgba(240,92,92,.1)' },
    muted: { cor: 'var(--muted)', bg: 'transparent' },
  };
  const st = map[tipo] || map.muted;
  const label = txt || '—';
  return `<span class="pill" style="background:${st.bg};color:${st.cor};border:1px solid ${st.cor}33;">${typeof esc === 'function' ? esc(label) : label}</span>`;
}

function matriculadosRenderTabela(lista, filtro, pagina) {
  const filtrada = matriculadosFiltrarLista(lista, filtro);
  if (!filtrada.length) {
    return `<div class="janela-empty">Nenhum matriculado nesta competência.</div>`;
  }
  const totalPag = Math.max(1, Math.ceil(filtrada.length / MATRICULADOS_PAGE_SIZE));
  const pag = Math.min(Math.max(1, pagina || 1), totalPag);
  const slice = filtrada.slice((pag - 1) * MATRICULADOS_PAGE_SIZE, pag * MATRICULADOS_PAGE_SIZE);

  return `<div class="tw janela-tw"><table>
    <thead><tr>
      <th>Aluno</th>
      <th>Matrícula</th>
      <th>Plano</th>
      <th>Data matrícula</th>
      <th>Situação</th>
      <th>Treino</th>
      <th>Contato</th>
    </tr></thead>
    <tbody>${slice.map(m => {
      const nome = typeof esc === 'function' ? esc(m.nome_aluno || '—') : (m.nome_aluno || '—');
      const mat = typeof esc === 'function' ? esc(m.matricula || '—') : (m.matricula || '—');
      const plano = typeof esc === 'function' ? esc(m.plano || '—') : (m.plano || '—');
      const sit = m.situacao_cliente_descricao || m.situacao_cliente || '—';
      const treino = m.treino_status || '—';
      const contato = m.precisa_contato
        ? (m.motivo_contato || 'Sim')
        : '—';
      const sitTipo = /ativo|normal|em dia/i.test(String(sit)) ? 'ok'
        : /tranc|susp/i.test(String(sit)) ? 'warn' : 'muted';
      const treinoTipo = /ok|em dia|ativo/i.test(String(treino)) ? 'ok'
        : /sem|pend/i.test(String(treino)) ? 'warn' : 'muted';
      const contatoTipo = m.precisa_contato ? 'alert' : 'muted';
      return `<tr>
        <td style="font-weight:500;">${nome}</td>
        <td style="font-family:'DM Mono',monospace;font-size:11px;">${mat}</td>
        <td style="max-width:160px;white-space:normal;font-size:11px;">${plano}</td>
        <td style="font-family:'DM Mono',monospace;font-size:11px;">${matriculadosFmtDataCurta(m.data_lancamento)}</td>
        <td>${matriculadosPillStatus(sit, sitTipo)}</td>
        <td>${matriculadosPillStatus(treino, treinoTipo)}</td>
        <td style="font-size:11px;color:${m.precisa_contato ? '#f05c5c' : 'var(--muted)'};">${typeof esc === 'function' ? esc(contato) : contato}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>${matriculadosRenderPaginador(filtrada.length, pag)}`;
}

function matriculadosAtualizarTabela(root, resetPage) {
  if (resetPage) root.dataset.pagina = '1';
  const lista = JSON.parse(root.dataset.matriculados || '[]');
  const filtro = (root.querySelector('.matric-busca')?.value || '').trim();
  const totalPag = Math.max(1, Math.ceil(matriculadosFiltrarLista(lista, filtro).length / MATRICULADOS_PAGE_SIZE));
  let pagina = parseInt(root.dataset.pagina || '1', 10);
  pagina = Math.min(Math.max(1, pagina), totalPag);
  root.dataset.pagina = String(pagina);
  const wrap = root.querySelector('.matric-alunos-wrap');
  if (wrap) wrap.innerHTML = matriculadosRenderTabela(lista, filtro, pagina);
}

function matriculadosFiltrarBusca(input) {
  const root = input.closest('.matric-card');
  if (root) matriculadosAtualizarTabela(root, true);
}

function matriculadosIrPagina(btn, delta) {
  const root = btn.closest('.matric-card');
  if (!root) return;
  const lista = JSON.parse(root.dataset.matriculados || '[]');
  const filtro = (root.querySelector('.matric-busca')?.value || '').trim();
  const filtrada = matriculadosFiltrarLista(lista, filtro);
  const totalPag = Math.max(1, Math.ceil(filtrada.length / MATRICULADOS_PAGE_SIZE));
  let pagina = parseInt(root.dataset.pagina || '1', 10) + delta;
  root.dataset.pagina = String(Math.min(Math.max(1, pagina), totalPag));
  matriculadosAtualizarTabela(root);
}

function matriculadosRenderConteudo(data, unidade, unidId, opts) {
  const o = opts || {};
  const lista = o.lista || matriculadosLista(unidade);
  const resumo = data.resumo_geral || {};
  const competencia = data.competencia || lista[0]?.competencia_coleta || '—';
  const competenciaSel = o.competenciaSel || '__live__';
  const fonte = o.fonte || 'live';
  const historico = o.historico || [];
  const comTreino = lista.filter(m => /ok|em dia|ativo/i.test(String(m.treino_status || ''))).length;
  const precisaContato = lista.filter(m => m.precisa_contato).length;
  const nomeUnidade = (typeof UNIDADES !== 'undefined'
    ? UNIDADES.find(u => u.id === unidId)?.nome
    : null) || unidade?.unidade_nome || unidId;
  const fonteLabel = fonte === 'historico' ? 'Histórico salvo' : 'Dados ao vivo';
  const mesesSalvos = historico.length;

  const indicador = matriculadosTblCol('Indicador', [
    ['Matriculados no mês', lista.length],
    ['Competência', matriculadosFmtCompetencia(competencia)],
    ['Com treino OK', comTreino, '#34c47c'],
    ['Precisam contato', precisaContato, precisaContato ? '#f05c5c' : 'var(--muted)'],
  ]);

  const distribuicao = matriculadosTblCol('Distribuição', [
    ['Total na unidade', `${lista.length} (100%)`],
    ['Treino OK', lista.length ? `${comTreino} (${Math.round(comTreino / lista.length * 100)}%)` : '0', '#34c47c'],
    ['Precisa contato', lista.length ? `${precisaContato} (${Math.round(precisaContato / lista.length * 100)}%)` : '0', '#f05c5c'],
    ['Rede (todas unidades)', resumo.total_alunos_unicos ?? '—', '#378add'],
  ]);

  const sinc = matriculadosTblCol('Sincronização', [
    ['Fonte', fonteLabel],
    ['Competência', competencia],
    ['Histórico (meses)', mesesSalvos],
    ['Gerado em', data.gerado_em ? matriculadosFmtData(data.gerado_em) : (o.sincronizado_em ? matriculadosFmtData(o.sincronizado_em) : '—')],
    ['Atualizado em', resumo.ultima_atualizacao ? matriculadosFmtData(resumo.ultima_atualizacao) : (o.sincronizado_em ? matriculadosFmtData(o.sincronizado_em) : '—')],
  ]);

  const jsonLista = JSON.stringify(lista).replace(/'/g, '&#39;');
  const aoVivoComp = o.competenciaAoVivo || data.competencia;

  return `<div class="matric-card janela-card" data-pagina="1" data-unid-id="${unidId}" data-competencia-sel="${competenciaSel}" data-matriculados='${jsonLista}'>
    <div class="janela-card-head">
      <div>
        <div class="janela-title">Matriculados no mês — ${typeof esc === 'function' ? esc(nomeUnidade) : nomeUnidade}</div>
        <div class="janela-sub">${matriculadosFmtCompetencia(competencia)} · ${fonteLabel}${fonte === 'historico' ? ' · consulta ao histórico interno' : ''}${data.gerado_em && fonte === 'live' ? ' · Atualizado ' + matriculadosFmtData(data.gerado_em) : ''}</div>
      </div>
      <button type="button" class="janela-refresh" onclick="renderMatriculadosMes('${unidId}', true)" title="Atualizar ao vivo">↻ Atualizar</button>
    </div>
    <div class="janela-tables">${indicador}${distribuicao}${sinc}</div>
    <div class="janela-alunos-sec">
      <div class="sec" style="margin-bottom:8px;">Alunos matriculados</div>
      <div class="janela-toolbar">
        <div class="janela-tabs">${matriculadosRenderSelectCompetencias(unidId, historico, aoVivoComp, competenciaSel)}</div>
        <div class="janela-filtros">
          <input type="search" class="janela-busca matric-busca" placeholder="Buscar aluno, matrícula ou plano…" oninput="matriculadosFiltrarBusca(this)">
        </div>
      </div>
      <div class="matric-alunos-wrap">${matriculadosRenderTabela(lista, '', 1)}</div>
    </div>
  </div>`;
}

async function matriculadosTrocarCompetencia(select, unidId) {
  const val = select.value;
  const card = select.closest('.matric-card');
  if (card) card.dataset.competenciaSel = val;

  if (val === '__live__') {
    await renderMatriculadosMes(unidId, false);
    return;
  }

  const el = document.getElementById('dashMatriculadosMes');
  if (!el) return;

  el.innerHTML = `<div class="janela-card janela-loading">
    <div class="janela-title">Matriculados no mês</div>
    <div class="janela-sub">Carregando histórico ${matriculadosFmtCompetencia(val)}…</div>
  </div>`;

  const [histDoc, historico] = await Promise.all([
    matriculadosCarregarCompetencia(unidId, val),
    matriculadosListarCompetencias(unidId),
  ]);

  if (!histDoc) {
    el.innerHTML = `<div class="janela-card janela-erro">
      <div class="janela-title">Matriculados no mês</div>
      <div class="janela-sub">Nenhum histórico encontrado para ${matriculadosFmtCompetencia(val)}.</div>
      <button type="button" class="btn primary" style="margin-top:12px;" onclick="renderMatriculadosMes('${unidId}', false)">Voltar ao mês atual</button>
    </div>`;
    return;
  }

  const lista = histDoc.matriculados || [];
  const unidade = {
    unidade_codigo: histDoc.unidade_codigo,
    unidade_nome: histDoc.unidade_nome,
    matriculados: lista,
  };
  const data = {
    competencia: val,
    gerado_em: histDoc.gerado_em || histDoc.sincronizado_em,
    resumo_geral: { total_alunos_unicos: lista.length },
  };

  el.innerHTML = matriculadosRenderConteudo(data, unidade, unidId, {
    lista,
    fonte: 'historico',
    competenciaSel: val,
    historico,
    sincronizado_em: histDoc.sincronizado_em,
    competenciaAoVivo: _matriculadosCache.data?.competencia || val,
  });
}

function matriculadosAtualizarMetrica(unidId, data) {
  const card = document.getElementById('dashMetricMatriculados');
  if (!card) return;
  const total = matriculadosGetTotal(unidId, data);
  if (total == null) return;
  const mv = card.querySelector('.mv');
  const ml = card.querySelector('.ml');
  if (mv) mv.textContent = total.toLocaleString('pt-BR');
  if (ml) ml.textContent = 'Matriculados no mês';
  let live = card.querySelector('.md-live');
  while (mv && mv.nextElementSibling && mv.nextElementSibling !== live) {
    mv.nextElementSibling.remove();
  }
  if (!live) {
    live = document.createElement('div');
    live.className = 'md-live';
    live.style.cssText = 'font-size:11px;font-weight:600;color:var(--muted);margin-top:4px;';
    card.appendChild(live);
  }
  const comp = data?.competencia;
  live.textContent = comp ? matriculadosFmtCompetencia(comp) : 'Ao vivo';
}

async function renderMatriculadosMes(unidId, forceRefresh) {
  const el = document.getElementById('dashMatriculadosMes');
  if (!el) return;

  if (!unidId) {
    el.innerHTML = '';
    return;
  }

  if (forceRefresh) {
    _matriculadosCache.data = null;
    _matriculadosCache.at = 0;
  }

  el.innerHTML = `<div class="janela-card janela-loading">
    <div class="janela-title">Matriculados no mês</div>
    <div class="janela-sub">Carregando dados…</div>
  </div>`;

  const [data, historico] = await Promise.all([
    matriculadosBuscarDados(forceRefresh),
    matriculadosListarCompetencias(unidId),
  ]);

  if (data) {
    matriculadosPersistir(data).catch(e => console.warn('[MATRICULADOS] Persistência:', e.message));
  }

  if (!data) {
    el.innerHTML = `<div class="janela-card janela-erro">
      <div class="janela-title">Matriculados no mês</div>
      <div class="janela-sub">Não foi possível carregar os dados. Verifique o webhook ou tente novamente.</div>
      <button type="button" class="btn primary" style="margin-top:12px;" onclick="renderMatriculadosMes('${unidId}', true)">Tentar novamente</button>
    </div>`;
    return;
  }

  const unidade = matriculadosEncontrarUnidade(data, unidId);
  const lista = matriculadosLista(unidade);

  if (!unidade) {
    el.innerHTML = `<div class="janela-card">
      <div class="janela-card-head">
        <div>
          <div class="janela-title">Matriculados no mês — ${typeof UNIDADES !== 'undefined' ? (UNIDADES.find(u => u.id === unidId)?.nome || unidId) : unidId}</div>
          <div class="janela-sub">Sem matriculados registrados para esta unidade na competência ${matriculadosFmtCompetencia(data.competencia)}.</div>
        </div>
      </div>
      <div class="janela-empty">Nenhum aluno matriculado nesta unidade no mês.</div>
    </div>`;
    matriculadosAtualizarMetrica(unidId, data);
    return;
  }

  const historicoAtualizado = historico.length ? historico : await matriculadosListarCompetencias(unidId);
  el.innerHTML = matriculadosRenderConteudo(data, unidade, unidId, {
    fonte: 'live',
    competenciaSel: '__live__',
    historico: historicoAtualizado,
    competenciaAoVivo: data.competencia,
  });
  matriculadosAtualizarMetrica(unidId, data);
}
