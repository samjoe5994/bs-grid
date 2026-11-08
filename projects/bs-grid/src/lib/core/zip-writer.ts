/**
 * Minimal ZIP writer used for .xlsx export. Same approach as AG Grid's own ZipContainer (no
 * third-party zip library): CRC-32 + the browser's native CompressionStream('deflate-raw'),
 * falling back to stored (uncompressed) entries where that API is unavailable.
 */
interface ZipEntry {
  name: Uint8Array;
  data: Uint8Array;
  size: number;
  crc: number;
  method: number;
  offset: number;
}

/** Compressed zip (deflate via CompressionStream) — used for downloads, like AG Grid's getZipFile. */
export async function zipFiles(files: Record<string, string>, mimeType: string): Promise<Blob> {
  const enc = new TextEncoder();
  const entries: { path: string; raw: Uint8Array; deflated: Uint8Array | null }[] = [];
  for (const [path, text] of Object.entries(files)) {
    const raw = enc.encode(text);
    entries.push({ path, raw, deflated: await deflateRaw(raw) });
  }
  return assemble(entries, mimeType);
}

/** Uncompressed (stored) zip, synchronous — backs api.getDataAsExcel, like AG Grid's getUncompressedZipFile. */
export function zipFilesSync(files: Record<string, string>, mimeType: string): Blob {
  const enc = new TextEncoder();
  return assemble(Object.entries(files).map(([path, text]) => ({ path, raw: enc.encode(text), deflated: null })), mimeType);
}

function assemble(files: { path: string; raw: Uint8Array; deflated: Uint8Array | null }[], mimeType: string): Blob {
  const enc = new TextEncoder();
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const { path, raw, deflated } of files) {
    const entry: ZipEntry = {
      name: enc.encode(path),
      data: deflated ?? raw,
      size: raw.length,
      crc: crc32(raw),
      method: deflated ? 8 : 0,
      offset,
    };
    const local = header(entry, time, date, false);
    locals.push(local, entry.data);
    centrals.push(header(entry, time, date, true));
    offset += local.length + entry.data.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);        // end of central directory signature
  end.setUint16(8, centrals.length, true);   // entries on this disk
  end.setUint16(10, centrals.length, true);  // total entries
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);           // central directory offset
  return new Blob([...locals, ...centrals, end.buffer] as BlobPart[], { type: mimeType });
}

/** Local file header (30 bytes + name) or central directory header (46 bytes + name). */
function header(e: ZipEntry, time: number, date: number, central: boolean): Uint8Array {
  const buf = new Uint8Array((central ? 46 : 30) + e.name.length);
  const v = new DataView(buf.buffer);
  let p = 0;
  const u16 = (n: number) => { v.setUint16(p, n, true); p += 2; };
  const u32 = (n: number) => { v.setUint32(p, n >>> 0, true); p += 4; };
  u32(central ? 0x02014b50 : 0x04034b50);
  if (central) u16(20);                      // version made by
  u16(20);                                   // version needed to extract
  u16(0x0800);                               // flags: UTF-8 file names
  u16(e.method);
  u16(time);
  u16(date);
  u32(e.crc);
  u32(e.data.length);                        // compressed size
  u32(e.size);                               // uncompressed size
  u16(e.name.length);
  u16(0);                                    // extra field length
  if (central) {
    u16(0); u16(0); u16(0);                  // comment length, disk start, internal attrs
    u32(0);                                  // external attrs
    u32(e.offset);                           // local header offset
  }
  buf.set(e.name, p);
  return buf;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

let crcTable: Uint32Array | undefined;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = -1;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}
