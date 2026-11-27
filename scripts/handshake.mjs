// Starts the built server over stdio and lists its tools. No network needed, so CI can run it.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] });
const client = new Client({ name: "handshake", version: "0.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
await client.close();

console.log(`${tools.length} tools: ${tools.map((tool) => tool.name).join(", ")}`);
if (tools.length !== 8) process.exit(1);
