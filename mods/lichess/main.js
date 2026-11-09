// Lichess in the side panel: daily/next puzzles, Lichess TV, and your ongoing games.
// Live moves come over Lichess's websocket; actions (moves, resign) go over HTTP.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, layout, exec, settings, appHome, readTextFile } from "herdr";
import * as fs from "fs/promises";
import { Chess } from "./chess.js";
import { renderBoard } from "./board.js";
import {
  api, errorText, connectWatch, gameFromExport, syncToPlaying, applySocketMove, applyLocalMove,
  clockNow, formatClock, clickSquare, isPromotion, buildReplay, parseTypedMove, playerOf, applyStreamState,
} from "./game.js";

const TABS = [["puzzle", "Puzzle"], ["tv", "TV"], ["play", "Play"]];
const CHANNELS = [["best", "Top rated"], ["bullet", "Bullet"], ["blitz", "Blitz"], ["rapid", "Rapid"], ["classical", "Classical"]];
const TOKEN_URL = "https://lichess.org/account/oauth/token/create?scopes[]=board:play&description=Herdr";
const POLL_MS = 20000;

// Quick pairing. The Board API only seeks Rapid, Classical and Correspondence against people.
const GRID = [
  { time: 10, inc: 0, label: "10+0", kind: "Rapid" },
  { time: 10, inc: 5, label: "10+5", kind: "Rapid" },
  { time: 15, inc: 10, label: "15+10", kind: "Rapid" },
  { time: 30, inc: 0, label: "30+0", kind: "Classical" },
  { time: 30, inc: 20, label: "30+20", kind: "Classical" },
  { days: 3, label: "3 days", kind: "Correspondence" },
];
const SEEK_LIMIT_MS = 600000; // exec's maximum; the seek is cancelled after it
// A real-time seek lives as long as its HTTP connection, and fetch can't be aborted, so the
// seek runs in curl: killing it cancels the seek. $1 pid file, $2 auth header file, $3 url, $4 form.
// curl reads the auth file when it starts, so the file goes after a second.
const SEEK_SCRIPT = 'chmod 600 "$2"; curl -sS -N -X POST -H @"$2" -H "User-Agent: herdr-lichess-mod" '
  + `--data "$4" -w '\\n%{http_code}' "$3" & pid=$!; echo $pid > "$1"; sleep 1; rm -f "$2"; `
  + 'wait $pid; rc=$?; rm -f "$1"; exit $rc';
// Your game's Board API stream (draw/takeback offers, exact moves) is endless ndjson, which
// fetch can't read as it arrives: curl appends it to a file the heartbeat reads. curl runs
// in the background and outlives exec; the auth file goes once curl has read it.
// $1 output file, $2 auth header file, $3 url. Prints curl's pid.
const STREAM_SCRIPT = 'chmod 600 "$2"; curl -sS -N -H @"$2" -H "User-Agent: herdr-lichess-mod" "$3" > "$1" 2>&1 & '
  + 'pid=$!; sleep 1; rm -f "$2"; echo $pid';
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const RECENT_COUNT = 10;
const RECENT_MS = 120000;
const RESULT = { "+": { color: "#629924", word: "Won" }, "-": { color: "#cc3333", word: "Lost" }, "=": { color: null, word: "Draw" } };

function ago(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// A finished game from /api/games/user, seen from `me`'s side.
function recentFrom(ex, me) {
  const color = ex.players?.black?.user?.id === me ? "black" : "white";
  const other = color === "white" ? "black" : "white";
  return {
    id: ex.id, color, speed: ex.speed, rated: ex.rated, at: ex.lastMoveAt ?? ex.createdAt, moves: ex.moves,
    result: !ex.winner ? "=" : ex.winner === color ? "+" : "-",
    status: ex.status === "draw" ? null : ex.status?.replace(/([A-Z])/g, " $1").toLowerCase(),
    opening: ex.opening?.name ?? null,
    diff: ex.players?.[color]?.ratingDiff ?? null,
    opponent: playerOf(ex.players?.[other]),
    players: { white: playerOf(ex.players?.white), black: playerOf(ex.players?.black) },
  };
}

const sleep = (cx, ms) => new Promise((resolve) => cx.timer.after(ms, () => resolve()));

// The token reaches curl in a header file: exec has no stdin or env, and an argument would
// show in `ps`. fs.writeFile can't set a mode, so the folder is made private (700) first;
// the scripts chmod the file to 600 and delete it once curl has read it.
async function writeAuthFile(name, token) {
  const dir = `${appHome()}/data/lichess`;
  const r = await exec("sh", ["-c", 'umask 077; mkdir -p "$1" && chmod 700 "$1"', "sh", dir]);
  if (r.code !== 0) throw new Error(`Couldn't make ${dir} private: ${(r.stderr || r.stdout).trim()}`);
  const path = `${dir}/${name}`;
  await fs.writeFile(path, `Authorization: Bearer ${token}\n`);
  return path;
}
const standardOnly = (r) => (r?.nowPlaying ?? []).filter((g) => (g.variant?.key ?? "standard") === "standard");

// The path from the layout root to this mod's block, or null.
function pathToMod(node, path = []) {
  if (!node) return null;
  const here = [...path, node];
  if (node.content?.mod === "lichess") return here;
  for (const child of node.children ?? []) { const p = pathToMod(child, here); if (p) return p; }
  return null;
}

// Whether the block is on screen: no hidden ancestor, and every stack on the way shows the
// branch that holds it. Live sockets and streams run only while shown. When the mod isn't in
// the layout (a pane, a window), it's shown.
function panelShown() {
  const path = pathToMod(layout());
  if (!path) return true;
  return path.every((node, i) => !node.hidden
    && (node.type !== "stack" || !node.active || node.active === path[i + 1]?.id));
}

const open = (url) => { exec("open", [url]).catch(() => {}); };
const store = (k, v) => { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); };

export default class Lichess extends View {
  init(_props, cx) {
    this.tab = localStorage.getItem("tab") ?? "puzzle";
    this.width = 340;
    this.puzzle = null; this.puzzleLoading = false; this.puzzleError = null;
    this.tv = { channel: localStorage.getItem("tvChannel") ?? "best", game: null, error: null, watchers: null };
    this.play = {
      token: localStorage.getItem("token") ?? "", user: localStorage.getItem("user"),
      games: [], selected: null, game: null, error: null, polledAt: 0, polling: false, confirmResign: false,
      rated: localStorage.getItem("rated") !== "false", notice: null,
      recent: [], recentAt: 0, recentLoading: false, recentError: null,
      replay: null, // a finished game being stepped through
      moveError: null,
    };
    this.moveInput = InputState.new({ placeholder: "Type a move: e4, Nf3, O-O, e7e8q" });
    this.moveInput.on("submit", (_e, cx) => this.typeMove(cx));
    this.moveInput.on("change", (_e, cx) => { if (this.play.moveError) { this.play.moveError = null; cx.notify(); } });
    this.replayFocus = cx.focus_handle();
    this.seek = null; // { cell, startedAt, pid, cancelled }
    this.tokenInput = InputState.new({ placeholder: "lip_…" });
    this.tokenInput.set_masked(true);
    this.tokenInput.on("submit", (_e, cx) => this.saveToken(cx));
    this.feedKey = null; this.ws = null; this.wsGen = 0; this.tick = 0;
    this.stream = null; // { gameId, file, pid, offset, reading, stopped }
    cx.timer.every(1000, (cx) => this.heartbeat(cx));
    this.heartbeat(cx);
  }

  async close() {
    const pid = this.stream?.pid;
    this.stopFeed();
    if (pid) await exec("kill", [pid]).catch(() => {});
    // Never leave a seek running behind a closed panel: it could pair you into a game.
    if (this.seek?.pid) { this.seek.cancelled = true; await exec("kill", [this.seek.pid]).catch(() => {}); }
  }

  // ---- lifecycle: which live feed runs, pings, clocks, polling --------------------

  heartbeat(cx) {
    this.tick++;
    const shown = panelShown();
    const want = !shown ? null
      : this.tab === "tv" ? `tv:${this.tv.channel}`
      : this.tab === "play" && this.play.token && this.play.selected ? `play:${this.play.selected}` : null;
    if (want !== this.feedKey) {
      this.stopFeed();
      this.feedKey = want;
      if (want?.startsWith("tv:")) this.loadTv(cx);
      else if (want?.startsWith("play:")) this.loadGame(this.play.selected, cx);
    }
    if (shown && this.tab === "puzzle" && !this.puzzle && !this.puzzleLoading && !this.puzzleError) this.loadPuzzle("daily", cx);
    if (shown && this.tab === "play" && this.play.token && Date.now() - this.play.polledAt > POLL_MS) this.refreshPlaying(cx);
    if (shown && this.tab === "play" && this.play.token && this.play.user && !this.play.selected && !this.play.replay
      && Date.now() - this.play.recentAt > RECENT_MS) this.loadRecent(cx);
    if (this.ws && this.tick % 3 === 0) this.ws.write("null").catch(() => {});
    if (this.stream?.pid) this.readStream(cx);
    const live =this.tab === "tv" ? this.tv.game : this.tab === "play" ? this.play.game : null;
    if (shown && ((live?.clocks && !live.over) || (this.seek && this.tab === "play"))) cx.notify();
  }

  stopFeed() {
    this.wsGen++;
    const ws = this.ws;
    this.ws = null;
    ws?.close().catch(() => {});
    this.stopStream();
  }

  // ---- your game's Board API stream (offers, exact position) -------------------------

  startStream(gameId, cx) {
    this.stopStream();
    const dir = `${appHome()}/data/lichess`;
    const st = this.stream = { gameId, file: `${dir}/stream-${gameId}.ndjson`, pid: null, offset: 0, reading: false, stopped: false };
    const token = this.play.token;
    cx.spawn(async (cx) => {
      let auth = null;
      try {
        auth = await writeAuthFile(`stream-${gameId}.auth`, token);
        const r = await exec("sh", ["-c", STREAM_SCRIPT, "sh", st.file, auth, `https://lichess.org/api/board/game/stream/${gameId}`]);
        const pid = r.stdout.trim();
        if (st.stopped) { if (pid) exec("kill", [pid]).catch(() => {}); return; }
        st.pid = pid || null;
      } catch (e) {
        const g = this.play.game;
        if (g && !st.stopped) { g.error = `Offers unavailable: ${errorText(e)}`; cx.notify(); }
      } finally {
        if (auth) fs.unlink(auth).catch(() => {}); // the script removes it too
      }
    });
  }

  stopStream() {
    const st = this.stream;
    if (!st) return;
    st.stopped = true;
    this.stream = null;
    if (st.pid) exec("kill", [st.pid]).catch(() => {});
    fs.unlink(st.file).catch(() => {});
  }

  readStream(cx) {
    const st = this.stream;
    if (st.reading) return;
    st.reading = true;
    cx.spawn(async (cx) => {
      try {
        const text = (await readTextFile(st.file)) ?? "";
        if (st.stopped || text.length <= st.offset) return;
        const end = text.lastIndexOf("\n") + 1; // whole lines only
        if (end <= st.offset) return;
        const lines = text.slice(st.offset, end).split("\n");
        st.offset = end;
        const g = this.play.game;
        if (!g || g.id !== st.gameId) return;
        for (const line of lines) {
          if (!line.trim()) continue; // keep-alive
          let ev;
          try { ev = JSON.parse(line); } catch { g.error = line.slice(0, 160); continue; }
          if (ev.type === "gameFull") applyStreamState(g, ev.state ?? {}, true);
          else if (ev.type === "gameState") applyStreamState(g, ev, false);
          else if (ev.error) g.error = ev.error;
        }
        cx.notify();
      } catch { /* file not there yet */ } finally { st.reading = false; }
    });
  }

  // Restart the current feed (reload + reconnect) after a dropped socket or an error.
  retry(key, cx) {
    cx.timer.after(4000, (cx) => { if (this.feedKey === key) { this.feedKey = null; this.heartbeat(cx); } });
  }

  watch(gameId, color, onMessage, cx) {
    const gen = ++this.wsGen, key = this.feedKey;
    cx.spawn(async (cx) => {
      let ws;
      try { ws = await connectWatch(gameId, color); } catch { if (gen === this.wsGen) this.retry(key, cx); return; }
      if (gen !== this.wsGen) { ws.close().catch(() => {}); return; }
      this.ws = ws;
      for (;;) {
        let raw;
        try { raw = await ws.read(); } catch { break; }
        if (gen !== this.wsGen) return;
        if (typeof raw !== "string" || raw === "0") continue;
        let m;
        try { m = JSON.parse(raw); } catch { continue; }
        if (m?.t) { onMessage(m, cx); cx.notify(); }
      }
      if (gen === this.wsGen) { this.ws = null; this.retry(key, cx); }
    });
  }

  setTab(tab, cx) {
    this.tab = tab; store("tab", tab);
    this.heartbeat(cx); cx.notify();
  }

  // ---- puzzle ----------------------------------------------------------------------

  loadPuzzle(kind, cx) {
    this.puzzleLoading = true; this.puzzleError = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const p = await api(kind === "daily" ? "/api/puzzle/daily" : "/api/puzzle/next");
        const chess = new Chess();
        for (const san of p.game.pgn.split(" ").filter(Boolean)) chess.move(san);
        const h = chess.history({ verbose: true }), m = h[h.length - 1];
        this.puzzle = {
          kind, id: p.puzzle.id, rating: p.puzzle.rating, themes: p.puzzle.themes ?? [],
          solution: p.puzzle.solution, idx: 0, chess, last: m ? [m.from, m.to] : null,
          orientation: chess.turn() === "w" ? "white" : "black",
          status: "play", hint: false, sel: null, targets: [],
        };
      } catch (e) { this.puzzleError = errorText(e); }
      this.puzzleLoading = false; cx.notify();
    });
  }

  puzzleSquare(sq, cx) {
    const P = this.puzzle;
    if (!P || P.status === "solved" || P.promo) return;
    const mv = clickSquare(P, sq, P.orientation[0]);
    if (mv && isPromotion(P.chess, mv.from, mv.to)) P.promo = mv; // ask which piece
    else if (mv) this.puzzleMove(P, mv.from, mv.to, undefined, cx);
    else if (P.status === "wrong" && P.sel) P.status = "play";
    cx.notify();
  }

  puzzleMove(P, from, to, promotion, cx) {
    P.promo = null;
    P.chess.move({ from, to, promotion });
    const uci = from + to + (promotion ?? ""), expected = P.solution[P.idx];
    if (uci === expected || P.chess.isCheckmate()) {
      P.idx++; P.last = [from, to]; P.hint = false;
      if (P.idx >= P.solution.length) P.status = "solved";
      else { P.status = "good"; this.puzzleReply(P, cx); }
    } else { P.chess.undo(); P.status = "wrong"; }
    cx.notify();
  }

  puzzleReply(P, cx) {
    cx.timer.after(350, (cx) => {
      if (this.puzzle !== P) return;
      const r = P.solution[P.idx];
      P.chess.move({ from: r.slice(0, 2), to: r.slice(2, 4), promotion: r[4] });
      P.last = [r.slice(0, 2), r.slice(2, 4)];
      P.idx++;
      if (P.idx >= P.solution.length) P.status = "solved";
      cx.notify();
    });
  }

  // ---- TV ----------------------------------------------------------------------------

  loadTv(cx, id = null, color = null) {
    const key = this.feedKey, channel = this.tv.channel;
    this.tv.error = null;
    cx.spawn(async (cx) => {
      try {
        if (!id) {
          const chans = await api("/api/tv/channels");
          const c = chans[channel] ?? chans.best;
          id = c.gameId; color = c.color;
        }
        const ex = await api(`/game/export/${id}?clocks=true&opening=false`);
        if (key !== this.feedKey) return;
        this.tv.game = gameFromExport(ex, color);
        this.watch(id, color, (m, cx) => this.onTvMessage(m, cx), cx);
      } catch (e) {
        if (key !== this.feedKey) return;
        this.tv.error = errorText(e);
        this.retry(key, cx);
      }
      cx.notify();
    });
  }

  onTvMessage(m, cx) {
    const g = this.tv.game;
    if (m.t === "move" && g) applySocketMove(g, m.d);
    else if (m.t === "end" && g) g.over = typeof m.d === "string" ? `${m.d === "white" ? "White" : "Black"} won` : "Game over";
    else if (m.t === "crowd") this.tv.watchers = m.d?.watchers?.nb ?? null;
    else if (m.t === "tvSelect" && m.d?.channel === this.tv.channel && m.d.id !== g?.id) {
      this.stopFeed();
      this.loadTv(cx, m.d.id, m.d.color);
    }
  }

  setChannel(channel, cx) {
    this.tv.channel = channel; this.tv.game = null; store("tvChannel", channel);
    this.heartbeat(cx); cx.notify();
  }

  // ---- play --------------------------------------------------------------------------

  saveToken(cx) {
    const token = this.tokenInput.value().trim();
    if (!token) return;
    this.play.error = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const me = await api("/api/account", { token });
        Object.assign(this.play, { token, user: me.username, polledAt: 0 });
        store("token", token); store("user", me.username);
        this.tokenInput.set_value("");
        this.heartbeat(cx);
      } catch (e) { this.play.error = `Token rejected: ${errorText(e)}`; }
      cx.notify();
    });
  }

  signOut(cx) {
    this.cancelSeek(cx);
    Object.assign(this.play, { token: "", user: null, games: [], selected: null, game: null, error: null, notice: null,
      recent: [], recentAt: 0, recentError: null, replay: null });
    store("token", null); store("user", null);
    this.heartbeat(cx); cx.notify();
  }

  async fetchPlaying() {
    const games = standardOnly(await api("/api/account/playing?nb=50", { token: this.play.token }));
    this.play.games = games; this.play.polledAt = Date.now();
    return games;
  }

  refreshPlaying(cx) {
    if (this.play.polling) return;
    this.play.polling = true; this.play.polledAt = Date.now();
    cx.spawn(async (cx) => {
      try { await this.fetchPlaying(); this.play.error = null; } catch (e) { this.play.error = errorText(e); }
      this.play.polling = false; cx.notify();
    });
  }

  setRated(rated, cx) {
    this.play.rated = rated; store("rated", String(rated)); cx.notify();
  }

  // Seek an opponent; when paired, open the new game.
  startSeek(cell, cx) {
    if (this.seek) return;
    const P = this.play, token = P.token;
    const form = `rated=${P.rated}&` + (cell.days ? `days=${cell.days}` : `time=${cell.time}&increment=${cell.inc}`);
    const seek = this.seek = { cell, startedAt: Date.now(), pid: null, cancelled: false };
    P.error = null; P.notice = null; cx.notify();
    cx.spawn(async (cx) => {
      let authFile = null;
      try {
        const known =new Set((await this.fetchPlaying()).map((g) => g.gameId));
        if (seek.cancelled) return;
        if (cell.days) {
          await api("/api/board/seek", { token, method: "POST", form });
          P.notice = "Correspondence seek posted. The game appears below once someone accepts it.";
          return;
        }
        authFile = await writeAuthFile("seek.auth", token);
        const pidFile = `${appHome()}/data/lichess/seek.pid`;
        const run =exec("sh", ["-c", SEEK_SCRIPT, "sh", pidFile, authFile, "https://lichess.org/api/board/seek", form],
          { timeout: SEEK_LIMIT_MS });
        for (let i = 0; i < 30 && seek.pid == null; i++) {
          await sleep(cx, 100);
          const pid = (await readTextFile(pidFile).catch(() => null))?.trim();
          if (pid) seek.pid = pid;
        }
        if (seek.cancelled && seek.pid) exec("kill", [seek.pid]).catch(() => {});
        let r;
        try { r = await run; } catch (e) {
          if (seek.cancelled) return;
          if (seek.pid) exec("kill", [seek.pid]).catch(() => {});
          throw new Error(Date.now() - seek.startedAt >= SEEK_LIMIT_MS - 1000 ? "No opponent found in 10 minutes." : errorText(e));
        }
        if (seek.cancelled) return;
        const lines = r.stdout.trimEnd().split("\n"), status = Number(lines.pop());
        if (status !== 200) {
          let msg = lines.join("\n").trim();
          try { msg = JSON.parse(msg).error ?? msg; } catch { /* plain text */ }
          throw new Error(msg || r.stderr.trim() || `Lichess answered ${status || "nothing"}`);
        }
        // Paired (or the seek expired): find the new game. It can take a moment to be listed.
        for (let i = 0; i < 5; i++) {
          const fresh = (await this.fetchPlaying()).find((g) => !known.has(g.gameId));
          if (fresh) { this.seek = null; this.selectGame(fresh.gameId, cx); return; }
          await sleep(cx, 1000);
        }
        throw new Error("The seek ended without a game. Try again.");
      } catch (e) {
        if (!seek.cancelled) P.error = errorText(e);
      } finally {
        if (authFile) fs.unlink(authFile).catch(() => {}); // the script removes it too
        if (this.seek === seek) this.seek = null;
        cx.notify();
      }
    });
  }

  cancelSeek(cx) {
    const seek = this.seek;
    if (!seek) return;
    seek.cancelled = true;
    this.seek = null;
    if (seek.pid) exec("kill", [seek.pid]).catch(() => {});
    cx.notify();
  }

  loadGame(id, cx) {
    const key = this.feedKey, token = this.play.token;
    this.play.error = null;
    cx.spawn(async (cx) => {
      try {
        const [ex, playing] = await Promise.all([
          api(`/game/export/${id}?clocks=true&opening=false`, { token }),
          api("/api/account/playing?nb=50", { token }),
        ]);
        if (key !== this.feedKey) return;
        this.play.games = standardOnly(playing);
        this.play.polledAt = Date.now();
        const info = this.play.games.find((g) => g.gameId === id);
        const me = this.play.user?.toLowerCase();
        const color = info?.color ?? (ex.players?.black?.user?.id === me ? "black" : "white");
        const g = gameFromExport(ex, color);
        if (info && !g.over) {
          syncToPlaying(g, info); // the export lags a few moves on ongoing games
          if (info.secondsLeft != null) g.clocks = { ...(g.clocks ?? {}), [color]: info.secondsLeft, at: Date.now() };
        }
        this.play.game = g;
        if (!g.over) {
          this.watch(id, color, (m, cx) => this.onPlayMessage(m, cx), cx);
          this.startStream(id, cx);
        }
      } catch (e) {
        if (key !== this.feedKey) return;
        this.play.error = errorText(e);
        this.retry(key, cx);
      }
      cx.notify();
    });
  }

  onPlayMessage(m, _cx) {
    const g = this.play.game;
    if (!g) return;
    if (m.t === "move") applySocketMove(g, m.d);
    else if (m.t === "end" || m.t === "endData") {
      g.over = m.t === "end" && typeof m.d === "string" ? `${m.d === "white" ? "White" : "Black"} won` : g.over ?? "Game over";
      this.play.polledAt = 0; this.play.recentAt = 0;
    }
  }

  selectGame(id, cx) {
    Object.assign(this.play, { selected: id, game: null, confirmResign: false, error: null, moveError: null });
    this.moveInput.set_value("");
    this.heartbeat(cx); cx.notify();
  }

  playSquare(sq, cx) {
    const g = this.play.game;
    if (!g || g.over || g.sending || g.promo) return;
    const mv = clickSquare(g, sq, g.color[0]);
    if (mv && isPromotion(g.chess, mv.from, mv.to)) g.promo = mv; // ask which piece
    else if (mv) this.sendMove(g, mv.from, mv.to, undefined, cx);
    cx.notify();
  }

  promote(g, piece, cx) {
    const mv = g.promo;
    if (!mv) return;
    g.promo = null;
    if (!g.over && g.chess.turn() === g.color[0]) this.sendMove(g, mv.from, mv.to, piece, cx);
    cx.notify();
  }

  // Plays the move on the board at once, then tells Lichess; undone if Lichess refuses it.
  sendMove(g, from, to, promotion, cx) {
    const uci = from + to + (promotion ?? "");
    const undo = applyLocalMove(g, from, to, promotion);
    g.sending = true; g.error = null;
    cx.spawn(async (cx) => {
      try { await api(`/api/board/game/${g.id}/move/${uci}`, { token: this.play.token, method: "POST" }); }
      catch (e) { undo(); g.error = errorText(e); }
      g.sending = false; this.play.polledAt = 0; cx.notify();
    });
  }

  typeMove(cx) {
    const g = this.play.game, P = this.play;
    if (!g || g.over) return;
    if (g.sending) P.moveError = "Still sending your last move.";
    else if (g.chess.turn() !== g.color[0]) P.moveError = "It's not your turn.";
    else {
      try {
        const mv = parseTypedMove(g.chess, this.moveInput.value());
        this.sendMove(g, mv.from, mv.to, mv.promotion, cx);
        this.moveInput.set_value(""); P.moveError = null;
      } catch (e) { P.moveError = errorText(e); }
    }
    cx.notify();
  }

  // ---- recent games + replay ---------------------------------------------------------

  loadRecent(cx) {
    const P = this.play;
    if (P.recentLoading) return;
    P.recentLoading = true; P.recentAt = Date.now();
    cx.spawn(async (cx) => {
      try {
        const me = P.user.toLowerCase();
        // Ask for a few extra: aborted games and other variants are left out.
        const games = await api(`/api/games/user/${encodeURIComponent(P.user)}?max=${RECENT_COUNT + 10}&moves=true&opening=true&finished=true`,
          { token: P.token, ndjson: true });
        P.recent = games
          .filter((ex) => ex.variant === "standard" && !["aborted", "noStart", "created", "started"].includes(ex.status))
          .slice(0, RECENT_COUNT).map((ex) => recentFrom(ex, me));
        P.recentError = null;
      } catch (e) { P.recentError = errorText(e); }
      P.recentLoading = false; cx.notify();
    });
  }

  openReplay(r, cx) {
    const { fens, lasts, sans } = buildReplay(r.moves);
    this.play.replay = { ...r, fens, lasts, sans, idx: sans.length, chess: new Chess(fens[fens.length - 1]),
      last: lasts[lasts.length - 1], sel: null, targets: [] };
    this.replayFocus.focus();
    cx.notify();
  }

  stepReplay(idx, cx) {
    const R = this.play.replay;
    if (!R) return;
    const i = Math.max(0, Math.min(R.sans.length, idx));
    if (i !== R.idx) { R.idx = i; R.chess.load(R.fens[i]); R.last = R.lasts[i]; }
    cx.notify();
  }

  replayKey(e, cx) {
    const R = this.play.replay;
    if (!R) return;
    const step = { left: -1, up: -1, right: 1, down: 1 }[e.key];
    if (step) this.stepReplay(R.idx + step, cx);
    else if (e.key === "home") this.stepReplay(0, cx);
    else if (e.key === "end") this.stepReplay(R.sans.length, cx);
    else if (e.key === "escape") { this.play.replay = null; cx.notify(); }
    else return;
    cx.stop_propagation();
  }

  // `then` runs on success, e.g. to show your own offer before the stream confirms it.
  gameAction(action, cx, then = null) {
    const g = this.play.game;
    if (!g) return;
    this.play.confirmResign = false;
    cx.spawn(async (cx) => {
      try { await api(`/api/board/game/${g.id}/${action}`, { token: this.play.token, method: "POST" }); then?.(g); }
      catch (e) { g.error = errorText(e); }
      cx.notify();
    });
  }

  // Offers: draw/yes offers or accepts, draw/no declines; the same for takeback.
  offer(kind, answer, cx) {
    const key = kind === "draw" ? "myDraw" : "myTakeback", theirs = kind === "draw" ? "theirDraw" : "theirTakeback";
    this.gameAction(`${kind}/${answer}`, cx, (g) => {
      g.offers ??= {};
      if (g.offers[theirs]) g.offers[theirs] = false; // answered theirs
      else if (answer === "yes") g.offers[key] = true; // made ours
    });
  }

  // ---- render ------------------------------------------------------------------------

  button(id, label, t, onClick, { primary = false, danger = false } = {}) {
    return div().id(id).flex_none().px(8).py(3).rounded(5).text_size(11.5).cursor_pointer()
      .when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground))
      .when(!primary, (el) => el.text_color(danger ? t.blocked : t.muted).hover((s) => s.bg(t.hover)))
      .on_click(onClick).child(label);
  }

  boardSize() { return Math.max(160, Math.min(this.width - 24, 560)); }

  playerBar(id, player, clock, running, t) {
    const mono = typeof settings().font_family === "string" ? settings().font_family : "JetBrains Mono";
    return h_flex().id(id).w(this.boardSize()).h(26).items_center().justify_between().gap(8)
      .child(h_flex().min_w(0).gap(6).items_center()
        .when(Boolean(player?.title), (el) => el.child(div().text_size(11).font_semibold().text_color(t.blocked).child(player.title)))
        .child(div().min_w(0).truncate().font_medium().child(player?.name ?? "?"))
        .when(player?.rating != null, (el) => el.child(div().text_size(11.5).text_color(t.dim).child(String(player.rating)))))
      .when(clock != null, (el) => el.child(div().flex_none().px(7).py(1).rounded(4).font_family(mono).text_size(12.5)
        .bg(running ? t.selected : t.raised).text_color(running ? t.foreground : t.muted).child(formatClock(clock))));
  }

  // Players above and below the board, from `orientation`'s point of view.
  liveBoard(prefix, g, t, onSquare, onPromote = null) {
    const top = g.color === "white" ? "black" : "white", bottom = g.color;
    const bar = (side) => this.playerBar(`${prefix}-${side}`, g.players[side], clockNow(g, side),
      !g.over && g.chess.turn() === side[0], t);
    return v_flex().gap(6).items_center()
      .child(bar(top))
      .child(renderBoard({ id: prefix, model: g, orientation: g.color, size: this.boardSize(), onSquare, onPromote }))
      .child(bar(bottom));
  }

  // "Opponent offers a draw [Accept] [Decline]", and your own pending offers.
  offerBanners(g, t, w) {
    const o = g.offers ?? {};
    const name = g.players[g.color === "white" ? "black" : "white"]?.name ?? "Your opponent";
    const banner = (id, text, kind) => h_flex().id(id).w(w).px(10).py(7).gap(6).items_center().rounded(7)
      .border_1().border_color(t.accent).bg(t.selected)
      .child(div().flex_1().min_w(0).font_medium().child(text))
      .child(this.button(`${id}-yes`, "Accept", t, (_e, cx) => this.offer(kind, "yes", cx), { primary: true }))
      .child(this.button(`${id}-no`, "Decline", t, (_e, cx) => this.offer(kind, "no", cx)));
    const note = (text) => div().w(w).text_size(11.5).text_color(t.muted).child(text);
    return v_flex().gap(6).items_center()
      .when(Boolean(o.theirDraw), (el) => el.child(banner("pl-their-draw", `${name} offers a draw`, "draw")))
      .when(Boolean(o.theirTakeback), (el) => el.child(banner("pl-their-takeback", `${name} asks to take back a move`, "takeback")))
      .when(Boolean(o.myDraw), (el) => el.child(note("You offered a draw. Waiting for an answer.")))
      .when(Boolean(o.myTakeback), (el) => el.child(note("You asked for a takeback. Waiting for an answer.")));
  }

  renderPuzzle(t) {
    const P = this.puzzle;
    if (!P) return v_flex().gap(8)
      .child(div().text_color(this.puzzleError ? t.blocked : t.dim).child(this.puzzleError ?? "Loading puzzle…"))
      .when(Boolean(this.puzzleError), (el) => el.child(h_flex().child(this.button("pz-retry", "Try again", t, (_e, cx) => this.loadPuzzle("daily", cx)))));
    const side = P.orientation === "white" ? "White" : "Black";
    const [msg, color] = {
      play: [`${side} to move. Find the best move.`, t.foreground],
      good: ["Best move! Keep going.", t.done],
      wrong: ["That's not it. Try again.", t.blocked],
      solved: ["Solved!", t.done],
    }[P.status];
    const themes = P.themes.map((x) => x.replace(/([A-Z])/g, " $1").toLowerCase()).join(" · ");
    return v_flex().gap(8).items_center()
      .child(h_flex().w(this.boardSize()).justify_between().items_center()
        .child(div().font_semibold().child(P.kind === "daily" ? "Puzzle of the day" : "Puzzle"))
        .child(div().text_size(11.5).text_color(t.dim).child(`#${P.id} · ${P.rating}`)))
      .child(renderBoard({
        id: "pz", model: P, orientation: P.orientation, size: this.boardSize(),
        hint: P.hint && P.status !== "solved" ? P.solution[P.idx]?.slice(0, 2) : null,
        onSquare: (sq, cx) => this.puzzleSquare(sq, cx),
        onPromote: (p, cx) => { const mv = P.promo; if (mv) this.puzzleMove(P, mv.from, mv.to, p, cx); },
      }))
      .child(div().w(this.boardSize()).text_color(color).font_medium().child(msg))
      .when(Boolean(themes), (el) => el.child(div().w(this.boardSize()).text_size(11).text_color(t.dim).child(themes)))
      .child(h_flex().w(this.boardSize()).gap(4).flex_wrap()
        .when(P.status !== "solved", (el) => el.child(this.button("pz-hint", "Hint", t, (_e, cx) => { P.hint = true; cx.notify(); })))
        .child(this.button("pz-next", this.puzzleLoading ? "Loading…" : "Next puzzle", t, (_e, cx) => this.loadPuzzle("next", cx), { primary: P.status === "solved" }))
        .when(P.kind !== "daily", (el) => el.child(this.button("pz-daily", "Daily", t, (_e, cx) => this.loadPuzzle("daily", cx))))
        .child(div().flex_1())
        .child(this.button("pz-open", "Open on Lichess", t, () => open(`https://lichess.org/training/${P.id}`))));
  }

  renderTv(t) {
    const g = this.tv.game;
    const pills = h_flex().w(this.boardSize()).gap(3).flex_wrap().children(CHANNELS.map(([id, label]) => {
      const on = id === this.tv.channel;
      return div().id(`tv-ch-${id}`).px(8).py(2).rounded(5).text_size(11.5).cursor_pointer()
        .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.setChannel(id, cx)).child(label);
    }));
    let body;
    if (!g) body = div().text_color(this.tv.error ? t.blocked : t.dim).child(this.tv.error ?? "Tuning in…");
    else body = v_flex().gap(8).items_center()
      .child(this.liveBoard("tv", g, t, null))
      .child(h_flex().w(this.boardSize()).justify_between().items_center()
        .child(div().text_size(11.5).text_color(g.over ? t.foreground : t.dim)
          .child(g.over ?? (this.tv.watchers ? `Live · ${this.tv.watchers} watching` : "Live")))
        .child(this.button("tv-open", "Open on Lichess", t, () => open(`https://lichess.org/${g.id}`))));
    return v_flex().gap(10).items_center().child(pills).child(body);
  }

  renderPlay(t) {
    const P = this.play, w = this.boardSize();
    const err = (text) => div().w(w).text_size(11.5).text_color(t.blocked).child(text);
    if (!P.token) {
      return v_flex().w(w).gap(10)
        .child(div().font_semibold().child("Play your Lichess games"))
        .child(div().text_color(t.muted).text_size(12).child(
          "Paste a personal API token with the \"Play games with the board API\" scope. It is stored only in this panel."))
        .child(h_flex().child(this.button("pl-create", "Create a token on lichess.org", t, () => open(TOKEN_URL))))
        .child(Input.new(this.tokenInput).h(32).px(10).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12.5))
        .child(h_flex().child(this.button("pl-save", "Save token", t, (_e, cx) => this.saveToken(cx), { primary: true })))
        .when(Boolean(P.error), (el) => el.child(err(P.error)));
    }
    if (P.selected) {
      const g = P.game;
      const head = h_flex().w(w).justify_between().items_center()
        .child(this.button("pl-back", "← Games", t, (_e, cx) => this.selectGame(null, cx)))
        .when(Boolean(g?.speed), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(g.speed)));
      if (!g) return v_flex().gap(8).items_center().child(head)
        .child(div().w(w).text_color(P.error ? t.blocked : t.dim).child(P.error ?? "Loading game…"));
      const myTurn = !g.over && g.chess.turn() === g.color[0];
      const status = g.over ?? (g.sending ? "Sending move…" : myTurn ? "Your move" : "Waiting for your opponent");
      const actions = h_flex().w(w).gap(4).items_center()
        .when(!g.over && (g.ply ?? 2) < 2, (el) => el.child(this.button("pl-abort", "Abort", t, (_e, cx) => this.gameAction("abort", cx))))
        .when(!g.over && !P.confirmResign, (el) => el.child(this.button("pl-resign", "Resign", t, (_e, cx) => { P.confirmResign = true; cx.notify(); })))
        .when(!g.over && P.confirmResign, (el) => el
          .child(this.button("pl-resign-yes", "Really resign", t, (_e, cx) => this.gameAction("resign", cx), { danger: true }))
          .child(this.button("pl-resign-no", "Cancel", t, (_e, cx) => { P.confirmResign = false; cx.notify(); })))
        .when(!g.over && !g.offers?.myDraw && !g.offers?.theirDraw, (el) => el.child(this.button("pl-draw", "Offer draw", t, (_e, cx) => this.offer("draw", "yes", cx))))
        .when(!g.over && (g.ply ?? 1) > 0 && !g.offers?.myTakeback && !g.offers?.theirTakeback, (el) =>
          el.child(this.button("pl-takeback", "Takeback", t, (_e, cx) => this.offer("takeback", "yes", cx))))
        .when(Boolean(g.over), (el) => el.child(this.button("pl-new", "New game", t, (_e, cx) => this.selectGame(null, cx), { primary: true })))
        .child(div().flex_1())
        .child(this.button("pl-open", "Open on Lichess", t, () => open(`https://lichess.org/${g.id}`)));
      return v_flex().gap(8).items_center().child(head)
        .child(this.liveBoard("pl", g, t, (sq, cx) => this.playSquare(sq, cx), (p, cx) => this.promote(g, p, cx)))
        .child(div().w(w).font_medium().text_color(myTurn ? t.done : t.foreground).child(g.promo ? "Choose a piece" : status))
        .when(!g.over, (el) => el.child(this.offerBanners(g, t, w)))
        .when(Boolean(g.error), (el) => el.child(err(g.error)))
        .when(!g.over, (el) => el.child(h_flex().w(w).gap(6).items_center()
          .child(Input.new(this.moveInput).flex_1().h(30).px(9).rounded(7).border_1()
            .border_color(P.moveError ? t.blocked : t.input).bg(t.background).text_size(12.5))
          .child(this.button("pl-type-move", "Move", t, (_e, cx) => this.typeMove(cx), { primary: myTurn && !g.sending }))))
        .when(Boolean(P.moveError), (el) => el.child(err(P.moveError)))
        .child(actions);
    }
    if (P.replay) return this.renderReplay(t);
    const rows = P.games.map((g) => h_flex().id(`pl-g-${g.gameId}`).w(w).px(8).py(6).gap(8).items_center().rounded(6)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.selectGame(g.gameId, cx))
      .child(svg(`mods/lichess/icon.svg`).size(14).text_color(g.color === "white" ? t.foreground : t.dim))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().font_medium().child(`${g.opponent?.username ?? "?"}${g.opponent?.rating ? ` (${g.opponent.rating})` : ""}`))
        .child(div().text_size(11).text_color(t.dim).child(`${g.speed ?? ""} · you play ${g.color}`)))
      .child(div().flex_none().text_size(11).px(6).py(1).rounded(4)
        .bg(g.isMyTurn ? t.solid : t.raised).text_color(g.isMyTurn ? t.solid_foreground : t.muted)
        .child(g.isMyTurn ? "Your turn" : "Waiting")));
    return v_flex().gap(8).items_center()
      .child(h_flex().w(w).justify_between().items_center()
        .child(div().text_size(12).text_color(t.muted).child(`Signed in as ${P.user ?? "?"}`))
        .child(h_flex().gap(2)
          .child(this.button("pl-refresh", P.polling ? "Refreshing…" : "Refresh", t, (_e, cx) => this.refreshPlaying(cx)))
          .child(this.button("pl-signout", "Sign out", t, (_e, cx) => this.signOut(cx)))))
      .child(this.renderGrid(t))
      .when(Boolean(P.error), (el) => el.child(err(P.error)))
      .when(Boolean(P.notice), (el) => el.child(div().w(w).text_size(11.5).text_color(t.muted).child(P.notice)))
      .child(div().w(w).pt(6).text_size(11.5).text_color(t.dim).child(P.games.length ? "Your games" : "No games in progress"))
      .children(rows)
      .child(this.renderRecent(t));
  }

  resultBadge(result, t, size = 20) {
    const r = RESULT[result];
    return div().flex_none().size(size).rounded(5).flex().items_center().justify_center()
      .bg(r.color ?? t.raised).text_color(r.color ? "#ffffff" : t.muted).font_bold().text_size(size * 0.65)
      .child(result === "-" ? "−" : result);
  }

  renderRecent(t) {
    const P = this.play, w = this.boardSize();
    const head = h_flex().w(w).pt(10).justify_between().items_center()
      .child(div().text_size(11.5).text_color(t.dim).child("Recent games"))
      .child(this.button("pl-recent-refresh", P.recentLoading ? "Loading…" : "Refresh", t, (_e, cx) => this.loadRecent(cx)));
    const rows = P.recent.map((r) => h_flex().id(`pl-r-${r.id}`).w(w).px(6).py(5).gap(8).items_center().rounded(6)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.openReplay(r, cx))
      .child(this.resultBadge(r.result, t))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().font_medium().child(`${r.opponent.name}${r.opponent.rating ? ` (${r.opponent.rating})` : ""}`))
        .child(div().truncate().text_size(11).text_color(t.dim).child(`${r.speed}${r.rated ? "" : " · casual"} · ${ago(r.at)}`)))
      .when(r.diff != null, (el) => el.child(div().flex_none().text_size(11.5)
        .text_color(r.diff > 0 ? RESULT["+"].color : r.diff < 0 ? RESULT["-"].color : t.dim)
        .child(r.diff > 0 ? `+${r.diff}` : String(r.diff)))));
    return v_flex().gap(2).items_center().child(head)
      .when(Boolean(P.recentError), (el) => el.child(div().w(w).text_size(11.5).text_color(t.blocked).child(P.recentError)))
      .when(!P.recent.length && !P.recentError, (el) => el.child(div().w(w).text_size(12).text_color(t.dim)
        .child(P.recentLoading ? "Loading…" : "No finished games yet.")))
      .children(rows);
  }

  renderReplay(t) {
    const R = this.play.replay, w = this.boardSize();
    const top = R.color === "white" ? "black" : "white";
    const nav = (id, label, idx, enabled) => div().id(id).flex_1().h(28).rounded(6).flex().items_center().justify_center()
      .text_size(14).bg(t.raised).text_color(enabled ? t.foreground : t.dim)
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.replayFocus.focus(); this.stepReplay(idx, cx); }))
      .child(label);
    const atStart = R.idx === 0, atEnd = R.idx === R.sans.length;
    // Moves as "1. e4 e5 2. Nf3 …", wrapping; each move jumps there.
    const move = (i) => {
      const on = R.idx === i + 1;
      return div().id(`rp-m${i}`).px(4).py(1).rounded(4).cursor_pointer()
        .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).when(on, (el) => el.font_semibold())
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.replayFocus.focus(); this.stepReplay(i + 1, cx); }).child(R.sans[i]);
    };
    // A move number stays on the same line as White's move.
    const tokens = [];
    for (let i = 0; i < R.sans.length; i++) {
      if (i % 2 === 0) tokens.push(h_flex().id(`rp-w${i}`).items_center().pl(i ? 4 : 0)
        .child(div().text_color(t.dim).child(`${i / 2 + 1}.`)).child(move(i)));
      else tokens.push(move(i));
    }
    const res = RESULT[R.result];
    return v_flex().id("replay").track_focus(this.replayFocus).on_key_down((e, cx) => this.replayKey(e, cx))
      .gap(8).items_center()
      .child(h_flex().w(w).justify_between().items_center()
        .child(this.button("rp-back", "← Games", t, (_e, cx) => { this.play.replay = null; cx.notify(); }))
        .child(div().text_size(11.5).text_color(t.dim).child(`${R.speed}${R.rated ? " · rated" : " · casual"} · ${ago(R.at)}`)))
      .child(this.playerBar("rp-top", R.players[top], null, false, t))
      .child(renderBoard({ id: "rp", model: R, orientation: R.color, size: w }))
      .child(this.playerBar("rp-bottom", R.players[R.color], null, false, t))
      .child(h_flex().w(w).gap(4)
        .child(nav("rp-first", "«", 0, !atStart)).child(nav("rp-prev", "‹", R.idx - 1, !atStart))
        .child(nav("rp-next", "›", R.idx + 1, !atEnd)).child(nav("rp-last", "»", R.sans.length, !atEnd)))
      .child(h_flex().w(w).gap(8).items_center()
        .child(this.resultBadge(R.result, t, 18))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(res.color ?? t.muted).font_medium()
          .child(`${res.word}${R.status ? ` · ${R.status}` : ""}`))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(`${R.idx}/${R.sans.length}`)))
      .when(Boolean(R.opening), (el) => el.child(div().w(w).truncate().text_size(11).text_color(t.dim).child(R.opening)))
      .child(h_flex().w(w).flex_wrap().items_center().gap(1).text_size(12.5).children(tokens))
      .child(h_flex().w(w).justify_between().items_center()
        .child(div().text_size(11).text_color(t.dim).child("← → to step, Home/End to jump"))
        .child(this.button("rp-open", "Open on Lichess", t, () => open(`https://lichess.org/${R.id}/${R.color}`))));
  }

  renderGrid(t) {
    const P = this.play, w = this.boardSize(), gap = 6;
    const cellW = Math.floor((w - gap * 2) / 3);
    const pill = (id, label, on, action) => div().id(id).px(8).py(2).rounded(5).text_size(11.5).cursor_pointer()
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
      .when(!this.seek, (el) => el.hover((s) => s.bg(t.hover)).on_click(action)).child(label);
    const cell = (c) => {
      const searching = this.seek?.cell === c;
      const idle = !this.seek;
      const secs = searching ? Math.floor((Date.now() - this.seek.startedAt) / 1000) : 0;
      return v_flex().id(`seek-${c.label}`).w(cellW).h(62).flex_none().items_center().justify_center().gap(2).rounded(8)
        .border_1().border_color(searching ? t.accent : t.border).bg(searching ? t.selected : t.raised)
        .when(!idle && !searching, (el) => el.opacity(0.45))
        .when(idle, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.startSeek(c, cx)))
        .child(div().text_size(18).font_medium().text_color(t.foreground).child(c.label))
        .child(searching
          ? h_flex().gap(4).text_size(11).text_color(t.accent)
            .child(div().frames(SPIN, 90).child(SPIN[0])).child(`Searching ${formatClock(secs)}`)
          : div().text_size(11).text_color(t.dim).child(c.kind));
    };
    return v_flex().w(w).gap(gap)
      .child(h_flex().justify_between().items_center()
        .child(div().font_semibold().child("Quick pairing"))
        .child(h_flex().gap(2)
          .child(pill("seek-rated", "Rated", P.rated, (_e, cx) => this.setRated(true, cx)))
          .child(pill("seek-casual", "Casual", !P.rated, (_e, cx) => this.setRated(false, cx)))))
      .child(h_flex().flex_wrap().gap(gap).children(GRID.map(cell)))
      .when(Boolean(this.seek), (el) => el.child(h_flex().justify_between().items_center()
        .child(div().text_size(12).text_color(t.muted).child(`Looking for a ${this.seek.cell.kind.toLowerCase()} opponent…`))
        .child(this.button("seek-cancel", "Cancel", t, (_e, cx) => this.cancelSeek(cx), { danger: true }))));
  }

  render() {
    const t = theme();
    const tabs = h_flex().gap(2).children(TABS.map(([id, label]) => {
      const on = id === this.tab;
      return div().id(`tab-${id}`).px(9).py(3).rounded(6).text_size(12).cursor_pointer()
        .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.setTab(id, cx)).child(label);
    }));
    const content = this.tab === "tv" ? this.renderTv(t) : this.tab === "play" ? this.renderPlay(t) : this.renderPuzzle(t);
    return v_flex().id("lichess").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) >= 1) { this.width = size.width; cx.notify(); } })
      .child(h_flex().h(42).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().pl(4).font_semibold().child("Lichess")).child(div().flex_1()).child(tabs))
      .child(div().id("lichess-scroll").flex_1().min_h(0).overflow_y_scroll().px(12).py(12).child(content));
  }
}
