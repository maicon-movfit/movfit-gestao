import test from 'node:test';
import assert from 'node:assert/strict';
import { checksumSnapshot, normalizeCompetence } from './monthly-closure.js';

test('normaliza competência mensal para o primeiro dia', () => {
  assert.equal(normalizeCompetence('2026-09'), '2026-09-01');
  assert.equal(normalizeCompetence('2026-09-01'), '2026-09-01');
});

test('rejeita competência inválida ou que não inicia no primeiro dia', () => {
  assert.equal(normalizeCompetence('2026-13'), null);
  assert.equal(normalizeCompetence('2026-09-02'), null);
  assert.equal(normalizeCompetence('setembro/2026'), null);
});

test('checksum do snapshot não depende da ordem das chaves', () => {
  assert.equal(
    checksumSnapshot({ indicadores: { ativos: 10, acessos: 20 }, unidade: 'premium24' }),
    checksumSnapshot({ unidade: 'premium24', indicadores: { acessos: 20, ativos: 10 } }),
  );
});
