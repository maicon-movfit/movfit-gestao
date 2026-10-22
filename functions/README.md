# Cloud Function — OAuth Pacto MCP

O GitHub Pages não pode chamar `mcp-auth.conversas.ai/oauth/token` (CORS). Esta função faz a troca do código, como o backend Java do Movchat.

## Publicar (uma vez)

```bash
cd functions
npm install
cd ..
firebase login
firebase use mov-fit---gestao-de-carteira
firebase deploy --only functions:pactoMcpOAuthToken
```

URL usada no front: `PACTO_MCP_OAUTH_TOKEN_URL` em `js/firebase-config.js`.
