# Arquitetura do MOVFIT Gestão

O projeto está em transição segura de uma aplicação estática monolítica para frontend e backend separados.

## Estrutura

- `index.html`, `css/` e `js/`: frontend legado, preservado para não interromper o painel atual.
- `frontend/`: configuração do servidor web e camada nova de acesso a dados.
- `backend/`: API Node.js, autorização, migrations e persistência no PostgreSQL.
- `n8n/`: integrações externas existentes com a Pacto; permanecem independentes durante a migração.
- `compose.yaml`: stack com frontend, API e PostgreSQL.
- `ops/`: backup e restauração do PostgreSQL.
- `docs/`: guias de migração e publicação.

## Topologia de produção

```text
Internet -> proxy HTTPS -> Nginx/frontend -> API privada -> PostgreSQL privado
                                      |
                                      +-> dados sincronizados pelo n8n/Pacto

Firebase Auth -> identidade temporária -> API valida token e permissões
Firestore -> legado temporário, retirado módulo a módulo
```

Somente o frontend publica uma porta. O navegador nunca deve receber credenciais do PostgreSQL, tokens da Pacto ou segredos do n8n.

## Persistência e segurança

- Dados próprios ficam em volume persistente do PostgreSQL.
- Migrations são incrementais, transacionais e protegidas por advisory lock.
- A API valida usuário e acesso à unidade antes de documentos protegidos.
- Senhas e credenciais são fornecidas apenas por variáveis do Portainer.
- Logs removem cabeçalhos de autorização e cookies.
- Volume não substitui backup: o dump deve ser diário e armazenado fora do servidor.

## Compatibilidade e migração

O frontend legado continua como entrada até cada módulo ser migrado e validado. O `DataProvider` permite alternar gradualmente entre Firestore e API. A ordem segura é:

1. Subir PostgreSQL e API em homologação.
2. Executar migrations e cadastrar usuários/unidades.
3. Importar e conferir o conteúdo exportado do Firestore.
4. Trocar um módulo por vez para a API própria.
5. Comparar resultados e manter rollback durante a validação.
6. Desligar o Firestore somente após backup e aceite funcional.

Consulte `docs/DEPLOY_PORTAINER.md` e `docs/FIREBASE_EXPORT_CHECKLIST.md`.
