import { describe, expect, it } from "vitest";
import { frameFileName, suggestBitrate } from "../src/video/encode";
import { estimatedMemoryBytes, exportFrameSize } from "../src/video/export";
import { frameToTime, looksLikeVideo, timeToFrame, VIDEO_EXTENSIONS } from "../src/video/clip";
import type { Clip } from "../src/video/clip";

/** A clip stub: only the numeric fields the pure helpers read. */
function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    file: new File([], "x.mp4"),
    url: "blob:x",
    el: null as unknown as HTMLVideoElement,
    width: 1920,
    height: 1080,
    frameWidth: 1920,
    frameHeight: 1080,
    durationS: 10,
    fps: 25,
    fpsAssumed: false,
    frameCount: 250,
    hasAudio: false,
    ...overrides,
  };
}

describe("frame ↔ time", () => {
  it("lands mid-interval, not on the boundary", () => {
    // Seeking exactly to a frame boundary is where decoders disagree about
    // which side of it you asked for, so the target sits half a frame in.
    const c = clip();
    expect(frameToTime(c, 0)).toBeCloseTo(0.02, 5);
    expect(frameToTime(c, 10)).toBeCloseTo(0.42, 5);
  });

  it("never seeks past the end", () => {
    const c = clip({ durationS: 4, fps: 25, frameCount: 100 });
    expect(frameToTime(c, 9999)).toBeLessThan(4);
    expect(frameToTime(c, -5)).toBeGreaterThanOrEqual(0);
  });

  it("round-trips a frame index through a seek target", () => {
    const c = clip({ fps: 29.97, durationS: 20, frameCount: 599 });
    for (const frame of [0, 1, 37, 200, 598]) {
      expect(timeToFrame(c, frameToTime(c, frame))).toBe(frame);
    }
  });

  it("clamps a time outside the clip to a real frame", () => {
    const c = clip();
    expect(timeToFrame(c, -3)).toBe(0);
    expect(timeToFrame(c, 1e6)).toBe(c.frameCount - 1);
  });
});

describe("exportFrameSize", () => {
  it("keeps both dimensions even, which every H.264 profile requires", () => {
    for (const scale of [1, 0.9, 0.75, 0.5, 0.33, 0.25]) {
      const { width, height } = exportFrameSize(clip({ frameWidth: 1913, frameHeight: 1077 }), scale);
      expect(width % 2).toBe(0);
      expect(height % 2).toBe(0);
      expect(width).toBeGreaterThanOrEqual(2);
      expect(height).toBeGreaterThanOrEqual(2);
    }
  });

  it("scales down proportionally", () => {
    const full = exportFrameSize(clip(), 1);
    const half = exportFrameSize(clip(), 0.5);
    expect(full).toEqual({ width: 1920, height: 1080 });
    expect(half).toEqual({ width: 960, height: 540 });
  });
});

describe("estimatedMemoryBytes", () => {
  it("grows with frames and with area", () => {
    const base = estimatedMemoryBytes(100, 1920, 1080);
    expect(estimatedMemoryBytes(200, 1920, 1080)).toBeCloseTo(base * 2, -3);
    expect(estimatedMemoryBytes(100, 960, 540)).toBeCloseTo(base / 4, -3);
  });

  it("stays well under raw RGBA, which is the reason PNG is the intermediate", () => {
    const frames = 500;
    const raw = frames * 1920 * 1080 * 4;
    expect(estimatedMemoryBytes(frames, 1920, 1080)).toBeLessThan(raw / 10);
  });
});

describe("suggestBitrate", () => {
  it("is generous enough that dither patterns survive the encoder", () => {
    // Ordinary 1080p30 video is happy at 5-8 Mbps; dithered footage is all
    // high-frequency detail and smears at those rates.
    expect(suggestBitrate(1920, 1080, 30)).toBeGreaterThan(12_000_000);
  });

  it("clamps at both ends", () => {
    expect(suggestBitrate(64, 64, 1)).toBe(2_000_000);
    expect(suggestBitrate(7680, 4320, 120)).toBe(90_000_000);
  });
});

describe("frameFileName", () => {
  it("zero-pads so a written sequence sorts correctly", () => {
    expect(frameFileName("clip", 7, 1200)).toBe("clip_0007.png");
    expect(frameFileName("clip", 7, 20000)).toBe("clip_00007.png");
  });

  it("sorts lexicographically in frame order", () => {
    const names = [0, 1, 9, 10, 99, 100, 999].map((i) => frameFileName("c", i, 1000));
    expect([...names].sort()).toEqual(names);
  });
});

describe("looksLikeVideo", () => {
  it("accepts by MIME type", () => {
    expect(looksLikeVideo(new File([], "a.mp4", { type: "video/mp4" }))).toBe(true);
  });

  it("falls back to the extension, which is all some hosts give for a drop", () => {
    for (const ext of VIDEO_EXTENSIONS) {
      expect(looksLikeVideo(new File([], `clip.${ext}`, { type: "" }))).toBe(true);
    }
    expect(looksLikeVideo(new File([], "CLIP.MOV", { type: "" }))).toBe(true);
  });

  it("rejects stills and everything else", () => {
    expect(looksLikeVideo(new File([], "a.png", { type: "image/png" }))).toBe(false);
    expect(looksLikeVideo(new File([], "notes.txt", { type: "text/plain" }))).toBe(false);
    expect(looksLikeVideo(new File([], "noextension", { type: "" }))).toBe(false);
  });
});
