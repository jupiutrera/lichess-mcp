import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LichessClient, type ClientOptions } from "./lichess.js";
import { tools } from "./tools.js";

export const SERVER_INFO = { name: "lichess-mcp", version: "0.1.0" } as const;

/**
 * Builds the MCP server. Every tool is read-only and talks to a public API,
 * and a failed call comes back as a tool result with isError set, so the
 * model can read what went wrong and correct itself instead of the client
 * seeing a protocol error.
 */
export function createServer(options: ClientOptions = {}): McpServer {
  const client = new LichessClient(options);
  const server = new McpServer(SERVER_INFO, {
    instructions:
      "Read-only access to public Lichess data: players, games, the daily puzzle, cloud engine evaluations, " +
      "master-game opening statistics and endgame tablebases. Positions are given in FEN.",
  });

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await tool.run(client, args);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { content: [{ type: "text" as const, text: message }], isError: true };
        }
      },
    );
  }

  return server;
}
