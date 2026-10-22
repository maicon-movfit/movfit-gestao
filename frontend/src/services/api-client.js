export class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

export class ApiClient {
  constructor({ baseUrl, getAccessToken, fetchImpl = globalThis.fetch }) {
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
    this.getAccessToken = getAccessToken;
    this.fetch = fetchImpl;
  }

  async request(path, options = {}) {
    const token = await this.getAccessToken?.();
    const headers = new Headers(options.headers || {});
    headers.set('Accept', 'application/json');
    if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (token) headers.set('Authorization', `Bearer ${token}`);

    const response = await this.fetch(`${this.baseUrl}${path}`, { ...options, headers });
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) throw new ApiError(payload?.error || 'Falha na API', response.status, payload);
    return payload;
  }

  get(path) {
    return this.request(path);
  }

  post(path, data) {
    return this.request(path, { method: 'POST', body: JSON.stringify(data) });
  }

  put(path, data) {
    return this.request(path, { method: 'PUT', body: JSON.stringify(data) });
  }

  delete(path) {
    return this.request(path, { method: 'DELETE' });
  }
}
