import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getSlice as getSliceApi, postEvent as postEventApi, type Outline, type Pt, type ScanMeta } from "./api";
import { addPoint, aimedHere, axisLabels, edgePixels, imageInput, lineMm, loadingCue, nearestEnd, sliceLabel, upLabel, stepZ, toVoxel, unpackMask, wheelNotches, wheelStep, windowToRGBA, zOfImage } from "./image";
import { sliceQueue, wishes } from "./slices";
import { MAX_SCALE, STEP, centreOn, fitView, gestureLog, imageToScreen, panBy, screenToImage, wheelFactor, zoomAt, zoomToRect, type Rect, type Size, type View } from "./view";

type Props = { scan: ScanMeta; z: number; onZ: (z: number) => void; outline?: Outline; pending: boolean; onPick: (p: { y: number; x: number; shift: boolean }) => void; caption?: string[];
  load?: (id: string, z: number, signal?: AbortSignal) => Promise<Int16Array>; target?: { z: number; y: number; x: number; label?: string }; // load: another slice source (the Demo, which also sends no events); target: a ring on the spot to click (with a label: a follow-up proposal, in yellow)
  brush?: { radius: number; erase: boolean }; onStroke?: (z: number, points: Pt[]) => void; // brush: Paint or Erase on an open outline, so a press paints instead of clicking; one stroke is sent on release
  onAxes?: (long: [Pt, Pt], short: [Pt, Pt]) => void }; // Axes mode on an open outline: a press is never a click; the axis ends on axis_z have handles, and a real drag of one sends both lines
/** A brush stroke on slice z, or a grabbed axis end (line 0 long, 1 short) now at `at`; sent: released and waiting for the engine, still drawn. */
type Gesture = ({ kind: "paint"; z: number; pts: Pt[] } | { kind: "axis"; line: 0 | 1; end: 0 | 1; from: Pt; sx: number; sy: number; at: Pt; moved: boolean }) & { sent?: boolean };
const HANDLE_PX = 8; // a press this close to an axis end grabs it
/** The outline's lines with the grabbed end moved, and that line's length in mm. */
function withEnd(o: Outline, g: Extract<Gesture, { kind: "axis" }>, spacing: number[]): Outline {
  const key = g.line ? "short" : "long", line = [...o[`${key}_line`]!] as [Pt, Pt];
  line[g.end] = g.at;
  return { ...o, [`${key}_line`]: line, [`${key}_mm`]: lineMm(line, spacing) };
}
/** Breaks a line at spaces so each piece fits `max` px (a single word wider than that stays whole). */
function wrap(g: CanvasRenderingContext2D, line: string, max: number) {
  const out: string[] = [];
  let cur = "";
  for (const w of line.split(" ")) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && g.measureText(next).width > max) { out.push(cur); cur = w; } else cur = next;
  }
  return [...out, cur];
}
const HALO = "rgba(0,0,0,0.7)", HALO_RGBA = [0, 0, 0, 178]; // the thin dark edge under every overlay
export type SliceViewHandle = { toPNG: () => Promise<Blob>; centre: (y: number, x: number) => void }; // centre: that voxel to the middle of the view, zoom unchanged

export const SliceView = forwardRef<SliceViewHandle, Props>(function SliceView({ scan, z, onZ, outline, pending, onPick, caption = [], load, target, brush, onStroke, onAxes }, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const queues = useRef(new Map<string, ReturnType<typeof sliceQueue>>()); // by scan; both callers remount the view on a scan change, so it holds one
  const onCanvas = useRef<{ scan: string; z: number }>(); // the slice on the canvas
  const [shownZ, setShownZ] = useState<number>(); // the same z, for the render: overlays and input wait until it is the indicator's z
  useEffect(() => () => queues.current.forEach((q) => q.stop()), []); // unmounted (also a scan change): nothing keeps downloading
  const [depth, rows, cols] = scan.shape;
  const inst = scan.instance_numbers;
  const getSlice = load ?? getSliceApi;
  const postEvent = load ? () => {} : postEventApi;
  const [failed, setFailed] = useState<number>();
  const box = useRef<HTMLDivElement>(null);
  const marks = useRef<HTMLCanvasElement>(null);
  // The view survives a slice change; a new scan starts at Fit.
  const [view, setView] = useState<View>(fitView);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [areaMode, setAreaMode] = useState(false);
  const [drag, setDrag] = useState<Rect>();
  const [resized, setResized] = useState(0);
  const [space, setSpace] = useState(false); // Space held: drags pan
  const spaceRef = useRef(false);
  const [panning, setPanning] = useState(false);
  const pan = useRef({ x: 0, y: 0, view: fitView() });
  const hover = useRef(false); // the pointer is over the image: Space pans only then
  const poster = useRef<ReturnType<typeof gestureLog>>();
  poster.current ??= gestureLog((id, scale) => postEvent({ action: "zoom", scan: id, scale }), 500);
  useEffect(() => () => poster.current!.flush(), []);
  const [ring, setRing] = useState<{ z: number; y: number; x: number }>(); // where the click went while the engine works on it
  const [gesture, setGesture] = useState<Gesture>();
  const gestureRef = useRef<Gesture>();
  const put = (g?: Gesture) => { gestureRef.current = g; setGesture(g); };
  useEffect(() => { if (!pending) { setRing(undefined); put(undefined); } }, [pending]); // the engine's answer replaces the local preview
  const [hoverPx, setHoverPx] = useState<{ y: number; x: number }>(); // the pixel under the pointer: the brush ring's centre
  const [overHandle, setOverHandle] = useState(false);
  useEffect(() => { if (!brush) setHoverPx(undefined); }, [!!brush]); // the ring starts where the pointer next moves
  const latestProps = useRef({ brush, onStroke, onAxes, outline });
  latestProps.current = { brush, onStroke, onAxes, outline };
  const toolPress = useRef(false); // the press began a pan or a zoom-area drag: its click must not start a nodule, whatever ended the tool
  const pressZ = useRef<number>(); // the slice the indicator named at the press: a click on release counts only on that slice
  useEffect(() => { poster.current!.flush(); setView(fitView()); setAreaMode(false); setDrag(undefined); }, [scan]);
  useEffect(() => { // the viewer measures 0 x 0 while a hosted tab hides it: redraw the marks when it is shown again
    const f = () => setResized((n) => n + 1);
    window.addEventListener("resize", f);
    const ro = new ResizeObserver(f);
    ro.observe(box.current!);
    return () => { window.removeEventListener("resize", f); ro.disconnect(); };
  }, []);
  const sizeNow = (): Size => { const r = box.current!.getBoundingClientRect(); return { w: r.width, h: r.height, cols, rows }; };
  const event = (action: "zoom" | "zoom_fit" | "zoom_area", scale?: number) => (poster.current!.flush(), postEvent({ action, scan: scan.id, ...(scale === undefined ? {} : { scale }) }));
  const zoomBy = (factor: number) => {
    const s = sizeNow(), v = zoomAt(viewRef.current, factor, s.w / 2, s.h / 2, s);
    if (v.scale === viewRef.current.scale) return; // at a limit
    setView(v); event("zoom", v.scale);
  };
  const fit = () => { setView(fitView()); event("zoom_fit"); };

  const zRef = useRef(z), scanRef = useRef(scan.id);
  zRef.current = z; scanRef.current = scan.id;
  /** The fetched slice nearest the counter goes on the canvas when it is nearer than the one there: on a far server the image follows a scroll. */
  const show = (id: string) => {
    const q = queues.current.get(id), c = canvas.current, at = zRef.current, k = q?.nearest(at), s = onCanvas.current;
    if (!q || !c || k === undefined || id !== scanRef.current || (s?.scan === id && Math.abs(s.z - at) <= Math.abs(k - at))) return;
    c.getContext("2d")!.putImageData(new ImageData(windowToRGBA(q.have.get(k)!), cols, rows), 0, 0);
    c.dataset.z = String(k); // the slice on the canvas (the counter changes before the image arrives)
    onCanvas.current = { scan: id, z: k };
    setShownZ(k);
  };
  const queueFor = (id: string) => {
    let q = queues.current.get(id);
    if (!q) queues.current.set(id, (q = sliceQueue((k, signal) => getSlice(id, k, signal), () => show(id), (k) => { if (id === scanRef.current && k === zRef.current) setFailed(k); })));
    return q;
  };
  const from = useRef(z); // the slice before this one: which way the scroll goes
  useLayoutEffect(() => { // before the browser paints: a slice already fetched shows at once, with no cue in between
    setFailed(undefined);
    queueFor(scan.id).want(wishes(z, from.current, depth));
    from.current = z;
    show(scan.id);
  }, [scan, z]);

  const voxels = useMemo(() => (outline?.bbox && outline.mask ? unpackMask(outline.mask, outline.bbox) : undefined), [outline]);

  // The outline's fill sits on a canvas of the image's size that moves with the image.
  useEffect(() => {
    const g = overlay.current!.getContext("2d")!;
    g.clearRect(0, 0, cols, rows);
    const b = outline?.bbox;
    if (outline && b && voxels && z >= b[0] && z < b[3]) drawFill(g, b, voxels, z);
  }, [outline, voxels, z, scan]);

  // Axis lines, labels and click markers are drawn on screen through the view, so they keep their size at any zoom.
  useEffect(() => {
    const c = marks.current!, s = sizeNow(), dpr = window.devicePixelRatio || 1;
    const [w, h] = [Math.round(s.w * dpr), Math.round(s.h * dpr)];
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } // resizing clears and costs; otherwise clear by hand
    const g = c.getContext("2d")!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const at = (y: number, x: number): [number, number] => { const p = imageToScreen(view, x + 0.5, y + 0.5, s); return [p.x, p.y]; };
    const px = (s.w * view.scale) / cols; // screen px per image pixel
    if (gesture?.kind === "paint" && gesture.z === z && brush) { // the stroke so far, until the engine answers
      const r = (brush.radius + 0.5) * px, pts = gesture.pts.map(([y, x]) => at(y, x));
      g.fillStyle = g.strokeStyle = brush.erase ? "rgba(239,68,68,0.45)" : "rgba(255,220,0,0.4)";
      g.beginPath();
      if (pts.length === 1) { g.arc(...pts[0], r, 0, 2 * Math.PI); g.fill(); }
      else { g.lineWidth = 2 * r; g.lineCap = g.lineJoin = "round"; g.moveTo(...pts[0]); for (const p of pts) g.lineTo(...p); g.stroke(); }
    }
    const lines = outline && gesture?.kind === "axis" && gesture.moved ? withEnd(outline, gesture, scan.spacing) : outline; // a dragged end shows its line and length live
    if (lines && z === lines.axis_z) drawLines(g, lines, at, [s.w, s.h]);
    if (lines && z === lines.axis_z && onAxes && !pending) // a handle on each axis end: a hollow ring in the line's colour, so the outline under it stays visible
      for (const [line, colour] of [[lines.long_line, "#ff4fd8"], [lines.short_line, "#40c0ff"]] as const)
        for (const p of line ?? []) for (const [col, w] of [[HALO, 3.5], [colour, 1.5]] as const) { g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.arc(...at(...p), 4, 0, 2 * Math.PI); g.stroke(); }
    g.font = "bold 20px system-ui";
    g.textAlign = "center";
    g.textBaseline = "middle";
    for (const m of outline?.clicks ?? []) {
      if (m.z !== z) continue;
      const [mark, p] = [m.positive ? "+" : "−", at(m.y, m.x)];
      g.strokeStyle = HALO; g.lineWidth = 3; g.lineJoin = "round"; g.strokeText(mark, ...p);
      g.fillStyle = m.positive ? "#22c55e" : "#ef4444";
      g.fillText(mark, ...p);
    }
    if (pending && ring?.z === z) { // a dashed ring round the click until the outline comes back
      const [px, py] = at(ring.y, ring.x);
      for (const [col, w, dash] of [[HALO, 3.5, []], ["rgba(235,235,235,0.8)", 1.5, [5, 5]]] as const) { g.strokeStyle = col; g.lineWidth = w; g.setLineDash(dash); g.beginPath(); g.arc(px, py, 18, 0, 2 * Math.PI); g.stroke(); }
      g.setLineDash([]);
    }
    c.dataset.ring = "";
    if (brush && hoverPx && !space && !areaMode && !overHandle) { // the brush ring: what a press here paints (dashed: erases)
      const [cx, cy] = at(hoverPx.y, hoverPx.x), r = (brush.radius + 0.5) * px;
      c.dataset.ring = JSON.stringify([cx, cy, r]);
      for (const [col, w] of [[HALO, 3], ["rgba(255,255,255,0.9)", 1.5]] as const) { g.strokeStyle = col; g.lineWidth = w; g.setLineDash(brush.erase ? [4, 3] : []); g.beginPath(); g.arc(cx, cy, r, 0, 2 * Math.PI); g.stroke(); }
      g.setLineDash([]);
    }
    c.dataset.target = "";
    if (target && target.z === z) { // two rings, dark under white (yellow for a proposal), distinct from the + and - marks
      const [px, py] = at(target.y, target.x), fg = target.label ? "#ffdc00" : "#fff";
      c.dataset.target = JSON.stringify([px, py]);
      for (const [r, col, w] of [[16, HALO, 5], [16, fg, 2], [6, HALO, 4], [6, fg, 1.5]] as const) { g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.arc(px, py, r, 0, 2 * Math.PI); g.stroke(); }
      if (target.label) { // the label up and right of the ring
        g.font = "bold 14px system-ui"; g.textAlign = "start"; g.textBaseline = "alphabetic"; g.lineWidth = 3; g.lineJoin = "round";
        g.strokeStyle = HALO; g.strokeText(target.label, px + 16, py - 16); g.fillStyle = fg; g.fillText(target.label, px + 16, py - 16);
      }
    }
  }, [outline, z, scan, view, resized, target, pending, ring, gesture, brush?.radius, brush?.erase, hoverPx, space, areaMode, overHandle, !!onAxes]);

  // The recorded slice at full resolution (outline and axis lines, no click marks) with a caption strip under it.
  useImperativeHandle(ref, () => ({
    centre(y: number, x: number) { setView(centreOn(viewRef.current, x + 0.5, y + 0.5, sizeNow())); },
    async toPNG() {
      const o = outline!, hu = queueFor(scan.id).have.get(o.axis_z!) ?? (await getSlice(scan.id, o.axis_z!));
      const layer = (draw: (g: CanvasRenderingContext2D) => void) => {
        const c = document.createElement("canvas");
        c.width = cols; c.height = rows;
        draw(c.getContext("2d")!);
        return c;
      };
      const style = (i: number) => (i < 2 ? { font: "18px system-ui", h: 24, colour: "#fff" } : { font: "14px system-ui", h: 20, colour: "#bbb" }); // the third line (width, research use) is smaller
      const measure = document.createElement("canvas").getContext("2d")!;
      const wrapped = caption.flatMap((line, i) => { measure.font = style(i).font; return wrap(measure, line, cols - 16).map((t) => ({ t, ...style(i) })); }); // no line wider than the image less a margin
      const strip = wrapped.reduce((h, l) => h + l.h, 12);
      const out = document.createElement("canvas");
      out.width = cols; out.height = rows + strip;
      const g = out.getContext("2d")!;
      g.drawImage(layer((t) => t.putImageData(new ImageData(windowToRGBA(hu), cols, rows), 0, 0)), 0, 0);
      g.drawImage(layer((t) => drawFill(t, o.bbox!, unpackMask(o.mask!, o.bbox!), o.axis_z!)), 0, 0);
      g.drawImage(layer((t) => drawLines(t, o, (y, x) => [x + 0.5, y + 0.5], [cols, rows])), 0, 0);
      g.fillStyle = "#000"; g.fillRect(0, rows, cols, strip);
      g.textAlign = "start"; g.textBaseline = "alphabetic";
      let y = rows;
      for (const l of wrapped) { y += l.h; g.font = l.font; g.fillStyle = l.colour; g.fillText(l.t, 8, y); }
      return new Promise<Blob>((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error("no image"))), "image/png"));
    },
  }));

  const drawFill = (g: CanvasRenderingContext2D, b: number[], voxels: Uint8Array, z: number) => {
    const [h, w] = [b[4] - b[1], b[5] - b[2]];
    const m = voxels.subarray((z - b[0]) * h * w, (z - b[0] + 1) * h * w);
    const edge = edgePixels(m, h, w);
    const img = g.createImageData(cols, rows);
    const at = (i: number) => 4 * ((b[1] + Math.floor(i / w)) * cols + b[2] + (i % w));
    for (let i = 0; i < m.length; i++) { // a thin dark edge just outside the outline, under it
      if (!edge[i]) continue;
      const [y, x] = [Math.floor(i / w), i % w];
      for (const [dy, dx] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const [ny, nx] = [y + dy, x + dx];
        if ((ny >= 0 && nx >= 0 && ny < h && nx < w && m[ny * w + nx]) || b[1] + ny < 0 || b[2] + nx < 0 || b[1] + ny >= rows || b[2] + nx >= cols) continue;
        img.data.set(HALO_RGBA, 4 * ((b[1] + ny) * cols + b[2] + nx));
      }
    }
    for (let i = 0; i < m.length; i++) {
      if (!m[i]) continue;
      img.data.set(edge[i] ? [255, 220, 0, 255] : [255, 220, 0, 64], at(i)); // solid edge, 25% fill
    }
    g.putImageData(img, 0, 0);
  };

  /** The two axis lines, then their mm labels on top (placed by axisLabels); `at` maps an image (y, x) to the canvas, sizes stay in canvas px. */
  const drawLines = (g: CanvasRenderingContext2D, outline: Outline, at: (y: number, x: number) => [number, number], size: [number, number]) => {
    const items = ([[outline.long_line, outline.long_mm, "#ff4fd8"], [outline.short_line, outline.short_mm, "#40c0ff"]] as const)
      .map(([line, mm, colour]) => ({ ends: line && ([at(...line[0]), at(...line[1])] as [[number, number], [number, number]]), text: `${mm.toFixed(1)} mm`, colour }));
    for (const { ends, colour } of items) if (ends) for (const halo of [true, false]) { // the dark edge first, about 1 px wider each side, then the colour
      g.strokeStyle = halo ? HALO : colour; g.lineWidth = halo ? 3.5 : 1.5;
      g.beginPath(); g.moveTo(...ends[0]); g.lineTo(...ends[1]); g.stroke();
    }
    g.font = "14px system-ui"; g.textAlign = "start"; g.textBaseline = "middle"; g.lineJoin = "round";
    const boxes = axisLabels(items[0].ends, items[1].ends, [[g.measureText(items[0].text).width, 14], [g.measureText(items[1].text).width, 14]], size);
    items.forEach(({ text, colour }, i) => {
      const b = boxes[i]; // undefined: it would touch the other label (the caption and the panel keep the number)
      if (b) { g.lineWidth = 3; g.strokeStyle = HALO; g.strokeText(text, b.x, b.y + b.h / 2); g.fillStyle = colour; g.fillText(text, b.x, b.y + b.h / 2); }
    });
  };

  // Wheel and arrows move one slice; the wheel listener is native because React's is passive.
  useEffect(() => {
    const move = (d: 1 | -1) => onZ(stepZ(zRef.current, inst, d, depth));
    let acc = 0;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey) { // pinch, or Ctrl + wheel
        const r = box.current!.getBoundingClientRect(), s = sizeNow();
        const v = zoomAt(viewRef.current, wheelFactor(e.deltaY, e.deltaMode), e.clientX - r.left, e.clientY - r.top, s);
        poster.current!.note(scan.id, v.scale, viewRef.current.scale);
        viewRef.current = v; setView(v); // the ref now, so events in the same frame build on each other
        return;
      }
      const mode = e.deltaMode; // read first: Firefox reports a mouse wheel in lines only when deltaMode is read before the deltas
      // macOS turns a mouse wheel with Shift held into horizontal scroll (deltaX), so Shift + wheel still scrolls
      const x = !e.deltaY && e.shiftKey, d = x ? e.deltaX : e.deltaY;
      const notches = wheelNotches(d, mode, (e as WheelEvent & { wheelDeltaX?: number; wheelDeltaY?: number })[x ? "wheelDeltaX" : "wheelDeltaY"]);
      // a mouse: one notch is one image, whatever its pixel size; a trackpad: one image per 50 px, smooth
      const r = notches ? { steps: notches, acc: 0 } : wheelStep(acc, d, mode, innerHeight);
      acc = r.acc;
      let nz = zRef.current;
      for (let i = 0; i < Math.abs(r.steps); i++) nz = stepZ(nz, inst, r.steps > 0 ? 1 : -1, depth);
      if (r.steps && nz === zRef.current) acc = 0; // pinned at an end: drop the leftover
      else if (nz !== zRef.current) onZ(nz);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      if (!box.current?.offsetParent) return; // the hosted page's hidden Measure tab: the keys belong to the tab on screen
      if ((e.target as HTMLElement).closest("select, input, textarea")) return;
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : -1);
    };
    const c = canvas.current!;
    c.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("keydown", key);
    return () => { c.removeEventListener("wheel", wheel); window.removeEventListener("keydown", key); };
  }, [scan, onZ]);

  // Zoom keys. Same rule as the slice keys: not while typing in a form field.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest("select, textarea, dialog, input:not([type=range])")) return; // a focused slider still takes these keys
      if (!box.current?.offsetParent) return; // hidden (another hosted tab): not ours
      const k = e.key.toLowerCase();
      if (k === "+" || k === "=") zoomBy(STEP);
      else if (k === "-") zoomBy(1 / STEP);
      else if (k === "f") fit();
      else if (k === "z") { setAreaMode((m) => !m); setDrag(undefined); }
      else if (k === "escape") { setAreaMode(false); setDrag(undefined); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [scan]);

  // Space held means pan. It must not scroll the page or press a focused button, so keydown and keyup are both stopped.
  useEffect(() => {
    const typing = (e: KeyboardEvent) => !!(e.target as HTMLElement).closest("select, textarea, input:not([type=range])");
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && spaceRef.current) { e.preventDefault(); return; } // a pan holds Space, also when the pointer left the image
      if (e.code !== "Space" || typing(e) || !hover.current) return; // elsewhere Space keeps its normal job, e.g. pressing a focused button
      e.preventDefault();
      if (!e.repeat) { spaceRef.current = true; setSpace(true); }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || !spaceRef.current) return;
      e.preventDefault();
      spaceRef.current = false; setSpace(false);
    };
    const blur = () => { spaceRef.current = false; setSpace(false); setPanning(false); };
    window.addEventListener("keydown", down); window.addEventListener("keyup", up); window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", blur); };
  }, []);

  // A pan drag follows the mouse on window, so a release outside the image still ends it.
  useEffect(() => {
    if (!panning) return;
    const move = (e: MouseEvent) => {
      const r = box.current!.getBoundingClientRect(), a = pan.current;
      setView(panBy(a.view, a.x, a.y, e.clientX - r.left, e.clientY - r.top, sizeNow()));
    };
    const up = () => setPanning(false);
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [panning]);

  const local = (e: { clientX: number; clientY: number }) => { const r = box.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const pixel = (e: { clientX: number; clientY: number }) => toVoxel(e.clientX, e.clientY, box.current!.getBoundingClientRect(), cols, rows, viewRef.current); // the click's own mapping
  /** The axis end under the pointer, on axis_z of an open outline. */
  const handleAt = (e: { clientX: number; clientY: number }) => {
    const o = latestProps.current.outline;
    if (!latestProps.current.onAxes || !o || z !== o.axis_z || !o.long_line || !o.short_line) return null;
    const s = sizeNow(), p = local(e), sc = ([y, x]: Pt): [number, number] => { const q = imageToScreen(viewRef.current, x + 0.5, y + 0.5, s); return [q.x, q.y]; };
    return nearestEnd([o.long_line.map(sc), o.short_line.map(sc)], p.x, p.y, HANDLE_PX) as [0 | 1, 0 | 1] | null;
  };
  // A stroke or an axis drag follows the mouse on window, so a release outside the image still ends it.
  const live = !!gesture && !gesture.sent;
  /** The live gesture still acts on the image it was aimed at: a stroke on its slice, an axis drag on the largest slice. */
  const aimed = (g: Gesture) => aimedHere(g.kind === "paint" ? g.z : undefined, zRef.current, latestProps.current.outline?.axis_z);
  useEffect(() => { // the wheel, an arrow or the slider moved during a stroke or drag: cancelled, nothing is sent
    const g = gestureRef.current;
    if (g && !g.sent && !aimed(g)) put(undefined);
  }, [z]);
  useEffect(() => {
    if (!live) return;
    const move = (e: MouseEvent) => {
      const g = gestureRef.current;
      if (!g || g.sent) return;
      if (g.kind === "paint") { const v = pixel(e); if (v) put({ ...g, pts: addPoint(g.pts, [v.y, v.x]) }); return; }
      const p = local(e), s = sizeNow(), a = screenToImage(viewRef.current, g.sx, g.sy, s), b = screenToImage(viewRef.current, p.x, p.y, s);
      const r2 = (v: number) => Math.round(v * 100) / 100;
      put({ ...g, moved: g.moved || Math.hypot(p.x - g.sx, p.y - g.sy) >= 3, at: [r2(g.from[0] + b.y - a.y), r2(g.from[1] + b.x - a.x)] });
    };
    const up = () => {
      const g = gestureRef.current, { onStroke, onAxes, outline } = latestProps.current;
      if (!g || g.sent) return;
      if (!aimed(g)) { put(undefined); return; } // released after the slice changed, before the effect above ran
      // nothing to send: no pixel painted, a handle pressed without a drag, or an end dragged back where it was (the engine would mark unchanged axes hand-set)
      if (g.kind === "paint" ? !g.pts.length : !g.moved || (g.at[0] === g.from[0] && g.at[1] === g.from[1])) { put(undefined); return; }
      put({ ...g, sent: true });
      if (g.kind === "paint") onStroke?.(g.z, g.pts);
      else if (outline) { const o = withEnd(outline, g, scan.spacing); onAxes?.(o.long_line!, o.short_line!); }
    };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [live]);
  const release = (e: MouseEvent) => {
    if (!areaMode) return;
    const p = local(e), d = drag;
    setAreaMode(false); setDrag(undefined);
    if (!d || Math.abs(p.x - d.x0) < 4 || Math.abs(p.y - d.y0) < 4) return; // a release without a drag just leaves the mode
    const v = zoomToRect(viewRef.current, { ...d, x1: p.x, y1: p.y }, sizeNow());
    setView(v); event("zoom_area", v.scale);
  };
  const releaseRef = useRef(release);
  releaseRef.current = release;
  const dragging = areaMode && !!drag;
  useEffect(() => { // the area drag ends on a release anywhere
    if (!dragging) return;
    const up = (e: MouseEvent) => releaseRef.current(e);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, [dragging]);
  const lo = inst ? Math.min(...inst) : 1, hi = inst ? Math.max(...inst) : depth;
  const shown = (k: number) => (inst ? inst[k] : k + 1);
  const up = upLabel(scan.head_dir, inst); // "head ↑ / feet ↓": the rail's top end is the first word
  const [top, bottom] = up ? up.split(" / ").map((w) => w[0].toUpperCase() + w.slice(1, -2)) : ["", ""];
  const b = outline?.bbox, frac = (n: number) => (n - lo) / (hi - lo || 1);
  const band = b && [shown(b[0]), shown(b[3] - 1)].sort((p, q) => p - q).map(frac); // the outline's images on the rail, in yellow
  const kbd = (k: string, on = false) => <kbd className={on ? "k k-on" : "k"}>{k}</kbd>;
  // The picture is another slice than the indicator's (a far server catching up): the overlays belong to z, so they hide, and a click,
  // stroke or axis drag would be aimed on another image, so it does nothing. Pan and zoom still work.
  const cue = loadingCue(shownZ, z, inst);
  const input = imageInput({ cue, space, areaMode, tool: !!brush || !!onAxes, panning, dragging: gesture?.kind === "axis", overHandle, pending, axes: !!onAxes });

  return (
    <div className="m-slice">
      <div className="m-counter" aria-live="polite">
        <span className="count num">{sliceLabel(z, inst, depth)}</span>
        {up && <span className="small muted">{up}</span>}
        {outline && z === outline.axis_z && input.overlays && <span className="m-pill"><span className="dot" aria-hidden="true" />Largest slice</span>}
        {failed !== undefined && <span role="alert" className="small" style={{ color: "var(--warn)" }}>{`Could not load ${inst ? `image ${inst[failed]}` : `slice index ${failed + 1}`}. Scroll to retry.`}</span>}
      </div>
      <div className="m-stage">
        <div className="m-fit">
          <div style={{ position: "relative", width: `min(100cqw, calc(100cqh * ${cols / rows}))`, aspectRatio: `${cols} / ${rows}` }}>
            <div ref={box} data-testid="viewer" style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#000", userSelect: "none",
              cursor: input.cursor }}
              onMouseEnter={() => { hover.current = true; }} onMouseLeave={() => { hover.current = false; setHoverPx(undefined); setOverHandle(false); }}
              onMouseDown={(e) => {
                toolPress.current = input.toolPress; // Paint, Erase and Axes presses are never clicks, also while a request is pending, nor any press during the cue
                pressZ.current = z;
                if (space) { const p = local(e); pan.current = { x: p.x, y: p.y, view: viewRef.current }; setPanning(true); e.preventDefault(); return; }
                if (areaMode) { const p = local(e); setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y }); return; }
                if (e.button !== 0 || pending || cue) return;
                const h = handleAt(e), v = pixel(e);
                if (h) { // Axes mode, on a handle: a drag of that end
                  const p = local(e), [line, end] = h, at = outline![line ? "short_line" : "long_line"]![end];
                  put({ kind: "axis", line, end, from: at, sx: p.x, sy: p.y, at, moved: false });
                  e.preventDefault();
                } else if (brush) { put({ kind: "paint", z, pts: v ? [[v.y, v.x]] : [] }); e.preventDefault(); }
              }}
              onMouseMove={(e) => {
                if (areaMode && drag) { const p = local(e); setDrag({ ...drag, x1: p.x, y1: p.y }); }
                if (brush) { const v = pixel(e) ?? undefined; setHoverPx((h) => (h && v && h.y === v.y && h.x === v.x ? h : v)); }
                if (onAxes) { const on = !!handleAt(e); setOverHandle((o) => (o === on ? o : on)); }
              }}
              onClick={(e) => {
                if (spaceRef.current) return; // Space is for panning, never a click
                if (toolPress.current) { toolPress.current = false; return; }
                if (cue || !aimedHere(pressZ.current, z, undefined)) return; // the wheel moved while the button was down: aimed on another image
                const v = toVoxel(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect(), cols, rows, view);
                if (!v) return;
                if (!pending) setRing({ z, ...v });
                onPick({ ...v, shift: e.shiftKey });
              }}>
              <div style={{ position: "absolute", inset: 0, transformOrigin: "0 0", transform: `translate(${(-view.ox / cols) * view.scale * 100}%, ${(-view.oy / rows) * view.scale * 100}%) scale(${view.scale})`,
                imageRendering: view.scale > 1 ? "pixelated" : "auto" }}>
                <canvas ref={canvas} data-view={JSON.stringify(view)} width={cols} height={rows} aria-label="CT slice" style={{ width: "100%", height: "100%", display: "block" }} />
                <canvas ref={overlay} width={cols} height={rows} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", visibility: input.overlays ? undefined : "hidden" }} />
              </div>
              <canvas ref={marks} aria-label="Axis lines and click marks" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", visibility: input.overlays ? undefined : "hidden" }} />
              {cue && failed !== z && <span className="m-pill" style={{ position: "absolute", left: 8, top: 8, pointerEvents: "none" }}>{cue}</span>}
              {drag && <div style={{ position: "absolute", left: Math.min(drag.x0, drag.x1), top: Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0),
                border: "1.5px dashed var(--text)", outline: "2px solid rgba(0,0,0,0.6)", background: "rgba(255,255,255,0.07)", pointerEvents: "none" }} />}
            </div>
          </div>
        </div>
        <div className="m-rail">
          <span aria-hidden="true">{top}</span>
          <div className="m-track">
            {band && <div className="m-band" style={{ top: `calc(${band[0]} * (100% - 16px) + 3px)`, height: `calc(${band[1] - band[0]} * (100% - 16px) + 10px)` }} />}
            {/* min at the top: up on the screen is the lower image number, as the arrow keys go */}
            <input type="range" className="m-range" aria-label="Image slider" min={lo} max={hi} value={shown(z)}
              onChange={(e) => onZ(inst ? zOfImage(+e.target.value, inst) : +e.target.value - 1)} onPointerUp={(e) => e.currentTarget.blur()} />
          </div>
          <span aria-hidden="true">{bottom}</span>
        </div>
      </div>
      <div className="m-tools">
        {areaMode
          ? <span role="status" className="small">Zoom to area: drag a rectangle on the image. <span className="muted">{kbd("Esc")} cancels.</span></span>
          : <span className="small muted">{kbd("↑")}{kbd("↓")} or wheel: images · Ctrl+wheel or pinch: zoom · {kbd("Space")}+drag: pan</span>}
        <span className="grow" />
        <div className="m-zoom" role="toolbar" aria-label="Zoom tools">
          <button aria-pressed={areaMode} aria-label="Zoom to area (Z)" onClick={() => { setAreaMode(!areaMode); setDrag(undefined); }}>
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ marginRight: 6 }}><path d="M3 9V5a2 2 0 0 1 2-2h4M15 3h4a2 2 0 0 1 2 2v4M3 15v4a2 2 0 0 0 2 2h4" /><circle cx="15" cy="15" r="3.5" /><path d="M17.6 17.6L21 21" /></svg>
            Zoom to area{kbd("Z", areaMode)}</button>
          <span className="sep" aria-hidden="true" />
          <button onClick={() => zoomBy(1 / STEP)} disabled={view.scale <= 1} aria-label="Zoom out (−)">−{kbd("−")}</button>
          <output aria-live="off" aria-label="Zoom" className="num">{Math.round(view.scale * 100)} %</output>
          <button onClick={() => zoomBy(STEP)} disabled={view.scale >= MAX_SCALE} aria-label="Zoom in (+)">+{kbd("+")}</button>
          <span className="sep" aria-hidden="true" />
          <button onClick={fit} aria-label="Fit (F)">Fit{kbd("F")}</button>
        </div>
      </div>
    </div>
  );
});
