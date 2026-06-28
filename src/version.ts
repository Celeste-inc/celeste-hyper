// Single source of truth for the running build's version, surfaced by GET /api/health (CC.2).
// Kept in step with package.json's "version" (a JSON import would force tsconfig resolveJsonModule).
export const VERSION = "0.1.0";
