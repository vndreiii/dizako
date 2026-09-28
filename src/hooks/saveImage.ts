/**
 * Writing results to disk.
 *
 * Inside Tauri the webview ignores `<a download>` entirely, so everything goes
 * through the native dialogs and the fs plugin; picking a path there is also
 * what grants the fs scope to write to it. In a plain browser the anchor trick
 * is the only option and is good enough for development.
 */
import { appError } from "../errors";
import { frameFileName } from "../video/encode";

export type SaveOutcome = "saved" | "cancelled";

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function writeBlob(path: string, blob: Blob): Promise<void> {
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
}

function downloadInBrowser(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  // Revoking immediately can race the download on WebKit; a beat is enough.
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Saves one blob under a user-chosen path. */
export async function saveBlob(
  blob: Blob,
  suggestedName: string,
  filter: { name: string; extensions: string[] },
): Promise<SaveOutcome> {
  if (!inTauri()) {
    downloadInBrowser(blob, suggestedName);
    return "saved";
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({ defaultPath: suggestedName, filters: [filter] });
  if (!path) return "cancelled";
  try {
    await writeBlob(path, blob);
  } catch (err) {
    throw appError("export/write-failed", {
      detail: `could not write ${path}: ${String(err)}`,
      values: { path },
      cause: err,
    });
  }
  return "saved";
}

export function savePng(blob: Blob, suggestedName: string): Promise<SaveOutcome> {
  return saveBlob(blob, suggestedName, { name: "PNG image", extensions: ["png"] });
}

export function saveVideo(blob: Blob, suggestedName: string, extension: string): Promise<SaveOutcome> {
  return saveBlob(blob, suggestedName, {
    name: extension === "mp4" ? "MP4 video" : "WebM video",
    extensions: [extension],
  });
}

/**
 * Writes a numbered PNG sequence into a folder the user picks.
 *
 * The frames land in a `<base>_frames` subfolder rather than loose in the
 * chosen directory: a thousand files dumped into someone's Pictures folder is
 * not a result, it is a mess they have to clean up.
 */
export async function savePngSequence(
  frames: Blob[],
  base: string,
  onProgress?: (done: number, total: number) => void,
): Promise<SaveOutcome> {
  if (!inTauri()) {
    // No directory picker in a plain browser; one download per frame is the
    // only honest option and is why this path is a development convenience.
    for (let i = 0; i < frames.length; i++) {
      downloadInBrowser(frames[i]!, frameFileName(base, i, frames.length));
      onProgress?.(i + 1, frames.length);
      await new Promise((r) => window.setTimeout(r, 40));
    }
    return "saved";
  }

  const [{ open }, fs] = await Promise.all([
    import("@tauri-apps/plugin-dialog"),
    import("@tauri-apps/plugin-fs"),
  ]);
  const picked = await open({ directory: true, multiple: false, title: "Choose a folder for the frame sequence" });
  if (!picked || typeof picked !== "string") return "cancelled";

  const folder = `${picked}/${base}_frames`;
  try {
    await fs.mkdir(folder, { recursive: true });
  } catch (err) {
    // An existing folder is fine; anything else is a real permission problem.
    const message = String(err);
    if (!/exists/i.test(message)) {
      throw appError("video/export-write-failed", {
        detail: `could not create ${folder}: ${message}`,
        values: { path: folder },
        cause: err,
      });
    }
  }

  for (let i = 0; i < frames.length; i++) {
    const name = frameFileName(base, i, frames.length);
    try {
      await fs.writeFile(`${folder}/${name}`, new Uint8Array(await frames[i]!.arrayBuffer()));
    } catch (err) {
      throw appError("video/export-write-failed", {
        detail: `failed on ${name} (${i + 1} of ${frames.length}): ${String(err)}`,
        values: { path: `${folder}/${name}` },
        cause: err,
      });
    }
    onProgress?.(i + 1, frames.length);
  }
  return "saved";
}
