/**
 * Eval cases. Each one is a question a person could ask an agent, the tool it
 * should take, and a `truth` function that fetches the accepted answers
 * straight from the Lichess API with its own code, not through the server
 * under test: a bug in the server must not be able to grade itself as correct.
 *
 * `truth` runs before and after the agent answers and both results are
 * accepted, because live data (a rating, a leaderboard) can change in between.
 */

const UA = { "User-Agent": "lichess-mcp-eval/0.1 (+https://github.com/jupiutrera/lichess-mcp)" };

async function get(url, accept = "application/json") {
  const response = await fetch(url, { headers: { ...UA, Accept: accept } });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.text();
}
const json = async (url, accept) => JSON.parse(await get(url, accept));
const ndjson = async (url) =>
  (await get(url, "application/x-ndjson"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const q = (fen) => encodeURIComponent(fen);

const tablebase = (fen) => json(`https://tablebase.lichess.ovh/standard?fen=${q(fen)}`);
/** Moves after which the opponent is in the given tablebase category. */
const movesLeaving = async (fen, category) =>
  (await tablebase(fen)).moves.filter((move) => move.category === category).map((move) => move.san);

const SICILIAN_NF3 = "rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2";
const KINGS_INDIAN = "rnbqk2r/ppppppbp/5np1/8/2PP4/2N5/PP2PPPP/R1BQKBNR w KQkq - 2 4";
const ITALIAN = "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3";
const GAME = "L07dBpjM";

/** Graders. Each takes the text after "ANSWER:" and the list of accepted values. */
export const graders = {
  /** The answer, ignoring case, spaces and check marks, is one of the accepted values. */
  exact: (answer, accepted) => accepted.some((value) => normalize(answer) === normalize(value)),
  /** The answer contains one of the accepted values as a whole word. */
  contains: (answer, accepted) =>
    accepted.some((value) => new RegExp(`(^|[^a-z0-9])${escape(normalize(value))}($|[^a-z0-9])`).test(normalize(answer))),
  /** The first number in the answer is within `tolerance` of an accepted value. */
  number:
    (tolerance = 0) =>
    (answer, accepted) => {
      const match = /-?\d+(?:\.\d+)?/.exec(answer.replace(/(?<=\d),(?=\d{3})/g, ""));
      return match !== null && accepted.some((value) => Math.abs(Number(match[0]) - Number(value)) <= tolerance);
    },
};

const normalize = (text) => String(text).toLowerCase().replace(/[\s+#!?.]/g, "");
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const cases = [
  {
    id: "player-title",
    question: "What chess title does the Lichess player DrNykterstein hold? Answer with the abbreviation.",
    tool: "get_player",
    grade: graders.exact,
    truth: async () => [(await json("https://lichess.org/api/user/DrNykterstein")).title],
  },
  {
    id: "player-joined",
    question: "On what date did the Lichess user thibault create their account? Answer as YYYY-MM-DD (UTC).",
    tool: "get_player",
    grade: graders.exact,
    truth: async () => [new Date((await json("https://lichess.org/api/user/thibault")).createdAt).toISOString().slice(0, 10)],
  },
  {
    id: "player-rating",
    question: "What is the current bullet rating of the Lichess player penguingim1? Answer with the number.",
    tool: "get_player",
    grade: graders.number(0),
    truth: async () => [(await json("https://lichess.org/api/user/penguingim1")).perfs.bullet.rating],
  },
  {
    id: "player-not-found",
    question: "What is the blitz rating of the Lichess user zzzz_nope_zzzz_123? Answer with the number.",
    tool: "get_player",
    grade: graders.exact,
    truth: async () => ["NOT_FOUND"],
  },
  {
    id: "recent-wins",
    question:
      "Look at the 10 most recent rated blitz games of the Lichess player DrNykterstein. How many of them did DrNykterstein win? Answer with the number.",
    tool: "get_recent_games",
    grade: graders.number(0),
    truth: async () => {
      const games = await ndjson("https://lichess.org/api/games/user/DrNykterstein?max=10&perfType=blitz&rated=true");
      const wins = games.filter((game) => game.winner && game.players[game.winner].user?.id === "drnykterstein");
      return [wins.length];
    },
  },
  {
    id: "game-opening",
    question: `What is the ECO code of the opening played in the Lichess game ${GAME}? Answer with the code.`,
    tool: "get_game",
    grade: graders.exact,
    truth: async () => [(await json(`https://lichess.org/game/export/${GAME}?opening=true`)).opening.eco],
  },
  {
    id: "game-tenth-move",
    question: `In the Lichess game https://lichess.org/${GAME}, what was White's 10th move? Answer in SAN.`,
    tool: "get_game",
    grade: graders.exact,
    truth: async () => [(await json(`https://lichess.org/game/export/${GAME}?moves=true`)).moves.split(" ")[18]],
  },
  {
    id: "chain-last-game-first-move",
    question:
      "Find the most recent game of the Lichess player DrNykterstein. What was White's first move in that game? Answer in SAN.",
    tool: "get_recent_games",
    grade: graders.exact,
    truth: async () => {
      const [game] = await ndjson("https://lichess.org/api/games/user/DrNykterstein?max=1&moves=true");
      return [game.moves.split(" ")[0]];
    },
  },
  {
    id: "daily-puzzle",
    question: "What is the first move of the solution to today's Lichess daily puzzle? Answer in UCI notation, like e2e4.",
    tool: "get_daily_puzzle",
    grade: graders.exact,
    truth: async () => [(await json("https://lichess.org/api/puzzle/daily")).puzzle.solution[0]],
  },
  {
    id: "cloud-eval-given-fen",
    question: `In the position ${ITALIAN} what is the first move of the top line in the Lichess cloud engine evaluation? Answer in UCI notation, like e2e4.`,
    tool: "get_cloud_eval",
    grade: graders.exact,
    truth: async () => [(await json(`https://lichess.org/api/cloud-eval?fen=${q(ITALIAN)}`)).pvs[0].moves.split(" ")[0]],
  },
  {
    id: "cloud-eval-from-moves",
    question:
      "After the moves 1. d4 d5 2. c4, what does the Lichess cloud engine evaluation give as Black's best move? Answer in UCI notation, like e7e5.",
    tool: "get_cloud_eval",
    grade: graders.exact,
    truth: async () => {
      const fen = "rnbqkbnr/ppp1pppp/8/3p4/2PP4/8/PP2PPPP/RNBQKBNR b KQkq - 0 2";
      return [(await json(`https://lichess.org/api/cloud-eval?fen=${q(fen)}`)).pvs[0].moves.split(" ")[0]];
    },
  },
  {
    id: "masters-most-played",
    question: `In master games, what is the most played move in the position ${SICILIAN_NF3} ? Answer in SAN.`,
    tool: "explore_masters",
    grade: graders.exact,
    truth: async () => [(await json(`https://explorer.lichess.ovh/masters?fen=${q(SICILIAN_NF3)}&moves=1&topGames=0`)).moves[0].san],
  },
  {
    id: "masters-game-count",
    question: `How many master games in the Lichess masters database reached the position ${KINGS_INDIAN} ? Answer with the exact number.`,
    tool: "explore_masters",
    grade: graders.number(0),
    truth: async () => {
      const data = await json(`https://explorer.lichess.ovh/masters?fen=${q(KINGS_INDIAN)}&moves=1&topGames=0`);
      return [data.white + data.draws + data.black];
    },
  },
  {
    id: "masters-draw-rate",
    question: `In master games that reached the position ${SICILIAN_NF3} what percentage ended in a draw? Answer with the number, one decimal.`,
    tool: "explore_masters",
    grade: graders.number(0.15),
    truth: async () => {
      const data = await json(`https://explorer.lichess.ovh/masters?fen=${q(SICILIAN_NF3)}&moves=1&topGames=0`);
      return [(100 * data.draws) / (data.white + data.draws + data.black)];
    },
  },
  {
    id: "tablebase-only-win",
    question:
      "Endgame, White to move: 8/8/8/1k6/8/8/1PK5/8 w - - 0 1. With perfect play exactly one move wins for White. Which one? Answer in SAN.",
    tool: "probe_tablebase",
    grade: graders.exact,
    truth: () => movesLeaving("8/8/8/1k6/8/8/1PK5/8 w - - 0 1", "loss"),
  },
  {
    id: "tablebase-only-draw",
    question:
      "Endgame, White to move: 8/8/1p6/8/1P6/k7/8/1K6 w - - 0 1. With perfect play exactly one move saves the draw for White. Which one? Answer in SAN.",
    tool: "probe_tablebase",
    grade: graders.exact,
    truth: () => movesLeaving("8/8/1p6/8/1P6/k7/8/1K6 w - - 0 1", "draw"),
  },
  {
    id: "tablebase-black-holds",
    question:
      "Endgame, Black to move: 8/8/8/8/5k2/8/4PK2/8 b - - 0 1. Which single move holds the draw for Black with perfect play? Answer in SAN.",
    tool: "probe_tablebase",
    grade: graders.exact,
    truth: () => movesLeaving("8/8/8/8/5k2/8/4PK2/8 b - - 0 1", "draw"),
  },
  {
    id: "tablebase-result",
    question:
      "Rook endgame, White to move: 8/8/4k3/8/2r5/4P3/4K3/7R w - - 0 1. With perfect play, is this a win, a draw or a loss for White? Answer with one word.",
    tool: "probe_tablebase",
    grade: graders.contains,
    truth: async () => [(await tablebase("8/8/4k3/8/2r5/4P3/4K3/7R w - - 0 1")).category],
  },
  {
    id: "leaderboard-first",
    question: "Who is first on the Lichess rapid leaderboard right now? Answer with the username.",
    tool: "get_leaderboard",
    grade: graders.exact,
    truth: async () => [
      (await json("https://lichess.org/api/player/top/1/rapid", "application/vnd.lichess.v3+json")).users[0].username,
    ],
  },
  {
    id: "leaderboard-third-rating",
    question: "What is the rating of the player in third place on the Lichess bullet leaderboard right now? Answer with the number.",
    tool: "get_leaderboard",
    grade: graders.number(0),
    truth: async () => [
      (await json("https://lichess.org/api/player/top/3/bullet", "application/vnd.lichess.v3+json")).users[2].perfs.bullet.rating,
    ],
  },
];
