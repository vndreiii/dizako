/**
 * Saves a PNG blob. Inside Tauri the webview ignores `<a download>`, so we go
 * through the native save dialog; in a plain browser we fall back to the
 * anchor trick.
 */

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function savePng(blob: Blob, suggestedName: string): Promise<"saved" | "cancelled"> {
  if (inTauri()) {
    const [{ save }, { writeFile }] = await Promise.all([
      import("@tauri-apps/plugin-dialog"),
      import("@tauri-apps/plugin-fs"),
    ]);
    const path = await save({
      defaultPath: suggestedName,
      filters: [{ name: "PNG image", extensions: ["png"] }],
    });
    if (!path) return "cancelled";
    await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    return "saved";
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  a.click();
  URL.revokeObjectURL(url);
  return "saved";
}
