$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$output = Join-Path $repo 'n8n\workflow-avaliacoes-diarias-todas-unidades.json'
$endpoint = 'https://apigw.pactosolucoes.com.br/psec/avaliacao-fisica-bi/avaliacoes'

$units = @(
  @{ Key = 'stm24'; Name = 'Santarem 24h'; Code = 3; Slug = 'santarem_24h'; Empresa = 1; Delay = 0; Y = 0 },
  # O endpoint TreinoWeb usa uma credencial por tenant; dentro de cada tenant a empresa e 1.
  @{ Key = 'novarep'; Name = 'Nova Republica'; Code = 5; Slug = 'santarem_nova_republica'; Empresa = 1; Delay = 20; Y = 240 },
  @{ Key = 'itaituba'; Name = 'Itaituba'; Code = 2; Slug = 'itaituba'; Empresa = 1; Delay = 40; Y = 480 },
  @{ Key = 'medicilandia'; Name = 'Medicilandia'; Code = 1; Slug = 'medicilandia'; Empresa = 1; Delay = 60; Y = 720 },
  @{ Key = 'novoprogresso'; Name = 'Novo Progresso'; Code = 6; Slug = 'novo_progresso'; Empresa = 1; Delay = 80; Y = 960 }
)

$nodes = [System.Collections.Generic.List[object]]::new()
$connections = [ordered]@{}

function Add-Connection([string]$From, [string]$To) {
  $connections[$From] = @{ main = @(,@(@{ node = $To; type = 'main'; index = 0 })) }
}

$nodes.Add(@{
  parameters = @{ rule = @{ interval = @(@{ field = 'hours'; hoursInterval = 6 }) } }
  type = 'n8n-nodes-base.scheduleTrigger'; typeVersion = 1.3
  position = @(-760, 480); id = '1b9fd3e0-9156-4e98-8454-efb490be37c2'; name = 'A cada 6 horas'
})

$sql = @'
WITH dados AS (
    SELECT *
    FROM jsonb_to_recordset($1::jsonb) AS d(
        unidade_codigo integer,
        unidade_nome text,
        empresa_api_id integer,
        data_referencia date,
        tipo_avaliacao text,
        quantidade integer,
        coletado_em timestamptz
    )
),
salvos AS (
    INSERT INTO public.avaliacoes_fisicas_diarias AS destino (
        unidade_codigo, unidade_nome, empresa_api_id, data_referencia,
        tipo_avaliacao, quantidade, coletado_em, atualizado_em
    )
    SELECT
        unidade_codigo, unidade_nome, empresa_api_id, data_referencia,
        tipo_avaliacao, quantidade, coletado_em, now()
    FROM dados
    ON CONFLICT (unidade_codigo, data_referencia, tipo_avaliacao)
    DO UPDATE SET
        unidade_nome = EXCLUDED.unidade_nome,
        empresa_api_id = EXCLUDED.empresa_api_id,
        quantidade = EXCLUDED.quantidade,
        coletado_em = EXCLUDED.coletado_em,
        atualizado_em = now()
    RETURNING 1
)
SELECT
    $2::text AS unidade,
    COUNT(*)::integer AS registros_salvos,
    MIN(data_referencia) AS periodo_inicio,
    MAX(data_referencia) AS periodo_fim,
    MAX(coletado_em) AS coletado_em
FROM dados
WHERE EXISTS (SELECT 1 FROM salvos);
'@

foreach ($u in $units) {
  $configName = "Configurar $($u.Name)"
  $requestName = "Pacto avaliacoes $($u.Name)"
  $validateName = "Validar e agrupar $($u.Name)"
  $saveName = "Salvar avaliacoes $($u.Name)"
  $previous = 'A cada 6 horas'
  $x = -500

  if ($u.Delay -gt 0) {
    $waitName = "Aguardar $($u.Delay)s - $($u.Name)"
    $nodes.Add(@{
      parameters = @{ amount = $u.Delay; unit = 'seconds' }
      type = 'n8n-nodes-base.wait'; typeVersion = 1.1
      position = @(-610, $u.Y); id = [guid]::NewGuid().ToString(); name = $waitName
    })
    Add-Connection 'A cada 6 horas' $waitName
    $previous = $waitName
    $x = -380
  }

  $configCode = @"
const agora = `$now.setZone('America/Sao_Paulo');
const inicio = agora.startOf('month');
const fim = agora.endOf('day');
const base = {
  unidade_codigo: $($u.Code),
  unidade_nome: '$($u.Slug)',
  empresa_api_id: $($u.Empresa),
  periodo_inicio: inicio.toISODate(),
  periodo_fim: fim.toISODate(),
  coletado_em: agora.toUTC().toISO(),
  tamanho_pagina: 2000,
};
const indicadores = [
  ['todas', 'IND_AF_TODAS'],
  ['bio_nova', 'IND_AF_NOVAS'],
  ['reavaliacao', 'IND_AF_REAVALIACOES'],
];
return indicadores.map(([tipo, indicador]) => ({ json: {
  ...base,
  tipo,
  indicador,
  filters: JSON.stringify({
    dataInicio: inicio.toMillis(),
    dataFim: fim.toMillis(),
    professorId: -1,
    avaliadorId: -1,
    indicador,
    tipoAvaliacao: 'TODOS_PROFESSORES',
  }),
}}));
"@

  $nodes.Add(@{
    parameters = @{ jsCode = $configCode }
    type = 'n8n-nodes-base.code'; typeVersion = 2
    position = @($x, $u.Y); id = [guid]::NewGuid().ToString(); name = $configName
  })
  Add-Connection $previous $configName

  $nodes.Add(@{
    parameters = @{
      url = $endpoint
      authentication = 'genericCredentialType'
      genericAuthType = 'httpHeaderAuth'
      sendQuery = $true
      queryParameters = @{ parameters = @(
        @{ name = 'filters'; value = '={{ $json.filters }}' },
        @{ name = 'configs'; value = '={{ JSON.stringify({}) }}' },
        @{ name = 'page'; value = '0' },
        @{ name = 'size'; value = '={{ $json.tamanho_pagina }}' }
      ) }
      sendHeaders = $true
      headerParameters = @{ parameters = @(
        @{ name = 'accept'; value = 'application/json' },
        @{ name = 'empresaId'; value = '={{ String($json.empresa_api_id) }}' }
      ) }
      options = @{ response = @{ response = @{ responseFormat = 'json' } } }
    }
    type = 'n8n-nodes-base.httpRequest'; typeVersion = 4.4
    position = @(($x + 240), $u.Y); id = [guid]::NewGuid().ToString(); name = $requestName
    retryOnFail = $true; maxTries = 3; waitBetweenTries = 2000
  })
  Add-Connection $configName $requestName

  $validateCode = @"
const configs = `$('${configName}').all().map(i => i.json);
const responses = `$input.all().map(i => i.json);
if (configs.length !== 3 || responses.length !== 3) {
  throw new Error('Esperadas tres respostas: todas, novas e reavaliacoes.');
}
const porTipo = {};
for (let i = 0; i < configs.length; i++) {
  const cfg = configs[i];
  const res = responses[i];
  if (!Array.isArray(res.content) || !Number.isSafeInteger(Number(res.totalElements))) {
    throw new Error('Resposta invalida para ' + cfg.indicador + '.');
  }
  const total = Number(res.totalElements);
  if (total !== res.content.length || res.last !== true) {
    throw new Error('Coleta incompleta em ' + cfg.indicador + ': ' + res.content.length + '/' + total + '. Reduza o periodo ou implemente paginacao.');
  }
  porTipo[cfg.tipo] = { cfg, res, total };
}
if (porTipo.bio_nova.total + porTipo.reavaliacao.total !== porTipo.todas.total) {
  throw new Error('Divergencia Pacto: novas (' + porTipo.bio_nova.total + ') + reavaliacoes (' + porTipo.reavaliacao.total + ') != todas (' + porTipo.todas.total + ').');
}
const base = configs[0];
const inicio = new Date(base.periodo_inicio + 'T12:00:00.000Z');
const fim = new Date(base.periodo_fim + 'T12:00:00.000Z');
const contagens = { bio_nova: new Map(), reavaliacao: new Map() };
for (const tipo of ['bio_nova', 'reavaliacao']) {
  for (const item of porTipo[tipo].res.content) {
    const data = String(item.dataAvaliacao || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || data < base.periodo_inicio || data > base.periodo_fim) {
      throw new Error('Data de avaliacao invalida em ' + tipo + ': ' + data + '.');
    }
    contagens[tipo].set(data, (contagens[tipo].get(data) || 0) + 1);
  }
}
const registros = [];
for (let dia = new Date(inicio); dia <= fim; dia.setUTCDate(dia.getUTCDate() + 1)) {
  const data = dia.toISOString().slice(0, 10);
  for (const tipo of ['bio_nova', 'reavaliacao']) {
    registros.push({
      unidade_codigo: base.unidade_codigo,
      unidade_nome: base.unidade_nome,
      empresa_api_id: base.empresa_api_id,
      data_referencia: data,
      tipo_avaliacao: tipo,
      quantidade: contagens[tipo].get(data) || 0,
      coletado_em: base.coletado_em,
    });
  }
}
return [{ json: { unidade: base.unidade_nome, registros, coletado_em: base.coletado_em } }];
"@

  $nodes.Add(@{
    parameters = @{ jsCode = $validateCode }
    type = 'n8n-nodes-base.code'; typeVersion = 2
    position = @(($x + 480), $u.Y); id = [guid]::NewGuid().ToString(); name = $validateName
  })
  Add-Connection $requestName $validateName

  $nodes.Add(@{
    parameters = @{
      operation = 'executeQuery'; query = $sql
      options = @{ queryReplacement = '={{ [JSON.stringify($json.registros), $json.unidade] }}' }
    }
    type = 'n8n-nodes-base.postgres'; typeVersion = 2.6
    position = @(($x + 720), $u.Y); id = [guid]::NewGuid().ToString(); name = $saveName
    credentials = @{ postgres = @{ id = 'jnHp29TLth10XuTY'; name = 'Movfit' } }
  })
  Add-Connection $validateName $saveName
}

$workflow = [ordered]@{
  nodes = $nodes
  connections = $connections
  pinData = @{}
  meta = @{ templateCredsSetupCompleted = $true; instanceId = '79075fb22e5045e1beb3493444de048310c5aee705e7f3d3f6b2ea7d89bc4b09' }
}

[System.IO.File]::WriteAllText(
  $output,
  ($workflow | ConvertTo-Json -Depth 100),
  [System.Text.UTF8Encoding]::new($false)
)
Write-Output $output
