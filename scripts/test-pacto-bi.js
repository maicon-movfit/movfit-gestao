/**
 * Testa BI Pacto por unidade — uso: node scripts/test-pacto-bi.js
 */
const https = require('https');

const token = 'movfit_proxy_k7x9m2pQ4wR9';
const base = 'https://n8n2.mov.pro.br/webhook/movfit/pacto';

function post(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(base);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Movfit-Proxy': token,
        'Content-Length': Buffer.byteLength(data),
      },
    }, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(buf) }); }
        catch (e) { resolve({ status: res.statusCode, raw: buf.slice(0, 800) }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function extrairLista(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.professores)) return data.professores;
  if (Array.isArray(data.content)) return data.content;
  if (data.dados && Array.isArray(data.dados[0]?.content)) return data.dados[0].content;
  return [];
}

function num(p, ...keys) {
  for (const k of keys) {
    if (p[k] != null && p[k] !== '') return Number(p[k]) || 0;
  }
  return 0;
}

async function main() {
  const unidades = [
    ['medicilandia', 'medicilandia', 'stm_medicilandia'],
    ['premium24', 'stmpremium24', 'stm_24h'],
  ];
  for (const [unidId, action, unidade] of unidades) {
    const r = await post({ action, tipo: 'bi', empresaId: '1', unidId, unidade });
    const flat = extrairLista(r.data);
    let com = 0; let em = 0; let ven = 0; let sem = 0;
    flat.forEach(p => {
      com += num(p, 'com_treino', 'comTreino');
      em += num(p, 'em_dia', 'emDia');
      ven += num(p, 'vencidos', 'vencido');
      sem += num(p, 'sem_treino', 'semTreino');
    });
    const atualizado = flat[0]?.atualizado_em || flat[0]?.atualizadoEm || flat[0]?.coletado_em || '?';
    console.log(`\n=== ${unidId} HTTP ${r.status} | ${flat.length} profs ===`);
    console.log(`  comTreino=${com} emDia=${em} vencidos=${ven} semTreino=${sem}`);
    console.log(`  atualizado_em: ${atualizado}`);
    if (flat[0]) console.log(`  amostra: ${flat[0].nome} com=${num(flat[0], 'com_treino', 'comTreino')} em=${num(flat[0], 'em_dia', 'emDia')}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
