// ════════════════════════════════════════════════════════════════════════
// INDICADORES OFICIAIS DA PACTO — MCP persistido e exposto pelo webhook n8n
// Config: js/n8n-config.js
// ════════════════════════════════════════════════════════════════════════

const _totalAtivosCache = { data: null, at: 0 };
const TOTAL_ATIVOS_CACHE_TTL_MS = 3 * 60 * 1000;
const PACTO_INDICADORES_ATENCAO_MS = 8 * 60 * 60 * 1000;
const PACTO_INDICADORES_EXPIRADO_MS = 24 * 60 * 60 * 1000;

/** Mapeamento unidId (app) → unidade do webhook. */
const ATIVOS_UNIDADE_MAP = {
  medicilandia: { codigo: 1, slug: 'medicilandia' },
  itaituba:     { codigo: 2, slug: 'itaituba' },
  premium24:    { codigo: 3, slug: 'santarem_24h' },
  nrexpress:    { codigo: 5, slug: 'santarem_nova_republica' },
};

function totalAtivosFmtData(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function totalAtivosNormalizarResposta(raw) {
  if (!raw) return null;
  if (raw.sucesso && Array.isArray(raw.unidades)) return raw;
  const item = raw.dados?.[0];
  if (item?.resposta?.unidades) return item.resposta;
  if (item?.unidades) return item;
  return null;
}

function totalAtivosEncontrarUnidade(data, unidId) {
  const ref = ATIVOS_UNIDADE_MAP[unidId];
  if (!ref || !data?.unidades) return null;
  return data.unidades.find(u =>
    u.unidade_codigo === ref.codigo ||
    u.unidade_nome === ref.slug
  ) || null;
}

function pactoIndicadoresCompetenciaAtual(unidade) {
  const comp = String(unidade?.competencia || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(comp)) return false;
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit',
  }).formatToParts(new Date());
  const ano = partes.find(p => p.type === 'year')?.value;
  const mes = partes.find(p => p.type === 'month')?.value;
  const atual = ano && mes ? `${ano}-${mes}` : '';
  return comp === atual;
}

function pactoIndicadoresStatus(unidade) {
  if (!unidade) return { valido: false, nivel: 'ausente', data: null, idadeMs: null };
  if (!pactoIndicadoresCompetenciaAtual(unidade)) {
    return { valido: false, nivel: 'competencia', data: null, idadeMs: null };
  }
  const valorData = unidade.coletado_em || unidade.momento_pacto ||
    unidade.sincronizacao?.ultima_atualizacao;
  const data = valorData ? new Date(valorData) : null;
  const timestamp = data?.getTime();
  if (!Number.isFinite(timestamp)) {
    return { valido: false, nivel: 'sem_data', data: null, idadeMs: null };
  }
  const idadeMs = Date.now() - timestamp;
  if (idadeMs < -(5 * 60 * 1000)) {
    return { valido: false, nivel: 'futuro', data, idadeMs };
  }
  if (idadeMs > PACTO_INDICADORES_EXPIRADO_MS) {
    return { valido: false, nivel: 'expirado', data, idadeMs };
  }
  return {
    valido: true,
    nivel: idadeMs > PACTO_INDICADORES_ATENCAO_MS ? 'atencao' : 'atualizado',
    data,
    idadeMs,
  };
}

/** Retorna um indicador oficial somente quando ele pertence à competência atual. */
function pactoIndicadoresGetNumero(unidId, campo, data) {
  const unidade = totalAtivosEncontrarUnidade(data || _totalAtivosCache.data, unidId);
  if (!pactoIndicadoresStatus(unidade).valido) return null;
  if (unidade[campo] == null || unidade[campo] === '') return null;
  const valor = Number(unidade[campo]);
  const permiteNegativo = campo === 'saldo_mes';
  return Number.isFinite(valor) && (permiteNegativo || valor >= 0) ? valor : null;
}

async function totalAtivosBuscarDados(forceRefresh) {
  if (typeof N8N_PACTO_INDICADORES_URL === 'undefined' || !N8N_PACTO_INDICADORES_URL) {
    console.warn('[ATIVOS] Configure N8N_PACTO_INDICADORES_URL em js/n8n-config.js');
    return null;
  }
  if (!forceRefresh && _totalAtivosCache.data &&
    (Date.now() - _totalAtivosCache.at) < TOTAL_ATIVOS_CACHE_TTL_MS) {
    return _totalAtivosCache.data;
  }
  if (window._totalAtivosInflightPromise) return window._totalAtivosInflightPromise;

  window._totalAtivosInflightPromise = (async () => {
    try {
      const headers = await n8nAuthHeaders();
      const resp = await fetch(N8N_PACTO_INDICADORES_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });
      if (!resp.ok) {
        console.error('[ATIVOS] Webhook HTTP', resp.status);
        return null;
      }
      const raw = await resp.json();
      const data = totalAtivosNormalizarResposta(raw);
      if (!data?.sucesso || !data?.unidades) {
        console.warn('[ATIVOS] Resposta inválida');
        return null;
      }
      _totalAtivosCache.data = data;
      _totalAtivosCache.at = Date.now();
      return data;
    } catch (e) {
      console.error('[ATIVOS] Erro de conexão:', e.message);
      return null;
    } finally {
      window._totalAtivosInflightPromise = null;
    }
  })();

  return window._totalAtivosInflightPromise;
}

function totalAtivosGetUnidade(unidId, data) {
  const src = data || _totalAtivosCache.data;
  if (!src || !unidId) return null;
  const unidade = totalAtivosEncontrarUnidade(src, unidId);
  if (!pactoIndicadoresStatus(unidade).valido) return null;
  const oficial = pactoIndicadoresGetNumero(unidId, 'alunos_ativos', src);
  if (oficial != null) return oficial;
  const resumo = unidade.resumo?.total_alunos_ativos;
  if (resumo != null && Number.isFinite(Number(resumo))) return Number(resumo);
  const n = (unidade.alunos || []).length;
  return n > 0 ? n : null;
}

function totalAtivosSubtitulo(unidId, data) {
  const unidade = totalAtivosEncontrarUnidade(data || _totalAtivosCache.data, unidId);
  const status = pactoIndicadoresStatus(unidade);
  const dataStatus = status.data ? totalAtivosFmtData(status.data) : null;
  if (status.nivel === 'ausente') return 'Pacto MCP - unidade sem dados';
  if (status.nivel === 'competencia') return 'Pacto MCP - competencia divergente';
  if (status.nivel === 'sem_data') return 'Pacto MCP - horario da coleta ausente';
  if (status.nivel === 'futuro') return 'Pacto MCP - horario da coleta invalido';
  if (status.nivel === 'expirado') {
    return `Pacto MCP - desatualizado${dataStatus ? ` desde ${dataStatus}` : ''}`;
  }
  if (status.nivel === 'atencao') return `Pacto MCP - atencao - ${dataStatus}`;
  const when = totalAtivosFmtData(
    unidade?.coletado_em || unidade?.sincronizacao?.ultima_atualizacao
  );
  return when ? `Pacto MCP · ${when}` : 'Pacto MCP';
}

async function atualizarMetricaTotalAtivos(unidId) {
  if (!unidId) return;
  const card = document.getElementById('dashMetricTotalAtivos');
  if (!card) return;

  const data = await totalAtivosBuscarDados();
  const unidade = totalAtivosEncontrarUnidade(data, unidId);
  const status = pactoIndicadoresStatus(unidade);
  const total = totalAtivosGetUnidade(unidId, data);

  const ml = card.querySelector('.ml');
  const mv = card.querySelector('.mv');

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
  live.textContent = totalAtivosSubtitulo(unidId, data);
  live.style.color = !status.valido
    ? '#f05c5c'
    : status.nivel === 'atencao' ? '#f5a623' : 'var(--muted)';

  if (total == null) return;
  if (ml) ml.textContent = 'Alunos ativos';
  if (mv) mv.textContent = total.toLocaleString('pt-BR');
}
