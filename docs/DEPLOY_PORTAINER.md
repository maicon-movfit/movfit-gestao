# Publicação no Portainer

## Serviços

- `frontend`: Nginx publica o painel e encaminha `/api/` internamente.
- `backend`: API Node.js privada; executa migrations antes de iniciar.
- `db`: PostgreSQL 16 acessível apenas pela rede interna.
- `postgres_data`: volume persistente, independente de atualizações dos containers.

## Preparação

1. Cadastre no Portainer todas as variáveis de `.env.production.example`. Use valores diferentes em `COMPOSE_PROJECT_NAME` para produção e homologação, evitando compartilhar volumes.
2. Use uma senha longa para `POSTGRES_PASSWORD`; ela não é inserida em URL e pode conter caracteres especiais.
3. Converta a conta de serviço Firebase para Base64 enquanto o login ainda depender do Firebase Auth:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('firebase-service-account.json'))
```

4. Salve apenas o resultado em `FIREBASE_SERVICE_ACCOUNT_BASE64` no Portainer. Não versione a credencial.
5. Autorize o domínio definitivo no Firebase Authentication enquanto essa autenticação for utilizada.

## Deploy

1. Em **Stacks > Add stack**, selecione o repositório Git e a branch de homologação.
2. Defina `compose.yaml` como Compose path.
3. Cadastre as variáveis de ambiente e faça o deploy.
4. Confirme os três containers como `healthy`.
5. Configure HTTPS em Traefik, Nginx Proxy Manager ou proxy equivalente.

Validações: `/healthz` deve retornar `ok`; `/api/v1/health` deve informar API e banco como `ok`; somente o frontend deve possuir porta pública.

## Backup e atualização

Execute diariamente `./ops/backup-postgres.sh` e copie o arquivo para armazenamento externo. Teste a restauração periodicamente em homologação com `./ops/restore-postgres.sh arquivo.dump.gz`.

Antes de atualizar: faça backup, registre o commit em produção, atualize a stack e aguarde os healthchecks. Em falha, volte ao commit anterior sem apagar o volume. Migrations aplicadas nunca devem ser alteradas; crie uma nova migration incremental.
