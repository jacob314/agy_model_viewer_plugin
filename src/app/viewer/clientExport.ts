import * as THREE from 'three';
import { getBambuLut, rgbToHex } from '../../shared/bambu/colorMatch.js';
import type { BambuPaletteScope } from '../../shared/bambu/palette.js';
import {
  buildBambu3mf,
  buildBinaryStl,
  type ExportMeshGroup,
  type ExportedFilamentInfo,
} from '../../shared/exporters.js';
import type { ExportFormatOption } from '../../shared/types.js';
import type { LoadedModelBundle } from './loadModel.js';

interface TextureSampler {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  flipY: boolean;
}

function buildTextureSampler(texture: THREE.Texture | null): TextureSampler | null {
  if (!texture) return null;
  const img = texture.image as HTMLImageElement | HTMLCanvasElement | ImageBitmap | undefined;
  if (!img || !('width' in img) || !('height' in img) || !img.width || !img.height) {
    return null;
  }
  const maxDim = 512;
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img as CanvasImageSource, 0, 0, w, h);
  return {
    width: w,
    height: h,
    data: ctx.getImageData(0, 0, w, h).data,
    flipY: texture.flipY,
  };
}

function sampleTextureRgb(sampler: TextureSampler, u: number, v: number): [number, number, number] {
  const wu = ((u % 1) + 1) % 1;
  const wv = ((v % 1) + 1) % 1;
  const px = Math.min(sampler.width - 1, Math.max(0, Math.floor(wu * sampler.width)));
  const pyRaw = sampler.flipY ? 1 - wv : wv;
  const py = Math.min(sampler.height - 1, Math.max(0, Math.floor(pyRaw * sampler.height)));
  const off = (py * sampler.width + px) * 4;
  return [sampler.data[off], sampler.data[off + 1], sampler.data[off + 2]];
}

/**
 * Extracts Z-up millimeter ExportMeshGroups from a loaded Three.js bundle
 * (supports discrete materials, vertex colors, and textured GLB/OBJ quantized into AMS Bambu filaments).
 */
function extractGroupsFromBundle(
  bundle: LoadedModelBundle,
  colorOn: boolean,
  bambuScope: BambuPaletteScope,
  maxAmsColors = 8,
): ExportMeshGroup[] {
  // Temporarily clear user turntable rotation so exported print orientation stays upright & unrotated
  const savedRotY = bundle.pivotGroup.rotation.y;
  bundle.pivotGroup.rotation.y = 0;
  bundle.pivotGroup.updateMatrixWorld(true);

  const invScale = bundle.normalizeScale > 1e-6 ? 1 / bundle.normalizeScale : 1;
  // Note: GLB models exported in meters (e.g. 0.15m) vs mm: if max dimension < 2.5, assume meters -> convert to mm!
  const rawMaxMm = Math.max(bundle.dimensionsMm[0], bundle.dimensionsMm[1], bundle.dimensionsMm[2]);
  const unitFactor = rawMaxMm > 0 && rawMaxMm < 2.5 ? 1000 : 1;
  const worldToMm = invScale * unitFactor;

  const groups: ExportMeshGroup[] = [];
  const lut = getBambuLut(bambuScope);
  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const tmpColor = new THREE.Color();

  // Convert Three.js Y-up (x, y, z) -> Bambu Studio Z-up (x, -z, y) in millimeters
  const toZupMm = (v: THREE.Vector3): [number, number, number] => [
    v.x * worldToMm,
    -v.z * worldToMm,
    v.y * worldToMm,
  ];

  for (const rec of bundle.appearance.records) {
    const mesh = rec.mesh;
    const geo = mesh.geometry;
    const posAttr = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!posAttr) continue;

    const idxAttr = geo.getIndex();
    const triCount = idxAttr ? Math.floor(idxAttr.count / 3) : Math.floor(posAttr.count / 3);
    if (triCount === 0) continue;

    mesh.updateMatrixWorld(true);
    const matWorld = mesh.matrixWorld;
    const mat = mesh.material as THREE.MeshStandardMaterial;

    const getIdx = (k: number) => (idxAttr ? idxAttr.getX(k) : k);

    // Textured or vertex-colored mesh -> quantize triangles into Bambu AMS filament buckets
    const uvAttr = geo.getAttribute('uv') as THREE.BufferAttribute | undefined;
    const colAttr = geo.getAttribute('color') as THREE.BufferAttribute | undefined;
    const sampler = colorOn && rec.originalMap && uvAttr ? buildTextureSampler(rec.originalMap) : null;
    const useVCol = colorOn && Boolean(rec.originalVertexColors) && Boolean(colAttr);

    if (sampler || useVCol) {
      const buckets = new Map<number, number[]>(); // lutEntryIndex -> flat xyz triples

      for (let t = 0; t < triCount; t++) {
        const a = getIdx(t * 3);
        const b = getIdx(t * 3 + 1);
        const c = getIdx(t * 3 + 2);

        v0.fromBufferAttribute(posAttr, a).applyMatrix4(matWorld);
        v1.fromBufferAttribute(posAttr, b).applyMatrix4(matWorld);
        v2.fromBufferAttribute(posAttr, c).applyMatrix4(matWorld);

        let r8 = 180, g8 = 180, b8 = 180;
        if (sampler && uvAttr) {
          const u = (uvAttr.getX(a) + uvAttr.getX(b) + uvAttr.getX(c)) / 3;
          const v = (uvAttr.getY(a) + uvAttr.getY(b) + uvAttr.getY(c)) / 3;
          [r8, g8, b8] = sampleTextureRgb(sampler, u, v);
        } else if (useVCol && rec.originalVertexColors) {
          const lr = (rec.originalVertexColors[a * 3] + rec.originalVertexColors[b * 3] + rec.originalVertexColors[c * 3]) / 3;
          const lg = (rec.originalVertexColors[a * 3 + 1] + rec.originalVertexColors[b * 3 + 1] + rec.originalVertexColors[c * 3 + 1]) / 3;
          const lb = (rec.originalVertexColors[a * 3 + 2] + rec.originalVertexColors[b * 3 + 2] + rec.originalVertexColors[c * 3 + 2]) / 3;
          tmpColor.setRGB(lr, lg, lb, THREE.LinearSRGBColorSpace);
          const srgb = { r: 0, g: 0, b: 0 };
          tmpColor.getRGB(srgb, THREE.SRGBColorSpace);
          r8 = Math.round(srgb.r * 255);
          g8 = Math.round(srgb.g * 255);
          b8 = Math.round(srgb.b * 255);
        }

        const lutIdx = lut.table[((r8 >> 3) << 10) | ((g8 >> 3) << 5) | (b8 >> 3)];
        let arr = buckets.get(lutIdx);
        if (!arr) {
          arr = [];
          buckets.set(lutIdx, arr);
        }
        const p0 = toZupMm(v0);
        const p1 = toZupMm(v1);
        const p2 = toZupMm(v2);
        arr.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
      }

      // Keep top maxAmsColors by triangle count; merge tail into nearest kept filament
      const ranked = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
      const kept = ranked.slice(0, maxAmsColors);
      const overflow = ranked.slice(maxAmsColors);

      for (const [ovIdx, coords] of overflow) {
        const ovRgb = lut.entries[ovIdx].rgb;
        let bestTarget = kept[0];
        let bestDist = Infinity;
        for (const kEntry of kept) {
          const kRgb = lut.entries[kEntry[0]].rgb;
          const d =
            (ovRgb[0] - kRgb[0]) ** 2 + (ovRgb[1] - kRgb[1]) ** 2 + (ovRgb[2] - kRgb[2]) ** 2;
          if (d < bestDist) {
            bestDist = d;
            bestTarget = kEntry;
          }
        }
        bestTarget[1].push(...coords);
      }

      for (const [entryIdx, coords] of kept) {
        const fil = lut.entries[entryIdx].filament;
        const pos = Float32Array.from(coords);
        const vertCount = pos.length / 3;
        const indices = new Uint32Array(vertCount);
        for (let i = 0; i < vertCount; i++) indices[i] = i;
        groups.push({
          name: `${fil.line} ${fil.name}`,
          color: fil.hex,
          filamentSettingsId: `Bambu ${fil.line} @${fil.name}`,
          positions: pos,
          indices,
        });
      }
      continue;
    }

    // Flat-color mesh (discrete material)
    const srgb = { r: 0, g: 0, b: 0 };
    mat.color.getRGB(srgb, THREE.SRGBColorSpace);
    const hex = colorOn ? rgbToHex(srgb.r * 255, srgb.g * 255, srgb.b * 255) : '#9CA3AF';

    const positions = new Float32Array(posAttr.count * 3);
    for (let i = 0; i < posAttr.count; i++) {
      v0.fromBufferAttribute(posAttr, i).applyMatrix4(matWorld);
      const [x, y, z] = toZupMm(v0);
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
    }

    const indices = new Uint32Array(triCount * 3);
    for (let i = 0; i < triCount * 3; i++) {
      indices[i] = getIdx(i);
    }

    groups.push({
      name: mesh.name || 'Part',
      color: hex,
      positions,
      indices,
    });
  }

  // Restore user's visual turntable rotation
  bundle.pivotGroup.rotation.y = savedRotY;
  bundle.pivotGroup.updateMatrixWorld(true);

  return groups;
}

export function exportBundleClientSide(params: {
  bundle: LoadedModelBundle;
  title: string;
  exportFormat: ExportFormatOption;
  bambuMatch: boolean;
  bambuScope: BambuPaletteScope;
  colorOn: boolean;
}): {
  bytes: Uint8Array;
  extWithDot: '.3mf' | '.stl';
  mimeType: string;
  triangleCount: number;
  filaments?: ExportedFilamentInfo[];
} {
  const groups = extractGroupsFromBundle(params.bundle, params.colorOn, params.bambuScope, 8);

  if (params.exportFormat === 'stl') {
    const { bytes, triangleCount } = buildBinaryStl(groups, true);
    return {
      bytes,
      extWithDot: '.stl',
      mimeType: 'model/stl',
      triangleCount,
    };
  }

  const snap = params.exportFormat === 'bambu-3mf-matched' || params.bambuMatch;
  const { bytes, filaments, triangleCount } = buildBambu3mf({
    title: params.title,
    groups,
    snapToBambu: snap,
    bambuScope: params.bambuScope,
    groundOnBuildPlate: true,
  });

  return {
    bytes,
    extWithDot: '.3mf',
    mimeType: 'model/3mf',
    triangleCount,
    filaments,
  };
}
