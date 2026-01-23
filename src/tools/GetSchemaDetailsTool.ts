import { MCPTool } from "mcp-framework";
import { z } from "zod";
import { openAPIManager } from "../utils/OpenAPIManager.js";

interface GetSchemaDetailsInput {
  schemaName: string;
  resolveRefs?: boolean;
  maxDepth?: number;
}

class GetSchemaDetailsTool extends MCPTool<GetSchemaDetailsInput> {
  name = "get_schema_details";
  description = "Get detailed information about a specific schema/model including all properties and nested schemas with resolved $ref references.";

  schema = {
    schemaName: {
      type: z.string(),
      description: "The name of the schema to retrieve (e.g., 'User', 'OrderResponse')",
    },
    resolveRefs: {
      type: z.boolean().optional(),
      description: "Whether to resolve $ref references inline (default: true)",
    },
    maxDepth: {
      type: z.number().optional(),
      description: "Maximum depth for resolving nested references (default: 5). Use lower values for deeply nested schemas.",
    },
  };

  async toolCall(request: { params: { arguments?: Record<string, unknown> } }) {
    try {
      const args = request.params.arguments || {};
      const zodSchema = z.object({
        schemaName: z.string(),
        resolveRefs: z.boolean().optional(),
        maxDepth: z.number().optional(),
      });
      const validatedInput = zodSchema.parse(args) as GetSchemaDetailsInput;
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

  async execute(input: GetSchemaDetailsInput) {
    const resolveRefs = input.resolveRefs !== false;
    const maxDepth = input.maxDepth || 5;
    const details = await openAPIManager.getSchemaDetails(input.schemaName, resolveRefs, maxDepth);

    return {
      success: true,
      data: details,
    };
  }
}

export default GetSchemaDetailsTool;
