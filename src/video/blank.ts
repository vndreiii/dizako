/**
 * Detects the "painted nothing" failure.
 *
 * Some WebKit builds hand back a surface that is entirely transparent when a
 * video frame is read a particular way - no exception, no warning, just zeros.
 * Video frames are opaque, so a plane whose every sampled alpha is zero cannot
 * be a real frame; it means the route used to read it does not work on this
 * host and the caller should switch to another.
 *
 * Sampling a few dozen pixels is enough: the failure is all-or-nothing, and a
 * full scan of a 4-megapixel plane would cost what the readback saved.
 */
export function looksBlank(data: Uint8ClampedArray | Uint8Array, samples = 96): boolean {
  const pixels = data.length >> 2;
  if (pixels === 0) return true;
  const stride = Math.max(1, Math.floor(pixels / samples));
  for (let i = 0; i < pixels; i += stride) {
    if (data[i * 4 + 3] !== 0) return false;
  }
  // The last pixel too, so a plane that is only partly painted still passes.
  return data[pixels * 4 - 1] === 0;
}
