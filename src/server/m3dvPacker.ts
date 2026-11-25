import type { M3dvHeader, M3dvGroupMeta } from '../shared/types.js';

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
 * Packs parsed multi-group 3D geometry into a compact little-endian M3DV v1 buffer:
 * [0..3]   "M3DV"
 * [4..7]   version = 1 (uint32 LE)
 * [8..11]  headerJsonLen (uint32 LE)
 * [12..]   UTF-8 JSON header, zero-padded to 4-byte boundary
 * [...]    Contiguous Float32Array of all group positions
 * [...]    Contiguous Uint32Array of all group indices
 */
export function packM3dv(input: PackM3dvInput): Buffer {
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

  const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const paddedHeaderLen = (headerBuf.length + 3) & ~3;
  const positionsByteLen = totalVertexFloats * 4;
  const indicesByteLen = totalIndices * 4;
  const totalBytes = 12 + paddedHeaderLen + positionsByteLen + indicesByteLen;

  const out = Buffer.allocUnsafe(totalBytes);
  out.write('M3DV', 0, 'ascii');
  out.writeUInt32LE(1, 4);
  out.writeUInt32LE(headerBuf.length, 8);
  headerBuf.copy(out, 12);
  if (paddedHeaderLen > headerBuf.length) {
    out.fill(0, 12 + headerBuf.length, 12 + paddedHeaderLen);
  }

  let offset = 12 + paddedHeaderLen;
  for (const g of input.groups) {
    if (g.positions.length === 0 || g.indices.length === 0) continue;
    const src = Buffer.from(g.positions.buffer, g.positions.byteOffset, g.positions.byteLength);
    src.copy(out, offset);
    offset += src.length;
  }

  for (const g of input.groups) {
    if (g.positions.length === 0 || g.indices.length === 0) continue;
    const src = Buffer.from(g.indices.buffer, g.indices.byteOffset, g.indices.byteLength);
    src.copy(out, offset);
    offset += src.length;
  }

  return out;
}
