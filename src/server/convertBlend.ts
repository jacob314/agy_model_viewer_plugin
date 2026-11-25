import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { optimizeGlbIfNeeded } from './optimizeGlb.js';

const execFileAsync = promisify(execFile);
const MAX_CACHED_BLENDS = 12;

let cachedBlenderBin: string | null | undefined;

export function findBlenderBinary(): string | null {
  if (cachedBlenderBin !== undefined) return cachedBlenderBin;

  const candidates: string[] = [];
  if (process.env.BLENDER_PATH) {
    candidates.push(process.env.BLENDER_PATH);
  }

  // Standard macOS locations (including versioned Blender*.app bundles)
  if (process.platform === 'darwin') {
    candidates.push('/Applications/Blender.app/Contents/MacOS/Blender');
    try {
      const apps = fs.readdirSync('/Applications');
      for (const entry of apps) {
        if (/^Blender.*\.app$/i.test(entry) && entry !== 'Blender.app') {
          candidates.push(path.join('/Applications', entry, 'Contents/MacOS/Blender'));
        }
      }
    } catch {
      // Ignore
    }
    candidates.push('/opt/homebrew/bin/blender', '/usr/local/bin/blender');
  } else if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    try {
      const bfDir = path.join(pf, 'Blender Foundation');
      if (fs.existsSync(bfDir)) {
        for (const sub of fs.readdirSync(bfDir).sort().reverse()) {
          candidates.push(path.join(bfDir, sub, 'blender.exe'));
        }
      }
    } catch {
      // Ignore
    }
  } else {
    candidates.push('/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender');
  }

  // Also check PATH entries
  const pathEnv = process.env.PATH || '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(path.join(dir, process.platform === 'win32' ? 'blender.exe' : 'blender'));
  }

  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) {
        fs.accessSync(c, fs.constants.X_OK);
        cachedBlenderBin = c;
        return c;
      }
    } catch {
      // Continue
    }
  }

  cachedBlenderBin = null;
  return null;
}

/**
 * Blender Python script compatible with Blender 3.x / 4.x / 5.x.
 * Exports visible renderable geometry with modifiers applied, textures & materials intact,
 * excluding camera/light/animation clutter. Falls back to all objects if all were hidden.
 */
const BLEND_TO_GLB_PY = `
import bpy, sys, os

out_path = sys.argv[-1]
props = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())

def has_visible_geo():
    for obj in bpy.context.scene.objects:
        if obj.type in {'MESH', 'CURVE', 'SURFACE', 'FONT', 'META'} and obj.visible_get():
            return True
    return False

use_vis = has_visible_geo()

kwargs = {
    'filepath': out_path,
    'export_format': 'GLB',
    'use_visible': use_vis,
    'export_apply': True,
    'export_cameras': False,
    'export_lights': False,
    'export_animations': False,
    'export_materials': 'EXPORT',
    'export_texcoords': True,
    'export_normals': True,
}
if 'export_attributes' in props:
    kwargs['export_attributes'] = True
elif 'export_colors' in props:
    kwargs['export_colors'] = True

# Filter kwargs to supported RNA properties for cross-version safety
safe_kwargs = {k: v for k, v in kwargs.items() if k in props}
bpy.ops.export_scene.gltf(**safe_kwargs)
if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
    raise RuntimeError('Blender produced an empty GLB export')
`;

function pruneCacheDir(cacheDir: string): void {
  try {
    const entries = fs
      .readdirSync(cacheDir)
      .filter((f) => f.endsWith('.glb'))
      .map((f) => {
        const full = path.join(cacheDir, f);
        return { full, mtimeMs: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const stale of entries.slice(MAX_CACHED_BLENDS)) {
      fs.rmSync(stale.full, { force: true });
    }
  } catch {
    // Non-fatal
  }
}

export async function convertBlendToOptimizedGlb(
  blendAbsPath: string,
  dataDir: string,
): Promise<Buffer> {
  const stat = fs.statSync(blendAbsPath);
  const cacheDir = path.join(dataDir, 'blend_cache');
  const hash = crypto
    .createHash('sha256')
    .update(`${blendAbsPath}|${stat.mtimeMs}|${stat.size}`)
    .digest('hex')
    .slice(0, 20);
  const cachePath = path.join(cacheDir, `${hash}.glb`);

  if (fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath);
  }

  const blenderBin = findBlenderBinary();
  if (!blenderBin) {
    throw new Error(
      'Blender is required to view .blend files directly. Install Blender (e.g. /Applications/Blender.app) or set BLENDER_PATH.',
    );
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3dv-blend-'));
  const rawGlbPath = path.join(tmpDir, 'export.glb');
  try {
    await execFileAsync(
      blenderBin,
      ['-b', '--factory-startup', blendAbsPath, '--python-expr', BLEND_TO_GLB_PY, '--', rawGlbPath],
      {
        timeout: 90_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    if (!fs.existsSync(rawGlbPath)) {
      throw new Error(`Blender failed to export ${path.basename(blendAbsPath)} to GLB.`);
    }

    const rawGlb = fs.readFileSync(rawGlbPath);
    const optimized = await optimizeGlbIfNeeded(rawGlb);

    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(cachePath, optimized);
      pruneCacheDir(cacheDir);
    } catch {
      // Non-fatal if cache dir not writable
    }

    return optimized;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function convertBlendBufferToOptimizedGlb(
  blendBytes: Buffer,
  dataDir: string,
): Promise<Buffer> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3dv-blend-buf-'));
  const tmpBlend = path.join(tmpDir, 'input.blend');
  try {
    fs.writeFileSync(tmpBlend, blendBytes);
    return await convertBlendToOptimizedGlb(tmpBlend, dataDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
