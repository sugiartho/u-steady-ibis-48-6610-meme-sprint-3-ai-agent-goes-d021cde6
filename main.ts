// Meme Sprint 3: AI Agent Goes Rogue (Node 22, standard library only).
//
// The entry is one image meme about an AI agent that has gone rogue. This
// program draws it from scratch: it reads MEME.json from the repository
// root (the joke's lines, the palette, the canvas size), checks every line
// is text the built-in bitmap font can draw, paints a chat scene pixel by
// pixel into an RGB buffer, encodes the buffer as a PNG with node:zlib,
// and writes it to /output/entry.png, where the judge reads it.
//
// The picture must pass the gate: a whole PNG, at most 1 MiB and at most
// 1024 by 1024 pixels. After writing, the program reads the file back and
// verifies the PNG magic, the IHDR size, every chunk CRC, and that the
// IDAT data inflates to exactly the scanlines it drew.
//
// Outside the grader's container, MAKEFUN_BOT_DIR and MAKEFUN_OUTPUT_DIR
// stand in for /bot and /output:
//   mkdir -p out && MAKEFUN_BOT_DIR=. MAKEFUN_OUTPUT_DIR=out node main.ts

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";
import { join } from "node:path";

const BOT_DIR = process.env.MAKEFUN_BOT_DIR ?? "/bot";
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
const MAX_BYTES = 1048576;
const MAX_DIM = 1024;

// A 5 by 7 pixel font, one glyph per character, rows top to bottom.
// Only the characters the meme needs are defined; anything else is an
// error, so a typo in MEME.json fails loudly instead of drawing garbage.
const FONT: Record<string, string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "7": ["11111", "00001", "00010", "00100", "00100", "00100", "00100"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  "'": ["00100", "00100", "01000", "00000", "00000", "00000", "00000"],
  "?": ["01110", "10001", "00001", "00110", "00100", "00000", "00100"],
  "-": ["00000", "00000", "00000", "01110", "00000", "00000", "00000"],
};

// PNG plumbing: CRC-32 (the same table the format uses) and chunk writer.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 0);
  return Buffer.concat([head, data, tail]);
}

function encodePng(rgb: Uint8Array, width: number, height: number): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0; // filter: none
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), rowStart + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type 2: truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// A canvas: an RGB pixel buffer with flat fills, circles, rounded
// rectangles and bitmap text. Every coordinate is clipped to the canvas,
// so a layout slip draws nothing outside the picture instead of crashing.
type RGB = [number, number, number];

function hex(rgb: string): RGB {
  const n = parseInt(rgb.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

class Canvas {
  readonly width: number;
  readonly height: number;
  private pixels: Uint8Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height * 3);
  }

  set(x: number, y: number, [r, g, b]: RGB): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 3;
    this.pixels[i] = r;
    this.pixels[i + 1] = g;
    this.pixels[i + 2] = b;
  }

  fillRect(x: number, y: number, w: number, h: number, color: RGB): void {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) this.set(xx, yy, color);
    }
  }

  fillCircle(cx: number, cy: number, r: number, color: RGB): void {
    for (let yy = cy - r; yy <= cy + r; yy++) {
      const dy = yy - cy;
      const dx = Math.floor(Math.sqrt(r * r - dy * dy));
      for (let xx = cx - dx; xx <= cx + dx; xx++) this.set(xx, yy, color);
    }
  }

  // A rectangle with rounded corners: a point is in when it is inside
  // the straight middle or within one corner circle's radius.
  fillRoundRect(x: number, y: number, w: number, h: number, r: number, color: RGB): void {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        const dx = Math.max(x + r - xx, 0, xx - (x + w - r));
        const dy = Math.max(y + r - yy, 0, yy - (y + h - r));
        if (dx * dx + dy * dy <= r * r) this.set(xx, yy, color);
      }
    }
  }

  textWidth(text: string, scale: number): number {
    return text.length * 6 * scale;
  }

  drawText(text: string, x: number, y: number, scale: number, color: RGB): void {
    for (let i = 0; i < text.length; i++) {
      const glyph = FONT[text[i]];
      if (!glyph) throw new Error(`no glyph for character ${JSON.stringify(text[i])}`);
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (glyph[row][col] !== "1") continue;
          this.fillRect(x + (i * 6 + col) * scale, y + row * scale, scale, scale, color);
        }
      }
    }
  }

  // The raw scanlines the PNG encoder writes: one filter byte per row
  // (none) followed by the row's RGB bytes. The round-trip check in
  // verifyPng compares the inflated IDAT data against exactly this.
  rawScanlines(): Buffer {
    const raw = Buffer.alloc(this.height * (1 + this.width * 3));
    for (let row = 0; row < this.height; row++) {
      const start = row * (1 + this.width * 3);
      raw[start] = 0;
      raw.set(this.pixels.subarray(row * this.width * 3, (row + 1) * this.width * 3), start + 1);
    }
    return raw;
  }

  toPng(): Buffer {
    return encodePng(this.pixels, this.width, this.height);
  }
}

function readSpec(): any {
  const source = join(BOT_DIR, "MEME.json");
  if (!existsSync(source)) throw new Error("MEME.json is missing from the repository root");
  const spec = JSON.parse(readFileSync(source, "utf8"));
  if (!Number.isInteger(spec.width) || !Number.isInteger(spec.height)) {
    throw new Error("MEME.json must name an integer width and height");
  }
  if (spec.width < 1 || spec.width > MAX_DIM || spec.height < 1 || spec.height > MAX_DIM) {
    throw new Error(`canvas must be at most ${MAX_DIM} by ${MAX_DIM}`);
  }
  const groups: any[][] = [spec.agent, [spec.human], [spec.kicker]];
  const headerLines = [spec.header?.name].filter((x) => typeof x === "string");
  for (const line of headerLines) {
    for (const ch of line) {
      if (!FONT[ch]) throw new Error(`header uses a character the font cannot draw: ${JSON.stringify(ch)}`);
    }
  }
  for (const group of groups) {
    for (const bubble of group) {
      if (!Array.isArray(bubble.lines) || bubble.lines.length === 0) {
        throw new Error("every bubble needs at least one line of text");
      }
      for (const line of bubble.lines) {
        if (typeof line !== "string" || line.trim().length === 0) {
          throw new Error("bubble lines must be non-empty text");
        }
        for (const ch of line) {
          if (!FONT[ch]) throw new Error(`line uses a character the font cannot draw: ${JSON.stringify(ch)}`);
        }
      }
      if (!Number.isInteger(bubble.scale) || bubble.scale < 1 || bubble.scale > 10) {
        throw new Error("bubble scale must be an integer from 1 to 10");
      }
    }
  }
  return spec;
}

function drawMeme(spec: any): Canvas {
  const W = spec.width;
  const H = spec.height;
  const pal = spec.palette;
  const c = new Canvas(W, H);
  const bg = hex(pal.background);
  const headerBg = hex(pal.header);
  const humanBg = hex(pal.human_bubble);
  const agentBg = hex(pal.agent_bubble);
  const white = hex(pal.text_white);
  const dark = hex(pal.text_dark);
  const teal = hex(pal.avatar);
  const avatarDark = hex(pal.avatar_dark);
  const green = hex(pal.online);
  const yellow = hex(pal.kicker);
  const dotGrey = hex(pal.typing_dot);

  c.fillRect(0, 0, W, H, bg);

  // Header bar: the agent's avatar, its name, and the green online dot.
  const headerH = 104;
  c.fillRect(0, 0, W, headerH, headerBg);
  c.fillCircle(70, 52, 30, teal);
  c.fillRect(68, 8, 4, 16, teal);
  c.fillCircle(70, 8, 5, yellow);
  c.fillCircle(58, 48, 5, avatarDark);
  c.fillCircle(82, 48, 5, avatarDark);
  c.fillRect(58, 64, 24, 4, avatarDark);
  c.fillCircle(92, 76, 11, headerBg);
  c.fillCircle(92, 76, 8, green);
  const nameScale = spec.header.scale;
  c.drawText(spec.header.name, 118, (headerH - 7 * nameScale) / 2, nameScale, white);

  // Chat bubbles, stacked with a fixed gap. The human's bubble hugs the
  // right edge; the agent's hug the left, like any chat app.
  const margin = 40;
  const radius = 28;
  const gap = 52;
  let y = headerH + gap;

  const drawBubble = (lines: string[], scale: number, right: boolean, color: RGB): number => {
    const lineH = 7 * scale;
    const lineGap = 12;
    const pad = 28;
    const textW = Math.max(...lines.map((line) => c.textWidth(line, scale)));
    const w = textW + pad * 2;
    const h = lines.length * lineH + (lines.length - 1) * lineGap + pad * 2;
    const x = right ? W - margin - w : margin;
    c.fillRoundRect(x, y, w, h, radius, color);
    const blockH = lines.length * lineH + (lines.length - 1) * lineGap;
    let ty = y + (h - blockH) / 2;
    for (const line of lines) {
      c.drawText(line, x + pad, ty, scale, white);
      ty += lineH + lineGap;
    }
    return h;
  };

  y += drawBubble(spec.human.lines, spec.human.scale, true, humanBg) + gap;
  for (const bubble of spec.agent) {
    y += drawBubble(bubble.lines, bubble.scale, false, agentBg) + gap;
  }

  // The typing dots: the agent is still typing, right before the kicker.
  const typingY = y;
  c.fillRoundRect(margin, typingY, 132, 56, radius, agentBg);
  for (let i = 0; i < 3; i++) c.fillCircle(margin + 32 + i * 34, typingY + 28, 7, dotGrey);

  // Kicker bar along the bottom: the punchline, in black on yellow.
  const kickerH = 144;
  const kickerY = H - kickerH;
  c.fillRect(0, kickerY, W, kickerH, yellow);
  const kicker = spec.kicker;
  const kickerText = kicker.lines[0];
  const kx = (W - c.textWidth(kickerText, kicker.scale)) / 2;
  const ky = kickerY + (kickerH - 7 * kicker.scale) / 2;
  c.drawText(kickerText, kx, ky, kicker.scale, dark);
  return c;
}

// Read the written PNG back and prove it is the picture just drawn:
// magic, size, every chunk CRC, and the IDAT data inflating to exactly
// the scanlines that were encoded.
function verifyPng(file: Buffer, expected: Buffer, width: number, height: number): void {
  if (file.length > MAX_BYTES) throw new Error(`entry.png is ${file.length} bytes, over the 1 MiB gate`);
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!file.subarray(0, 8).equals(magic)) throw new Error("entry.png is not a PNG");
  let pos = 8;
  let seenIhdr = false;
  let seenIend = false;
  const idat: Buffer[] = [];
  while (pos < file.length) {
    if (pos + 8 > file.length) throw new Error("truncated PNG chunk header");
    const len = file.readUInt32BE(pos);
    const type = file.subarray(pos + 4, pos + 8).toString("ascii");
    const data = file.subarray(pos + 8, pos + 8 + len);
    if (data.length !== len || pos + 12 + len > file.length) throw new Error(`truncated PNG chunk ${type}`);
    const storedCrc = file.readUInt32BE(pos + 8 + len);
    if (crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) !== storedCrc) {
      throw new Error(`bad CRC in PNG chunk ${type}`);
    }
    if (type === "IHDR") {
      if (len !== 13) throw new Error("bad IHDR length");
      if (data.readUInt32BE(0) !== width || data.readUInt32BE(4) !== height) {
        throw new Error("IHDR size does not match the canvas");
      }
      seenIhdr = true;
    }
    if (type === "IDAT") idat.push(data);
    if (type === "IEND") seenIend = true;
    pos += 12 + len;
  }
  if (!seenIhdr || !seenIend) throw new Error("PNG is missing IHDR or IEND");
  const inflated = inflateSync(Buffer.concat(idat));
  if (inflated.length !== height * (1 + width * 3)) throw new Error("IDAT does not inflate to the canvas scanlines");
  if (!inflated.equals(expected)) throw new Error("round-trip check failed: inflated scanlines differ from the canvas");
}

const spec = readSpec();
const canvas = drawMeme(spec);
const png = canvas.toPng();
const target = join(OUTPUT_DIR, "entry.png");
mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(target, png);

// Rebuild the raw scanlines the encoder wrote, for the round-trip check.
verifyPng(readFileSync(target), canvas.rawScanlines(), spec.width, spec.height);
console.log(`meme ${spec.width}x${spec.height}, entry.png ${png.length} bytes (gate: at most 1048576)`);
