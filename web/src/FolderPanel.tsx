import { useEffect, useRef, useState } from "react";
import { listFolder, setStudyFolder, type Folder, type Patients } from "./api";
import { canUse, crumbs, enter, readsLine } from "./folders";

const FolderMark = () => <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="M3 7.5a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>;

const INTO = ".pp-folder, .m-btn.primary"; // the first subfolder, else Use this folder

/** The Patients panel's Change folder…: the engine lists the folders inside its browse root (a typed path is the fallback), and Use this folder makes the
 *  shown one the study folder. A breadcrumb goes back up. A control that goes away hands the focus on (after a move: the first subfolder, else Use this
 *  folder, so Enter goes on down). onBusy: the folder is being read, which cannot be cancelled, so Cancel is off and the sheet ignores Esc meanwhile. */
export function FolderPanel({ onChosen, onClose, onBusy }: { onChosen: (p: Patients) => void; onClose: () => void; onBusy?: (busy: boolean) => void }) {
  const [folder, setFolder] = useState<Folder>();
  const [typing, setTyping] = useState(false); // Type a path: the field in the breadcrumb's place
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLElement>(null), next = useRef<string>(); // next: what takes the focus after the coming render
  useEffect(() => { const sel = next.current; next.current = undefined; if (sel) root.current?.querySelector<HTMLElement>(sel)?.focus(); });
  useEffect(() => onBusy?.(busy), [busy]);
  useEffect(() => () => onBusy?.(false), []); // a read that ends by closing this view (Use this folder done) unmounts it before the effect above runs: never left busy

  const go = (path: string) => {
    setError(undefined);
    listFolder(path).then((f) => { if (folder) next.current = INTO; setFolder(f); setTyped(f.path); setTyping(false); }, (e) => setError(e.message));
  };
  useEffect(() => go(""), []);

  const choose = () => { // the engine reads the whole folder before it keeps it: the first time can take seconds
    if (!folder) return;
    setBusy(true);
    setError(undefined);
    setStudyFolder(folder.path).then((p) => { setBusy(false); onChosen(p); }, (e) => { setBusy(false); setError(e.message); next.current = ".m-btn.primary"; }); // refused: back on Use this folder, under its alert
  };

  const parts = crumbs(folder?.path ?? "");
  return (
    <section ref={root} className="pp-fold" aria-labelledby="pp-fold-h">
      <header className="pp-fold-head"><h2 id="pp-fold-h">Choose the study folder</h2><p>The folder that holds the study's CT scans. Subfolders are read too.</p></header>
      <div className="pp-fold-bar">
        {typing ? (
          <form className="pp-path" onSubmit={(e) => { e.preventDefault(); go(typed); }}>
            <label className="pp-search"><span className="sr-only">Folder path</span><input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Folder path" /></label>
            <button className="m-btn sm" type="submit">Go</button>
            <button className="m-link" type="button" onClick={() => { setTyping(false); next.current = INTO; }}>Show the folders</button>
          </form>
        ) : <>
          <nav className="pp-crumbs" aria-label="Folder path">
            <ol>{parts.map((c, i) => <li key={c.path}>{i === parts.length - 1 ? <span aria-current="location">{c.name}</span>
              : <button className="pp-crumb" disabled={busy} onClick={() => go(c.path)}>{c.name}</button>}</li>)}</ol>
          </nav>
          <button className="m-link" onClick={() => { setTyping(true); next.current = "input"; }} disabled={busy}>Type a path</button>
        </>}
      </div>
      <ul className="pp-folders" aria-label="Subfolders">
        {folder?.folders.map((n) => <li key={n}><button className="pp-folder" disabled={busy} onClick={() => go(enter(folder.path, n))}><FolderMark /><span>{n}</span><i aria-hidden="true">›</i></button></li>)}
        {folder && !folder.folders.length && <li className="pp-none">No subfolders here.</li>}
      </ul>
      <div className="pp-foot">
        {error && <span className="pp-error" role="alert">{error}</span>}
        {busy ? <span role="status"><span className="m-spin" aria-hidden="true" />Reading the folder…</span> : folder && <span>{readsLine(folder)}</span>}
        <span className="grow" />
        <button className="m-btn sm ghost" disabled={busy} onClick={onClose}>Cancel</button><button className="m-btn sm primary" disabled={!canUse(folder) || busy} onClick={choose}>Use this folder</button>
      </div>
    </section>
  );
}
