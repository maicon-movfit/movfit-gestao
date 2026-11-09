# Fechamento mensal automático

O mês não deve ser digitado na tela administrativa. O n8n coleta os dados finais,
confere as cinco unidades e envia um snapshot imutável para a API.

## Janela de execução (America/Sao_Paulo)

No último dia do mês:

1. `22:00`: dispara a atualização dos indicadores Pacto e do cache de BI dos professores.
2. `23:00`: repete ambas as atualizações.
3. `23:40`: valida que as cinco unidades retornaram dados recentes e completos.
4. `23:55`: realiza uma última tentativa apenas para unidades pendentes.
5. `00:05` do primeiro dia do mês seguinte: monta e envia os snapshots do mês anterior.

O snapshot só é enviado quando todas as cinco unidades forem válidas. Uma falha deve
gerar alerta e impedir o fechamento parcial.

## Disparos de atualização

Crie dois Webhooks n8n autenticados por cabeçalho interno (não públicos):

- `POST /webhook/internal/atualizar-indicadores-pacto`, ligado ao início de
  `workflow-pacto-indicadores-todas-unidades.json`;
- `POST /webhook/internal/atualizar-bi-professores`, ligado ao início de
  `workflow-atualizar-bi-professores-cache-seguro-v2.json`.

Cada Webhook deve iniciar as mesmas ramificações atualmente iniciadas pelo respectivo
Schedule Trigger. O workflow orquestrador chama os dois, aguarda sua conclusão e só
então prossegue para a conferência. Use uma credencial de Header Auth do n8n; nunca
coloque tokens no JSON versionado.

## Contrato do snapshot para a API

Para cada unidade, o node HTTP Request chama:

```text
POST {{$env.MOVFIT_API_URL}}/api/v1/monthly-closures
X-Integration-Key: {{$env.MOVFIT_MONTHLY_CLOSURE_KEY}}
Content-Type: application/json
```

O corpo precisa seguir este formato. `competence` é o mês que acabou de terminar.

```json
{
  "unitId": "premium24",
  "competence": "2026-10",
  "source": "n8n-monthly-close",
  "collectedAt": "2026-11-01T00:05:00-03:00",
  "snapshot": {
    "indicators": {
      "training": { "total": 0, "active": 0, "withTraining": 0, "upToDate": 0, "expired": 0, "toRenew": 0, "withoutTraining": 0 },
      "pacto": {},
      "evaluations": {}
    },
    "teachers": [
      { "id": "codigo-pacto", "name": "Professor", "total": 0, "active": 0, "withTraining": 0, "upToDate": 0, "expired": 0, "toRenew": 0, "withoutTraining": 0, "averageDurationDays": 0 }
    ]
  }
}
```

Os campos de professor são os que alimentarão os filtros e as séries dos gráficos.
Mantenha também os payloads brutos, se necessários, em campos próprios do snapshot,
mas não os use como única fonte dos gráficos.

## Validação obrigatória antes do envio

- existem exatamente as cinco unidades: `premium24`, `nrexpress`, `itaituba`,
  `medicilandia` e `novoprogresso`;
- cada consulta de indicadores e BI foi atualizada na última hora;
- os totais de professor não possuem números negativos;
- o indicador da unidade bate com a soma dos professores quando esse indicador for
  calculável;
- a competência enviada é o mês anterior ao horário da execução.

O endpoint é idempotente: reenviar o mesmo snapshot é seguro. Se uma competência
fechada receber dados diferentes, a API responderá `409` e o workflow deve alertar
um administrador, sem tentar sobrescrever o histórico.

## Consulta do histórico pelo painel

O frontend autenticado consulta:

```text
GET /api/v1/monthly-closures?unitId=premium24&from=2026-01&to=2026-10
```

Administradores podem omitir `unitId` para obter a rede; RTs só recebem unidades às
quais estão vinculados. O resultado contém um snapshot por unidade/mês fechado.
