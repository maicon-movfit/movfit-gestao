# Histórico mensal de matriculados

## Instalação segura

Execute `matriculados-historico.sql` uma única vez com a credencial PostgreSQL `Movfit`.
O script é aditivo: mantém `matriculas_mov_fit` e a chave primária atual intactas.

## Finalização de cada unidade

Depois de `Conferir coleta concluida`, adicione um node PostgreSQL chamado
`Arquivar competencia`. Use esta consulta:

```sql
SELECT public.fechar_coleta_matriculas(
    $1::integer,
    $2::date,
    $3::integer,
    $4::timestamptz
) AS registros_arquivados;
```

Em **Query Parameters**, envie:

```js
={{ [
  $json.unidade_codigo,
  $json.competencia_coleta,
  $json.total_api,
  $json.coletado_em
] }}
```

Repita o node após os cinco conferidores. O procedimento:

- recusa competências anteriores ao mês corrente;
- valida a quantidade esperada antes de arquivar;
- substitui somente o snapshot do mês corrente dentro de uma transação;
- registra conclusão por unidade e competência;
- deixa meses anteriores imutáveis.

## Consulta do mês atual

O webhook atual pode continuar lendo `matriculas_mov_fit`, filtrado por
`competencia_coleta`.

## Consulta histórica

Para consultar uma competência fechada:

```sql
SELECT h.*
FROM public.matriculas_mov_fit_historico h
WHERE h.competencia_coleta = $1::date
ORDER BY h.unidade_nome, h.nome_aluno, h.data_lancamento DESC;
```

Antes de liberar o resultado, confirme que todas as unidades esperadas concluíram:

```sql
SELECT unidade_codigo, status, registros_esperados, registros_arquivados,
       coletado_em, finalizado_em
FROM public.matriculas_mov_fit_coletas
WHERE competencia = $1::date
ORDER BY unidade_codigo;
```

Uma competência só deve ser apresentada como completa quando as cinco unidades tiverem
`status = 'CONCLUIDA'` e `registros_esperados = registros_arquivados`.

