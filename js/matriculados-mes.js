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
const MATRICULADOS_TIME_ZONE = 'America/Sao_Paulo';

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

/** Competencia civil corrente no fuso da operacao, sem depender do fuso do navegador. */
function matriculadosCompetenciaAtual() {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: MATRICULADOS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  const ano = partes.find(p => p.type === 'year')?.value;
  const mes = partes.find(p => p.type === 'month')?.value;
  return ano && mes ? `${ano}-${mes}` : new Date().toISOString().slice(0, 7);
}

function matriculadosCompetenciaEncerrada(competencia) {
  return /^\d{4}-\d{2}$/.test(String(competencia || ''))
    && String(competencia) < matriculadosCompetenciaAtual();
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

/**
 * Escopo de controle: somente planos anual recorrente e anual parcelado.
 * Exclui mensal avulso, semanal, quinzenal e demais.
 */
function matriculadosPlanoElegivel(m) {
  const p = String(m.plano || '').toUpperCase().trim();
  if (!p) return false;
  return /ANUAL\s+(RECORRENTE|PARCELADO)/.test(p);
}

function matriculadosFiltrarPlanosElegiveis(lista) {
  return (lista || []).filter(matriculadosPlanoElegivel);
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
      const headers = await n8nAuthHeaders();
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

/**
 * Último acesso da Janela pode ser de contrato anterior.
 * Para matriculados do mês, frequência conta só a partir da data_lancamento.
 */
function matriculadosResolverAcessoMatricula(m, ultimoAcessoBruto) {
  const mat = m.data_lancamento ? new Date(m.data_lancamento) : null;
  const acc = ultimoAcessoBruto ? new Date(ultimoAcessoBruto) : null;
  const matOk = mat && !Number.isNaN(mat.getTime());
  const accOk = acc && !Number.isNaN(acc.getTime());

  if (accOk && matOk && acc >= mat) {
    return {
      ultimo_acesso_bruto: ultimoAcessoBruto,
      ultimo_acesso_efetivo: ultimoAcessoBruto,
      iso_frequencia: ultimoAcessoBruto,
      acesso_anterior_matricula: false,
      sem_visita_desde_matricula: false,
    };
  }
  if (accOk && matOk && acc < mat) {
    return {
      ultimo_acesso_bruto: ultimoAcessoBruto,
      ultimo_acesso_efetivo: null,
      iso_frequencia: m.data_lancamento,
      acesso_anterior_matricula: true,
      sem_visita_desde_matricula: true,
    };
  }
  if (!accOk && matOk) {
    return {
      ultimo_acesso_bruto: null,
      ultimo_acesso_efetivo: null,
      iso_frequencia: m.data_lancamento,
      acesso_anterior_matricula: false,
      sem_visita_desde_matricula: true,
    };
  }
  return {
    ultimo_acesso_bruto: ultimoAcessoBruto || null,
    ultimo_acesso_efetivo: ultimoAcessoBruto || null,
    iso_frequencia: ultimoAcessoBruto || null,
    acesso_anterior_matricula: false,
    sem_visita_desde_matricula: false,
  };
}

function matriculadosFmtDiasMatricula(m) {
  if (typeof janelaFmtDiasSemAcessar !== 'function' || typeof janelaDiasSemAcessar !== 'function') {
    return { txt: '—', cor: 'var(--muted)' };
  }
  const iso = m.iso_frequencia || m.ultimo_acesso;
  if (!iso) return { txt: 'Sem registro', cor: 'var(--muted)' };
  const base = janelaFmtDiasSemAcessar(iso);
  if (m.sem_visita_desde_matricula) {
    const dias = janelaDiasSemAcessar(iso);
    if (dias === 0) return { txt: 'Matriculou hoje', cor: 'var(--muted)' };
    if (dias === 1) return { txt: '1 dia (desde matr.)', cor: base.cor };
    return { txt: `${dias} dias (desde matr.)`, cor: base.cor };
  }
  return base;
}

/** Aluno com treino montado — somente via Janela de Treino (fonte confiável). */
function matriculadosTemTreinoMontado(j, statusTreino) {
  if (!j) return false;
  if (statusTreino && statusTreino !== 'SEM_TREINO') return true;
  return !!(j.nome_programa && j.codigo_programa);
}

function matriculadosValidacaoIssues(m) {
  const issues = [];
  const ativo = matriculadosSituacaoId(m) === 'ativo';

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
  if (m.precisa_contato) {
    issues.push(m.motivo_contato
      ? `Precisa contato: ${m.motivo_contato}`
      : 'Precisa contato');
  }
  return issues;
}

/** Normaliza a situação sem confundir, por exemplo, "ativo" com "inativo". */
function matriculadosSituacaoId(m) {
  const sit = String(m?.situacao_cliente_descricao || m?.situacao_cliente || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  if (!sit) return 'nao_informada';
  if (/\binativ/.test(sit)) return 'inativo';
  if (/\bcancel/.test(sit)) return 'cancelado';
  if (/\bdesist/.test(sit)) return 'desistente';
  if (/\btranc/.test(sit)) return 'trancado';
  if (/\bsusp/.test(sit)) return 'suspenso';
  if (/\bativ/.test(sit)) return 'ativo';
  return 'outra';
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
  const ultimoAcessoBruto = j?.ultimo_acesso || m.ultimo_acesso || null;
  const acesso = matriculadosResolverAcessoMatricula(m, ultimoAcessoBruto);
  const temJanelaFns = typeof janelaBucketId === 'function' && typeof janelaDiasSemAcessar === 'function';
  const isoFreq = acesso.iso_frequencia;

  return {
    ...m,
    treino_status: treinoLabel,
    status_treino: statusTreino,
    ...aval,
    com_treino: comTreino,
    treino_valido_ate: j?.treino_valido_ate || m.treino_valido_ate || null,
    ultimo_acesso: acesso.ultimo_acesso_efetivo || acesso.ultimo_acesso_bruto,
    ultimo_acesso_bruto: acesso.ultimo_acesso_bruto,
    iso_frequencia: isoFreq,
    acesso_anterior_matricula: acesso.acesso_anterior_matricula,
    sem_visita_desde_matricula: acesso.sem_visita_desde_matricula,
    frequencia_id: temJanelaFns && isoFreq ? janelaBucketId(isoFreq) : (temJanelaFns ? 'sem_registro' : null),
    dias_sem_acesso: temJanelaFns && isoFreq ? janelaDiasSemAcessar(isoFreq) : null,
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
  let totalElegivel = 0;
  let totalBruto = 0;
  const unidades = data.unidades.map(u => {
    const unidId = matriculadosUnidIdPorCodigo(u.unidade_codigo, u.unidade_nome);
    const mapas = unidId ? mapasPorUnid[unidId] : null;
    const bruta = matriculadosLista(u);
    const elegiveis = matriculadosFiltrarPlanosElegiveis(bruta);
    const lista = matriculadosEnriquecerLista(elegiveis, mapas);
    totalBruto += bruta.length;
    totalElegivel += lista.length;
    return {
      ...u,
      matriculados: lista,
      matriculados_total_bruto: bruta.length,
      matriculados_excluidos_plano: Math.max(0, bruta.length - lista.length),
    };
  });
  return {
    ...data,
    unidades,
    resumo_geral: {
      ...(data.resumo_geral || {}),
      total_alunos_unicos: totalElegivel,
      total_bruto: totalBruto,
      excluidos_plano: Math.max(0, totalBruto - totalElegivel),
      filtro_planos: 'anual_recorrente_parcelado',
    },
  };
}

/** Matriculado do mês com bio (avaliação física) realizada e treino montado na Janela. */
function matriculadosJornadaCompleta(m) {
  return m.avaliacao_realizada === true && !!m.com_treino;
}

const MATRIC_FREQ_ORDEM = { critico: 0, alerta: 1, acompanhar: 2, normal: 3, sem_registro: 4 };

function matriculadosResumoOnboarding(lista) {
  const n = (lista || []).length;
  const bio = lista.filter(m => m.avaliacao_realizada === true).length;
  const treino = lista.filter(m => m.com_treino).length;
  const completa = lista.filter(m => matriculadosJornadaCompleta(m)).length;
  const pct = (x) => (n ? Math.round(x / n * 100) : 0);
  return { n, bio, treino, completa, pct };
}

function matriculadosBadgeJornada(m) {
  if (matriculadosJornadaCompleta(m)) return matriculadosPillStatus('Completa', 'ok');
  if (m.avaliacao_atrasada === true) return matriculadosPillStatus('Bio atrasada', 'alert');
  if (m.avaliacao_realizada && !m.com_treino) return matriculadosPillStatus('Só bio', 'warn');
  if (!m.avaliacao_realizada && m.com_treino) return matriculadosPillStatus('Só treino', 'warn');
  return matriculadosPillStatus('Pendente', 'muted');
}

function matriculadosRenderFreqPill(m) {
  if (typeof janelaClassificarFrequencia !== 'function') {
    return matriculadosPillStatus('—', 'muted');
  }
  const iso = m.iso_frequencia || m.ultimo_acesso;
  const cls = janelaClassificarFrequencia(iso);
  const tip = m.acesso_anterior_matricula
    ? `${cls.faixa} · Último acesso (${matriculadosFmtDataCurta(m.ultimo_acesso_bruto)}) é anterior à matrícula`
    : m.sem_visita_desde_matricula
      ? `${cls.faixa} · Sem visita registrada desde a matrícula`
      : cls.faixa;
  return `<span class="pill" style="background:${cls.bg};color:${cls.cor};border:1px solid ${cls.cor}33;" title="${tip}">${cls.label}</span>`;
}

function matriculadosOrdenarOnboarding(lista) {
  return matriculadosOrdenarParaRelatorio(lista);
}

function matriculadosOrdenarFrequencia(lista) {
  return matriculadosOrdenarParaRelatorio(lista);
}

/** Ordem de prioridade para relatório e tabelas: crítico → alerta → acompanhar → normal → sem registro. */
function matriculadosOrdenarParaRelatorio(lista) {
  return [...(lista || [])].sort((a, b) => {
    const fa = MATRIC_FREQ_ORDEM[a.frequencia_id] ?? 5;
    const fb = MATRIC_FREQ_ORDEM[b.frequencia_id] ?? 5;
    if (fa !== fb) return fa - fb;
    const da = a.dias_sem_acesso;
    const db = b.dias_sem_acesso;
    if (da === null && db === null) {
      return String(a.nome_aluno || '').localeCompare(String(b.nome_aluno || ''), 'pt-BR');
    }
    if (da === null) return 1;
    if (db === null) return -1;
    if (da !== db) return db - da;
    const ja = matriculadosJornadaCompleta(a) ? 1 : 0;
    const jb = matriculadosJornadaCompleta(b) ? 1 : 0;
    if (ja !== jb) return ja - jb;
    return String(a.nome_aluno || '').localeCompare(String(b.nome_aluno || ''), 'pt-BR');
  });
}

const MATRIC_REL_GRUPOS = [
  { id: 'critico', titulo: 'Crítico — ação imediata', faixa: '31+ dias', cor: '#f05c5c' },
  { id: 'alerta', titulo: 'Alerta — resgatar', faixa: '16–30 dias', cor: '#f5a623' },
  { id: 'acompanhar', titulo: 'Acompanhar', faixa: '7–15 dias', cor: '#378add' },
  { id: 'normal', titulo: 'Normal', faixa: '0–6 dias', cor: '#34c47c' },
  { id: 'sem_registro', titulo: 'Sem registro de acesso', faixa: '—', cor: '#6b7280' },
];

function matriculadosAgruparPorFrequencia(alunos) {
  const map = Object.fromEntries(MATRIC_REL_GRUPOS.map(g => [g.id, []]));
  (alunos || []).forEach(a => {
    const id = a.frequencia_id || 'sem_registro';
    (map[id] || map.sem_registro).push(a);
  });
  return MATRIC_REL_GRUPOS.map(g => ({ ...g, alunos: map[g.id] || [] })).filter(g => g.alunos.length);
}

function matriculadosRenderFunil(lista) {
  const o = matriculadosResumoOnboarding(lista);
  const steps = [
    { id: 'total', label: 'Matriculados', n: o.n, pct: 100, cor: '#378add', filtro: 'todos' },
    { id: 'bio', label: 'Bio feita', n: o.bio, pct: o.pct(o.bio), cor: '#34c47c', filtro: 'avaliacao_realizada' },
    { id: 'treino', label: 'Com treino', n: o.treino, pct: o.pct(o.treino), cor: '#378add', filtro: 'com_treino' },
    { id: 'completa', label: 'Jornada completa', n: o.completa, pct: o.pct(o.completa), cor: '#34c47c', filtro: 'jornada_completa' },
  ];
  return `<div class="matric-funil">
    ${steps.map((s, i) => {
      const arrow = i < steps.length - 1
        ? '<span class="matric-funil-arrow" aria-hidden="true">→</span>' : '';
      return `<button type="button" class="matric-funil-step" onclick="matriculadosClicarFunil(this,'${s.filtro}')" title="Filtrar: ${s.label}">
        <span class="matric-funil-n" style="color:${s.cor}">${s.n.toLocaleString('pt-BR')}</span>
        <span class="matric-funil-lbl">${s.label}</span>
        <span class="matric-funil-pct">${s.pct}%</span>
      </button>${arrow}`;
    }).join('')}
  </div>`;
}

function matriculadosResumoCruzamento(lista) {
  const total = lista.length;
  const naJanela = lista.filter(m => m._cruzamento?.janela).length;
  const emAtivos = lista.filter(m => m._cruzamento?.ativos).length;
  const temListaAtivos = lista.some(m => m._cruzamento?.temListaAtivos);
  const comTreinoMontado = lista.filter(m => m.com_treino).length;
  const avaliacaoAtrasada = lista.filter(m => m.avaliacao_atrasada === true).length;
  const avaliacaoRealizada = lista.filter(m => m.avaliacao_realizada === true).length;
  const jornadaCompleta = lista.filter(m => matriculadosJornadaCompleta(m)).length;
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
    avaliacaoAtrasada, avaliacaoRealizada, avaliacaoSemRegistro, jornadaCompleta, alertas,
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

/**
 * Grava snapshot mensal + ficha de cada aluno (data_lancamento preservada).
 * Competencia encerrada e append-only: depois da virada, dados ao vivo nao a sobrescrevem.
 */
async function matriculadosPersistir(data) {
  if (typeof db === 'undefined' || !data?.unidades || !data.competencia) return;
  const competencia = data.competencia;
  const agora = new Date().toISOString();

  for (const u of data.unidades) {
    const unidId = matriculadosUnidIdPorCodigo(u.unidade_codigo, u.unidade_nome);
    if (!unidId) continue;
    const lista = matriculadosLista(u);

    try {
      const refCompetencia = matriculadosColCompetencias(unidId).doc(competencia);
      const payload = {
        competencia,
        unidade_codigo: u.unidade_codigo,
        unidade_nome: u.unidade_nome,
        sincronizado_em: agora,
        gerado_em: data.gerado_em || null,
        total: lista.length,
        total_bruto: u.matriculados_total_bruto ?? lista.length,
        excluidos_plano: u.matriculados_excluidos_plano ?? 0,
        filtro_planos: 'anual_recorrente_parcelado',
        matriculados: lista,
      };
      const encerrada = matriculadosCompetenciaEncerrada(competencia);

      await db.runTransaction(async transaction => {
        const atual = await transaction.get(refCompetencia);
        if (encerrada && atual.exists) {
          const salvo = atual.data();
          if (!salvo.fechado_em || salvo.status !== 'fechado') {
            transaction.update(refCompetencia, {
              status: 'fechado',
              fechado_em: agora,
              atualizado_em: salvo.sincronizado_em || agora,
            });
          }
          return;
        }
        transaction.set(refCompetencia, {
          ...payload,
          status: encerrada ? 'fechado' : 'aberto',
          fechado_em: encerrada ? agora : null,
          atualizado_em: agora,
        }, { merge: !encerrada });
      });
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
  const opts = [];
  if (aoVivo) {
    opts.push(`<option value="__live__"${selecionada === '__live__' ? ' selected' : ''}>${matriculadosFmtCompetencia(aoVivo)} (ao vivo)</option>`);
  }
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
      const headers = await n8nAuthHeaders();
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
    outros: 0,
  };
  (lista || []).forEach(m => {
    const id = matriculadosStatusAbaId(m);
    if (id in c) c[id]++;
  });
  return c;
}

function matriculadosFiltrarLista(lista, filtro, statusAba, validacao, situacao, jornada, bio, treino, freqFaixa) {
  let out = lista || [];
  const faixa = freqFaixa || 'todos';
  if (faixa !== 'todos') {
    out = out.filter(m => (m.frequencia_id || 'sem_registro') === faixa);
  }
  const aba = statusAba || 'todos';
  if (aba !== 'todos') {
    out = out.filter(m => matriculadosStatusAbaId(m) === aba);
  }
  const val = validacao || 'todos';
  if (val !== 'todos') {
    out = out.filter(m => {
      const issues = matriculadosValidacaoIssues(m);
      if (val === 'ok') return !issues.length;
      if (val === 'alertas') return issues.length > 0;
      if (val === 'contato') return !!m.precisa_contato;
      return true;
    });
  }
  const sitF = situacao || 'todos';
  if (sitF !== 'todos') {
    out = out.filter(m => {
      return matriculadosSituacaoId(m) === sitF;
    });
  }
  const jor = jornada || 'todos';
  if (jor !== 'todos') {
    out = out.filter(m => {
      if (jor === 'jornada_completa') return matriculadosJornadaCompleta(m);
      if (jor === 'jornada_pendente') return !matriculadosJornadaCompleta(m);
      return true;
    });
  }
  const bioF = bio || 'todos';
  if (bioF !== 'todos') {
    out = out.filter(m => {
      if (bioF === 'realizada') return m.avaliacao_realizada === true;
      if (bioF === 'atrasada') return m.avaliacao_atrasada === true;
      if (bioF === 'sem_bio') return m.avaliacao_atrasada === false && m.avaliacao_realizada === false;
      if (bioF === 'nao_verificada') return m.avaliacao_atrasada == null && m.avaliacao_realizada == null;
      return true;
    });
  }
  const treinoF = treino || 'todos';
  if (treinoF !== 'todos') {
    out = out.filter(m => {
      if (treinoF === 'montado') return !!m.com_treino;
      if (treinoF === 'nao_montado') return !!m._cruzamento?.janela && !m.com_treino;
      if (treinoF === 'nao_verificado') return !m._cruzamento?.janela;
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
  if (c.outros > 0) {
    tabs.push({ id: 'outros', label: 'Não classificado', n: c.outros, cor: '#6b7280' });
  }
  return tabs.map(t =>
    `<button type="button" class="janela-tab${t.id === abaAtiva ? ' janela-tab-on' : ''}" onclick="matriculadosTrocarAba(this,'${t.id}')">${t.label} <span class="janela-tab-n"${t.cor ? ` style="color:${t.cor}"` : ''}>${t.n}</span></button>`
  ).join('');
}

function matriculadosRenderSelectValidacao(val) {
  const v = val || 'todos';
  const opts = [
    ['todos', 'Validação: todos'],
    ['ok', 'Validação: sem pendências'],
    ['alertas', 'Validação: com pendências'],
    ['contato', 'Validação: precisa contato'],
  ];
  return `<select class="janela-prof-select matric-valid-select" onchange="matriculadosTrocarFiltro(this)">${opts.map(([id, lbl]) => `<option value="${id}"${id === v ? ' selected' : ''}>${lbl}</option>`).join('')}</select>`;
}

function matriculadosRenderSelectSituacao(val, lista) {
  const v = val || 'todos';
  const disponiveis = new Set((lista || []).map(matriculadosSituacaoId));
  const todas = [
    ['todos', 'Situação: todas'],
    ['ativo', 'Situação: ativo'],
    ['trancado', 'Situação: trancado'],
    ['suspenso', 'Situação: suspenso'],
    ['cancelado', 'Situação: cancelado'],
    ['desistente', 'Situação: desistente'],
    ['inativo', 'Situação: inativo'],
    ['nao_informada', 'Situação: não informada'],
    ['outra', 'Situação: outra'],
  ];
  const opts = todas.filter(([id]) => id === 'todos' || disponiveis.has(id) || id === v);
  return `<select class="janela-prof-select matric-sit-select" onchange="matriculadosTrocarFiltro(this)">${opts.map(([id, lbl]) => `<option value="${id}"${id === v ? ' selected' : ''}>${lbl}</option>`).join('')}</select>`;
}

function matriculadosRenderSelectJornada(val) {
  const v = val || 'todos';
  const opts = [
    ['todos', 'Jornada: todos'],
    ['jornada_completa', 'Jornada: completa'],
    ['jornada_pendente', 'Jornada: pendente'],
  ];
  return `<select class="janela-prof-select matric-jornada-select" onchange="matriculadosTrocarFiltro(this)">${opts.map(([id, lbl]) => `<option value="${id}"${id === v ? ' selected' : ''}>${lbl}</option>`).join('')}</select>`;
}

function matriculadosRenderSelectBio(val) {
  const v = val || 'todos';
  const opts = [
    ['todos', 'Bio: todas'],
    ['realizada', 'Bio: feita'],
    ['atrasada', 'Bio: atrasada'],
    ['sem_bio', 'Bio: sem avaliação'],
    ['nao_verificada', 'Bio: não verificada'],
  ];
  return `<select class="janela-prof-select matric-bio-select" onchange="matriculadosTrocarFiltro(this)">${opts.map(([id, lbl]) => `<option value="${id}"${id === v ? ' selected' : ''}>${lbl}</option>`).join('')}</select>`;
}

function matriculadosRenderSelectTreino(val) {
  const v = val || 'todos';
  const opts = [
    ['todos', 'Treino: todos'],
    ['montado', 'Treino: montado'],
    ['nao_montado', 'Treino: não montado'],
    ['nao_verificado', 'Treino: sem registro na janela'],
  ];
  return `<select class="janela-prof-select matric-treino-select" onchange="matriculadosTrocarFiltro(this)">${opts.map(([id, lbl]) => `<option value="${id}"${id === v ? ' selected' : ''}>${lbl}</option>`).join('')}</select>`;
}

function matriculadosLerFiltros(root) {
  const modulo = root.dataset.modulo || 'onboarding';
  const view = modulo === 'frequencia'
    ? root.querySelector('.matric-view-frequencia')
    : root.querySelector('.matric-view-onboarding');
  return {
    filtro: (view?.querySelector('.matric-busca')?.value || root.querySelector('.matric-busca')?.value || '').trim(),
    statusAba: root.dataset.statusAba || 'todos',
    validacao: root.querySelector('.matric-valid-select')?.value || 'todos',
    situacao: root.querySelector('.matric-sit-select')?.value || 'todos',
    jornada: root.querySelector('.matric-jornada-select')?.value || 'todos',
    bio: root.querySelector('.matric-bio-select')?.value || 'todos',
    treino: root.querySelector('.matric-treino-select')?.value || 'todos',
    freqFaixa: root.dataset.freqAba || 'todos',
    modulo,
  };
}

function matriculadosTrocarModuloUI(root, modulo) {
  root.dataset.modulo = modulo;
  root.querySelectorAll('.matric-modulo-btn').forEach(b => {
    b.classList.toggle('janela-modulo-on', b.dataset.modulo === modulo);
  });
  const viewOn = root.querySelector('.matric-view-onboarding');
  const viewFreq = root.querySelector('.matric-view-frequencia');
  if (viewOn) viewOn.hidden = modulo !== 'onboarding';
  if (viewFreq) viewFreq.hidden = modulo !== 'frequencia';
}

function matriculadosTrocarModulo(btn, modulo) {
  const root = btn.closest('.matric-card');
  if (!root) return;
  matriculadosTrocarModuloUI(root, modulo);
  root.dataset.pagina = '1';
  matriculadosAtualizarTabela(root, false);
}

function matriculadosTrocarAbaFreq(btn, faixa) {
  const root = btn.closest('.matric-card');
  if (!root) return;
  root.dataset.freqAba = faixa;
  root.querySelectorAll('.matric-freq-tabs .janela-tab').forEach(b => b.classList.remove('janela-tab-on'));
  btn.classList.add('janela-tab-on');
  matriculadosAtualizarTabela(root, true);
}

function matriculadosClicarFunil(btn, filtroJornada) {
  const root = btn.closest('.matric-card');
  if (!root) return;
  matriculadosTrocarModuloUI(root, 'onboarding');
  const jornada = root.querySelector('.matric-jornada-select');
  const bio = root.querySelector('.matric-bio-select');
  const treino = root.querySelector('.matric-treino-select');
  if (jornada) jornada.value = 'todos';
  if (bio) bio.value = 'todos';
  if (treino) treino.value = 'todos';
  if (filtroJornada === 'avaliacao_realizada' && bio) bio.value = 'realizada';
  else if (filtroJornada === 'com_treino' && treino) treino.value = 'montado';
  else if (jornada) jornada.value = filtroJornada || 'todos';
  matriculadosAtualizarTabela(root, true);
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
  if (m.ultimo_acesso_bruto) parts.push(`Último acesso (janela): ${matriculadosFmtDataCurta(m.ultimo_acesso_bruto)}`);
  if (m.sem_visita_desde_matricula) {
    parts.push(m.acesso_anterior_matricula
      ? 'Acesso anterior à matrícula — contando dias desde a matrícula'
      : 'Sem visita desde a matrícula');
  } else if (m.ultimo_acesso) {
    parts.push(`Último acesso: ${matriculadosFmtDataCurta(m.ultimo_acesso)}`);
  }
  return parts.join(' · ') || 'Matrícula não informada';
}

function matriculadosRenderSimNao(val, labelSim, labelNao) {
  if (val === true) return matriculadosPillStatus(labelSim || 'Sim', 'ok');
  if (val === false) return matriculadosPillStatus(labelNao || 'Não', 'warn');
  return matriculadosPillStatus('—', 'muted');
}

function matriculadosThSort(col, label, sortCol, sortDir) {
  const on = sortCol === col;
  const arrow = !on ? '↕' : sortDir === 'asc' ? '↑' : '↓';
  return `<th class="janela-th-sort${on ? ' janela-th-sort-on' : ''}" onclick="matriculadosClicarOrdenacao(this,'${col}')" title="Ordenar coluna">${label} <span class="janela-sort-ico">${arrow}</span></th>`;
}

function matriculadosClicarOrdenacao(th, col) {
  const root = th.closest('.matric-card');
  if (!root) return;
  const prev = root.dataset.sortCol || '';
  const prevDir = root.dataset.sortDir || 'asc';
  root.dataset.sortCol = col;
  root.dataset.sortDir = prev === col && prevDir === 'asc' ? 'desc' : 'asc';
  matriculadosAtualizarTabela(root, true);
}

function matriculadosSortVal(m, col) {
  switch (col) {
    case 'aluno': return (m.nome_aluno || '').toLowerCase();
    case 'matricula': return (m.matricula || '').replace(/^0+/, '') || '0';
    case 'plano': return (m.plano || '').toLowerCase();
    case 'data_matricula': return m.data_lancamento ? new Date(m.data_lancamento).getTime() : null;
    case 'jornada': {
      if (matriculadosJornadaCompleta(m)) return 0;
      if (m.avaliacao_atrasada) return 1;
      if (m.avaliacao_realizada && !m.com_treino) return 2;
      if (!m.avaliacao_realizada && m.com_treino) return 3;
      return 4;
    }
    case 'bio': return (m.avaliacao_label || '').toLowerCase();
    case 'treino': return m.com_treino ? 0 : 1;
    case 'dias': return m.dias_sem_acesso != null ? m.dias_sem_acesso : null;
    case 'frequencia': return MATRIC_FREQ_ORDEM[m.frequencia_id] ?? 5;
    case 'ultimo_acesso': {
      const iso = m.iso_frequencia || m.ultimo_acesso;
      return iso ? new Date(iso).getTime() : null;
    }
    case 'situacao_treino': return (m.treino_status || m.status_treino || '').toLowerCase();
    case 'classificacao': {
      const iso = m.iso_frequencia || m.ultimo_acesso;
      const c = typeof janelaClassificarFrequencia === 'function'
        ? janelaClassificarFrequencia(iso) : { label: '' };
      return (c.label || '').toLowerCase();
    }
    case 'acao': {
      const iso = m.iso_frequencia || m.ultimo_acesso;
      const c = typeof janelaClassificarFrequencia === 'function'
        ? janelaClassificarFrequencia(iso) : { acao: '' };
      return (c.acao || '').toLowerCase();
    }
    default: return null;
  }
}

function matriculadosCmpOrdenacao(a, b, col) {
  const va = matriculadosSortVal(a, col);
  const vb = matriculadosSortVal(b, col);
  if (va == null && vb == null) return 0;
  if (va == null) return 1;
  if (vb == null) return -1;
  if (typeof va === 'number' && typeof vb === 'number') return va - vb;
  return String(va).localeCompare(String(vb), 'pt-BR', { numeric: true, sensitivity: 'base' });
}

function matriculadosAplicarOrdenacao(lista, sortCol, sortDir) {
  if (sortCol) {
    const mul = sortDir === 'desc' ? -1 : 1;
    return [...(lista || [])].sort((a, b) => matriculadosCmpOrdenacao(a, b, sortCol) * mul);
  }
  return matriculadosOrdenarParaRelatorio(lista);
}

function matriculadosRenderAvaliacaoPill(m) {
  if (m.avaliacao_label && m.avaliacao_label !== '—') {
    return matriculadosPillStatus(m.avaliacao_label, m.avaliacao_tipo || 'muted');
  }
  return matriculadosPillStatus('—', 'muted');
}

function matriculadosRenderTabela(lista, filtro, pagina, statusAba, validacao, situacao, jornada, bio, treino, sortCol, sortDir) {
  const sc = sortCol || '';
  const sd = sortDir || 'asc';
  const filtrada = matriculadosAplicarOrdenacao(
    matriculadosFiltrarLista(lista, filtro, statusAba, validacao, situacao, jornada, bio, treino),
    sc, sd
  );
  if (!filtrada.length) {
    return `<div class="janela-empty">Nenhum aluno neste filtro.</div>`;
  }
  const totalPag = Math.max(1, Math.ceil(filtrada.length / MATRICULADOS_PAGE_SIZE));
  const pag = Math.min(Math.max(1, pagina || 1), totalPag);
  const slice = filtrada.slice((pag - 1) * MATRICULADOS_PAGE_SIZE, pag * MATRICULADOS_PAGE_SIZE);

  return `<div class="tw janela-tw"><table>
    <thead><tr>
      ${matriculadosThSort('aluno', 'Aluno', sc, sd)}
      ${matriculadosThSort('matricula', 'Matrícula', sc, sd)}
      ${matriculadosThSort('plano', 'Plano', sc, sd)}
      ${matriculadosThSort('data_matricula', 'Data matrícula', sc, sd)}
      ${matriculadosThSort('jornada', 'Jornada', sc, sd)}
      ${matriculadosThSort('bio', 'Bio', sc, sd)}
      ${matriculadosThSort('treino', 'Treino', sc, sd)}
      ${matriculadosThSort('frequencia', 'Frequência', sc, sd)}
      ${matriculadosThSort('situacao_treino', 'Situação treino', sc, sd)}
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
      const diasFmt = matriculadosFmtDiasMatricula(m);
      return `<tr>
        <td style="font-weight:500;"><span class="janela-nome-aluno" title="${tip}">${nome}</span></td>
        <td style="font-family:'DM Mono',monospace;font-size:11px;">${mat}</td>
        <td style="max-width:160px;white-space:normal;font-size:11px;">${plano}</td>
        <td style="font-family:'DM Mono',monospace;font-size:11px;">${matriculadosFmtDataCurta(m.data_lancamento)}</td>
        <td>${matriculadosBadgeJornada(m)}</td>
        <td>${matriculadosRenderAvaliacaoPill(m)}</td>
        <td>${matriculadosRenderSimNao(m.com_treino, 'Sim', 'Não')}</td>
        <td>${matriculadosRenderFreqPill(m)}<div style="font-size:10px;color:${diasFmt.cor};margin-top:2px;font-family:'DM Mono',monospace;">${diasFmt.txt}${m.ultimo_acesso ? ' · ' + matriculadosFmtDataCurta(m.ultimo_acesso) : ''}</div></td>
        <td>${matriculadosRenderTreinoPill(m)}</td>
        <td style="font-size:11px;color:${m.precisa_contato ? '#f05c5c' : 'var(--muted)'};">${typeof esc === 'function' ? esc(contato) : contato}</td>
        <td>${matriculadosRenderValidacao(m)}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>${matriculadosRenderPaginador(filtrada.length, pag)}`;
}

function matriculadosRenderTabelaFrequencia(lista, filtro, pagina, freqFaixa, sortCol, sortDir) {
  const sc = sortCol || '';
  const sd = sortDir || 'asc';
  const filtrada = matriculadosAplicarOrdenacao(
    matriculadosFiltrarLista(lista, filtro, 'todos', 'todos', 'todos', 'todos', 'todos', 'todos', freqFaixa),
    sc, sd
  );
  if (!filtrada.length) {
    return `<div class="janela-empty">Nenhum aluno nesta faixa de frequência.</div>`;
  }
  const totalPag = Math.max(1, Math.ceil(filtrada.length / MATRICULADOS_PAGE_SIZE));
  const pag = Math.min(Math.max(1, pagina || 1), totalPag);
  const slice = filtrada.slice((pag - 1) * MATRICULADOS_PAGE_SIZE, pag * MATRICULADOS_PAGE_SIZE);

  return `<div class="tw janela-tw"><table>
    <thead><tr>
      ${matriculadosThSort('aluno', 'Aluno', sc, sd)}
      ${matriculadosThSort('matricula', 'Matrícula', sc, sd)}
      ${matriculadosThSort('jornada', 'Jornada', sc, sd)}
      ${matriculadosThSort('ultimo_acesso', 'Último acesso', sc, sd)}
      ${matriculadosThSort('dias', 'Dias s/ vir', sc, sd)}
      ${matriculadosThSort('classificacao', 'Classificação', sc, sd)}
      ${matriculadosThSort('acao', 'Ação sugerida', sc, sd)}
    </tr></thead>
    <tbody>${slice.map(m => {
      const nomeRaw = m.nome_aluno || '—';
      const nome = typeof esc === 'function' ? esc(nomeRaw) : nomeRaw;
      const mat = typeof esc === 'function' ? esc(m.matricula || '—') : (m.matricula || '—');
      const iso = m.iso_frequencia || m.ultimo_acesso;
      const cls = typeof janelaClassificarFrequencia === 'function'
        ? janelaClassificarFrequencia(iso)
        : { label: '—', cor: 'var(--muted)', bg: 'transparent', acao: '—' };
      const dias = matriculadosFmtDiasMatricula(m);
      const ultAcessoTxt = m.sem_visita_desde_matricula
        ? (m.acesso_anterior_matricula ? 'Antes da matr.' : '—')
        : matriculadosFmtDataCurta(m.ultimo_acesso);
      return `<tr>
        <td style="font-weight:500;">${nome}</td>
        <td style="font-family:'DM Mono',monospace;font-size:11px;">${mat}</td>
        <td>${matriculadosBadgeJornada(m)}</td>
        <td style="font-family:'DM Mono',monospace;font-size:11px;">${ultAcessoTxt}</td>
        <td style="font-family:'DM Mono',monospace;font-size:11px;font-weight:600;color:${dias.cor};">${dias.txt}</td>
        <td><span class="pill" style="background:${cls.bg};color:${cls.cor};border:1px solid ${cls.cor}33;">${cls.label}</span></td>
        <td style="font-size:11px;color:var(--muted);">${cls.acao}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>${matriculadosRenderPaginador(filtrada.length, pag)}`;
}

function matriculadosAtualizarTabela(root, resetPage) {
  if (resetPage) root.dataset.pagina = '1';
  const lista = JSON.parse(root.dataset.matriculados || '[]');
  const { filtro, statusAba, validacao, situacao, jornada, bio, treino, freqFaixa, modulo } = matriculadosLerFiltros(root);
  const filtrada = modulo === 'frequencia'
    ? matriculadosFiltrarLista(lista, filtro, 'todos', 'todos', 'todos', 'todos', 'todos', 'todos', freqFaixa)
    : matriculadosFiltrarLista(lista, filtro, statusAba, validacao, situacao, jornada, bio, treino);
  const totalPag = Math.max(1, Math.ceil(filtrada.length / MATRICULADOS_PAGE_SIZE));
  let pagina = parseInt(root.dataset.pagina || '1', 10);
  pagina = Math.min(Math.max(1, pagina), totalPag);
  root.dataset.pagina = String(pagina);
  const sortCol = root.dataset.sortCol || '';
  const sortDir = root.dataset.sortDir || 'asc';
  const wrap = modulo === 'frequencia'
    ? root.querySelector('.matric-freq-alunos-wrap')
    : root.querySelector('.matric-alunos-wrap');
  if (!wrap) return;
  wrap.innerHTML = modulo === 'frequencia'
    ? matriculadosRenderTabelaFrequencia(lista, filtro, pagina, freqFaixa, sortCol, sortDir)
    : matriculadosRenderTabela(lista, filtro, pagina, statusAba, validacao, situacao, jornada, bio, treino, sortCol, sortDir);
}

function matriculadosFiltrarBusca(input) {
  const root = input.closest('.matric-card');
  if (root) matriculadosAtualizarTabela(root, true);
}

function matriculadosIrPagina(btn, delta) {
  const root = btn.closest('.matric-card');
  if (!root) return;
  const lista = JSON.parse(root.dataset.matriculados || '[]');
  const { filtro, statusAba, validacao, situacao, jornada, bio, treino, freqFaixa, modulo } = matriculadosLerFiltros(root);
  const filtrada = modulo === 'frequencia'
    ? matriculadosFiltrarLista(lista, filtro, 'todos', 'todos', 'todos', 'todos', 'todos', 'todos', freqFaixa)
    : matriculadosFiltrarLista(lista, filtro, statusAba, validacao, situacao, jornada, bio, treino);
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
  const fonteLabel = fonte === 'historico' ? 'Histórico salvo' : 'Webhook operacional (ao vivo)';
  const mesesSalvos = historico.length;
  const exclPlanos = unidade?.matriculados_excluidos_plano ?? o.excluidosPlano ?? 0;
  const filtroPlanoLabel = 'Anual recorrente + parcelado';
  const pacto = fonte === 'live' && typeof totalAtivosEncontrarUnidade === 'function'
    ? totalAtivosEncontrarUnidade(_totalAtivosCache?.data, unidId)
    : null;
  const pactoStatus = pacto && typeof pactoIndicadoresStatus === 'function'
    ? pactoIndicadoresStatus(pacto)
    : null;
  const pactoAtual = pacto && typeof pactoIndicadoresCompetenciaAtual === 'function'
    && pactoIndicadoresCompetenciaAtual(pacto)
    && pactoStatus?.valido ? pacto : null;
  const pactoNumero = campo => {
    if (!pactoAtual || typeof pactoIndicadoresGetNumero !== 'function') return null;
    return pactoIndicadoresGetNumero(unidId, campo, _totalAtivosCache.data);
  };
  const pactoFmt = campo => {
    const valor = pactoNumero(campo);
    return valor == null ? '—' : valor.toLocaleString('pt-BR');
  };

  const indicador = matriculadosTblCol('Indicador', [
    ['Matriculados no mês', lista.length],
    ['Jornada completa', lista.length ? `${cruz.jornadaCompleta} (${Math.round(cruz.jornadaCompleta / lista.length * 100)}%)` : '0', '#34c47c'],
    ['Bio atrasada', lista.length ? `${cruz.avaliacaoAtrasada} (${Math.round(cruz.avaliacaoAtrasada / lista.length * 100)}%)` : '0', '#f05c5c'],
  ]);

  const distribuicao = matriculadosTblCol('Jornada', [
    ['Bio feita', lista.length ? `${cruz.avaliacaoRealizada} (${Math.round(cruz.avaliacaoRealizada / lista.length * 100)}%)` : '0', '#34c47c'],
    ['Com treino montado', lista.length ? `${cruz.comTreinoMontado} (${Math.round(cruz.comTreinoMontado / lista.length * 100)}%)` : '0', '#378add'],
    ['Na Janela de Treino', lista.length ? `${cruz.naJanela} (${Math.round(cruz.naJanela / lista.length * 100)}%)` : '0', '#378add'],
    ['Precisam contato', precisaContato, precisaContato ? '#f05c5c' : 'var(--muted)'],
  ]);

  const freqResumo = typeof janelaRenderResumoFrequencia === 'function'
    ? janelaRenderResumoFrequencia(lista) : null;
  const freqTabs = freqResumo && typeof JANELA_FREQ !== 'undefined' ? [
    { id: 'todos', label: 'Todos', n: lista.length },
    { id: 'normal', label: '0–6', n: freqResumo.buckets.normal.length, cor: JANELA_FREQ.normal.cor },
    { id: 'acompanhar', label: '7–15', n: freqResumo.buckets.acompanhar.length, cor: JANELA_FREQ.acompanhar.cor },
    { id: 'alerta', label: '16–30', n: freqResumo.buckets.alerta.length, cor: JANELA_FREQ.alerta.cor },
    { id: 'critico', label: '31+', n: freqResumo.buckets.critico.length, cor: JANELA_FREQ.critico.cor },
    { id: 'sem_registro', label: 'Sem registro', n: freqResumo.buckets.sem_registro.length },
  ] : [];
  const funil = matriculadosRenderFunil(lista);

  const linhasAtivos = cruz.temListaAtivos
    ? [['Em alunos ativos', lista.length ? `${cruz.emAtivos} (${Math.round(cruz.emAtivos / lista.length * 100)}%)` : '0', '#378add']]
    : [];

  // Referências agregadas oficiais. Não substituem a lista de onboarding,
  // cujo escopo é restrito a planos anuais recorrentes e parcelados.
  const linhasPacto = pactoAtual ? [
    ['Fonte oficial', 'Pacto MCP'],
    ['Alunos ativos (oficial)', pactoFmt('alunos_ativos'), '#378add'],
    ['Contratos ativos / vencidos', `${pactoFmt('contratos_ativos')} / ${pactoFmt('contratos_vencidos')}`],
    ['Matrículas no mês (geral)', pactoFmt('matriculados_mes')],
    ['Rematrículas no mês (geral)', pactoFmt('rematriculados_mes')],
    ['Cancelamentos no mês (geral)', pactoFmt('cancelados_mes')],
    ['Saldo do mês (geral)', pactoFmt('saldo_mes')],
    ['Acessos hoje / mês', `${pactoFmt('acessos_hoje')} / ${pactoFmt('acessos_mes')}`],
    ['Acessos nos últimos 30 dias', pactoFmt('acessos_ultimos_30_dias')],
    ['Pico de movimento', pacto.dia_pico && pacto.horario_pico ? `${pacto.dia_pico}, ${pacto.horario_pico}` : '—'],
    ['Coleta oficial', pacto.coletado_em ? matriculadosFmtData(pacto.coletado_em) : '—'],
  ] : pacto ? [
    ['Pacto MCP', typeof totalAtivosSubtitulo === 'function'
      ? totalAtivosSubtitulo(unidId, _totalAtivosCache?.data)
      : 'Dados oficiais indisponiveis', '#f05c5c'],
  ] : [];

  const sinc = matriculadosTblCol('Sincronização', [
    ['Fonte', fonteLabel],
    ['Competência', competencia],
    ['Escopo planos', filtroPlanoLabel],
    ...(exclPlanos > 0 ? [['Excluídos do escopo', exclPlanos, '#f5a623']] : []),
    ['Cruzamento', 'Matrícula → Janela + Aval. realizadas/atrasadas'],
    ...linhasAtivos,
    ...linhasPacto,
    ['Histórico (meses)', mesesSalvos],
    ['Gerado em', data.gerado_em ? matriculadosFmtData(data.gerado_em) : (o.sincronizado_em ? matriculadosFmtData(o.sincronizado_em) : '—')],
    ['Atualizado em', resumo.ultima_atualizacao ? matriculadosFmtData(resumo.ultima_atualizacao) : (o.sincronizado_em ? matriculadosFmtData(o.sincronizado_em) : '—')],
  ]);

  const jsonLista = JSON.stringify(lista).replace(/'/g, '&#39;');
  const aoVivoComp = o.competenciaAoVivo || data.competencia;
  const atualizadoEm = resumo.ultima_atualizacao || o.sincronizado_em || data.gerado_em;
  const alertaHtml = cruz.alertas ? `<div class="matric-alerta-validacao">
    <div><strong>${cruz.alertas.toLocaleString('pt-BR')} de ${lista.length.toLocaleString('pt-BR')} matriculados com pendência</strong>
    <span>Use o filtro “Validação” para priorizar as correções.</span></div>
    <span class="matric-alerta-pct">${lista.length ? Math.round(cruz.alertas / lista.length * 100) : 0}%</span>
  </div>` : '';
  const syncDetails = `<details class="janela-details">
    <summary><span><i></i> ${fonteLabel}</span><span>Atualizado ${atualizadoEm ? matriculadosFmtData(atualizadoEm) : '—'} · Ver detalhes</span></summary>
    <div class="janela-details-body">${sinc}</div>
  </details>`;

  return `<div class="matric-card janela-card" data-modulo="onboarding" data-freq-aba="todos" data-pagina="1" data-status-aba="todos" data-unid-id="${unidId}" data-competencia-sel="${competenciaSel}" data-excluidos-plano="${exclPlanos}" data-matriculados='${jsonLista}'>
    <div class="janela-card-head">
      <div>
        <div class="janela-title">Matriculados no mês — ${typeof esc === 'function' ? esc(nomeUnidade) : nomeUnidade}</div>
        <div class="janela-sub">${matriculadosFmtCompetencia(competencia)} · ${fonteLabel} · ${filtroPlanoLabel}${exclPlanos > 0 ? ` · ${exclPlanos} excl. (avulso/semanal)` : ''}${fonte === 'historico' ? ' · histórico interno' : ''}${data.gerado_em && fonte === 'live' ? ' · Atualizado ' + matriculadosFmtData(data.gerado_em) : ''}</div>
      </div>
      <div class="matric-head-actions">
        <button type="button" class="janela-refresh matric-relatorio-btn" onclick="matriculadosAbrirModalRelatorio('${unidId}')" title="Gerar relatório ou exportar">📄 Relatório</button>
        <button type="button" class="janela-refresh" onclick="renderMatriculadosMes('${unidId}', true)" title="Atualizar ao vivo">↻ Atualizar</button>
      </div>
    </div>
    ${syncDetails}
    <div class="janela-tables janela-tables-2">${indicador}${distribuicao}</div>
    ${funil}
    ${alertaHtml}
    <div class="janela-modulo-nav">
      <button type="button" class="janela-modulo-btn matric-modulo-btn janela-modulo-on" data-modulo="onboarding" onclick="matriculadosTrocarModulo(this,'onboarding')">Onboarding (bio + treino)</button>
      <button type="button" class="janela-modulo-btn matric-modulo-btn" data-modulo="frequencia" onclick="matriculadosTrocarModulo(this,'frequencia')">Frequência de acesso</button>
    </div>
    <div class="matric-view-onboarding">
      <div class="janela-alunos-sec">
        <div class="sec" style="margin-bottom:8px;">Alunos matriculados — onboarding</div>
        <div class="janela-toolbar matric-toolbar-comp">
          ${matriculadosRenderSelectCompetencias(unidId, historico, aoVivoComp, competenciaSel)}
        </div>
        <div class="janela-toolbar">
          <div class="janela-tabs matric-status-tabs">${matriculadosRenderTabsStatus(lista, 'todos')}</div>
          <div class="janela-filtros">
            ${matriculadosRenderSelectJornada('todos')}
            ${matriculadosRenderSelectBio('todos')}
            ${matriculadosRenderSelectTreino('todos')}
            ${matriculadosRenderSelectValidacao('todos')}
            ${matriculadosRenderSelectSituacao('todos', lista)}
            <input type="search" class="janela-busca matric-busca" placeholder="Buscar aluno, matrícula ou plano…" oninput="matriculadosFiltrarBusca(this)">
          </div>
        </div>
        <div class="matric-alunos-wrap">${matriculadosRenderTabela(lista, '', 1, 'todos', 'todos', 'todos', 'todos', 'todos', 'todos')}</div>
      </div>
    </div>
    <div class="matric-view-frequencia" hidden>
      ${freqResumo ? `<div class="janela-tables">${freqResumo.indicador}${freqResumo.distribuicao}${freqResumo.acoes}</div>${freqResumo.bars}` : ''}
      <div class="janela-alunos-sec">
        <div class="sec" style="margin-bottom:8px;">Alunos por frequência de acesso</div>
        <div class="janela-toolbar">
          <div class="janela-tabs matric-freq-tabs">${freqTabs.map(t =>
            `<button type="button" class="janela-tab${t.id === 'todos' ? ' janela-tab-on' : ''}" onclick="matriculadosTrocarAbaFreq(this,'${t.id}')">${t.label} <span class="janela-tab-n"${t.cor ? ` style="color:${t.cor}"` : ''}>${t.n}</span></button>`
          ).join('')}</div>
          <div class="janela-filtros">
            <input type="search" class="janela-busca matric-busca" placeholder="Buscar aluno ou matrícula…" oninput="matriculadosFiltrarBusca(this)">
          </div>
        </div>
        <div class="matric-freq-alunos-wrap">${matriculadosRenderTabelaFrequencia(lista, '', 1, 'todos')}</div>
      </div>
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
  const elegiveis = matriculadosFiltrarPlanosElegiveis(listaRaw);
  // O snapshot ja foi enriquecido ao ser gravado. Cruzar novamente com as fontes
  // atuais alteraria retroativamente bio, treino e frequencia do mes encerrado.
  const lista = elegiveis;
  const unidade = {
    unidade_codigo: histDoc.unidade_codigo,
    unidade_nome: histDoc.unidade_nome,
    matriculados: lista,
    matriculados_total_bruto: listaRaw.length,
    matriculados_excluidos_plano: Math.max(0, listaRaw.length - elegiveis.length),
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

function matriculadosPreencherMetricCard(cardId, opts) {
  const card = document.getElementById(cardId);
  if (!card) return;
  const o = opts || {};
  const mv = card.querySelector('.mv');
  const ml = card.querySelector('.ml');
  if (mv && o.valor != null) mv.textContent = o.valor;
  if (ml && o.label) ml.textContent = o.label;
  if (mv) mv.style.color = o.valorCor || '';
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
  if (o.sub != null) live.textContent = o.sub;
}

function matriculadosAtualizarMetrica(unidId, data, lista) {
  const total = matriculadosGetTotal(unidId, data);
  const comp = data?.competencia;
  const subComp = comp ? matriculadosFmtCompetencia(comp) : 'Ao vivo';

  if (total != null) {
    matriculadosPreencherMetricCard('dashMetricMatriculados', {
      valor: total.toLocaleString('pt-BR'),
      label: 'Matriculados no mês',
      sub: `${subComp} · anual rec./parc.`,
    });
  }

  const cardAv = document.getElementById('dashMetricMatriculadosAvRealizada');
  if (!cardAv) return;

  if (!Array.isArray(lista)) {
    matriculadosPreencherMetricCard('dashMetricMatriculadosAvRealizada', {
      valor: '—',
      label: 'Bio+treino (mês)',
      sub: 'Carregando…',
    });
    return;
  }

  const n = lista.length;
  const realizadas = lista.filter(m => m.avaliacao_realizada === true).length;
  const jornadaOk = lista.filter(m => matriculadosJornadaCompleta(m)).length;
  const pct = n ? Math.round(realizadas / n * 100) : 0;
  matriculadosPreencherMetricCard('dashMetricMatriculadosAvRealizada', {
    valor: jornadaOk.toLocaleString('pt-BR'),
    label: 'Bio+treino (mês)',
    sub: n
      ? `${jornadaOk} jornada completa · ${realizadas} c/ bio (${pct}%) · ${subComp}`
      : `Nenhum matriculado · ${subComp}`,
    valorCor: jornadaOk > 0 ? '#34c47c' : undefined,
  });
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
    await matriculadosPersistir(dataEnriquecida)
      .catch(e => console.warn('[MATRICULADOS] Persistência:', e.message));
  }

  if (!data) {
    el.innerHTML = `<div class="janela-card janela-erro">
      <div class="janela-title">Matriculados no mês</div>
      <div class="janela-sub">Não foi possível carregar os dados. Verifique o webhook ou tente novamente.</div>
      <button type="button" class="btn primary" style="margin-top:12px;" onclick="renderMatriculadosMes('${unidId}', true)">Tentar novamente</button>
    </div>`;
    return;
  }

  const competenciaAtual = matriculadosCompetenciaAtual();
  const competenciaRecebida = String(data.competencia || '');
  const payloadEhAtual = competenciaRecebida === competenciaAtual;

  // Um webhook atrasado nao transforma o mes anterior em dados "ao vivo". Depois
  // de fechar, renderizamos exatamente o snapshot salvo, sem cruzamentos atuais.
  if (matriculadosCompetenciaEncerrada(competenciaRecebida)) {
    const [histDoc, historicoFechado] = await Promise.all([
      matriculadosCarregarCompetencia(unidId, competenciaRecebida),
      matriculadosListarCompetencias(unidId),
    ]);
    if (histDoc) {
      const listaFechada = matriculadosFiltrarPlanosElegiveis(histDoc.matriculados || []);
      const unidadeFechada = {
        unidade_codigo: histDoc.unidade_codigo,
        unidade_nome: histDoc.unidade_nome,
        matriculados: listaFechada,
        matriculados_total_bruto: histDoc.total_bruto ?? listaFechada.length,
        matriculados_excluidos_plano: histDoc.excluidos_plano ?? 0,
      };
      const dataFechada = {
        competencia: competenciaRecebida,
        gerado_em: histDoc.gerado_em || histDoc.sincronizado_em,
        resumo_geral: { total_alunos_unicos: listaFechada.length },
      };
      el.innerHTML = matriculadosRenderConteudo(dataFechada, unidadeFechada, unidId, {
        lista: listaFechada,
        fonte: 'historico',
        competenciaSel: competenciaRecebida,
        historico: historicoFechado,
        sincronizado_em: histDoc.sincronizado_em,
        competenciaAoVivo: null,
      });
      matriculadosAtualizarMetrica(unidId, dataFechada, listaFechada);
      return;
    }
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
    matriculadosAtualizarMetrica(unidId, data, []);
    return;
  }

  const historicoAtualizado = historico.length ? historico : await matriculadosListarCompetencias(unidId);
  el.innerHTML = matriculadosRenderConteudo(dataEnriquecida || data, unidade, unidId, {
    lista,
    fonte: 'live',
    competenciaSel: payloadEhAtual ? '__live__' : competenciaRecebida,
    historico: historicoAtualizado,
    competenciaAoVivo: payloadEhAtual ? data.competencia : null,
    excluidosPlano: unidade.matriculados_excluidos_plano ?? 0,
  });
  matriculadosAtualizarMetrica(unidId, dataEnriquecida || data, lista);
}

// ════════════════════════════════════════════════════════════════════════
// RELATÓRIOS — mensal / semanal / anual · Firestore · CSV · PDF (impressão)
// ════════════════════════════════════════════════════════════════════════

function matriculadosDedupeChaveAluno(m) {
  if (m.codigo_contrato != null && m.codigo_contrato !== '') return `c:${m.codigo_contrato}`;
  const mat = matriculadosNormalizarMatricula(m.matricula);
  const dt = String(m.data_lancamento || '').slice(0, 10);
  return `m:${mat}_${dt}`;
}

function matriculadosDedupeAlunos(lista) {
  const map = new Map();
  (lista || []).forEach(m => {
    const k = matriculadosDedupeChaveAluno(m);
    const prev = map.get(k);
    if (!prev) {
      map.set(k, m);
      return;
    }
    const dta = new Date(m.data_lancamento || 0).getTime();
    const dtb = new Date(prev.data_lancamento || 0).getTime();
    if (dta < dtb) map.set(k, m);
  });
  return [...map.values()];
}

function matriculadosAnosDisponiveis(historico, competenciaAoVivo) {
  const set = new Set();
  (historico || []).forEach(c => {
    const y = String(c.competencia || '').slice(0, 4);
    if (/^\d{4}$/.test(y)) set.add(y);
  });
  if (competenciaAoVivo) {
    const y = String(competenciaAoVivo).slice(0, 4);
    if (/^\d{4}$/.test(y)) set.add(y);
  }
  set.add(String(new Date().getFullYear()));
  return [...set].sort((a, b) => b.localeCompare(a));
}

function matriculadosContagemPorMesAno(lista, anoStr) {
  const porMes = {};
  for (let m = 1; m <= 12; m++) {
    porMes[`${anoStr}-${String(m).padStart(2, '0')}`] = 0;
  }
  (lista || []).forEach(a => {
    const cm = String(a.data_lancamento || a.competencia_coleta || '').slice(0, 7);
    if (porMes[cm] != null) porMes[cm]++;
  });
  return Object.entries(porMes).map(([competencia, total]) => ({ competencia, total }));
}

/** Matriculados do ano: snapshots mensais (Firestore) + mês ao vivo, deduplicados e enriquecidos. */
async function matriculadosCarregarMatriculadosAno(unidId, ano) {
  const anoStr = String(ano);
  const historico = await matriculadosListarCompetencias(unidId);
  const comps = historico
    .map(c => c.competencia)
    .filter(c => String(c).startsWith(`${anoStr}-`));
  const liveComp = _matriculadosCache.data?.competencia;
  const mapas = await matriculadosBuscarCruzamentos(unidId, false);
  let bruta = [];

  const carregarComp = async (comp) => {
    if (comp === liveComp && _matriculadosCache.data) {
      const u = matriculadosEncontrarUnidade(_matriculadosCache.data, unidId);
      return matriculadosFiltrarPlanosElegiveis(matriculadosLista(u) || []);
    }
    const doc = await matriculadosCarregarCompetencia(unidId, comp);
    return matriculadosFiltrarPlanosElegiveis(doc?.matriculados || []);
  };

  const lotes = await Promise.all(comps.map(async comp => {
    const raw = await carregarComp(comp);
    return raw.map(m => ({ ...m, _competencia_snapshot: comp }));
  }));
  lotes.forEach(l => { bruta = bruta.concat(l); });

  if (liveComp?.startsWith(`${anoStr}-`) && !comps.includes(liveComp)) {
    const extra = await carregarComp(liveComp);
    bruta = bruta.concat(extra.map(m => ({ ...m, _competencia_snapshot: liveComp })));
  }

  const cardLista = matriculadosObterListaDoCard(unidId);
  if (cardLista.length && liveComp?.startsWith(`${anoStr}-`)) {
    cardLista.forEach(m => {
      bruta.push({ ...m, _competencia_snapshot: liveComp, _from_card: true });
    });
  }

  const deduped = matriculadosDedupeAlunos(bruta);
  const lista = matriculadosEnriquecerLista(deduped, mapas);
  const porMes = matriculadosContagemPorMesAno(lista, anoStr);
  const mesesComSnapshot = comps.length + (liveComp?.startsWith(`${anoStr}-`) && !comps.includes(liveComp) ? 1 : 0);

  return {
    lista,
    porMes,
    mesesComSnapshot,
    competenciasUsadas: [...new Set(comps.concat(liveComp?.startsWith(`${anoStr}-`) ? [liveComp] : []))].filter(Boolean),
  };
}

function matriculadosColRelatorios(unidId) {
  if (typeof db === 'undefined' || !unidId) return null;
  return db.collection('unidades').doc(unidId).collection('matriculados_relatorios');
}

function matriculadosIsoSemana(d) {
  const dt = d ? new Date(d) : new Date();
  const utc = new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const y = utc.getUTCFullYear();
  const w = Math.ceil((((utc - new Date(Date.UTC(y, 0, 1))) / 86400000) + 1) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}

function matriculadosFmtPeriodoSemana(iso) {
  const m = String(iso || '').match(/^(\d{4})-W(\d{2})$/);
  if (!m) return iso || '—';
  return `Semana ${Number(m[2])} · ${m[1]}`;
}

function matriculadosInicioSemana(d) {
  const dt = d ? new Date(d) : new Date();
  const day = dt.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const ini = new Date(dt);
  ini.setHours(0, 0, 0, 0);
  ini.setDate(ini.getDate() + diff);
  return ini;
}

function matriculadosFimSemana(d) {
  const ini = matriculadosInicioSemana(d);
  const fim = new Date(ini);
  fim.setDate(fim.getDate() + 6);
  fim.setHours(23, 59, 59, 999);
  return fim;
}

function matriculadosAlunoNaSemana(m, refDate) {
  if (!m.data_lancamento) return false;
  const dt = new Date(m.data_lancamento);
  if (Number.isNaN(dt.getTime())) return false;
  return dt >= matriculadosInicioSemana(refDate) && dt <= matriculadosFimSemana(refDate);
}

function matriculadosObterListaDoCard(unidId) {
  const card = document.querySelector(`.matric-card[data-unid-id="${unidId}"]`);
  if (!card) return [];
  try {
    return JSON.parse(card.dataset.matriculados || '[]');
  } catch (_) {
    return [];
  }
}

function matriculadosObterMetaDoCard(unidId) {
  const card = document.querySelector(`.matric-card[data-unid-id="${unidId}"]`);
  const titulo = card?.querySelector('.janela-title')?.textContent || '';
  const sub = card?.querySelector('.janela-sub')?.textContent || '';
  const competenciaSel = card?.dataset.competenciaSel || '__live__';
  const nomeUnidade = (typeof UNIDADES !== 'undefined'
    ? UNIDADES.find(u => u.id === unidId)?.nome
    : null) || unidId;
  return { titulo, sub, competenciaSel, nomeUnidade };
}

function matriculadosMontarResumoRelatorio(lista) {
  const cruz = matriculadosResumoCruzamento(lista);
  const onboarding = matriculadosResumoOnboarding(lista);
  const buckets = typeof janelaMontarFreqBuckets === 'function'
    ? janelaMontarFreqBuckets(lista) : null;
  const freq = buckets ? {
    normal: buckets.normal.length,
    acompanhar: buckets.acompanhar.length,
    alerta: buckets.alerta.length,
    critico: buckets.critico.length,
    sem_registro: buckets.sem_registro.length,
  } : null;
  return { ...cruz, ...onboarding, frequencia: freq };
}

function matriculadosLinhaExportacao(m) {
  const iso = m.iso_frequencia || m.ultimo_acesso;
  const cls = typeof janelaClassificarFrequencia === 'function'
    ? janelaClassificarFrequencia(iso) : { label: '—', acao: '—' };
  const dias = matriculadosFmtDiasMatricula(m).txt;
  let jornada = 'Pendente';
  if (matriculadosJornadaCompleta(m)) jornada = 'Completa';
  else if (m.avaliacao_atrasada) jornada = 'Bio atrasada';
  else if (m.avaliacao_realizada && !m.com_treino) jornada = 'Só bio';
  else if (!m.avaliacao_realizada && m.com_treino) jornada = 'Só treino';
  return {
    nome: m.nome_aluno || '',
    matricula: m.matricula || '',
    plano: m.plano || '',
    data_matricula: matriculadosFmtDataCurta(m.data_lancamento),
    situacao: m.situacao_cliente_descricao || m.situacao_cliente || '',
    jornada,
    bio: m.avaliacao_label || (m.avaliacao_realizada ? 'Realizada' : m.avaliacao_atrasada ? 'Atrasada' : '—'),
    com_treino: m.com_treino ? 'Sim' : 'Não',
    situacao_treino: m.treino_status || m.status_treino || '',
    ultimo_acesso: m.sem_visita_desde_matricula
      ? (m.acesso_anterior_matricula
        ? `Antes matr. (${matriculadosFmtDataCurta(m.ultimo_acesso_bruto)})`
        : 'Sem visita desde matr.')
      : matriculadosFmtDataCurta(m.ultimo_acesso),
    dias_sem_vir: dias,
    frequencia: cls.label,
    frequencia_id: m.frequencia_id || 'sem_registro',
    acao_sugerida: cls.acao,
    professor: m.nome_professor || '',
    programa: m.nome_programa || '',
  };
}

function matriculadosCsvEsc(val) {
  const s = String(val ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function matriculadosMontarPayloadRelatorio(unidId, lista, tipo, opts) {
  const o = opts || {};
  const agora = new Date();
  const competencia = o.competencia || _matriculadosCache.data?.competencia || agora.toISOString().slice(0, 7);
  const ano = o.ano || String(agora.getFullYear());
  const periodo = tipo === 'semanal'
    ? matriculadosIsoSemana(agora)
    : tipo === 'anual'
      ? ano
      : competencia;
  const listaSemana = lista.filter(m => matriculadosAlunoNaSemana(m, agora));
  const detalhe = lista || [];
  const meta = matriculadosObterMetaDoCard(unidId);
  const card = document.querySelector(`.matric-card[data-unid-id="${unidId}"]`);
  const exclPlanos = Number(card?.dataset.excluidosPlano || 0);
  const linhas = matriculadosOrdenarParaRelatorio(detalhe).map(m => {
    const row = matriculadosLinhaExportacao(m);
    if (tipo === 'anual') {
      const cm = String(m.data_lancamento || '').slice(0, 7);
      row.competencia_matricula = cm ? matriculadosFmtCompetencia(cm) : '—';
    }
    return row;
  });
  return {
    tipo,
    periodo,
    ano: tipo === 'anual' ? ano : undefined,
    competencia: tipo === 'anual' ? `${ano}-01` : competencia,
    unidadeId: unidId,
    unidade_nome: meta.nomeUnidade,
    gerado_em: agora.toISOString(),
    fonte: tipo === 'anual' ? 'historico_agregado' : (o.fonte || (meta.competenciaSel === '__live__' ? 'ao_vivo' : 'historico')),
    filtro_planos: 'Anual recorrente + parcelado',
    excluidos_plano: exclPlanos,
    resumo_mes: matriculadosMontarResumoRelatorio(lista),
    resumo_detalhe: matriculadosMontarResumoRelatorio(detalhe),
    por_mes: tipo === 'anual' ? (o.porMes || matriculadosContagemPorMesAno(detalhe, ano)) : null,
    meses_com_snapshot: tipo === 'anual' ? (o.mesesComSnapshot ?? 0) : null,
    novos_semana: listaSemana.length,
    alunos: linhas,
    total_mes: lista.length,
    total_detalhe: detalhe.length,
  };
}

async function matriculadosMontarPayloadRelatorioAsync(unidId, tipo, opts) {
  const o = opts || {};
  if (tipo === 'anual') {
    const ano = o.ano || matriculadosLerAnoRelatorio();
    const pack = await matriculadosCarregarMatriculadosAno(unidId, ano);
    return matriculadosMontarPayloadRelatorio(unidId, pack.lista, tipo, {
      ...o,
      ano,
      porMes: pack.porMes,
      mesesComSnapshot: pack.mesesComSnapshot,
    });
  }
  const lista = o.lista ?? matriculadosObterListaDoCard(unidId);
  return matriculadosMontarPayloadRelatorio(unidId, lista, tipo, o);
}

function matriculadosExportarCSV(payload) {
  const colsAnual = payload.tipo === 'anual'
    ? [['competencia_matricula', 'Mês matrícula']]
    : [];
  const cols = [
    ['nome', 'Aluno'], ['matricula', 'Matrícula'], ['plano', 'Plano'],
    ...colsAnual,
    ['data_matricula', 'Data matrícula'], ['situacao', 'Situação'], ['jornada', 'Jornada'],
    ['bio', 'Bio'], ['com_treino', 'Com treino'], ['situacao_treino', 'Situação treino'],
    ['ultimo_acesso', 'Último acesso'], ['dias_sem_vir', 'Dias s/ vir'],
    ['frequencia', 'Frequência'], ['acao_sugerida', 'Ação sugerida'],
    ['professor', 'Professor'], ['programa', 'Programa'],
  ];
  const header = cols.map(([, lbl]) => matriculadosCsvEsc(lbl)).join(';');
  const rows = [];
  matriculadosAgruparPorFrequencia(payload.alunos || []).forEach(gr => {
    rows.push(cols.map((_, i) => matriculadosCsvEsc(i === 0
      ? `— ${gr.titulo} (${gr.faixa}) · ${gr.alunos.length} aluno(s) —`
      : '')).join(';'));
    gr.alunos.forEach(a => {
      rows.push(cols.map(([k]) => matriculadosCsvEsc(a[k])).join(';'));
    });
    rows.push('');
  });
  const bom = '\uFEFF';
  const blob = new Blob([bom + header + '\n' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `matriculados_${payload.tipo}_${payload.periodo}_${payload.unidadeId}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function matriculadosHtmlRelatorio(payload) {
  const r = payload.resumo_mes;
  const rd = payload.resumo_detalhe;
  const f = r.frequencia || {};
  const tituloTipo = payload.tipo === 'semanal'
    ? `Relatório semanal — ${matriculadosFmtPeriodoSemana(payload.periodo)}`
    : payload.tipo === 'anual'
      ? `Relatório anual — ${payload.ano || payload.periodo}`
      : `Relatório mensal — ${matriculadosFmtCompetencia(payload.competencia)}`;
  const escH = (s) => (typeof esc === 'function' ? esc(String(s ?? '')) : String(s ?? ''));

  const tblHead = `<thead><tr>
    <th>Aluno</th><th>Matrícula</th><th>Matrícula em</th><th>Jornada</th><th>Bio</th><th>Treino</th><th>Dias s/ vir</th><th>Ação</th>
  </tr></thead>`;

  const tblRow = (a) => `<tr>
    <td>${escH(a.nome)}</td>
    <td>${escH(a.matricula)}</td>
    <td>${escH(a.data_matricula)}</td>
    <td>${escH(a.jornada)}</td>
    <td>${escH(a.bio)}</td>
    <td>${escH(a.com_treino)}</td>
    <td>${escH(a.dias_sem_vir)}</td>
    <td>${escH(a.acao_sugerida)}</td>
  </tr>`;

  const secoes = matriculadosAgruparPorFrequencia(payload.alunos || []).map(gr => {
    const acao = gr.alunos[0]?.acao_sugerida || '';
    return `<div class="grp" style="page-break-inside:avoid;margin-bottom:18px;">
      <div class="grp-hd" style="border-left:4px solid ${gr.cor};padding:8px 12px;background:#f9fafb;margin-bottom:6px;border-radius:0 6px 6px 0;">
        <div class="grp-tit" style="font-size:10pt;font-weight:700;color:${gr.cor};">${escH(gr.titulo)} <span style="color:#666;font-weight:600;">(${escH(gr.faixa)})</span></div>
        <div class="grp-sub" style="font-size:8pt;color:#666;margin-top:2px;">${gr.alunos.length} aluno${gr.alunos.length !== 1 ? 's' : ''}${acao ? ` · ${escH(acao)}` : ''}</div>
      </div>
      <table>${tblHead}<tbody>${gr.alunos.map(tblRow).join('')}</tbody></table>
    </div>`;
  }).join('');

  const extraSem = payload.tipo === 'semanal'
    ? `<p class="sub">Novos matriculados na semana: <strong>${payload.novos_semana}</strong> · Total do mês: <strong>${payload.total_mes}</strong></p>`
    : '';
  const tblMesAnual = payload.tipo === 'anual' && payload.por_mes?.length
    ? `<div class="sec">Matriculados por mês (${payload.ano || payload.periodo})</div>
      <table><thead><tr><th>Mês</th><th>Matriculados</th></tr></thead><tbody>
      ${payload.por_mes.map(m => `<tr><td>${escH(matriculadosFmtCompetencia(m.competencia))}</td><td>${m.total}</td></tr>`).join('')}
      </tbody></table>
      ${payload.meses_com_snapshot != null ? `<p class="sub">${payload.meses_com_snapshot} mês(es) com snapshot no histórico · métricas de frequência/jornada na data da geração</p>` : ''}`
    : '';
  const lblTotal = payload.tipo === 'anual' ? 'Matriculados no ano' : 'Matriculados no mês';
  const lblFreq = payload.tipo === 'anual' ? 'Frequência de acesso (situação atual)' : 'Frequência de acesso (mês)';

  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">
<title>${escH(tituloTipo)}</title>
<style>
  body{font-family:Inter,Arial,sans-serif;color:#111;margin:24px;font-size:11pt;}
  h1{font-size:16pt;margin:0 0 4px;}
  .sub{color:#666;font-size:9pt;margin:0 0 16px;}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px;}
  .kpi{border:1px solid #e5e7eb;border-radius:8px;padding:10px;text-align:center;}
  .kpi-v{font-size:18pt;font-weight:700;color:#1a3a5c;}
  .kpi-l{font-size:8pt;color:#666;margin-top:4px;text-transform:uppercase;}
  .sec{font-size:9pt;font-weight:700;text-transform:uppercase;color:#1a3a5c;margin:16px 0 8px;}
  table{width:100%;border-collapse:collapse;font-size:8.5pt;}
  th,td{border:1px solid #e5e7eb;padding:5px 6px;text-align:left;}
  th{background:#1a3a5c;color:#fff;}
  tr:nth-child(even){background:#f9fafb;}
  .grp table{margin-bottom:0;}
  @media print{body{margin:12mm;} .no-print{display:none;} .grp{page-break-inside:avoid;}}
</style></head><body>
  <h1>${escH(tituloTipo)}</h1>
  <p class="sub">${escH(payload.unidade_nome)} · Escopo: ${escH(payload.filtro_planos || 'Anual recorrente + parcelado')}${payload.excluidos_plano ? ` · ${payload.excluidos_plano} excluídos (avulso/semanal)` : ''} · Gerado em ${matriculadosFmtData(payload.gerado_em)}${extraSem}</p>
  <div class="kpis">
    <div class="kpi"><div class="kpi-v">${rd.total ?? payload.total_detalhe}</div><div class="kpi-l">${lblTotal}</div></div>
    <div class="kpi"><div class="kpi-v" style="color:#34c47c">${rd.avaliacaoRealizada ?? rd.bio ?? 0}</div><div class="kpi-l">Bio feita</div></div>
    <div class="kpi"><div class="kpi-v" style="color:#378add">${rd.comTreinoMontado ?? rd.treino ?? 0}</div><div class="kpi-l">Com treino</div></div>
    <div class="kpi"><div class="kpi-v" style="color:#34c47c">${rd.jornadaCompleta ?? rd.completa ?? 0}</div><div class="kpi-l">Jornada completa</div></div>
  </div>
  ${tblMesAnual}
  <div class="sec">${lblFreq}</div>
  <div class="kpis" style="grid-template-columns:repeat(5,1fr);">
    <div class="kpi"><div class="kpi-v" style="color:#34c47c;font-size:14pt">${f.normal ?? 0}</div><div class="kpi-l">0–6 dias</div></div>
    <div class="kpi"><div class="kpi-v" style="color:#378add;font-size:14pt">${f.acompanhar ?? 0}</div><div class="kpi-l">7–15 dias</div></div>
    <div class="kpi"><div class="kpi-v" style="color:#f5a623;font-size:14pt">${f.alerta ?? 0}</div><div class="kpi-l">16–30 dias</div></div>
    <div class="kpi"><div class="kpi-v" style="color:#f05c5c;font-size:14pt">${f.critico ?? 0}</div><div class="kpi-l">31+ dias</div></div>
    <div class="kpi"><div class="kpi-v" style="font-size:14pt">${f.sem_registro ?? 0}</div><div class="kpi-l">Sem registro</div></div>
  </div>
  <div class="sec">Detalhamento por frequência (${payload.alunos.length} aluno${payload.alunos.length !== 1 ? 's' : ''}) — crítico → alerta → acompanhar → normal → sem registro</div>
  ${secoes || '<p class="sub">Nenhum aluno</p>'}
  <p class="sub no-print" style="margin-top:20px;">Use Ctrl+P ou o botão Imprimir para salvar em PDF.</p>
</body></html>`;
}

function matriculadosImprimirRelatorio(payload) {
  const w = window.open('', '_blank');
  if (!w) {
    alert('Permita pop-ups para gerar o PDF.');
    return;
  }
  w.document.write(matriculadosHtmlRelatorio(payload));
  w.document.close();
  w.onload = () => setTimeout(() => w.print(), 300);
}

async function matriculadosSalvarRelatorio(unidId, payload) {
  const col = matriculadosColRelatorios(unidId);
  if (!col) {
    if (typeof mostrarToast === 'function') mostrarToast('Firestore indisponível — exporte CSV/PDF.');
    return false;
  }
  const docId = `${payload.tipo}_${payload.periodo}`;
  try {
    await col.doc(docId).set({
      ...payload,
      salvo_em: new Date().toISOString(),
    }, { merge: true });
    return true;
  } catch (e) {
    console.warn('[MATRICULADOS] Erro ao salvar relatório', e.message);
    return false;
  }
}

async function matriculadosListarRelatorios(unidId, limite) {
  const col = matriculadosColRelatorios(unidId);
  if (!col) return [];
  try {
    const snap = await col.orderBy('gerado_em', 'desc').limit(limite || 8).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.warn('[MATRICULADOS] Erro ao listar relatórios', e.message);
    return [];
  }
}

function matriculadosRenderPreviewRelatorio(payload) {
  const r = payload.resumo_detalhe;
  const titulo = payload.tipo === 'semanal'
    ? matriculadosFmtPeriodoSemana(payload.periodo)
    : payload.tipo === 'anual'
      ? `Ano ${payload.ano || payload.periodo}`
      : matriculadosFmtCompetencia(payload.competencia);
  const tipoLbl = payload.tipo === 'semanal' ? 'Semanal' : payload.tipo === 'anual' ? 'Anual' : 'Mensal';
  const porMes = payload.tipo === 'anual' && payload.por_mes?.length
    ? `<span>${payload.por_mes.filter(m => m.total > 0).length} mês(es) com matrículas · ${payload.meses_com_snapshot ?? '—'} snapshot(s) no histórico</span>`
    : '';
  return `<div class="matric-rel-preview">
    <div class="matric-rel-preview-hd">${titulo} · ${tipoLbl}</div>
    <div class="matric-rel-preview-grid">
      <span><strong>${payload.total_detalhe}</strong> alunos no detalhe</span>
      <span><strong style="color:#34c47c">${r.jornadaCompleta ?? r.completa ?? 0}</strong> jornada completa</span>
      <span><strong style="color:#34c47c">${r.avaliacaoRealizada ?? r.bio ?? 0}</strong> bio feita</span>
      <span><strong style="color:#378add">${r.comTreinoMontado ?? r.treino ?? 0}</strong> com treino</span>
      ${payload.tipo === 'semanal' ? `<span><strong>${payload.novos_semana}</strong> novos na semana · ${payload.total_mes} no mês</span>` : ''}
      ${porMes}
    </div>
  </div>`;
}

function matriculadosRenderHistoricoRelatorios(items) {
  if (!items.length) {
    return '<div class="matric-rel-hist-empty">Nenhum registro salvo ainda.</div>';
  }
  return `<div class="matric-rel-hist">${items.map(it => {
    const lbl = it.tipo === 'semanal'
      ? matriculadosFmtPeriodoSemana(it.periodo)
      : it.tipo === 'anual'
        ? `Ano ${it.ano || it.periodo}`
        : matriculadosFmtCompetencia(it.competencia || it.periodo);
    const dt = it.salvo_em || it.gerado_em;
    return `<div class="matric-rel-hist-item">
      <span>${lbl} <em>(${it.tipo})</em></span>
      <span class="matric-rel-hist-meta">${dt ? matriculadosFmtData(dt) : '—'} · ${it.total_detalhe ?? it.alunos?.length ?? 0} alunos</span>
    </div>`;
  }).join('')}</div>`;
}

function matriculadosEnsureModalRelatorio() {
  if (document.getElementById('matricRelModal')) return;
  const el = document.createElement('div');
  el.id = 'matricRelModal';
  el.className = 'matric-rel-modal';
  el.style.display = 'none';
  el.innerHTML = `<div class="matric-rel-backdrop" onclick="matriculadosFecharModalRelatorio()"></div>
    <div class="matric-rel-panel" role="dialog" aria-labelledby="matricRelTitulo">
      <div class="matric-rel-head">
        <div>
          <div id="matricRelTitulo" class="matric-rel-title">Relatório — Matriculados</div>
          <div id="matricRelSub" class="matric-rel-sub"></div>
        </div>
        <button type="button" class="matric-rel-close" onclick="matriculadosFecharModalRelatorio()" aria-label="Fechar">✕</button>
      </div>
      <div class="matric-rel-body">
        <div class="matric-rel-tipo">
          <label class="matric-rel-radio"><input type="radio" name="matricRelTipo" value="mensal" checked> Mensal (competência)</label>
          <label class="matric-rel-radio"><input type="radio" name="matricRelTipo" value="semanal"> Semanal (snapshot + novos na semana)</label>
          <label class="matric-rel-radio"><input type="radio" name="matricRelTipo" value="anual"> Anual (todos os meses do ano)</label>
        </div>
        <div id="matricRelAnoWrap" class="matric-rel-ano" hidden>
          <label class="matric-rel-ano-lbl">Ano calendário</label>
          <select id="matricRelAno" class="janela-prof-select matric-rel-ano-select"></select>
        </div>
        <div id="matricRelPreview"></div>
        <div class="matric-rel-acoes">
          <button type="button" class="btn primary" onclick="matriculadosAcaoRelatorio('salvar')">💾 Registrar</button>
          <button type="button" class="btn" onclick="matriculadosAcaoRelatorio('csv')">⬇ CSV</button>
          <button type="button" class="btn" onclick="matriculadosAcaoRelatorio('pdf')">📄 PDF / Imprimir</button>
        </div>
        <div class="sec" style="margin-top:16px;margin-bottom:6px;">Registros salvos</div>
        <div id="matricRelHistorico"></div>
      </div>
    </div>`;
  document.body.appendChild(el);
  el.querySelectorAll('input[name="matricRelTipo"]').forEach(inp => {
    inp.addEventListener('change', () => {
      matriculadosToggleAnoRelatorio();
      matriculadosAtualizarPreviewRelatorio();
    });
  });
  const selAno = el.querySelector('#matricRelAno');
  if (selAno) selAno.addEventListener('change', () => matriculadosAtualizarPreviewRelatorio());
}

function matriculadosLerTipoRelatorio() {
  const inp = document.querySelector('#matricRelModal input[name="matricRelTipo"]:checked');
  const v = inp?.value;
  if (v === 'semanal' || v === 'anual') return v;
  return 'mensal';
}

function matriculadosLerAnoRelatorio() {
  const sel = document.getElementById('matricRelAno');
  if (sel?.value) return sel.value;
  const comp = _matriculadosCache.data?.competencia;
  if (comp) return String(comp).slice(0, 4);
  return String(new Date().getFullYear());
}

function matriculadosToggleAnoRelatorio() {
  const wrap = document.getElementById('matricRelAnoWrap');
  if (!wrap) return;
  wrap.hidden = matriculadosLerTipoRelatorio() !== 'anual';
}

function matriculadosPreencherSelectAnoRelatorio(anos) {
  const sel = document.getElementById('matricRelAno');
  if (!sel) return;
  const lista = anos?.length ? anos : matriculadosAnosDisponiveis([], null);
  sel.innerHTML = lista.map(y => `<option value="${y}">${y}</option>`).join('');
}

async function matriculadosAtualizarPreviewRelatorio() {
  const unidId = document.getElementById('matricRelModal')?.dataset.unidId;
  if (!unidId) return;
  const tipo = matriculadosLerTipoRelatorio();
  matriculadosToggleAnoRelatorio();
  const prev = document.getElementById('matricRelPreview');
  if (prev) prev.innerHTML = '<div class="matric-rel-preview"><div class="matric-rel-preview-hd">Carregando…</div></div>';
  const meta = matriculadosObterMetaDoCard(unidId);
  try {
    const payload = await matriculadosMontarPayloadRelatorioAsync(unidId, tipo, {
      competencia: _matriculadosCache.data?.competencia,
      ano: matriculadosLerAnoRelatorio(),
      fonte: meta.competenciaSel === '__live__' ? 'ao_vivo' : 'historico',
    });
    if (prev) {
      if (!payload.total_detalhe && tipo !== 'anual') {
        prev.innerHTML = '<div class="matric-rel-hist-empty">Nenhum aluno para este relatório.</div>';
      } else if (!payload.total_detalhe && tipo === 'anual') {
        prev.innerHTML = '<div class="matric-rel-hist-empty">Nenhum matriculado no ano selecionado. Sincronize os meses (↻ Atualizar) para gravar histórico.</div>';
      } else {
        prev.innerHTML = matriculadosRenderPreviewRelatorio(payload);
      }
    }
    document.getElementById('matricRelModal').dataset.payload = JSON.stringify(payload);
  } catch (e) {
    console.warn('[MATRICULADOS] Preview relatório', e.message);
    if (prev) prev.innerHTML = '<div class="matric-rel-hist-empty">Erro ao montar relatório.</div>';
  }
}

async function matriculadosAbrirModalRelatorio(unidId) {
  matriculadosEnsureModalRelatorio();
  const modal = document.getElementById('matricRelModal');
  const lista = matriculadosObterListaDoCard(unidId);
  const historicoComp = await matriculadosListarCompetencias(unidId);
  if (!lista.length && !historicoComp.length) {
    alert('Nenhum matriculado carregado. Abra a seção e clique em Atualizar, ou aguarde o histórico mensal.');
    return;
  }
  const meta = matriculadosObterMetaDoCard(unidId);
  modal.dataset.unidId = unidId;
  document.getElementById('matricRelSub').textContent = meta.nomeUnidade;
  matriculadosPreencherSelectAnoRelatorio(
    matriculadosAnosDisponiveis(historicoComp, _matriculadosCache.data?.competencia)
  );
  matriculadosToggleAnoRelatorio();
  await matriculadosAtualizarPreviewRelatorio();
  const hist = await matriculadosListarRelatorios(unidId, 8);
  const histEl = document.getElementById('matricRelHistorico');
  if (histEl) histEl.innerHTML = matriculadosRenderHistoricoRelatorios(hist);
  modal.style.display = 'flex';
}

function matriculadosFecharModalRelatorio() {
  const modal = document.getElementById('matricRelModal');
  if (modal) modal.style.display = 'none';
}

async function matriculadosAcaoRelatorio(acao) {
  const modal = document.getElementById('matricRelModal');
  const unidId = modal?.dataset.unidId;
  if (!unidId) return;
  let payload;
  try {
    payload = JSON.parse(modal.dataset.payload || '{}');
  } catch (_) {
    payload = null;
  }
  if (!payload?.alunos?.length) {
    payload = await matriculadosMontarPayloadRelatorioAsync(unidId, matriculadosLerTipoRelatorio(), {
      ano: matriculadosLerAnoRelatorio(),
    });
  }
  if (acao === 'csv') {
    matriculadosExportarCSV(payload);
    if (typeof mostrarToast === 'function') mostrarToast('CSV exportado.');
    return;
  }
  if (acao === 'pdf') {
    matriculadosImprimirRelatorio(payload);
    return;
  }
  if (acao === 'salvar') {
    const ok = await matriculadosSalvarRelatorio(unidId, payload);
    if (typeof mostrarToast === 'function') {
      mostrarToast(ok ? 'Registro salvo no histórico.' : 'Não foi possível salvar.');
    } else if (ok) {
      alert('Registro salvo no histórico.');
    }
    if (ok) {
      const hist = await matriculadosListarRelatorios(unidId, 8);
      const histEl = document.getElementById('matricRelHistorico');
      if (histEl) histEl.innerHTML = matriculadosRenderHistoricoRelatorios(hist);
    }
  }
}
