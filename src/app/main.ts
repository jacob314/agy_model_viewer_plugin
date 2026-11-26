import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import { z } from 'zod';
import type {
  AnyViewerPayload,
  BackdropMode,
  ExportFormatOption,
  ExportResultResponse,
  FileViewerPayload,
  LoadChunkResponse,
  ModelSlotMeta,
  PromoteInlineResponse,
  SupportedFormat,
  ViewerSessionPayload,
} from '../shared/types.js';
import type { BambuPaletteScope } from './bambu/palette.js';
import { SceneManager } from './viewer/SceneManager.js';
import { loadModelFromBytes, type LoadedModelBundle } from './viewer/loadModel.js';
import { exportBundleClientSide } from './viewer/clientExport.js';
import type { SwatchEntry } from './viewer/materials.js';

// Optional local browser test hooks (never set in production MCP App)
declare global {
  interface Window {
    __TEST_SESSION__?: ViewerSessionPayload;
    __TEST_FETCH_CHUNK__?: (
      modelId: string,
      chunkIndex: number,
      assetName?: string,
    ) => Promise<LoadChunkResponse>;
  }
}

const slotsRow = document.getElementById('slotsRow')!;
const btnColorToggle = document.getElementById('btnColorToggle') as HTMLButtonElement;
const lblColorToggle = document.getElementById('lblColorToggle')!;
const btnBambuToggle = document.getElementById('btnBambuToggle') as HTMLButtonElement;
const btnBackdropToggle = document.getElementById('btnBackdropToggle') as HTMLButtonElement;
const lblBackdropToggle = document.getElementById('lblBackdropToggle')!;
const btnMatToggle = document.getElementById('btnMatToggle') as HTMLButtonElement;
const lblMatToggle = document.getElementById('lblMatToggle')!;
const btnResetView = document.getElementById('btnResetView') as HTMLButtonElement;
const exportMenuWrap = document.getElementById('exportMenuWrap')!;
const btnExportMenu = document.getElementById('btnExportMenu') as HTMLButtonElement;
const exportDropdown = document.getElementById('exportDropdown')!;
const exportToast = document.getElementById('exportToast')!;
const exportToastTitle = document.getElementById('exportToastTitle')!;
const exportToastMeta = document.getElementById('exportToastMeta')!;
const exportToastPath = document.getElementById('exportToastPath')!;
const btnCloseToast = document.getElementById('btnCloseToast') as HTMLButtonElement;
const btnCopyExportPath = document.getElementById('btnCopyExportPath') as HTMLButtonElement;
const btnPopSidePane = document.getElementById('btnPopSidePane') as HTMLButtonElement;
const stageWrap = document.getElementById('stageWrap')!;
const canvasHost = document.getElementById('canvasHost')!;
const interactionBadge = document.getElementById('interactionBadge')!;
const loadingOverlay = document.getElementById('loadingOverlay')!;
const loadingLabel = document.getElementById('loadingLabel')!;
const loadingBar = document.getElementById('loadingBar')!;
const errorOverlay = document.getElementById('errorOverlay')!;
const errorDetail = document.getElementById('errorDetail')!;
const btnErrorFallback = document.getElementById('btnErrorFallback') as HTMLButtonElement;
const emptyOverlay = document.getElementById('emptyOverlay')!;
const localFileInput = document.getElementById('localFileInput') as HTMLInputElement;
const swatchList = document.getElementById('swatchList')!;
const bambuScopeSelect = document.getElementById('bambuScopeSelect') as HTMLSelectElement;
const metaFormat = document.getElementById('metaFormat')!;
const metaDims = document.getElementById('metaDims')!;
const metaTris = document.getElementById('metaTris')!;

const state = {
  session: null as ViewerSessionPayload | null,
  models: [] as ModelSlotMeta[],
  activeIndex: 0,
  colorOn: true,
  bambuMatch: false,
  bambuScope: 'basic-matte' as BambuPaletteScope,
  backdrop: 'black' as BackdropMode,
  deskMat: false,
  loadedBundles: new Map<string, LoadedModelBundle>(),
  localFiles: new Map<string, Uint8Array>(),
  loadToken: 0,
};

const sceneManager = new SceneManager(canvasHost, {
  onDragState: (dragState, hoveringModel) => {
    interactionBadge.classList.remove('mode-object', 'mode-orbit');
    if (dragState === 'rotate-object') {
      interactionBadge.textContent = 'Spinning 3D object';
      interactionBadge.classList.add('mode-object');
    } else if (dragState === 'orbit') {
      interactionBadge.textContent = 'Orbiting camera';
      interactionBadge.classList.add('mode-orbit');
    } else if (hoveringModel) {
      interactionBadge.textContent = 'Click & drag to spin object • Alt+drag to orbit camera';
      interactionBadge.classList.add('mode-object');
    } else {
      interactionBadge.textContent = 'Drag model: spin object • Drag background: orbit camera';
    }
  },
});

const app = new App({ name: '3D Print Model Viewer', version: '1.5.1' }, {});
let mcpConnected = false;
let lastExportedPath = '';
let lastFailedFileName = '';

function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(i + step, bytes.length)));
  }
  return btoa(bin);
}

function triggerBrowserDownload(bytes: Uint8Array, fileName: string, mimeType: string): void {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy.buffer], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function showExportToast(opts: {
  title: string;
  meta: string;
  path?: string;
  isError?: boolean;
}): void {
  exportToast.classList.toggle('is-error', Boolean(opts.isError));
  exportToastTitle.textContent = opts.title;
  exportToastMeta.textContent = opts.meta;
  lastExportedPath = opts.path || '';
  exportToastPath.textContent = opts.path || '';
  exportToastPath.classList.toggle('hidden', !opts.path);
  btnCopyExportPath.classList.toggle('hidden', !opts.path);
  btnCopyExportPath.textContent = 'Copy Path';
  exportToast.classList.remove('hidden');
}

function closeExportDropdown(): void {
  exportDropdown.classList.add('hidden');
  btnExportMenu.setAttribute('aria-expanded', 'false');
}

async function runExport(exportFormat: ExportFormatOption): Promise<void> {
  closeExportDropdown();
  const meta = state.models[state.activeIndex];
  if (!meta) return;

  const isLocalOnly = state.localFiles.has(meta.id);
  const labelText =
    exportFormat === 'stl'
      ? 'Binary STL'
      : exportFormat === 'bambu-3mf-matched'
      ? 'Bambu Spool-Matched 3MF'
      : 'Bambu Multi-Color 3MF';

  showExportToast({
    title: `Exporting ${labelText}…`,
    meta: `Preparing ${meta.label} for 3D printing`,
  });

  try {
    // Path 1: Fast full-resolution server-side export for server-registered .3mf / .stl files
    if (mcpConnected && !isLocalOnly && (meta.format === '3mf' || meta.format === 'stl')) {
      const res = await app.callServerTool({
        name: 'export_3d_model',
        arguments: {
          modelId: meta.id,
          exportFormat,
          bambuMatch: state.bambuMatch,
          bambuScope: state.bambuScope,
          colorOn: state.colorOn,
        },
      });
      if (res.isError || !res.structuredContent) {
        const errText =
          res.content?.[0] && 'text' in res.content[0] ? res.content[0].text : 'Export failed';
        throw new Error(errText);
      }
      const data = res.structuredContent as unknown as ExportResultResponse;
      const mb = (data.sizeBytes / 1024 / 1024).toFixed(2);
      const filInfo = data.filamentCount
        ? ` • ${data.filamentCount} Bambu filament${data.filamentCount === 1 ? '' : 's'}`
        : '';
      showExportToast({
        title: `Exported ${data.fileName}`,
        meta: `${mb} MB • ${(data.triangleCount / 1000).toFixed(1)}k tris${filInfo}`,
        path: data.savedPath,
      });
      return;
    }

    // Path 2: Client-side export for .glb/.gltf/.obj/.ply, host file-viewer, or locally dropped files
    const bundle = state.loadedBundles.get(meta.id);
    if (!bundle) {
      throw new Error('Model is still loading. Please try exporting again once loaded.');
    }

    const built = exportBundleClientSide({
      bundle,
      title: meta.label,
      exportFormat,
      bambuMatch: state.bambuMatch,
      bambuScope: state.bambuScope,
      colorOn: state.colorOn,
    });

    const origStem = meta.fileName.replace(/\.[^.]+$/, '');
    const suffix =
      exportFormat === 'stl'
        ? '_print'
        : exportFormat === 'bambu-3mf-matched' || state.bambuMatch
        ? '_bambu_matched'
        : '_bambu_multicolor';
    const baseStem = `${origStem}${suffix}`;

    if (mcpConnected) {
      const CHUNK = 524_288; // 512 KiB raw (~699 KiB base64 JSON, safely below 1 MiB)
      const totalChunks = Math.max(1, Math.ceil(built.bytes.length / CHUNK));
      const uploadId = `exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      let finalResp: ExportResultResponse | null = null;

      for (let i = 0; i < totalChunks; i++) {
        const slice = built.bytes.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, built.bytes.length));
        const res = await app.callServerTool({
          name: 'save_exported_file_chunk',
          arguments: {
            uploadId,
            modelId: isLocalOnly ? undefined : meta.id,
            baseStem,
            extWithDot: built.extWithDot,
            exportFormat,
            chunkIndex: i,
            totalChunks,
            dataBase64: uint8ArrayToBase64(slice),
            triangleCount: built.triangleCount,
            filaments: built.filaments?.map((f) => ({ slot: f.slot, name: f.name, hex: f.hex })),
          },
        });
        if (res.isError) {
          const errText =
            res.content?.[0] && 'text' in res.content[0] ? res.content[0].text : 'Save failed';
          throw new Error(errText);
        }
        if (i === totalChunks - 1 && res.structuredContent) {
          finalResp = res.structuredContent as unknown as ExportResultResponse;
        }
      }

      if (finalResp) {
        const mb = (finalResp.sizeBytes / 1024 / 1024).toFixed(2);
        const filInfo = finalResp.filamentCount
          ? ` • ${finalResp.filamentCount} Bambu filament${finalResp.filamentCount === 1 ? '' : 's'}`
          : '';
        showExportToast({
          title: `Exported ${finalResp.fileName}`,
          meta: `${mb} MB • ${(finalResp.triangleCount / 1000).toFixed(1)}k tris${filInfo}`,
          path: finalResp.savedPath,
        });
        return;
      }
    }

    // Standalone browser fallback (direct file download)
    const outName = `${baseStem}${built.extWithDot}`;
    triggerBrowserDownload(built.bytes, outName, built.mimeType);
    const mb = (built.bytes.byteLength / 1024 / 1024).toFixed(2);
    const filInfo = built.filaments?.length ? ` • ${built.filaments.length} Bambu filaments` : '';
    showExportToast({
      title: `Downloaded ${outName}`,
      meta: `${mb} MB • ${(built.triangleCount / 1000).toFixed(1)}k tris${filInfo}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showExportToast({
      title: 'Export failed',
      meta: msg,
      isError: true,
    });
  }
}

async function fetchChunk(
  modelId: string,
  chunkIndex: number,
  assetName?: string,
): Promise<LoadChunkResponse> {
  if (window.__TEST_FETCH_CHUNK__) {
    return window.__TEST_FETCH_CHUNK__(modelId, chunkIndex, assetName);
  }
  const result = await app.callServerTool({
    name: 'load_model_chunk',
    arguments: assetName
      ? { modelId, chunkIndex, assetName }
      : { modelId, chunkIndex },
  });
  if (result.isError || !result.structuredContent) {
    const msg =
      result.content?.[0] && 'text' in result.content[0]
        ? result.content[0].text
        : 'Failed to load model chunk';
    throw new Error(msg);
  }
  return result.structuredContent as unknown as LoadChunkResponse;
}

async function fetchFullModelBytes(
  modelId: string,
  assetName?: string,
  onProgress?: (pct: number) => void,
): Promise<Uint8Array> {
  if (!assetName && state.localFiles.has(modelId)) {
    onProgress?.(100);
    return state.localFiles.get(modelId)!;
  }

  const first = await fetchChunk(modelId, 0, assetName);
  const totalChunks = first.totalChunks;
  const firstBytes = base64ToUint8Array(first.dataBase64);
  onProgress?.(Math.round((1 / totalChunks) * 100));

  if (totalChunks <= 1) {
    return firstBytes;
  }

  const full = new Uint8Array(first.totalBytes);
  full.set(firstBytes, 0);
  let writeOffset = firstBytes.length;

  // Stream up to 3 chunks concurrently (safely below Antigravity's 4 in-flight tool call cap)
  for (let idx = 1; idx < totalChunks; idx += 3) {
    const batch: Promise<LoadChunkResponse>[] = [fetchChunk(modelId, idx, assetName)];
    if (idx + 1 < totalChunks) {
      batch.push(fetchChunk(modelId, idx + 1, assetName));
    }
    if (idx + 2 < totalChunks) {
      batch.push(fetchChunk(modelId, idx + 2, assetName));
    }
    const responses = await Promise.all(batch);
    for (const r of responses) {
      const part = base64ToUint8Array(r.dataBase64);
      full.set(part, writeOffset);
      writeOffset += part.length;
    }
    onProgress?.(Math.min(100, Math.round(((idx + responses.length) / totalChunks) * 100)));
  }

  return full;
}

function showLoading(text: string, pct = 10): void {
  emptyOverlay.classList.add('hidden');
  errorOverlay.classList.add('hidden');
  loadingLabel.textContent = text;
  loadingBar.style.width = `${Math.max(8, Math.min(100, pct))}%`;
  loadingOverlay.classList.remove('hidden');
}

function hideOverlays(): void {
  loadingOverlay.classList.add('hidden');
  errorOverlay.classList.add('hidden');
  emptyOverlay.classList.add('hidden');
}

function showError(msg: string, fallbackFileName?: string): void {
  loadingOverlay.classList.add('hidden');
  emptyOverlay.classList.add('hidden');
  errorDetail.textContent = msg;
  lastFailedFileName = fallbackFileName || '';
  const canFallback =
    Boolean(fallbackFileName) && mcpConnected && Boolean(app.getHostCapabilities()?.message);
  btnErrorFallback.classList.toggle('hidden', !canFallback);
  errorOverlay.classList.remove('hidden');
}

function showEmpty(): void {
  loadingOverlay.classList.add('hidden');
  errorOverlay.classList.add('hidden');
  emptyOverlay.classList.remove('hidden');
}

function syncToolbar(): void {
  const colorDot = btnColorToggle.querySelector('.dot-color')!;
  btnColorToggle.classList.toggle('active', state.colorOn);
  colorDot.classList.toggle('grey', !state.colorOn);
  lblColorToggle.textContent = state.colorOn ? 'Color' : 'Grey';

  btnBambuToggle.classList.toggle('bambu-active', state.bambuMatch && state.colorOn);
  bambuScopeSelect.classList.toggle('hidden', !(state.bambuMatch && state.colorOn));
  bambuScopeSelect.value = state.bambuScope;

  btnBackdropToggle.classList.toggle('desk-active', state.backdrop === 'desk');
  lblBackdropToggle.textContent = state.backdrop === 'desk' ? 'Desk BG' : 'Black BG';

  btnMatToggle.classList.toggle('hidden', state.backdrop !== 'desk');
  btnMatToggle.classList.toggle('active', state.deskMat);
  lblMatToggle.textContent = state.deskMat ? 'Mat: On' : 'Mat: Off';
}

function renderSlots(): void {
  slotsRow.innerHTML = '';
  state.models.forEach((m, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `slot-btn${idx === state.activeIndex ? ' active' : ''}`;
    btn.title = `${m.fileName} (${m.format.toUpperCase()}) — Shortcut: ${idx + 1}`;
    btn.innerHTML = `<span class="slot-num">${idx + 1}</span><span class="slot-label"></span>`;
    (btn.querySelector('.slot-label') as HTMLElement).textContent = m.label;
    btn.addEventListener('click', () => {
      void activateSlot(idx);
    });
    slotsRow.appendChild(btn);
  });
}

function renderSwatches(swatches: SwatchEntry[]): void {
  swatchList.innerHTML = '';
  const visible = swatches.slice(0, 8);
  for (const sw of visible) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `swatch-chip${sw.muted || !state.colorOn ? ' muted' : ''}`;
    const displayHex =
      !state.colorOn || sw.muted
        ? '#9CA3AF'
        : state.bambuMatch && sw.bambuMatch
        ? sw.bambuMatch.filament.hex
        : sw.originalHex;

    const dot = document.createElement('span');
    dot.className = 'swatch-dot';
    dot.style.background = displayHex;
    chip.appendChild(dot);

    const text = document.createElement('span');
    if (state.colorOn && state.bambuMatch && sw.bambuMatch) {
      const f = sw.bambuMatch.filament;
      text.innerHTML = `<span class="swatch-bambu-tag">${f.line.replace('PLA ', '')}</span> ${f.name}`;
      chip.title = `${sw.name} (${sw.originalHex}) → Bambu Lab ${f.line} ${f.name} (${f.hex}, ΔE ${sw.bambuMatch.deltaE.toFixed(1)}). Click to toggle grey.`;
    } else {
      text.textContent = sw.name;
      chip.title = `${sw.name} (${sw.originalHex}). Click to toggle this color to grey.`;
    }
    chip.appendChild(text);

    if (!sw.key.startsWith('dyn:')) {
      chip.addEventListener('click', () => {
        if (!state.colorOn) {
          state.colorOn = true;
          syncToolbar();
        }
        const updated = sceneManager.toggleSwatchMuted(sw.key);
        renderSwatches(updated);
      });
    }
    swatchList.appendChild(chip);
  }
}

function renderMeta(bundle: LoadedModelBundle): void {
  const [dx, dy, dz] = bundle.dimensionsMm;
  metaFormat.textContent = bundle.formatLabel;
  metaDims.textContent = `${dx.toFixed(1)} × ${dy.toFixed(1)} × ${dz.toFixed(1)} mm`;
  const triStr =
    bundle.displayedTriangles >= 1000
      ? `${(bundle.displayedTriangles / 1000).toFixed(1)}k tris`
      : `${bundle.displayedTriangles} tris`;
  metaTris.textContent = bundle.decimated
    ? `${triStr} (of ${(bundle.originalTriangles / 1000).toFixed(0)}k)`
    : triStr;
}

async function activateSlot(index: number): Promise<void> {
  if (index < 0 || index >= state.models.length) return;
  state.activeIndex = index;
  renderSlots();

  const meta = state.models[index];
  const token = ++state.loadToken;

  try {
    let bundle = state.loadedBundles.get(meta.id);
    if (!bundle) {
      showLoading(`Loading ${meta.label} (${meta.format.toUpperCase()})…`, 12);
      const bytes = await fetchFullModelBytes(meta.id, undefined, (pct) => {
        if (token === state.loadToken) {
          loadingBar.style.width = `${Math.max(12, Math.round(pct * 0.85))}%`;
        }
      });
      if (token !== state.loadToken) return;

      showLoading(`Building 3D mesh for ${meta.label}…`, 92);
      bundle = await loadModelFromBytes(meta, bytes, (assetName) =>
        fetchFullModelBytes(meta.id, assetName),
      );
      if (token !== state.loadToken) return;
      state.loadedBundles.set(meta.id, bundle);
    }

    hideOverlays();
    const swatches = sceneManager.showModel(bundle);
    renderSwatches(swatches);
    renderMeta(bundle);
  } catch (err) {
    if (token !== state.loadToken) return;
    const message = err instanceof Error ? err.message : String(err);
    showError(message);
  }
}

function applySession(payload: ViewerSessionPayload): void {
  state.session = payload;
  document.body.dataset.layout = payload.layout || 'pane';

  // Show "Side Panel ↗" in compact inline layout whenever connected (opens instantly via toggle-aux-pane!)
  btnPopSidePane.classList.toggle(
    'hidden',
    payload.layout !== 'inline' || !mcpConnected || payload.models.length === 0,
  );
  // Show Export menu in BOTH inline and side-panel views whenever at least 1 model is loaded
  exportMenuWrap.classList.toggle('hidden', payload.models.length === 0);
  closeExportDropdown();
  exportToast.classList.add('hidden');

  state.models = payload.models.slice(0, 5);
  state.activeIndex = payload.activeIndex ?? 0;
  state.backdrop = payload.background ?? 'black';
  state.deskMat = Boolean(payload.deskMat);
  state.colorOn = payload.colorMode !== 'grey';
  state.bambuMatch = Boolean(payload.bambuMatch);

  sceneManager.setDeskMatVisible(state.deskMat);
  sceneManager.setBackdrop(state.backdrop);
  syncToolbar();
  renderSlots();

  if (state.models.length === 0) {
    showEmpty();
    swatchList.innerHTML = '';
    metaFormat.textContent = '—';
    metaDims.textContent = 'No model loaded';
    metaTris.textContent = '';
    return;
  }

  void activateSlot(state.activeIndex);
}

async function openHostFileViewer(file: FileViewerPayload['file']): Promise<void> {
  document.body.dataset.layout = 'pane';
  btnPopSidePane.classList.add('hidden');

  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'blend') {
    showError(
      `${file.name} is a Blender file and needs server-side Blender conversion. Click below to open it via the 3D Print Viewer server.`,
      file.name,
    );
    return;
  }
  const supported = new Set(['stl', '3mf', 'glb', 'gltf', 'obj', 'ply']);
  if (!supported.has(ext)) {
    showError(`Unsupported 3D file extension ".${ext}" for ${file.name}`);
    return;
  }

  showLoading(`Reading ${file.name}…`, 25);
  try {
    const res = await app.request(
      {
        method: 'resources/read',
        params: { uri: file.resourceUri },
      },
      z
        .object({
          contents: z.array(
            z
              .object({
                blob: z.string().optional(),
                text: z.string().optional(),
              })
              .passthrough(),
          ),
        })
        .passthrough(),
    );

    const item = res.contents?.[0];
    if (!item || (!item.blob && !item.text)) {
      throw new Error(`No file data returned for ${file.name}`);
    }
    const bytes = item.blob
      ? base64ToUint8Array(item.blob)
      : new TextEncoder().encode(item.text!);

    const id = `host-file-${Date.now()}-${file.name}`;
    state.localFiles.set(id, bytes);
    applySession({
      kind: 'session',
      sessionId: id,
      layout: 'pane',
      title: file.name,
      activeIndex: 0,
      background: state.backdrop,
      colorMode: state.colorOn ? 'color' : 'grey',
      bambuMatch: state.bambuMatch,
      deskMat: state.deskMat,
      models: [
        {
          id,
          label: file.name.replace(/\.[^.]+$/, ''),
          fileName: file.name,
          format: ext as SupportedFormat,
          sizeBytes: bytes.byteLength,
          defaultColor: '#38BDF8',
          transport: 'raw',
        },
      ],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTooLarge = /10\s*m|too large|exceed|size|limit/i.test(msg);
    if (isTooLarge) {
      showError(
        `${file.name} exceeds Antigravity's 10 MiB direct file-viewer limit. Click below to open it through the 3D Print Viewer server (auto-optimizes large GLBs/STLs with no 10 MiB limit), or drop the file onto this window.`,
        file.name,
      );
    } else {
      showError(msg, file.name);
    }
  }
}

// --- Toolbar Events ---
btnColorToggle.addEventListener('click', () => {
  state.colorOn = !state.colorOn;
  syncToolbar();
  const swatches = sceneManager.applyAppearance(state.colorOn, state.bambuMatch, state.bambuScope);
  renderSwatches(swatches);
});

btnBambuToggle.addEventListener('click', () => {
  state.bambuMatch = !state.bambuMatch;
  if (state.bambuMatch && !state.colorOn) {
    state.colorOn = true;
  }
  syncToolbar();
  const swatches = sceneManager.applyAppearance(state.colorOn, state.bambuMatch, state.bambuScope);
  renderSwatches(swatches);
});

bambuScopeSelect.addEventListener('change', () => {
  state.bambuScope = bambuScopeSelect.value as BambuPaletteScope;
  const swatches = sceneManager.applyAppearance(state.colorOn, state.bambuMatch, state.bambuScope);
  renderSwatches(swatches);
});

btnBackdropToggle.addEventListener('click', () => {
  state.backdrop = state.backdrop === 'black' ? 'desk' : 'black';
  sceneManager.setBackdrop(state.backdrop);
  syncToolbar();
});

btnMatToggle.addEventListener('click', () => {
  state.deskMat = !state.deskMat;
  sceneManager.setDeskMatVisible(state.deskMat);
  syncToolbar();
});

btnResetView.addEventListener('click', () => {
  sceneManager.resetView();
});

btnErrorFallback.addEventListener('click', async () => {
  if (!mcpConnected || !lastFailedFileName) return;
  try {
    await app.sendMessage({
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Open ${lastFailedFileName} in the 3D Print Viewer side panel using open_3d_viewer.`,
        },
      ],
    });
  } catch {
    // Ignore
  }
});

btnExportMenu.addEventListener('click', (ev) => {
  ev.stopPropagation();
  const willOpen = exportDropdown.classList.contains('hidden');
  exportDropdown.classList.toggle('hidden', !willOpen);
  btnExportMenu.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
});

exportDropdown.querySelectorAll<HTMLButtonElement>('[data-export]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const fmt = btn.dataset.export as ExportFormatOption;
    void runExport(fmt);
  });
});

document.addEventListener('click', (ev) => {
  if (!exportMenuWrap.contains(ev.target as Node)) {
    closeExportDropdown();
  }
});

btnCloseToast.addEventListener('click', () => {
  exportToast.classList.add('hidden');
});

btnCopyExportPath.addEventListener('click', async () => {
  if (!lastExportedPath) return;
  try {
    await navigator.clipboard.writeText(lastExportedPath);
    btnCopyExportPath.textContent = 'Copied ✓';
  } catch {
    btnCopyExportPath.textContent = 'Select path above';
  }
});

btnPopSidePane.addEventListener('click', async () => {
  if (!mcpConnected || state.models.length === 0) return;
  const origLabel = btnPopSidePane.textContent;
  btnPopSidePane.disabled = true;
  btnPopSidePane.textContent = 'Opening…';

  let openedDirectly = false;
  try {
    // 1. Register full multi-model session state on our MCP server (no LLM turn)
    const promoRes = await app.callServerTool({
      name: 'promote_inline_session',
      arguments: {
        modelIds: state.models.map((m) => m.id),
        activeIndex: state.activeIndex,
        title: state.session?.title,
        background: state.backdrop,
        colorMode: state.colorOn ? 'color' : 'grey',
        bambuMatch: state.bambuMatch,
        deskMat: state.deskMat,
      },
    });

    const promo = promoRes.structuredContent as unknown as PromoteInlineResponse | undefined;
    if (!promoRes.isError && promo?.fileUri) {
      // 2. Ask Antigravity host directly to open our custom file viewer in the side panel (ZERO model turn!)
      const toggleRes = await app.request(
        {
          method: 'com.google.antigravity/toggle-aux-pane',
          params: { tabType: 'fileView', uri: promo.fileUri },
        } as unknown as Parameters<typeof app.request>[0],
        z.object({ isError: z.boolean().optional() }).passthrough(),
      );
      if (!toggleRes?.isError) {
        openedDirectly = true;
      }
    }
  } catch {
    // Host doesn't support toggle-aux-pane (-32601) or surface has no side pane; fall back below
  } finally {
    btnPopSidePane.disabled = false;
    btnPopSidePane.textContent = origLabel;
  }

  // Fallback only for hosts that don't support direct toggle-aux-pane
  if (!openedDirectly && app.getHostCapabilities()?.message) {
    try {
      await app.sendMessage({
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Open these current 3D models in the 3D Print Viewer side panel.',
          },
        ],
      });
    } catch {
      // Ignore if unavailable
    }
  }
});

// Keyboard shortcuts
window.addEventListener('keydown', (ev) => {
  if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement) return;
  const key = ev.key.toLowerCase();
  if (key >= '1' && key <= '5') {
    const idx = parseInt(key, 10) - 1;
    if (idx < state.models.length) void activateSlot(idx);
  } else if (key === 'c') {
    btnColorToggle.click();
  } else if (key === 'b') {
    btnBambuToggle.click();
  } else if (key === 'd') {
    btnBackdropToggle.click();
  } else if (key === 'm' && state.backdrop === 'desk') {
    btnMatToggle.click();
  } else if (key === 'r') {
    btnResetView.click();
  } else if (key === 'escape') {
    closeExportDropdown();
  }
});

// --- Local Drag-and-Drop / File Picker (great when opened empty in Side Panel) ---
const DEFAULT_LOCAL_COLORS = ['#38BDF8', '#00AE42', '#FF6A13', '#A855F7', '#F43F5E'];

async function ingestLocalFiles(files: FileList | File[]): Promise<void> {
  const arr = Array.from(files).slice(0, 5);
  const supported = new Set(['stl', '3mf', 'glb', 'gltf', 'obj', 'ply']);
  const metas: ModelSlotMeta[] = [];

  for (let i = 0; i < arr.length; i++) {
    const f = arr[i];
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    if (!supported.has(ext)) continue;
    const bytes = new Uint8Array(await f.arrayBuffer());
    const id = `local-${Date.now()}-${i}-${f.name}`;
    state.localFiles.set(id, bytes);
    metas.push({
      id,
      label: f.name.replace(/\.[^.]+$/, ''),
      fileName: f.name,
      format: ext as SupportedFormat,
      sizeBytes: bytes.byteLength,
      defaultColor: DEFAULT_LOCAL_COLORS[i % DEFAULT_LOCAL_COLORS.length],
      transport: 'raw',
    });
  }

  if (metas.length === 0) return;
  applySession({
    sessionId: `local-${Date.now()}`,
    layout: (document.body.dataset.layout as 'pane' | 'inline') || 'pane',
    title: 'Local 3D Models',
    activeIndex: 0,
    background: state.backdrop,
    colorMode: state.colorOn ? 'color' : 'grey',
    bambuMatch: state.bambuMatch,
    models: metas,
  });
}

localFileInput.addEventListener('change', () => {
  if (localFileInput.files && localFileInput.files.length > 0) {
    void ingestLocalFiles(localFileInput.files);
    localFileInput.value = '';
  }
});

stageWrap.addEventListener('dragover', (ev) => {
  ev.preventDefault();
  stageWrap.classList.add('drag-over');
});
stageWrap.addEventListener('dragleave', () => {
  stageWrap.classList.remove('drag-over');
});
stageWrap.addEventListener('drop', (ev) => {
  ev.preventDefault();
  stageWrap.classList.remove('drag-over');
  if (ev.dataTransfer?.files && ev.dataTransfer.files.length > 0) {
    void ingestLocalFiles(ev.dataTransfer.files);
  }
});

// --- MCP App SDK Lifecycle (register handlers BEFORE connect!) ---
app.ontoolinput = () => {
  showLoading('Preparing 3D Print Viewer…', 15);
};

app.ontoolresult = (result) => {
  if (!result.structuredContent) return;
  const payload = result.structuredContent as unknown as AnyViewerPayload;
  if (payload.kind === 'file_viewer' && payload.file?.resourceUri) {
    void openHostFileViewer(payload.file);
  } else {
    applySession(payload as ViewerSessionPayload);
  }
};

app.onhostcontextchanged = (ctx) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
};

async function boot() {
  if (window.__TEST_SESSION__) {
    applySession(window.__TEST_SESSION__);
    return;
  }
  try {
    await app.connect();
    mcpConnected = true;
    const ctx = app.getHostContext();
    if (ctx?.theme) applyDocumentTheme(ctx.theme);
    if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  } catch {
    // Standalone browser open without host
    showEmpty();
  }
}

void boot();
