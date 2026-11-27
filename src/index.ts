#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

// stdout carries the protocol, so anything meant for a human goes to stderr.
const server = createServer();
await server.connect(new StdioServerTransport());
console.error("lichess-mcp is running on stdio");
