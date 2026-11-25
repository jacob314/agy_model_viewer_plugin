import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPTIMIZE_SIZE_THRESHOLD = 6 * 1024 * 1024; // Optimize GLBs > 6 MB (or any Draco-compressed GLB)
const MAX_TOTAL_TRIANGLES = 240_000;
const TEXTURE_RESIZE_THRESHOLD = 350 * 1024; // Downscale embedded textures > 350 KB
const MAX_TEXTURE_DIM = 1024;

interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
  target?: number;
}

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT2' | 'MAT3' | 'MAT4';
  max?: number[];
  min?: number[];
}

interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
  extensions?: Record<string, unknown>;
}

interface GltfJson {
  asset: Record<string, unknown>;
  scene?: number;
  scenes?: unknown[];
  nodes?: unknown[];
  materials?: Array<Record<string, unknown>>;
  textures?: Array<{ sampler?: number; source?: number }>;
  samplers?: unknown[];
  images?: Array<{ bufferView?: number; mimeType?: string; uri?: string; name?: string }>;
  meshes?: Array<{ name?: string; primitives: GltfPrimitive[] }>;
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
  buffers?: Array<{ byteLength: number; uri?: string }>;
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  [key: string]: unknown;
}

// Lazy-loaded Three.js Draco JS decoder running inside Node VM (zero browser CSP / WASM issues)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let dracoModulePromise: Promise<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getDracoModule(): Promise<any> {
  if (dracoModulePromise) return dracoModulePromise;
  dracoModulePromise = (async () => {
    const candidates = [
      path.join(__dirname, 'draco_decoder.js'),
      path.resolve(__dirname, '../node_modules/three/examples/jsm/libs/draco/gltf/draco_decoder.js'),
    ];
    const decoderPath = candidates.find((p) => fs.existsSync(p));
    if (!decoderPath) {
      throw new Error('Draco decoder bundle not found (expected dist/draco_decoder.js)');
    }
    const code = fs.readFileSync(decoderPath, 'utf8');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sandbox: Record<string, any> = {
      console,
      setTimeout,
      clearTimeout,
      Uint8Array,
      Int8Array,
      Uint16Array,
      Int16Array,
      Uint32Array,
      Int32Array,
      Float32Array,
      Float64Array,
      ArrayBuffer,
      DataView,
      Math,
      Date,
      Object,
      Array,
      Error,
      TypeError,
      RangeError,
      String,
      Number,
      Boolean,
      RegExp,
      Promise,
      Map,
      Set,
      performance,
    };
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    vm.runInNewContext(code, sandbox);
    return sandbox.DracoDecoderModule();
  })();
  return dracoModulePromise;
}

function componentByteSize(ct: number): number {
  switch (ct) {
    case 5120:
    case 5121:
      return 1;
    case 5122:
    case 5123:
      return 2;
    case 5125:
    case 5126:
      return 4;
    default:
      return 4;
  }
}

function typeNumComponents(t: string): number {
  switch (t) {
    case 'SCALAR': return 1;
    case 'VEC2': return 2;
    case 'VEC3': return 3;
    case 'VEC4':
    case 'MAT2': return 4;
    case 'MAT3': return 9;
    case 'MAT4': return 16;
    default: return 1;
  }
}

function readComponent(view: DataView, offset: number, ct: number, normalized = false): number {
  switch (ct) {
    case 5126: return view.getFloat32(offset, true);
    case 5125: return view.getUint32(offset, true);
    case 5123: {
      const v = view.getUint16(offset, true);
      return normalized ? v / 65535 : v;
    }
    case 5122: {
      const v = view.getInt16(offset, true);
      return normalized ? Math.max(-1, v / 32767) : v;
    }
    case 5121: {
      const v = view.getUint8(offset);
      return normalized ? v / 255 : v;
    }
    case 5120: {
      const v = view.getInt8(offset);
      return normalized ? Math.max(-1, v / 127) : v;
    }
    default:
      return view.getFloat32(offset, true);
  }
}

function readAccessorAsFloat32(gltf: GltfJson, bin: Buffer, accIdx: number): Float32Array {
  const acc = gltf.accessors![accIdx];
  const bv = gltf.bufferViews![acc.bufferView!];
  const numComp = typeNumComponents(acc.type);
  const compBytes = componentByteSize(acc.componentType);
  const stride = bv.byteStride || numComp * compBytes;
  const baseOff = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const out = new Float32Array(acc.count * numComp);

  if (acc.componentType === 5126 && stride === numComp * 4) {
    for (let i = 0; i < acc.count * numComp; i++) {
      out[i] = view.getFloat32(baseOff + i * 4, true);
    }
    return out;
  }

  for (let i = 0; i < acc.count; i++) {
    const rowOff = baseOff + i * stride;
    for (let c = 0; c < numComp; c++) {
      out[i * numComp + c] = readComponent(
        view,
        rowOff + c * compBytes,
        acc.componentType,
        acc.normalized,
      );
    }
  }
  return out;
}

function readIndicesAsUint32(gltf: GltfJson, bin: Buffer, accIdx: number): Uint32Array {
  const acc = gltf.accessors![accIdx];
  const bv = gltf.bufferViews![acc.bufferView!];
  const compBytes = componentByteSize(acc.componentType);
  const stride = bv.byteStride || compBytes;
  const baseOff = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const out = new Uint32Array(acc.count);

  for (let i = 0; i < acc.count; i++) {
    const off = baseOff + i * stride;
    if (acc.componentType === 5125) out[i] = view.getUint32(off, true);
    else if (acc.componentType === 5123) out[i] = view.getUint16(off, true);
    else out[i] = view.getUint8(off);
  }
  return out;
}

interface DecodedPrimitive {
  positions: Float32Array;
  uvs: Float32Array | null;
  colors: Float32Array | null;
  colorComponents: number; // 3 or 4
  indices: Uint32Array;
}

async function decodeDracoPrimitive(
  bin: Buffer,
  bv: GltfBufferView,
  attrIds: Record<string, number>,
): Promise<DecodedPrimitive> {
  const draco = await getDracoModule();
  const decoder = new draco.Decoder();
  const dracoMesh = new draco.Mesh();
  const dracoBuf = new draco.DecoderBuffer();

  try {
    const start = bv.byteOffset || 0;
    const raw = new Int8Array(bin.buffer, bin.byteOffset + start, bv.byteLength);
    dracoBuf.Init(raw, raw.byteLength);

    const status = decoder.DecodeBufferToMesh(dracoBuf, dracoMesh);
    if (!status.ok() || dracoMesh.ptr === 0) {
      throw new Error(`Draco decode failed: ${status.error_msg()}`);
    }

    const numVerts = dracoMesh.num_points();
    const numFaces = dracoMesh.num_faces();

    // Decode triangle indices
    const indices = new Uint32Array(numFaces * 3);
    const face = new draco.DracoInt32Array();
    for (let f = 0; f < numFaces; f++) {
      decoder.GetFaceFromMesh(dracoMesh, f, face);
      indices[f * 3] = face.GetValue(0);
      indices[f * 3 + 1] = face.GetValue(1);
      indices[f * 3 + 2] = face.GetValue(2);
    }
    draco.destroy(face);

    const readFloatAttr = (uniqueId: number | undefined, numComp: number): Float32Array | null => {
      if (uniqueId === undefined) return null;
      const attr = decoder.GetAttributeByUniqueId(dracoMesh, uniqueId);
      if (!attr || attr.ptr === 0) return null;
      const arr = new draco.DracoFloat32Array();
      decoder.GetAttributeFloatForAllPoints(dracoMesh, attr, arr);
      const out = new Float32Array(numVerts * numComp);
      const actualComp = attr.num_components();
      for (let i = 0; i < numVerts; i++) {
        for (let c = 0; c < numComp; c++) {
          out[i * numComp + c] = c < actualComp ? arr.GetValue(i * actualComp + c) : 1;
        }
      }
      draco.destroy(arr);
      return out;
    };

    const positions = readFloatAttr(attrIds.POSITION, 3);
    if (!positions) throw new Error('Draco mesh missing POSITION attribute');
    const uvs = readFloatAttr(attrIds.TEXCOORD_0, 2);

    let colors: Float32Array | null = null;
    let colorComponents = 3;
    if (attrIds.COLOR_0 !== undefined) {
      const cAttr = decoder.GetAttributeByUniqueId(dracoMesh, attrIds.COLOR_0);
      if (cAttr && cAttr.ptr !== 0) {
        colorComponents = Math.min(4, Math.max(3, cAttr.num_components()));
        colors = readFloatAttr(attrIds.COLOR_0, colorComponents);
      }
    }

    return { positions, uvs, colors, colorComponents, indices };
  } finally {
    draco.destroy(dracoBuf);
    draco.destroy(dracoMesh);
    draco.destroy(decoder);
  }
}

/**
 * UV-seam-preserving spatial vertex clustering for huge GLB primitives (> targetTris).
 * Preserves sharp UV boundaries by including coarse UV tile coordinates in the cluster key.
 */
function decimatePrimitive(prim: DecodedPrimitive, targetTris: number): DecodedPrimitive {
  const triCount = Math.floor(prim.indices.length / 3);
  if (triCount <= targetTris) return prim;

  const pos = prim.positions;
  const uvs = prim.uvs;
  const cols = prim.colors;
  const cComp = prim.colorComponents;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  const maxSpan = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-5);
  const gridRes = Math.max(40, Math.min(260, Math.round(Math.sqrt(targetTris * 0.24))));
  const invCell = gridRes / maxSpan;

  const vCount = pos.length / 3;
  const origToCluster = new Int32Array(vCount);
  const cellMap = new Map<string, number>();

  const sumX: number[] = [];
  const sumY: number[] = [];
  const sumZ: number[] = [];
  const sumU: number[] = [];
  const sumV: number[] = [];
  const sumC: number[] = [];
  const counts: number[] = [];

  for (let i = 0; i < vCount; i++) {
    const x = pos[i * 3];
    const y = pos[i * 3 + 1];
    const z = pos[i * 3 + 2];
    const gx = Math.floor((x - minX) * invCell);
    const gy = Math.floor((y - minY) * invCell);
    const gz = Math.floor((z - minZ) * invCell);

    let key: string;
    if (uvs) {
      const u = uvs[i * 2];
      const v = uvs[i * 2 + 1];
      // Coarse UV bucket prevents merging across UV island seams!
      const uq = Math.floor(u * 12);
      const vq = Math.floor(v * 12);
      key = `${gx},${gy},${gz}|${uq},${vq}`;
    } else {
      key = `${gx},${gy},${gz}`;
    }

    let cIdx = cellMap.get(key);
    if (cIdx === undefined) {
      cIdx = counts.length;
      cellMap.set(key, cIdx);
      sumX.push(x);
      sumY.push(y);
      sumZ.push(z);
      if (uvs) {
        sumU.push(uvs[i * 2]);
        sumV.push(uvs[i * 2 + 1]);
      }
      if (cols) {
        for (let k = 0; k < cComp; k++) sumC.push(cols[i * cComp + k]);
      }
      counts.push(1);
    } else {
      sumX[cIdx] += x;
      sumY[cIdx] += y;
      sumZ[cIdx] += z;
      if (uvs) {
        sumU[cIdx] += uvs[i * 2];
        sumV[cIdx] += uvs[i * 2 + 1];
      }
      if (cols) {
        for (let k = 0; k < cComp; k++) sumC[cIdx * cComp + k] += cols[i * cComp + k];
      }
      counts[cIdx] += 1;
    }
    origToCluster[i] = cIdx;
  }

  const outIdx: number[] = [];
  const origIdx = prim.indices;
  for (let t = 0; t < triCount; t++) {
    const i0 = origToCluster[origIdx[t * 3]];
    const i1 = origToCluster[origIdx[t * 3 + 1]];
    const i2 = origToCluster[origIdx[t * 3 + 2]];
    if (i0 !== i1 && i1 !== i2 && i2 !== i0) {
      outIdx.push(i0, i1, i2);
    }
  }

  const newVCount = counts.length;
  const outPos = new Float32Array(newVCount * 3);
  const outUvs = uvs ? new Float32Array(newVCount * 2) : null;
  const outCols = cols ? new Float32Array(newVCount * cComp) : null;

  for (let i = 0; i < newVCount; i++) {
    const inv = 1 / counts[i];
    outPos[i * 3] = sumX[i] * inv;
    outPos[i * 3 + 1] = sumY[i] * inv;
    outPos[i * 3 + 2] = sumZ[i] * inv;
    if (outUvs) {
      outUvs[i * 2] = sumU[i] * inv;
      outUvs[i * 2 + 1] = sumV[i] * inv;
    }
    if (outCols) {
      for (let k = 0; k < cComp; k++) {
        outCols[i * cComp + k] = sumC[i * cComp + k] * inv;
      }
    }
  }

  return {
    positions: outPos,
    uvs: outUvs,
    colors: outCols,
    colorComponents: cComp,
    indices: Uint32Array.from(outIdx),
  };
}

function optimizeImageBuffer(
  imgBytes: Buffer,
  mimeType: string,
  preferJpeg: boolean,
): { bytes: Buffer; mimeType: string } {
  if (imgBytes.length <= TEXTURE_RESIZE_THRESHOLD) {
    return { bytes: imgBytes, mimeType };
  }
  // Use macOS `sips` when available (zero npm native deps, ultra-fast)
  if (process.platform !== 'darwin') {
    return { bytes: imgBytes, mimeType };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3dv-tex-'));
  try {
    const inExt = mimeType.includes('png') ? '.png' : mimeType.includes('webp') ? '.webp' : '.jpg';
    const inPath = path.join(tmpDir, `in${inExt}`);
    const outFormat = preferJpeg ? 'jpeg' : 'png';
    const outExt = preferJpeg ? '.jpg' : '.png';
    const outPath = path.join(tmpDir, `out${outExt}`);
    fs.writeFileSync(inPath, imgBytes);

    const args = ['-Z', String(MAX_TEXTURE_DIM), '-s', 'format', outFormat];
    if (preferJpeg) args.push('-s', 'formatOptions', '84');
    args.push(inPath, '--out', outPath);

    execFileSync('/usr/bin/sips', args, { stdio: 'ignore', timeout: 10_000 });
    const outBytes = fs.readFileSync(outPath);
    if (outBytes.length > 0 && outBytes.length < imgBytes.length) {
      return {
        bytes: outBytes,
        mimeType: preferJpeg ? 'image/jpeg' : 'image/png',
      };
    }
    return { bytes: imgBytes, mimeType };
  } catch {
    return { bytes: imgBytes, mimeType };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function pad4(buf: Buffer, padByte = 0x00): Buffer {
  const rem = buf.length % 4;
  if (rem === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(4 - rem, padByte)]);
}

/**
 * Optimizes large (> 6 MB) or Draco-compressed GLB v2 files server-side into a compact,
 * standard uncompressed GLB (< ~6 MB) that loads smoothly in WebGL without hitting MCP size limits.
 */
export async function optimizeGlbIfNeeded(rawBuf: Buffer): Promise<Buffer> {
  if (rawBuf.length < 20 || rawBuf.subarray(0, 4).toString('ascii') !== 'glTF') {
    return rawBuf;
  }

  const jsonChunkLen = rawBuf.readUInt32LE(12);
  const jsonChunkType = rawBuf.subarray(16, 20).toString('ascii');
  if (jsonChunkType !== 'JSON') return rawBuf;

  const gltf = JSON.parse(rawBuf.subarray(20, 20 + jsonChunkLen).toString('utf8')) as GltfJson;
  const hasDraco =
    Boolean(gltf.extensionsUsed?.includes('KHR_draco_mesh_compression')) ||
    Boolean(gltf.extensionsRequired?.includes('KHR_draco_mesh_compression'));

  // Small non-Draco GLBs pass through untouched!
  if (rawBuf.length <= OPTIMIZE_SIZE_THRESHOLD && !hasDraco) {
    return rawBuf;
  }

  const binHeaderOff = 20 + jsonChunkLen;
  if (binHeaderOff + 8 > rawBuf.length) return rawBuf;
  const binChunkLen = rawBuf.readUInt32LE(binHeaderOff);
  const binChunkType = rawBuf.subarray(binHeaderOff + 4, binHeaderOff + 8).toString('ascii');
  if (binChunkType !== 'BIN\0') return rawBuf;
  const binBuf = rawBuf.subarray(binHeaderOff + 8, binHeaderOff + 8 + binChunkLen);

  // Skip skinned/morphed animated rigs just in case — keep geometry pipeline focused on rigid 3D print models
  if (Array.isArray(gltf.skins) && gltf.skins.length > 0) {
    return rawBuf;
  }

  // Count total triangles across all primitives
  let totalTris = 0;
  const meshes = gltf.meshes || [];
  for (const mesh of meshes) {
    for (const prim of mesh.primitives) {
      if (prim.indices !== undefined && gltf.accessors?.[prim.indices]) {
        totalTris += Math.floor(gltf.accessors[prim.indices].count / 3);
      } else if (prim.attributes.POSITION !== undefined && gltf.accessors?.[prim.attributes.POSITION]) {
        totalTris += Math.floor(gltf.accessors[prim.attributes.POSITION].count / 3);
      }
    }
  }

  // Identify which image indices are used with alpha blending so we preserve PNG transparency if needed
  const alphaImages = new Set<number>();
  for (const mat of gltf.materials || []) {
    const alphaMode = mat.alphaMode as string | undefined;
    if (alphaMode === 'BLEND' || alphaMode === 'MASK') {
      const pbr = mat.pbrMetallicRoughness as { baseColorTexture?: { index?: number } } | undefined;
      const texIdx = pbr?.baseColorTexture?.index;
      if (texIdx !== undefined && gltf.textures?.[texIdx]?.source !== undefined) {
        alphaImages.add(gltf.textures[texIdx].source!);
      }
    }
  }

  // Build fresh compact BIN buffer + bufferViews + accessors
  const newBinParts: Buffer[] = [];
  let binCursor = 0;
  const newBufferViews: GltfBufferView[] = [];
  const newAccessors: GltfAccessor[] = [];

  const appendBufferView = (buf: Buffer, target?: number): number => {
    const padded = pad4(buf, 0x00);
    const bvIdx = newBufferViews.length;
    const bv: GltfBufferView = {
      buffer: 0,
      byteOffset: binCursor,
      byteLength: buf.length,
    };
    if (target !== undefined) bv.target = target;
    newBufferViews.push(bv);
    newBinParts.push(padded);
    binCursor += padded.length;
    return bvIdx;
  };

  // 1. Optimize & re-embed images
  const newImages = (gltf.images || []).map((img, idx) => {
    if (img.bufferView === undefined || !gltf.bufferViews?.[img.bufferView]) {
      return img;
    }
    const bv = gltf.bufferViews[img.bufferView];
    const start = bv.byteOffset || 0;
    const rawImg = binBuf.subarray(start, start + bv.byteLength);
    const mime = img.mimeType || 'image/png';
    const preferJpeg = !alphaImages.has(idx);
    const opt = optimizeImageBuffer(rawImg, mime, preferJpeg);
    const newBvIdx = appendBufferView(opt.bytes);
    return {
      ...img,
      bufferView: newBvIdx,
      mimeType: opt.mimeType,
    };
  });

  // 2. Decode, decimate (if needed), and repack all mesh primitives
  const newMeshes = [];
  for (const mesh of meshes) {
    const newPrimitives: GltfPrimitive[] = [];

    for (const prim of mesh.primitives) {
      let decoded: DecodedPrimitive;

      const dracoExt = prim.extensions?.KHR_draco_mesh_compression as
        | { bufferView: number; attributes: Record<string, number> }
        | undefined;

      if (dracoExt && gltf.bufferViews?.[dracoExt.bufferView]) {
        decoded = await decodeDracoPrimitive(
          binBuf,
          gltf.bufferViews[dracoExt.bufferView],
          dracoExt.attributes,
        );
      } else {
        const positions = readAccessorAsFloat32(gltf, binBuf, prim.attributes.POSITION);
        const uvs =
          prim.attributes.TEXCOORD_0 !== undefined
            ? readAccessorAsFloat32(gltf, binBuf, prim.attributes.TEXCOORD_0)
            : null;
        let colors: Float32Array | null = null;
        let colorComponents = 3;
        if (prim.attributes.COLOR_0 !== undefined) {
          const cAcc = gltf.accessors![prim.attributes.COLOR_0];
          colorComponents = typeNumComponents(cAcc.type);
          colors = readAccessorAsFloat32(gltf, binBuf, prim.attributes.COLOR_0);
        }
        let indices: Uint32Array;
        if (prim.indices !== undefined) {
          indices = readIndicesAsUint32(gltf, binBuf, prim.indices);
        } else {
          const vc = positions.length / 3;
          indices = new Uint32Array(vc);
          for (let i = 0; i < vc; i++) indices[i] = i;
        }
        decoded = { positions, uvs, colors, colorComponents, indices };
      }

      const primTris = Math.floor(decoded.indices.length / 3);
      if (totalTris > MAX_TOTAL_TRIANGLES && primTris > 20_000) {
        const budget = Math.max(
          20_000,
          Math.round((primTris / totalTris) * MAX_TOTAL_TRIANGLES),
        );
        decoded = decimatePrimitive(decoded, budget);
      }

      // Compute POSITION min/max (required by glTF 2.0 spec)
      const p = decoded.positions;
      const vCount = p.length / 3;
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let i = 0; i < p.length; i += 3) {
        if (p[i] < minX) minX = p[i]; if (p[i] > maxX) maxX = p[i];
        if (p[i + 1] < minY) minY = p[i + 1]; if (p[i + 1] > maxY) maxY = p[i + 1];
        if (p[i + 2] < minZ) minZ = p[i + 2]; if (p[i + 2] > maxZ) maxZ = p[i + 2];
      }

      const attrs: Record<string, number> = {};

      // POSITION
      const posBuf = Buffer.from(p.buffer, p.byteOffset, p.byteLength);
      const posBv = appendBufferView(posBuf, 34962);
      attrs.POSITION = newAccessors.length;
      newAccessors.push({
        bufferView: posBv,
        componentType: 5126,
        count: vCount,
        type: 'VEC3',
        min: [minX, minY, minZ],
        max: [maxX, maxY, maxZ],
      });

      // TEXCOORD_0
      if (decoded.uvs) {
        const uvBuf = Buffer.from(decoded.uvs.buffer, decoded.uvs.byteOffset, decoded.uvs.byteLength);
        const uvBv = appendBufferView(uvBuf, 34962);
        attrs.TEXCOORD_0 = newAccessors.length;
        newAccessors.push({
          bufferView: uvBv,
          componentType: 5126,
          count: vCount,
          type: 'VEC2',
        });
      }

      // COLOR_0
      if (decoded.colors) {
        const cBuf = Buffer.from(
          decoded.colors.buffer,
          decoded.colors.byteOffset,
          decoded.colors.byteLength,
        );
        const cBv = appendBufferView(cBuf, 34962);
        attrs.COLOR_0 = newAccessors.length;
        newAccessors.push({
          bufferView: cBv,
          componentType: 5126,
          count: vCount,
          type: decoded.colorComponents === 4 ? 'VEC4' : 'VEC3',
        });
      }

      // Indices (use Uint16 when vCount <= 65535 for half the size!)
      let idxCompType = 5125;
      let idxBuf: Buffer;
      if (vCount <= 65535) {
        const u16 = new Uint16Array(decoded.indices.length);
        u16.set(decoded.indices);
        idxBuf = Buffer.from(u16.buffer, u16.byteOffset, u16.byteLength);
        idxCompType = 5123;
      } else {
        idxBuf = Buffer.from(
          decoded.indices.buffer,
          decoded.indices.byteOffset,
          decoded.indices.byteLength,
        );
      }
      const idxBv = appendBufferView(idxBuf, 34963);
      const idxAcc = newAccessors.length;
      newAccessors.push({
        bufferView: idxBv,
        componentType: idxCompType,
        count: decoded.indices.length,
        type: 'SCALAR',
      });

      const newPrim: GltfPrimitive = {
        attributes: attrs,
        indices: idxAcc,
        material: prim.material,
        mode: prim.mode ?? 4,
      };
      newPrimitives.push(newPrim);
    }

    newMeshes.push({
      ...mesh,
      primitives: newPrimitives,
    });
  }

  // Strip KHR_draco_mesh_compression since we decoded it to clean standard glTF 2.0
  const extUsed = (gltf.extensionsUsed || []).filter((e) => e !== 'KHR_draco_mesh_compression');
  const extReq = (gltf.extensionsRequired || []).filter((e) => e !== 'KHR_draco_mesh_compression');

  const outGltf: GltfJson = {
    ...gltf,
    images: newImages.length > 0 ? newImages : undefined,
    meshes: newMeshes,
    accessors: newAccessors,
    bufferViews: newBufferViews,
    buffers: [{ byteLength: binCursor }],
    extensionsUsed: extUsed.length > 0 ? extUsed : undefined,
    extensionsRequired: extReq.length > 0 ? extReq : undefined,
  };

  const newJsonBuf = pad4(Buffer.from(JSON.stringify(outGltf), 'utf8'), 0x20);
  const newBinBuf = Buffer.concat(newBinParts);
  const totalLen = 12 + 8 + newJsonBuf.length + 8 + newBinBuf.length;

  const out = Buffer.allocUnsafe(totalLen);
  out.write('glTF', 0, 'ascii');
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(totalLen, 8);

  out.writeUInt32LE(newJsonBuf.length, 12);
  out.write('JSON', 16, 'ascii');
  newJsonBuf.copy(out, 20);

  const binOff = 20 + newJsonBuf.length;
  out.writeUInt32LE(newBinBuf.length, binOff);
  out.write('BIN\0', binOff + 4, 'ascii');
  newBinBuf.copy(out, binOff + 8);

  return out;
}
