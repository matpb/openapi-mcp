import { MCPTool } from "mcp-framework";
import { z } from "zod";
import { openAPIManager } from "../utils/OpenAPIManager.js";

interface GetGuideInput {
  id: string;
}

class GetGuideTool extends MCPTool<GetGuideInput> {
  name = "get_guide";
  description = "Return the full markdown of one platform guide by id (from list_guides), or the platform overview with id \"overview\". Use it when you need to understand a concept, feature or workflow before calling endpoints.";

  schema = {
    id: {
      type: z.string(),
      description: "Guide id from list_guides (e.g., 'feed' or 'guide:feed'), or 'overview'",
    },
  };

  async toolCall(request: { params: { arguments?: Record<string, unknown> } }) {
    try {
      const args = request.params.arguments || {};
      const zodSchema = z.object({
        id: z.string(),
      });
      const validatedInput = zodSchema.parse(args) as GetGuideInput;
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

  async execute(input: GetGuideInput) {
    const result = await openAPIManager.getGuide(input.id);
    return {
      success: true,
      data: {
        id: result.id,
        title: result.title,
        group: result.group,
        summary: result.summary,
        verifiedAgainst: result.verifiedAgainst,
        markdown: result.markdown,
      },
    };
  }
}

export default GetGuideTool;
