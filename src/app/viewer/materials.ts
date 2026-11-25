import * as THREE from 'three';
import {
  getBambuLut,
  hexToRgb,
  matchBambuHex,
  rgbToHex,
  type BambuMatchResult,
} from '../bambu/colorMatch.js';
import type { BambuPaletteScope } from '../bambu/palette.js';

export interface SwatchEntry {
  key: string;
  name: string;
  originalHex: string;
  filamentHint?: string;
  bambuMatch?: BambuMatchResult;
  muted: boolean;
}

export interface MaterialRecord {
  mesh: THREE.Mesh;
  swatchKey: string;
  originalColor: THREE.Color;
  originalHex: string;
  originalRoughness: number;
  originalMetalness: number;
  originalMap: THREE.Texture | null;
  originalVertexColors: Float32Array | null;
  bambuMapCache: Map<BambuPaletteScope, THREE.CanvasTexture>;
  bambuVertexCache: Map<BambuPaletteScope, Float32Array>;
}

const INSPECTION_GREY = new THREE.Color('#9CA3AF');
const GREY_ROUGHNESS = 0.56;
const GREY_METALNESS = 0.05;

function remapTextureToBambu(
  texture: THREE.Texture,
  scope: BambuPaletteScope,
): { tex: THREE.CanvasTexture; topMatches: Map<string, { count: number; match: BambuMatchResult }> } | null {
  const img = texture.image as HTMLImageElement | HTMLCanvasElement | ImageBitmap | undefined;
  if (!img || !('width' in img) || !('height' in img) || !img.width || !img.height) {
    return null;
  }

  // Clamp max dimension to 1024px for snappy real-time pixel remapping
  const maxDim = 1024;
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img as CanvasImageSource, 0, 0, w, h);
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;

  const lut = getBambuLut(scope);
  const { entries, table } = lut;
  const counts = new Uint32Array(entries.length);

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) continue;
    const r5 = data[i] >> 3;
    const g5 = data[i + 1] >> 3;
    const b5 = data[i + 2] >> 3;
    const idx = table[(r5 << 10) | (g5 << 5) | b5];
    const [br, bg, bb] = entries[idx].rgb;
    data[i] = br;
    data[i + 1] = bg;
    data[i + 2] = bb;
    counts[idx]++;
  }

  ctx.putImageData(imgData, 0, 0);

  const outTex = new THREE.CanvasTexture(canvas);
  outTex.colorSpace = THREE.SRGBColorSpace;
  outTex.flipY = texture.flipY;
  outTex.wrapS = texture.wrapS;
  outTex.wrapT = texture.wrapT;
  outTex.repeat.copy(texture.repeat);
  outTex.offset.copy(texture.offset);
  outTex.needsUpdate = true;

  const topMatches = new Map<string, { count: number; match: BambuMatchResult }>();
  for (let i = 0; i < entries.length; i++) {
    if (counts[i] > 0) {
      topMatches.set(entries[i].filament.id, {
        count: counts[i],
        match: { filament: entries[i].filament, deltaE: 0 },
      });
    }
  }

  return { tex: outTex, topMatches };
}

function remapVertexColorsToBambu(
  orig: Float32Array,
  scope: BambuPaletteScope,
): { arr: Float32Array; topMatches: Map<string, { count: number; match: BambuMatchResult }> } {
  const lut = getBambuLut(scope);
  const { entries, table } = lut;
  const out = new Float32Array(orig.length);
  const counts = new Uint32Array(entries.length);
  const tmpColor = new THREE.Color();

  for (let i = 0; i < orig.length; i += 3) {
    // Vertex colors in Three.js are linear; convert to sRGB 0..255 for perceptual Bambu lookup
    tmpColor.setRGB(orig[i], orig[i + 1], orig[i + 2], THREE.LinearSRGBColorSpace);
    const r8 = Math.min(255, Math.max(0, Math.round(tmpColor.r * 255)));
    const g8 = Math.min(255, Math.max(0, Math.round(tmpColor.g * 255)));
    const b8 = Math.min(255, Math.max(0, Math.round(tmpColor.b * 255)));
    // Wait: tmpColor.r is linear; use getRGB with SRGBColorSpace!
    const srgb = { r: 0, g: 0, b: 0 };
    tmpColor.getRGB(srgb, THREE.SRGBColorSpace);
    const sr5 = Math.min(31, Math.max(0, Math.round(srgb.r * 31)));
    const sg5 = Math.min(31, Math.max(0, Math.round(srgb.g * 31)));
    const sb5 = Math.min(31, Math.max(0, Math.round(srgb.b * 31)));
    void r8; void g8; void b8;

    const idx = table[(sr5 << 10) | (sg5 << 5) | sb5];
    const [br, bg, bb] = entries[idx].rgb;
    counts[idx]++;

    tmpColor.setRGB(br / 255, bg / 255, bb / 255, THREE.SRGBColorSpace);
    out[i] = tmpColor.r;
    out[i + 1] = tmpColor.g;
    out[i + 2] = tmpColor.b;
  }

  const topMatches = new Map<string, { count: number; match: BambuMatchResult }>();
  for (let i = 0; i < entries.length; i++) {
    if (counts[i] > 0) {
      topMatches.set(entries[i].filament.id, {
        count: counts[i],
        match: { filament: entries[i].filament, deltaE: 0 },
      });
    }
  }

  return { arr: out, topMatches };
}

export class ModelAppearanceController {
  public readonly records: MaterialRecord[] = [];
  public swatches: SwatchEntry[] = [];
  private textureMatchedSwatches = new Map<BambuPaletteScope, SwatchEntry[]>();

  public registerMesh(mesh: THREE.Mesh, swatchName: string, filamentHint?: string): void {
    const rawMat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    let mat: THREE.MeshStandardMaterial;

    if (rawMat instanceof THREE.MeshStandardMaterial) {
      mat = rawMat;
    } else {
      const legacy = rawMat as THREE.MeshPhongMaterial | THREE.MeshBasicMaterial | undefined;
      mat = new THREE.MeshStandardMaterial({
        color: legacy && 'color' in legacy ? legacy.color.clone() : new THREE.Color('#9CA3AF'),
        map: legacy && 'map' in legacy ? legacy.map : null,
        roughness: 0.48,
        metalness: 0.04,
      });
      if (mesh.geometry.getAttribute('color')) {
        mat.vertexColors = true;
      }
      mesh.material = mat;
    }

    const colorAttr = mesh.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    const origVColors = colorAttr ? new Float32Array(colorAttr.array as Float32Array) : null;

    const srgb = { r: 0, g: 0, b: 0 };
    mat.color.getRGB(srgb, THREE.SRGBColorSpace);
    const originalHex = rgbToHex(srgb.r * 255, srgb.g * 255, srgb.b * 255);
    const swatchKey = mat.map
      ? `tex:${swatchName}`
      : origVColors
      ? `vcol:${swatchName}`
      : `${originalHex}|${swatchName}`;

    if (!this.swatches.some((s) => s.key === swatchKey)) {
      this.swatches.push({
        key: swatchKey,
        name: swatchName,
        originalHex,
        filamentHint,
        muted: false,
      });
    }

    this.records.push({
      mesh,
      swatchKey,
      originalColor: mat.color.clone(),
      originalHex,
      originalRoughness: mat.roughness,
      originalMetalness: mat.metalness,
      originalMap: mat.map ?? null,
      originalVertexColors: origVColors,
      bambuMapCache: new Map(),
      bambuVertexCache: new Map(),
    });
  }

  public toggleSwatchMuted(swatchKey: string): void {
    const sw = this.swatches.find((s) => s.key === swatchKey);
    if (sw) sw.muted = !sw.muted;
  }

  public applyAppearance(
    colorOn: boolean,
    bambuMatch: boolean,
    scope: BambuPaletteScope,
  ): SwatchEntry[] {
    const dynamicBambuCounts = new Map<string, { count: number; match: BambuMatchResult }>();

    for (const sw of this.swatches) {
      sw.bambuMatch = bambuMatch ? matchBambuHex(sw.originalHex, scope) : undefined;
    }

    for (const rec of this.records) {
      const mat = rec.mesh.material as THREE.MeshStandardMaterial;
      const sw = this.swatches.find((s) => s.key === rec.swatchKey);
      const isMuted = !colorOn || Boolean(sw?.muted);

      if (isMuted) {
        mat.color.copy(INSPECTION_GREY);
        mat.roughness = GREY_ROUGHNESS;
        mat.metalness = GREY_METALNESS;
        mat.map = null;
        if (rec.originalVertexColors) {
          mat.vertexColors = false;
        }
        mat.needsUpdate = true;
        continue;
      }

      // Colors ON
      if (rec.originalMap) {
        if (bambuMatch) {
          let cachedTex = rec.bambuMapCache.get(scope);
          if (!cachedTex) {
            const remapped = remapTextureToBambu(rec.originalMap, scope);
            if (remapped) {
              cachedTex = remapped.tex;
              rec.bambuMapCache.set(scope, cachedTex);
              for (const [k, v] of remapped.topMatches) {
                const prev = dynamicBambuCounts.get(k);
                if (prev) prev.count += v.count;
                else dynamicBambuCounts.set(k, { ...v });
              }
            }
          }
          mat.map = cachedTex ?? rec.originalMap;
          mat.color.set('#FFFFFF');
          mat.roughness = scope === 'matte' ? 0.78 : 0.48;
          mat.metalness = 0.04;
        } else {
          mat.map = rec.originalMap;
          mat.color.copy(rec.originalColor);
          mat.roughness = rec.originalRoughness;
          mat.metalness = rec.originalMetalness;
        }
        mat.needsUpdate = true;
        continue;
      }

      if (rec.originalVertexColors) {
        const attr = rec.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
        mat.vertexColors = true;
        mat.color.set('#FFFFFF');
        if (bambuMatch) {
          let cached = rec.bambuVertexCache.get(scope);
          if (!cached) {
            const remapped = remapVertexColorsToBambu(rec.originalVertexColors, scope);
            cached = remapped.arr;
            rec.bambuVertexCache.set(scope, cached);
            for (const [k, v] of remapped.topMatches) {
              const prev = dynamicBambuCounts.get(k);
              if (prev) prev.count += v.count;
              else dynamicBambuCounts.set(k, { ...v });
            }
          }
          (attr.array as Float32Array).set(cached);
          attr.needsUpdate = true;
          mat.roughness = scope === 'matte' ? 0.78 : 0.48;
          mat.metalness = 0.04;
        } else {
          (attr.array as Float32Array).set(rec.originalVertexColors);
          attr.needsUpdate = true;
          mat.roughness = rec.originalRoughness;
          mat.metalness = rec.originalMetalness;
        }
        mat.needsUpdate = true;
        continue;
      }

      // Discrete flat-color material (3MF channels, STL, multi-material OBJ/GLB)
      if (bambuMatch) {
        const match = sw?.bambuMatch ?? matchBambuHex(rec.originalHex, scope);
        const [r, g, b] = hexToRgb(match.filament.hex);
        mat.color.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
        mat.roughness = match.filament.roughness;
        mat.metalness = match.filament.metalness;
      } else {
        mat.color.copy(rec.originalColor);
        mat.roughness = rec.originalRoughness;
        mat.metalness = rec.originalMetalness;
      }
      mat.needsUpdate = true;
    }

    // For textured/vertex-colored models under Bambu Match, surface the top matched Bambu spools in the legend!
    const hasTextureOrVCol = this.records.some((r) => r.originalMap || r.originalVertexColors);
    if (bambuMatch && hasTextureOrVCol) {
      if (dynamicBambuCounts.size > 0) {
        const sorted = [...dynamicBambuCounts.values()]
          .sort((a, b) => b.count - a.count)
          .slice(0, 8)
          .map((item) => ({
            key: `dyn:${item.match.filament.id}`,
            name: item.match.filament.name,
            originalHex: item.match.filament.hex,
            bambuMatch: item.match,
            muted: false,
          }));
        this.textureMatchedSwatches.set(scope, sorted);
      }
      const cachedList = this.textureMatchedSwatches.get(scope);
      if (cachedList && cachedList.length > 0) {
        return cachedList;
      }
    }

    return this.swatches;
  }

  public dispose(): void {
    for (const rec of this.records) {
      for (const tex of rec.bambuMapCache.values()) {
        tex.dispose();
      }
      rec.bambuMapCache.clear();
    }
  }
}
