import { zipSync, strToU8 } from 'fflate';
import { matchBambuHex } from './bambu/colorMatch.js';
import type { BambuPaletteScope } from './bambu/palette.js';

export interface ExportMeshGroup {
  name: string;
  color: string; // #RRGGBB
  filamentSettingsId?: string;
  /** Z-up millimeter coordinates */
  positions: Float32Array;
  /** Triangle vertex indices into positions */
  indices: Uint32Array;
}

export interface ExportBambu3mfOptions {
  title: string;
  groups: ExportMeshGroup[];
  /** If true, maps each group's color to closest official Bambu Lab filament and sets filament_settings_id */
  snapToBambu?: boolean;
  bambuScope?: BambuPaletteScope;
  /** Ground model cleanly on Z=0 and center X/Y at 0 (default true) */
  groundOnBuildPlate?: boolean;
}

export interface ExportedFilamentInfo {
  slot: number;
  name: string;
  hex: string;
  settingsId: string;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeHex6(hex: string): string {
  const c = hex.trim().replace(/^#/, '');
  if (c.length >= 6) return ('#' + c.slice(0, 6)).toUpperCase();
  return '#D1D3D5';
}

/**
 * Encodes 1-based Bambu Studio / PrusaSlicer MMU extruder index (1..16) into `paint_color` hex string.
 * 1 -> "4", 2 -> "8", 3 -> "0C", 4 -> "1C", 5 -> "2C", ...
 */
export function encodeBambuPaintColor(extruder1Based: number): string {
  const e = Math.max(1, Math.min(16, Math.round(extruder1Based)));
  if (e === 1) return '4';
  if (e === 2) return '8';
  const extNibble = (e - 3).toString(16).toUpperCase();
  return `${extNibble}C`;
}

function computeBounds(groups: ExportMeshGroup[]): {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
} {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const g of groups) {
    const p = g.positions;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  }
  if (!Number.isFinite(minX)) {
    return { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

/**
 * Generates a Bambu Studio canonical multi-color .3mf ZIP archive (Uint8Array)
 * with <basematerials>, per-triangle pid/p1 + Bambu paint_color,
 * Metadata/project_settings.config (AMS filament colors & profiles), and Metadata/model_settings.config.
 */
export function buildBambu3mf(opts: ExportBambu3mfOptions): {
  bytes: Uint8Array;
  filaments: ExportedFilamentInfo[];
  triangleCount: number;
} {
  const nonEmpty = opts.groups.filter((g) => g.positions.length > 0 && g.indices.length > 0);
  if (nonEmpty.length === 0) {
    throw new Error('Cannot export 3MF: model has no mesh geometry');
  }

  const scope = opts.bambuScope ?? 'basic-matte';

  // Deduplicate/merge filament channels (cap at 16 AMS slots)
  interface MergedChannel {
    slotIndex: number;
    name: string;
    hex: string;
    settingsId: string;
    groups: ExportMeshGroup[];
  }
  const channelMap = new Map<string, MergedChannel>();
  const channels: MergedChannel[] = [];

  for (const g of nonEmpty) {
    let hex = normalizeHex6(g.color);
    let name = g.name || 'Filament';
    let settingsId = g.filamentSettingsId || `Bambu PLA Basic @${name}`;

    if (opts.snapToBambu) {
      const m = matchBambuHex(hex, scope);
      hex = m.filament.hex;
      name = `${m.filament.line} ${m.filament.name}`;
      settingsId = `Bambu ${m.filament.line} @${m.filament.name}`;
    }

    const key = opts.snapToBambu ? `${settingsId}|${hex}` : `${hex}|${name}`;
    let ch = channelMap.get(key);
    if (!ch) {
      if (channels.length >= 16) {
        // Merge overflow into closest existing channel
        ch = channels[channels.length - 1];
      } else {
        ch = {
          slotIndex: channels.length,
          name,
          hex,
          settingsId,
          groups: [],
        };
        channelMap.set(key, ch);
        channels.push(ch);
      }
    }
    ch.groups.push(g);
  }

  // Compute build-plate centering offset (X/Y centered at 0, bottom resting flush on Z=0)
  const bounds = computeBounds(nonEmpty);
  const offX = opts.groundOnBuildPlate !== false ? -(bounds.minX + bounds.maxX) * 0.5 : 0;
  const offY = opts.groundOnBuildPlate !== false ? -(bounds.minY + bounds.maxY) * 0.5 : 0;
  const offZ = opts.groundOnBuildPlate !== false ? -bounds.minZ : 0;

  // Build unified vertex list + painted triangle list
  const vertLines: string[] = [];
  const triLines: string[] = [];
  let vertexBase = 0;
  let triangleCount = 0;

  for (const ch of channels) {
    const paintHex = encodeBambuPaintColor(ch.slotIndex + 1);
    const p1 = ch.slotIndex;

    for (const g of ch.groups) {
      const p = g.positions;
      const vCount = p.length / 3;
      for (let i = 0; i < vCount; i++) {
        const x = (p[i * 3] + offX).toFixed(4);
        const y = (p[i * 3 + 1] + offY).toFixed(4);
        const z = (p[i * 3 + 2] + offZ).toFixed(4);
        vertLines.push(`     <vertex x="${x}" y="${y}" z="${z}"/>`);
      }

      const idx = g.indices;
      for (let i = 0; i < idx.length; i += 3) {
        const v1 = vertexBase + idx[i];
        const v2 = vertexBase + idx[i + 1];
        const v3 = vertexBase + idx[i + 2];
        triLines.push(
          `     <triangle v1="${v1}" v2="${v2}" v3="${v3}" pid="1" p1="${p1}" paint_color="${paintHex}"/>`,
        );
        triangleCount++;
      }

      vertexBase += vCount;
    }
  }

  const safeTitle = escapeXml(opts.title || '3D Print Export');
  const baseMatLines = channels.map((ch, i) => {
    const cleanName = escapeXml(`${i + 1}_${ch.name.replace(/\s+/g, '_')}`);
    return `   <base name="${cleanName}" displaycolor="${ch.hex}FF"/>`;
  });

  const modelXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">',
    ' <metadata name="Application">BambuStudio-02.05.00</metadata>',
    ' <metadata name="BambuStudio:3mfVersion">1</metadata>',
    ` <metadata name="Title">${safeTitle}</metadata>`,
    ' <resources>',
    '  <basematerials id="1">',
    ...baseMatLines,
    '  </basematerials>',
    `  <object id="2" name="${safeTitle}" type="model" pid="1" pindex="0">`,
    '   <mesh>',
    '    <vertices>',
    ...vertLines,
    '    </vertices>',
    '    <triangles>',
    ...triLines,
    '    </triangles>',
    '   </mesh>',
    '  </object>',
    ' </resources>',
    ' <build>',
    '  <item objectid="2"/>',
    ' </build>',
    '</model>',
  ].join('\n');

  const contentTypesXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    ' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    ' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>',
    ' <Default Extension="config" ContentType="text/plain"/>',
    '</Types>',
  ].join('\n');

  const relsXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    ' <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2010/06/3dmodel"/>',
    '</Relationships>',
  ].join('\n');

  const projectSettings = {
    filament_colour: channels.map((c) => c.hex),
    filament_type: channels.map(() => 'PLA'),
    filament_settings_id: channels.map((c) => c.settingsId),
  };

  const modelSettingsXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<config>',
    '  <object id="2">',
    `    <metadata key="name" value="${safeTitle}"/>`,
    '    <metadata key="extruder" value="1"/>',
    '    <part id="2" subtype="normal_part">',
    `      <metadata key="name" value="${safeTitle}"/>`,
    '      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>',
    '    </part>',
    '  </object>',
    '  <plate>',
    '    <metadata key="plater_id" value="1"/>',
    `    <metadata key="plater_name" value="Bambu ${channels.length}-Color Plate"/>`,
    '    <metadata key="locked" value="false"/>',
    '    <model_instance>',
    '      <metadata key="object_id" value="2"/>',
    '      <metadata key="instance_id" value="0"/>',
    '      <metadata key="identify_id" value="1"/>',
    '    </model_instance>',
    '  </plate>',
    '</config>',
  ].join('\n');

  const zipBytes = zipSync(
    {
      '[Content_Types].xml': strToU8(contentTypesXml),
      '_rels/.rels': strToU8(relsXml),
      '3D/3dmodel.model': strToU8(modelXml),
      'Metadata/project_settings.config': strToU8(JSON.stringify(projectSettings, null, 2)),
      'Metadata/model_settings.config': strToU8(modelSettingsXml),
    },
    { level: 6 },
  );

  const filaments: ExportedFilamentInfo[] = channels.map((c, i) => ({
    slot: i + 1,
    name: c.name,
    hex: c.hex,
    settingsId: c.settingsId,
  }));

  return { bytes: zipBytes, filaments, triangleCount };
}

/**
 * Generates a standard binary STL (Uint8Array) in Z-up millimeter space resting flush on Z=0.
 */
export function buildBinaryStl(
  groups: ExportMeshGroup[],
  groundOnBuildPlate = true,
): { bytes: Uint8Array; triangleCount: number } {
  const nonEmpty = groups.filter((g) => g.positions.length > 0 && g.indices.length > 0);
  if (nonEmpty.length === 0) {
    throw new Error('Cannot export STL: model has no mesh geometry');
  }

  let totalTris = 0;
  for (const g of nonEmpty) {
    totalTris += Math.floor(g.indices.length / 3);
  }

  const bounds = computeBounds(nonEmpty);
  const offX = groundOnBuildPlate ? -(bounds.minX + bounds.maxX) * 0.5 : 0;
  const offY = groundOnBuildPlate ? -(bounds.minY + bounds.maxY) * 0.5 : 0;
  const offZ = groundOnBuildPlate ? -bounds.minZ : 0;

  const out = new Uint8Array(84 + totalTris * 50);
  const headerText = 'Exported by Antigravity 3D Print Viewer (mm)';
  for (let i = 0; i < headerText.length && i < 80; i++) {
    out[i] = headerText.charCodeAt(i);
  }
  const view = new DataView(out.buffer);
  view.setUint32(80, totalTris, true);

  let offset = 84;
  for (const g of nonEmpty) {
    const p = g.positions;
    const idx = g.indices;
    for (let i = 0; i + 2 < idx.length; i += 3) {
      const i0 = idx[i] * 3;
      const i1 = idx[i + 1] * 3;
      const i2 = idx[i + 2] * 3;

      const x0 = p[i0] + offX, y0 = p[i0 + 1] + offY, z0 = p[i0 + 2] + offZ;
      const x1 = p[i1] + offX, y1 = p[i1 + 1] + offY, z1 = p[i1 + 2] + offZ;
      const x2 = p[i2] + offX, y2 = p[i2 + 1] + offY, z2 = p[i2 + 2] + offZ;

      const ax = x1 - x0, ay = y1 - y0, az = z1 - z0;
      const bx = x2 - x0, by = y2 - y0, bz = z2 - z0;
      let nx = ay * bz - az * by;
      let ny = az * bx - ax * bz;
      let nz = ax * by - ay * bx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;

      view.setFloat32(offset, nx, true);
      view.setFloat32(offset + 4, ny, true);
      view.setFloat32(offset + 8, nz, true);

      view.setFloat32(offset + 12, x0, true);
      view.setFloat32(offset + 16, y0, true);
      view.setFloat32(offset + 20, z0, true);

      view.setFloat32(offset + 24, x1, true);
      view.setFloat32(offset + 28, y1, true);
      view.setFloat32(offset + 32, z1, true);

      view.setFloat32(offset + 36, x2, true);
      view.setFloat32(offset + 40, y2, true);
      view.setFloat32(offset + 44, z2, true);

      view.setUint16(offset + 48, 0, true);
      offset += 50;
    }
  }

  return { bytes: out, triangleCount: totalTris };
}
