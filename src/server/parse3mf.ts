import { parse3mfBytesToM3dv } from '../shared/parse3mf.js';

export function parse3mfToM3dv(buf: Buffer, defaultColor = '#4F8EF7'): Buffer {
  const out = parse3mfBytesToM3dv(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), defaultColor);
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}
