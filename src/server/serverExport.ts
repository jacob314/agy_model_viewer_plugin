import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { M3dvHeader } from '../shared/types.js';
import type { BambuPaletteScope } from '../shared/bambu/palette.js';
import {
  buildBambu3mf,
  buildBinaryStl,
  type ExportMeshGroup,
  type ExportedFilamentInfo,
} from '../shared/exporters.js';
import { parse3mfBytesToM3dv } from '../shared/parse3mf.js';
import { parseStlToM3dv } from './parseStl.js';

function unpackM3dvToGroups(bytes: Uint8Array): { header: M3dvHeader; groups: ExportMeshGroup[] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = view.getUint32(8, true);
  const header = JSON.parse(
    new TextDecoder('utf-8').decode(bytes.subarray(12, 12 + headerLen)),
  ) as M3dvHeader;

  const paddedHeaderLen = (headerLen + 3) & ~3;
  const posOffset = bytes.byteOffset + 12 + paddedHeaderLen;
  const posBytes = header.totalVertexFloats * 4;
  const idxOffset = posOffset + posBytes;

  const positions =
    posOffset % 4 === 0
      ? new Float32Array(bytes.buffer, posOffset, header.totalVertexFloats)
      : new Float32Array(bytes.slice(12 + paddedHeaderLen, 12 + paddedHeaderLen + posBytes).buffer);
  const indices =
    idxOffset % 4 === 0
      ? new Uint32Array(bytes.buffer, idxOffset, header.totalIndices)
      : new Uint32Array(
          bytes.slice(12 + paddedHeaderLen + posBytes, 12 + paddedHeaderLen + posBytes + header.totalIndices * 4).buffer,
        );

  const groups: ExportMeshGroup[] = header.groups.map((g) => ({
    name: g.name,
    color: g.color,
    filamentSettingsId: g.filamentName,
    positions: positions.subarray(g.vertexOffset, g.vertexOffset + g.vertexCount * 3),
    indices: indices.subarray(g.indexOffset, g.indexOffset + g.indexCount),
  }));

  return { header, groups };
}

export function pickNonClobberingPath(dirPath: string, baseStem: string, extWithDot: string): string {
  const safeStem = baseStem.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'model_export';
  const targetDir = dirPath && fs.existsSync(dirPath) ? dirPath : path.join(os.homedir(), 'Downloads');
  fs.mkdirSync(targetDir, { recursive: true });

  let candidate = path.join(targetDir, `${safeStem}${extWithDot}`);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(targetDir, `${safeStem}_${n}${extWithDot}`);
    n++;
  }
  return candidate;
}

export function exportServerRegisteredModel(params: {
  absPath: string;
  format: '3mf' | 'stl';
  label: string;
  defaultColor: string;
  exportFormat: 'bambu-3mf' | 'bambu-3mf-matched' | 'stl';
  snapToBambu: boolean;
  bambuScope: BambuPaletteScope;
  colorOn: boolean;
}): {
  savedPath: string;
  fileName: string;
  sizeBytes: number;
  triangleCount: number;
  filaments?: ExportedFilamentInfo[];
} {
  const dirPath = path.dirname(params.absPath);
  const origStem = path.basename(params.absPath, path.extname(params.absPath));
  const rawBuf = fs.readFileSync(params.absPath);

  // Fast path: full-resolution STL -> STL export (preserves 100% original geometry without decimation)
  if (params.format === 'stl' && params.exportFormat === 'stl') {
    const savedPath = pickNonClobberingPath(dirPath, `${origStem}_print`, '.stl');
    fs.writeFileSync(savedPath, rawBuf);
    const triCount = rawBuf.length >= 84 ? rawBuf.readUInt32LE(80) : 0;
    return {
      savedPath,
      fileName: path.basename(savedPath),
      sizeBytes: rawBuf.length,
      triangleCount: triCount,
    };
  }

  // Parse into Z-up mm groups
  const m3dvBytes =
    params.format === '3mf'
      ? parse3mfBytesToM3dv(new Uint8Array(rawBuf.buffer, rawBuf.byteOffset, rawBuf.byteLength), params.defaultColor)
      : (() => {
          const b = parseStlToM3dv(rawBuf, params.defaultColor);
          return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
        })();

  const { groups } = unpackM3dvToGroups(m3dvBytes);

  if (params.exportFormat === 'stl') {
    const { bytes, triangleCount } = buildBinaryStl(groups, true);
    const savedPath = pickNonClobberingPath(dirPath, `${origStem}_print`, '.stl');
    fs.writeFileSync(savedPath, bytes);
    return {
      savedPath,
      fileName: path.basename(savedPath),
      sizeBytes: bytes.byteLength,
      triangleCount,
    };
  }

  const effectiveGroups = params.colorOn
    ? groups
    : groups.map((g) => ({
        ...g,
        name: 'Neutral Grey',
        color: '#9CA3AF',
        filamentSettingsId: 'Bambu PLA Matte @Ash Gray',
      }));

  const snap = params.exportFormat === 'bambu-3mf-matched' || params.snapToBambu;
  const suffix = snap ? '_bambu_matched' : '_bambu_multicolor';
  const { bytes, filaments, triangleCount } = buildBambu3mf({
    title: params.label || origStem,
    groups: effectiveGroups,
    snapToBambu: snap,
    bambuScope: params.bambuScope,
    groundOnBuildPlate: true,
  });

  const savedPath = pickNonClobberingPath(dirPath, `${origStem}${suffix}`, '.3mf');
  fs.writeFileSync(savedPath, bytes);
  return {
    savedPath,
    fileName: path.basename(savedPath),
    sizeBytes: bytes.byteLength,
    triangleCount,
    filaments,
  };
}
