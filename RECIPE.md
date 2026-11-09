# Lichess

A side panel that brings Lichess into Herdr: the puzzle of the day, Lichess TV with
live moves, and your own games, from finding an opponent to stepping through what you
played. Boards look like Lichess's brown board, with Lichess's pieces and arrows.

![Lichess](preview.png)

## What you see

One panel (docked right, 380px), drawn as a card: `background` fill, 1px `border`,
10px radius. A 42px header with "Lichess" (semibold, 13px) on the left and three tabs
on the right: Puzzle, TV, Play (12px pills, `selected` background on the active one).
Below it, a scrolling body with 12px padding. Everything is sized to one board width:
the panel width minus 24px, between 160 and 560px, rounded down to a multiple of 8.

**The board** (shared by all tabs): squares `#f0d9b5` / `#b58863` (a1 dark); the last
move `#cdd26a` / `#aaa23a`; the selected piece `#829769` / `#646e40`; a hinted square
`#9ab8d6` / `#7a95b3`; a king in check `#f08a76` / `#d3624c`. Rank numbers on the
left file and file letters on the bottom rank, in the opposite square colour, 20% of a
square. Legal targets: a dot (28% of a square, `#14551e80`) on empty squares, a ring
on captures. Pieces are Lichess's cburnett SVGs. Arrows and circles from the user
are drawn over the pieces in `#15781bcc` green, `#882020cc` red, `#003088cc` blue or
`#e68f00cc` yellow.

**Puzzle**: "Puzzle of the day" (or "Puzzle") with `#id · rating` on the right, the
board from the side to move, a status line, theme tags (11px, `dim`), and Hint, Next
puzzle, Daily, Open on Lichess.

**TV**: channel pills (Top rated, Bullet, Blitz, Rapid, Classical), then the opponent's
bar, the board, your side's bar. A bar is the title (in `blocked` colour), name, rating
(`dim`), and on the right a monospace clock (`selected` background while it runs,
`raised` otherwise). Below: "Live · N watching" or the result, and Open on Lichess.

**Play**, signed out: a short explanation, "Create a token on lichess.org", a masked
token field and Save token.

**Play**, signed in, top to bottom:
- "Signed in as NAME", Refresh, Sign out.
- "Quick pairing" with a Rated/Casual toggle, then a 3-column grid of 62px cells
  (`raised`, 1px `border`, 8px radius): the time control at 18px and its kind under it
  (10+0, 10+5, 15+10 Rapid; 30+0, 30+20 Classical; 3 days Correspondence). While
  searching, that cell gets an `accent` border, a braille spinner and "Searching 0:12";
  the others fade to 45%; a row below says "Looking for a rapid opponent…" with Cancel.
- Errors in `blocked`, notices in `muted`.
- "Your games": one row per ongoing game: the mod icon, "opponent (rating)", "speed ·
  you play white", and a "Your turn" (`solid`) or "Waiting" badge.
- "Recent games" with Refresh: the last 10 finished games, each with a 20px result
  badge (**+** on `#629924`, **−** on `#cc3333`, white text; **=** on `raised`),
  opponent and rating, "speed · casual · 3h ago", and the rating change in green/red.

**A live game**: "← Games" and the speed; bars and board from your side; a status line
("Your move" in `done`, "Waiting for your opponent", "Sending move…", "Choose a piece",
or the result); offer banners; a move field with a Move button; then Abort (first
moves only), Resign, Offer draw, Takeback, New game (once over), Open on Lichess.

**A finished game**: "← Games" and "speed · rated · 3d ago"; bars and board from your
side; four step buttons « ‹ › »; the result badge with "Won · resign" and "20/91"; the
opening; every move as wrapping "1. e4 e5 2. Nf3 …" text, the current one highlighted;
"← → to step, Home/End to jump" and Open on Lichess.

## How it behaves

- **Moving**: click your piece, then a dot. Clicking it again, or elsewhere, deselects.
  A pawn reaching the last rank dims the board and stacks queen, knight, rook, bishop
  (grey discs) from that square toward the centre; a click elsewhere cancels.
- **Typing a move**: Enter or Move. Accepts SAN (`Nf3`, `exd5`, `O-O`, `0-0`, `e8=Q`,
  `e8q`, trailing `+#!?`) and coordinates (`e2e4`, `e7e8q`). Illegal moves and moves out
  of turn show why, in red, and send nothing.
- Your moves show at once and are sent to Lichess; if Lichess refuses, the move is
  undone and the reason shown.
- **Puzzle**: a right move turns the line "Best move! Keep going." and the reply
  follows 350ms later; a wrong one says "That's not it. Try again." and isn't kept. Any
  mating move counts at the end. "Solved!" when done.
- **TV** switches to the channel's next featured game by itself.
- **Pairing**: clicking a real-time cell searches until someone accepts, then opens the
  new game. Cancel, closing the panel, a reload, quitting or signing out cancels the
  search. 3 days posts a correspondence seek and says so.
- **Offers**: "NAME offers a draw" / "NAME asks to take back a move" banners (`accent`
  border, `selected` fill) with Accept and Decline; your own pending offer shows as a
  muted line instead of its button. An accepted takeback rewinds the board.
- **Arrows**: right-drag draws (shift red, alt blue, shift+alt yellow, else green),
  right-click circles a square, repeating removes, another colour recolours, left-click
  clears. They belong to the position: in a replay they stay on their move; in a live
  game they go when a move is played.
- **Replays**: ←/↑ back, →/↓ forward, Home/End, Escape closes.
- Clocks count down every second while visible. Live feeds stop when the panel isn't
  on screen and start again (reloading the game) when it is.

## Built from

- `mods/lichess/mod.json`: `{ "place": "right", "size": 380 }`.
- `main.js`: the view. A 1-second heartbeat decides which live feed should run
  (`tv:<channel>` or `play:<gameId>`, only while the block is visible), loads the daily
  puzzle on first show, polls `/api/account/playing` every 20s and recent games every 2
  minutes on the Play tab, pings the socket every 3s, reads the game stream, and
  redraws for running clocks. Visibility walks `layout()` to the block whose
  `content.mod` is `lichess`: no hidden ancestor, and each stack's `active` is on the path.
- `game.js`: `api()` (fetch with a `User-Agent`, JSON or ndjson, form bodies), the game
  model, socket moves, stream states, clocks, typed-move parsing, replays.
- `board.js`: `renderBoard()`: squares, overlays drawn with `window.paint_path` and
  `PathBuilder` polygons, right-button drag handling, the promotion picker.
- `chess.js`: chess.js 1.4.0 (ESM build, vendored) for rules and SAN.
- `pieces/`: 12 cburnett SVGs, drawn with `image()`.
- Lichess: `/api/puzzle/daily`, `/api/puzzle/next`, `/api/tv/channels`,
  `/game/export/{id}`, `/api/account`, `/api/account/playing`, `/api/games/user/{name}`,
  `/api/board/seek`, `/api/board/game/stream/{id}`, `/api/board/game/{id}/move/{uci}`,
  `…/resign`, `…/abort`, `…/draw/{yes|no}`, `…/takeback/{yes|no}`.
- Websocket `wss://socket.lichess.org/watch/{id}/{color}/v6?sri=<random>`: `move`
  (`uci`, `san`, placement-only `fen`, `ply`, `clock`), `end`, `crowd`, `tvSelect`.
  Send `"null"` to keep it alive; it answers `"0"`.
- Herdr: `exec` (`sh`, `curl`, `kill`, `open`), `readTextFile`, `fs/promises`,
  `appHome()`, `theme()`, `settings()`, `layout()`, `localStorage`.

## Watch out

- **Lichess answers 403 without a `User-Agent`** on some endpoints (game export), and
  Herdr's `fetch` sends none. Always set one.
- `fetch` waits for the whole body and can't be cancelled, but seeks and the game stream
  are endless HTTP streams. Seeks run in `curl` under `sh` (its pid in a file; `kill`
  cancels; `-w '\n%{http_code}'` gives the status). The game stream runs in a
  background `curl` writing to `data/lichess/stream-<id>.ndjson`; a background process
  outlives `exec`. The token goes in a header file (`-H @file`): `exec` has no stdin or
  env, and an argument shows in `ps`. `fs.writeFile` can't set a mode, so make the folder
  `700` (`umask 077; mkdir -p; chmod 700`) before writing, `chmod 600` the file, and
  delete it a second after `curl` starts (it reads the file at once), plus in a `finally`.
- Exports of ongoing games lag a few moves for anti-cheating, and socket FENs are
  placement only. Track `ply`, apply socket moves by UCI when they're next in line, else
  load the placement with hand-tracked castling rights and en passant from the last move.
  The game stream's full UCI list is the truth; rebuild from it only when the stream
  itself changed, or an older line rolls back a move the socket already delivered.
- The Board API seeks people only at Rapid, Classical and Correspondence.
  `exec` caps at 10 minutes, so a search ends there.
- Never keep a `cx`; every timer, task and handler gets its own. Guard async results
  with the feed key or a generation counter so a stale load can't start a socket.
- gpui-kit has no occlusion: overlays don't stop clicks reaching squares, so ignore
  square clicks while the promotion picker is open.
- `positionKey` (FEN placement + side to move) keys arrows per position.

## Done when

- `herdr-app check mods/lichess` passes.
- Puzzle shows the daily puzzle; a right move gets a reply, a wrong one is refused.
- TV shows a live game whose board and clocks change within seconds, and the watcher count.
- With a `board:play` token: the grid finds a 10+0 game and opens it; Cancel stops a
  search; moves made by clicking and by typing reach Lichess; the opponent's moves
  arrive live; a promotion offers four pieces; draw and takeback offers show and can be
  answered.
- Recent games list +/−/= with rating changes; opening one steps through every move.
- Right-drag draws an arrow; left-click clears it.
- Hiding the panel closes the socket and the stream `curl` (`pgrep -fl board/game/stream`).
