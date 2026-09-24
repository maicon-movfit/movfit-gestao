// ════════════════════════════════════════════════════════════════════════
// TOTAL DE ALUNOS ATIVOS — webhook n8n
// Config: js/n8n-config.js
// ════════════════════════════════════════════════════════════════════════

const _totalAtivosCache = { data: null, at: 0 };
const TOTAL_ATIVOS_CACHE_TTL_MS = 3 * 60 * 1000;

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
  if (raw.unidades) return raw;
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

async function totalAtivosBuscarDados(forceRefresh) {
  if (typeof N8N_TOTAL_ATIVOS_URL === 'undefined' || !N8N_TOTAL_ATIVOS_URL) {
    console.warn('[ATIVOS] Configure N8N_TOTAL_ATIVOS_URL em js/n8n-config.js');
    return null;
  }
  if (!forceRefresh && _totalAtivosCache.data &&
    (Date.now() - _totalAtivosCache.at) < TOTAL_ATIVOS_CACHE_TTL_MS) {
    return _totalAtivosCache.data;
  }
  if (window._totalAtivosInflightPromise) return window._totalAtivosInflightPromise;

  window._totalAtivosInflightPromise = (async () => {
    try {
      const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      };
      if (typeof N8N_PROXY_TOKEN === 'string' && N8N_PROXY_TOKEN) {
        headers['X-Movfit-Proxy'] = N8N_PROXY_TOKEN;
      }
      const resp = await fetch(N8N_TOTAL_ATIVOS_URL, {
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
  if (!unidade) return null;
  const resumo = unidade.resumo?.total_alunos_ativos;
  if (resumo != null) return Number(resumo);
  const n = (unidade.alunos || []).length;
  return n > 0 ? n : null;
}

function totalAtivosSubtitulo(unidId, data) {
  const unidade = totalAtivosEncontrarUnidade(data || _totalAtivosCache.data, unidId);
  const when = totalAtivosFmtData(unidade?.sincronizacao?.ultima_atualizacao);
  return when ? `Ao vivo · ${when}` : 'Ao vivo';
}

async function atualizarMetricaTotalAtivos(unidId) {
  if (!unidId) return;
  const card = document.getElementById('dashMetricTotalAtivos');
  if (!card) return;

  const data = await totalAtivosBuscarDados();
  const total = totalAtivosGetUnidade(unidId, data);
  if (total == null) return;

  const ml = card.querySelector('.ml');
  const mv = card.querySelector('.mv');
  if (ml) ml.textContent = 'Alunos ativos';
  if (mv) mv.textContent = total.toLocaleString('pt-BR');

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
}
