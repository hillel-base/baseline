import { useEffect, useState } from "react";
import type { Outline, ScanMeta, ScanRow } from "./api";
import { NEEDS_ENGINE, correct, getIndex, getScan, getSlice, getSteps, listScans, startNodule, type DemoIndex, type Step } from "./demo";
import { Panel } from "./Panel";
import { SliceView } from "./SliceView";

const SIZES = ["small", "medium", "large"]; // the recorded cases, in volume order

/** The Demo tab: recorded results replayed through the same viewer and panel as Measure. Nothing here needs the engine. */
export function DemoView() {
  const [index, setIndex] = useState<DemoIndex>();
  const [cases, setCases] = useState<ScanRow[]>();
  const [failed, setFailed] = useState(false);
  const [scan, setScan] = useState<ScanMeta>();
  const [steps, setSteps] = useState<Step[]>();
  const [z, setZ] = useState(0);
  const [started, setStarted] = useState(false);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string>();
  useEffect(() => { Promise.all([getIndex(), listScans()]).then(([i, c]) => { setIndex(i); setCases(c); }, () => setFailed(true)); }, []);

  const open = (id: string) => {
    setScan(undefined); setSteps(undefined); setStarted(false); setStep(0); setError(undefined);
    if (!id) return;
    Promise.all([getScan(id), getSteps(id)]).then(([s, st]) => { setScan(s); setSteps(st); setZ(st[0].outline.clicks[0].z); }, () => setFailed(true));
  };
  const first = steps?.[0].outline.clicks[0];
  const outline: Outline | undefined = started ? steps?.[step].outline : undefined;
  const pick = ({ y, x }: { y: number; x: number }) => {
    if (!scan) return;
    (started ? correct() : startNodule(scan.id, { z, y, x })).then(
      () => { setStarted(true); setError(undefined); },
      (e) => setError(e.message),
    );
  };
  return (
    <div>
      <p className="shell-status warn" role="status">Demo: recorded results on development cases, not a live model.</p>
      {failed ? <p role="alert">Could not read the demo files.</p> : (
        <>
          <label>Case{" "}
            <select defaultValue="" onChange={(e) => open(e.target.value)} disabled={!cases}>
              <option value="">Choose a case</option>
              {cases?.map((c, i) => <option key={c.id} value={c.id}>{SIZES[i] ?? `case ${i + 1}`} ({c.id})</option>)}
            </select>
          </label>
          {scan && steps && (
            <div style={{ display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 560px", height: "min(calc(100vh - 200px), 760px)", display: "flex", background: "var(--bg-viewer)" }}>{/* the viewer fits the image to this box */}
                <SliceView scan={scan} z={z} onZ={setZ} outline={outline} pending={false} onPick={pick} load={getSlice} target={started ? undefined : first} />
              </div>
              <div style={{ flex: "1 1 260px" }}>
                <Panel outline={outline} pending={false} error={error} instanceNumbers={scan.instance_numbers} demo={NEEDS_ENGINE}
                  onGoToAxisSlice={() => outline?.axis_z != null && setZ(outline.axis_z)} onNew={() => {}} />
                {started && (
                  <>
                    <p>Recorded result: {steps[step].label}</p>
                    {step + 1 < steps.length && <button className="shell-btn" onClick={() => setStep(step + 1)}>Next: {steps[step + 1].label}</button>}
                    {step > 0 && <button className="shell-btn" onClick={() => setStep(step - 1)}>Back: {steps[step - 1].label}</button>}
                  </>
                )}
              </div>
            </div>
          )}
        </>
      )}
      {index && <footer style={{ color: "var(--text-muted)", marginTop: 16 }}><small>{index.note}. {index.attribution.join(" ")}</small></footer>}
    </div>
  );
}
