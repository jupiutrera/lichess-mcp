// Starts the built server over stdio and calls every tool once against the live API.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] });
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);

const calls = [
  ["get_player", { username: "DrNykterstein" }],
  ["get_recent_games", { username: "DrNykterstein", max: 2 }],
  ["get_daily_puzzle", {}],
  ["get_cloud_eval", { fen: "startpos", lines: 2 }],
  ["explore_masters", { fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", moves: 3 }],
  ["probe_tablebase", { fen: "8/8/8/8/8/2k5/8/2KQ4 w - - 0 1", moves: 3 }],
  ["get_leaderboard", { perfType: "blitz", count: 3 }],
  ["get_player", { username: "zzzz_nope_zzzz_123" }],
  ["probe_tablebase", { fen: "startpos" }],
  ["get_cloud_eval", { fen: "8/8/3k4/8/2n5/8/1K3N2/7R w - - 0 1" }],
  ["get_cloud_eval", { fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP b KQkq - 0 1" }],
];

let failed = 0;
const max = Number(process.env.SMOKE_CHARS ?? 500);
for (const [name, args] of calls) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content[0]?.text ?? "";
  console.log(`\n--- ${name} ${JSON.stringify(args)}${result.isError ? "  [isError]" : ""}`);
  console.log(text.length > max ? `${text.slice(0, max)}…` : text);
  if (text === "") failed += 1;
}
await client.close();
process.exit(failed === 0 ? 0 : 1);
