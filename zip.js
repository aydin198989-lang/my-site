'use strict';

/** Минимальное чтение и запись ZIP (для .xlsx). Без библиотек: сжатие через встроенные Compression Streams. */
const ZipLib = (() => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const CRC_T = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    CRC_T[n] = c >>> 0;
  }
  function crc32(b) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  async function pipe(bytes, stream) {
    const s = new Blob([bytes]).stream().pipeThrough(stream);
    return new Uint8Array(await new Response(s).arrayBuffer());
  }

  function read(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('NOT_ZIP');
    const total = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = [];
    for (let i = 0; i < total; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('BAD_ZIP');
      const flags = dv.getUint16(p + 8, true);
      if (flags & 1) throw new Error('ENCRYPTED');
      const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const e = {
        name: dec.decode(buf.subarray(p + 46, p + 46 + nlen)),
        method: dv.getUint16(p + 10, true),
        time: dv.getUint16(p + 12, true),
        date: dv.getUint16(p + 14, true),
        crc: dv.getUint32(p + 16, true),
        csize: dv.getUint32(p + 20, true),
        usize: dv.getUint32(p + 24, true),
      };
      const lho = dv.getUint32(p + 42, true);
      const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
      e.data = buf.subarray(start, start + e.csize);
      entries.push(e);
      p += 46 + nlen + elen + clen;
    }
    return entries;
  }

  async function getData(e) {
    if (e.method === 0) return e.data;
    if (e.method === 8) return pipe(e.data, new DecompressionStream('deflate-raw'));
    throw new Error('UNSUPPORTED_METHOD');
  }

  async function setData(e, bytes) {
    e.data = await pipe(bytes, new CompressionStream('deflate-raw'));
    e.method = 8;
    e.crc = crc32(bytes);
    e.usize = bytes.length;
    e.csize = e.data.length;
  }

  function write(entries) {
    const parts = [], central = [];
    let offset = 0;
    for (const e of entries) {
      const name = enc.encode(e.name);
      const l = new Uint8Array(30 + name.length), lv = new DataView(l.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, e.method, true); lv.setUint16(10, e.time, true); lv.setUint16(12, e.date, true);
      lv.setUint32(14, e.crc, true); lv.setUint32(18, e.csize, true); lv.setUint32(22, e.usize, true);
      lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
      l.set(name, 30);

      const c = new Uint8Array(46 + name.length), cv = new DataView(c.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true); cv.setUint16(10, e.method, true);
      cv.setUint16(12, e.time, true); cv.setUint16(14, e.date, true);
      cv.setUint32(16, e.crc, true); cv.setUint32(20, e.csize, true); cv.setUint32(24, e.usize, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      c.set(name, 46);

      parts.push(l, e.data);
      central.push(c);
      offset += l.length + e.data.length;
    }
    const cdSize = central.reduce((s, c) => s + c.length, 0);
    const end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end],
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  return { read, getData, setData, write };
})();
