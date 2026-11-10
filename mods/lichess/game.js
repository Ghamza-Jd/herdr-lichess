// Lichess data -> a live game model, and the HTTP plumbing.
import { Chess } from "./chess.js";

export const LICHESS = "https://lichess.org";

export async function api(path, { token, method = "GET", form, ndjson = false } = {}) {
  // Lichess answers 403 to some endpoints (game export) without a User-Agent; fetch sends none.
  const headers = { Accept: ndjson ? "application/x-ndjson" : "application/json", "User-Agent": "herdr-lichess-mod" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (form) headers["Content-Type"] = "application/x-www-form-urlencoded";
  const r = await fetch(LICHESS + path, { method, headers, body: form });
  const text = await r.text();
  if (ndjson && r.ok) return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!r.ok) throw new Error(body?.error ?? `Lichess answered ${r.status} for ${path.split("?")[0]}`);
  if (body == null && text) throw new Error(`Lichess sent a page instead of data for ${path.split("?")[0]}`);
  return body;
}

export const errorText = (e) => String(e?.message ?? e);

const squares = (uci) => [uci.slice(0, 2), uci.slice(2, 4)];
const placementOf = (chess) => chess.fen().split(" ")[0];

/** A Chess from Lichess's space-separated SAN move list. */
export function replay(sanMoves) {
  const chess = new Chess();
  for (const san of (sanMoves ?? "").split(" ").filter(Boolean)) chess.move(san);
  return chess;
}

function lastOf(chess) {
  const h = chess.history({ verbose: true });
  const m = h[h.length - 1];
  return m ? [m.from, m.to] : null;
}

export function playerOf(p) {
  if (!p) return { name: "?" };
  if (p.aiLevel) return { name: `Stockfish level ${p.aiLevel}` };
  return { name: p.user?.name ?? "Anonymous", title: p.user?.title ?? null, rating: p.rating ?? null };
}

export function endText(ex) {
  if (!ex.status || ex.status === "started" || ex.status === "created") return null;
  const who = ex.winner ? `${ex.winner === "white" ? "White" : "Black"} won` : "Draw";
  return `${who} · ${ex.status.replace(/([A-Z])/g, " $1").toLowerCase()}`;
}

// Remaining seconds per side from an export's per-ply clocks (centiseconds).
function exportClocks(ex) {
  if (!ex.clock) return null;
  let white = ex.clock.initial, black = ex.clock.initial;
  (ex.clocks ?? []).forEach((cs, i) => { if (i % 2 === 0) white = cs / 100; else black = cs / 100; });
  return { white, black, at: ex.lastMoveAt ?? Date.now() };
}

/**
 * A game as the panel shows it. `ply` is null when unknown (position loaded from a
 * bare FEN); `castle` is tracked by hand because the playing list's FEN is placement only.
 */
export function gameFromExport(ex, orientation) {
  const chess = replay(ex.moves);
  return {
    id: ex.id, color: orientation, chess,
    ply: chess.history().length,
    castle: chess.fen().split(" ")[2],
    last: lastOf(chess),
    players: { white: playerOf(ex.players?.white), black: playerOf(ex.players?.black) },
    clocks: exportClocks(ex),
    over: endText(ex),
    speed: ex.speed,
    vsAi: Boolean(ex.players?.white?.aiLevel || ex.players?.black?.aiLevel),
    sel: null, targets: [],
  };
}

const CASTLE_SQUARES = { e1: "KQ", h1: "K", a1: "Q", e8: "kq", h8: "k", a8: "q" };
function updateCastle(game, from, to) {
  for (const sq of [from, to]) for (const r of CASTLE_SQUARES[sq] ?? "") game.castle = game.castle.replace(r, "");
  if (!game.castle) game.castle = "-";
}

/** Sets the board from a placement-only FEN, keeping castling rights and en passant right. */
export function loadPlacement(game, placement, turn, lastUci) {
  const castle = game.castle || "-";
  try { game.chess.load(`${placement} ${turn} ${castle} - 0 1`); }
  catch { game.chess.load(`${placement} ${turn} - - 0 1`); }
  if (!lastUci) return;
  const [from, to] = squares(lastUci);
  if (game.chess.get(to)?.type === "p" && Math.abs(+from[1] - +to[1]) === 2) {
    const ep = from[0] + (+from[1] + +to[1]) / 2;
    try { game.chess.load(`${placement} ${turn} ${castle} ${ep} 0 1`); } catch { /* keep without ep */ }
  }
}

/** Brings the game up to date with the current position from /api/account/playing. */
export function syncToPlaying(game, info) {
  const placement = info.fen.split(" ")[0];
  if (placement === placementOf(game.chess)) return;
  const turn = info.isMyTurn === (game.color === "white") ? "w" : "b";
  loadPlacement(game, placement, turn, info.lastMove);
  game.ply = null;
  if (info.lastMove) game.last = squares(info.lastMove);
}

/** A TV game from the feed's `featured` event: full FEN, orientation, players, clocks. */
export function tvGame(d) {
  const players = {}, clocks = { at: Date.now() };
  for (const p of d.players ?? []) { players[p.color] = playerOf(p); clocks[p.color] = p.seconds ?? null; }
  let chess;
  try { chess = new Chess(d.fen); } catch { chess = new Chess(); }
  return { id: d.id, color: d.orientation ?? "white", chess, ply: null, castle: "-", last: null,
    players, clocks, over: null, sel: null, targets: [] };
}

/** A TV feed `fen` event: the position after a move, the move, and both clocks (seconds). */
export function tvMove(game, d) {
  try { game.chess.load(d.fen); } catch { return; }
  game.last = d.lm ? squares(d.lm) : null;
  if (d.wc != null && d.bc != null) game.clocks = { white: d.wc, black: d.bc, at: Date.now() };
}

/** Rebuilds the position from the full UCI move list (exact castling, en passant, ply). */
function rebuildFromUci(game, uciMoves) {
  const chess = new Chess();
  let last = null;
  for (const u of uciMoves) { chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); last = squares(u); }
  Object.assign(game, { chess, ply: uciMoves.length, castle: chess.fen().split(" ")[2], last, sel: null, targets: [], promo: null });
}

/**
 * Applies a gameFull/gameState from the Board API game stream: the authoritative move
 * list (so takebacks show), clocks on connect, the end of the game, and pending offers.
 */
export function applyStreamState(game, st, full) {
  const moves = (st.moves ?? "").split(" ").filter(Boolean);
  // Only rebuild when the stream itself changed: your own move shows before the stream
  // echoes it, and an older line must not roll the board back.
  const changed = full || moves.length !== game.streamCount;
  if (changed) {
    game.streamCount = moves.length;
    if (full || game.ply !== moves.length) {
      try { rebuildFromUci(game, moves); } catch { /* keep the board as it is */ }
    }
  }
  if (changed && st.wtime != null && game.speed !== "correspondence") {
    game.clocks = { white: st.wtime / 1000, black: st.btime / 1000, at: Date.now() };
  }
  if (st.status && st.status !== "started" && st.status !== "created") {
    game.over = endText({ status: st.status, winner: st.winner });
  }
  const mine = game.color === "white" ? "w" : "b", theirs = mine === "w" ? "b" : "w";
  game.offers = {
    myDraw: Boolean(st[`${mine}draw`]), theirDraw: Boolean(st[`${theirs}draw`]),
    myTakeback: Boolean(st[`${mine}takeback`]), theirTakeback: Boolean(st[`${theirs}takeback`]),
  };
}

/** Plays a local move; returns a function that undoes it. */
export function applyLocalMove(game, from, to, promotion) {
  const before = { fen: game.chess.fen(), ply: game.ply, last: game.last, castle: game.castle };
  game.chess.move({ from, to, promotion });
  updateCastle(game, from, to);
  if (game.ply != null) game.ply++;
  game.last = [from, to];
  game.sel = null; game.targets = []; game.promo = null;
  return () => { game.chess.load(before.fen); Object.assign(game, { ply: before.ply, last: before.last, castle: before.castle }); };
}

/** Seconds left for `side` now, counting down the side to move. */
export function clockNow(game, side) {
  const c = game.clocks;
  if (!c || c[side] == null) return null;
  const running = !game.over && game.chess.turn() === side[0] && (game.ply == null || game.ply >= 2);
  return Math.max(0, c[side] - (running ? (Date.now() - c.at) / 1000 : 0));
}

export function formatClock(s) {
  if (s == null) return "";
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

/** Click on a square: select a movable piece, or return {from, to} for a legal target. */
export function clickSquare(model, sq, mover) {
  if (model.sel && model.targets.includes(sq)) {
    const move = { from: model.sel, to: sq };
    model.sel = null; model.targets = [];
    return move;
  }
  const p = model.chess.get(sq);
  if (p && p.color === model.chess.turn() && p.color === mover && model.sel !== sq) {
    model.sel = sq;
    model.targets = model.chess.moves({ square: sq, verbose: true }).map((m) => m.to);
  } else { model.sel = null; model.targets = []; }
  return null;
}

/**
 * Where `color`'s piece on `sq` could go once it's their turn: the moves it would have if
 * it were to move now. Used for premoves while the opponent thinks.
 */
export function premoveTargets(chess, sq, color) {
  const [placement, , castle] = chess.fen().split(" ");
  try {
    const probe = new Chess(`${placement} ${color} ${castle} - 0 1`, { skipValidation: true });
    return probe.moves({ square: sq, verbose: true }).map((m) => m.to);
  } catch { return []; }
}

export const isPromotion = (chess, from, to) => chess.get(from)?.type === "p" && (to[1] === "8" || to[1] === "1");

/** Every position of a finished game, for stepping through it: fens[i] is after i plies. */
export function buildReplay(sanMoves) {
  const chess = new Chess();
  const fens = [chess.fen()], lasts = [null], sans = [];
  for (const san of (sanMoves ?? "").split(" ").filter(Boolean)) {
    const m = chess.move(san);
    fens.push(chess.fen()); lasts.push([m.from, m.to]); sans.push(m.san);
  }
  return { fens, lasts, sans };
}

/**
 * A typed move -> {from, to, promotion}, or throws. Takes algebraic notation (Nf3, exd5,
 * O-O, 0-0, e8=Q) and coordinates (e2e4, e7e8q). Doesn't change `chess`.
 */
export function parseTypedMove(chess, text) {
  const s = text.trim().replace(/[!?]+$/, "");
  if (!s) throw new Error("Type a move first.");
  const probe = new Chess(chess.fen());
  const uci = /^([a-h][1-8])-?([a-h][1-8])=?([qrbnQRBN])?$/.exec(s);
  try {
    const m = uci
      ? probe.move({ from: uci[1], to: uci[2], promotion: uci[3]?.toLowerCase() ?? (isPromotion(probe, uci[1], uci[2]) ? "q" : undefined) })
      : probe.move(s.replace(/0/g, "O").replace(/^([a-h](?:x[a-h])?[18])=?([qrbnQRBN])([+#]?)$/,
        (_m, sq, p, chk) => `${sq}=${p.toUpperCase()}${chk}`)); // b8q, bxa8n -> b8=Q, bxa8=N
    return { from: m.from, to: m.to, promotion: m.promotion };
  } catch {
    throw new Error(`"${s}" isn't a legal move here.`);
  }
}
