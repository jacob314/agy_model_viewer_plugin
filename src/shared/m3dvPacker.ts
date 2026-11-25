import type { M3dvHeader, M3dvGroupMeta } from './types.js';

export interface GeometryGroupInput {
  name: string;
  color: string;
  filamentName?: string;
  positions: Float32Array;
  indices: Uint32Array;
  isMonochromeDefault?: boolean;
}

export interface PackM3dvInput {
  format: '3mf' | 'stl';
  upAxis: 'z' | 'y';
  dimensionsMm: [number, number, number];
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
  originalTriangleCount: number;
  displayedTriangleCount: number;
  decimated: boolean;
  hasExplicitColors: boolean;
  groups: GeometryGroupInput[];
}

/**
 * Runtime-agnostic (Node + Browser) M3DV v1 packer returning a Uint8Array:
 * [0..3]   "M3DV"
 * [4..7]   version = 1 (uint32 LE)
 * [8..11]  headerJsonLen (uint32 LE)
 * [12..]   UTF-8 JSON header, zero-padded to 4-byte boundary
 * [...]    Contiguous Float32Array of all group positions
 * [...]    Contiguous Uint32Array of all group indices
 */
export function packM3dvBytes(input: PackM3dvInput): Uint8Array {
  const groupMetas: M3dvGroupMeta[] = [];
  let totalVertexFloats = 0;
  let totalIndices = 0;

  for (const g of input.groups) {
    if (g.positions.length === 0 || g.indices.length === 0) continue;
    groupMetas.push({
      name: g.name,
      color: g.color,
      filamentName: g.filamentName,
      vertexOffset: totalVertexFloats,
      vertexCount: g.positions.length / 3,
      indexOffset: totalIndices,
      indexCount: g.indices.length,
      isMonochromeDefault: g.isMonochromeDefault,
    });
    totalVertexFloats += g.positions.length;
    totalIndices += g.indices.length;
  }

  const header: M3dvHeader = {
    version: 1,
    format: input.format,
    upAxis: input.upAxis,
    dimensionsMm: input.dimensionsMm,
    bboxMin: input.bboxMin,
    bboxMax: input.bboxMax,
    originalTriangleCount: input.originalTriangleCount,
    displayedTriangleCount: input.displayedTriangleCount,
    decimated: input.decimated,
    hasExplicitColors: input.hasExplicitColors,
    totalVertexFloats,
    totalIndices,
    groups: groupMetas,
  };

  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const paddedHeaderLen = (headerBytes.length + 3) & ~3;
  const positionsByteLen = totalVertexFloats * 4;
  const indicesByteLen = totalIndices * 4;
  const totalBytes = 12 + paddedHeaderLen + positionsByteLen + indicesByteLen;

  const out = new Uint8Array(totalBytes);
  const view = new DataView(out.buffer);
  out[0] = 0x4d; // 'M'
  out[1] = 0x33; // '3'
  out[2] = 0x44; // 'D'
  out[3] = 0x56; // 'V'
  view.setUint32(4, 1, true);
  view.setUint32(8, headerBytes.length, true);
  out.set(headerBytes, 12);

  let offset = 12 + paddedHeaderLen;
  for (const g of input.groups) {
    if (g.positions.length === 0 || g.indices.length === 0) continue;
    const src = new Uint8Array(g.positions.buffer, g.positions.byteOffset, g.positions.byteLength);
    out.set(src, offset);
    offset += src.byteLength;
  }

  for (const g of input.groups) {
    if (g.positions.length === 0 || g.indices.length === 0) continue;
    const src = new Uint8Array(g.indices.buffer, g.indices.byteOffset, g.indices.byteLength);
    out.set(src, offset);
    offset += src.byteLength;
  }

  return out;
}
