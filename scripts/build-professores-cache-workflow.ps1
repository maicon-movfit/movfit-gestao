param(
    [Parameter(Mandatory = $true)]
    [string]$Source
)

$ErrorActionPreference = 'Stop'
$workflow = Get-Content -LiteralPath $Source -Raw | ConvertFrom-Json

$branches = @(
    @{ Http = 'BI PROFESSORES4'; Code = 'Code in JavaScript1'; Db = 'cash stm_24h'; Unit = 'stm_24h'; Company = 1; Credential = 'Pacto API Treino - Santarem 24h' },
    @{ Http = 'BI PROFESSORES'; Code = 'Code in JavaScript'; Db = 'cash stm_nov_rep'; Unit = 'stm_nova_republica'; Company = 2; Credential = 'Pacto API Treino - Nova Republica' },
    @{ Http = 'BI PROFESSORES2'; Code = 'Code in JavaScript2'; Db = 'cash itaituba'; Unit = 'itaituba'; Company = 4; Credential = 'Pacto API Treino - Itaituba' },
    @{ Http = 'BI PROFESSORES3'; Code = 'Code in JavaScript3'; Db = 'cash medicilandia'; Unit = 'medicilandia'; Company = 5; Credential = 'Pacto API Treino - Medicilandia' }
)

$codeTemplate = @'
const raw = $input.first()?.json;
const unidade = '__UNIT__';
const empresaId = __COMPANY__;

function extrairLista(valor) {
  if (Array.isArray(valor)) return valor;
  if (Array.isArray(valor?.professores)) return valor.professores;
  if (Array.isArray(valor?.content)) return valor.content;
  return [];
}

const lista = extrairLista(raw);
if (!lista.length) {
  throw new Error(`[${unidade}] A Pacto retornou uma lista vazia; o cache anterior foi preservado.`);
}

const registros = lista.map((p, indice) => {
  if (p?.codigo != null && p?.comTreino != null) {
    return {
      empresa_id: empresaId,
      unidade,
      codigo: Number(p.codigo),
      nome: String(p.nome || '').trim(),
      com_treino: Number(p.comTreino ?? 0),
      sem_treino: Number(p.semTreino ?? 0),
      em_dia: Number(p.emDia ?? 0),
      vencidos: Number(p.vencidos ?? 0),
      a_renovar: Number(p.aRenovar ?? 0),
      ativos: Number(p.ativos ?? 0),
      total: Number(p.total ?? p.ativos ?? 0),
      duracao: p.duracao == null ? null : Number(p.duracao),
    };
  }

  const professor = p?.professor || {};
  const bi = p?.biTreinoTreinamentoDTO || {};
  const comTreino = Number(bi.alunosAtivosComTreino ?? 0);
  const semTreino = Number(bi.alunosAtivosSemTreino ?? 0);
  const medio = bi.tempoPermanenciaPrograma?.medio;

  return {
    empresa_id: empresaId,
    unidade,
    codigo: Number(professor.codigoPessoa ?? professor.id),
    nome: String(professor.nome || '').trim(),
    com_treino: comTreino,
    sem_treino: semTreino,
    em_dia: Number(bi.alunosAtivosProgramaEmDia ?? 0),
    vencidos: Number(bi.alunosProgramaVencidos ?? 0),
    a_renovar: Number(bi.alunosProgramaRenovar ?? 0),
    ativos: comTreino + semTreino,
    total: comTreino + semTreino,
    duracao: medio == null || !Number.isFinite(Number(medio)) || Number(medio) <= 0
      ? null
      : Math.round(Number(medio)),
  };
});

const invalidos = registros.filter((r) =>
  !Number.isFinite(r.codigo) || !r.nome ||
  ['com_treino', 'sem_treino', 'em_dia', 'vencidos', 'a_renovar', 'ativos', 'total']
    .some((campo) => !Number.isFinite(r[campo]) || r[campo] < 0)
);
if (invalidos.length) {
  throw new Error(`[${unidade}] ${invalidos.length} registro(s) inválido(s); nada foi gravado.`);
}

const codigos = new Set(registros.map((r) => r.codigo));
if (codigos.size !== registros.length) {
  throw new Error(`[${unidade}] A resposta contém códigos de professor duplicados; nada foi gravado.`);
}

return [{
  json: {
    unidade,
    empresa_id: empresaId,
    quantidade: registros.length,
    coletado_em: new Date().toISOString(),
    registros,
  },
}];
'@

$query = @'
WITH dados AS (
    SELECT *
    FROM jsonb_to_recordset($1::jsonb) AS d(
        empresa_id integer,
        unidade text,
        codigo bigint,
        nome text,
        com_treino integer,
        sem_treino integer,
        em_dia integer,
        vencidos integer,
        a_renovar integer,
        ativos integer,
        total integer,
        duracao integer
    )
),
validacao AS (
    SELECT CASE
        WHEN COUNT(*) = 0 THEN public.raise_exception('Coleta vazia; cache preservado')
        WHEN COUNT(*) <> $4::integer THEN public.raise_exception('Quantidade da coleta divergente; cache preservado')
        WHEN COUNT(DISTINCT codigo) <> COUNT(*) THEN public.raise_exception('Codigos duplicados; cache preservado')
        ELSE NULL
    END AS resultado
    FROM dados
),
salvos AS (
    INSERT INTO public.cash_professores_bi_mfgestao (
        empresa_id, unidade, codigo, nome, com_treino, sem_treino,
        em_dia, vencidos, a_renovar, ativos, total, duracao, atualizado_em
    )
    SELECT
        empresa_id, unidade, codigo, nome, com_treino, sem_treino,
        em_dia, vencidos, a_renovar, ativos, total, duracao, $3::timestamptz
    FROM dados
    CROSS JOIN validacao
    ON CONFLICT (unidade, codigo) DO UPDATE SET
        empresa_id = EXCLUDED.empresa_id,
        nome = EXCLUDED.nome,
        com_treino = EXCLUDED.com_treino,
        sem_treino = EXCLUDED.sem_treino,
        em_dia = EXCLUDED.em_dia,
        vencidos = EXCLUDED.vencidos,
        a_renovar = EXCLUDED.a_renovar,
        ativos = EXCLUDED.ativos,
        total = EXCLUDED.total,
        duracao = EXCLUDED.duracao,
        atualizado_em = EXCLUDED.atualizado_em
    RETURNING codigo
),
removidos AS (
    DELETE FROM public.cash_professores_bi_mfgestao antigo
    WHERE antigo.unidade = $2::text
      AND (
          (SELECT COUNT(*) FROM dados) >= CEIL(
              (SELECT COUNT(*) FROM public.cash_professores_bi_mfgestao existente
               WHERE existente.unidade = $2::text) * 0.70
          )
          OR (
              antigo.atualizado_em < $3::timestamptz - interval '7 days'
              AND (SELECT COUNT(*) FROM dados) >= CEIL(
                  (SELECT COUNT(*) FROM public.cash_professores_bi_mfgestao existente
                   WHERE existente.unidade = $2::text) * 0.50
              )
          )
      )
      AND NOT EXISTS (
          SELECT 1 FROM dados atual WHERE atual.codigo = antigo.codigo
      )
    RETURNING antigo.codigo
)
SELECT
    $2::text AS unidade,
    (SELECT COUNT(*) FROM salvos)::integer AS registros_salvos,
    (SELECT COUNT(*) FROM removidos)::integer AS registros_removidos,
    EXISTS (
        SELECT 1
        FROM public.cash_professores_bi_mfgestao antigo
        WHERE antigo.unidade = $2::text
          AND NOT EXISTS (SELECT 1 FROM dados atual WHERE atual.codigo = antigo.codigo)
          AND NOT (
              (SELECT COUNT(*) FROM dados) >= CEIL(
                  (SELECT COUNT(*) FROM public.cash_professores_bi_mfgestao existente
                   WHERE existente.unidade = $2::text) * 0.70
              )
              OR (
                  antigo.atualizado_em < $3::timestamptz - interval '7 days'
                  AND (SELECT COUNT(*) FROM dados) >= CEIL(
                      (SELECT COUNT(*) FROM public.cash_professores_bi_mfgestao existente
                       WHERE existente.unidade = $2::text) * 0.50
                  )
              )
          )
    ) AS limpeza_protegida,
    $3::timestamptz AS atualizado_em;
'@

# A validação de SQL não depende de uma função auxiliar inexistente: a lista já
# foi integralmente validada pelo Code node antes desta transação.
$query = $query -replace "validacao AS \([\s\S]*?\),\r?\nsalvos AS", 'salvos AS'
$query = $query -replace "\r?\n    CROSS JOIN validacao", ''

foreach ($branch in $branches) {
    $httpNode = $workflow.nodes | Where-Object name -eq $branch.Http | Select-Object -First 1
    if (-not $httpNode) { throw "Node ausente: $($branch.Http)" }
    $httpNode.parameters.authentication = 'genericCredentialType'
    $httpNode.parameters.genericAuthType = 'httpHeaderAuth'
    $httpNode.parameters.headerParameters.parameters = @(
        $httpNode.parameters.headerParameters.parameters |
            Where-Object { $_.name -notmatch '^(?i:Authorization)$' }
    )
    $httpNode.credentials = [pscustomobject]@{
        httpHeaderAuth = [pscustomobject]@{ name = $branch.Credential }
    }

    $codeNode = $workflow.nodes | Where-Object name -eq $branch.Code | Select-Object -First 1
    if (-not $codeNode) { throw "Node ausente: $($branch.Code)" }
    $codeNode.parameters.jsCode = $codeTemplate.Replace('__UNIT__', $branch.Unit).Replace('__COMPANY__', [string]$branch.Company)

    $dbNode = $workflow.nodes | Where-Object name -eq $branch.Db | Select-Object -First 1
    if (-not $dbNode) { throw "Node ausente: $($branch.Db)" }
    $dbNode.parameters = [pscustomobject]@{
        operation = 'executeQuery'
        query = $query
        options = [pscustomobject]@{
            queryReplacement = '={{ [JSON.stringify($json.registros), $json.unidade, $json.coletado_em] }}'
        }
    }
}

$workflow | Add-Member -NotePropertyName name -NotePropertyValue 'Atualizar BI Professores - cache seguro v2' -Force
$workflow | ConvertTo-Json -Depth 100 -Compress
