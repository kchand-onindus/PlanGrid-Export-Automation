import type { ExportErrorType } from './types.js';

export class ExportError extends Error {
  constructor(readonly errorType: ExportErrorType, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ExportError';
  }
}
