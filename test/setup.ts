/**
 * Node lacks the DOM `ImageData` global that the engine constructs. The shim
 * mirrors the shape the engine relies on: `.data`, `.width`, `.height`.
 */
class ImageDataShim {
  data: Uint8ClampedArray;
  width: number;
  height: number;

  constructor(
    data: Uint8ClampedArray | ArrayBufferLike,
    width: number,
    height: number,
  ) {
    const bytes =
      data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data);
    if (bytes.length !== width * height * 4) {
      throw new Error("ImageData size mismatch");
    }
    this.data = bytes;
    this.width = width;
    this.height = height;
  }
}

if (typeof (globalThis as Record<string, unknown>).ImageData === "undefined") {
  (globalThis as Record<string, unknown>).ImageData = ImageDataShim;
}
