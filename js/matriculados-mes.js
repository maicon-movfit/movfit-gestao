// ════════════════════════════════════════════════════════════════════════
// MATRICULADOS NO MÊS — webhook n8n
// Config: js/n8n-config.js
// ════════════════════════════════════════════════════════════════════════

const _matriculadosCache = { data: null, at: 0 };
const _avaliacoesAtrasadasCache = { data: null, at: 0 };
const _avaliacoesRealizadasCache = { data: null, at: 0 };
const MATRICULADOS_CACHE_TTL_MS = 3 * 60 * 1000;
const AVALIACOES_CACHE_TTL_MS = 3 * 60 * 1000;
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

/** Chave única para cruzamento entre webhooks (ignora zeros à esquerda). */
function matriculadosNormalizarMatricula(mat) {
  if (mat == null || mat === '') return '';
  const s = String(mat).trim();
  const semZeros = s.replace(/^0+/, '');
  return semZeros || '0';
}

/** Mapa matrícula → aluno; em duplicata mantém o registro mais recente. */
function matriculadosMontarMapaAlunos(alunos) {
  const map = new Map();
  (alunos || []).forEach(a => {
    const k = matriculadosNormalizarMatricula(a.matricula);
    if (!k) return;
    const prev = map.get(k);
    if (!prev) {
      map.set(k, a);
      return;
    }
    const dtA = new Date(a.atualizado_em || a.coletado_em || 0).getTime();
    const dtB = new Date(prev.atualizado_em || prev.coletado_em || 0).getTime();
    if (dtA >= dtB) map.set(k, a);
  });
  return map;
}

function avaliacoesNormalizarResposta(raw) {
  if (!raw) return null;
  if (raw.unidades) return raw;
  const item = raw.dados?.[0];
  if (item?.unidades) return item;
  return null;
}

async function avaliacoesBuscarWebhook(url, cache, tag, forceRefresh) {
  if (!url) return null;
  if (!forceRefresh && cache.data &&
    (Date.now() - cache.at) < AVALIACOES_CACHE_TTL_MS) {
    return cache.data;
  }
  const inflightKey = '_avInflight_' + tag;
  if (window[inflightKey]) return window[inflightKey];

  window[inflightKey] = (async () => {
    try {
      const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      };
      if (typeof N8N_PROXY_TOKEN === 'string' && N8N_PROXY_TOKEN) {
        headers['X-Movfit-Proxy'] = N8N_PROXY_TOKEN;
      }
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });
      if (!resp.ok) {
        console.warn(`[AVALIACOES ${tag}] Webhook HTTP`, resp.status);
        return null;
      }
      const raw = await resp.json();
      const data = avaliacoesNormalizarResposta(raw);
      if (!data?.unidades) {
        console.warn(`[AVALIACOES ${tag}] Resposta inválida`);
        return null;
      }
      cache.data = data;
      cache.at = Date.now();
      return data;
    } catch (e) {
      console.warn(`[AVALIACOES ${tag}] Erro:`, e.message);
      return null;
    } finally {
      window[inflightKey] = null;
    }
  })();

  return window[inflightKey];
}

async function avaliacoesBuscarAtrasadas(forceRefresh) {
  if (typeof N8N_AVALIACOES_ATRASADAS_URL === 'undefined' || !N8N_AVALIACOES_ATRASADAS_URL) {
    return null;
  }
  return avaliacoesBuscarWebhook(
    N8N_AVALIACOES_ATRASADAS_URL,
    _avaliacoesAtrasadasCache,
    'atrasadas',
    forceRefresh
  );
}

async function avaliacoesBuscarRealizadas(forceRefresh) {
  if (typeof N8N_AVALIACOES_REALIZADAS_URL === 'undefined' || !N8N_AVALIACOES_REALIZADAS_URL) {
    return null;
  }
  return avaliacoesBuscarWebhook(
    N8N_AVALIACOES_REALIZADAS_URL,
    _avaliacoesRealizadasCache,
    'realizadas',
    forceRefresh
  );
}

async function avaliacoesBuscarCruzamentoDados(forceRefresh) {
  const [atrasadas, realizadas] = await Promise.all([
    avaliacoesBuscarAtrasadas(forceRefresh).catch(() => null),
    avaliacoesBuscarRealizadas(forceRefresh).catch(() => null),
  ]);
  return { atrasadas, realizadas };
}

function matriculadosMontarMapaAvaliacoes(dataAvaliacoes, unidId, tipo) {
  if (!dataAvaliacoes?.[tipo]) return new Map();
  const u = matriculadosEncontrarUnidade(dataAvaliacoes[tipo], unidId);
  return matriculadosMontarMapaAlunos(u?.alunos || []);
}

function matriculadosMontarMapasCruzamento(unidId, dataJanela, dataAtivos, dataAvaliacoes) {
  let janelaMap = new Map();
  if (dataJanela && typeof janelaEncontrarUnidade === 'function') {
    const u = janelaEncontrarUnidade(dataJanela, unidId);
    const alunos = typeof janelaMontarAlunosTodos === 'function'
      ? janelaMontarAlunosTodos(u || {})
      : [];
    janelaMap = matriculadosMontarMapaAlunos(alunos);
  }

  let ativosMap = new Map();
  if (dataAtivos && typeof totalAtivosEncontrarUnidade === 'function') {
    const u = totalAtivosEncontrarUnidade(dataAtivos, unidId);
    ativosMap = matriculadosMontarMapaAlunos(u?.alunos || []);
  }

  const avaliacoesAtrasadasMap = matriculadosMontarMapaAvaliacoes(dataAvaliacoes, unidId, 'atrasadas');
  const avaliacoesRealizadasMap = matriculadosMontarMapaAvaliacoes(dataAvaliacoes, unidId, 'realizadas');

  return {
    janela: janelaMap,
    ativos: ativosMap,
    avaliacoesAtrasadas: avaliacoesAtrasadasMap,
    avaliacoesRealizadas: avaliacoesRealizadasMap,
  };
}

function matriculadosMapasPorUnidade(dataJanela, dataAtivos, dataAvaliacoes) {
  const out = {};
  Object.keys(MATRICULADOS_UNIDADE_MAP).forEach(uid => {
    out[uid] = matriculadosMontarMapasCruzamento(uid, dataJanela, dataAtivos, dataAvaliacoes);
  });
  return out;
}

async function matriculadosBuscarCruzamentos(unidId, forceRefresh) {
  const [dataJanela, dataAtivos, dataAvaliacoes] = await Promise.all([
    typeof janelaBuscarDados === 'function'
      ? janelaBuscarDados().catch(() => null)
      : Promise.resolve(null),
    typeof totalAtivosBuscarDados === 'function'
      ? totalAtivosBuscarDados(forceRefresh).catch(() => null)
      : Promise.resolve(null),
    avaliacoesBuscarCruzamentoDados(forceRefresh).catch(() => null),
  ]);
  if (unidId) {
    return matriculadosMontarMapasCruzamento(unidId, dataJanela, dataAtivos, dataAvaliacoes);
  }
  return matriculadosMapasPorUnidade(dataJanela, dataAtivos, dataAvaliacoes);
}

function matriculadosTreinoLabel(statusTreino, fallback) {
  if (statusTreino && typeof JANELA_STATUS !== 'undefined') {
    return JANELA_STATUS[statusTreino]?.label || statusTreino;
  }
  const fb = String(fallback || '');
  if (fb && !/nao_verificado/i.test(fb)) return fb;
  return null;
}

/** Interpreta avaliacao_status do webhook de matriculados. */
function matriculadosParseAvaliacao(status) {
  const s = String(status || '').trim().toLowerCase();
  if (!s) return { feita: null, label: '—', tipo: 'muted' };
  if (/realiz|feita|conclu|ok|em_dia|ativa/.test(s) && !/nao|sem|pend|não/.test(s)) {
    return { feita: true, label: 'Sim', tipo: 'ok' };
  }
  if (/vencid/.test(s)) {
    return { feita: true, label: 'Vencida', tipo: 'warn' };
  }
  if (/nao_verificad|não_verificad/.test(s)) {
    return { feita: null, label: 'Não verificado', tipo: 'muted' };
  }
  if (/pend|sem|nao_realiz|não_realiz|nao_feita|não_feita/.test(s)) {
    return { feita: false, label: 'Pendente', tipo: 'warn' };
  }
  return { feita: null, label: status, tipo: 'muted' };
}

/**
 * Avaliação via webhooks avaliacoes_atrasadas + avaliacoes_realizadas.
 * Prioridade: atrasada > realizada > sem avaliação > fallback matriculados.
 */
function matriculadosResolverAvaliacao(m, avAtrasada, avRealizada, ctx) {
  const temAtrasadas = ctx?.temListaAtrasadas || false;
  const temRealizadas = ctx?.temListaRealizadas || false;
  const proxima = (av) => av?.data_proxima || av?.data_proxima_avaliacao || null;

  if (avAtrasada) {
    return {
      avaliacao_atrasada: true,
      avaliacao_realizada: false,
      avaliacao_label: 'Atrasada',
      avaliacao_tipo: 'alert',
      data_avaliacao: avAtrasada.data_avaliacao || null,
      data_proxima_avaliacao: proxima(avAtrasada),
      nome_avaliador: avAtrasada.nome_avaliador || null,
    };
  }
  if (avRealizada) {
    return {
      avaliacao_atrasada: false,
      avaliacao_realizada: true,
      avaliacao_label: 'Realizada',
      avaliacao_tipo: 'ok',
      data_avaliacao: avRealizada.data_avaliacao || null,
      data_proxima_avaliacao: proxima(avRealizada),
      nome_avaliador: avRealizada.nome_avaliador || null,
    };
  }
  if (temRealizadas || temAtrasadas) {
    if (temRealizadas) {
      return {
        avaliacao_atrasada: false,
        avaliacao_realizada: false,
        avaliacao_label: 'Sem avaliação',
        avaliacao_tipo: 'warn',
        data_avaliacao: null,
        data_proxima_avaliacao: null,
        nome_avaliador: null,
      };
    }
    return {
      avaliacao_atrasada: false,
      avaliacao_realizada: null,
      avaliacao_label: 'Não atrasada',
      avaliacao_tipo: 'ok',
      data_avaliacao: null,
      data_proxima_avaliacao: null,
      nome_avaliador: null,
    };
  }
  const aval = matriculadosParseAvaliacao(m.avaliacao_status);
  return {
    avaliacao_atrasada: null,
    avaliacao_realizada: null,
    avaliacao_label: aval.label,
    avaliacao_tipo: aval.tipo,
    data_avaliacao: null,
    data_proxima_avaliacao: null,
    nome_avaliador: null,
  };
}

/** Aluno com treino montado — somente via Janela de Treino (fonte confiável). */
function matriculadosTemTreinoMontado(j, statusTreino) {
  if (!j) return false;
  if (statusTreino && statusTreino !== 'SEM_TREINO') return true;
  return !!(j.nome_programa && j.codigo_programa);
}

function matriculadosValidacaoIssues(m) {
  const issues = [];
  const sit = String(m.situacao_cliente_descricao || m.situacao_cliente || '');
  const ativo = /ativo/i.test(sit);

  if (!m._cruzamento?.janela) {
    issues.push('Sem registro na Janela de Treino');
  }
  if (m._cruzamento?.janela && m._cruzamento?.ativos === false && m._cruzamento?.temListaAtivos) {
    issues.push('Na janela, mas não consta em ativos');
  }
  if (ativo && m.avaliacao_atrasada === true) {
    issues.push('Avaliação física atrasada');
  }
  if (ativo && m.status_treino === 'VENCIDO') {
    issues.push('Contrato ativo com treino vencido');
  }
  if (ativo && m._cruzamento?.janela && !m.com_treino) {
    issues.push(m.status_treino === 'SEM_TREINO'
      ? 'Contrato ativo sem treino na janela'
      : 'Ativo sem treino montado');
  }
  if (m.precisa_contato && m.status_treino === 'EM_DIA') {
    issues.push('Marcado para contato, mas treino em dia');
  }
  return issues;
}

function matriculadosEnriquecerAluno(m, mapas) {
  const key = matriculadosNormalizarMatricula(m.matricula);
  const j = mapas?.janela?.get(key) || null;
  const a = mapas?.ativos?.get(key) || null;
  const avAtrasada = mapas?.avaliacoesAtrasadas?.get(key) || null;
  const avRealizada = mapas?.avaliacoesRealizadas?.get(key) || null;
  const temListaAtrasadas = (mapas?.avaliacoesAtrasadas?.size || 0) > 0;
  const temListaRealizadas = (mapas?.avaliacoesRealizadas?.size || 0) > 0;
  const statusTreino = j?.status_treino || null;
  const treinoLabel = matriculadosTreinoLabel(statusTreino, m.treino_status)
    || (j ? 'Sem status' : 'Não encontrado');
  const aval = matriculadosResolverAvaliacao(m, avAtrasada, avRealizada, {
    temListaAtrasadas,
    temListaRealizadas,
  });
  const comTreino = matriculadosTemTreinoMontado(j, statusTreino);

  return {
    ...m,
    treino_status: treinoLabel,
    status_treino: statusTreino,
    ...aval,
    com_treino: comTreino,
    treino_valido_ate: j?.treino_valido_ate || m.treino_valido_ate || null,
    ultimo_acesso: j?.ultimo_acesso || m.ultimo_acesso || null,
    nome_professor: j?.nome_professor || m.nome_professor || null,
    nome_programa: j?.nome_programa || m.nome_programa || null,
    _cruzamento: {
      janela: !!j,
      ativos: !!a,
      avaliacaoAtrasada: !!avAtrasada,
      avaliacaoRealizada: !!avRealizada,
      temListaAtivos: (mapas?.ativos?.size || 0) > 0,
      temListaAtrasadas,
      temListaRealizadas,
    },
  };
}

function matriculadosEnriquecerLista(lista, mapas) {
  if (!lista?.length) return lista || [];
  if (!mapas) return lista;
  return lista.map(m => matriculadosEnriquecerAluno(m, mapas));
}

function matriculadosEnriquecerPayload(data, mapasPorUnid) {
  if (!data?.unidades) return data;
  return {
    ...data,
    unidades: data.unidades.map(u => {
      const unidId = matriculadosUnidIdPorCodigo(u.unidade_codigo, u.unidade_nome);
      const mapas = unidId ? mapasPorUnid[unidId] : null;
      const lista = matriculadosEnriquecerLista(matriculadosLista(u), mapas);
      return { ...u, matriculados: lista };
    }),
  };
}

function matriculadosResumoCruzamento(lista) {
  const total = lista.length;
  const naJanela = lista.filter(m => m._cruzamento?.janela).length;
  const emAtivos = lista.filter(m => m._cruzamento?.ativos).length;
  const temListaAtivos = lista.some(m => m._cruzamento?.temListaAtivos);
  const comTreinoMontado = lista.filter(m => m.com_treino).length;
  const avaliacaoAtrasada = lista.filter(m => m.avaliacao_atrasada === true).length;
  const avaliacaoRealizada = lista.filter(m => m.avaliacao_realizada === true).length;
  const avaliacaoSemRegistro = lista.filter(m =>
    m.avaliacao_atrasada === false && m.avaliacao_realizada === false
  ).length;
  const comTreino = lista.filter(m =>
    m.status_treino === 'EM_DIA' || /em dia/i.test(String(m.treino_status || ''))
  ).length;
  const alertas = lista.filter(m => matriculadosValidacaoIssues(m).length > 0).length;
  return {
    total, naJanela, emAtivos, temListaAtivos,
    comTreino, comTreinoMontado,
    avaliacaoAtrasada, avaliacaoRealizada, avaliacaoSemRegistro, alertas,
  };
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

function matriculadosStatusAbaId(m) {
  if (!m._cruzamento?.janela) return 'sem_janela';
  const st = m.status_treino;
  if (st === 'EM_DIA') return 'em_dia';
  if (st === 'A_VENCER') return 'a_vencer';
  if (st === 'VENCIDO') return 'vencidos';
  if (st === 'SEM_TREINO') return 'sem_treino';
  return 'outros';
}

function matriculadosContarAbas(lista) {
  const c = {
    todos: (lista || []).length,
    em_dia: 0,
    a_vencer: 0,
    vencidos: 0,
    sem_treino: 0,
    sem_janela: 0,
  };
  (lista || []).forEach(m => {
    const id = matriculadosStatusAbaId(m);
    if (id in c) c[id]++;
  });
  return c;
}

function matriculadosFiltrarLista(lista, filtro, statusAba, validacao, situacao, jornada) {
  let out = lista || [];
  const aba = statusAba || 'todos';
  if (aba !== 'todos') {
    out = out.filter(m => matriculadosStatusAbaId(m) === aba);
  }
  const val = validacao || 'todos';
  if (val !== 'todos') {
    out = out.filter(m => {
      const issues = matriculadosValidacaoIssues(m);
      if (val === 'ok') return !issues.length;
      if (val === 'sem_janela') return !m._cruzamento?.janela;
      if (val === 'alertas') return issues.length > 0 && !!m._cruzamento?.janela;
      if (val === 'contato') return !!m.precisa_contato;
      return true;
    });
  }
  const sitF = situacao || 'todos';
  if (sitF !== 'todos') {
    out = out.filter(m => {
      const sit = String(m.situacao_cliente_descricao || m.situacao_cliente || '').toLowerCase();
      if (sitF === 'ativo') return /ativo/.test(sit);
      if (sitF === 'trancado') return /tranc/.test(sit);
      if (sitF === 'suspenso') return /susp/.test(sit);
      return sit.includes(sitF);
    });
  }
  const jor = jornada || 'todos';
  if (jor !== 'todos') {
    out = out.filter(m => {
      if (jor === 'avaliacao_atrasada') return m.avaliacao_atrasada === true;
      if (jor === 'avaliacao_realizada') return m.avaliacao_realizada === true;
      if (jor === 'avaliacao_sem') return m.avaliacao_atrasada === false && m.avaliacao_realizada === false;
      if (jor === 'avaliacao_nao_verificada') return m.avaliacao_atrasada == null && m.avaliacao_realizada == null;
      if (jor === 'com_treino') return !!m.com_treino;
      if (jor === 'sem_treino') return !m.com_treino;
      return true;
    });
  }
  if (filtro) {
    const q = filtro.toLowerCase();
    out = out.filter(m =>
      (m.nome_aluno || '').toLowerCase().includes(q) ||
      (m.matricula || '').includes(q) ||
      (m.plano || '').toLowerCase().includes(q)
    );
  }
  return out;
}

function matriculadosRenderTabsStatus(lista, abaAtiva) {
  const c = matriculadosContarAbas(lista);
  const tabs = [
    { id: 'todos', label: 'Todos', n: c.todos },
    { id: 'em_dia', label: 'Em dia', n: c.em_dia, cor: '#34c47c' },
    { id: 'a_vencer', label: 'A vencer', n: c.a_vencer, cor: '#eab308' },
    { id: 'vencidos', label: 'Vencidos', n: c.vencidos, cor: '#f05c5c' },
    { id: 'sem_treino', label: 'Sem treino', n: c.sem_treino, cor: '#f5a623' },
    { id: 'sem_janela', label: 'Sem janela', n: c.sem_janela, cor: '#f5a623' },
  ];
  return tabs.map(t =>
    `<button type="button" class="janela-tab${t.id === abaAtiva ? ' janela-tab-on' : ''}" onclick="matriculadosTrocarAba(this,'${t.id}')">${t.label} <span class="janela-tab-n"${t.cor ? ` style="color:${t.cor}"` : ''}>${t.n}</span></button>`
  ).join('');
}

function matriculadosRenderSelectValidacao(val) {
  const v = val || 'todos';
  const opts = [
    ['todos', 'Validação: todos'],
    ['ok', 'Validação: OK'],
    ['sem_janela', 'Validação: sem janela'],
    ['alertas', 'Validação: com alertas'],
    ['contato', 'Validação: precisa contato'],
  ];
  return `<select class="janela-prof-select matric-valid-select" onchange="matriculadosTrocarFiltro(this)">${opts.map(([id, lbl]) => `<option value="${id}"${id === v ? ' selected' : ''}>${lbl}</option>`).join('')}</select>`;
}

function matriculadosRenderSelectSituacao(val) {
  const v = val || 'todos';
  const opts = [
    ['todos', 'Situação: todas'],
    ['ativo', 'Situação: ativo'],
    ['trancado', 'Situação: trancado'],
    ['suspenso', 'Situação: suspenso'],
  ];
  return `<select class="janela-prof-select matric-sit-select" onchange="matriculadosTrocarFiltro(this)">${opts.map(([id, lbl]) => `<option value="${id}"${id === v ? ' selected' : ''}>${lbl}</option>`).join('')}</select>`;
}

function matriculadosRenderSelectJornada(val) {
  const v = val || 'todos';
  const opts = [
    ['todos', 'Jornada: todos'],
    ['avaliacao_realizada', 'Jornada: avaliação realizada'],
    ['avaliacao_atrasada', 'Jornada: avaliação atrasada'],
    ['avaliacao_sem', 'Jornada: sem avaliação'],
    ['avaliacao_nao_verificada', 'Jornada: avaliação não verificada'],
    ['com_treino', 'Jornada: com treino montado'],
    ['sem_treino', 'Jornada: sem treino montado'],
  ];
  return `<select class="janela-prof-select matric-jornada-select" onchange="matriculadosTrocarFiltro(this)">${opts.map(([id, lbl]) => `<option value="${id}"${id === v ? ' selected' : ''}>${lbl}</option>`).join('')}</select>`;
}

function matriculadosLerFiltros(root) {
  return {
    filtro: (root.querySelector('.matric-busca')?.value || '').trim(),
    statusAba: root.dataset.statusAba || 'todos',
    validacao: root.querySelector('.matric-valid-select')?.value || 'todos',
    situacao: root.querySelector('.matric-sit-select')?.value || 'todos',
    jornada: root.querySelector('.matric-jornada-select')?.value || 'todos',
  };
}

function matriculadosTrocarAba(btn, aba) {
  const root = btn.closest('.matric-card');
  if (!root) return;
  root.dataset.statusAba = aba;
  root.querySelectorAll('.matric-status-tabs .janela-tab').forEach(b => b.classList.remove('janela-tab-on'));
  btn.classList.add('janela-tab-on');
  matriculadosAtualizarTabela(root, true);
}

function matriculadosTrocarFiltro(select) {
  const root = select.closest('.matric-card');
  if (root) matriculadosAtualizarTabela(root, true);
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

function matriculadosRenderTreinoPill(m) {
  if (m.status_treino && typeof JANELA_STATUS !== 'undefined') {
    const st = JANELA_STATUS[m.status_treino] || {
      label: m.treino_status || m.status_treino,
      cor: 'var(--muted)',
      bg: 'transparent',
    };
    return `<span class="pill" style="background:${st.bg};color:${st.cor};border:1px solid ${st.cor}33;">${typeof esc === 'function' ? esc(st.label) : st.label}</span>`;
  }
  const txt = m.treino_status || '—';
  const tipo = /não encontrado|nao encontrado/i.test(txt) ? 'warn'
    : /sem status/i.test(txt) ? 'muted' : 'muted';
  return matriculadosPillStatus(txt, tipo);
}

function matriculadosRenderValidacao(m) {
  const issues = matriculadosValidacaoIssues(m);
  if (!issues.length) return matriculadosPillStatus('OK', 'ok');
  const tip = typeof esc === 'function' ? esc(issues.join(' · ')) : issues.join(' · ');
  if (!m._cruzamento?.janela) {
    return `<span class="pill" style="background:rgba(245,166,35,.1);color:#f5a623;border:1px solid #f5a62333;" title="${tip}">Sem janela</span>`;
  }
  return `<span class="pill" style="background:rgba(240,92,92,.1);color:#f05c5c;border:1px solid #f05c5c33;" title="${tip}">${issues.length} alerta${issues.length > 1 ? 's' : ''}</span>`;
}

function matriculadosTooltipAluno(m) {
  const parts = [];
  if (m.matricula) parts.push(`Matrícula: ${m.matricula}`);
  if (m.avaliacao_label) parts.push(`Avaliação: ${m.avaliacao_label}`);
  if (m.data_avaliacao) parts.push(`Última avaliação: ${matriculadosFmtDataCurta(m.data_avaliacao)}`);
  if (m.data_proxima_avaliacao) parts.push(`Próxima: ${matriculadosFmtDataCurta(m.data_proxima_avaliacao)}`);
  if (m.nome_avaliador) parts.push(`Avaliador: ${m.nome_avaliador}`);
  if (m.com_treino != null) parts.push(`Treino montado: ${m.com_treino ? 'Sim' : 'Não'}`);
  if (m.nome_professor) parts.push(`Professor: ${m.nome_professor}`);
  if (m.nome_programa) parts.push(`Programa: ${m.nome_programa}`);
  if (m.ultimo_acesso) parts.push(`Último acesso: ${matriculadosFmtDataCurta(m.ultimo_acesso)}`);
  return parts.join(' · ') || 'Matrícula não informada';
}

function matriculadosRenderSimNao(val, labelSim, labelNao) {
  if (val === true) return matriculadosPillStatus(labelSim || 'Sim', 'ok');
  if (val === false) return matriculadosPillStatus(labelNao || 'Não', 'warn');
  return matriculadosPillStatus('—', 'muted');
}

function matriculadosRenderAvaliacaoPill(m) {
  if (m.avaliacao_label && m.avaliacao_label !== '—') {
    return matriculadosPillStatus(m.avaliacao_label, m.avaliacao_tipo || 'muted');
  }
  return matriculadosPillStatus('—', 'muted');
}

function matriculadosRenderTabela(lista, filtro, pagina, statusAba, validacao, situacao, jornada) {
  const filtrada = matriculadosFiltrarLista(lista, filtro, statusAba, validacao, situacao, jornada);
  if (!filtrada.length) {
    return `<div class="janela-empty">Nenhum aluno neste filtro.</div>`;
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
      <th>Avaliação física</th>
      <th>Com treino</th>
      <th>Situação treino</th>
      <th>Válido até</th>
      <th>Contato</th>
      <th>Validação</th>
    </tr></thead>
    <tbody>${slice.map(m => {
      const nomeRaw = m.nome_aluno || '—';
      const nome = typeof esc === 'function' ? esc(nomeRaw) : nomeRaw;
      const tip = typeof esc === 'function' ? esc(matriculadosTooltipAluno(m)) : matriculadosTooltipAluno(m);
      const mat = typeof esc === 'function' ? esc(m.matricula || '—') : (m.matricula || '—');
      const plano = typeof esc === 'function' ? esc(m.plano || '—') : (m.plano || '—');
      const sit = m.situacao_cliente_descricao || m.situacao_cliente || '—';
      const contato = m.precisa_contato
        ? (m.motivo_contato || 'Sim')
        : '—';
      const sitTipo = /ativo|normal|em dia/i.test(String(sit)) ? 'ok'
        : /tranc|susp/i.test(String(sit)) ? 'warn' : 'muted';
      return `<tr>
        <td style="font-weight:500;"><span class="janela-nome-aluno" title="${tip}">${nome}</span></td>
        <td style="font-family:'DM Mono',monospace;font-size:11px;">${mat}</td>
        <td style="max-width:160px;white-space:normal;font-size:11px;">${plano}</td>
        <td style="font-family:'DM Mono',monospace;font-size:11px;">${matriculadosFmtDataCurta(m.data_lancamento)}</td>
        <td>${matriculadosPillStatus(sit, sitTipo)}</td>
        <td>${matriculadosRenderAvaliacaoPill(m)}</td>
        <td>${matriculadosRenderSimNao(m.com_treino, 'Sim', 'Não')}</td>
        <td>${matriculadosRenderTreinoPill(m)}</td>
        <td style="font-family:'DM Mono',monospace;font-size:11px;">${matriculadosFmtDataCurta(m.treino_valido_ate)}</td>
        <td style="font-size:11px;color:${m.precisa_contato ? '#f05c5c' : 'var(--muted)'};">${typeof esc === 'function' ? esc(contato) : contato}</td>
        <td>${matriculadosRenderValidacao(m)}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>${matriculadosRenderPaginador(filtrada.length, pag)}`;
}

function matriculadosAtualizarTabela(root, resetPage) {
  if (resetPage) root.dataset.pagina = '1';
  const lista = JSON.parse(root.dataset.matriculados || '[]');
  const { filtro, statusAba, validacao, situacao, jornada } = matriculadosLerFiltros(root);
  const filtrada = matriculadosFiltrarLista(lista, filtro, statusAba, validacao, situacao, jornada);
  const totalPag = Math.max(1, Math.ceil(filtrada.length / MATRICULADOS_PAGE_SIZE));
  let pagina = parseInt(root.dataset.pagina || '1', 10);
  pagina = Math.min(Math.max(1, pagina), totalPag);
  root.dataset.pagina = String(pagina);
  const wrap = root.querySelector('.matric-alunos-wrap');
  if (wrap) wrap.innerHTML = matriculadosRenderTabela(lista, filtro, pagina, statusAba, validacao, situacao, jornada);
}

function matriculadosFiltrarBusca(input) {
  const root = input.closest('.matric-card');
  if (root) matriculadosAtualizarTabela(root, true);
}

function matriculadosIrPagina(btn, delta) {
  const root = btn.closest('.matric-card');
  if (!root) return;
  const lista = JSON.parse(root.dataset.matriculados || '[]');
  const { filtro, statusAba, validacao, situacao, jornada } = matriculadosLerFiltros(root);
  const filtrada = matriculadosFiltrarLista(lista, filtro, statusAba, validacao, situacao, jornada);
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
  const cruz = matriculadosResumoCruzamento(lista);
  const comTreino = cruz.comTreino;
  const precisaContato = lista.filter(m => m.precisa_contato).length;
  const nomeUnidade = (typeof UNIDADES !== 'undefined'
    ? UNIDADES.find(u => u.id === unidId)?.nome
    : null) || unidade?.unidade_nome || unidId;
  const fonteLabel = fonte === 'historico' ? 'Histórico salvo' : 'Dados ao vivo';
  const mesesSalvos = historico.length;

  const indicador = matriculadosTblCol('Indicador', [
    ['Matriculados no mês', lista.length],
    ['Competência', matriculadosFmtCompetencia(competencia)],
    ['Avaliação realizada', lista.length ? `${cruz.avaliacaoRealizada} (${Math.round(cruz.avaliacaoRealizada / lista.length * 100)}%)` : '0', '#34c47c'],
    ['Avaliação atrasada', lista.length ? `${cruz.avaliacaoAtrasada} (${Math.round(cruz.avaliacaoAtrasada / lista.length * 100)}%)` : '0', '#f05c5c'],
  ]);

  const distribuicao = matriculadosTblCol('Jornada', [
    ['Sem avaliação', lista.length ? `${cruz.avaliacaoSemRegistro} (${Math.round(cruz.avaliacaoSemRegistro / lista.length * 100)}%)` : '0', '#f5a623'],
    ['Com treino montado', lista.length ? `${cruz.comTreinoMontado} (${Math.round(cruz.comTreinoMontado / lista.length * 100)}%)` : '0', '#34c47c'],
    ['Na Janela de Treino', lista.length ? `${cruz.naJanela} (${Math.round(cruz.naJanela / lista.length * 100)}%)` : '0', '#378add'],
    ['Precisam contato', precisaContato, precisaContato ? '#f05c5c' : 'var(--muted)'],
  ]);

  const linhasAtivos = cruz.temListaAtivos
    ? [['Em alunos ativos', lista.length ? `${cruz.emAtivos} (${Math.round(cruz.emAtivos / lista.length * 100)}%)` : '0', '#378add']]
    : [];

  const sinc = matriculadosTblCol('Sincronização', [
    ['Fonte', fonteLabel],
    ['Competência', competencia],
    ['Cruzamento', 'Matrícula → Janela + Aval. realizadas/atrasadas'],
    ...linhasAtivos,
    ['Histórico (meses)', mesesSalvos],
    ['Gerado em', data.gerado_em ? matriculadosFmtData(data.gerado_em) : (o.sincronizado_em ? matriculadosFmtData(o.sincronizado_em) : '—')],
    ['Atualizado em', resumo.ultima_atualizacao ? matriculadosFmtData(resumo.ultima_atualizacao) : (o.sincronizado_em ? matriculadosFmtData(o.sincronizado_em) : '—')],
  ]);

  const jsonLista = JSON.stringify(lista).replace(/'/g, '&#39;');
  const aoVivoComp = o.competenciaAoVivo || data.competencia;

  return `<div class="matric-card janela-card" data-pagina="1" data-status-aba="todos" data-unid-id="${unidId}" data-competencia-sel="${competenciaSel}" data-matriculados='${jsonLista}'>
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
      <div class="janela-toolbar matric-toolbar-comp">
        ${matriculadosRenderSelectCompetencias(unidId, historico, aoVivoComp, competenciaSel)}
      </div>
      <div class="janela-toolbar">
        <div class="janela-tabs matric-status-tabs">${matriculadosRenderTabsStatus(lista, 'todos')}</div>
        <div class="janela-filtros">
          ${matriculadosRenderSelectJornada('todos')}
          ${matriculadosRenderSelectValidacao('todos')}
          ${matriculadosRenderSelectSituacao('todos')}
          <input type="search" class="janela-busca matric-busca" placeholder="Buscar aluno, matrícula ou plano…" oninput="matriculadosFiltrarBusca(this)">
        </div>
      </div>
      <div class="matric-alunos-wrap">${matriculadosRenderTabela(lista, '', 1, 'todos', 'todos', 'todos', 'todos')}</div>
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

  const listaRaw = histDoc.matriculados || [];
  const mapas = await matriculadosBuscarCruzamentos(unidId, false);
  const lista = matriculadosEnriquecerLista(listaRaw, mapas);
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
    _avaliacoesAtrasadasCache.data = null;
    _avaliacoesAtrasadasCache.at = 0;
    _avaliacoesRealizadasCache.data = null;
    _avaliacoesRealizadasCache.at = 0;
  }

  el.innerHTML = `<div class="janela-card janela-loading">
    <div class="janela-title">Matriculados no mês</div>
    <div class="janela-sub">Carregando dados…</div>
  </div>`;

  const [data, historico, mapasPorUnid] = await Promise.all([
    matriculadosBuscarDados(forceRefresh),
    matriculadosListarCompetencias(unidId),
    matriculadosBuscarCruzamentos(null, forceRefresh),
  ]);

  const dataEnriquecida = data
    ? matriculadosEnriquecerPayload(data, mapasPorUnid)
    : null;

  if (dataEnriquecida) {
    matriculadosPersistir(dataEnriquecida).catch(e => console.warn('[MATRICULADOS] Persistência:', e.message));
  }

  if (!data) {
    el.innerHTML = `<div class="janela-card janela-erro">
      <div class="janela-title">Matriculados no mês</div>
      <div class="janela-sub">Não foi possível carregar os dados. Verifique o webhook ou tente novamente.</div>
      <button type="button" class="btn primary" style="margin-top:12px;" onclick="renderMatriculadosMes('${unidId}', true)">Tentar novamente</button>
    </div>`;
    return;
  }

  const unidade = matriculadosEncontrarUnidade(dataEnriquecida || data, unidId);
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
    lista,
    fonte: 'live',
    competenciaSel: '__live__',
    historico: historicoAtualizado,
    competenciaAoVivo: data.competencia,
  });
  matriculadosAtualizarMetrica(unidId, data);
}
