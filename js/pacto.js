// ════════════════════════════════════════════════════════════════════════
// MÓDULO PACTO BI — Integração em tempo real com API Pacto Soluções
// Chaves armazenadas no Firestore: configuracoes/pacto_api
// Escopo treino: busca carteira em tempo real por professor
// Escopo adm:  busca lista de professores e codigoPessoa
// ════════════════════════════════════════════════════════════════════════

const PACTO_BASE = 'https://apigw.pactosolucoes.com.br';

// Cache em memória para não repetir chamadas na mesma sessão
const _pactoCache = {};

// ── Busca chave do Firestore (com cache de sessão) ────────────────────
async function pactoGetChave(campo) {
  if (_pactoCache['_chave_' + campo]) return _pactoCache['_chave_' + campo];
  try {
    const snap = await db.collection('configuracoes').doc('pacto_api').get();
    if (!snap.exists) { console.warn('[PACTO] Documento pacto_api não encontrado no Firestore.'); return null; }
    const chave = snap.data()[campo] || null;
    if (chave) _pactoCache['_chave_' + campo] = chave;
    return chave;
  } catch(e) {
    console.error('[PACTO] Erro ao buscar chave:', e);
    return null;
  }
}

// ── Chamada genérica à API Pacto ─────────────────────────────────────
async function pactoChamar(endpoint, campoChave, headersExtras = {}) {
  const chave = await pactoGetChave(campoChave);
  if (!chave) { console.error('[PACTO] Chave não disponível:', campoChave); return null; }
  const cacheKey = endpoint + JSON.stringify(headersExtras);
  if (_pactoCache[cacheKey]) return _pactoCache[cacheKey];
  try {
    const resp = await fetch(PACTO_BASE + endpoint, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + chave,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...headersExtras
      }
    });
    if (!resp.ok) {
      console.error('[PACTO] Erro HTTP', resp.status, endpoint);
      return null;
    }
    const data = await resp.json();
    _pactoCache[cacheKey] = data;
    return data;
  } catch(e) {
    console.error('[PACTO] Erro de conexão:', e.message, endpoint);
    return null;
  }
}

// ── Busca professores ativos da unidade (retorna array com codigoPessoa) ──
// Usa chave ADM + empresaId no header
// ── Busca professores do Treino Web com indicadores já calculados ────
// Endpoint BI: retorna só quem tem vínculo ativo com alunos no Treino Web
// Campos retornados: biTreinoTreinamento, alunosAtivosComTreino,
//   alunosAtivosSemTreino, alunosProgramaVencidos, + distribuição semanal
async function pactoBuscarProfessoresBI(empresaId) {
  const data = await pactoChamar('/psec/colaboradores/bi-professores-vinculos', 'premium24h_treino', { empresaId: String(empresaId) });
  if (!data) return [];
  if (Array.isArray(data)) return data;
  // Resposta pode estar em data.content
  if (data.content && Array.isArray(data.content)) return data.content;
  const chave = Object.keys(data).find(k => Array.isArray(data[k]));
  return chave ? data[chave] : [];
}

// Mantida para compatibilidade — usa chave ADM, retorna todos os colaboradores
async function pactoBuscarProfessores(empresaId) {
  const data = await pactoChamar('/colaboradores/professores-ativos', 'premium24h_adm', { empresaId: String(empresaId) });
  if (!data) return [];
  if (Array.isArray(data)) return data;
  const chave = Object.keys(data).find(k => Array.isArray(data[k]));
  return chave ? data[chave] : [];
}

// ── Busca dados de carteira de um professor (chave Treino) ────────────
async function pactoBuscarCarteira(codigoPessoa, empresaId) {
  const hdr = { empresaId: String(empresaId) };
  const [ativos, semTreino, vencidos, comTreino] = await Promise.all([
    pactoChamar(`/psec/treino-bi/alunos-ativos/${codigoPessoa}`,           'premium24h_treino', hdr),
    pactoChamar(`/psec/treino-bi/alunos-ativo-sem-treino/${codigoPessoa}`, 'premium24h_treino', hdr),
    pactoChamar(`/psec/treino-bi/alunos-treino-vencido/${codigoPessoa}`,   'premium24h_treino', hdr),
    pactoChamar(`/psec/treino-bi/alunos-ativos-treino/${codigoPessoa}`,    'premium24h_treino', hdr),
  ]);
  // Resposta paginada: { content:[...], quantidadeTotalElementos, size }
  const contar = d => {
    if (!d) return 0;
    if (Array.isArray(d)) return d.length;
    if (typeof d === 'object') {
      if (d.quantidadeTotalElementos !== undefined) return d.quantidadeTotalElementos;
      const k = Object.keys(d).find(x => Array.isArray(d[x]));
      return k ? d[k].length : (d.total || d.quantidade || d.count || 0);
    }
    return 0;
  };
  return {
    ativos:    contar(ativos),
    semTreino: contar(semTreino),
    vencidos:  contar(vencidos),
    comTreino: contar(comTreino),
    _raw: { ativos, semTreino, vencidos, comTreino }
  };
}

// ── Extrai nome do objeto professor ──────────────────────────────────
// Suporta dois formatos: objeto plano (professores-ativos) e aninhado (bi-professores-vinculos)
function pactoNomeProfessor(p) {
  if (!p) return '?';
  if (p.professor) return p.professor.nome || '?';    // bi-professores-vinculos
  if (p.pessoa)    return p.pessoa.nome || '?';        // professores-ativos
  return p.nome || p.nomeColaborador || '?';
}

// ── Extrai objeto normalizado de indicadores do professor BI ─────────
function pactoNormalizarProfessor(p) {
  if (!p) return null;
  // Formato: { professor: {...}, biTreinoTreinamentoDTO: {...} }
  const prof = p.professor || p;
  const bi   = p.biTreinoTreinamentoDTO || {};
  return {
    codigo:    prof.codigoPessoa || prof.id || prof.codigo || null,
    nome:      prof.nome || '?',
    comTreino: bi.alunosAtivosComTreino    ?? null,
    emDia:     bi.alunosAtivosProgramaEmDia ?? null,
    vencidos:  bi.alunosProgramaVencidos   ?? null,
    aRenovar:  bi.alunosProgramaRenovar    ?? bi.alunosProgramaARenovar ?? null,
    semTreino: bi.alunosAtivosSemTreino    ?? null,
  };
}

// ── TESTE: descobre professores e loga estrutura no console ───────────
// Chame pactoTesteDescoberta() no console do navegador para validar
async function pactoTesteDescoberta(empresaId) {
  console.group('[PACTO] 🔍 Descoberta de professores');
  console.log('empresaId:', empresaId);
  const profs = await pactoBuscarProfessores(empresaId);
  console.log('Total de professores retornados:', profs.length);
  if (profs.length > 0) {
    console.log('Estrutura do primeiro professor:', profs[0]);
    console.log('Campos disponíveis:', Object.keys(profs[0]));
    console.table(profs.slice(0, 10));
  } else {
    console.warn('Nenhum professor retornado — verifique empresaId e escopo da chave ADM');
  }
  console.groupEnd();
  return profs;
}
