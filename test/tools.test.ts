import { describe, expect, it } from "vitest";
import { call, connect, fakeLichess } from "./helpers.js";

// Replies are trimmed copies of what the live API returned on 2026-11-27.

const MAGNUS = {
  id: "drnykterstein",
  username: "DrNykterstein",
  title: "GM",
  flair: "people.santa-claus-light-skin-tone",
  patron: true,
  perfs: {
    ultraBullet: { games: 92, rating: 2406, rd: 239, prog: -7, prov: true },
    bullet: { games: 9585, rating: 3263, rd: 92, prog: 23 },
    blitz: { games: 614, rating: 3196, rd: 153, prog: 66, prov: true },
    rapid: { games: 0, rating: 2500, rd: 150, prog: 0, prov: true },
    storm: { runs: 12, score: 60 },
  },
  createdAt: 1544100290814,
  seenAt: 1795636425205,
  count: { all: 10460, rated: 10445, win: 7217, loss: 2409, draw: 834 },
  url: "https://lichess.org/@/DrNykterstein",
};

const GAME_WON_AS_BLACK = {
  id: "L07dBpjM",
  rated: true,
  variant: "standard",
  speed: "blitz",
  createdAt: 1795636441790,
  status: "resign",
  players: {
    white: { user: { name: "Budanov_Aleksandr", id: "budanov_aleksandr" }, rating: 2300, ratingDiff: 0 },
    black: { user: { name: "DrNykterstein", title: "GM", id: "drnykterstein" }, rating: 3195, ratingDiff: 1 },
  },
  winner: "black",
  opening: { eco: "A00", name: "Polish Opening: King's Indian Variation", ply: 4 },
  clock: { initial: 180, increment: 0, totalTime: 180 },
};

const GAME_LOST_AS_WHITE = {
  ...GAME_WON_AS_BLACK,
  id: "6p6wZYne",
  status: "mate",
  players: {
    white: { user: { name: "DrNykterstein", title: "GM", id: "drnykterstein" }, rating: 3195 },
    black: { aiLevel: 8 },
  },
  winner: "black",
};

const GAME_DRAWN = { ...GAME_WON_AS_BLACK, id: "abcd1234", status: "draw", winner: undefined };

const E4_FEN = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

describe("the server", () => {
  it("lists eight read-only tools, each with a description and an input schema", async () => {
    const client = await connect(fakeLichess({}).fetch);
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      "get_player",
      "get_recent_games",
      "get_game",
      "get_daily_puzzle",
      "get_cloud_eval",
      "explore_masters",
      "probe_tablebase",
      "get_leaderboard",
    ]);
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(40);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });

  it("rejects arguments that do not match the schema without calling Lichess", async () => {
    const lichess = fakeLichess({});
    const client = await connect(lichess.fetch);

    const badName = await call(client, "get_player", { username: "not a username!" });
    const tooMany = await call(client, "get_recent_games", { username: "DrNykterstein", max: 500 });

    expect(badName.isError).toBe(true);
    expect(tooMany.isError).toBe(true);
    expect(lichess.requests).toHaveLength(0);
  });
});

describe("get_player", () => {
  it("keeps the ratings that have games, most played first, and drops the noise", async () => {
    const client = await connect(fakeLichess({ "/api/user/DrNykterstein": { body: MAGNUS } }).fetch);

    const { data } = await call(client, "get_player", { username: "DrNykterstein" });

    expect(data.title).toBe("GM");
    expect(data.games).toEqual({ total: 10460, rated: 10445, wins: 7217, losses: 2409, draws: 834 });
    expect(data.ratings).toEqual([
      { variant: "bullet", rating: 3263, games: 9585, provisional: false },
      { variant: "blitz", rating: 3196, games: 614, provisional: true },
      { variant: "ultraBullet", rating: 2406, games: 92, provisional: true },
    ]);
    expect(data.joined).toBe("2018-12-06T12:44:50.814Z");
    expect(JSON.stringify(data)).not.toContain("flair");
  });

  it("explains a 404 in words the model can act on", async () => {
    const client = await connect(fakeLichess({}).fetch);

    const result = await call(client, "get_player", { username: "nobody_here" });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/check the username/i);
  });

  it("tells the model to back off when Lichess rate limits", async () => {
    const client = await connect(
      fakeLichess({ "/api/user/DrNykterstein": { status: 429, body: { error: "Too many requests" } } }).fetch,
    );

    const result = await call(client, "get_player", { username: "DrNykterstein" });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/wait a full minute/i);
  });
});

describe("get_recent_games", () => {
  const ndjson = [GAME_WON_AS_BLACK, GAME_LOST_AS_WHITE, GAME_DRAWN].map((g) => JSON.stringify(g)).join("\n") + "\n";

  it("computes the record from the player's side of each game", async () => {
    const lichess = fakeLichess({ "/api/games/user/drnykterstein": { body: ndjson } });
    const client = await connect(lichess.fetch);

    // Lower case on purpose: usernames are not case sensitive.
    const { data } = await call(client, "get_recent_games", { username: "drnykterstein", max: 3 });

    expect(data.record).toEqual({ wins: 1, losses: 1, draws: 1 });
    expect(data.games.map((g: any) => [g.playedAs, g.outcome])).toEqual([
      ["black", "win"],
      ["white", "loss"],
      ["black", "draw"],
    ]);
    expect(data.games[0].opening).toBe("A00 Polish Opening: King's Indian Variation");
    expect(data.games[0].timeControl).toBe("3+0");
    expect(data.games[1].black.name).toBe("Stockfish level 8");
  });

  it("asks for NDJSON and passes the filters through", async () => {
    const lichess = fakeLichess({ "/api/games/user/DrNykterstein": { body: ndjson } });
    const client = await connect(lichess.fetch);

    await call(client, "get_recent_games", { username: "DrNykterstein", perfType: "blitz", rated: true });

    const [request] = lichess.requests;
    expect(request?.accept).toBe("application/x-ndjson");
    expect(Object.fromEntries(request!.url.searchParams)).toEqual({
      max: "5",
      perfType: "blitz",
      rated: "true",
      opening: "true",
      moves: "false",
    });
  });
});

describe("get_game", () => {
  it("accepts a URL with a colour suffix and returns the moves", async () => {
    const lichess = fakeLichess({ "/game/export/L07dBpjM": { body: { ...GAME_WON_AS_BLACK, moves: "b4 g6 Bb2 Nf6" } } });
    const client = await connect(lichess.fetch);

    const { data } = await call(client, "get_game", { game: "https://lichess.org/L07dBpjM/black#12" });

    expect(data.moves).toBe("b4 g6 Bb2 Nf6");
    expect(data.winner).toBe("black");
    expect(data.endedBy).toBe("resign");
  });

  it("refuses something that is not a game id", async () => {
    const lichess = fakeLichess({});
    const client = await connect(lichess.fetch);

    const result = await call(client, "get_game", { game: "https://example.com/game" });

    expect(result.isError).toBe(true);
    expect(lichess.requests).toHaveLength(0);
  });
});

describe("get_daily_puzzle", () => {
  it("says whose move it is and gives the solution", async () => {
    const client = await connect(
      fakeLichess({
        "/api/puzzle/daily": {
          body: {
            game: { id: "x1aiUFti", perf: { key: "rapid", name: "Rapid" }, players: [] },
            puzzle: {
              id: "9jL9E",
              rating: 1767,
              plays: 15959,
              solution: ["h6h8", "g8h8", "g6f7"],
              themes: ["deflection", "pin"],
              fen: "r1b1r1k1/pp3qb1/5nQR/3p2p1/3P4/3BP1P1/PPP2PP1/R3K3 w Q - 1 1",
            },
          },
        },
      }).fetch,
    );

    const { data } = await call(client, "get_daily_puzzle");

    expect(data.sideToMove).toBe("white");
    expect(data.solutionUci).toEqual(["h6h8", "g8h8", "g6f7"]);
    expect(data.url).toBe("https://lichess.org/training/9jL9E");
  });
});

describe("get_cloud_eval", () => {
  it("formats centipawns and mates from White's point of view", async () => {
    const lichess = fakeLichess({
      "/api/cloud-eval": {
        body: {
          depth: 60,
          knodes: 119133,
          pvs: [
            { moves: "e7e5 g1f3", cp: 22 },
            { moves: "c7c6 d2d4", cp: -135 },
            { moves: "g7g5 d1h5", mate: -3 },
          ],
        },
      },
    });
    const client = await connect(lichess.fetch);

    const { data } = await call(client, "get_cloud_eval", { fen: E4_FEN, lines: 3 });

    expect(data.lines.map((line: any) => line.evaluation)).toEqual(["+0.22", "-1.35", "Black mates in 3"]);
    expect(data.lines[0].movesUci).toEqual(["e7e5", "g1f3"]);
    expect(data.sideToMove).toBe("black");
    expect(lichess.requests[0]?.url.searchParams.get("multiPv")).toBe("3");
  });

  it("passes on why Lichess has no evaluation", async () => {
    const client = await connect(
      fakeLichess({
        "/api/cloud-eval": { status: 404, body: { error: "No cloud evaluation available for that position" } },
      }).fetch,
    );

    const result = await call(client, "get_cloud_eval", { fen: "8/8/3k4/8/2n5/8/1K3N2/7R w - - 0 1" });

    expect(result.isError).toBe(true);
    expect(result.text).toBe("No cloud evaluation available for that position.");
  });

  it("catches a malformed FEN before the network", async () => {
    const lichess = fakeLichess({});
    const client = await connect(lichess.fetch);

    const result = await call(client, "get_cloud_eval", { fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP b KQkq - 0 1" });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/8 ranks/);
    expect(lichess.requests).toHaveLength(0);
  });
});

describe("explore_masters", () => {
  it("turns game counts into percentages", async () => {
    const lichess = fakeLichess({
      "/masters": {
        body: {
          white: 300,
          draws: 500,
          black: 200,
          opening: { eco: "B00", name: "King's Pawn Game" },
          moves: [
            { uci: "c7c5", san: "c5", averageRating: 2396, white: 150, draws: 250, black: 100, opening: { eco: "B20", name: "Sicilian Defense" } },
            { uci: "e7e5", san: "e5", averageRating: 2405, white: 50, draws: 150, black: 50, opening: null },
          ],
        },
      },
    });
    const client = await connect(lichess.fetch);

    const { data } = await call(client, "explore_masters", { fen: E4_FEN, moves: 2 });

    expect(lichess.requests[0]?.url.host).toBe("explorer.lichess.ovh");
    expect(data).toMatchObject({ games: 1000, whiteWinsPct: 30, drawsPct: 50, blackWinsPct: 20 });
    expect(data.moves[0]).toMatchObject({ san: "c5", games: 500, playedPct: 50, leadsTo: "B20 Sicilian Defense" });
    expect(data.moves[1]).toMatchObject({ san: "e5", games: 250, playedPct: 25, drawsPct: 60 });
    expect(data.note).toBeUndefined();
  });

  it("says so when no master game reached the position", async () => {
    const client = await connect(
      fakeLichess({ "/masters": { body: { white: 0, draws: 0, black: 0, moves: [], opening: null } } }).fetch,
    );

    const { data } = await call(client, "explore_masters", { fen: E4_FEN });

    expect(data.games).toBe(0);
    expect(data.whiteWinsPct).toBe(0);
    expect(data.note).toMatch(/no master game/i);
  });
});

describe("probe_tablebase", () => {
  it("reports each move from the side that plays it", async () => {
    const client = await connect(
      fakeLichess({
        "/standard": {
          body: {
            category: "win",
            dtz: 13,
            dtm: 7,
            checkmate: false,
            stalemate: false,
            insufficient_material: false,
            moves: [
              { uci: "d1d5", san: "Qd5", category: "loss", dtz: -12, dtm: -6 },
              { uci: "d1d3", san: "Qd3+", category: "draw", dtz: 0, dtm: 0 },
              { uci: "c1b1", san: "Kb1", category: "loss", dtz: -14, dtm: -10 },
            ],
          },
        },
      }).fetch,
    );

    const { data } = await call(client, "probe_tablebase", { fen: "8/8/8/8/8/2k5/8/2KQ4 w - - 0 1", moves: 2 });

    expect(data.resultForSideToMove).toBe("win");
    expect(data.pliesToMate).toBe(7);
    expect(data.legalMoves).toBe(3);
    expect(data.moves).toEqual([
      { san: "Qd5", uci: "d1d5", resultForMover: "win", pliesToMateAfterMove: 6 },
      { san: "Qd3+", uci: "d1d3", resultForMover: "draw", pliesToMateAfterMove: 0 },
    ]);
  });

  it("points to the cloud evaluation when there are too many pieces", async () => {
    const lichess = fakeLichess({});
    const client = await connect(lichess.fetch);

    const result = await call(client, "probe_tablebase", { fen: "startpos" });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/has 32/);
    expect(result.text).toMatch(/get_cloud_eval/);
    expect(lichess.requests).toHaveLength(0);
  });

  it("passes on a plain-text rejection from the tablebase", async () => {
    const client = await connect(
      fakeLichess({ "/standard": { status: 400, body: "illegal position: opposite check" } }).fetch,
    );

    const result = await call(client, "probe_tablebase", { fen: "8/8/8/8/8/2k5/8/2K1Q3 w - - 0 1" });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/illegal position: opposite check/);
  });
});

describe("get_leaderboard", () => {
  it("ranks the players and reads the rating of the requested variant", async () => {
    const lichess = fakeLichess({
      "/api/player/top/2/blitz": {
        body: {
          users: [
            { id: "a", username: "Alpha", title: "FM", perfs: { blitz: { rating: 3001, progress: 45 } } },
            { id: "b", username: "Beta", perfs: { blitz: { rating: 2997, progress: 21 } } },
          ],
        },
      },
    });
    const client = await connect(lichess.fetch);

    const { data } = await call(client, "get_leaderboard", { perfType: "blitz", count: 2 });

    expect(lichess.requests[0]?.accept).toBe("application/vnd.lichess.v3+json");
    expect(data.players).toEqual([
      { rank: 1, username: "Alpha", title: "FM", rating: 3001 },
      { rank: 2, username: "Beta", rating: 2997 },
    ]);
  });
});
