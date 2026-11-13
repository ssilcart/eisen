// A floating box that keeps the terminal's own background (a translucent
// terminal shows through it, like through the matrix) without letting the
// matrix underneath show through. OpenTUI 0.8.4 blends a fill whose alpha is
// 0, so a box with `backgroundColor: "transparent"` leaves the cells below
// as they were; setCell does not blend, so writing a space on a transparent
// background first clears each cell to "default background, no glyph", which
// the renderer emits as SGR 49 (verified in a real pty).
import { RGBA, type BoxRenderable } from "@opentui/core";

const CLEAR_BG = RGBA.fromValues(0, 0, 0, 0);
const CLEAR_FG = RGBA.fromValues(1, 1, 1, 1);

/** Makes `box` transparent and clears what is under it before it and its children draw. */
export function seeThrough(box: BoxRenderable): BoxRenderable {
  box.backgroundColor = "transparent";
  box.renderBefore = function (buffer) {
    const right = Math.min(this.x + this.width, buffer.width);
    const bottom = Math.min(this.y + this.height, buffer.height);
    for (let y = Math.max(0, this.y); y < bottom; y++) {
      for (let x = Math.max(0, this.x); x < right; x++) buffer.setCell(x, y, " ", CLEAR_FG, CLEAR_BG);
    }
  };
  return box;
}
