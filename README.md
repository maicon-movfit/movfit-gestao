# MOVFIT Gestão

Painel operacional da MOVFIT em migração para uma arquitetura com frontend, API Node.js e PostgreSQL próprios.

## Desenvolvimento

Requisitos: Node.js 22+ e npm.

```sh
npm ci
npm test
npm run check
npm run dev:api
```

Copie `backend/.env.example` para `backend/.env` e ajuste somente no ambiente local. Não versione credenciais.

## Produção

A stack para Portainer está em `compose.yaml`. Use `.env.production.example` como lista de variáveis, sem preencher segredos no repositório. Instruções completas estão em `docs/DEPLOY_PORTAINER.md`.

## Estado da migração

O banco e a API próprios já têm a base de persistência e importação. O painel legado ainda usa Firebase Auth e partes do Firestore até a migração gradual ser concluída. As integrações Pacto continuam passando pelos webhooks e tabelas existentes.
