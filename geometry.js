'use strict';
// Shared by the main process and the pick overlay, so the size printed on the Record button is exactly
// the size ffmpeg is asked to record.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Geometry = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MIN = 16; // smallest recording side, in physical pixels

  // rel: rectangle in DIPs relative to the display's top-left. scale: the display's scale factor.
  // out: { w, h } of that monitor in physical pixels.
  // Returns the physical rectangle to record, relative to the monitor: inside it, even width and height
  // (H.264 needs even sizes), or null when it is too small.
  function toRecordRect(rel, scale, out) {
    let x = Math.round(rel.x * scale), y = Math.round(rel.y * scale);
    let r = Math.round((rel.x + rel.w) * scale), b = Math.round((rel.y + rel.h) * scale);
    x = Math.max(0, Math.min(x, out.w)); y = Math.max(0, Math.min(y, out.h));
    r = Math.max(0, Math.min(r, out.w)); b = Math.max(0, Math.min(b, out.h));
    let w = r - x, h = b - y;
    w -= w % 2; h -= h % 2;
    if (w < MIN || h < MIN) return null;
    return { x, y, w, h };
  }

  // The physical rectangle back in DIPs relative to the display (for drawing the border around it)
  function toDip(phys, scale) {
    return { x: phys.x / scale, y: phys.y / scale, w: phys.w / scale, h: phys.h / scale };
  }

  return { MIN, toRecordRect, toDip };
});
