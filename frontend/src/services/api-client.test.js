import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiClient } from './api-client.js';

test('envia token e desserializa JSON', async () => {
  let received;
  const client = new ApiClient({
    baseUrl: 'https://api.exemplo.test',
    getAccessToken: async () => 'token-teste',
    fetchImpl: async (url, options) => {
      received = { url, options };
      return new Response(JSON.stringify({ sucesso: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const response = await client.get('/v1/unidades');
  assert.deepEqual(response, { sucesso: true });
  assert.equal(received.url, 'https://api.exemplo.test/v1/unidades');
  assert.equal(received.options.headers.get('Authorization'), 'Bearer token-teste');
});

test('propaga erro HTTP com status e resposta', async () => {
  const client = new ApiClient({
    baseUrl: 'https://api.exemplo.test',
    fetchImpl: async () => new Response(JSON.stringify({ erro: 'negado' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    }),
  });

  await assert.rejects(
    () => client.get('/v1/unidades'),
    (error) => error.status === 403 && error.payload.erro === 'negado',
  );
});
