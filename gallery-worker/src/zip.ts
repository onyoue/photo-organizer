/**
 * Streaming STORE-method ZIP encoder.
 *
 * STORE = no compression. Photos are already JPEG, so STORE adds zero
 * overhead and lets us avoid running a compression pass on every byte
 * (which would chew through Workers' free-tier CPU budget).
 *
 * CRC-32 of every file is expected to be pre-computed at upload time
 * (stored in R2 customMetadata) and passed in. That moves the CPU work
 * out of the ZIP request, which only relays bytes.
 *
 * No ZIP64 support: callers must stay under 4 GiB per file and 4 GiB
 * total. The gallery use case is tens of MB to hundreds of MB.
 */

const SIG_LFH = 0x04034b50;
const SIG_CDR = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const VERSION = 20;
const FLAG_UTF8 = 1 << 11;
const METHOD_STORE = 0;

// 1980-01-01 00:00:00 in DOS date/time. Gallery ZIPs don't surface real
// mtimes, and using a constant keeps the encoding stable.
const DOS_DATE = ((1980 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

interface ZipEntry {
  name: Uint8Array; // utf-8 filename
  crc: number;      // pre-computed CRC-32 (uint32)
  size: number;     // file size in bytes
  offset: number;   // byte offset of the local file header
}

export class ZipStreamWriter {
  private offset = 0;
  private entries: ZipEntry[] = [];

  /** Emit local file header + body bytes to `controller`, in order. */
  async writeFile(
    controller: ReadableStreamDefaultController<Uint8Array>,
    filename: string,
    crc: number,
    size: number,
    body: ReadableStream<Uint8Array>,
  ): Promise<void> {
    const name = new TextEncoder().encode(filename);
    const offset = this.offset;
    const lfh = localFileHeader(name, crc, size);
    controller.enqueue(lfh);
    this.offset += lfh.length;

    let written = 0;
    const reader = body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value.length > 0) {
          controller.enqueue(value);
          this.offset += value.length;
          written += value.length;
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (written !== size) {
      throw new Error(`size mismatch for ${filename}: declared ${size}, got ${written}`);
    }

    this.entries.push({ name, crc, size, offset });
  }

  /** Emit central directory + EOCD record. Caller must close the stream after. */
  finalize(controller: ReadableStreamDefaultController<Uint8Array>): void {
    const dirOffset = this.offset;
    for (const e of this.entries) {
      const cdr = centralDirEntry(e);
      controller.enqueue(cdr);
      this.offset += cdr.length;
    }
    const dirSize = this.offset - dirOffset;
    const eocd = endOfCentralDirectory(this.entries.length, dirSize, dirOffset);
    controller.enqueue(eocd);
    this.offset += eocd.length;
  }
}

function localFileHeader(name: Uint8Array, crc: number, size: number): Uint8Array {
  const out = new Uint8Array(30 + name.length);
  u32le(out, 0, SIG_LFH);
  u16le(out, 4, VERSION);
  u16le(out, 6, FLAG_UTF8);
  u16le(out, 8, METHOD_STORE);
  u16le(out, 10, DOS_TIME);
  u16le(out, 12, DOS_DATE);
  u32le(out, 14, crc);
  u32le(out, 18, size);
  u32le(out, 22, size);
  u16le(out, 26, name.length);
  u16le(out, 28, 0);
  out.set(name, 30);
  return out;
}

function centralDirEntry(e: ZipEntry): Uint8Array {
  const out = new Uint8Array(46 + e.name.length);
  u32le(out, 0, SIG_CDR);
  u16le(out, 4, VERSION);
  u16le(out, 6, VERSION);
  u16le(out, 8, FLAG_UTF8);
  u16le(out, 10, METHOD_STORE);
  u16le(out, 12, DOS_TIME);
  u16le(out, 14, DOS_DATE);
  u32le(out, 16, e.crc);
  u32le(out, 20, e.size);
  u32le(out, 24, e.size);
  u16le(out, 28, e.name.length);
  u16le(out, 30, 0);
  u16le(out, 32, 0);
  u16le(out, 34, 0);
  u16le(out, 36, 0);
  u32le(out, 38, 0);
  u32le(out, 42, e.offset);
  out.set(e.name, 46);
  return out;
}

function endOfCentralDirectory(count: number, dirSize: number, dirOffset: number): Uint8Array {
  const out = new Uint8Array(22);
  u32le(out, 0, SIG_EOCD);
  u16le(out, 4, 0);
  u16le(out, 6, 0);
  u16le(out, 8, count);
  u16le(out, 10, count);
  u32le(out, 12, dirSize);
  u32le(out, 16, dirOffset);
  u16le(out, 20, 0);
  return out;
}

function u16le(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v & 0xff;
  buf[off + 1] = (v >>> 8) & 0xff;
}

function u32le(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v & 0xff;
  buf[off + 1] = (v >>> 8) & 0xff;
  buf[off + 2] = (v >>> 16) & 0xff;
  buf[off + 3] = (v >>> 24) & 0xff;
}

// ---------- CRC-32 ----------------------------------------------------------

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[i] = c;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Resolve duplicate filenames within a single ZIP by appending " (n)"
 * before the extension. Mirrors macOS/Windows save-as behaviour.
 */
export function dedupeFilenames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const lower = name.toLowerCase();
    const count = seen.get(lower) ?? 0;
    seen.set(lower, count + 1);
    if (count === 0) return name;
    const dot = name.lastIndexOf(".");
    if (dot <= 0) return `${name} (${count})`;
    return `${name.slice(0, dot)} (${count})${name.slice(dot)}`;
  });
}
