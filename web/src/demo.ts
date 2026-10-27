// The Demo: the same calls as api.ts, answered from the recorded files in /demo. Nothing here calls /api or localhost.
import type { Outline, ScanMeta, ScanRow } from "./api";
import { unpackMask } from "./image";

export type Step = { label: string; outline: Outline };
export type DemoIndex = { cases: { id: string }[]; engine_commit: string; note: string; attribution: string[] };
export const FAR = "In demo mode, click the marked spot: these are recorded results.";
export const NEEDS_ENGINE = 'Corrections and saving need your own engine: use "Use my local engine" in Measure.';

const json = async <T,>(url: string): Promise<T> => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
};
export const getIndex = () => json<DemoIndex>("/demo/index.json");
export const listScans = async (): Promise<ScanRow[]> =>
  (await getIndex()).cases.map(({ id }) => ({ id, patient: id.split("_")[0], series: id.split("_")[1] }));
export const getScan = (id: string) => json<ScanMeta>(`/demo/${id}/meta.json`);
const steps = new Map<string, Promise<Step[]>>();
export const getSteps = (id: string) => {
  if (!steps.has(id)) steps.set(id, json<{ steps: Step[] }>(`/demo/${id}/outline.json`).then((d) => d.steps));
  return steps.get(id)!;
};

/** The PNG holds the lung window (W1500/L-600) as 8-bit grey; this is its inverse, so the page's own window draws the same image. */
export const greyToHU = (g: number) => Math.round(-1350 + (g * 1500) / 255);
export async function getSlice(id: string, z: number): Promise<Int16Array> {
  const img = new Image();
  img.src = `/demo/${id}/slices/${z}.png`;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(img, 0, 0);
  const px = g.getImageData(0, 0, c.width, c.height).data;
  const out = new Int16Array(c.width * c.height);
  for (let i = 0; i < out.length; i++) out[i] = greyToHU(px[4 * i]);
  return out;
}

type Vox = { z: number; y: number; x: number };
/** A click counts when it is inside the recorded outline or within 10 voxels of the recorded click. */
export function hitsRecorded(o: Outline, p: Vox): boolean {
  const c = o.clicks[0];
  if (Math.hypot(c.z - p.z, c.y - p.y, c.x - p.x) <= 10) return true;
  const b = o.bbox;
  if (!b || !o.mask || p.z < b[0] || p.z >= b[3] || p.y < b[1] || p.y >= b[4] || p.x < b[2] || p.x >= b[5]) return false;
  return !!unpackMask(o.mask, b)[((p.z - b[0]) * (b[4] - b[1]) + (p.y - b[1])) * (b[5] - b[2]) + (p.x - b[2])];
}
export async function startNodule(id: string, p: Vox): Promise<Outline> {
  const first = (await getSteps(id))[0].outline;
  if (!hitsRecorded(first, p)) throw new Error(FAR);
  return first;
}
export const correct = async (): Promise<Outline> => { throw new Error(NEEDS_ENGINE); };
export const undo = correct;
export const record = correct;
