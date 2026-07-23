// ════════════════════════════════════════════════════════════════════════
// MÓDULO PACTO BI — dados ao vivo via proxy n8n
// A key Bearer da Pacto NÃO fica aqui nem no Firestore.
// n8n injeta a key (Credentials) e devolve só o JSON.
// Config: js/n8n-config.js  |  Setup: n8n/SETUP.txt
// ════════════════════════════════════════════════════════════════════════

// Cache em memória + dedupe de requests em voo (evita rate limit 429 da Pacto)
const _pactoCache = {};
const _pactoCacheAt = {};
const _pactoInflight = {};
const PACTO_CACHE_TTL_MS = 3 * 60 * 1000; // 3 min — reabrir grade/home não bate de novo

/** Limpa respostas da API. Use só em "Atualizar da Pacto" manual. */
function pactoLimparCacheDados() {
  Object.keys(_pactoCache).forEach(k => delete _pactoCache[k]);
  Object.keys(_pactoCacheAt).forEach(k => delete _pactoCacheAt[k]);
}

/**
 * POST no webhook n8n (action: bi | professores | carteira).
 * Nunca envia nem recebe a key Pacto.
 * Cache TTL + single-flight: várias telas pedindo BI ao mesmo tempo = 1 HTTP.
 */
async function pactoViaN8n(action, body = {}) {
  if (typeof n8nPactoConfigOk !== 'function' || !n8nPactoConfigOk()) {
    console.error('[PACTO] Configure N8N_PACTO_BASE e N8N_PROXY_TOKEN em js/n8n-config.js (veja n8n/SETUP.txt).');
    return null;
  }
  const cacheKey = action + JSON.stringify(body);
  const cached = _pactoCache[cacheKey];
  if (cached !== undefined && (Date.now() - (_pactoCacheAt[cacheKey] || 0)) < PACTO_CACHE_TTL_MS) {
    return cached;
  }
  if (_pactoInflight[cacheKey]) return _pactoInflight[cacheKey];

  _pactoInflight[cacheKey] = (async () => {
    try {
      const resp = await fetch(N8N_PACTO_BASE, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Movfit-Proxy': N8N_PROXY_TOKEN,
        },
        body: JSON.stringify({ action, ...body }),
      });
      if (!resp.ok) {
        console.error('[PACTO] Proxy n8n HTTP', resp.status, action);
        return null;
      }
      const data = await resp.json();
      _pactoCache[cacheKey] = data;
      _pactoCacheAt[cacheKey] = Date.now();
      return data;
    } catch (e) {
      console.error('[PACTO] Erro de conexão com n8n:', e.message, action);
      return null;
    } finally {
      delete _pactoInflight[cacheKey];
    }
  })();

  return _pactoInflight[cacheKey];
}

/** Extrai array de lista da resposta Pacto (array direto, content, ou 1ª chave array). */
function pactoExtrairLista(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (data.content && Array.isArray(data.content)) return data.content;
  const chave = Object.keys(data).find(k => Array.isArray(data[k]));
  return chave ? data[chave] : [];
}

// ── Busca professores do Treino Web com indicadores já calculados ────
async function pactoBuscarProfessoresBI(empresaId) {
  const data = await pactoViaN8n('bi', { empresaId: String(empresaId) });
  return pactoExtrairLista(data);
}

// Mantida para compatibilidade — lista ADM via proxy
async function pactoBuscarProfessores(empresaId) {
  const data = await pactoViaN8n('professores', { empresaId: String(empresaId) });
  return pactoExtrairLista(data);
}

// ── Busca dados de carteira de um professor (agregado no n8n) ─────────
async function pactoBuscarCarteira(codigoPessoa, empresaId) {
  const data = await pactoViaN8n('carteira', {
    empresaId: String(empresaId),
    codigoPessoa: String(codigoPessoa),
  });
  if (!data) {
    return { ativos: 0, semTreino: 0, vencidos: 0, comTreino: 0, _raw: null };
  }
  return {
    ativos:    data.ativos    ?? 0,
    semTreino: data.semTreino ?? 0,
    vencidos:  data.vencidos  ?? 0,
    comTreino: data.comTreino ?? 0,
    _raw: data,
  };
}

// ── Extrai nome do objeto professor ──────────────────────────────────
function pactoNomeProfessor(p) {
  if (!p) return '?';
  if (p.professor) return p.professor.nome || p.professor.nomeCompleto || '?';
  if (p.pessoa)    return p.pessoa.nome || p.pessoa.nomeCompleto || '?';
  return p.nome || p.nomeColaborador || p.nomeCompleto || '?';
}

// ── Extrai objeto normalizado de indicadores do professor BI ─────────
function pactoNormalizarProfessor(p) {
  if (!p) return null;
  const prof = p.professor || p.pessoa || p;
  const bi   = p.biTreinoTreinamentoDTO || p.biTreinoTreinamento || {};
  const nome = prof.nome || prof.nomeCompleto || pactoNomeProfessor(p);
  return {
    codigo:    prof.codigoPessoa || prof.id || prof.codigo || p.codigoPessoa || null,
    nome:      nome || '?',
    comTreino: bi.alunosAtivosComTreino    ?? null,
    emDia:     bi.alunosAtivosProgramaEmDia ?? null,
    vencidos:  bi.alunosProgramaVencidos   ?? null,
    aRenovar:  bi.alunosProgramaRenovar    ?? bi.alunosProgramaARenovar ?? null,
    semTreino: bi.alunosAtivosSemTreino    ?? null,
  };
}

function pactoTokensNome(nome) {
  return String(nome || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1 && !['de', 'da', 'do', 'das', 'dos', 'e', 'di', 'del'].includes(t));
}

function pactoNomesCompativeis(a, b) {
  const ta = pactoTokensNome(a);
  const tb = pactoTokensNome(b);
  if (!ta.length || !tb.length) return false;
  if (ta[0] === tb[0] && ta[ta.length - 1] === tb[tb.length - 1]) return true;
  const short = ta.length <= tb.length ? ta : tb;
  const long  = ta.length <= tb.length ? tb : ta;
  if (short.length >= 2 && short.every(t => long.includes(t))) return true;
  if (ta.length >= 2 && tb.includes(ta[0]) && tb.includes(ta[ta.length - 1])) return true;
  if (tb.length >= 2 && ta.includes(tb[0]) && ta.includes(tb[tb.length - 1])) return true;
  return false;
}

function pactoEncontrarProfessor(normalizados, opts = {}) {
  if (!normalizados || !normalizados.length) return null;
  const codigoHint = opts.codigoPacto != null ? opts.codigoPacto : null;
  const nome = opts.nome || '';

  if (codigoHint != null) {
    const byCod = normalizados.find(p => String(p.codigo) === String(codigoHint));
    if (byCod) return byCod;
  }
  if (!nome) return null;

  if (typeof nomeParaId === 'function') {
    const alvo = nomeParaId(nome);
    const exato = normalizados.find(p => p.nome && nomeParaId(p.nome) === alvo);
    if (exato) return exato;
  }

  const fuzzy = normalizados.find(p => p.nome && p.nome !== '?' && pactoNomesCompativeis(p.nome, nome));
  return fuzzy || null;
}

async function pactoTesteDescoberta(empresaId) {
  console.group('[PACTO] Descoberta de professores (via n8n)');
  console.log('empresaId:', empresaId, '| proxy:', typeof N8N_PACTO_BASE !== 'undefined' ? N8N_PACTO_BASE : '(não configurado)');
  const profs = await pactoBuscarProfessores(empresaId);
  console.log('Total de professores retornados:', profs.length);
  if (profs.length > 0) {
    console.log('Estrutura do primeiro professor:', profs[0]);
    console.log('Campos disponíveis:', Object.keys(profs[0]));
    console.table(profs.slice(0, 10));
  } else {
    console.warn('Nenhum professor retornado — verifique n8n/Credentials e N8N_PACTO_BASE');
  }
  console.groupEnd();
  return profs;
}

const PACTO_EMPRESA_POR_UNIDADE = {
  premium24: '1',
};

function pactoEmpresaId(unidId) {
  if (!unidId) return null;
  return PACTO_EMPRESA_POR_UNIDADE[unidId] || null;
}

async function pactoBuscarIndicadoresProfessor(unidId, opts = {}) {
  const empresaId = pactoEmpresaId(unidId);
  if (!empresaId) return null;

  const lista = await pactoBuscarProfessoresBI(empresaId);
  if (!lista || !lista.length) return null;

  const normalizados = lista.map(pactoNormalizarProfessor).filter(Boolean);
  let match = pactoEncontrarProfessor(normalizados, opts);

  if (!match) {
    try {
      const adm = await pactoBuscarProfessores(empresaId);
      const admNorm = (adm || []).map(raw => ({
        codigo: (raw.pessoa && (raw.pessoa.codigoPessoa || raw.pessoa.id)) || raw.codigoPessoa || raw.id || null,
        nome: pactoNomeProfessor(raw),
      })).filter(p => p.nome && p.nome !== '?');
      const admMatch = pactoEncontrarProfessor(admNorm, opts);
      if (admMatch && admMatch.codigo != null) {
        match = normalizados.find(p => String(p.codigo) === String(admMatch.codigo)) || null;
        if (!match) {
          match = {
            ...admMatch,
            comTreino: null, emDia: null, vencidos: null, aRenovar: null, semTreino: null,
          };
        }
      }
    } catch (e) {}
  }
  if (!match) return null;

  // Não chama carteira (4 hits na Pacto) se o BI já trouxe indicadores —
  // evita rate limit 429. Ativos = comTreino + semTreino.
  let ativos = null;
  const precisaCarteira = opts.forcarCarteira === true
    && match.codigo != null
    && match.comTreino == null
    && match.semTreino == null;
  if (precisaCarteira) {
    try {
      const cart = await pactoBuscarCarteira(match.codigo, empresaId);
      if (cart && cart.ativos != null) ativos = cart.ativos;
    } catch (e) {
      console.warn('[PACTO] carteira opcional falhou:', e);
    }
  }

  const comTreino = match.comTreino;
  const semTreino = match.semTreino;
  const totalEstimado =
    ativos != null ? ativos
    : (comTreino != null && semTreino != null ? Number(comTreino) + Number(semTreino) : comTreino);

  return {
    fonte: 'pacto',
    empresaId,
    codigo: match.codigo,
    nome: match.nome,
    comTreino,
    emDia: match.emDia,
    vencidos: match.vencidos,
    aRenovar: match.aRenovar,
    semTreino,
    ativos: ativos != null ? ativos : totalEstimado,
    total: totalEstimado,
  };
}

/**
 * Remove keys Pacto do Firestore (não são mais usadas pelo app).
 * Chame no console após o proxy n8n estar ok:
 *   await limparChavesPactoFirestore()
 * Depois ROTACIONE a key na Pacto e atualize a Credential no n8n.
 */
async function limparChavesPactoFirestore() {
  if (typeof db === 'undefined') {
    console.error('[PACTO] Firestore (db) indisponível.');
    return false;
  }
  const campos = {
    premium24h_treino: firebase.firestore.FieldValue.delete(),
    premium24h_adm: firebase.firestore.FieldValue.delete(),
    bearer_24horas: firebase.firestore.FieldValue.delete(),
  };
  try {
    await db.collection('configuracoes').doc('pacto_api').set(campos, { merge: true });
    console.log('[PACTO] Campos de key removidos de configuracoes/pacto_api.');
    console.warn('[PACTO] Rotacione o Bearer na Pacto e atualize Credentials no n8n.');
    if (typeof mostrarToast === 'function') {
      mostrarToast('Keys Pacto removidas do Firestore. Rotacione a key na Pacto/n8n.');
    }
    return true;
  } catch (e) {
    console.error('[PACTO] Falha ao limpar Firestore:', e);
    if (typeof mostrarToast === 'function') mostrarToast('Erro ao limpar keys: ' + (e.message || e));
    return false;
  }
}
