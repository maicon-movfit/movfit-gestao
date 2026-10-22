// Indicadores do painel via MCP Pacto (apos login OAuth) — sem n8n.

const PACTO_MCP_UNIDADES = [
  { unidade_codigo: 1, unidade_nome: 'medicilandia', empresa_pacto_id: 1, chave_empresa: '3b9baed057b6aae89853e3826862fd9b' },
  { unidade_codigo: 2, unidade_nome: 'itaituba', empresa_pacto_id: 1, chave_empresa: 'b599c7f369f33460597a86ec40ab16b5' },
  { unidade_codigo: 3, unidade_nome: 'santarem_24h', empresa_pacto_id: 1, chave_empresa: '546c67bafa5678856869c0f8d43c1a05' },
  { unidade_codigo: 5, unidade_nome: 'santarem_nova_republica', empresa_pacto_id: 1, chave_empresa: '519fbd660bd686239efcbc6838408c28' },
  { unidade_codigo: 6, unidade_nome: 'novo_progresso', empresa_pacto_id: 1, chave_empresa: '2a1214c12272bdfac8118b2d61406eb0' },
];

function pactoMcpIndicadoresCompetenciaAtual() {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit',
  }).formatToParts(new Date());
  const ano = partes.find(p => p.type === 'year')?.value;
  const mes = partes.find(p => p.type === 'month')?.value;
  return ano && mes ? `${ano}-${mes}` : null;
}

async function pactoMcpIndicadoresConectado() {
  if (typeof pactoMcpCarregarConfig !== 'function') return false;
  const cfg = await pactoMcpCarregarConfig();
  return !!(cfg?.token && (cfg.autenticacao === 'OAUTH' || cfg.ativo));
}

async function pactoMcpIndicadoresUnidade(cfgUnidade) {
  const baseArgs = {
    chave_empresa: cfgUnidade.chave_empresa,
    empresa_id: cfgUnidade.empresa_pacto_id,
    listar: false,
  };
  const alunos = await pactoMcpChamarFerramenta('alunos_ativos_empresa', baseArgs);
  const contratos = await pactoMcpChamarFerramenta('numero_contratos_ativos_empresa', baseArgs);
  const acessos = await pactoMcpChamarFerramenta('gestao_acessos_empresa', baseArgs);
  if (!alunos || !contratos || !acessos) {
    throw new Error(`MCP incompleto para ${cfgUnidade.unidade_nome}`);
  }
  if (alunos.total_ativos == null || contratos.total == null || acessos.acessos_mes_atual == null) {
    throw new Error(`Resposta MCP incompleta (${cfgUnidade.unidade_nome})`);
  }
  const momento = String(acessos.momento || '').replace(' ', 'T');
  const coletado = momento ? `${momento}:00-03:00` : new Date().toISOString();
  const competencia = pactoMcpIndicadoresCompetenciaAtual();
  return {
    unidade_codigo: cfgUnidade.unidade_codigo,
    unidade_nome: cfgUnidade.unidade_nome,
    competencia,
    alunos_ativos: alunos.total_ativos,
    contratos_total: contratos.total,
    contratos_ativos: contratos.breakdown?.ativos_fim_mes_atual,
    contratos_vencidos: contratos.breakdown?.vencidos_mes_atual,
    fechamento_anterior: contratos.fechamento_mes_anterior?.total,
    matriculados_mes: contratos.movimentacao_mes?.matriculados?.ate_hoje,
    rematriculados_mes: contratos.movimentacao_mes?.rematriculados?.ate_hoje,
    cancelados_mes: contratos.movimentacao_mes?.cancelados?.ate_hoje,
    desistencias_mes: contratos.movimentacao_mes?.desistencias?.ate_hoje,
    saldo_mes: contratos.movimentacao_mes?.saldo_mes,
    churn: contratos.churn_rate,
    acessos_hoje: acessos.acessos_realizados_hoje,
    alunos_agora: acessos.alunos_em_tempo_real,
    acessos_mes: acessos.acessos_mes_atual,
    acessos_ultimos_30_dias: acessos.total_acessos_ultimos_30_dias,
    dia_pico: acessos.dia_mais_acessos_mes,
    horario_pico: acessos.horario_mais_acessos_mes,
    coletado_em: coletado,
    momento_pacto: coletado,
    fonte: 'pacto_mcp_direto',
  };
}

async function pactoMcpIndicadoresBuscarTodos(forceRefresh) {
  if (!forceRefresh && typeof _totalAtivosCache !== 'undefined'
    && _totalAtivosCache.data?.fonte === 'pacto_mcp_direto'
    && _totalAtivosCache.data?.unidades?.length
    && (Date.now() - _totalAtivosCache.at) < (typeof TOTAL_ATIVOS_CACHE_TTL_MS !== 'undefined' ? TOTAL_ATIVOS_CACHE_TTL_MS : 180000)) {
    return _totalAtivosCache.data;
  }
  if (!(await pactoMcpIndicadoresConectado())) return null;
  const unidades = [];
  for (let i = 0; i < PACTO_MCP_UNIDADES.length; i += 1) {
    unidades.push(await pactoMcpIndicadoresUnidade(PACTO_MCP_UNIDADES[i]));
  }
  const competencia = pactoMcpIndicadoresCompetenciaAtual();
  return {
    sucesso: true,
    competencia,
    ao_vivo: true,
    fonte: 'pacto_mcp_direto',
    gerado_em: new Date().toISOString(),
    total_unidades: unidades.length,
    unidades,
  };
}
