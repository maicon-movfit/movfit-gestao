# Backend

API própria do MOVFIT Gestão. Ela centraliza autorização, regras de negócio e acesso ao PostgreSQL.

## Configuração local

1. Copie `.env.example` para `.env`.
2. Preencha `DATABASE_URL` e a credencial do Firebase Admin.
3. Execute `npm install` na raiz do repositório.
4. Execute `npm run migrate --workspace @movfit/backend`.
5. Inicie com `npm run dev:api`.

Endpoints iniciais:

- `GET /api/v1/health`: saúde da aplicação e do banco.
- `GET /api/v1/units`: unidades às quais o usuário autenticado tem acesso.
- `GET /api/v1/units/:unidadeId`: unidade específica autorizada.

O Firebase é usado apenas para validar identidade nesta fase. Os dados operacionais e permissões pertencem ao PostgreSQL.
