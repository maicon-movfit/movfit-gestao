$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$output = Join-Path $repo 'n8n\workflow-webhook-fechamento-semanal-avaliacoes.json'

$prepareCode = @'
const entrada = $input.first().json;
const body = entrada.body || entrada;
const query = entrada.query || {};

const unidadeInformada = String(
  body.unidade || query.unidade || body.unidade_codigo || query.unidade_codigo || ''
).trim().toLowerCase();

const unidades = {
  '1': { codigo: 1, slug: 'medicilandia' },
  medicilandia: { codigo: 1, slug: 'medicilandia' },
  '2': { codigo: 2, slug: 'itaituba' },
  itaituba: { codigo: 2, slug: 'itaituba' },
  '3': { codigo: 3, slug: 'santarem_24h' },
  stm_24h: { codigo: 3, slug: 'santarem_24h' },
  santarem_24h: { codigo: 3, slug: 'santarem_24h' },
  '5': { codigo: 5, slug: 'santarem_nova_republica' },
  stm_nova_republica: { codigo: 5, slug: 'santarem_nova_republica' },
  santarem_nova_republica: { codigo: 5, slug: 'santarem_nova_republica' },
  '6': { codigo: 6, slug: 'novo_progresso' },
  novo_progresso: { codigo: 6, slug: 'novo_progresso' },
};

const unidade = unidades[unidadeInformada];
if (!unidade) {
  throw new Error('Unidade invalida. Use medicilandia, itaituba, stm_24h, stm_nova_republica ou novo_progresso.');
}

const inicio = String(body.data_inicio || query.data_inicio || '').trim();
const fim = String(body.data_fim || query.data_fim || '').trim();
const formato = /^\d{4}-\d{2}-\d{2}$/;

if (!formato.test(inicio) || !formato.test(fim)) {
  throw new Error('data_inicio e data_fim sao obrigatorias no formato AAAA-MM-DD.');
}

const inicioData = new Date(inicio + 'T12:00:00.000Z');
const fimData = new Date(fim + 'T12:00:00.000Z');
if (Number.isNaN(inicioData.getTime()) || Number.isNaN(fimData.getTime()) || inicioData > fimData) {
  throw new Error('Periodo invalido.');
}

const dias = Math.floor((fimData - inicioData) / 86400000) + 1;
if (dias > 31) {
  throw new Error('O periodo maximo permitido e de 31 dias.');
}

return [{ json: {
  unidade_codigo: unidade.codigo,
  unidade: unidade.slug,
  data_inicio: inicio,
  data_fim: fim,
} }];
'@

$query = @'
WITH parametros AS (
    SELECT
        $1::integer AS unidade_codigo,
        $2::date AS data_inicio,
        $3::date AS data_fim
),
dias AS (
    SELECT generate_series(p.data_inicio, p.data_fim, interval '1 day')::date AS data
    FROM parametros p
),
contagens AS (
    SELECT
        a.data_referencia AS data,
        SUM(a.quantidade) FILTER (WHERE a.tipo_avaliacao = 'bio_nova')::integer AS bio_novas,
        SUM(a.quantidade) FILTER (WHERE a.tipo_avaliacao = 'reavaliacao')::integer AS reavaliacoes,
        COUNT(*) FILTER (WHERE a.tipo_avaliacao IN ('bio_nova', 'reavaliacao'))::integer AS linhas_dia
    FROM public.avaliacoes_fisicas_diarias a
    CROSS JOIN parametros p
    WHERE a.unidade_codigo = p.unidade_codigo
      AND a.data_referencia BETWEEN p.data_inicio AND p.data_fim
    GROUP BY a.data_referencia
),
metadata AS (
    SELECT MAX(a.coletado_em) AS atualizado_em
    FROM public.avaliacoes_fisicas_diarias a
    CROSS JOIN parametros p
    WHERE a.unidade_codigo = p.unidade_codigo
      AND a.data_referencia BETWEEN p.data_inicio AND p.data_fim
),
atrasadas AS (
    SELECT COUNT(DISTINCT COALESCE(NULLIF(a.matricula, ''), a.codigo_cliente::text))::integer AS quantidade
    FROM public.alunos_avaliacao_atrasada a
    CROSS JOIN parametros p
    WHERE a.unidade_codigo = p.unidade_codigo
),
sem_avaliacao AS (
    SELECT
        c.total_api::integer AS quantidade,
        c.coletado_em
    FROM public.coletas_alunos_sem_avaliacao c
    CROSS JOIN parametros p
    WHERE c.unidade_codigo = p.unidade_codigo
)
SELECT
    d.data,
    COALESCE(c.bio_novas, 0)::integer AS bio_novas,
    COALESCE(c.reavaliacoes, 0)::integer AS reavaliacoes,
    COALESCE(c.linhas_dia, 0)::integer AS linhas_dia,
    (SELECT quantidade FROM atrasadas) AS avaliacoes_atrasadas,
    (SELECT quantidade FROM sem_avaliacao) AS alunos_sem_avaliacao,
    (SELECT coletado_em FROM sem_avaliacao) AS sem_avaliacao_coletado_em,
    m.atualizado_em
FROM dias d
LEFT JOIN contagens c ON c.data = d.data
CROSS JOIN metadata m
ORDER BY d.data;
'@

$responseCode = @'
const entrada = $('Preparar consulta').first().json;
const linhas = $input.all().map(i => i.json);

if (!linhas.length) {
  throw new Error('A consulta nao retornou os dias do periodo.');
}

const dias = linhas.map(linha => ({
  data: String(linha.data).slice(0, 10),
  disponivel: Number(linha.linhas_dia || 0) === 2,
  bio_novas: Number(linha.bio_novas || 0),
  reavaliacoes: Number(linha.reavaliacoes || 0),
  total_avaliacoes: Number(linha.bio_novas || 0) + Number(linha.reavaliacoes || 0),
}));

const coletaDisponivel = dias.some(d => d.disponivel);
const periodoCompleto = dias.every(d => d.disponivel);
const semAvaliacaoColetadoEm = linhas[0].sem_avaliacao_coletado_em || null;
const semAvaliacaoTimestamp = semAvaliacaoColetadoEm
  ? new Date(semAvaliacaoColetadoEm).getTime()
  : NaN;
const semAvaliacaoIdadeMs = Date.now() - semAvaliacaoTimestamp;
const semAvaliacaoDisponivel = Number.isFinite(semAvaliacaoTimestamp)
  && semAvaliacaoIdadeMs >= -(5 * 60 * 1000)
  && semAvaliacaoIdadeMs <= (24 * 60 * 60 * 1000);

return [{ json: {
  sucesso: true,
  unidade: entrada.unidade,
  unidade_codigo: entrada.unidade_codigo,
  periodo_inicio: entrada.data_inicio,
  periodo_fim: entrada.data_fim,
  fonte: 'pacto_avaliacoes_fisicas_diarias',
  coleta_disponivel: coletaDisponivel,
  periodo_completo: periodoCompleto,
  dias,
  totais: {
    bio_novas: dias.reduce((s, d) => s + d.bio_novas, 0),
    reavaliacoes: dias.reduce((s, d) => s + d.reavaliacoes, 0),
    total_avaliacoes: dias.reduce((s, d) => s + d.total_avaliacoes, 0),
  },
  indicadores_semana: {
    alunos_sem_avaliacao: !semAvaliacaoDisponivel || linhas[0].alunos_sem_avaliacao == null
      ? null
      : Number(linhas[0].alunos_sem_avaliacao),
    avaliacoes_atrasadas: Number(linhas[0].avaliacoes_atrasadas || 0),
  },
  avisos: [
    ...(!periodoCompleto
      ? ['Alguns dias ainda nao possuem coleta; o dashboard deve aplicar somente dias com disponivel=true.']
      : []),
    ...(!semAvaliacaoDisponivel
      ? ['A coleta de alunos sem avaliacao esta ausente ou desatualizada; o campo permanece manual.']
      : []),
  ],
  sem_avaliacao_disponivel: semAvaliacaoDisponivel,
  sem_avaliacao_coletado_em: semAvaliacaoColetadoEm,
  atualizado_em: linhas[0].atualizado_em || null,
  gerado_em: $now.toUTC().toISO(),
} }];
'@

$nodes = @(
  @{
    parameters = @{ httpMethod = 'POST'; path = 'fechamento_semanal_avaliacoes'; responseMode = 'responseNode'; options = @{} }
    type = 'n8n-nodes-base.webhook'; typeVersion = 2.1; position = @(-480, 0)
    id = '5cf5bcf4-b0dc-45c9-959b-bd647966a547'; name = 'Webhook fechamento semanal avaliacoes'
    webhookId = '84eb4458-e709-490f-a51e-5fd3f2c75ed2'
  },
  @{
    parameters = @{ jsCode = $prepareCode }
    type = 'n8n-nodes-base.code'; typeVersion = 2; position = @(-240, 0)
    id = '2f3cd742-d42e-45c2-b06a-63b095de9581'; name = 'Preparar consulta'
  },
  @{
    parameters = @{
      operation = 'executeQuery'; query = $query
      options = @{ queryReplacement = '={{ [$json.unidade_codigo, $json.data_inicio, $json.data_fim] }}' }
    }
    type = 'n8n-nodes-base.postgres'; typeVersion = 2.6; position = @(0, 0)
    id = 'bafc4901-d871-4f3b-994f-16ca4e43034c'; name = 'Consultar fechamento no Postgres'
    credentials = @{ postgres = @{ id = 'jnHp29TLth10XuTY'; name = 'Movfit' } }
  },
  @{
    parameters = @{ jsCode = $responseCode }
    type = 'n8n-nodes-base.code'; typeVersion = 2; position = @(240, 0)
    id = 'b47bf612-168b-44cb-9179-3f663351f914'; name = 'Montar fechamento semanal'
  },
  @{
    parameters = @{ respondWith = 'json'; responseBody = '={{ $json }}'; options = @{} }
    type = 'n8n-nodes-base.respondToWebhook'; typeVersion = 1.5; position = @(480, 0)
    id = '784615f8-c196-4bff-94a0-405169fc45ef'; name = 'Responder fechamento semanal'
  }
)

$connections = [ordered]@{
  'Webhook fechamento semanal avaliacoes' = @{ main = @(,@(@{ node = 'Preparar consulta'; type = 'main'; index = 0 })) }
  'Preparar consulta' = @{ main = @(,@(@{ node = 'Consultar fechamento no Postgres'; type = 'main'; index = 0 })) }
  'Consultar fechamento no Postgres' = @{ main = @(,@(@{ node = 'Montar fechamento semanal'; type = 'main'; index = 0 })) }
  'Montar fechamento semanal' = @{ main = @(,@(@{ node = 'Responder fechamento semanal'; type = 'main'; index = 0 })) }
}

$workflow = [ordered]@{
  nodes = $nodes; connections = $connections; pinData = @{}
  meta = @{ templateCredsSetupCompleted = $true; instanceId = '79075fb22e5045e1beb3493444de048310c5aee705e7f3d3f6b2ea7d89bc4b09' }
}

[System.IO.File]::WriteAllText(
  $output,
  ($workflow | ConvertTo-Json -Depth 100),
  [System.Text.UTF8Encoding]::new($false)
)
Write-Output $output
