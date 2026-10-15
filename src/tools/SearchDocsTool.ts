import { MCPTool } from "mcp-framework";
import { z } from "zod";
import { openAPIManager } from "../utils/OpenAPIManager.js";

interface SearchDocsInput {
  query: string;
  limit?: number;
  offset?: number;
}

const limitSchema = z.number().int().min(1).max(50);
const offsetSchema = z.number().int().min(0);

class SearchDocsTool extends MCPTool<SearchDocsInput> {
  name = "search_docs";
  description = "Search the platform overview, guides and endpoints (path, operationId, summary, description; endpoint hits rank after guides) for one or more words (case-insensitive; an entry matches when it contains every word, in any order; page through hits with limit and offset). Use it to find which guide or endpoint covers a topic, then open it with get_guide or get_endpoint_details.";

  schema = {
    query: {
      type: z.string(),
      description: "Words to search for; every word must appear (case-insensitive)",
    },
    limit: {
      type: limitSchema.optional(),
      description: "Maximum number of results to return (integer 1-50, default 10)",
    },
    offset: {
      type: offsetSchema.optional(),
      description: "Number of hits to skip before returning results (integer >= 0, default 0)",
    },
  };

  async toolCall(request: { params: { arguments?: Record<string, unknown> } }) {
    try {
      const args = request.params.arguments || {};
      const zodSchema = z.object({
        query: z.string(),
        limit: limitSchema.optional(),
        offset: offsetSchema.optional(),
      });
      const validatedInput = zodSchema.parse(args) as SearchDocsInput;
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

  async execute(input: SearchDocsInput) {
    const result = await openAPIManager.searchDocs(input.query, input.limit, input.offset);
    return {
      success: true,
      data: result,
    };
  }
}

export default SearchDocsTool;
