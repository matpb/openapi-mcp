import { MCPTool } from "mcp-framework";
import { z } from "zod";
import { openAPIManager } from "../utils/OpenAPIManager.js";

type ListGuidesInput = Record<string, never>;

class ListGuidesTool extends MCPTool<ListGuidesInput> {
  name = "list_guides";
  description = "List the platform guides: the overview plus guides grouped by topic, each with id, title and summary. Call this first to discover what the platform guides cover, then use get_guide for the full text.";

  schema = {};

  async toolCall(request: { params: { arguments?: Record<string, unknown> } }) {
    try {
      const args = request.params.arguments || {};
      const zodSchema = z.object({});
      const validatedInput = zodSchema.parse(args) as ListGuidesInput;
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

  async execute(_input: ListGuidesInput) {
    const result = await openAPIManager.listGuides();
    return {
      success: true,
      data: result,
    };
  }
}

export default ListGuidesTool;
