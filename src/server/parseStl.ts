import { packM3dv, type GeometryGroupInput } from './m3dvPacker.js';

const MAX_DISPLAY_TRIANGLES = 350_000;

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return (
    '#' +
    clamp(r).toString(16).padStart(2, '0') +
    clamp(g).toString(16).padStart(2, '0') +
    clamp(b).toString(16).padStart(2, '0')
  ).toUpperCase();
}

function isBinaryStl(buf: Buffer): boolean {
  if (buf.length < 84) return false;
  const triCount = buf.readUInt32LE(80);
  const expectedSize = 84 + triCount * 50;
  if (expectedSize === buf.length) return true;
  const head = buf.subarray(0, Math.min(256, buf.length)).toString('ascii').trimStart();
  if (head.startsWith('solid') && buf.subarray(0, Math.min(4096, buf.length)).toString('ascii').includes('facet')) {
    return false;
  }
  return expectedSize <= buf.length && triCount > 0;
}

/**
 * Spatial vertex-clustering decimation for massive STLs (>350k triangles).
 * Preserves sharp silhouette and proportions while making 50-135 MB plates smooth at 60 FPS.
 */
function decimateTriangles(
  rawCoords: Float32Array,
  triCount: number,
  bboxMin: [number, number, number],
  bboxMax: [number, number, number],
  targetTris: number,
): { positions: Float32Array; indices: Uint32Array } {
  const sx = Math.max(bboxMax[0] - bboxMin[0], 1e-5);
  const sy = Math.max(bboxMax[1] - bboxMin[1], 1e-5);
  const sz = Math.max(bboxMax[2] - bboxMin[2], 1e-5);
  const maxSpan = Math.max(sx, sy, sz);

  // Choose grid resolution so even wide flat build plates land cleanly near targetTris (~250k-350k)
  const gridRes = Math.max(48, Math.min(280, Math.round(Math.sqrt(targetTris * 0.22))));
  const invCell = gridRes / maxSpan;

  const cellMap = new Map<string, number>();
  const sumX: number[] = [];
  const sumY: number[] = [];
  const sumZ: number[] = [];
  const counts: number[] = [];
  const outIndices: number[] = [];

  const getCellVertex = (x: number, y: number, z: number): number => {
    const gx = Math.floor((x - bboxMin[0]) * invCell);
    const gy = Math.floor((y - bboxMin[1]) * invCell);
    const gz = Math.floor((z - bboxMin[2]) * invCell);
    const key = `${gx},${gy},${gz}`;
    let idx = cellMap.get(key);
    if (idx === undefined) {
      idx = counts.length;
      cellMap.set(key, idx);
      sumX.push(x);
      sumY.push(y);
      sumZ.push(z);
      counts.push(1);
    } else {
      sumX[idx] += x;
      sumY[idx] += y;
      sumZ[idx] += z;
      counts[idx] += 1;
    }
    return idx;
  };

  for (let t = 0; t < triCount; t++) {
    const base = t * 9;
    const i0 = getCellVertex(rawCoords[base], rawCoords[base + 1], rawCoords[base + 2]);
    const i1 = getCellVertex(rawCoords[base + 3], rawCoords[base + 4], rawCoords[base + 5]);
    const i2 = getCellVertex(rawCoords[base + 6], rawCoords[base + 7], rawCoords[base + 8]);
    if (i0 !== i1 && i1 !== i2 && i2 !== i0) {
      outIndices.push(i0, i1, i2);
    }
  }

  const vCount = counts.length;
  const positions = new Float32Array(vCount * 3);
  for (let i = 0; i < vCount; i++) {
    const inv = 1 / counts[i];
    positions[i * 3] = sumX[i] * inv;
    positions[i * 3 + 1] = sumY[i] * inv;
    positions[i * 3 + 2] = sumZ[i] * inv;
  }

  return {
    positions,
    indices: Uint32Array.from(outIndices),
  };
}

function buildIndexedFromRaw(coords: Float32Array): { positions: Float32Array; indices: Uint32Array } {
  const map = new Map<string, number>();
  const verts: number[] = [];
  const totalVerts = coords.length / 3;
  const indices = new Uint32Array(totalVerts);

  for (let i = 0; i < totalVerts; i++) {
    const x = coords[i * 3];
    const y = coords[i * 3 + 1];
    const z = coords[i * 3 + 2];
    const key = `${Math.round(x * 10000)},${Math.round(y * 10000)},${Math.round(z * 10000)}`;
    let idx = map.get(key);
    if (idx === undefined) {
      idx = verts.length / 3;
      map.set(key, idx);
      verts.push(x, y, z);
    }
    indices[i] = idx;
  }

  return {
    positions: Float32Array.from(verts),
    indices,
  };
}

export function parseStlToM3dv(buf: Buffer, defaultColor = '#4F8EF7'): Buffer {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  if (isBinaryStl(buf)) {
    const triCount = buf.readUInt32LE(80);
    const headerAscii = buf.subarray(0, 80).toString('ascii');
    const isMaterialiseMagics = headerAscii.includes('COLOR=') || headerAscii.includes('MATERIAL=');

    let nonZeroAttrCount = 0;
    const sampleStep = Math.max(1, Math.floor(triCount / 2000));
    for (let t = 0; t < triCount; t += sampleStep) {
      const attr = buf.readUInt16LE(84 + t * 50 + 48);
      if (attr !== 0 && (isMaterialiseMagics || (attr & 0x8000) !== 0)) {
        nonZeroAttrCount++;
      }
    }
    const hasPerFaceColors = nonZeroAttrCount > 0;

    if (!hasPerFaceColors) {
      const rawCoords = new Float32Array(triCount * 9);
      for (let t = 0; t < triCount; t++) {
        const off = 84 + t * 50 + 12;
        const base = t * 9;
        for (let v = 0; v < 3; v++) {
          const x = buf.readFloatLE(off + v * 12);
          const y = buf.readFloatLE(off + v * 12 + 4);
          const z = buf.readFloatLE(off + v * 12 + 8);
          rawCoords[base + v * 3] = x;
          rawCoords[base + v * 3 + 1] = y;
          rawCoords[base + v * 3 + 2] = z;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
      }

      const bboxMin: [number, number, number] = [minX, minY, minZ];
      const bboxMax: [number, number, number] = [maxX, maxY, maxZ];
      let positions: Float32Array;
      let indices: Uint32Array;
      let decimated = false;

      if (triCount > MAX_DISPLAY_TRIANGLES) {
        const res = decimateTriangles(rawCoords, triCount, bboxMin, bboxMax, MAX_DISPLAY_TRIANGLES);
        positions = res.positions;
        indices = res.indices;
        decimated = true;
      } else {
        const res = buildIndexedFromRaw(rawCoords);
        positions = res.positions;
        indices = res.indices;
      }

      return packM3dv({
        format: 'stl',
        upAxis: 'z',
        dimensionsMm: [maxX - minX, maxY - minY, maxZ - minZ],
        bboxMin,
        bboxMax,
        originalTriangleCount: triCount,
        displayedTriangleCount: indices.length / 3,
        decimated,
        hasExplicitColors: false,
        groups: [
          {
            name: 'Model Mesh',
            color: defaultColor,
            positions,
            indices,
            isMonochromeDefault: true,
          },
        ],
      });
    } else {
      const colorBuckets = new Map<string, number[]>();
      for (let t = 0; t < triCount; t++) {
        const off = 84 + t * 50 + 12;
        const attr = buf.readUInt16LE(84 + t * 50 + 48);
        let hex = defaultColor;
        if (isMaterialiseMagics && (attr & 0x8000) === 0 && attr !== 0) {
          const r = ((attr & 0x1f) / 31) * 255;
          const g = (((attr >> 5) & 0x1f) / 31) * 255;
          const b = (((attr >> 10) & 0x1f) / 31) * 255;
          hex = rgbToHex(r, g, b);
        } else if ((attr & 0x8000) !== 0) {
          const b = ((attr & 0x1f) / 31) * 255;
          const g = (((attr >> 5) & 0x1f) / 31) * 255;
          const r = (((attr >> 10) & 0x1f) / 31) * 255;
          hex = rgbToHex(r, g, b);
        }
        let bucket = colorBuckets.get(hex);
        if (!bucket) {
          bucket = [];
          colorBuckets.set(hex, bucket);
        }
        for (let v = 0; v < 3; v++) {
          const x = buf.readFloatLE(off + v * 12);
          const y = buf.readFloatLE(off + v * 12 + 4);
          const z = buf.readFloatLE(off + v * 12 + 8);
          bucket.push(x, y, z);
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
      }

      const bboxMin: [number, number, number] = [minX, minY, minZ];
      const bboxMax: [number, number, number] = [maxX, maxY, maxZ];
      const groups: GeometryGroupInput[] = [];
      let displayed = 0;
      let idx = 1;
      for (const [hex, arr] of colorBuckets.entries()) {
        const raw = Float32Array.from(arr);
        const built = buildIndexedFromRaw(raw);
        displayed += built.indices.length / 3;
        groups.push({
          name: `Color ${idx++}`,
          color: hex,
          positions: built.positions,
          indices: built.indices,
        });
      }

      return packM3dv({
        format: 'stl',
        upAxis: 'z',
        dimensionsMm: [maxX - minX, maxY - minY, maxZ - minZ],
        bboxMin,
        bboxMax,
        originalTriangleCount: triCount,
        displayedTriangleCount: displayed,
        decimated: false,
        hasExplicitColors: true,
        groups,
      });
    }
  }

  // ASCII STL fallback
  const text = buf.toString('utf8');
  const vertexRegex = /vertex\s+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/g;
  const coords: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = vertexRegex.exec(text)) !== null) {
    const x = parseFloat(match[1]);
    const y = parseFloat(match[2]);
    const z = parseFloat(match[3]);
    coords.push(x, y, z);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  const triCount = Math.floor(coords.length / 9);
  const raw = Float32Array.from(coords.slice(0, triCount * 9));
  const bboxMin: [number, number, number] = triCount > 0 ? [minX, minY, minZ] : [0, 0, 0];
  const bboxMax: [number, number, number] = triCount > 0 ? [maxX, maxY, maxZ] : [1, 1, 1];
  const built =
    triCount > MAX_DISPLAY_TRIANGLES
      ? decimateTriangles(raw, triCount, bboxMin, bboxMax, MAX_DISPLAY_TRIANGLES)
      : buildIndexedFromRaw(raw);

  return packM3dv({
    format: 'stl',
    upAxis: 'z',
    dimensionsMm: [bboxMax[0] - bboxMin[0], bboxMax[1] - bboxMin[1], bboxMax[2] - bboxMin[2]],
    bboxMin,
    bboxMax,
    originalTriangleCount: triCount,
    displayedTriangleCount: built.indices.length / 3,
    decimated: triCount > MAX_DISPLAY_TRIANGLES,
    hasExplicitColors: false,
    groups: [
      {
        name: 'Model Mesh',
        color: defaultColor,
        positions: built.positions,
        indices: built.indices,
        isMonochromeDefault: true,
      },
    ],
  });
}
