import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { runProgram } from "../livestreams/livestream-reader";

/**
 * ffprobe and ffmpeg for signage media (docs/signage.md section 9). Same rules as the livestream checks: an argument array,
 * no environment from the API (no secrets), a time limit, an output cap, and work files only under /tmp.
 */

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

/** Formats we accept, as ffprobe names them (the container), never the browser's word for it. */
const IMAGE_CODECS = new Set(["mjpeg", "png", "webp", "gif", "bmp", "tiff"]);
const IMAGE_FORMATS = new Set(["image2", "png_pipe", "jpeg_pipe", "webp_pipe", "gif", "bmp_pipe", "tiff_pipe", "gif_pipe"]);
const VIDEO_FORMATS = /^(mov,mp4,m4a,3gp,3g2,mj2|matroska,webm|avi|mpegts|mpeg|flv|asf)$/;

export interface Probe {
  kind: "image" | "video";
  width: number;
  height: number;
  durationS: number | null;
  /** What the file is, said plainly (for errors). */
  describe: string;
}

interface FfprobeJson {
  format?: { format_name?: string; duration?: string };
  streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string; nb_frames?: string }>;
}

/** What a file really is, or a plain reason it cannot be used. */
export async function probe(path: string): Promise<Probe | { error: string }> {
  const r = await runProgram(FFPROBE, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-i", path], { timeoutMs: 60_000, maxStdout: 2_000_000 });
  if (r.timedOut) return { error: "Reading the file took too long." };
  if (r.code !== 0) return { error: "This is not a picture or video the dashboard can read." };
  let j: FfprobeJson;
  try {
    j = JSON.parse(r.stdout.toString("utf8")) as FfprobeJson;
  } catch {
    return { error: "This is not a picture or video the dashboard can read." };
  }
  const fmt = j.format?.format_name ?? "";
  const video = (j.streams ?? []).find((s) => s.codec_type === "video");
  if (!video || !video.width || !video.height) return { error: "The file has no picture in it (sound-only files cannot be shown)." };
  const isImage = (IMAGE_FORMATS.has(fmt) || IMAGE_CODECS.has(video.codec_name ?? "")) && !VIDEO_FORMATS.test(fmt) && (video.codec_name !== "gif" || Number(video.nb_frames ?? 1) <= 1);
  if (isImage && IMAGE_CODECS.has(video.codec_name ?? "")) return { kind: "image", width: video.width, height: video.height, durationS: null, describe: `${video.codec_name} picture` };
  if (VIDEO_FORMATS.test(fmt) || video.codec_name === "gif") {
    const dur = Number(j.format?.duration ?? video.duration ?? NaN);
    if (!Number.isFinite(dur) || dur <= 0) return { error: "The video's length could not be read." };
    if (dur > 4 * 3600) return { error: "Videos can be at most 4 hours long." };
    return { kind: "video", width: video.width, height: video.height, durationS: Math.round(dur * 100) / 100, describe: `${video.codec_name} video` };
  }
  return { error: `This kind of file (${fmt || "unknown"}) cannot be shown.` };
}

/** The box a rendition must fit in: 1920x1080, or 1080x1920 for a portrait original. Never scaled up. */
export function renditionBox(width: number, height: number): { w: number; h: number } {
  return height > width ? { w: 1080, h: 1920 } : { w: 1920, h: 1080 };
}

/** ffmpeg arguments for the rendition a Pi plays (H.264 High at most 1080p30 and 8 Mbps, no sound, metadata stripped). */
export function renditionArgs(kind: "image" | "video", input: string, output: string, width: number, height: number, png: boolean): string[] {
  const box = renditionBox(width, height);
  const scale = `scale=w='min(${box.w},iw)':h='min(${box.h},ih)':force_original_aspect_ratio=decrease`;
  if (kind === "image") {
    return ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-map_metadata", "-1", "-frames:v", "1", "-vf", scale, ...(png ? ["-c:v", "png"] : ["-c:v", "mjpeg", "-q:v", "3", "-pix_fmt", "yuvj420p"]), output];
  }
  return [
    "-hide_banner", "-loglevel", "error", "-y", "-i", input,
    "-map", "0:v:0", "-map_metadata", "-1", "-an", "-sn", "-dn",
    "-vf", `${scale}:force_divisible_by=2,fps=fps='min(30,source_fps)'`,
    "-c:v", "libx264", "-profile:v", "high", "-level", "4.1", "-preset", "medium", "-crf", "21",
    "-maxrate", "8M", "-bufsize", "16M", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    output,
  ];
}

/** A small JPEG to show in the library (from the middle of a video). */
export function thumbArgs(input: string, output: string, atS: number | null): string[] {
  return ["-hide_banner", "-loglevel", "error", "-y", ...(atS ? ["-ss", String(atS)] : []), "-i", input, "-frames:v", "1", "-vf", "scale=w=320:h=320:force_original_aspect_ratio=decrease", "-q:v", "5", output];
}

export async function ffmpeg(args: string[], timeoutMs: number): Promise<string | null> {
  const r = await runProgram(FFMPEG, args, { timeoutMs, maxStdout: 1_000_000 });
  if (r.timedOut) return "Converting the file took too long.";
  if (r.code !== 0) return `Converting the file failed: ${r.stderr.trim().split("\n").slice(-2).join(" ").slice(0, 300) || "ffmpeg stopped"}`;
  return null;
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (d) => h.update(d))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}
