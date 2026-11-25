import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { parseStlToM3dv } from './parseStl.js';
import { parse3mfToM3dv } from './parse3mf.js';
import { optimizeGlbIfNeeded } from './optimizeGlb.js';
import { exportServerRegisteredModel, pickNonClobberingPath } from './serverExport.js';
import type {
  BackdropMode,
  ColorMode,
  ExportResultResponse,
  FileViewerPayload,
  LoadChunkResponse,
  ModelSlotMeta,
  PromoteInlineResponse,
  SupportedFormat,
  ViewerLayout,
  ViewerSessionPayload,
} from '../shared/types.js';

const APP_URI = 'ui://model3d-viewer/app.html';
// 512 KiB raw -> ~699 KiB base64 JSON, comfortably below Antigravity's 1 MiB MCP payload cap
const CHUNK_SIZE_BYTES = 524_288;
const PROMOTED_SESSION_TTL_MS = 30_000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..');

let DATA_DIR = path.join(PLUGIN_ROOT, '.data');
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--data-dir=')) {
    DATA_DIR = arg.slice('--data-dir='.length);
  }
}

const DEFAULT_SLOT_COLORS = ['#38BDF8', '#00AE42', '#FF6A13', '#A855F7', '#F43F5E'];

const SUPPORTED_EXT_MAP: Record<string, SupportedFormat> = {
  '.3mf': '3mf',
  '.stl': 'stl',
  '.glb': 'glb',
  '.gltf': 'gltf',
  '.obj': 'obj',
  '.ply': 'ply',
};

interface RegisteredModel {
  id: string;
  absPath: string;
  dirPath: string;
  meta: ModelSlotMeta;
}

interface CompiledCacheEntry {
  mtimeMs: number;
  defaultColor: string;
  buffer: Buffer;
}

interface PromotedInlineSession {
  createdAt: number;
  activeFileName: string;
  payload: ViewerSessionPayload;
}

const registeredModels = new Map<string, RegisteredModel>();
const compiledM3dvCache = new Map<string, CompiledCacheEntry>();
const pendingExportUploads = new Map<string, Buffer[]>();
let pendingPromotedSession: PromotedInlineSession | null = null;

function lastSessionPath(): string {
  return path.join(DATA_DIR, 'last_session.json');
}

interface PersistedSession {
  title: string;
  activeIndex: number;
  background: BackdropMode;
  colorMode: ColorMode;
  bambuMatch: boolean;
  deskMat?: boolean;
  models: Array<{ path: string; label?: string; color?: string }>;
}

function saveLastSession(session: PersistedSession): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(lastSessionPath(), JSON.stringify(session, null, 2), 'utf8');
  } catch {
    // Non-fatal
  }
}

function loadLastSession(): PersistedSession | null {
  try {
    const p = lastSessionPath();
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!raw || !Array.isArray(raw.models)) return null;
    const existing = raw.models.filter(
      (m: { path?: string }) => typeof m?.path === 'string' && fs.existsSync(m.path),
    );
    if (existing.length === 0) return null;
    return { ...raw, models: existing.slice(0, 5) };
  } catch {
    return null;
  }
}

function makeModelId(absPath: string, defaultColor: string): string {
  return crypto
    .createHash('sha256')
    .update(`${absPath}|${defaultColor}`)
    .digest('hex')
    .slice(0, 16);
}

function registerModelList(
  items: Array<{ path: string; label?: string; color?: string }>,
): ModelSlotMeta[] {
  const metas: ModelSlotMeta[] = [];

  for (let i = 0; i < Math.min(items.length, 5); i++) {
    const item = items[i];
    const absPath = path.resolve(item.path);
    if (!fs.existsSync(absPath)) {
      throw new Error(`File not found: ${absPath}`);
    }
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) {
      throw new Error(`Path is not a file: ${absPath}`);
    }
    const ext = path.extname(absPath).toLowerCase();
    const format = SUPPORTED_EXT_MAP[ext];
    if (!format) {
      throw new Error(
        `Unsupported 3D format "${ext}" for ${path.basename(absPath)}. Supported: .3mf, .stl, .obj, .glb, .gltf, .ply`,
      );
    }

    const defaultColor =
      item.color && /^#?[0-9a-fA-F]{6}$/.test(item.color)
        ? (item.color.startsWith('#') ? item.color : `#${item.color}`).toUpperCase()
        : DEFAULT_SLOT_COLORS[i % DEFAULT_SLOT_COLORS.length];

    const id = makeModelId(absPath, defaultColor);
    const fileName = path.basename(absPath);
    const label = (item.label && item.label.trim()) || fileName.replace(/\.[^.]+$/, '');
    const transport: 'm3dv' | 'raw' = format === '3mf' || format === 'stl' ? 'm3dv' : 'raw';

    const meta: ModelSlotMeta = {
      id,
      label,
      fileName,
      format,
      sizeBytes: stat.size,
      defaultColor,
      transport,
    };

    registeredModels.set(id, {
      id,
      absPath,
      dirPath: path.dirname(absPath),
      meta,
    });

    metas.push(meta);
  }

  return metas;
}

function getCompiledBuffer(reg: RegisteredModel): Buffer {
  const stat = fs.statSync(reg.absPath);
  const color = reg.meta.defaultColor || '#4F8EF7';
  const cached = compiledM3dvCache.get(reg.id);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.defaultColor === color) {
    return cached.buffer;
  }

  const rawBuf = fs.readFileSync(reg.absPath);
  const compiled =
    reg.meta.format === '3mf'
      ? parse3mfToM3dv(rawBuf, color)
      : parseStlToM3dv(rawBuf, color);

  if (compiledM3dvCache.size >= 10) {
    const oldestKey = compiledM3dvCache.keys().next().value;
    if (oldestKey) compiledM3dvCache.delete(oldestKey);
  }
  compiledM3dvCache.set(reg.id, { mtimeMs: stat.mtimeMs, defaultColor: color, buffer: compiled });
  return compiled;
}

async function getOptimizedGlbBuffer(reg: RegisteredModel): Promise<Buffer> {
  const stat = fs.statSync(reg.absPath);
  const cached = compiledM3dvCache.get(reg.id);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.buffer;
  }
  const rawBuf = fs.readFileSync(reg.absPath);
  const optimized = await optimizeGlbIfNeeded(rawBuf);
  if (compiledM3dvCache.size >= 10) {
    const oldestKey = compiledM3dvCache.keys().next().value;
    if (oldestKey) compiledM3dvCache.delete(oldestKey);
  }
  compiledM3dvCache.set(reg.id, {
    mtimeMs: stat.mtimeMs,
    defaultColor: reg.meta.defaultColor || '#38BDF8',
    buffer: optimized,
  });
  return optimized;
}

function mimeForFile(name: string): string {
  const ext = path.extname(name).toLowerCase();
  switch (ext) {
    case '.glb': return 'model/gltf-binary';
    case '.gltf': return 'model/gltf+json';
    case '.obj': return 'text/plain';
    case '.mtl': return 'text/plain';
    case '.ply': return 'application/octet-stream';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    default: return 'application/octet-stream';
  }
}

function readAppHtml(): string {
  const override = process.env.MODEL3D_VIEWER_APP_HTML;
  const htmlPath = override || path.join(PLUGIN_ROOT, 'dist', 'index.html');
  if (!fs.existsSync(htmlPath)) {
    throw new Error(`Viewer HTML bundle missing at ${htmlPath}. Run npm run build.`);
  }
  return fs.readFileSync(htmlPath, 'utf8');
}

const ModelInputSchema = z.object({
  path: z.string().describe('Absolute path to a .3mf, .stl, .obj, .glb, .gltf, or .ply file'),
  label: z.string().optional().describe('Short label for the model tab (max ~24 chars recommended)'),
  color: z.string().optional().describe('Optional #RRGGBB default filament color for monochrome meshes'),
});

const ViewerArgsShape = {
  models: z
    .array(ModelInputSchema)
    .max(5)
    .optional()
    .describe('Up to 5 3D printing model files (.3mf, .stl, .obj, .glb, .gltf, .ply) to toggle between'),
  activeIndex: z
    .number()
    .int()
    .min(0)
    .max(4)
    .optional()
    .describe('0-based index of the initially active model slot (default 0)'),
  title: z.string().optional().describe('Optional title displayed in the viewer header'),
  background: z
    .enum(['black', 'desk'])
    .optional()
    .describe('Initial backdrop: "black" (default, high contrast) or "desk" (natural oak desk)'),
  colorMode: z
    .enum(['color', 'grey'])
    .optional()
    .describe('Initial color state: "color" (default) or "grey" (neutral inspection grey)'),
  bambuMatch: z
    .boolean()
    .optional()
    .describe('Whether to start with Bambu Lab filament color matching enabled (default false)'),
  deskMat: z
    .boolean()
    .optional()
    .describe('Whether to show the grey maker mat on the oak desk (default false)'),
};

function buildViewerSessionResult(
  layout: ViewerLayout,
  args: {
    models?: Array<{ path: string; label?: string; color?: string }>;
    activeIndex?: number;
    title?: string;
    background?: BackdropMode;
    colorMode?: ColorMode;
    bambuMatch?: boolean;
    deskMat?: boolean;
  },
) {
  let effectiveModels = args.models;
  let effectiveTitle = args.title;
  let effectiveActive = args.activeIndex ?? 0;
  let effectiveBg: BackdropMode = args.background ?? 'black';
  let effectiveColor: ColorMode = args.colorMode ?? 'color';
  let effectiveBambu = args.bambuMatch ?? false;
  let effectiveMat = args.deskMat ?? false;

  if (!effectiveModels || effectiveModels.length === 0) {
    const prev = loadLastSession();
    if (prev) {
      effectiveModels = prev.models;
      effectiveTitle = effectiveTitle ?? prev.title;
      effectiveActive = args.activeIndex ?? prev.activeIndex;
      effectiveBg = args.background ?? prev.background;
      effectiveColor = args.colorMode ?? prev.colorMode;
      effectiveBambu = args.bambuMatch ?? prev.bambuMatch;
      effectiveMat = args.deskMat ?? prev.deskMat ?? false;
    } else {
      effectiveModels = [];
    }
  } else {
    saveLastSession({
      title: effectiveTitle || '3D Print Viewer',
      activeIndex: effectiveActive,
      background: effectiveBg,
      colorMode: effectiveColor,
      bambuMatch: effectiveBambu,
      deskMat: effectiveMat,
      models: effectiveModels,
    });
  }

  const metas = registerModelList(effectiveModels);
  const clampedActive = metas.length > 0 ? Math.min(Math.max(0, effectiveActive), metas.length - 1) : 0;

  const payload: ViewerSessionPayload = {
    kind: 'session',
    sessionId: crypto.randomUUID(),
    layout,
    title: effectiveTitle || (metas.length === 1 ? metas[0].label : '3D Print Viewer'),
    activeIndex: clampedActive,
    background: effectiveBg,
    colorMode: effectiveColor,
    bambuMatch: effectiveBambu,
    deskMat: effectiveMat,
    models: metas,
  };

  const summary =
    metas.length === 0
      ? 'Opened 3D Print Viewer (no models loaded yet — drop a .3mf, .stl, .obj, .glb, or .ply file into the viewer or pass file paths).'
      : `Loaded ${metas.length} model${metas.length === 1 ? '' : 's'} in ${layout === 'pane' ? 'Side Panel' : 'Inline Preview'}: ${metas
          .map((m, i) => `[${i + 1}] ${m.label} (${m.format.toUpperCase()}, ${(m.sizeBytes / 1024 / 1024).toFixed(2)} MB)`)
          .join(', ')}.`;

  return {
    content: [{ type: 'text' as const, text: summary }],
    structuredContent: payload as unknown as Record<string, unknown>,
  };
}

const server = new McpServer(
  {
    name: 'model3d-viewer',
    version: '1.4.1',
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  },
);

server.registerResource(
  '3D Print Viewer App',
  APP_URI,
  {
    description: 'Interactive Three.js 3D Print Model Viewer (STL, Bambu 3MF, OBJ, GLB, PLY)',
    mimeType: 'text/html;profile=mcp-app',
    _meta: {
      ui: {
        prefersBorder: false,
      },
    },
  },
  async () => ({
    contents: [
      {
        uri: APP_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: readAppHtml(),
      },
    ],
  }),
);

// 1. Primary Side Panel tool (aux_pane)
server.registerTool(
  'open_3d_viewer',
  {
    title: '3D Print Viewer',
    description:
      'Open or update up to 5 STL or Bambu Studio multi-color 3D models (.3mf, .stl, .obj, .glb, .gltf, .ply) in the full-height 3D Print Viewer side panel. Primary default viewer.',
    inputSchema: ViewerArgsShape,
    _meta: {
      ui: {
        resourceUri: APP_URI,
      },
      'com.google.antigravity/ui': {
        entrypoints: [{ type: 'aux_pane', title: '3D Print Viewer' }],
      },
    },
  },
  async (args) => buildViewerSessionResult('pane', args),
);

// 2. Compact Inline Chat Preview tool (no aux_pane entrypoint -> renders inline)
server.registerTool(
  'preview_3d_models_inline',
  {
    title: 'Inline 3D Preview',
    description:
      'Render a compact interactive 3D preview inline in the chat message for 1 to 5 STL or Bambu Studio multi-color 3D models (.3mf, .stl, .obj, .glb, .gltf, .ply).',
    inputSchema: {
      ...ViewerArgsShape,
      models: z
        .array(ModelInputSchema)
        .min(1)
        .max(5)
        .describe('1 to 5 3D printing model files to preview inline'),
    },
    _meta: {
      ui: {
        resourceUri: APP_URI,
      },
    },
  },
  async (args) => buildViewerSessionResult('inline', args),
);

// 3. Custom File Viewer entrypoint: opens any .3mf/.stl/.glb/.gltf/.obj/.ply directly in the side panel
//    AND powers zero-turn instant promotion from inline previews via com.google.antigravity/toggle-aux-pane!
server.registerTool(
  'view_3d_file',
  {
    title: '3D Print Viewer',
    description: 'Host-invoked custom file viewer for 3D printing models (.3mf, .stl, .glb, .gltf, .obj, .ply).',
    inputSchema: {
      file: z
        .object({
          name: z.string(),
          resourceUri: z.string(),
        })
        .optional(),
    },
    _meta: {
      ui: {
        resourceUri: APP_URI,
        visibility: ['app'],
      },
      'com.google.antigravity/ui': {
        entrypoints: [
          {
            type: 'file',
            title: '3D Print Viewer',
            extensions: ['.3mf', '.stl', '.glb', '.gltf', '.obj', '.ply'],
          },
        ],
      },
    },
  },
  async ({ file }) => {
    // Check if an inline preview just promoted its full 1-5 model session to the side panel!
    if (
      file &&
      pendingPromotedSession &&
      Date.now() - pendingPromotedSession.createdAt <= PROMOTED_SESSION_TTL_MS &&
      pendingPromotedSession.activeFileName.toLowerCase() === file.name.toLowerCase()
    ) {
      const promoted = pendingPromotedSession.payload;
      pendingPromotedSession = null;
      return {
        content: [
          {
            type: 'text' as const,
            text: `Opened promoted 3D Print Viewer session (${promoted.models.length} model${promoted.models.length === 1 ? '' : 's'}) in Side Panel.`,
          },
        ],
        structuredContent: promoted as unknown as Record<string, unknown>,
      };
    }

    if (!file) {
      return buildViewerSessionResult('pane', {});
    }

    // If this exact file is already registered on our server (e.g. from earlier in this session),
    // stream it via load_model_chunk so >10 MiB GLBs/STLs bypass Antigravity's 10 MiB antigravity-file:// cap!
    for (const reg of registeredModels.values()) {
      if (reg.meta.fileName.toLowerCase() === file.name.toLowerCase() && fs.existsSync(reg.absPath)) {
        const sessionPayload: ViewerSessionPayload = {
          kind: 'session',
          sessionId: crypto.randomUUID(),
          layout: 'pane',
          title: reg.meta.label,
          activeIndex: 0,
          background: 'black',
          colorMode: 'color',
          bambuMatch: false,
          deskMat: false,
          models: [reg.meta],
        };
        return {
          content: [{ type: 'text' as const, text: `Opened ${file.name} via optimized server stream.` }],
          structuredContent: sessionPayload as unknown as Record<string, unknown>,
        };
      }
    }

    const payload: FileViewerPayload = {
      kind: 'file_viewer',
      layout: 'pane',
      file: {
        name: file.name,
        resourceUri: file.resourceUri,
      },
    };
    return {
      content: [{ type: 'text' as const, text: `Opened ${file.name} in 3D Print Viewer.` }],
      structuredContent: payload as unknown as Record<string, unknown>,
    };
  },
);

// 4. App-only helper: Promotes the current inline multi-model state so toggle-aux-pane opens instantly with zero LLM turn
server.registerTool(
  'promote_inline_session',
  {
    title: 'Promote Inline Session to Side Panel',
    description: 'App-only tool that registers the active inline viewer state and returns the active file:// URI for instant side-pane opening.',
    inputSchema: {
      modelIds: z.array(z.string()).min(1).max(5),
      activeIndex: z.number().int().min(0).max(4).default(0),
      title: z.string().optional(),
      background: z.enum(['black', 'desk']).default('black'),
      colorMode: z.enum(['color', 'grey']).default('color'),
      bambuMatch: z.boolean().default(false),
      deskMat: z.boolean().default(false),
    },
    _meta: {
      ui: {
        visibility: ['app'],
      },
    },
  },
  async ({ modelIds, activeIndex, title, background, colorMode, bambuMatch, deskMat }) => {
    const regs: RegisteredModel[] = [];
    for (const id of modelIds) {
      const reg = registeredModels.get(id);
      if (reg) regs.push(reg);
    }
    if (regs.length === 0) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: 'No registered models found for promotion.' }],
      };
    }

    const clampedActive = Math.min(Math.max(0, activeIndex), regs.length - 1);
    const activeReg = regs[clampedActive];
    const fileUri = pathToFileURL(activeReg.absPath).href;

    const promotedPayload: ViewerSessionPayload = {
      kind: 'session',
      sessionId: crypto.randomUUID(),
      layout: 'pane',
      title: title || (regs.length === 1 ? activeReg.meta.label : '3D Print Viewer'),
      activeIndex: clampedActive,
      background,
      colorMode,
      bambuMatch,
      deskMat,
      models: regs.map((r) => r.meta),
    };

    pendingPromotedSession = {
      createdAt: Date.now(),
      activeFileName: activeReg.meta.fileName,
      payload: promotedPayload,
    };

    saveLastSession({
      title: promotedPayload.title,
      activeIndex: clampedActive,
      background,
      colorMode,
      bambuMatch,
      deskMat,
      models: regs.map((r) => ({
        path: r.absPath,
        label: r.meta.label,
        color: r.meta.defaultColor,
      })),
    });

    const resp: PromoteInlineResponse = {
      fileUri,
      fileName: activeReg.meta.fileName,
    };
    return {
      content: [{ type: 'text' as const, text: `Prepared side panel view for ${activeReg.meta.fileName}` }],
      structuredContent: resp as unknown as Record<string, unknown>,
    };
  },
);

// 5. App-only chunked geometry & sibling asset loader
server.registerTool(
  'load_model_chunk',
  {
    title: 'Load Model Chunk',
    description: 'App-only tool to stream geometry or sibling material/texture chunks for registered models.',
    inputSchema: {
      modelId: z.string().describe('Registered model ID from view session payload'),
      chunkIndex: z.number().int().min(0).default(0),
      assetName: z
        .string()
        .optional()
        .describe('Optional sibling relative asset path (e.g. .mtl, .png, .bin) inside the model directory'),
    },
    _meta: {
      ui: {
        visibility: ['app'],
      },
    },
  },
  async ({ modelId, chunkIndex, assetName }) => {
    const reg = registeredModels.get(modelId);
    if (!reg) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `Unknown modelId: ${modelId}` }],
      };
    }

    let dataBuffer: Buffer;
    let transport: 'm3dv' | 'raw' = reg.meta.transport;
    let mimeType = 'application/octet-stream';
    let resolvedAssetName = reg.meta.fileName;

    if (assetName) {
      const safeRel = assetName.replace(/\\/g, '/').replace(/^\/+/, '');
      const candidate = path.resolve(reg.dirPath, safeRel);
      const relCheck = path.relative(reg.dirPath, candidate);
      if (relCheck.startsWith('..') || path.isAbsolute(relCheck) || !fs.existsSync(candidate)) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Sibling asset not found or disallowed: ${assetName}` }],
        };
      }
      dataBuffer = fs.readFileSync(candidate);
      transport = 'raw';
      mimeType = mimeForFile(candidate);
      resolvedAssetName = safeRel;
    } else if (reg.meta.transport === 'm3dv') {
      dataBuffer = getCompiledBuffer(reg);
      mimeType = 'application/x-m3dv';
    } else if (reg.meta.format === 'glb') {
      dataBuffer = await getOptimizedGlbBuffer(reg);
      mimeType = 'model/gltf-binary';
    } else {
      dataBuffer = fs.readFileSync(reg.absPath);
      mimeType = mimeForFile(reg.absPath);
    }

    const totalBytes = dataBuffer.length;
    const totalChunks = Math.max(1, Math.ceil(totalBytes / CHUNK_SIZE_BYTES));
    const clampedIdx = Math.min(Math.max(0, chunkIndex), totalChunks - 1);
    const start = clampedIdx * CHUNK_SIZE_BYTES;
    const end = Math.min(start + CHUNK_SIZE_BYTES, totalBytes);
    const slice = dataBuffer.subarray(start, end);

    const resp: LoadChunkResponse = {
      modelId,
      assetName: resolvedAssetName,
      transport,
      totalBytes,
      chunkIndex: clampedIdx,
      totalChunks,
      mimeType,
      dataBase64: slice.toString('base64'),
    };

    return {
      content: [
        {
          type: 'text' as const,
          text: `Chunk ${clampedIdx + 1}/${totalChunks} (${slice.length} bytes)`,
        },
      ],
      structuredContent: resp as unknown as Record<string, unknown>,
    };
  },
);

// 6. App-only server-side exporter for registered .3mf / .stl models (full resolution, saved next to source)
server.registerTool(
  'export_3d_model',
  {
    title: 'Export 3D Print Model',
    description:
      'App-only tool to export a registered 3MF or STL model directly to Bambu Studio multi-color .3mf or binary .stl on disk.',
    inputSchema: {
      modelId: z.string(),
      exportFormat: z.enum(['bambu-3mf', 'bambu-3mf-matched', 'stl']),
      bambuMatch: z.boolean().default(false),
      bambuScope: z.enum(['basic-matte', 'matte', 'basic', 'all']).default('basic-matte'),
      colorOn: z.boolean().default(true),
    },
    _meta: {
      ui: {
        visibility: ['app'],
      },
    },
  },
  async ({ modelId, exportFormat, bambuMatch, bambuScope, colorOn }) => {
    const reg = registeredModels.get(modelId);
    if (!reg) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `Unknown modelId: ${modelId}` }],
      };
    }
    if (reg.meta.format !== '3mf' && reg.meta.format !== 'stl') {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: `Server-side direct export only applies to .3mf/.stl; use save_exported_file_chunk for ${reg.meta.format}`,
          },
        ],
      };
    }

    try {
      const result = exportServerRegisteredModel({
        absPath: reg.absPath,
        format: reg.meta.format,
        label: reg.meta.label,
        defaultColor: reg.meta.defaultColor || '#38BDF8',
        exportFormat,
        snapToBambu: bambuMatch,
        bambuScope,
        colorOn,
      });

      const resp: ExportResultResponse = {
        savedPath: result.savedPath,
        fileName: result.fileName,
        sizeBytes: result.sizeBytes,
        exportFormat,
        triangleCount: result.triangleCount,
        filamentCount: result.filaments?.length,
        filaments: result.filaments?.map((f) => ({ slot: f.slot, name: f.name, hex: f.hex })),
      };

      return {
        content: [{ type: 'text' as const, text: `Exported ${result.fileName} to ${result.savedPath}` }],
        structuredContent: resp as unknown as Record<string, unknown>,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `Export failed: ${msg}` }],
      };
    }
  },
);

// 7. App-only chunked saver for client-built exports (.glb/.gltf/.obj/.ply/dropped/file-viewer -> .3mf or .stl)
server.registerTool(
  'save_exported_file_chunk',
  {
    title: 'Save Exported 3D File Chunk',
    description: 'App-only tool that receives base64 chunks of a client-exported .3mf or .stl and writes it to disk.',
    inputSchema: {
      uploadId: z.string(),
      modelId: z.string().optional(),
      baseStem: z.string(),
      extWithDot: z.enum(['.3mf', '.stl']),
      exportFormat: z.enum(['bambu-3mf', 'bambu-3mf-matched', 'stl']),
      chunkIndex: z.number().int().min(0),
      totalChunks: z.number().int().min(1),
      dataBase64: z.string(),
      triangleCount: z.number().int().min(0).default(0),
      filaments: z
        .array(z.object({ slot: z.number().int(), name: z.string(), hex: z.string() }))
        .optional(),
    },
    _meta: {
      ui: {
        visibility: ['app'],
      },
    },
  },
  async ({
    uploadId,
    modelId,
    baseStem,
    extWithDot,
    exportFormat,
    chunkIndex,
    totalChunks,
    dataBase64,
    triangleCount,
    filaments,
  }) => {
    let chunks = pendingExportUploads.get(uploadId);
    if (!chunks || chunkIndex === 0) {
      chunks = new Array<Buffer>(totalChunks);
      pendingExportUploads.set(uploadId, chunks);
    }
    chunks[chunkIndex] = Buffer.from(dataBase64, 'base64');

    if (chunkIndex < totalChunks - 1) {
      return {
        content: [{ type: 'text' as const, text: `Received export chunk ${chunkIndex + 1}/${totalChunks}` }],
        structuredContent: { received: chunkIndex + 1, totalChunks },
      };
    }

    pendingExportUploads.delete(uploadId);
    const fullBuf = Buffer.concat(chunks.filter(Boolean));
    const reg = modelId ? registeredModels.get(modelId) : undefined;
    const targetDir = reg ? reg.dirPath : '';
    const savedPath = pickNonClobberingPath(targetDir, baseStem, extWithDot);
    fs.writeFileSync(savedPath, fullBuf);

    const resp: ExportResultResponse = {
      savedPath,
      fileName: path.basename(savedPath),
      sizeBytes: fullBuf.length,
      exportFormat,
      triangleCount,
      filamentCount: filaments?.length,
      filaments,
    };

    return {
      content: [{ type: 'text' as const, text: `Saved exported model to ${savedPath}` }],
      structuredContent: resp as unknown as Record<string, unknown>,
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('model3d-viewer MCP server fatal error:', err);
  process.exit(1);
});
