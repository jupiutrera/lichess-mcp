/**
 * Shallow FEN checks. They catch what models get wrong most often (missing
 * fields, a rank that does not add up to eight squares) before a network
 * round trip. Legality is left to Lichess.
 */

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export interface ParsedFen {
  fen: string;
  sideToMove: "white" | "black";
  pieceCount: number;
}

export function parseFen(input: string): ParsedFen {
  const raw = input.trim();
  if (raw.toLowerCase() === "startpos") return parseFen(START_FEN);

  const fields = raw.split(/[\s_]+/);
  if (fields.length < 2) {
    throw new Error(
      'A FEN needs at least the board and the side to move, for example "8/8/8/8/8/2k5/2p5/2K5 w - - 0 1".',
    );
  }
  const [board, side] = fields as [string, string];

  const ranks = board.split("/");
  if (ranks.length !== 8) {
    throw new Error(`The FEN board must have 8 ranks separated by "/", but it has ${ranks.length}.`);
  }
  let pieceCount = 0;
  ranks.forEach((rank, index) => {
    let squares = 0;
    for (const char of rank) {
      if (/[1-8]/.test(char)) squares += Number(char);
      else if (/[pnbrqkPNBRQK]/.test(char)) {
        squares += 1;
        pieceCount += 1;
      } else {
        throw new Error(`Unexpected character "${char}" in rank ${8 - index} of the FEN.`);
      }
    }
    if (squares !== 8) {
      throw new Error(`Rank ${8 - index} of the FEN describes ${squares} squares instead of 8.`);
    }
  });

  if (side !== "w" && side !== "b") {
    throw new Error(`The side to move in the FEN must be "w" or "b", not "${side}".`);
  }

  const castling = fields[2] ?? "-";
  const enPassant = fields[3] ?? "-";
  const halfmove = fields[4] ?? "0";
  const fullmove = fields[5] ?? "1";

  return {
    fen: [board, side, castling, enPassant, halfmove, fullmove].join(" "),
    sideToMove: side === "w" ? "white" : "black",
    pieceCount,
  };
}
