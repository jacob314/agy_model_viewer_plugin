import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { M3dvHeader, ModelSlotMeta } from '../../shared/types.js';
import { parse3mfBytesToM3dv } from '../../shared/parse3mf.js';
import { ModelAppearanceController } from './materials.js';

export interface LoadedModelBundle {
  pivotGroup: THREE.Group;
  contentGroup: THREE.Group;
  normalizeScale: number;
  appearance: ModelAppearanceController;
  dimensionsMm: [number, number, number];
  originalTriangles: number;
  displayedTriangles: number;
  decimated: boolean;
  basePivotY: number;
  formatLabel: string;
}

export type FetchAssetFn = (assetName?: string, onProgress?: (pct: number) => void) => Promise<Uint8Array>;

function parseM3dvBuffer(bytes: Uint8Array): {
  header: M3dvHeader;
  positions: Float32Array;
  indices: Uint32Array;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(
    bytes[0],
    bytes[1],
    bytes[2],
    bytes[3],
  );
  if (magic !== 'M3DV') {
    throw new Error(`Invalid M3DV magic: ${magic}`);
  }
  const version = view.getUint32(4, true);
  if (version !== 1) {
    throw new Error(`Unsupported M3DV version: ${version}`);
  }
  const headerLen = view.getUint32(8, true);
  const headerStr = new TextDecoder('utf-8').decode(bytes.subarray(12, 12 + headerLen));
  const header = JSON.parse(headerStr) as M3dvHeader;

  const paddedHeaderLen = (headerLen + 3) & ~3;
  const posOffset = bytes.byteOffset + 12 + paddedHeaderLen;
  const posBytes = header.totalVertexFloats * 4;
  const idxOffset = posOffset + posBytes;

  // Copy into aligned typed arrays if byteOffset isn't 4-byte aligned
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

  return { header, positions, indices };
}

function normalizeAndWrap(
  contentGroup: THREE.Group,
  appearance: ModelAppearanceController,
  upAxis: 'z' | 'y',
  explicitDimsMm?: [number, number, number],
  originalTriangles = 0,
  displayedTriangles = 0,
  decimated = false,
  formatLabel = '3D',
): LoadedModelBundle {
  // Convert CAD/slicer Z-up to Three.js Y-up
  if (upAxis === 'z') {
    contentGroup.rotation.x = -Math.PI / 2;
  }
  contentGroup.updateMatrixWorld(true);

  const rawBox = new THREE.Box3().setFromObject(contentGroup);
  const rawSize = new THREE.Vector3();
  const rawCenter = new THREE.Vector3();
  rawBox.getSize(rawSize);
  rawBox.getCenter(rawCenter);

  const maxSpan = Math.max(rawSize.x, rawSize.y, rawSize.z, 1e-4);
  const targetSpan = 2.2;
  const scale = targetSpan / maxSpan;

  // Center the model around its own visual center inside pivotGroup so direct object rotation spins smoothly!
  const offsetGroup = new THREE.Group();
  offsetGroup.add(contentGroup);
  contentGroup.position.sub(rawCenter);
  offsetGroup.scale.setScalar(scale);

  const scaledHeight = rawSize.y * scale;
  const basePivotY = scaledHeight * 0.5;

  const pivotGroup = new THREE.Group();
  pivotGroup.add(offsetGroup);
  pivotGroup.position.set(0, basePivotY, 0);

  // Count triangles if not supplied
  let countedTris = displayedTriangles;
  if (countedTris === 0) {
    contentGroup.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        const g = obj.geometry;
        if (g.index) countedTris += g.index.count / 3;
        else if (g.getAttribute('position')) countedTris += g.getAttribute('position').count / 3;
      }
    });
    countedTris = Math.round(countedTris);
  }

  const dimsMm: [number, number, number] = explicitDimsMm ?? [rawSize.x, rawSize.z, rawSize.y];

  return {
    pivotGroup,
    contentGroup,
    normalizeScale: scale,
    appearance,
    dimensionsMm: dimsMm,
    originalTriangles: originalTriangles || countedTris,
    displayedTriangles: countedTris,
    decimated,
    basePivotY,
    formatLabel,
  };
}

function buildFromM3dv(bytes: Uint8Array): LoadedModelBundle {
  const { header, positions, indices } = parseM3dvBuffer(bytes);
  const content = new THREE.Group();
  const appearance = new ModelAppearanceController();

  // Apply crisp creased normals per group for CAD/sign/mechanical prints (up to 300k total / 180k per group)
  const allowCreased = header.displayedTriangleCount <= 300_000;

  for (const grp of header.groups) {
    const posSlice = positions.subarray(grp.vertexOffset, grp.vertexOffset + grp.vertexCount * 3);
    const idxSlice = indices.subarray(grp.indexOffset, grp.indexOffset + grp.indexCount);

    let geo: THREE.BufferGeometry = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(posSlice), 3));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idxSlice), 1));

    const grpTris = grp.indexCount / 3;
    if (allowCreased && grpTris <= 180_000) {
      geo = toCreasedNormals(geo, Math.PI / 5); // 36 deg crease angle: crisp CAD edges + smooth curves!
    } else {
      geo.computeVertexNormals();
    }

    const labelLower = `${grp.filamentName ?? ''} ${grp.name}`.toLowerCase();
    const isMatte = labelLower.includes('matte');
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(grp.color),
      roughness: isMatte ? 0.8 : 0.48,
      metalness: 0.03,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = grp.name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    content.add(mesh);
    appearance.registerMesh(mesh, grp.name, grp.filamentName);
  }

  return normalizeAndWrap(
    content,
    appearance,
    header.upAxis,
    header.dimensionsMm,
    header.originalTriangleCount,
    header.displayedTriangleCount,
    header.decimated,
    header.format.toUpperCase(),
  );
}

async function buildFromGlb(bytes: Uint8Array, fetchAsset?: FetchAssetFn): Promise<LoadedModelBundle> {
  const loader = new GLTFLoader();
  const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
    const copy = bytes.slice().buffer;
    loader.parse(copy, '', resolve, reject);
  });
  void fetchAsset;

  const content = new THREE.Group();
  content.add(gltf.scene);
  const appearance = new ModelAppearanceController();

  let meshIdx = 1;
  gltf.scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
      if (!obj.geometry.getAttribute('normal')) {
        obj.geometry.computeVertexNormals();
      }
      const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
      const label = mat?.name || obj.name || `Material ${meshIdx++}`;
      appearance.registerMesh(obj, label);
    }
  });

  return normalizeAndWrap(content, appearance, 'y', undefined, 0, 0, false, 'GLB');
}

async function buildFromObj(
  bytes: Uint8Array,
  defaultColor: string,
  fetchAsset?: FetchAssetFn,
): Promise<LoadedModelBundle> {
  const text = new TextDecoder('utf-8').decode(bytes);
  const objLoader = new OBJLoader();
  const blobUrls: string[] = [];

  // Look for mtllib directive and load sibling .mtl + texture maps via fetchAsset
  const mtlMatch = /^\s*mtllib\s+(.+)$/m.exec(text);
  if (mtlMatch && fetchAsset) {
    const mtlName = mtlMatch[1].trim();
    try {
      const mtlBytes = await fetchAsset(mtlName);
      let mtlText = new TextDecoder('utf-8').decode(mtlBytes);

      // Pre-fetch referenced texture maps and replace paths with blob URLs
      const mapRe = /^\s*(map_Kd|map_Ka|map_Ks|map_Bump|bump)\s+(.+)$/gm;
      const texNames = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = mapRe.exec(mtlText)) !== null) {
        texNames.add(m[2].trim());
      }
      for (const texName of texNames) {
        try {
          const texBytes = await fetchAsset(texName);
          const ext = texName.split('.').pop()?.toLowerCase();
          const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
          const blobCopy = new Uint8Array(texBytes.byteLength);
          blobCopy.set(texBytes);
          const url = URL.createObjectURL(new Blob([blobCopy.buffer], { type: mime }));
          blobUrls.push(url);
          mtlText = mtlText.split(texName).join(url);
        } catch {
          // Optional texture missing; skip gracefully
        }
      }

      const mtlLoader = new MTLLoader();
      const materials = mtlLoader.parse(mtlText, '');
      materials.preload();
      objLoader.setMaterials(materials);
    } catch {
      // Fallback to un-textured OBJ if MTL unavailable
    }
  }

  const parsed = objLoader.parse(text);
  const appearance = new ModelAppearanceController();
  let idx = 1;
  parsed.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
      if (!obj.geometry.getAttribute('normal')) {
        obj.geometry.computeVertexNormals();
      }
      const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
      if (!mat || (mat instanceof THREE.MeshPhongMaterial && !mat.map && mat.color.getHex() === 0xffffff && !mtlMatch)) {
        obj.material = new THREE.MeshStandardMaterial({
          color: new THREE.Color(defaultColor),
          roughness: 0.48,
          metalness: 0.04,
          side: THREE.DoubleSide,
        });
      }
      const label = (Array.isArray(obj.material) ? obj.material[0]?.name : obj.material?.name) || obj.name || `Part ${idx++}`;
      appearance.registerMesh(obj, label);
    }
  });

  // Note: keep blobUrls alive until texture image finishes decoding
  if (blobUrls.length > 0) {
    setTimeout(() => {
      for (const u of blobUrls) URL.revokeObjectURL(u);
    }, 15_000);
  }

  return normalizeAndWrap(parsed, appearance, 'y', undefined, 0, 0, false, 'OBJ');
}

function buildFromPly(bytes: Uint8Array, defaultColor: string): LoadedModelBundle {
  const loader = new PLYLoader();
  const geo = loader.parse(bytes.slice().buffer);
  geo.computeVertexNormals();

  const hasColors = Boolean(geo.getAttribute('color'));
  const mat = new THREE.MeshStandardMaterial({
    color: hasColors ? new THREE.Color('#FFFFFF') : new THREE.Color(defaultColor),
    vertexColors: hasColors,
    roughness: 0.5,
    metalness: 0.04,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const content = new THREE.Group();
  content.add(mesh);

  const appearance = new ModelAppearanceController();
  appearance.registerMesh(mesh, hasColors ? 'Vertex Colors' : 'PLY Mesh');

  return normalizeAndWrap(content, appearance, 'z', undefined, 0, 0, false, 'PLY');
}

function buildFromRawStl(bytes: Uint8Array, defaultColor: string): LoadedModelBundle {
  const loader = new STLLoader();
  const geo = loader.parse(bytes.slice().buffer);
  const hasColors = Boolean(geo.getAttribute('color'));
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    color: hasColors ? new THREE.Color('#FFFFFF') : new THREE.Color(defaultColor),
    vertexColors: hasColors,
    roughness: 0.46,
    metalness: 0.04,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const content = new THREE.Group();
  content.add(mesh);

  const appearance = new ModelAppearanceController();
  appearance.registerMesh(mesh, 'STL Mesh');

  return normalizeAndWrap(content, appearance, 'z', undefined, 0, 0, false, 'STL');
}

function buildFromRaw3mf(bytes: Uint8Array, defaultColor: string): LoadedModelBundle {
  // Use our full Bambu Studio + 3MF multi-color parser natively in the browser too!
  const m3dvBytes = parse3mfBytesToM3dv(bytes, defaultColor);
  return buildFromM3dv(m3dvBytes);
}

export async function loadModelFromBytes(
  meta: ModelSlotMeta,
  bytes: Uint8Array,
  fetchAsset?: FetchAssetFn,
): Promise<LoadedModelBundle> {
  if (meta.transport === 'm3dv') {
    return buildFromM3dv(bytes);
  }
  const color = meta.defaultColor || '#38BDF8';
  switch (meta.format) {
    case '3mf':
      return buildFromRaw3mf(bytes, color);
    case 'glb':
    case 'gltf':
      return buildFromGlb(bytes, fetchAsset);
    case 'obj':
      return buildFromObj(bytes, color, fetchAsset);
    case 'ply':
      return buildFromPly(bytes, color);
    case 'stl':
      return buildFromRawStl(bytes, color);
    default:
      throw new Error(`Unsupported format: ${meta.format}`);
  }
}
