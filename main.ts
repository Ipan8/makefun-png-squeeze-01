// png-squeeze: a lossless PNG re-encoder that writes every screenshot as small as it can.
//
// For each instance under MAKEFUN_INPUT_DIR/<id>/image.png it writes
// MAKEFUN_OUTPUT_DIR/<id>/image.png (defaults /input and /output, the harness mounts;
// give input and output directories as argv[2] and argv[3] to run it locally, or two
// .png paths for a single file). Node 22 runs `node main.ts` with types stripped, so
// this file uses erasable TypeScript syntax only, Node's standard library only, and no
// network, no clock and no randomness: two runs write byte-identical files.
//
// What it does, per image:
//   1. Decodes the PNG to RGBA (own decoder: bit depth 8, non-interlaced, colour types
//      0, 2, 3, 4, 6; chunk CRCs checked; a fully transparent pixel's colour kept).
//   2. Analyses the pixels: opaque? grey? at most 256 distinct colours? one single
//      fully-transparent value no opaque pixel uses (then a tRNS key replaces the alpha
//      channel)? From that it builds the candidate forms: palette (count order and
//      luminance order, transparent entries first so tRNS stays short), grey / grey+alpha,
//      RGB / RGBA, RGB or grey with a tRNS key.
//   3. Screens every form under every filter choice (fixed None/Sub/Up/Paeth, per-row
//      minimum-sum, fewest-distinct-pairs, and brute force: each row tried under all
//      five filters, each trial deflated at level 4 against the 32 KiB written before
//      it, the smallest kept). Each choice is weighed by a level-6 deflate plus its
//      PLTE/tRNS chunk bytes; the smallest wins, the first on a tie.
//   4. Writes the winner's filtered data with the best of four deflate streams: the
//      level-6 screening stream, level 9, level-9-filtered, and level 9 at memLevel 9
//      (memLevel 8 wins on this data at every level, measured on the practice set, but
//      memLevel 9 still wins on rare images, so it stays a candidate). One IDAT, only
//      IHDR / PLTE / tRNS / IDAT / IEND, every CRC correct, bit depth 8, never interlaced.
//
// The work per set is fixed by the images, never by the clock, so the 60-second wall
// is budgeted by work: screening is one level-6 deflate per choice, brute force is
// five small deflates per row, and the final pass is two full deflates. Nothing here
// reads the time, so repeated runs cannot diverge.

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync, inflateSync, constants as zlibConstants } from "node:zlib";

// ---------------------------------------------------------------------------
// PNG container: signature, CRC-32, chunk assembly, IHDR.
// ---------------------------------------------------------------------------

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ALLOWED_CHUNKS = ["IHDR", "PLTE", "tRNS", "IDAT", "IEND"];

const CRC_TABLE = ((): Int32Array => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function ascii(s: string): Uint8Array {
  return Uint8Array.from(s, (ch) => ch.charCodeAt(0));
}

/** A PNG file of [type, data] chunks: signature, then each chunk with length and CRC. */
function pngOf(chunks: Array<[string, Uint8Array]>): Uint8Array {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ascii(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

/** IHDR data: width, height, bit depth 8, colour type, compression 0, filter 0, no interlace. */
function ihdrOf(width: number, height: number, colourType: number): Uint8Array {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

// ---------------------------------------------------------------------------
// Decoder: PNG bytes -> { width, height, rgba } (or why it cannot be read).
// ---------------------------------------------------------------------------

type Decoded =
  | { ok: true; width: number; height: number; rgba: Uint8Array }
  | { ok: false; why: string };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodePng(bytes: Uint8Array): Decoded {
  const fail = (why: string): Decoded => ({ ok: false, why });
  if (bytes.length < SIGNATURE.length || SIGNATURE.some((b, i) => bytes[i] !== b)) {
    return fail("it does not start with the PNG signature");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = SIGNATURE.length;
  let header: { width: number; height: number; colourType: number } | null = null;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let idatDone = false;
  let ended = false;
  while (at < bytes.length) {
    if (ended) return fail("it holds bytes after IEND");
    if (at + 12 > bytes.length) return fail(`a chunk at byte ${at} is cut short`);
    const len = view.getUint32(at);
    if (len > 0x7fffffff || at + 12 + len > bytes.length) {
      return fail(`the chunk at byte ${at} claims ${len} bytes the file does not hold`);
    }
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (!/^[A-Za-z]{4}$/.test(type)) return fail(`the chunk at byte ${at} has no chunk type (four letters)`);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) {
      return fail(`the ${type} chunk at byte ${at} fails its CRC`);
    }
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (!ALLOWED_CHUNKS.includes(type)) return fail(`it holds a ${type} chunk, and only ${ALLOWED_CHUNKS.join(", ")} are read`);
    if (header === null && type !== "IHDR") return fail(`its first chunk is ${type}, not IHDR`);
    if (type !== "IDAT" && idat.length > 0) idatDone = true;
    if (type === "IHDR") {
      if (header !== null) return fail("it holds IHDR twice");
      if (len !== 13) return fail("its IHDR is not 13 bytes");
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      const width = dv.getUint32(0);
      const height = dv.getUint32(4);
      if (width === 0 || height === 0) return fail("its width or height is 0");
      if (data[8] !== 8) return fail(`its bit depth is ${data[8]}, not 8`);
      if (!Object.hasOwn(CHANNELS, data[9])) return fail(`its colour type is ${data[9]}, not 0, 2, 3, 4 or 6`);
      if (data[10] !== 0 || data[11] !== 0) return fail("its compression or filter method is not 0");
      if (data[12] !== 0) return fail("it is interlaced");
      header = { width, height, colourType: data[9] };
    } else if (type === "PLTE") {
      if (palette !== null) return fail("it holds PLTE twice");
      if (header!.colourType !== 3) return fail(`it holds PLTE with colour type ${header!.colourType} (only type 3 takes one)`);
      if (idat.length > 0) return fail("its PLTE follows IDAT");
      if (len === 0 || len % 3 !== 0 || len > 768) return fail("its PLTE is not 1 to 256 entries of 3 bytes");
      palette = data;
    } else if (type === "tRNS") {
      if (trns !== null) return fail("it holds tRNS twice");
      if (idat.length > 0) return fail("its tRNS follows IDAT");
      const ct = header!.colourType;
      if (ct === 3) {
        if (palette === null) return fail("its tRNS comes before PLTE");
        if (len > palette.length / 3) return fail("its tRNS holds more entries than its palette");
      } else if (ct === 0 || ct === 2) {
        if (len !== (ct === 0 ? 2 : 6)) return fail(`its tRNS is not ${ct === 0 ? 2 : 6} bytes for colour type ${ct}`);
        for (let i = 0; i < len; i += 2) if (data[i] !== 0) return fail("its tRNS names a sample over 255");
      } else {
        return fail(`it holds tRNS with colour type ${ct}`);
      }
      trns = data;
    } else if (type === "IDAT") {
      if (idatDone) return fail("its IDAT chunks are not in a row");
      if (header!.colourType === 3 && palette === null) return fail("its IDAT comes before PLTE (colour type 3 needs one)");
      idat.push(data);
    } else {
      if (len !== 0) return fail("its IEND is not empty");
      ended = true;
    }
  }
  if (!ended) return fail("it has no IEND");
  if (idat.length === 0) return fail("it has no IDAT");
  const { width, height, colourType } = header!;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  if (!Number.isSafeInteger(expected) || expected > 1 << 30) return fail("its image is too large to read");
  let raw: Uint8Array;
  try {
    raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  } catch (err) {
    return fail(`its IDAT data is not one whole zlib stream of ${expected} bytes (${String(err && (err as Error).message).split("\n")[0]})`);
  }
  if (raw.length !== expected) return fail(`its IDAT data inflates to ${raw.length} bytes, not ${expected}`);

  // Unfilter row by row into samples.
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) return fail(`row ${y} has filter type ${ft}`);
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) {
      samples.set(raw.subarray(src, src + stride), o);
    } else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
      }
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    }
  }

  // Expand the samples to RGBA.
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette!.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette![e * 3];
      lut[e * 4 + 1] = palette![e * 3 + 1];
      lut[e * 4 + 2] = palette![e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) return fail(`pixel (${i % width}, ${Math.floor(i / width)}) names palette entry ${e} of ${entries}`);
      rgba[d] = lut[e * 4];
      rgba[d + 1] = lut[e * 4 + 1];
      rgba[d + 2] = lut[e * 4 + 2];
      rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { ok: true, width, height, rgba };
}

// ---------------------------------------------------------------------------
// Filters: the five PNG row filters, and the per-row cost heuristics.
// ---------------------------------------------------------------------------

/** Row `cur` (stride samples, bpp a pixel, `prev` the row above or null) filtered by `type` into out. */
function filterRow(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

/** Sum of a filtered row's bytes read as signed (-128 to 127), absolute. */
function signedSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

/** Fewest-distinct-pairs cost: distinct neighbouring byte pairs in a filtered row. */
function pairsOf(row: Uint8Array, seen: Uint32Array, stamp: number): number {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Analysis: what an RGBA image holds, and the forms that can carry it exactly.
// ---------------------------------------------------------------------------

interface Colour {
  r: number;
  g: number;
  b: number;
  a: number;
  word: number;
  count: number;
}

interface Analysis {
  opaque: boolean;
  grey: boolean;
  colours: Colour[] | null; // null when more than 256 distinct colours
}

function analyse(rgba: Uint8Array): Analysis {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const counts = new Map<number, number>();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const r = rgba[d];
    const g = rgba[d + 1];
    const b = rgba[d + 2];
    const a = rgba[d + 3];
    if (a !== 255) opaque = false;
    if (r !== g || r !== b) grey = false;
    if (!many) {
      const word = (((r << 24) | (g << 16) | (b << 8) | a) >>> 0);
      const k = counts.get(word);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(word, 1);
      } else {
        counts.set(word, k + 1);
      }
    }
  }
  const colours = many
    ? null
    : [...counts.entries()].map(([word, count]) => ({
        r: (word >>> 24) & 0xff,
        g: (word >>> 16) & 0xff,
        b: (word >>> 8) & 0xff,
        a: word & 0xff,
        word,
        count,
      }));
  return { opaque, grey, colours };
}

/**
 * The one fully transparent value (grey sample, or RGB triple) the image may key by
 * tRNS instead of an alpha channel: every pixel opaque or that exact value at alpha
 * 0, and no opaque pixel of the same value. Null when there is none.
 */
function transparentKey(rgba: Uint8Array, grey: boolean): number | null {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

/** The image's samples in colour type `ct` (0, 2, 4 or 6) from its RGBA. */
function samplesOf(rgba: Uint8Array, ct: number): Uint8Array {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) {
      out[s] = rgba[d];
    } else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

/** A palette's entries in the order a trial writes them: transparent first (by alpha), then by `order`. */
function paletteOrder(colours: Colour[], order: "count" | "luminance"): Colour[] {
  const lum = (c: Colour): number => 299 * c.r + 587 * c.g + 114 * c.b;
  return [...colours].sort((x, y) => {
    const ta = x.a === 255 ? 1 : 0;
    const tb = y.a === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.a !== y.a) return x.a - y.a;
    if (order === "luminance") return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

interface PaletteForm {
  plte: Uint8Array;
  trns: Uint8Array | null;
  indices: Uint8Array;
}

/** The palette form: {plte, trns, indices} for a colour list in `order`. */
function paletteForm(rgba: Uint8Array, colours: Colour[], order: "count" | "luminance"): PaletteForm {
  const entries = paletteOrder(colours, order);
  const index = new Map<number, number>(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const word = (((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]) >>> 0);
    indices[i] = index.get(word)!;
  }
  return { plte, trns, indices };
}

// ---------------------------------------------------------------------------
// Screening: filter choices weighed by a level-6 deflate, brute force included.
// ---------------------------------------------------------------------------

/** The zlib setting every choice is screened by. */
const SCREEN = { level: 6, memLevel: 8, strategy: zlibConstants.Z_DEFAULT_STRATEGY };
/** The zlib settings the winner is finally written with, best of all tried. */
const FINAL = { level: 9, memLevel: 8, strategy: zlibConstants.Z_DEFAULT_STRATEGY };
const FINAL_FILTERED = { level: 9, memLevel: 8, strategy: zlibConstants.Z_FILTERED };
const FINAL_M9 = { level: 9, memLevel: 9, strategy: zlibConstants.Z_DEFAULT_STRATEGY };
/** How many bytes written before a row brute force compresses its trials after. */
const BRUTE_CONTEXT = 32768;
/** The zlib level brute force weighs a row's trials at. */
const BRUTE_LEVEL = 4;

type FilterChoice = number | "minsum" | "pairs" | "brute";

/**
 * The raw data of an image of `samples` (height rows of width x bpp samples), each
 * row behind its filter byte, by `choice`: a filter type (0 to 4) for every row, or
 * 'minsum', 'pairs' or 'brute' (each row its own type, the lower type on a tie).
 */
function filtered(samples: Uint8Array, width: number, height: number, bpp: number, choice: FilterChoice): Uint8Array {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial: Uint8Array[] = Array.from({ length: 5 }, (_, t) => {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    return row;
  });
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === "number") {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost: number;
      if (choice === "minsum") cost = signedSum(trial[t].subarray(1));
      else if (choice === "pairs") cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      else {
        cost = deflateSync(
          trial[t],
          before.length === 0
            ? { level: BRUTE_LEVEL, memLevel: 9 }
            : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before },
        ).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

interface Form {
  colourType: number;
  bpp: number;
  samples: Uint8Array;
  plte: Uint8Array | null;
  trns: Uint8Array | null;
  filters: FilterChoice[];
}

const CHANNEL_FILTERS: FilterChoice[] = [0, 1, 2, 4, "minsum", "pairs", "brute"];
const PALETTE_FILTERS: FilterChoice[] = [0, "minsum", "brute"];

/** The forms the screen tries for an image: palette forms, then the channel form. */
function formsOf(rgba: Uint8Array): Form[] {
  const { opaque, grey, colours } = analyse(rgba);
  const forms: Form[] = [];
  if (colours !== null) {
    for (const order of ["count", "luminance"] as const) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters: PALETTE_FILTERS });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct: number;
  let trns: Uint8Array | null = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct]!;
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: CHANNEL_FILTERS });
  return forms;
}

/** The bytes a form's PLTE and tRNS chunks take in its file (12 bytes of length, type and CRC around each). */
function chunkBytes(form: Form): number {
  return (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
}

interface Screened {
  form: Form;
  choice: FilterChoice;
  data: Uint8Array;
  zlib: Uint8Array;
  bytes: number;
}

/** The screen's winner: the form and filter choice whose level-6 stream weighs least. */
function screen(rgba: Uint8Array, width: number, height: number): Screened {
  let best: Screened | null = null;
  for (const form of formsOf(rgba)) {
    const chunks = chunkBytes(form);
    for (const choice of form.filters) {
      const data = filtered(form.samples, width, height, form.bpp, choice);
      const zlib = deflateSync(data, SCREEN);
      const bytes = zlib.length + chunks;
      if (best === null || bytes < best.bytes) {
        best = { form, choice, data, zlib: new Uint8Array(zlib.buffer, zlib.byteOffset, zlib.length), bytes };
      }
    }
  }
  return best!;
}

/** The PNG of an image of `form` whose IDAT holds the zlib stream `idat`. */
function pngOfForm(width: number, height: number, form: Form, idat: Uint8Array): Uint8Array {
  const chunks: Array<[string, Uint8Array]> = [["IHDR", ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(["PLTE", form.plte]);
  if (form.trns !== null) chunks.push(["tRNS", form.trns]);
  chunks.push(["IDAT", idat]);
  chunks.push(["IEND", new Uint8Array(0)]);
  return pngOf(chunks);
}

/** The smallest lossless PNG of an RGBA image: screen, then the best final deflate. */
function squeeze(rgba: Uint8Array, width: number, height: number, id = ""): Uint8Array {
  const { form, choice, data, zlib } = screen(rgba, width, height);
  // The winner's stream, then the final candidates; memLevel 8 beats 9 on this data
  // at every level (measured on the practice set), but level 9 at memLevel 9 still
  // wins on rare images, so it stays as a candidate. Strictly-smaller wins, first on a tie.
  const candidates: Array<[string, Uint8Array]> = [
    ["level6", zlib],
    ["level9", deflateSync(data, FINAL)],
    ["level9-filtered", deflateSync(data, FINAL_FILTERED)],
    ["level9-mem9", deflateSync(data, FINAL_M9)],
  ];
  let best: Uint8Array = candidates[0][1];
  let bestHow = candidates[0][0];
  for (const [how, stream] of candidates.slice(1)) {
    if (stream.length < best.length) {
      best = stream;
      bestHow = how;
    }
  }
  if (process.env.MAKEFUN_DEBUG !== undefined) {
    process.stderr.write(
      `${id} ct=${form.colourType} choice=${String(choice)} ` +
        candidates.map(([how, s]) => `${how}=${s.length}`).join(" ") +
        ` final=${best.length} (${bestHow})\n`,
    );
  }
  return pngOfForm(width, height, form, best);
}

// ---------------------------------------------------------------------------
// Entry point: every instance directory in the input dir, in sorted order.
// ---------------------------------------------------------------------------

function squeezeFile(inputPath: string, outputPath: string, id = ""): void {
  const image = decodePng(new Uint8Array(readFileSync(inputPath)));
  if (!image.ok) throw new Error(`${inputPath}: ${image.why}`);
  writeFileSync(outputPath, squeeze(image.rgba, image.width, image.height, id));
}

function main(): void {
  const a2 = process.argv[2];
  const a3 = process.argv[3];
  // Single-file mode: node main.ts in.png out.png
  if (a2 !== undefined && a3 !== undefined && a2.endsWith(".png") && a3.endsWith(".png")) {
    squeezeFile(a2, a3);
    return;
  }
  const inputDir = a2 ?? process.env.MAKEFUN_INPUT_DIR ?? "/input";
  const outputDir = a3 ?? process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  const ids = readdirSync(inputDir).sort().filter((id) => statSync(join(inputDir, id)).isDirectory());
  if (ids.length === 0) {
    // A flat directory holding image.png itself counts as one unnamed instance.
    mkdirSync(outputDir, { recursive: true });
    squeezeFile(join(inputDir, "image.png"), join(outputDir, "image.png"));
    return;
  }
  for (const id of ids) {
    mkdirSync(join(outputDir, id), { recursive: true });
    squeezeFile(join(inputDir, id, "image.png"), join(outputDir, id, "image.png"), id);
  }
}

main();
