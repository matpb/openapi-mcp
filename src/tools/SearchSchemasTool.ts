import { MCPTool } from "mcp-framework";
import { z } from "zod";
import { openAPIManager } from "../utils/OpenAPIManager.js";

interface SearchSchemasInput {
  namePattern?: string;
  propertyName?: string;
  limit?: number;
  offset?: number;
}

class SearchSchemasTool extends MCPTool<SearchSchemasInput> {
  name = "search_schemas";
  description = "Search for schemas/models in the OpenAPI spec by name pattern or property name. Returns a paginated list of matching schemas.";

  schema = {
    namePattern: {
      type: z.string().optional(),
      description: "Regex pattern to match schema names (e.g., 'User' to find User, UserResponse, etc.)",
    },
    propertyName: {
      type: z.string().optional(),
      description: "Find schemas that contain a property with this name (partial match)",
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
        namePattern: z.string().optional(),
        propertyName: z.string().optional(),
        limit: z.number().optional(),
        offset: z.number().optional(),
      });
      const validatedInput = zodSchema.parse(args) as SearchSchemasInput;
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

  async execute(input: SearchSchemasInput) {
    const { schemas, total } = await openAPIManager.searchSchemas(input);
    const limit = input.limit || 20;
    const offset = input.offset || 0;

    return {
      success: true,
      schemas,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + schemas.length < total,
      },
    };
  }
}

export default SearchSchemasTool;
