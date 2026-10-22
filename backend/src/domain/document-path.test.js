import assert from 'node:assert/strict';
import test from 'node:test';

import { canAccessDocument, parseDocumentPath } from './document-path.js';

test('interpreta documento e unidade em caminho aninhado', () => {
  assert.deepEqual(
    parseDocumentPath('unidades/premium24/colaboradores/abc/ciclos/outubro'),
    {
      path: 'unidades/premium24/colaboradores/abc/ciclos/outubro',
      collection: 'ciclos',
      documentId: 'outubro',
      parentPath: 'unidades/premium24/colaboradores/abc',
      unitId: 'premium24',
    },
  );
});

test('nega documento global para usuário de unidade', () => {
  const path = parseDocumentPath('config/metas');
  assert.equal(canAccessDocument({ papel: 'rt', unidades: ['premium24'] }, path), false);
  assert.equal(canAccessDocument({ papel: 'admin', unidades: [] }, path), true);
});
