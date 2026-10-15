const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'n8n', 'workflow-alunos-sem-avaliacao-todas-unidades.json');

const units = [
  { code: 5, name: 'santarem_nova_republica', label: 'Nova Republica', minute: 0, y: 0 },
  { code: 3, name: 'santarem_24h', label: 'Santarem 24h', minute: 5, y: 320 },
  { code: 2, name: 'itaituba', label: 'Itaituba', minute: 10, y: 640 },
  { code: 1, name: 'medicilandia', label: 'Medicilandia', minute: 15, y: 960 },
  { code: 6, name: 'novo_progresso', label: 'Novo Progresso', minute: 20, y: 1280 },
];

const nodes = [];
const connections = {};

function add(node) {
  nodes.push(node);
  return node;
}

function connect(from, output, to) {
  if (!connections[from]) connections[from] = { main: [] };
  while (connections[from].main.length <= output) connections[from].main.push([]);
  connections[from].main[output].push({ node: to, type: 'main', index: 0 });
}

const createPagesCode = `const resposta = $input.first().json;
const total = Number(resposta.totalElements ?? resposta.data?.totalElements ?? 0);
const cfg = $('__CONFIG__').first().json;
const tamanho = Number(cfg.tamanho_pagina || 50);
if (!Number.isInteger(total) || total < 0) throw new Error('totalElements invalido: ' + total);
const paginas = Math.max(1, Math.ceil(total / tamanho));
return Array.from({ length: paginas }, (_, pagina) => ({ json: {
  pagina, tamanho, total_esperado: total, sem_dados: total === 0
} }));`;

const normalizeCode = `const resposta = $input.first().json;
const controle = $('__LOOP__').item.json;
const cfg = $('__CONFIG__').first().json;
const alunos = Array.isArray(resposta.content) ? resposta.content
  : Array.isArray(resposta.data?.content) ? resposta.data.content : null;
if (!alunos) throw new Error('Resposta sem content: ' + JSON.stringify(resposta).slice(0, 800));
if (controle.sem_dados) return [{ json: { controle_sem_dados: true, total_esperado: 0 } }];
if (!alunos.length) throw new Error('Pagina ' + controle.pagina + ' vazia com total esperado ' + controle.total_esperado);
const coletadoEm = new Date().toISOString();
const texto = v => v == null || String(v).trim() === '' || String(v).trim() === '-' ? null : String(v).trim();
const numero = v => v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
return alunos.map((a, indice) => {
  const codigo = numero(a.codCliente ?? a.codigoCliente ?? a.codigo_cliente);
  const matricula = texto(a.matricula);
  const nome = texto(a.nome ?? a.nomeAluno ?? a.nome_aluno);
  if (codigo == null || !matricula || !nome) throw new Error('Aluno invalido na pagina ' + controle.pagina + ', item ' + indice);
  return { json: {
    unidade_codigo: cfg.unidade_codigo,
    unidade_nome: cfg.unidade_nome,
    codigo_cliente: codigo,
    matricula,
    nome_aluno: nome,
    nome_avaliador: texto(a.avaliador ?? a.nomeAvaliador),
    nome_professor: texto(a.professor ?? a.nomeProfessor),
    observacao: texto(a.obs ?? a.observacao),
    modalidade: texto(a.modalidade),
    indicador: cfg.indicador,
    pagina_origem: Number(controle.pagina),
    coletado_em: coletadoEm,
    total_esperado: Number(controle.total_esperado)
  } };
});`;

const prepareCode = `const cfg = $('__CONFIG__').first().json;
const itens = $input.all().map(i => i.json);
const semDados = itens.some(i => i.controle_sem_dados === true);
const registros = semDados ? [] : itens.filter(i => i.codigo_cliente != null);
const esperados = semDados ? 0 : Number(registros[0]?.total_esperado ?? -1);
const unicos = new Map();
for (const r of registros) unicos.set(String(r.codigo_cliente), r);
if (esperados < 0 || registros.length !== esperados || unicos.size !== esperados) {
  throw new Error('Coleta incompleta: esperados=' + esperados + ', recebidos=' + registros.length + ', unicos=' + unicos.size);
}
const alunos = [...unicos.values()].map(({ total_esperado, ...r }) => r);
return [{ json: {
  unidade_codigo: cfg.unidade_codigo,
  unidade_nome: cfg.unidade_nome,
  indicador: cfg.indicador,
  total_api: esperados,
  coletado_em: new Date().toISOString(),
  alunos_json: JSON.stringify(alunos)
} }];`;

const saveQuery = `WITH recebidos AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS d(
        unidade_codigo integer, unidade_nome text, codigo_cliente bigint,
        matricula text, nome_aluno text, nome_avaliador text,
        nome_professor text, observacao text, modalidade text,
        indicador text, pagina_origem integer, coletado_em timestamptz
    )
), gravados AS (
    INSERT INTO public.alunos_sem_avaliacao AS destino (
        unidade_codigo, unidade_nome, codigo_cliente, matricula, nome_aluno,
        nome_avaliador, nome_professor, observacao, modalidade, indicador,
        pagina_origem, coletado_em, atualizado_em
    )
    SELECT unidade_codigo, unidade_nome, codigo_cliente, matricula, nome_aluno,
        nome_avaliador, nome_professor, observacao, modalidade, indicador,
        pagina_origem, coletado_em, now()
    FROM recebidos
    ON CONFLICT (unidade_codigo, codigo_cliente) DO UPDATE SET
        unidade_nome=EXCLUDED.unidade_nome, matricula=EXCLUDED.matricula,
        nome_aluno=EXCLUDED.nome_aluno, nome_avaliador=EXCLUDED.nome_avaliador,
        nome_professor=EXCLUDED.nome_professor, observacao=EXCLUDED.observacao,
        modalidade=EXCLUDED.modalidade, indicador=EXCLUDED.indicador,
        pagina_origem=EXCLUDED.pagina_origem, coletado_em=EXCLUDED.coletado_em,
        atualizado_em=now()
    RETURNING 1
), removidos AS (
    DELETE FROM public.alunos_sem_avaliacao a
    WHERE a.unidade_codigo=$2::integer
      AND NOT EXISTS (SELECT 1 FROM recebidos r
        WHERE r.unidade_codigo=a.unidade_codigo AND r.codigo_cliente=a.codigo_cliente)
    RETURNING 1
), controle AS (
    INSERT INTO public.coletas_alunos_sem_avaliacao
        (unidade_codigo, unidade_nome, indicador, total_api, coletado_em, atualizado_em)
    VALUES ($2::integer, $3::text, $4::text, $5::integer, $6::timestamptz, now())
    ON CONFLICT (unidade_codigo) DO UPDATE SET
        unidade_nome=EXCLUDED.unidade_nome, indicador=EXCLUDED.indicador,
        total_api=EXCLUDED.total_api, coletado_em=EXCLUDED.coletado_em,
        atualizado_em=now()
    RETURNING 1
)
SELECT $2::integer AS unidade_codigo, $3::text AS unidade_nome,
  (SELECT count(*)::integer FROM gravados) AS registros_gravados,
  (SELECT count(*)::integer FROM removidos) AS registros_removidos,
  $5::integer AS total_atual, $6::timestamptz AS coletado_em
WHERE EXISTS (SELECT 1 FROM controle);`;

for (const unit of units) {
  const suffix = String(unit.code);
  const schedule = `Agendar ${unit.label}`;
  const config = `Configurar ${unit.label}`;
  const first = `Consultar total ${unit.label}`;
  const pages = `Criar paginas ${unit.label}`;
  const loop = `Paginar ${unit.label}`;
  const fetch = `Buscar pagina ${unit.label}`;
  const normalize = `Normalizar ${unit.label}`;
  const wait = `Aguardar ${unit.label}`;
  const prepare = `Conferir coleta ${unit.label}`;
  const save = `Salvar sem avaliacao ${unit.label}`;

  add({ id: `schedule-${suffix}`, name: schedule, type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.3,
    position: [-720, unit.y], parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 6, triggerAtMinute: unit.minute }] } } });
  add({ id: `config-${suffix}`, name: config, type: 'n8n-nodes-base.code', typeVersion: 2,
    position: [-500, unit.y], parameters: { jsCode: `const agora = $now.setZone('America/Sao_Paulo');\nconst inicio = agora.set({ day: 1 });\nconst filtros = { dataInicio: inicio.toMillis(), dataFim: agora.toMillis(), professorId: -1, avaliadorId: -1, indicador: 'IND_AF_ATIVOS_SEM', tipoAvaliacao: 'TODOS_PROFESSORES' };\nreturn [{ json: { unidade_codigo: ${unit.code}, unidade_nome: '${unit.name}', tamanho_pagina: 50, indicador: filtros.indicador, filters_json: JSON.stringify(filtros), iniciado_em: agora.toUTC().toISO() } }];` } });
  const httpBase = {
    url: 'https://apigw.pactosolucoes.com.br/psec/avaliacao-fisica-bi/avaliacoes',
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendQuery: true, sendHeaders: true,
    headerParameters: { parameters: [{ name: 'accept', value: 'application/json' }, { name: 'empresaId', value: '1' }] },
    options: { response: { response: { responseFormat: 'json' } } }
  };
  add({ id: `first-${suffix}`, name: first, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4,
    position: [-280, unit.y], retryOnFail: true, parameters: { ...httpBase,
      queryParameters: { parameters: [{ name: 'filters', value: `={{ $('${config}').first().json.filters_json }}` }, { name: 'page', value: '0' }, { name: 'size', value: `={{ $json.tamanho_pagina }}` }] } },
    credentials: { httpHeaderAuth: { name: 'Pacto API' } } });
  add({ id: `pages-${suffix}`, name: pages, type: 'n8n-nodes-base.code', typeVersion: 2,
    position: [-60, unit.y], parameters: { jsCode: createPagesCode.replace('__CONFIG__', config) } });
  add({ id: `loop-${suffix}`, name: loop, type: 'n8n-nodes-base.splitInBatches', typeVersion: 3,
    position: [160, unit.y], parameters: { options: {} } });
  add({ id: `fetch-${suffix}`, name: fetch, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4,
    position: [380, unit.y + 80], retryOnFail: true, parameters: { ...httpBase,
      queryParameters: { parameters: [{ name: 'filters', value: `={{ $('${config}').first().json.filters_json }}` }, { name: 'page', value: '={{ $json.pagina }}' }, { name: 'size', value: '={{ $json.tamanho }}' }] } },
    credentials: { httpHeaderAuth: { name: 'Pacto API' } } });
  add({ id: `normalize-${suffix}`, name: normalize, type: 'n8n-nodes-base.code', typeVersion: 2,
    position: [600, unit.y + 80], parameters: { jsCode: normalizeCode.replace('__LOOP__', loop).replace('__CONFIG__', config) } });
  add({ id: `wait-${suffix}`, name: wait, type: 'n8n-nodes-base.wait', typeVersion: 1.1,
    position: [820, unit.y + 80], parameters: { amount: 1 } });
  add({ id: `prepare-${suffix}`, name: prepare, type: 'n8n-nodes-base.code', typeVersion: 2,
    position: [380, unit.y - 80], parameters: { jsCode: prepareCode.replace('__CONFIG__', config) } });
  add({ id: `save-${suffix}`, name: save, type: 'n8n-nodes-base.postgres', typeVersion: 2.6,
    position: [600, unit.y - 80], parameters: { operation: 'executeQuery', query: saveQuery,
      options: { queryReplacement: '={{ [$json.alunos_json, $json.unidade_codigo, $json.unidade_nome, $json.indicador, $json.total_api, $json.coletado_em] }}' } },
    credentials: { postgres: { id: 'jnHp29TLth10XuTY', name: 'Movfit' } } });

  connect(schedule, 0, config); connect(config, 0, first); connect(first, 0, pages);
  connect(pages, 0, loop); connect(loop, 0, prepare); connect(loop, 1, fetch);
  connect(fetch, 0, normalize); connect(normalize, 0, wait); connect(wait, 0, loop);
  connect(prepare, 0, save);
}

const workflow = {
  name: 'Pacto - Alunos sem avaliacao - todas as unidades',
  nodes, connections, pinData: {}, settings: { executionOrder: 'v1', timezone: 'America/Sao_Paulo' },
  meta: { templateCredsSetupCompleted: true }
};

fs.writeFileSync(output, JSON.stringify(workflow, null, 2) + '\n');
console.log(output);
