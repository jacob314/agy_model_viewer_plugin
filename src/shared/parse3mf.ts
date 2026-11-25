import { unzipSync, strFromU8 } from 'fflate';
import { packM3dvBytes, type GeometryGroupInput } from './m3dvPacker.js';

interface ColorEntry {
  name: string;
  color: string; // #RRGGBB
  filamentName?: string;
}

interface ParsedObjectMesh {
  id: string;
  name: string;
  defaultPid?: string;
  defaultPindex?: number;
  vertices: Float32Array;
  colorTriangles: Map<string, number[]>;
  components: Array<{
    objectId: string;
    path?: string;
    transform?: number[];
  }>;
}

interface ModelFileData {
  baseMaterials: Map<string, ColorEntry[]>;
  objects: Map<string, ParsedObjectMesh>;
  buildItems: Array<{ objectId: string; transform?: number[] }>;
}

function normalizeHex(raw: string | undefined, fallback = '#D1D3D5'): string {
  if (!raw) return fallback;
  const cleaned = raw.trim().replace(/^#/, '');
  if (cleaned.length === 8 || cleaned.length === 6) {
    return ('#' + cleaned.slice(0, 6)).toUpperCase();
  }
  if (cleaned.length === 3) {
    return (
      '#' +
      cleaned[0] +
      cleaned[0] +
      cleaned[1] +
      cleaned[1] +
      cleaned[2] +
      cleaned[2]
    ).toUpperCase();
  }
  return fallback;
}

export function decodeBambuPaintColor(hexStr: string): number {
  const s = hexStr.trim();
  if (!s) return 0;

  const nibbles: number[] = [];
  for (let i = s.length - 1; i >= 0; i--) {
    const v = parseInt(s[i], 16);
    if (!Number.isNaN(v)) nibbles.push(v);
  }
  if (nibbles.length === 0) return 0;

  const first = nibbles[0];
  const splitSides = first & 0x03;
  const state = (first >> 2) & 0x03;
  if (splitSides === 0) {
    if (state === 0) return 0;
    if (state === 1) return 1;
    if (state === 2) return 2;
    if (nibbles.length >= 2) return nibbles[1] + 3;
    return 3;
  }

  const counts = new Map<number, number>();
  let pos = 0;
  const walk = (depth: number) => {
    if (pos >= nibbles.length || depth > 16) return;
    const nib = nibbles[pos++];
    const ss = nib & 0x03;
    const st = (nib >> 2) & 0x03;
    if (ss === 0) {
      let ext = 0;
      if (st === 1) ext = 1;
      else if (st === 2) ext = 2;
      else if (st === 3 && pos < nibbles.length) ext = nibbles[pos++] + 3;
      if (ext > 0) counts.set(ext, (counts.get(ext) ?? 0) + 1);
      return;
    }
    const children = ss === 1 ? 2 : ss === 2 ? 3 : 4;
    for (let c = 0; c < children; c++) {
      walk(depth + 1);
    }
  };
  walk(0);

  let bestExt = 0;
  let bestCount = 0;
  for (const [ext, cnt] of counts.entries()) {
    if (cnt > bestCount) {
      bestCount = cnt;
      bestExt = ext;
    }
  }
  return bestExt;
}

function parseTransform12(attr: string | undefined): number[] | undefined {
  if (!attr) return undefined;
  const nums = attr.trim().split(/\s+/).map(Number);
  if (nums.length === 12 && nums.every(Number.isFinite)) return nums;
  return undefined;
}

function composeTransform(parent: number[] | undefined, child: number[] | undefined): number[] | undefined {
  if (!parent) return child;
  if (!child) return parent;
  const a = child;
  const b = parent;
  return [
    a[0] * b[0] + a[1] * b[3] + a[2] * b[6],
    a[0] * b[1] + a[1] * b[4] + a[2] * b[7],
    a[0] * b[2] + a[1] * b[5] + a[2] * b[8],

    a[3] * b[0] + a[4] * b[3] + a[5] * b[6],
    a[3] * b[1] + a[4] * b[4] + a[5] * b[7],
    a[3] * b[2] + a[4] * b[5] + a[5] * b[8],

    a[6] * b[0] + a[7] * b[3] + a[8] * b[6],
    a[6] * b[1] + a[7] * b[4] + a[8] * b[7],
    a[6] * b[2] + a[7] * b[5] + a[8] * b[8],

    a[9] * b[0] + a[10] * b[3] + a[11] * b[6] + b[9],
    a[9] * b[1] + a[10] * b[4] + a[11] * b[7] + b[10],
    a[9] * b[2] + a[10] * b[5] + a[11] * b[8] + b[11],
  ];
}

function getAttr(tag: string, name: string): string | undefined {
  const re = new RegExp(`(?:^|[\\s:])${name}\\s*=\\s*"([^"]*)"`);
  const m = re.exec(tag);
  return m ? m[1] : undefined;
}

function parseModelXml(
  xml: string,
  filaments: ColorEntry[],
  partExtruders: Map<string, number>,
): ModelFileData {
  const baseMaterials = new Map<string, ColorEntry[]>();
  const objects = new Map<string, ParsedObjectMesh>();
  const buildItems: Array<{ objectId: string; transform?: number[] }> = [];

  const bmRe = /<basematerials\b([^>]*)>([\s\S]*?)<\/basematerials>/g;
  let bmMatch: RegExpExecArray | null;
  while ((bmMatch = bmRe.exec(xml)) !== null) {
    const id = getAttr(bmMatch[1], 'id');
    if (!id) continue;
    const entries: ColorEntry[] = [];
    const baseRe = /<base\b([^>]*)\/?>/g;
    let bMatch: RegExpExecArray | null;
    let idx = 1;
    while ((bMatch = baseRe.exec(bmMatch[2])) !== null) {
      const name = (getAttr(bMatch[1], 'name') || `Material ${idx}`).replace(/_/g, ' ');
      const hex = normalizeHex(getAttr(bMatch[1], 'displaycolor'));
      entries.push({ name, color: hex });
      idx++;
    }
    baseMaterials.set(id, entries);
  }

  const cgRe = /<(?:[a-zA-Z0-9_]+:)?colorgroup\b([^>]*)>([\s\S]*?)<\/(?:[a-zA-Z0-9_]+:)?colorgroup>/g;
  let cgMatch: RegExpExecArray | null;
  while ((cgMatch = cgRe.exec(xml)) !== null) {
    const id = getAttr(cgMatch[1], 'id');
    if (!id) continue;
    const entries: ColorEntry[] = [];
    const colorRe = /<(?:[a-zA-Z0-9_]+:)?color\b([^>]*)\/?>/g;
    let cMatch: RegExpExecArray | null;
    let idx = 1;
    while ((cMatch = colorRe.exec(cgMatch[2])) !== null) {
      const hex = normalizeHex(getAttr(cMatch[1], 'color'));
      entries.push({ name: `Color ${idx++}`, color: hex });
    }
    baseMaterials.set(id, entries);
  }

  let cursor = 0;
  while (true) {
    const objStart = xml.indexOf('<object', cursor);
    if (objStart === -1) break;
    const tagEnd = xml.indexOf('>', objStart);
    if (tagEnd === -1) break;
    const objEnd = xml.indexOf('</object>', tagEnd);
    if (objEnd === -1) break;
    cursor = objEnd + 9;

    const openTag = xml.slice(objStart, tagEnd + 1);
    const id = getAttr(openTag, 'id');
    if (!id) continue;
    const name = getAttr(openTag, 'name') || `Object ${id}`;
    const defaultPid = getAttr(openTag, 'pid');
    const defaultPindexRaw = getAttr(openTag, 'pindex');
    const defaultPindex = defaultPindexRaw !== undefined ? parseInt(defaultPindexRaw, 10) : undefined;

    const body = xml.slice(tagEnd + 1, objEnd);

    const components: ParsedObjectMesh['components'] = [];
    const compIdx = body.indexOf('<components');
    if (compIdx !== -1) {
      const compEnd = body.indexOf('</components>', compIdx);
      const compBlock = compEnd !== -1 ? body.slice(compIdx, compEnd) : body.slice(compIdx);
      const cRe = /<component\b([^>]*)\/?>/g;
      let cm: RegExpExecArray | null;
      while ((cm = cRe.exec(compBlock)) !== null) {
        const oid = getAttr(cm[1], 'objectid');
        if (!oid) continue;
        components.push({
          objectId: oid,
          path: getAttr(cm[1], 'path'),
          transform: parseTransform12(getAttr(cm[1], 'transform')),
        });
      }
    }

    const verts: number[] = [];
    const vStart = body.indexOf('<vertices');
    if (vStart !== -1) {
      const vEnd = body.indexOf('</vertices>', vStart);
      if (vEnd !== -1) {
        const vBlock = body.slice(vStart, vEnd);
        const vRe = /<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/g;
        let vm: RegExpExecArray | null;
        while ((vm = vRe.exec(vBlock)) !== null) {
          verts.push(parseFloat(vm[1]), parseFloat(vm[2]), parseFloat(vm[3]));
        }
        if (verts.length === 0 && vBlock.includes('<vertex')) {
          const vTagRe = /<vertex\b([^>]*)\/?>/g;
          while ((vm = vTagRe.exec(vBlock)) !== null) {
            const x = parseFloat(getAttr(vm[1], 'x') ?? '0');
            const y = parseFloat(getAttr(vm[1], 'y') ?? '0');
            const z = parseFloat(getAttr(vm[1], 'z') ?? '0');
            verts.push(x, y, z);
          }
        }
      }
    }

    let objDefaultKey = 'default';
    const partExt = partExtruders.get(id);
    if (partExt && partExt >= 1) {
      objDefaultKey = `ext:${partExt - 1}`;
    } else if (defaultPid !== undefined && defaultPindex !== undefined && Number.isFinite(defaultPindex)) {
      objDefaultKey = `mat:${defaultPid}:${defaultPindex}`;
    } else if (filaments.length > 0) {
      objDefaultKey = 'ext:0';
    }

    const colorTriangles = new Map<string, number[]>();
    const tStart = body.indexOf('<triangles');
    if (tStart !== -1) {
      const tEnd = body.indexOf('</triangles>', tStart);
      if (tEnd !== -1) {
        const tBlock = body.slice(tStart, tEnd);
        const tRe = /<triangle\b([^>]*)\/?>/g;
        let tm: RegExpExecArray | null;
        while ((tm = tRe.exec(tBlock)) !== null) {
          const attrs = tm[1];
          const v1m = /\bv1="(\d+)"/.exec(attrs);
          const v2m = /\bv2="(\d+)"/.exec(attrs);
          const v3m = /\bv3="(\d+)"/.exec(attrs);
          if (!v1m || !v2m || !v3m) continue;
          const v1 = parseInt(v1m[1], 10);
          const v2 = parseInt(v2m[1], 10);
          const v3 = parseInt(v3m[1], 10);

          let key = objDefaultKey;
          let paintApplied = false;

          const pcM = /\bpaint_color="([0-9a-fA-F]+)"/.exec(attrs);
          if (pcM) {
            const ext1Based = decodeBambuPaintColor(pcM[1]);
            if (ext1Based >= 1 && filaments.length > 0) {
              key = `ext:${ext1Based - 1}`;
              paintApplied = true;
            }
          }

          if (!paintApplied) {
            const pidM = /\bpid="([^"]+)"/.exec(attrs);
            const p1M = /\bp1="(\d+)"/.exec(attrs);
            if (p1M) {
              const pid = pidM ? pidM[1] : defaultPid;
              if (pid) {
                key = `mat:${pid}:${p1M[1]}`;
              }
            }
          }

          let list = colorTriangles.get(key);
          if (!list) {
            list = [];
            colorTriangles.set(key, list);
          }
          list.push(v1, v2, v3);
        }
      }
    }

    objects.set(id, {
      id,
      name,
      defaultPid,
      defaultPindex,
      vertices: Float32Array.from(verts),
      colorTriangles,
      components,
    });
  }

  const bStart = xml.indexOf('<build');
  if (bStart !== -1) {
    const bEnd = xml.indexOf('</build>', bStart);
    const bBlock = bEnd !== -1 ? xml.slice(bStart, bEnd) : xml.slice(bStart);
    const itemRe = /<item\b([^>]*)\/?>/g;
    let im: RegExpExecArray | null;
    while ((im = itemRe.exec(bBlock)) !== null) {
      const oid = getAttr(im[1], 'objectid');
      if (!oid) continue;
      buildItems.push({
        objectId: oid,
        transform: parseTransform12(getAttr(im[1], 'transform')),
      });
    }
  }

  return { baseMaterials, objects, buildItems };
}

function parseProjectSettings(zipFiles: Record<string, Uint8Array>): ColorEntry[] {
  const key = Object.keys(zipFiles).find((k) => k.toLowerCase() === 'metadata/project_settings.config');
  if (!key) return [];
  try {
    const json = JSON.parse(strFromU8(zipFiles[key]));
    const colours: string[] = Array.isArray(json.filament_colour) ? json.filament_colour : [];
    const settingsIds: string[] = Array.isArray(json.filament_settings_id) ? json.filament_settings_id : [];
    const types: string[] = Array.isArray(json.filament_type) ? json.filament_type : [];

    return colours.map((hex, i) => {
      const setting = settingsIds[i] || '';
      let label = `Extruder ${i + 1}`;
      if (setting.includes('@')) {
        const afterAt = setting.split('@')[1].trim().replace(/_/g, ' ');
        if (afterAt && !afterAt.startsWith('BBL') && !afterAt.startsWith('System')) {
          label = afterAt;
        } else {
          label = setting.split('@')[0].trim();
        }
      } else if (setting) {
        label = setting;
      } else if (types[i]) {
        label = `Extruder ${i + 1} (${types[i]})`;
      }
      return {
        name: label,
        color: normalizeHex(hex),
        filamentName: setting || types[i] || undefined,
      };
    });
  } catch {
    return [];
  }
}

function parseModelSettings(zipFiles: Record<string, Uint8Array>): Map<string, number> {
  const extruders = new Map<string, number>();
  const key = Object.keys(zipFiles).find((k) => k.toLowerCase() === 'metadata/model_settings.config');
  if (!key) return extruders;
  const xml = strFromU8(zipFiles[key]);

  const objRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
  let om: RegExpExecArray | null;
  while ((om = objRe.exec(xml)) !== null) {
    const oid = getAttr(om[1], 'id');
    const body = om[2];
    let objExt = 0;
    const objExtM = /<metadata\s+key="extruder"\s+value="(\d+)"/.exec(body.split('<part')[0]);
    if (objExtM) objExt = parseInt(objExtM[1], 10);
    if (oid && objExt >= 1) extruders.set(oid, objExt);

    const partRe = /<part\b([^>]*)>([\s\S]*?)<\/part>/g;
    let pm: RegExpExecArray | null;
    while ((pm = partRe.exec(body)) !== null) {
      const pid = getAttr(pm[1], 'id');
      const pExtM = /<metadata\s+key="extruder"\s+value="(\d+)"/.exec(pm[2]);
      const ext = pExtM ? parseInt(pExtM[1], 10) : objExt;
      if (pid && ext >= 1) extruders.set(pid, ext);
    }
  }
  return extruders;
}

/**
 * Runtime-agnostic (Node + Browser) Bambu Studio & standard 3MF parser -> compact M3DV v1 Uint8Array.
 */
export function parse3mfBytesToM3dv(bytes: Uint8Array, defaultColor = '#4F8EF7'): Uint8Array {
  const zipFiles = unzipSync(bytes);
  const filaments = parseProjectSettings(zipFiles);
  const partExtruders = parseModelSettings(zipFiles);

  const pathLookup = new Map<string, string>();
  for (const k of Object.keys(zipFiles)) {
    pathLookup.set(k.replace(/^\/+/, '').toLowerCase(), k);
  }

  const parsedCache = new Map<string, ModelFileData>();
  const loadModelFile = (relPath: string): ModelFileData | undefined => {
    const norm = relPath.replace(/^\/+/, '').toLowerCase();
    const cached = parsedCache.get(norm);
    if (cached) return cached;
    const actualKey = pathLookup.get(norm);
    if (!actualKey) return undefined;
    const xml = strFromU8(zipFiles[actualKey]);
    const parsed = parseModelXml(xml, filaments, partExtruders);
    parsedCache.set(norm, parsed);
    return parsed;
  };

  const rootPath =
    pathLookup.get('3d/3dmodel.model') ||
    Object.keys(zipFiles).find((k) => k.toLowerCase().endsWith('.model'));
  if (!rootPath) {
    throw new Error('Invalid 3MF archive: no .model file found');
  }

  const rootModel = loadModelFile(rootPath)!;
  const allBaseMaterials = new Map<string, ColorEntry[]>(rootModel.baseMaterials);

  const accumulators = new Map<
    string,
    {
      meta: ColorEntry;
      verts: number[];
      indices: number[];
    }
  >();

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let totalTriangles = 0;

  const resolveColorMeta = (key: string, localBaseMaterials: Map<string, ColorEntry[]>): ColorEntry => {
    if (key.startsWith('ext:')) {
      const idx = parseInt(key.slice(4), 10);
      if (filaments[idx]) return filaments[idx];
      for (const list of localBaseMaterials.values()) {
        if (list[idx]) return list[idx];
      }
      for (const list of allBaseMaterials.values()) {
        if (list[idx]) return list[idx];
      }
      return { name: `Extruder ${idx + 1}`, color: defaultColor };
    }
    if (key.startsWith('mat:')) {
      const parts = key.split(':');
      const pid = parts[1];
      const pIdx = parseInt(parts[2], 10);
      const localList = localBaseMaterials.get(pid) ?? allBaseMaterials.get(pid);
      if (localList && localList[pIdx]) {
        const entry = localList[pIdx];
        const filament = filaments[pIdx];
        return {
          name: entry.name,
          color: entry.color,
          filamentName: filament?.filamentName,
        };
      }
      if (filaments[pIdx]) return filaments[pIdx];
    }
    return { name: 'Default Filament', color: defaultColor };
  };

  const emitObject = (
    modelData: ModelFileData,
    objectId: string,
    worldTransform: number[] | undefined,
    depth: number,
  ) => {
    if (depth > 8) return;
    const obj = modelData.objects.get(objectId);
    if (!obj) return;

    if (obj.vertices.length > 0 && obj.colorTriangles.size > 0) {
      const vArr = obj.vertices;
      const t = worldTransform;

      for (const [colorKey, triIndices] of obj.colorTriangles.entries()) {
        const meta = resolveColorMeta(colorKey, modelData.baseMaterials);
        const bucketKey = `${meta.color}|${meta.name}`;
        let acc = accumulators.get(bucketKey);
        if (!acc) {
          acc = { meta, verts: [], indices: [] };
          accumulators.set(bucketKey, acc);
        }

        const localRemap = new Map<number, number>();
        const baseVertexOffset = acc.verts.length / 3;

        for (let i = 0; i < triIndices.length; i++) {
          const origV = triIndices[i];
          let mapped = localRemap.get(origV);
          if (mapped === undefined) {
            const vx = vArr[origV * 3];
            const vy = vArr[origV * 3 + 1];
            const vz = vArr[origV * 3 + 2];
            if (vx === undefined || vy === undefined || vz === undefined) continue;

            let x = vx, y = vy, z = vz;
            if (t) {
              x = vx * t[0] + vy * t[3] + vz * t[6] + t[9];
              y = vx * t[1] + vy * t[4] + vz * t[7] + t[10];
              z = vx * t[2] + vy * t[5] + vz * t[8] + t[11];
            }
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;

            mapped = baseVertexOffset + localRemap.size;
            localRemap.set(origV, mapped);
            acc.verts.push(x, y, z);
          }
          acc.indices.push(mapped);
        }
        totalTriangles += triIndices.length / 3;
      }
    }

    for (const comp of obj.components) {
      const nextTransform = composeTransform(worldTransform, comp.transform);
      let targetModel = modelData;
      if (comp.path) {
        const extModel = loadModelFile(comp.path);
        if (extModel) {
          for (const [k, v] of extModel.baseMaterials) allBaseMaterials.set(k, v);
          targetModel = extModel;
        }
      }
      emitObject(targetModel, comp.objectId, nextTransform, depth + 1);
    }
  };

  if (rootModel.buildItems.length > 0) {
    for (const item of rootModel.buildItems) {
      emitObject(rootModel, item.objectId, item.transform, 0);
    }
  } else {
    for (const oid of rootModel.objects.keys()) {
      emitObject(rootModel, oid, undefined, 0);
    }
  }

  const groups: GeometryGroupInput[] = [];
  for (const acc of accumulators.values()) {
    if (acc.verts.length === 0 || acc.indices.length === 0) continue;
    groups.push({
      name: acc.meta.name,
      color: acc.meta.color,
      filamentName: acc.meta.filamentName,
      positions: Float32Array.from(acc.verts),
      indices: Uint32Array.from(acc.indices),
    });
  }

  if (groups.length === 0) {
    throw new Error('3MF file contained no renderable mesh geometry');
  }

  const bboxMin: [number, number, number] = [minX, minY, minZ];
  const bboxMax: [number, number, number] = [maxX, maxY, maxZ];
  const hasExplicitColors = groups.length > 1 || filaments.length > 0 || allBaseMaterials.size > 0;

  return packM3dvBytes({
    format: '3mf',
    upAxis: 'z',
    dimensionsMm: [maxX - minX, maxY - minY, maxZ - minZ],
    bboxMin,
    bboxMax,
    originalTriangleCount: totalTriangles,
    displayedTriangleCount: totalTriangles,
    decimated: false,
    hasExplicitColors,
    groups,
  });
}
