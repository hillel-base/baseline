import { useEffect, useState } from "react";
import { listFolder, openFolder, type Folder, type ScanMeta } from "./api";
import { enter, seriesLabel } from "./folders";

/** In-page folder browser: the engine lists folders inside its browse root; a path field is the fallback. */
export function FolderPanel({ onOpened, onClose }: { onOpened: (s: ScanMeta) => void; onClose: () => void }) {
  const [folder, setFolder] = useState<Folder>();
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const go = (path: string) => {
    setError(undefined);
    listFolder(path).then((f) => { setFolder(f); setTyped(f.path); }, (e) => setError(e.message));
  };
  useEffect(() => go(""), []);

  const open = (series: string) => {
    if (!folder) return;
    setBusy(true);
    setError(undefined);
    openFolder(folder.path, series).then(onOpened, (e) => setError(e.message)).finally(() => setBusy(false));
  };

  return (
    <section aria-label="Open a CT folder" style={{ border: "1px solid #888", padding: 12, margin: "8px 0" }}>
      <p>Folder: <strong>{folder ? `/${folder.path}` : "…"}</strong>{" "}
        <button onClick={() => folder?.parent != null && go(folder.parent)} disabled={folder?.parent == null}>Up</button>{" "}
        <button onClick={onClose}>Close</button></p>
      {folder && folder.folders.length > 0 && (
        <ul aria-label="Subfolders">
          {folder.folders.map((n) => <li key={n}><button onClick={() => go(enter(folder.path, n))}>{n}</button></li>)}
        </ul>
      )}
      {folder && (folder.series.length === 0 ? <p>No CT series in this folder.</p> : (
        <ul aria-label="Series in this folder">
          {folder.series.map((s) => (
            <li key={s.uid_hash}>{seriesLabel(s)}{" "}
              <button onClick={() => open(s.uid_hash)} disabled={busy} aria-label={`Open ${seriesLabel(s)}`}>Open</button></li>
          ))}
        </ul>
      ))}
      <form onSubmit={(e) => { e.preventDefault(); go(typed); }}>
        <label>Folder path <input value={typed} onChange={(e) => setTyped(e.target.value)} size={40} /></label>{" "}
        <button type="submit">Go</button>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
