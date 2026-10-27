/** The zoom of the slice: scale 1 is fit, ox/oy the image pixel at the canvas's top-left. The one transform for drawing and clicks. */
export type View = { scale: number; ox: number; oy: number };
/** The canvas on screen (w, h in css px) and the image it shows (cols, rows). The image fills the canvas at scale 1. */
export type Size = { w: number; h: number; cols: number; rows: number };
export type Rect = { x0: number; y0: number; x1: number; y1: number };

export const MIN_SCALE = 1, MAX_SCALE = 8, STEP = 1.25;

export const fitView = (): View => ({ scale: 1, ox: 0, oy: 0 });

/** Image pixels per screen pixel at this scale. */
const k = (v: View, s: Size) => s.cols / (s.w * v.scale);

/** No empty margin beyond the image, scale within 1..8. */
export function clampView(v: View, s: Size): View {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale));
  const ox = Math.min(s.cols - s.cols / scale, Math.max(0, v.ox));
  const oy = Math.min(s.rows - s.rows / scale, Math.max(0, v.oy));
  return { scale, ox, oy };
}

export function screenToImage(v: View, sx: number, sy: number, s: Size) {
  return { x: v.ox + sx * k(v, s), y: v.oy + sy * k(v, s) * (s.rows / s.cols) * (s.w / s.h) };
}

export function imageToScreen(v: View, ix: number, iy: number, s: Size) {
  return { x: (ix - v.ox) / k(v, s), y: (iy - v.oy) / (k(v, s) * (s.rows / s.cols) * (s.w / s.h)) };
}

/** Zooms by `factor`, keeping the image point under screen (px, py) where it is. */
export function zoomAt(v: View, factor: number, px: number, py: number, s: Size): View {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
  const p = screenToImage(v, px, py, s);
  const next = { ...v, scale };
  const q = screenToImage({ ...next, ox: 0, oy: 0 }, px, py, s); // offset of the point from the new view's origin
  return clampView({ scale, ox: p.x - q.x, oy: p.y - q.y }, s);
}

/** The dragged screen rectangle fills the canvas (aspect kept: the longer side decides), centred on the rectangle. */
export function zoomToRect(v: View, r: Rect, s: Size): View {
  const [w, h] = [Math.abs(r.x1 - r.x0), Math.abs(r.y1 - r.y0)];
  if (w < 1 || h < 1) return v;
  const a = screenToImage(v, (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, s);
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * Math.min(s.w / w, s.h / h)));
  return centreOn({ ...v, scale }, a.x, a.y, s);
}

/** The image point (ix, iy) in the middle of the canvas, as near as the image edges allow; the scale stays. */
export const centreOn = (v: View, ix: number, iy: number, s: Size): View => clampView({ scale: v.scale, ox: ix - s.cols / v.scale / 2, oy: iy - s.rows / v.scale / 2 }, s);

/** Zoom factor of one Ctrl+wheel / pinch event: smooth on a trackpad, bigger per mouse notch. */
export const wheelFactor = (deltaY: number, deltaMode = 0) => Math.exp(-Math.max(-20, Math.min(20, deltaY * (deltaMode === 1 ? 16 : 1))) * 0.01); // deltaMode 1: lines (Firefox) // a 100 px mouse notch counts as 20: about x1.22

/** One log post per wheel gesture: `note` after each event, the post `ms` after the last one, with the scan and scale captured then. None if the scale ended where it began. `flush` posts a pending gesture now. */
export function gestureLog(post: (scan: string, scale: number) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  let pending: { scan: string; scale: number; start: number } | undefined;
  const flush = () => {
    clearTimeout(t); t = undefined;
    const p = pending; pending = undefined;
    if (p && p.scale !== p.start) post(p.scan, p.scale);
  };
  const note = (scan: string, scale: number, before: number) => {
    pending = { scan, scale, start: pending?.start ?? before };
    clearTimeout(t); t = setTimeout(flush, ms);
  };
  return { note, flush };
}

/** The view dragged by the screen move (sx0, sy0) to (sx, sy): the image point first under (sx0, sy0) ends under (sx, sy). */
export function panBy(v: View, sx0: number, sy0: number, sx: number, sy: number, s: Size): View {
  const a = screenToImage(v, sx0, sy0, s), b = screenToImage(v, sx, sy, s);
  return clampView({ scale: v.scale, ox: v.ox - (b.x - a.x), oy: v.oy - (b.y - a.y) }, s);
}
