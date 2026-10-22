# Arquitetura do MOVFIT Gestão

O projeto está em transição segura de uma aplicação estática monolítica para frontend e backend separados.

## Estrutura

- `index.html`, `css/` e `js/`: frontend legado ainda publicado pelo GitHub Pages.
- `frontend/`: camada nova do frontend. Os serviços daqui isolam acesso a dados e permitem trocar Firestore por API sem reescrever telas.
- `backend/`: API própria em Node.js, responsável por autorização e persistência no PostgreSQL.
- `n8n/`: integrações externas existentes com Pacto. Permanecem independentes durante a migração.

## Regra de compatibilidade

O frontend legado continua sendo a entrada de produção até cada módulo ser migrado e validado. Nenhum arquivo publicado foi movido nesta etapa. A troca de fonte é feita gradualmente pelo `DataProvider`, com possibilidade de retorno ao modo legado.

## Fronteiras

```text
Navegador -> frontend -> API própria -> PostgreSQL
                              |
                              +-> dados sincronizados pelo n8n/Pacto

Firebase Auth -> identidade temporária -> API própria valida o token
Firestore -> legado temporário, retirado por módulo
```

O navegador não deve receber credenciais do PostgreSQL, tokens da Pacto ou segredos do n8n.

## Ordem de migração

1. Criar banco e executar migrations.
2. Cadastrar usuários autorizados e vínculos com unidades.
3. Publicar a API em HTTPS.
4. Configurar o frontend para o modo `api` em um módulo por vez.
5. Comparar respostas do legado e da API.
6. Desligar coleções Firestore somente após conferência e backup.
