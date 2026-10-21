export * from './config.js';
export * from './types.js';
export * from './utils.js';
export * from './security.js';
export * from './logger.js';
export * from './business.js';
export * from './crawl-types.js';
export * from './plans.js';

export class AppError extends Error {
  constructor(
    message: string,
    public statusCode = 400,
    public code = 'bad_request',
    public details?: unknown,
  ) {
    super(message);
  }
}
