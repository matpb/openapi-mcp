#!/usr/bin/env node
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { openAPIManager } from "./utils/OpenAPIManager.js";

// Import tools directly
import SearchEndpointsTool from "./tools/SearchEndpointsTool.js";
import GetEndpointDetailsTool from "./tools/GetEndpointDetailsTool.js";
import SearchSchemasTool from "./tools/SearchSchemasTool.js";
import GetSchemaDetailsTool from "./tools/GetSchemaDetailsTool.js";
import GetOpenAPISpecTool from "./tools/GetOpenAPISpecTool.js";

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read package.json
const packageJsonPath = join(__dirname, "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

// Configuration
const transportType = process.env.MCP_TRANSPORT || "stdio";
const port = parseInt(process.env.MCP_PORT || "8080", 10);
const apiKeys = (process.env.API_KEYS || "")
  .split(",")
  .map((k) => k.trim())
  .filter((k) => k.length > 0);
const corsOrigin = process.env.CORS_ORIGIN || "*";

// Instantiate tools
const tools = [
  new SearchEndpointsTool(),
  new GetEndpointDetailsTool(),
  new SearchSchemasTool(),
  new GetSchemaDetailsTool(),
  new GetOpenAPISpecTool(),
];
const toolsMap = new Map(tools.map((t) => [t.name, t]));

// Create an MCP Server instance and wire up tool handlers
function createMCPServer(): Server {
  const server = new Server(
    { name: packageJson.name, version: packageJson.version },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => t.toolDefinition),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = toolsMap.get(request.params.name);
    if (!tool) {
      throw new Error(
        `Unknown tool: ${request.params.name}. Available: ${[...toolsMap.keys()].join(", ")}`
      );
    }
    return await tool.toolCall({ params: request.params });
  });

  return server;
}

// --- HTTP transport ---

function setCorsHeaders(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", corsOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-API-Key, Mcp-Session-Id"
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Type, Mcp-Session-Id"
  );
}

function checkApiKey(req: IncomingMessage): boolean {
  if (apiKeys.length === 0) return true;
  const headerKey = req.headers["x-api-key"] as string | undefined;
  if (headerKey && apiKeys.includes(headerKey)) return true;
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const queryKey = url.searchParams.get("api_key");
  if (queryKey && apiKeys.includes(queryKey)) return true;
  return false;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.setHeader("Content-Type", "application/json");
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString()));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : null);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// Session management
const transports: Record<string, StreamableHTTPServerTransport> = {};

async function handleMcpRequest(req: IncomingMessage, res: ServerResponse) {
  // Auth check
  if (!checkApiKey(req)) {
    sendJson(res, 401, {
      error: "Invalid API key",
      status: 401,
      type: "authentication_error",
    });
    return;
  }

  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const body = req.method === "POST" ? await readBody(req) : null;
  const isInit = !sessionId && body && isInitializeRequest(body);

  if (sessionId && transports[sessionId]) {
    // Existing session
    await transports[sessionId].handleRequest(req, res, body);
  } else if (isInit) {
    // New session
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        console.error(`[Server] Session initialized: ${sid}`);
        transports[sid] = transport;
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid && transports[sid]) {
        console.error(`[Server] Session closed: ${sid}`);
        delete transports[sid];
      }
    };

    transport.onerror = (error) => {
      console.error(`[Server] Transport error: ${error.message}`);
      const sid = transport.sessionId;
      if (sid) delete transports[sid];
    };

    // Connect a fresh MCP server to this transport
    const server = createMCPServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } else if (!sessionId) {
    sendJson(res, 400, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: No valid session ID provided" },
      id: null,
    });
  } else {
    // Session ID provided but not found (expired/restarted)
    sendJson(res, 404, {
      jsonrpc: "2.0",
      error: { code: -32001, message: "Session not found. Please reconnect." },
      id: null,
    });
  }
}

function startHttpServer() {
  console.error(`[Server] Starting HTTP Stream transport on port ${port}`);

  if (apiKeys.length > 0) {
    console.error(
      `[Server] API Key authentication enabled with ${apiKeys.length} key(s)`
    );
  } else {
    console.error(
      "[Server] WARNING: No API_KEYS configured - server is running without authentication!"
    );
  }

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);

      // CORS preflight
      if (req.method === "OPTIONS") {
        setCorsHeaders(res);
        res.setHeader("Access-Control-Max-Age", "86400");
        res.writeHead(204).end();
        return;
      }

      setCorsHeaders(res);

      // Health check endpoint (no auth required)
      if (url.pathname === "/health") {
        sendJson(res, 200, { status: "ok" });
        return;
      }

      // OAuth discovery endpoints — return proper JSON 404 so MCP clients don't get parse errors
      if (url.pathname.startsWith("/.well-known/")) {
        sendJson(res, 404, {
          error: "not_found",
          error_description: "OAuth is not configured on this server",
        });
        return;
      }

      // MCP endpoint
      if (url.pathname === "/mcp") {
        await handleMcpRequest(req, res);
        return;
      }

      // Everything else
      sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      console.error(`[Server] Request error: ${error}`);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal_server_error" });
      }
    }
  });

  httpServer.listen(port, () => {
    console.error(`[Server] HTTP server listening on port ${port}, endpoint /mcp`);
    console.error(`[Server] Health check available at /health`);
  });

  return httpServer;
}

// --- Stdio transport ---

async function startStdio() {
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const server = createMCPServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[Server] Started on stdio transport`);
}

// --- Graceful shutdown ---

const shutdown = async (signal: string) => {
  console.error(`[Server] Received ${signal}, shutting down gracefully...`);
  try {
    openAPIManager.clearCache();
    for (const [sid, transport] of Object.entries(transports)) {
      try {
        await transport.close();
      } catch {
        // ignore close errors during shutdown
      }
      delete transports[sid];
    }
  } catch (error) {
    console.error(`[Server] Error during shutdown: ${error}`);
  }
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGHUP", () => shutdown("SIGHUP"));

process.on("uncaughtException", async (error) => {
  console.error(`[Server] Uncaught exception: ${error}`);
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  console.error(`[Server] Unhandled rejection: ${reason}`);
  process.exit(1);
});

// --- Start ---

if (transportType === "http-stream") {
  startHttpServer();
} else {
  startStdio();
}
