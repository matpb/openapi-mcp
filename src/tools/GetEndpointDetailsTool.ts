import { MCPTool } from "mcp-framework";
import { z } from "zod";
import { openAPIManager } from "../utils/OpenAPIManager.js";

interface GetEndpointDetailsInput {
  path: string;
  method: string;
  resolveRefs?: boolean;
}

class GetEndpointDetailsTool extends MCPTool<GetEndpointDetailsInput> {
  name = "get_endpoint_details";
  description = "Get detailed information about a specific API endpoint including parameters, request body schema, and response schemas.";

  schema = {
    path: {
      type: z.string(),
      description: "The endpoint path (e.g., '/api/v2/users/{id}')",
    },
    method: {
      type: z.string(),
      description: "HTTP method (GET, POST, PUT, PATCH, DELETE)",
    },
    resolveRefs: {
      type: z.boolean().optional(),
      description: "Whether to resolve $ref references inline (default: true)",
    },
  };

  async toolCall(request: { params: { arguments?: Record<string, unknown> } }) {
    try {
      const args = request.params.arguments || {};
      const zodSchema = z.object({
        path: z.string(),
        method: z.string(),
        resolveRefs: z.boolean().optional(),
      });
      const validatedInput = zodSchema.parse(args) as GetEndpointDetailsInput;
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

  async execute(input: GetEndpointDetailsInput) {
    const resolveRefs = input.resolveRefs !== false;
    const details = await openAPIManager.getEndpointDetails(input.path, input.method, resolveRefs);

    return {
      success: true,
      endpoint: details,
    };
  }
}

export default GetEndpointDetailsTool;
