// Draws a chess board: Lichess's brown squares, last move, selection, legal targets, check,
// and Lichess-style annotations: right-drag draws an arrow, right-click circles a square
// (shift: red, alt: blue, shift+alt: yellow), a left click clears them.
import { div, image, PathBuilder } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";

const LIGHT = "#f0d9b5", DARK = "#b58863";
const LAST = ["#cdd26a", "#aaa23a"];
const SELECTED = ["#829769", "#646e40"];
const HINT = ["#9ab8d6", "#7a95b3"];
const CHECK = ["#f08a76", "#d3624c"];
const PREMOVE = ["#827b85", "#645974"]; // Lichess's rgba(20,30,85,.5) over the squares
const FILES = "abcdefgh";
const BRUSH = { green: "#15781bcc", red: "#882020cc", blue: "#003088cc", yellow: "#e68f00cc" };

const brushFor = (m) => (m?.shift && m?.alt ? "yellow" : m?.shift ? "red" : m?.alt ? "blue" : "green");

// Annotations belong to a position, so they stay with it when stepping through a game
// and disappear once a move is played.
const positionKey = (chess) => chess.fen().split(" ").slice(0, 2).join(" ");

function toggleShape(model, shape) {
  const key = positionKey(model.chess);
  model.shapes ??= {};
  const list = model.shapes[key] ?? [];
  const same = list.findIndex((x) => x.from === shape.from && x.to === shape.to);
  if (same >= 0 && list[same].brush === shape.brush) list.splice(same, 1);
  else if (same >= 0) list[same] = shape;
  else list.push(shape);
  model.shapes[key] = list;
}

function arrowPath(x1, y1, x2, y2, s) {
  const len = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / len, uy = (y2 - y1) / len;
  const nx = -uy, ny = ux;
  const shaft = s * 0.15, head = s * 0.42, headLen = s * 0.4;
  const tipX = x2 - ux * s * 0.08, tipY = y2 - uy * s * 0.08; // stop just short of the centre
  const sx = x1 + ux * s * 0.18, sy = y1 + uy * s * 0.18; // start a little off the centre
  const bx = tipX - ux * headLen, by = tipY - uy * headLen;
  return PathBuilder.fill().add_polygon([
    [sx + nx * shaft / 2, sy + ny * shaft / 2], [bx + nx * shaft / 2, by + ny * shaft / 2],
    [bx + nx * head / 2, by + ny * head / 2], [tipX, tipY],
    [bx - nx * head / 2, by - ny * head / 2], [bx - nx * shaft / 2, by - ny * shaft / 2],
    [sx - nx * shaft / 2, sy - ny * shaft / 2],
  ], true).build();
}

/**
 * @param {object} o
 * @param {string} o.id unique prefix for element ids
 * @param {any} o.model { chess, last, sel, targets, premove?, shapes?, drawing? }
 * @param {"white"|"black"} o.orientation side at the bottom
 * @param {number} o.size board width in px
 * @param {string|null} [o.hint] square to highlight
 * @param {((sq: string, cx: any) => void) | null} [o.onSquare]
 * @param {((piece: string, cx: any) => void) | null} [o.onPromote] called with q/n/r/b while `model.promo` is set
 */
export function renderBoard({ id, model, orientation, size, hint = null, onSquare = null, onPromote = null }) {
  const s = Math.floor(size / 8);
  const { chess, last, sel, targets } = model;
  const pre = model.premove;
  let checkSq = null;
  if (chess.inCheck()) {
    for (const row of chess.board()) for (const p of row) if (p?.type === "k" && p.color === chess.turn()) checkSq = p.square;
  }
  const ranks = orientation === "white" ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
  const files = orientation === "white" ? [...FILES] : [...FILES].reverse();
  const center = (sq) => [(files.indexOf(sq[0]) + 0.5) * s, (ranks.indexOf(+sq[1]) + 0.5) * s];
  const squareAt = (p) => {
    if (!p) return null;
    const col = Math.floor(p.x / s), row = Math.floor(p.y / s);
    return col >= 0 && col < 8 && row >= 0 && row < 8 ? files[col] + ranks[row] : null;
  };
  const local = (e) => e.local_position ?? (e.bounds ? { x: e.position.x - e.bounds.x, y: e.position.y - e.bounds.y } : null);

  const square = (f, r) => {
    const sq = f + r;
    const isLight = (FILES.indexOf(f) + r) % 2 === 0; // a1 is dark
    const pick = (pair) => pair[isLight ? 0 : 1];
    const bg = sq === sel ? pick(SELECTED) : sq === checkSq ? pick(CHECK)
      : pre && (sq === pre.from || sq === pre.to) ? pick(PREMOVE) : sq === hint ? pick(HINT)
      : last && (sq === last[0] || sq === last[1]) ? pick(LAST) : isLight ? LIGHT : DARK;
    const piece = chess.get(sq);
    const coord = isLight ? DARK : LIGHT;
    let el = div().id(`${id}-${sq}`).relative().size(s).flex_none().bg(bg);
    if (piece) el = el.child(image(`mods/lichess/pieces/${piece.color}${piece.type.toUpperCase()}.svg`).size(s));
    if (f === files[0]) el = el.child(div().absolute().top(1).left(2).text_size(Math.max(8, s * 0.2)).text_color(coord).font_semibold().child(String(r)));
    if (r === ranks[7]) el = el.child(div().absolute().bottom(0).right(2).text_size(Math.max(8, s * 0.2)).text_color(coord).font_semibold().child(f));
    if (targets.includes(sq)) {
      el = piece
        ? el.child(div().absolute().top(0).left(0).size(s).rounded_full().border(Math.max(2, s * 0.08)).border_color("#14551e80"))
        : el.child(div().absolute().top(s * 0.36).left(s * 0.36).size(s * 0.28).rounded_full().bg("#14551e80"));
    }
    if (onSquare) el = el.cursor_pointer().on_click((_e, cx) => onSquare(sq, cx));
    return el;
  };

  // Annotations of this position, plus the arrow being dragged.
  const shapes = [...(model.shapes?.[positionKey(chess)] ?? [])];
  const d = model.drawing;
  if (d && d.to && d.to !== d.from) shapes.push(d);
  const overlays = shapes.map((sh, i) => {
    const [x1, y1] = center(sh.from);
    if (!sh.to || sh.to === sh.from) {
      const w = Math.max(2, s * 0.07);
      return div().absolute().top(y1 - s / 2 + w / 2).left(x1 - s / 2 + w / 2).size(s - w).rounded_full()
        .border(w).border_color(BRUSH[sh.brush]);
    }
    const [x2, y2] = center(sh.to);
    return window.paint_path(arrowPath(x1, y1, x2, y2, s), BRUSH[sh.brush]).absolute().top(0).left(0).size_full();
  });

  return v_flex().id(`${id}-board`).relative().flex_none().w(s * 8).h(s * 8).rounded(4).overflow_hidden()
    .on_mouse_down("right", (e, cx) => {
      const sq = squareAt(local(e));
      if (sq) { model.drawing = { from: sq, to: sq, brush: brushFor(e.modifiers) }; cx.notify(); }
      cx.stop_propagation();
    })
    .on_mouse_move((e, cx) => {
      const dr = model.drawing;
      if (!dr) return;
      const sq = squareAt(local(e)) ?? dr.to;
      if (sq !== dr.to) { dr.to = sq; cx.notify(); }
    })
    .on_mouse_up("right", (e, cx) => {
      const dr = model.drawing;
      if (!dr) return;
      model.drawing = null;
      toggleShape(model, { from: dr.from, to: squareAt(local(e)) ?? dr.to, brush: dr.brush });
      cx.notify(); cx.stop_propagation();
    })
    .on_mouse_down("left", (_e, cx) => {
      model.drawing = null;
      const list = model.shapes?.[positionKey(chess)];
      if (list?.length) { list.length = 0; cx.notify(); }
    })
    .children(ranks.map((r) => h_flex().id(`${id}-r${r}`).children(files.map((f) => square(f, r)))))
    .children(overlays)
    .when(Boolean(model.promo && onPromote), (el) => el.child(promotionPicker(id, model, s, files, ranks, onPromote)));
}

// Lichess's picker: queen, knight, rook, bishop stacked from the promotion square toward the
// middle of the board, over a dimmed board. Clicking elsewhere cancels.
function promotionPicker(id, model, s, files, ranks, onPromote) {
  const { to } = model.promo;
  const color = to[1] === "8" ? "w" : "b";
  const col = files.indexOf(to[0]), row = ranks.indexOf(+to[1]);
  const dir = row === 0 ? 1 : -1;
  return div().id(`${id}-promo`).absolute().top(0).left(0).size_full().bg("#00000059")
    .on_click((_e, cx) => { model.promo = null; cx.notify(); })
    .children(["q", "n", "r", "b"].map((p, i) => div().id(`${id}-promo-${p}`).absolute()
      .top((row + dir * i) * s).left(col * s).size(s).rounded_full().bg("#c8c8c8").cursor_pointer()
      .hover((st) => st.bg("#f2f2f2"))
      .on_click((_e, cx) => { cx.stop_propagation(); onPromote(p, cx); })
      .child(image(`mods/lichess/pieces/${color}${p.toUpperCase()}.svg`).size(s))));
}
