import { describe, expect, it } from "vitest";
import { call, connect } from "../helpers.js";

// One call per tool against the real API, to notice when Lichess changes a response.
describe("live Lichess API", async () => {
  const client = await connect(globalThis.fetch);

  it("get_player", async () => {
    const { data } = await call(client, "get_player", { username: "DrNykterstein" });
    expect(data.title).toBe("GM");
    expect(data.ratings.length).toBeGreaterThan(0);
  });

  it("get_recent_games then get_game", async () => {
    const recent = await call(client, "get_recent_games", { username: "DrNykterstein", max: 2 });
    expect(recent.data.gamesReturned).toBe(2);
    const game = await call(client, "get_game", { game: recent.data.games[0].id });
    expect(game.data.moves.length).toBeGreaterThan(0);
  });

  it("get_daily_puzzle", async () => {
    const { data } = await call(client, "get_daily_puzzle");
    expect(data.solutionUci.length).toBeGreaterThan(0);
    expect(["white", "black"]).toContain(data.sideToMove);
  });

  it("get_cloud_eval", async () => {
    const { data } = await call(client, "get_cloud_eval", { fen: "startpos" });
    expect(data.lines[0].movesUci.length).toBeGreaterThan(0);
  });

  it("explore_masters", async () => {
    const { data } = await call(client, "explore_masters", { fen: "startpos", moves: 3 });
    expect(data.games).toBeGreaterThan(1_000_000);
    expect(data.moves).toHaveLength(3);
  });

  it("probe_tablebase", async () => {
    const { data } = await call(client, "probe_tablebase", { fen: "8/8/8/8/8/2k5/8/2KQ4 w - - 0 1" });
    expect(data.resultForSideToMove).toBe("win");
    expect(data.moves[0].resultForMover).toBe("win");
  });

  it("get_leaderboard", async () => {
    const { data } = await call(client, "get_leaderboard", { perfType: "bullet", count: 3 });
    expect(data.players).toHaveLength(3);
  });
});
