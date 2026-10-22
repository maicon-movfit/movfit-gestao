export function parseDocumentPath(input) {
  const path = String(input || '').replace(/^\/+|\/+$/g, '');
  const segments = path.split('/').filter(Boolean);
  if (!path || segments.length < 2 || segments.length % 2 !== 0) {
    const error = new Error('Caminho de documento inválido.');
    error.code = 'invalid_document_path';
    throw error;
  }
  const unitIndex = segments.indexOf('unidades');
  return {
    path,
    collection: segments.at(-2),
    documentId: segments.at(-1),
    parentPath: segments.slice(0, -2).join('/') || null,
    unitId: unitIndex >= 0 ? segments[unitIndex + 1] || null : null,
  };
}

export function canAccessDocument(user, parsedPath) {
  if (user.papel === 'admin') return true;
  return Boolean(parsedPath.unitId && user.unidades.includes(parsedPath.unitId));
}
