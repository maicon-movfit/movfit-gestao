function dados(nome) {
  const original = $(nome).first().json;
  let valor = original.structuredContent
    ?? original.result?.structuredContent
    ?? original.result
    ?? original;

  if (Array.isArray(valor.content)) {
    const blocoTexto = valor.content.find(bloco => bloco?.type === 'text');
    valor = blocoTexto?.text ?? valor;
  }

  if (typeof valor === 'string') {
    try {
      valor = JSON.parse(valor);
    } catch {
      throw new Error(`Resposta textual invalida no node ${nome}.`);
    }
  }

  return valor;
}

const cfg = $('Configurar Nova Republica').first().json;
const alunos = dados('Pacto - Alunos ativos');
const contratos = dados('Pacto - Contratos');
const acessos = dados('Pacto - Acessos');
if (alunos.total_ativos == null || contratos.total == null || acessos.acessos_mes_atual == null) {
  throw new Error('Resposta MCP incompleta; confira a saida dos tres nodes Pacto.');
}
const momento = String(acessos.momento || '').replace(' ', 'T') + ':00-03:00';
return [{json:{...cfg,alunos_ativos:alunos.total_ativos,contratos_total:contratos.total,contratos_ativos:contratos.breakdown.ativos_fim_mes_atual,contratos_vencidos:contratos.breakdown.vencidos_mes_atual,fechamento_anterior:contratos.fechamento_mes_anterior.total,matriculados_mes:contratos.movimentacao_mes.matriculados.ate_hoje,rematriculados_mes:contratos.movimentacao_mes.rematriculados.ate_hoje,cancelados_mes:contratos.movimentacao_mes.cancelados.ate_hoje,desistencias_mes:contratos.movimentacao_mes.desistencias.ate_hoje,saldo_mes:contratos.movimentacao_mes.saldo_mes,churn:contratos.churn_rate,acessos_hoje:acessos.acessos_realizados_hoje,alunos_agora:acessos.alunos_em_tempo_real,acessos_mes:acessos.acessos_mes_atual,acessos_ultimos_30_dias:acessos.total_acessos_ultimos_30_dias,dia_pico:acessos.dia_mais_acessos_mes,horario_pico:acessos.horario_mais_acessos_mes,momento_pacto:momento,payload_alunos:alunos,payload_contratos:contratos,payload_acessos:acessos}}];