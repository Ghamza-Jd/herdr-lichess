# herdr-lichess

A [Herdr](https://herdr.dev) mod: Lichess in a side panel. Solve the daily puzzle,
watch Lichess TV live, and play your own games: find an opponent from a
quick-pairing grid, move by clicking or typing, answer draw and takeback offers,
and step through your recent games. Right-drag on any board to draw arrows.

![Lichess](preview.png)

## Install

Ask your agent: *"add the Herdr mod at github.com/Ghamza-Jd/herdr-lichess"*.
Or by hand:

```sh
cp -r mods/lichess ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/lichess
```

The first time Herdr sees the folder it docks the panel on the right, 380px wide.
To place it yourself, add a block to your layout, for example as one more child of
a panel stack:

```json
{ "id": "lichess", "type": "block", "content": { "mod": "lichess" } }
```

The live feeds (TV, your game) only run while the block is on screen: hidden
columns and inactive stack children are left alone.

To play, open **Play** and paste a Lichess API token with the *Play games with the
board API* (`board:play`) scope. The panel has a button that opens the token page.

## What's in it

- **Puzzle**: the puzzle of the day or the next one. Click to move; the opponent
  replies by itself. Hint, promotion picker, theme tags.
- **TV**: Top rated, Bullet, Blitz, Rapid or Classical, with live moves, clocks and
  watcher count. Follows the channel to the next featured game.
- **Play**:
  - a quick-pairing grid (10+0, 10+5, 15+10, 30+0, 30+20, 3 days), rated or casual,
    with Cancel;
  - your ongoing games, with a "Your turn" badge;
  - a live board: click or type moves (`Nf3`, `O-O`, `e8=Q`, `e2e4`), promotion
    picker, resign, abort, draw and takeback offers both ways;
  - your last 10 finished games with **+** / **−** / **=** and rating change; open
    one to step through it (« ‹ › », clicking a move, or ←/→ and Home/End).
- **Arrows** on every board, as on Lichess: right-drag for an arrow, right-click for
  a circle, shift = red, alt = blue, shift+alt = yellow, left-click clears.

## What it reaches

- **Network**: `lichess.org` (the public API, and the Board API with your token), and
  `socket.lichess.org`, the websocket the Lichess site itself uses for live moves.
  That socket is public but not a documented API.
- **Programs**: `curl` for pairing and your game's event stream (both are endless
  HTTP streams that `fetch` can't read or cancel), `sh` and `kill` to run and stop
  them, and `open` for "Open on Lichess" links.
- **Files**: while you're seeking or in a game it writes to
  `~/.config/herdr-app/data/lichess/`: a header file with your token (made private
  at once and deleted within a second) and the game stream's output (deleted when you
  leave the game).
- **Your token** is kept in the panel's own storage, nowhere else.

Needs macOS (for `open`) and `curl`.

## Limits

- Lichess lets the Board API seek people only at Rapid, Classical and Correspondence,
  so the grid has no Bullet or Blitz.
- A search stops after 10 minutes (the longest Herdr lets a program run from a mod).
- Draw and takeback offers can take up to a second to appear; moves are instant.
- Standard chess only. Puzzle attempts aren't sent to Lichess, so your puzzle rating
  doesn't change.

## Credits

- Chess pieces: the *cburnett* set by Colin M.L. Burnett, as shipped by
  [Lichess](https://github.com/lichess-org/lila/tree/master/public/piece/cburnett),
  CC BY-SA 3.0.
- Chess rules: [chess.js](https://github.com/jhlywa/chess.js) 1.4.0 by Jeff Hlywa,
  BSD-2-Clause (vendored as `mods/lichess/chess.js`).
- Lichess is a free, open-source chess server by the Lichess team. This mod is
  unofficial and not affiliated with it.

Code: MIT. See [LICENSE](LICENSE).
