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
 * action no webhook = academia (ex.: stmpremium24).
 * tipo = operação Pacto (bi | professores | carteira).
 * Nunca envia nem recebe a key Pacto.
 * Cache TTL + single-flight: várias telas pedindo BI ao mesmo tempo = 1 HTTP.
 */
async function pactoViaN8n(tipo, body = {}) {
  if (typeof n8nPactoConfigOk !== 'function' || !n8nPactoConfigOk()) {
    console.error('[PACTO] Configure N8N_PACTO_BASE e N8N_PROXY_TOKEN em js/n8n-config.js (veja n8n/SETUP.txt).');
    return null;
  }
  const unidId = body.unidId || pactoUnidadePorEmpresa(body.empresaId) || null;
  const action = pactoActionWebhook(unidId);
  if (!action) {
    console.error('[PACTO] Sem action de webhook para a unidade', unidId || '(desconhecida)');
    return null;
  }
  const { unidId: _omitUnid, ...rest } = body;
  const payload = { action, tipo, ...rest };
  const cacheKey = action + '|' + tipo + '|' + JSON.stringify(rest);
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
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        console.error('[PACTO] Proxy n8n HTTP', resp.status, action, tipo);
        return null;
      }
      const data = await resp.json();
      _pactoCache[cacheKey] = data;
      _pactoCacheAt[cacheKey] = Date.now();
      return data;
    } catch (e) {
      console.error('[PACTO] Erro de conexão com n8n:', e.message, action, tipo);
      return null;
    } finally {
      delete _pactoInflight[cacheKey];
    }
  })();

  return _pactoInflight[cacheKey];
}

/** Extrai array de lista da resposta Pacto (array direto, content, ou [{content}]). */
function pactoExtrairLista(data) {
  if (!data) return [];
  if (Array.isArray(data)) {
    // n8n às vezes devolve [{ content: [professores...] }]
    if (data.length === 1 && data[0] && Array.isArray(data[0].content)) {
      return data[0].content;
    }
    const comContent = data.find(x => x && Array.isArray(x.content));
    if (comContent && !(data[0] && (data[0].professor || data[0].biTreinoTreinamentoDTO))) {
      return comContent.content;
    }
    return data;
  }
  if (data.content && Array.isArray(data.content)) return data.content;
  const chave = Object.keys(data).find(k => Array.isArray(data[k]));
  return chave ? data[chave] : [];
}

/** Ativos Treino Web = comTreino + semTreino. */
function pactoCalcularAtivos(comTreino, semTreino) {
  if (comTreino == null && semTreino == null) return null;
  return Number(comTreino || 0) + Number(semTreino || 0);
}

/**
 * Total carteira = Ativos + Trancados + Cancelados (opção A).
 * Sem tranc/canc informados, Total = Ativos.
 */
function pactoCalcularTotal(ativos, trancado, cancelado) {
  if (ativos == null || Number.isNaN(Number(ativos))) return null;
  return Number(ativos) + Number(trancado || 0) + Number(cancelado || 0);
}

// ── Busca professores do Treino Web com indicadores já calculados ────
async function pactoBuscarProfessoresBI(empresaId, unidId) {
  const data = await pactoViaN8n('bi', {
    empresaId: String(empresaId),
    unidId: unidId || pactoUnidadePorEmpresa(empresaId) || undefined,
  });
  return pactoExtrairLista(data);
}

// Mantida para compatibilidade — lista ADM via proxy
async function pactoBuscarProfessores(empresaId, unidId) {
  const data = await pactoViaN8n('professores', {
    empresaId: String(empresaId),
    unidId: unidId || pactoUnidadePorEmpresa(empresaId) || undefined,
  });
  return pactoExtrairLista(data);
}

// ── Busca dados de carteira de um professor (agregado no n8n) ─────────
async function pactoBuscarCarteira(codigoPessoa, empresaId, unidId) {
  const data = await pactoViaN8n('carteira', {
    empresaId: String(empresaId),
    codigoPessoa: String(codigoPessoa),
    unidId: unidId || pactoUnidadePorEmpresa(empresaId) || undefined,
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
  const comTreino = bi.alunosAtivosComTreino    ?? null;
  const semTreino = bi.alunosAtivosSemTreino    ?? null;
  const ativos = pactoCalcularAtivos(comTreino, semTreino);
  const durMedio = bi.tempoPermanenciaPrograma && bi.tempoPermanenciaPrograma.medio != null
    ? Number(bi.tempoPermanenciaPrograma.medio)
    : null;
  return {
    codigo:    prof.codigoPessoa || prof.id || prof.codigo || p.codigoPessoa || null,
    nome:      nome || '?',
    comTreino,
    emDia:     bi.alunosAtivosProgramaEmDia ?? null,
    vencidos:  bi.alunosProgramaVencidos   ?? null,
    aRenovar:  bi.alunosProgramaRenovar    ?? bi.alunosProgramaARenovar ?? null,
    semTreino,
    ativos,
    // Total sem tranc/canc do cadastro local — quem soma é a grade/perfil
    total:     ativos,
    duracao:   (durMedio != null && !Number.isNaN(durMedio) && durMedio > 0) ? Math.round(durMedio) : null,
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

async function pactoTesteDescoberta(empresaId, unidId) {
  console.group('[PACTO] Descoberta de professores (via n8n)');
  const uid = unidId || pactoUnidadePorEmpresa(empresaId);
  console.log('empresaId:', empresaId, '| unidId:', uid, '| action:', pactoActionWebhook(uid), '| proxy:', typeof N8N_PACTO_BASE !== 'undefined' ? N8N_PACTO_BASE : '(não configurado)');
  const profs = await pactoBuscarProfessores(empresaId, uid);
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

/** Header empresaId na Pacto — igual para todas as academias MOV FIT. */
const PACTO_EMPRESA_POR_UNIDADE = {
  premium24: '1',
  nrexpress: '1',
  itaituba: '1',
  medicilandia: '1',
};

/** action enviada ao webhook n8n (seleciona key/fluxo da academia). */
const PACTO_ACTION_POR_UNIDADE = {
  premium24: 'stmpremium24',
  nrexpress: 'nrexpress',
  itaituba: 'itaituba',
  medicilandia: 'medicilandia',
};

function pactoEmpresaId(unidId) {
  if (!unidId) return null;
  if (!PACTO_EMPRESA_POR_UNIDADE[unidId]) return null;
  // empresaId é '1' para todas; o que libera a unidade é ter action no webhook
  if (!pactoActionWebhook(unidId)) return null;
  return PACTO_EMPRESA_POR_UNIDADE[unidId];
}

/** Só resolve unidade se houver exatamente um match (empresaId é compartilhado = '1'). */
function pactoUnidadePorEmpresa(empresaId) {
  if (empresaId == null || empresaId === '') return null;
  const eid = String(empresaId);
  const hits = Object.entries(PACTO_EMPRESA_POR_UNIDADE)
    .filter(([, v]) => String(v) === eid)
    .map(([id]) => id);
  return hits.length === 1 ? hits[0] : null;
}

function pactoActionWebhook(unidId) {
  if (!unidId) return null;
  return PACTO_ACTION_POR_UNIDADE[unidId] || null;
}

async function pactoBuscarIndicadoresProfessor(unidId, opts = {}) {
  const empresaId = pactoEmpresaId(unidId);
  if (!empresaId) return null;

  const lista = await pactoBuscarProfessoresBI(empresaId, unidId);
  if (!lista || !lista.length) return null;

  const normalizados = lista.map(pactoNormalizarProfessor).filter(Boolean);
  let match = pactoEncontrarProfessor(normalizados, opts);

  if (!match) {
    try {
      const adm = await pactoBuscarProfessores(empresaId, unidId);
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
            ativos: null, total: null, duracao: null,
          };
        }
      }
    } catch (e) {}
  }
  if (!match) return null;

  // Não chama carteira (4 hits na Pacto) se o BI já trouxe indicadores —
  // evita rate limit 429. Ativos = comTreino + semTreino.
  let ativos = match.ativos != null ? match.ativos : null;
  const precisaCarteira = opts.forcarCarteira === true
    && match.codigo != null
    && match.comTreino == null
    && match.semTreino == null;
  if (precisaCarteira) {
    try {
      const cart = await pactoBuscarCarteira(match.codigo, empresaId, unidId);
      if (cart && cart.ativos != null) ativos = cart.ativos;
    } catch (e) {
      console.warn('[PACTO] carteira opcional falhou:', e);
    }
  }

  const comTreino = match.comTreino;
  const semTreino = match.semTreino;
  if (ativos == null) ativos = pactoCalcularAtivos(comTreino, semTreino);

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
    ativos,
    total: ativos,
    duracao: match.duracao != null ? match.duracao : null,
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
