import { MCPTool } from "mcp-framework";
import { z } from "zod";
import { openAPIManager } from "../utils/OpenAPIManager.js";

interface GetOpenAPISpecInput {
  section?: string;
  pathFilter?: string;
}

class GetOpenAPISpecTool extends MCPTool<GetOpenAPISpecInput> {
  name = "get_openapi_spec";
  description = "Return the full OpenAPI spec or a filtered section. Use section to get specific parts (info, paths, components, tags, servers, full). Use pathFilter to filter paths by regex pattern.";

  schema = {
    section: {
      type: z.string().optional(),
      description: "Section to retrieve: info, paths, components, tags, servers, or full (default: full)",
    },
    pathFilter: {
      type: z.string().optional(),
      description: "Regex pattern to filter paths (e.g., '/users' to get all user-related endpoints)",
    },
  };

  async toolCall(request: { params: { arguments?: Record<string, unknown> } }) {
    try {
      const args = request.params.arguments || {};
      const zodSchema = z.object({
        section: z.string().optional(),
        pathFilter: z.string().optional(),
      });
      const validatedInput = zodSchema.parse(args) as GetOpenAPISpecInput;
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

  async execute(input: GetOpenAPISpecInput) {
    const result = await openAPIManager.getSpecSection(input.section, input.pathFilter);
    return {
      success: true,
      data: result,
    };
  }
}

export default GetOpenAPISpecTool;
