/**
 * Thin HTTP client for the public Lichess API.
 *
 * Only unauthenticated, read-only endpoints are used. Every failure is turned
 * into a LichessError whose message tells the calling model what to do next,
 * because that message is what ends up in the tool result.
 */

export const HOSTS = {
  api: "https://lichess.org",
  explorer: "https://explorer.lichess.ovh",
  tablebase: "https://tablebase.lichess.ovh",
} as const;

export class LichessError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "LichessError";
    this.status = status;
  }
}

export interface ClientOptions {
  /** Injected in tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
}

type Query = Record<string, string | number | boolean | undefined>;

export function buildUrl(host: string, path: string, query: Query = {}): string {
  const url = new URL(path, host);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export class LichessClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(options: ClientOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.userAgent = options.userAgent ?? "lichess-mcp/0.1 (+https://github.com/jupiutrera/lichess-mcp)";
  }

  /** GET a JSON document. */
  async json<T>(url: string, accept = "application/json"): Promise<T> {
    const body = await this.text(url, accept);
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new LichessError(`Lichess returned a response that is not JSON for ${url}.`);
    }
  }

  /** GET a newline-delimited JSON stream and return its rows. */
  async ndjson<T>(url: string): Promise<T[]> {
    const body = await this.text(url, "application/x-ndjson");
    const rows: T[] = [];
    for (const line of body.split("\n")) {
      if (line.trim() === "") continue;
      try {
        rows.push(JSON.parse(line) as T);
      } catch {
        throw new LichessError(`Lichess returned a malformed NDJSON row for ${url}.`);
      }
    }
    return rows;
  }

  private async text(url: string, accept: string): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { Accept: accept, "User-Agent": this.userAgent },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      const name = cause instanceof Error ? cause.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        throw new LichessError(`Lichess did not answer within ${this.timeoutMs / 1000} s. Try again later.`);
      }
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new LichessError(`Could not reach Lichess: ${detail}`);
    }

    const body = await response.text();
    if (response.ok) return body;
    throw new LichessError(describeFailure(response.status, body), response.status);
  }
}

function describeFailure(status: number, body: string): string {
  const detail = extractDetail(body);
  switch (status) {
    case 400:
      return `Lichess rejected the request: ${detail || "bad request"}. Check the arguments and try again.`;
    case 401:
    case 403:
      return "Lichess requires authentication for this endpoint, which this server does not support.";
    case 404:
      return detail && detail !== "Not found"
        ? `${detail}.`
        : "Lichess has nothing at that address. Check the username or id for typos.";
    case 429:
      return "Lichess rate limit reached. Wait a full minute before calling any Lichess tool again.";
    default:
      return `Lichess answered with HTTP ${status}${detail ? `: ${detail}` : ""}.`;
  }
}

function extractDetail(body: string): string {
  const trimmed = body.trim();
  if (trimmed === "" || trimmed.startsWith("<")) return "";
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      return String((parsed as { error: unknown }).error);
    }
  } catch {
    // Plain-text error bodies (explorer and tablebase) fall through.
  }
  return trimmed.slice(0, 200);
}
