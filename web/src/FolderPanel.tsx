import { useEffect, useState } from "react";
import { listFolder, setStudyFolder, type Folder, type Patients } from "./api";
import { enter } from "./folders";

/** The Patients panel's Change folder…: the engine lists folders inside its browse root (a path field is the fallback), and "Choose this folder" makes one the study folder. */
export function FolderPanel({ onChosen, onClose }: { onChosen: (p: Patients) => void; onClose: () => void }) {
  const [folder, setFolder] = useState<Folder>();
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const go = (path: string) => {
    setError(undefined);
    listFolder(path).then((f) => { setFolder(f); setTyped(f.path); }, (e) => setError(e.message));
  };
  useEffect(() => go(""), []);

  const choose = () => { // the engine reads the whole folder before it keeps it: the first time can take seconds
    if (!folder) return;
    setBusy(true);
    setError(undefined);
    setStudyFolder(folder.path).then(onChosen, (e) => setError(e.message)).finally(() => setBusy(false));
  };

  return (
    <section aria-label="Choose the study folder" style={{ border: "1px solid #888", padding: 12, margin: "8px 0" }}>
      <p>Folder: <strong>{folder ? `/${folder.path}` : "…"}</strong>{" "}
        <button onClick={() => folder?.parent != null && go(folder.parent)} disabled={folder?.parent == null}>Up</button>{" "}
        <button onClick={choose} disabled={!folder || busy}>Choose this folder</button>{" "}
        <button onClick={onClose}>Close</button></p>
      {folder && folder.folders.length > 0 && (
        <ul aria-label="Subfolders">
          {folder.folders.map((n) => <li key={n}><button onClick={() => go(enter(folder.path, n))}>{n}</button></li>)}
        </ul>
      )}
      <form onSubmit={(e) => { e.preventDefault(); go(typed); }}>
        <label>Folder path <input value={typed} onChange={(e) => setTyped(e.target.value)} size={40} /></label>{" "}
        <button type="submit">Go</button>
      </form>
      {busy && <p role="status">Reading the folder…</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
