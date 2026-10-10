/**
 * Audita cruzamentos matriculados × janela × avaliacoes e compara a coorte
 * mensal com os indicadores oficiais agregados da Pacto (MCP).
 * Uso: node scripts/audit-cruzamentos.js
 */
const https = require('https');

const URLS = {
  matriculados: 'https://n8n2.mov.pro.br/webhook/matriculados_mes',
  janela: 'https://n8n2.mov.pro.br/webhook/janela_de_treino',
  avaliacoesAtrasadas: 'https://n8n2.mov.pro.br/webhook/avaliacoes_atrasadas',
  avaliacoesRealizadas: 'https://n8n2.mov.pro.br/webhook/avaliacoes_realizadas',
  indicadoresPacto: 'https://n8n2.mov.pro.br/webhook/pacto_indicadores',
};

const UNIDADE_MAP = {
  medicilandia: { codigo: 1, slug: 'medicilandia' },
  itaituba: { codigo: 2, slug: 'itaituba' },
  premium24: { codigo: 3, slug: 'santarem_24h' },
  nrexpress: { codigo: 5, slug: 'santarem_nova_republica' },
};

function post(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = '{}';
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Parse ${url}: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('timeout')));
    req.write(body);
    req.end();
  });
}

function norm(mat) {
  if (mat == null || mat === '') return '';
  const s = String(mat).trim();
  return s.replace(/^0+/, '') || '0';
}

function findUnit(data, unidId) {
  const ref = UNIDADE_MAP[unidId];
  if (!ref || !data?.unidades) return null;
  return data.unidades.find(u => u.unidade_codigo === ref.codigo || u.unidade_nome === ref.slug) || null;
}

/** Mapa simples (último registro vence) — detecta duplicatas na origem. */
function buildMapNaive(alunos, campo) {
  const map = new Map();
  const dups = [];
  (alunos || []).forEach(a => {
    const k = norm(a[campo] ?? a.matricula);
    if (!k) return;
    if (map.has(k)) dups.push(k);
    map.set(k, a);
  });
  return { map, dups };
}

/** Igual ao app: em duplicata mantém registro mais recente. */
function buildMapDedup(alunos, campo) {
  const map = new Map();
  (alunos || []).forEach(a => {
    const k = norm(a[campo] ?? a.matricula);
    if (!k) return;
    const prev = map.get(k);
    if (!prev) { map.set(k, a); return; }
    const dtA = new Date(a.atualizado_em || a.coletado_em || 0).getTime();
    const dtB = new Date(prev.atualizado_em || prev.coletado_em || 0).getTime();
    if (dtA >= dtB) map.set(k, a);
  });
  return map;
}

function janelaTodos(u) {
  const a = u?.alunos || {};
  if (a.todos?.length) return a.todos;
  return [...(a.em_dia || []), ...(a.a_vencer || []), ...(a.vencidos || []), ...(a.sem_treino || [])];
}

function matriculadosLista(u) {
  return u?.matriculados || u?.alunos || [];
}

async function main() {
  console.log('Buscando webhooks…');
  const [matric, janela, avalAtr, avalReal, indicadoresPacto] = await Promise.all([
    post(URLS.matriculados),
    post(URLS.janela),
    post(URLS.avaliacoesAtrasadas),
    post(URLS.avaliacoesRealizadas),
    post(URLS.indicadoresPacto),
  ]);

  console.log('\n=== RESUMO WEBHOOKS ===');
  console.log('Matriculados:', matric?.unidades?.length, 'unidades, competência', matric?.competencia);
  console.log('Janela:', janela?.unidades?.length, 'unidades');
  console.log('Avaliações atrasadas:', avalAtr?.total_alunos, 'alunos,', avalAtr?.total_unidades, 'unidades');
  console.log('Avaliações realizadas:', avalReal?.total_alunos ?? (avalReal?.unidades ? 'ok' : 'ERRO'), avalReal?.code != null ? `(HTTP erro: ${avalReal.message || avalReal.code})` : '');
  console.log('Indicadores Pacto MCP:', indicadoresPacto?.unidades?.length, 'unidades, competencia', indicadoresPacto?.competencia);

  for (const [unidId, ref] of Object.entries(UNIDADE_MAP)) {
    const um = findUnit(matric, unidId);
    const uj = findUnit(janela, unidId);
    const uaAtr = findUnit(avalAtr, unidId);
    const uaReal = findUnit(avalReal, unidId);
    const pacto = findUnit(indicadoresPacto, unidId);
    const lista = matriculadosLista(um);
    if (!lista.length) {
      console.log(`\n--- ${unidId}: sem matriculados ---`);
      continue;
    }

    const jAlunos = janelaTodos(uj);
    const jNaive = buildMapNaive(jAlunos, 'matricula');
    const jMap = { map: buildMapDedup(jAlunos, 'matricula'), dups: jNaive.dups };
    const aAtrNaive = buildMapNaive(uaAtr?.alunos, 'matricula');
    const aAtrMap = { map: buildMapDedup(uaAtr?.alunos, 'matricula'), dups: aAtrNaive.dups };
    const aRealNaive = buildMapNaive(uaReal?.alunos, 'matricula');
    const aRealMap = { map: buildMapDedup(uaReal?.alunos, 'matricula'), dups: aRealNaive.dups };
    let hitJ = 0, hitAtr = 0, hitReal = 0;
    let atrasada = 0, realizada = 0, semAv = 0;
    const semJanela = [];
    const temReal = aRealMap.map.size > 0;
    const temAtr = aAtrMap.map.size > 0;

    lista.forEach(m => {
      const k = norm(m.matricula);
      if (jMap.map.has(k)) hitJ++; else semJanela.push(m.matricula);
      const isAtr = aAtrMap.map.has(k);
      const isReal = aRealMap.map.has(k);
      if (isAtr) { hitAtr++; atrasada++; }
      else if (isReal) { hitReal++; realizada++; }
      else if (temReal || temAtr) semAv++;
    });

    console.log(`\n--- ${unidId} (${ref.slug}) — ${lista.length} matriculados ---`);
    console.log(`  Janela: ${hitJ}/${lista.length} (${Math.round(hitJ / lista.length * 100)}%) | mapa=${jMap.map.size} dups=${jMap.dups.length}`);
    console.log(`  Aval. atrasadas: ${hitAtr}/${lista.length} | mapa=${aAtrMap.map.size}`);
    console.log(`  Aval. realizadas: ${hitReal}/${lista.length} | mapa=${aRealMap.map.size}${!temReal ? ' (webhook indisponível?)' : ''}`);
    console.log(`  Sem avaliação: ${semAv}`);
    const ativosOficiais = Number(pacto?.alunos_ativos);
    if (Number.isFinite(ativosOficiais)) {
      const diferenca = ativosOficiais - lista.length;
      console.log(
        `  Pacto MCP: ${ativosOficiais} alunos ativos | ` +
        `coorte matriculados no mês: ${lista.length} | diferença: ${diferenca >= 0 ? '+' : ''}${diferenca}`
      );
    } else {
      console.log('  Pacto MCP: total oficial indisponível para esta unidade');
    }
    if (jMap.dups.length) console.log('  ⚠ matrículas duplicadas janela:', [...new Set(jMap.dups)].slice(0, 5));
    if (semJanela.length <= 5) console.log('  Sem janela:', semJanela.join(', '));
    else console.log(`  Sem janela: ${semJanela.length} (ex: ${semJanela.slice(0, 3).join(', ')})`);

    if (temReal && atrasada + realizada + semAv !== lista.length) {
      console.log(`  ⚠ Partição avaliação: atrasada+realizada+sem=${atrasada + realizada + semAv} ≠ ${lista.length}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
