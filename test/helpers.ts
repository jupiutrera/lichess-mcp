import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

export interface Reply {
  status?: number;
  body: unknown;
}

export interface FakeLichess {
  fetch: typeof fetch;
  /** Every URL requested, in order. */
  requests: { url: URL; accept: string }[];
}

/**
 * A fetch that answers from a table keyed by URL path. A reply whose body is a
 * string is sent as is (NDJSON, plain-text errors); anything else is sent as JSON.
 */
export function fakeLichess(routes: Record<string, Reply>): FakeLichess {
  const requests: FakeLichess["requests"] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const headers = new Headers(init?.headers);
    requests.push({ url, accept: headers.get("accept") ?? "" });
    const reply = routes[url.pathname];
    if (!reply) return new Response('{"error":"Not found"}', { status: 404 });
    const body = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return new Response(body, { status: reply.status ?? 200 });
  }) as typeof fetch;
  return { fetch: fakeFetch, requests };
}

/** A real MCP client connected in memory to a server that uses the given fetch. */
export async function connect(fetchImpl: typeof fetch): Promise<Client> {
  const server = createServer({ fetch: fetchImpl });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

export interface CallResult {
  isError: boolean;
  text: string;
  /** The parsed result of a successful call. */
  data: any;
}

export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  const text = content[0]?.text ?? "";
  const isError = result.isError === true;
  return { isError, text, data: isError ? undefined : JSON.parse(text) };
}
