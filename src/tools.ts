/**
 * The tools this server exposes. Each one maps to a single Lichess endpoint
 * and reshapes the response into a small object: models read every byte of a
 * tool result, so anything they do not need (flairs, patron colours, rating
 * deviations) is dropped, and anything they tend to compute badly (win
 * percentages, a win/loss record, whose turn it is) is computed here.
 */

import { z } from "zod";
import { parseFen } from "./fen.js";
import { buildUrl, HOSTS, type LichessClient } from "./lichess.js";

export interface ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  run(client: LichessClient, args: z.infer<z.ZodObject<Shape>>): Promise<unknown>;
}

function defineTool<Shape extends z.ZodRawShape>(tool: ToolDefinition<Shape>): ToolDefinition<Shape> {
  return tool;
}

// ---------------------------------------------------------------- shared --

const username = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{2,30}$/, "A Lichess username has 2 to 30 letters, digits, underscores or hyphens.")
  .describe('Lichess username, for example "DrNykterstein". Not case sensitive.');

const fen = z
  .string()
  .min(3)
  .describe(
    'Position in FEN, for example "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1". ' +
      'Use "startpos" for the initial position.',
  );

const PERF_TYPES = [
  "ultraBullet",
  "bullet",
  "blitz",
  "rapid",
  "classical",
  "correspondence",
  "chess960",
  "crazyhouse",
  "antichess",
  "atomic",
  "horde",
  "kingOfTheHill",
  "racingKings",
  "threeCheck",
] as const;

const LEADERBOARD_PERF_TYPES = PERF_TYPES.filter((perf) => perf !== "correspondence");

function isoDate(ms: number | undefined): string | undefined {
  return typeof ms === "number" ? new Date(ms).toISOString() : undefined;
}

function percent(part: number, total: number): number {
  return total === 0 ? 0 : Math.round((part / total) * 1000) / 10;
}

// ----------------------------------------------------------------- games --

interface ApiPlayer {
  user?: { name: string; title?: string };
  aiLevel?: number;
  rating?: number;
  ratingDiff?: number;
}

interface ApiGame {
  id: string;
  rated: boolean;
  variant: string;
  speed: string;
  createdAt?: number;
  status: string;
  players: { white: ApiPlayer; black: ApiPlayer };
  winner?: "white" | "black";
  opening?: { eco: string; name: string };
  moves?: string;
  clock?: { initial: number; increment: number };
}

function shapePlayer(player: ApiPlayer) {
  const name = player.user?.name ?? (player.aiLevel ? `Stockfish level ${player.aiLevel}` : "Anonymous");
  return {
    name,
    title: player.user?.title,
    rating: player.rating,
    ratingChange: player.ratingDiff,
  };
}

function shapeGame(game: ApiGame) {
  return {
    id: game.id,
    url: `https://lichess.org/${game.id}`,
    playedAt: isoDate(game.createdAt),
    speed: game.speed,
    variant: game.variant,
    rated: game.rated,
    timeControl: game.clock ? `${game.clock.initial / 60}+${game.clock.increment}` : undefined,
    white: shapePlayer(game.players.white),
    black: shapePlayer(game.players.black),
    winner: game.winner ?? "none",
    endedBy: game.status,
    opening: game.opening ? `${game.opening.eco} ${game.opening.name}` : undefined,
    moves: game.moves,
  };
}

// ----------------------------------------------------------------- tools --

const getPlayer = defineTool({
  name: "get_player",
  title: "Get a Lichess player",
  description:
    "Public profile of a Lichess player: title, rating and number of games in every time control and variant " +
    "they have played, overall win/loss/draw record, and when they joined and were last seen. " +
    "Use it to answer questions about how strong someone is or what they play most.",
  inputSchema: { username },
  async run(client, args) {
    interface ApiPerf {
      games?: number;
      rating?: number;
      prov?: boolean;
    }
    interface ApiUser {
      username: string;
      title?: string;
      url?: string;
      perfs?: Record<string, ApiPerf>;
      createdAt?: number;
      seenAt?: number;
      count?: { all: number; rated: number; win: number; loss: number; draw: number };
      disabled?: boolean;
      tosViolation?: boolean;
      profile?: { fideRating?: number };
    }
    const user = await client.json<ApiUser>(buildUrl(HOSTS.api, `/api/user/${args.username}`));

    const ratings = Object.entries(user.perfs ?? {})
      .filter(([, perf]) => typeof perf.rating === "number" && (perf.games ?? 0) > 0)
      .map(([variant, perf]) => ({
        variant,
        rating: perf.rating,
        games: perf.games,
        provisional: perf.prov === true,
      }))
      .sort((a, b) => (b.games ?? 0) - (a.games ?? 0));

    return {
      username: user.username,
      title: user.title,
      url: user.url ?? `https://lichess.org/@/${user.username}`,
      joined: isoDate(user.createdAt),
      lastSeen: isoDate(user.seenAt),
      accountClosed: user.disabled === true,
      markedForTosViolation: user.tosViolation === true,
      fideRating: user.profile?.fideRating,
      games: user.count
        ? {
            total: user.count.all,
            rated: user.count.rated,
            wins: user.count.win,
            losses: user.count.loss,
            draws: user.count.draw,
          }
        : undefined,
      ratings,
      note: "A provisional rating comes from too few recent games to be reliable.",
    };
  },
});

const getRecentGames = defineTool({
  name: "get_recent_games",
  title: "Get a player's recent games",
  description:
    "Most recent games of a Lichess player, newest first, with opponents, ratings, result, how the game ended " +
    "and the opening. Also returns the player's win/loss/draw record over the games returned. " +
    "Set withMoves to true only when the moves themselves are needed: they make the result much longer.",
  inputSchema: {
    username,
    max: z.number().int().min(1).max(20).default(5).describe("How many games to return, 1 to 20."),
    perfType: z.enum(PERF_TYPES).optional().describe("Only games of this time control or variant."),
    rated: z.boolean().optional().describe("true for rated games only, false for casual games only."),
    color: z.enum(["white", "black"]).optional().describe("Only games the player had this colour in."),
    withMoves: z.boolean().default(false).describe("Include the moves of every game in SAN."),
  },
  async run(client, args) {
    const games = await client.ndjson<ApiGame>(
      buildUrl(HOSTS.api, `/api/games/user/${args.username}`, {
        max: args.max,
        perfType: args.perfType,
        rated: args.rated,
        color: args.color,
        opening: true,
        moves: args.withMoves,
      }),
    );

    const record = { wins: 0, losses: 0, draws: 0 };
    const wanted = args.username.toLowerCase();
    const shaped = games.map((game) => {
      const playedAs = game.players.white.user?.name.toLowerCase() === wanted ? "white" : "black";
      const outcome = game.winner === undefined ? "draw" : game.winner === playedAs ? "win" : "loss";
      if (outcome === "win") record.wins += 1;
      else if (outcome === "loss") record.losses += 1;
      else record.draws += 1;
      return { ...shapeGame(game), playedAs, outcome };
    });

    return { username: args.username, gamesReturned: shaped.length, record, games: shaped };
  },
});

const getGame = defineTool({
  name: "get_game",
  title: "Get one game",
  description:
    "One Lichess game by id or URL: players, ratings, result, opening and the full list of moves in SAN. " +
    "Use it after get_recent_games when the moves of a specific game are needed.",
  inputSchema: {
    game: z
      .string()
      .trim()
      .min(8)
      .describe('Game id (8 characters, for example "q7ZvsdUF") or a lichess.org game URL.'),
  },
  async run(client, args) {
    const id = extractGameId(args.game);
    const game = await client.json<ApiGame>(
      buildUrl(HOSTS.api, `/game/export/${id}`, { moves: true, opening: true, clocks: false, evals: false }),
    );
    return shapeGame(game);
  },
});

export function extractGameId(input: string): string {
  const match = /^(?:https?:\/\/)?(?:www\.)?lichess\.org\/([A-Za-z0-9]{8})/.exec(input) ?? /^([A-Za-z0-9]{8})/.exec(input);
  if (!match?.[1]) {
    throw new Error("That is not a Lichess game id. Ids have 8 letters or digits, as in lichess.org/q7ZvsdUF.");
  }
  return match[1];
}

const getDailyPuzzle = defineTool({
  name: "get_daily_puzzle",
  title: "Get the daily puzzle",
  description:
    "Today's Lichess puzzle: the position to solve in FEN, whose turn it is, the rating, the themes " +
    "and the solution as a list of moves in UCI notation (the solver's move first, then the forced reply, and so on).",
  inputSchema: {},
  async run(client) {
    interface ApiPuzzle {
      game: { id: string; perf?: { name: string }; players?: { name: string; color: string; rating: number }[] };
      puzzle: { id: string; rating: number; plays: number; solution: string[]; themes: string[]; fen?: string };
    }
    const daily = await client.json<ApiPuzzle>(buildUrl(HOSTS.api, "/api/puzzle/daily"));
    const position = daily.puzzle.fen ? parseFen(daily.puzzle.fen) : undefined;
    return {
      id: daily.puzzle.id,
      url: `https://lichess.org/training/${daily.puzzle.id}`,
      rating: daily.puzzle.rating,
      timesPlayed: daily.puzzle.plays,
      themes: daily.puzzle.themes,
      fen: position?.fen,
      sideToMove: position?.sideToMove,
      solutionUci: daily.puzzle.solution,
      fromGame: {
        url: `https://lichess.org/${daily.game.id}`,
        speed: daily.game.perf?.name,
        players: daily.game.players?.map((p) => ({ name: p.name, color: p.color, rating: p.rating })),
      },
    };
  },
});

const getCloudEval = defineTool({
  name: "get_cloud_eval",
  title: "Get the engine evaluation of a position",
  description:
    "Stockfish evaluation of a position from the Lichess cloud database, with the best line or lines. " +
    "Scores are always from White's point of view: positive favours White, negative favours Black. " +
    "Only positions that someone has analysed on Lichess are stored, mostly openings and well-known positions; " +
    "an unknown position returns an error and is not worth retrying.",
  inputSchema: {
    fen,
    lines: z.number().int().min(1).max(5).default(1).describe("How many best lines to return, 1 to 5."),
  },
  async run(client, args) {
    interface ApiEval {
      depth: number;
      knodes: number;
      pvs: { moves: string; cp?: number; mate?: number }[];
    }
    const position = parseFen(args.fen);
    const result = await client.json<ApiEval>(
      buildUrl(HOSTS.api, "/api/cloud-eval", { fen: position.fen, multiPv: args.lines }),
    );
    return {
      fen: position.fen,
      sideToMove: position.sideToMove,
      depth: result.depth,
      lines: result.pvs.map((pv) => ({
        evaluation: formatScore(pv),
        centipawns: pv.cp,
        mateIn: pv.mate,
        movesUci: pv.moves.split(" "),
      })),
      note:
        "Scores are from White's point of view. Moves are in UCI; castling is written as the king " +
        "moving onto its own rook (e1h1 is White castling short).",
    };
  },
});

export function formatScore(pv: { cp?: number; mate?: number }): string {
  if (typeof pv.mate === "number") {
    return pv.mate > 0 ? `White mates in ${pv.mate}` : `Black mates in ${-pv.mate}`;
  }
  const pawns = (pv.cp ?? 0) / 100;
  return `${pawns > 0 ? "+" : ""}${pawns.toFixed(2)}`;
}

const exploreMasters = defineTool({
  name: "explore_masters",
  title: "Explore master games from a position",
  description:
    "Opening statistics from over-the-board games between masters (rated 2200 or more): how often the position " +
    "was reached, how often White won, drew and lost, and the most played next moves with their own results. " +
    "Use it to answer what theory recommends in an opening position. It covers master games only, not online games.",
  inputSchema: {
    fen,
    moves: z.number().int().min(1).max(12).default(5).describe("How many candidate moves to return, 1 to 12."),
  },
  async run(client, args) {
    interface ApiStats {
      white: number;
      draws: number;
      black: number;
    }
    interface ApiExplorer extends ApiStats {
      opening?: { eco: string; name: string } | null;
      moves: (ApiStats & {
        uci: string;
        san: string;
        averageRating?: number;
        opening?: { eco: string; name: string } | null;
      })[];
    }
    const position = parseFen(args.fen);
    const data = await client.json<ApiExplorer>(
      buildUrl(HOSTS.explorer, "/masters", { fen: position.fen, moves: args.moves, topGames: 0 }),
    );
    const total = data.white + data.draws + data.black;
    const results = (stats: ApiStats, games: number) => ({
      whiteWinsPct: percent(stats.white, games),
      drawsPct: percent(stats.draws, games),
      blackWinsPct: percent(stats.black, games),
    });

    return {
      fen: position.fen,
      sideToMove: position.sideToMove,
      opening: data.opening ? `${data.opening.eco} ${data.opening.name}` : undefined,
      games: total,
      ...results(data, total),
      moves: data.moves.map((move) => {
        const games = move.white + move.draws + move.black;
        return {
          san: move.san,
          uci: move.uci,
          games,
          playedPct: percent(games, total),
          ...results(move, games),
          averageRating: move.averageRating,
          leadsTo: move.opening ? `${move.opening.eco} ${move.opening.name}` : undefined,
        };
      }),
      note: total === 0 ? "No master game in the database reached this position." : undefined,
    };
  },
});

const MOVER_OUTCOME: Record<string, string> = {
  loss: "win",
  win: "loss",
  draw: "draw",
  "cursed-win": "blessed-loss",
  "blessed-loss": "cursed-win",
  "maybe-win": "maybe-loss",
  "maybe-loss": "maybe-win",
  "syzygy-win": "syzygy-loss",
  "syzygy-loss": "syzygy-win",
  unknown: "unknown",
};

const probeTablebase = defineTool({
  name: "probe_tablebase",
  title: "Probe the endgame tablebase",
  description:
    "Perfect-play result of an endgame with 7 pieces or fewer (kings included) from the Syzygy tablebases: " +
    "whether the side to move wins, draws or loses, and every legal move with the result it leads to, best first. " +
    'A "cursed-win" is a win that the 50-move rule turns into a draw; a "blessed-loss" is the same seen from the other side.',
  inputSchema: {
    fen,
    moves: z.number().int().min(1).max(40).default(8).describe("How many moves to return, best first."),
  },
  async run(client, args) {
    interface ApiTablebaseMove {
      uci: string;
      san: string;
      category: string;
      dtz: number | null;
      dtm: number | null;
    }
    interface ApiTablebase {
      category: string;
      dtz: number | null;
      dtm: number | null;
      checkmate: boolean;
      stalemate: boolean;
      insufficient_material: boolean;
      moves: ApiTablebaseMove[];
    }
    const position = parseFen(args.fen);
    if (position.pieceCount > 7) {
      throw new Error(
        `The tablebase covers positions with 7 pieces or fewer and this one has ${position.pieceCount}. ` +
          "Use get_cloud_eval for positions with more pieces.",
      );
    }
    const data = await client.json<ApiTablebase>(buildUrl(HOSTS.tablebase, "/standard", { fen: position.fen }));
    return {
      fen: position.fen,
      sideToMove: position.sideToMove,
      resultForSideToMove: data.category,
      pliesToMate: data.dtm === null ? undefined : Math.abs(data.dtm),
      checkmate: data.checkmate,
      stalemate: data.stalemate,
      insufficientMaterial: data.insufficient_material,
      legalMoves: data.moves.length,
      moves: data.moves.slice(0, args.moves).map((move) => ({
        san: move.san,
        uci: move.uci,
        // Lichess reports each move from the opponent's side, after the move is played.
        resultForMover: MOVER_OUTCOME[move.category] ?? move.category,
        pliesToMateAfterMove: move.dtm === null ? undefined : Math.abs(move.dtm),
      })),
      note: "A ply is one move by one side, so mate in N moves takes 2N - 1 plies. Mate distances exist only for 5 pieces or fewer.",
    };
  },
});

const getLeaderboard = defineTool({
  name: "get_leaderboard",
  title: "Get a leaderboard",
  description: "Current top players on Lichess for one time control or variant, with title and rating.",
  inputSchema: {
    perfType: z.enum(LEADERBOARD_PERF_TYPES).describe("Time control or variant of the leaderboard."),
    count: z.number().int().min(1).max(50).default(10).describe("How many players to return, 1 to 50."),
  },
  async run(client, args) {
    interface ApiTop {
      users: { username: string; title?: string; perfs: Record<string, { rating: number; progress?: number }> }[];
    }
    const data = await client.json<ApiTop>(
      buildUrl(HOSTS.api, `/api/player/top/${args.count}/${args.perfType}`),
      "application/vnd.lichess.v3+json",
    );
    return {
      perfType: args.perfType,
      players: data.users.map((user, index) => ({
        rank: index + 1,
        username: user.username,
        title: user.title,
        rating: user.perfs[args.perfType]?.rating,
      })),
    };
  },
});

export const tools = [
  getPlayer,
  getRecentGames,
  getGame,
  getDailyPuzzle,
  getCloudEval,
  exploreMasters,
  probeTablebase,
  getLeaderboard,
] as ToolDefinition[];
