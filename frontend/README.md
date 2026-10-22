# Frontend

Esta pasta contém a nova fronteira do frontend. O site legado permanece na raiz para preservar o deploy atual do GitHub Pages.

`src/services/api-client.js` padroniza autenticação e erros HTTP. `data-provider.js` permite migrar telas individualmente entre as fontes `legacy` e `api`, evitando uma troca total arriscada.
