export { registerAccountRoutes } from './account-routes.js';
export * from './cookies.js';
export * from './email.js';
export { registerMFARoutes } from './mfa-routes.js';
export type { AuthUser } from './middleware.js';

export { getAuthUser, requireAuth } from './middleware.js';

export * from './oauth.js';
export { registerOAuthRoutes } from './oauth-routes.js';

export * from './password.js';

export { registerAuthRoutes } from './routes.js';

export * from './service.js';
export * from './tokens.js';
