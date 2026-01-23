import dotenv from 'dotenv';

dotenv.config();

// Validate required environment variables
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

export const config = {
  openapi: {
    specUrl: requireEnv('OPENAPI_SPEC_URL'),
    apiKey: process.env.OPENAPI_API_KEY || '', // Optional - some specs don't require auth
    cacheTtl: parseInt(process.env.SPEC_CACHE_TTL || '300', 10) * 1000, // Convert to ms
  },
  server: {
    transport: process.env.MCP_TRANSPORT || 'stdio',
    port: parseInt(process.env.MCP_PORT || '8080', 10),
    apiKeys: (process.env.API_KEYS || '').split(',').map(k => k.trim()).filter(k => k.length > 0),
    corsOrigin: process.env.CORS_ORIGIN || '*',
  },
};
