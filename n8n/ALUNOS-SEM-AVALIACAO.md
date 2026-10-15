# Alunos ativos sem avaliação

Implementação do indicador oficial Pacto `IND_AF_ATIVOS_SEM` para as cinco unidades.

## Instalação

1. Execute `alunos-sem-avaliacao.sql` uma única vez no PostgreSQL.
2. No n8n, crie uma credencial **Header Auth** chamada `Pacto API`:
   - Nome do header: `Authorization`
   - Valor: `Bearer <token>`
3. Importe `workflow-alunos-sem-avaliacao-todas-unidades.json`.
4. Selecione a credencial `Pacto API` nos dez nodes HTTP.
5. Execute cada ramo manualmente e confirme no último node:
   - `total_atual` igual ao total exibido pela Pacto;
   - `registros_gravados` sem erro;
   - coleta com zero também concluída normalmente.
6. Publique o workflow coletor.
7. Substitua o workflow `fechamento_semanal_avaliacoes` pelo arquivo
   `workflow-webhook-fechamento-semanal-avaliacoes.json` e publique-o.

Os cinco agendamentos são separados por cinco minutos para reduzir concorrência.
O webhook somente entrega `alunos_sem_avaliacao` ao dashboard quando a última
coleta tiver no máximo 24 horas. Se estiver ausente ou vencida, o campo manual é
preservado.

## Segurança

Não grave o bearer token diretamente no workflow exportado. Ao trocar ou revogar
o token, atualize apenas a credencial `Pacto API` no n8n.
