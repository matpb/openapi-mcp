# OpenAPI MCP Server

An MCP (Model Context Protocol) server that provides AI assistants with tools to explore and understand OpenAPI specifications. Point it at any OpenAPI spec (JSON or YAML) and give your AI the ability to search endpoints, explore schemas, and understand API structures.

## Features

- **OpenAPI 3.x Support** - Works with OpenAPI 3.0 and 3.1 specifications
- **JSON & YAML** - Automatically detects and parses both formats
- **Smart Caching** - Caches specs with configurable TTL to minimize API calls
- **Reference Resolution** - Automatically resolves `$ref` references for complete schema views
- **Dual Transport** - Run via stdio (local) or HTTP stream (remote/Docker)
- **Authentication** - Optional API key authentication for HTTP transport

## Available Tools

| Tool | Description |
|------|-------------|
| `search_endpoints` | Search API endpoints by path pattern, HTTP method, tags, or description |
| `get_endpoint_details` | Get complete details for a specific endpoint including parameters and schemas |
| `search_schemas` | Search for schemas/models by name or property |
| `get_schema_details` | Get full schema definition with resolved references |
| `get_openapi_spec` | Retrieve the full spec or filtered sections (info, paths, components, etc.) |

## Quick Start

### Prerequisites

- Node.js >= 18.0.0
- npm or yarn

### Installation

```bash
# Clone the repository
git clone https://github.com/matpb/openapi-mcp.git
cd openapi-mcp

# Install dependencies
npm install

# Build
npm run build
```

### Configuration

Create a `.env` file in the project root (see `.env.example`):

```bash
# Required: URL to your OpenAPI specification
OPENAPI_SPEC_URL=https://api.example.com/openapi.json

# Optional: API key if your spec endpoint requires authentication
OPENAPI_API_KEY=your-api-key

# Optional: Cache TTL in seconds (default: 300)
SPEC_CACHE_TTL=300

# Transport: 'stdio' for local, 'http-stream' for remote (default: stdio)
MCP_TRANSPORT=stdio

# HTTP transport settings (only used when MCP_TRANSPORT=http-stream)
MCP_PORT=8080
API_KEYS=key1,key2  # Comma-separated API keys for client authentication
CORS_ORIGIN=*
```

### Running Locally

```bash
# Development (build + run)
npm run dev

# Or production
npm run build
npm start
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAPI_SPEC_URL` | Yes | - | URL to the OpenAPI specification (JSON or YAML) |
| `OPENAPI_API_KEY` | No | - | API key for authenticated spec endpoints (sent as `X-API-Key` header) |
| `SPEC_CACHE_TTL` | No | `300` | How long to cache the spec in seconds |
| `MCP_TRANSPORT` | No | `stdio` | Transport type: `stdio` or `http-stream` |
| `MCP_PORT` | No | `8080` | Port for HTTP transport |
| `API_KEYS` | No | - | Comma-separated API keys for HTTP client authentication |
| `CORS_ORIGIN` | No | `*` | Allowed CORS origins for HTTP transport |

## Usage

### With Claude Desktop

Add to your Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "openapi": {
      "command": "node",
      "args": ["/path/to/openapi-mcp/dist/index.js"],
      "env": {
        "OPENAPI_SPEC_URL": "https://api.example.com/openapi.json",
        "OPENAPI_API_KEY": "your-api-key"
      }
    }
  }
}
```

### With Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "openapi": {
      "command": "node",
      "args": ["/path/to/openapi-mcp/dist/index.js"],
      "env": {
        "OPENAPI_SPEC_URL": "https://api.example.com/openapi.json"
      }
    }
  }
}
```

### With MCP Inspector

For testing and debugging, use the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
# Start the server in HTTP mode
MCP_TRANSPORT=http-stream npm run dev

# Connect Inspector to http://localhost:8080/mcp
```

## Docker Deployment

### Using Docker Compose (Recommended)

```bash
cd docker

# Set required environment variables
export OPENAPI_SPEC_URL=https://api.example.com/openapi.json
export OPENAPI_API_KEY=your-api-key  # if needed

# Start the server
docker-compose up -d
```

### Using Docker Directly

```bash
# Build the image
docker build -f docker/Dockerfile -t openapi-mcp .

# Run the container
docker run -d \
  -p 8080:8080 \
  -e OPENAPI_SPEC_URL=https://api.example.com/openapi.json \
  -e OPENAPI_API_KEY=your-api-key \
  -e API_KEYS=client-key-1,client-key-2 \
  openapi-mcp
```

### Docker Environment

When running in Docker, the server automatically uses HTTP stream transport on port 8080. Configure client authentication by setting the `API_KEYS` environment variable.

The container includes:
- Health check endpoint at `/mcp`
- Graceful shutdown handling
- Automatic restart on failure (when using docker-compose)

## HTTP API Authentication

When running in HTTP stream mode with `API_KEYS` configured, clients must include an API key in requests:

```bash
# Via header
curl -H "X-API-Key: your-client-key" http://localhost:8080/mcp

# Or via query parameter
curl http://localhost:8080/mcp?api_key=your-client-key
```

If no `API_KEYS` are configured, the server runs without authentication (suitable for local development or trusted networks).

## Tool Examples

### Search for Endpoints

```json
{
  "tool": "search_endpoints",
  "arguments": {
    "pathPattern": "user",
    "method": "GET",
    "limit": 10
  }
}
```

### Get Endpoint Details

```json
{
  "tool": "get_endpoint_details",
  "arguments": {
    "path": "/api/v2/users/{id}",
    "method": "GET",
    "resolveRefs": true
  }
}
```

### Search Schemas

```json
{
  "tool": "search_schemas",
  "arguments": {
    "namePattern": "User",
    "propertyName": "email"
  }
}
```

### Get Schema Details

```json
{
  "tool": "get_schema_details",
  "arguments": {
    "schemaName": "UserResponse",
    "resolveRefs": true,
    "maxDepth": 5
  }
}
```

### Get Spec Section

```json
{
  "tool": "get_openapi_spec",
  "arguments": {
    "section": "paths",
    "pathFilter": "/users"
  }
}
```

## Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run in development mode
npm run dev
```

### Project Structure

```
openapi-mcp/
├── src/
│   ├── index.ts           # Server entry point
│   ├── config.ts          # Environment configuration
│   ├── tools/             # MCP tool implementations
│   │   ├── SearchEndpointsTool.ts
│   │   ├── GetEndpointDetailsTool.ts
│   │   ├── SearchSchemasTool.ts
│   │   ├── GetSchemaDetailsTool.ts
│   │   └── GetOpenAPISpecTool.ts
│   └── utils/
│       ├── OpenAPIManager.ts  # Spec fetching and caching
│       └── RefResolver.ts     # $ref resolution
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml
├── .env.example
└── package.json
```

## License

MIT
