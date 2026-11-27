import { describe, expect, it } from "vitest";
import { parseFen } from "../src/fen.js";
import { buildUrl, LichessClient, LichessError } from "../src/lichess.js";
import { extractGameId, formatScore } from "../src/tools.js";

describe("parseFen", () => {
  it("fills in the fields a model tends to leave out", () => {
    expect(parseFen("8/8/8/8/8/2k5/2p5/2K5 w")).toEqual({
      fen: "8/8/8/8/8/2k5/2p5/2K5 w - - 0 1",
      sideToMove: "white",
      pieceCount: 3,
    });
  });

  it("accepts underscores for spaces and the startpos shorthand", () => {
    expect(parseFen("8/8/8/8/8/2k5/2p5/2K5_b_-_-_0_1").sideToMove).toBe("black");
    expect(parseFen("startpos").pieceCount).toBe(32);
  });

  it.each([
    ["e4 e5", /8 ranks/],
    ["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBN w KQkq - 0 1", /rank 1 .* 7 squares/i],
    ["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNX w KQkq - 0 1", /unexpected character "X"/i],
    ["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR white", /"w" or "b"/],
    ["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR", /side to move/],
  ])("rejects %s", (fen, message) => {
    expect(() => parseFen(fen)).toThrow(message);
  });
});

describe("extractGameId", () => {
  it.each([
    ["q7ZvsdUF", "q7ZvsdUF"],
    ["q7ZvsdUFabcd", "q7ZvsdUF"],
    ["https://lichess.org/q7ZvsdUF", "q7ZvsdUF"],
    ["lichess.org/q7ZvsdUF/white", "q7ZvsdUF"],
  ])("reads %s", (input, id) => {
    expect(extractGameId(input)).toBe(id);
  });

  it("rejects other sites", () => {
    expect(() => extractGameId("https://chess.com/game/1")).toThrow(/not a Lichess game id/);
  });
});

describe("formatScore", () => {
  it("signs centipawns and names the mating side", () => {
    expect(formatScore({ cp: 0 })).toBe("0.00");
    expect(formatScore({ cp: 7 })).toBe("+0.07");
    expect(formatScore({ cp: -250 })).toBe("-2.50");
    expect(formatScore({ mate: 2 })).toBe("White mates in 2");
    expect(formatScore({ mate: -1 })).toBe("Black mates in 1");
  });
});

describe("buildUrl", () => {
  it("encodes the FEN and skips undefined parameters", () => {
    const url = buildUrl("https://lichess.org", "/api/cloud-eval", {
      fen: "8/8/8/8/8/2k5/2p5/2K5 w - - 0 1",
      multiPv: 2,
      variant: undefined,
    });
    expect(url).toBe("https://lichess.org/api/cloud-eval?fen=8%2F8%2F8%2F8%2F8%2F2k5%2F2p5%2F2K5+w+-+-+0+1&multiPv=2");
  });
});

describe("LichessClient", () => {
  it("identifies itself with a User-Agent", async () => {
    let seen = "";
    const client = new LichessClient({
      fetch: (async (_url: unknown, init?: RequestInit) => {
        seen = new Headers(init?.headers).get("user-agent") ?? "";
        return new Response("{}");
      }) as typeof fetch,
    });
    await client.json("https://lichess.org/api/x");
    expect(seen).toMatch(/^lichess-mcp\//);
  });

  it("reports a timeout as such", async () => {
    const client = new LichessClient({
      timeoutMs: 20,
      fetch: ((_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        })) as typeof fetch,
    });
    await expect(client.json("https://lichess.org/api/x")).rejects.toThrow(/did not answer within/);
  });

  it("reports a network failure without a status", async () => {
    const client = new LichessClient({
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    const error = await client.json("https://lichess.org/api/x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LichessError);
    expect((error as LichessError).status).toBeUndefined();
    expect((error as LichessError).message).toMatch(/could not reach lichess/i);
  });

  it("does not leak an HTML error page into the tool result", async () => {
    const client = new LichessClient({
      fetch: (async () => new Response("<html><body>401 Authorization Required</body></html>", { status: 401 })) as typeof fetch,
    });
    const error = (await client.json("https://explorer.lichess.ovh/lichess").catch((e: unknown) => e)) as LichessError;
    expect(error.status).toBe(401);
    expect(error.message).not.toContain("<html>");
  });

  it("fails clearly on a body that is not JSON", async () => {
    const client = new LichessClient({ fetch: (async () => new Response("oops")) as typeof fetch });
    await expect(client.json("https://lichess.org/api/x")).rejects.toThrow(/not JSON/);
    await expect(client.ndjson("https://lichess.org/api/x")).rejects.toThrow(/malformed NDJSON/);
  });
});
