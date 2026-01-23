import { MCPTool } from "mcp-framework";
import { z } from "zod";
import { openAPIManager } from "../utils/OpenAPIManager.js";

interface SearchEndpointsInput {
  pathPattern?: string;
  method?: string;
  tags?: string[];
  description?: string;
  limit?: number;
  offset?: number;
}

class SearchEndpointsTool extends MCPTool<SearchEndpointsInput> {
  name = "search_endpoints";
  description = "Search API endpoints by path pattern, HTTP method, tags, or description. Returns a paginated list of matching endpoints.";

  schema = {
    pathPattern: {
      type: z.string().optional(),
      description: "Regex pattern to match endpoint paths (e.g., 'user' to find all user-related endpoints)",
    },
    method: {
      type: z.string().optional(),
      description: "HTTP method to filter by (GET, POST, PUT, PATCH, DELETE)",
    },
    tags: {
      type: z.array(z.string()).optional(),
      description: "Array of tags to filter by (endpoints matching any tag will be included)",
    },
    description: {
      type: z.string().optional(),
      description: "Regex pattern to search in endpoint summary/description",
    },
    limit: {
      type: z.number().optional(),
      description: "Maximum number of results to return (default: 20)",
    },
    offset: {
      type: z.number().optional(),
      description: "Number of results to skip for pagination (default: 0)",
    },
  };

  async toolCall(request: { params: { arguments?: Record<string, unknown> } }) {
    try {
      const args = request.params.arguments || {};
      const zodSchema = z.object({
        pathPattern: z.string().optional(),
        method: z.string().optional(),
        tags: z.array(z.string()).optional(),
        description: z.string().optional(),
        limit: z.number().optional(),
        offset: z.number().optional(),
      });
      const validatedInput = zodSchema.parse(args) as SearchEndpointsInput;
      const result = await this.execute(validatedInput);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }) }],
        isError: true,
      };
    }
  }

  async execute(input: SearchEndpointsInput) {
    const { endpoints, total } = await openAPIManager.searchEndpoints(input);
    const limit = input.limit || 20;
    const offset = input.offset || 0;

    return {
      success: true,
      endpoints,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + endpoints.length < total,
      },
    };
  }
}

export default SearchEndpointsTool;
