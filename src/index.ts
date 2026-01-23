#!/usr/bin/env node
import { MCPServer, APIKeyAuthProvider } from "mcp-framework";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { openAPIManager } from "./utils/OpenAPIManager.js";

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read package.json
const packageJsonPath = join(__dirname, "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

// Build transport configuration based on environment
function getTransportConfig() {
  const transportType = process.env.MCP_TRANSPORT || 'stdio';

  if (transportType === 'http-stream') {
    const port = parseInt(process.env.MCP_PORT || '8080', 10);
    const apiKeys = (process.env.API_KEYS || '').split(',').map(k => k.trim()).filter(k => k.length > 0);

    console.error(`[Server] Starting HTTP Stream transport on port ${port}`);

    const options: Record<string, unknown> = {
      port,
      endpoint: '/mcp',
      cors: {
        allowOrigin: process.env.CORS_ORIGIN || '*',
        allowMethods: 'GET, POST, DELETE, OPTIONS',
        allowHeaders: 'Content-Type, Authorization, X-API-Key, Mcp-Session-Id',
        exposeHeaders: 'Content-Type, Mcp-Session-Id',
      },
    };

    if (apiKeys.length > 0) {
      options.auth = {
        provider: new APIKeyAuthProvider({ keys: apiKeys }),
      };
      console.error(`[Server] API Key authentication enabled with ${apiKeys.length} key(s)`);
    } else {
      console.error('[Server] WARNING: No API_KEYS configured - server is running without authentication!');
    }

    return {
      type: 'http-stream' as const,
      options,
    };
  }

  // Default to stdio for local usage
  return undefined;
}

const server = new MCPServer({
  name: packageJson.name,
  version: packageJson.version,
  basePath: __dirname,
  transport: getTransportConfig(),
});

// Graceful shutdown handler
const shutdown = async (signal: string) => {
  console.error(`[Server] Received ${signal}, shutting down gracefully...`);
  try {
    openAPIManager.clearCache();
    console.error('[Server] Cache cleared');
  } catch (error) {
    console.error(`[Server] Error during shutdown: ${error}`);
  }
  process.exit(0);
};

// Register signal handlers
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGHUP', () => shutdown('SIGHUP'));

// Handle uncaught errors
process.on('uncaughtException', async (error) => {
  console.error(`[Server] Uncaught exception: ${error}`);
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  console.error(`[Server] Unhandled rejection: ${reason}`);
  process.exit(1);
});

server.start();
