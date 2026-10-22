/**
 * Ponto único para trocar Firestore pela API sem espalhar condicionais nas telas.
 * O modo padrão continua sendo Firestore até cada módulo ser migrado e conferido.
 */
export class DataProvider {
  constructor({ legacy, api, mode = 'legacy' }) {
    this.legacy = legacy;
    this.api = api;
    this.mode = mode;
  }

  source() {
    return this.mode === 'api' ? this.api : this.legacy;
  }

  async listUnits() {
    return this.source().listUnits();
  }
}
