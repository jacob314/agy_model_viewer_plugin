# Antigravity 3D Print Model Viewer Plugin

An interactive [Antigravity](https://antigravity.google) plugin (`model3d-viewer`) that bundles a local **MCP App**, an **always-on default viewer rule**, and the **`view-3d-models` skill** for inspecting, comparing, and exporting `.stl` and Bambu Studio's canonical multi-color 3D printing formats (`.3mf`, `.obj` + `.mtl`, `.glb` / `.gltf`, and `.ply`).

---

## Features

- **Side Panel + Compact Inline Chat Previews + Custom File Viewer**:
  - **Side Panel (`open_3d_viewer`)**: Full-height auxiliary side pane (`3D Print Viewer`) for detailed inspection and multi-model comparisons (also launchable directly from the side pane `+` menu, restoring your last session or accepting drag-and-dropped local 3D files).
  - **Compact Inline Preview (`preview_3d_models_inline`)**: Lightweight interactive 3D card rendered directly inside chat with a zero-turn **Side Panel ↗** button that pops your active models and toggles straight into the side panel.
  - **Custom File Viewer (`view_3d_file`)**: Automatically claims `.3mf`, `.stl`, `.glb`, `.gltf`, `.obj`, and `.ply` files so clicking any 3D file link in Antigravity opens it in the 3D Print Viewer.
- **Toggle Up to 5 Models**: Switch instantaneously between up to 5 files (with in-memory client caching and keyboard shortcuts `1`–`5`).
- **Native Bambu Studio Multi-Color `.3mf` & Large `.stl` Engine**:
  - Fast server-side parser supporting Bambu Studio / OrcaSlicer `paint_color` MMU bitstreams, `<basematerials>`, `<m:colorgroup>`, `Metadata/project_settings.config`, `Metadata/model_settings.config`, and multi-file `3D/Objects/*.model` assemblies.
  - Supports binary & ASCII `.stl` (including Magics/VisCAM 15-bit per-triangle RGB) with automatic spatial-clustering decimation for massive 100+ MB build plates so interaction stays smooth at 60 FPS while preserving true millimeter dimensions.
  - **Large & Draco `.glb` Server Optimizer**: Automatically decodes `KHR_draco_mesh_compression` server-side (bundled JS decoder, zero browser WASM/CSP issues), applies UV-seam-preserving spatial decimation for multi-million-triangle meshes, downscales oversized 4K textures to crisp 1024px, and streams in 512 KiB chunks safely below MCP payload caps.
- **Calibrated Studio Lighting & Self-Shadows**:
  - ~4.5:1 off-axis key-to-fill lighting rig with tight 2048×2048 shadow maps (`PCFSoftShadowMap`, `normalBias`) and per-group creased CAD normals so relief lettering and bevels cast crisp self-shadows on both matte white and vibrant filament colors.
- **Color / Grey Inspection Toggle (`C`)**: Switch between full colors and uniform neutral inspection grey (`#9CA3AF`), or click individual bottom swatch chips to mute/unmute specific color channels.
- **Bambu Lab Filament Color Matching (`B`)**: Perceptual CIELAB **CIEDE2000** matching against **68 official Bambu Lab filaments** (`PLA Basic`, `PLA Matte`, and `PLA Silk+`) with finish-accurate PBR roughness/metalness and fast 32³ RGB LUT remapping for full-color textured `.glb`/`.obj` and vertex-colored `.ply` models.
- **High-Contrast Black vs. Natural Oak Desk Backdrop (`D`) & Desk Mat (`M`)**: Toggle between pure `#000000` black for maximum contrast and a non-repeating natural quarter-sawn oak tabletop with soft grounded shadows and an optional toggleable grey maker mat.
- **Intuitive Dual Mouse Controls**:
  - **Click & drag on the 3D model**: Spins the object upright around its vertical turntable axis without tilting or flipping upside down.
  - **Click & drag on the background** (or `Alt`+drag anywhere): Orbits the camera (clamped above the tabletop in Desk mode so you never dip beneath the table).
  - **Scroll / pinch**: Zoom · **Right-drag / Shift+drag**: Pan · **`R` or double-click background**: Reset view.
- **Direct 3D Print Export (`Export ▾`)**:
  - **Bambu Multi-Color (`.3mf`)** *(Recommended)*: Exports an AMS-ready Bambu Studio `.3mf` with `<basematerials>`, `paint_color`, `project_settings.config`, and `model_settings.config`, grounded flush at `Z = 0` in millimeters.
  - **Bambu Spool-Matched (`.3mf`)**: Snaps all colors (or quantizes textured/vertex-colored models into up to 8 AMS channels) to the closest official Bambu Lab PLA filaments.
  - **Single-Color Mesh (`.stl`)**: Exports a standard binary `.stl` in millimeters grounded on the build plate.
  - Saves cleanly next to the source model (or into `~/Downloads` for locally dropped files) without overwriting existing files.

---

## Installation

Pre-built bundles (`dist/index.html` and `dist/server.mjs`) are checked into this repository so the plugin works immediately with **Node.js 20+** and no build step required.

Clone directly into your Antigravity global plugins directory:

```bash
git clone https://github.com/jacob314/agy_model_viewer_plugin.git ~/.gemini/config/plugins/model3d-viewer
```

Antigravity automatically discovers any plugin with a `plugin.json` under `~/.gemini/config/plugins/`. Once cloned:
- The **`model3d-viewer`** plugin, **`view-3d-models`** skill, **always-on default viewer rule** (`rules/AGENTS.md`), and **`model3d_viewer`** MCP server activate automatically.
- You can manage or toggle the plugin anytime from **Customizations → Plugins → 3D Print Model Viewer**.

---

## Usage

Just ask Antigravity in any chat to inspect, preview, or compare your 3D models:

- *"Open my latest Bambu 3MF and STL models in the 3D Print Viewer side panel"*
- *"Compare these 4 STL iterations side-by-side and match colors to Bambu Lab PLA filaments"*
- *"Show a compact inline 3D preview of `part.3mf` on the desk"*

Or click any `.3mf`, `.stl`, `.glb`, `.gltf`, `.obj`, or `.ply` file in Antigravity to open it directly in the **3D Print Viewer** side panel.

### Keyboard Shortcuts & Mouse Controls

| Input | Action |
| :--- | :--- |
| **`1` – `5`** | Switch between loaded model slots |
| **`C`** | Toggle **Color** ON vs. neutral inspection **Grey** |
| **`B`** | Toggle **Bambu Lab Filament Color Matching** |
| **`D`** | Toggle **Black BG** vs. **Natural Oak Desk BG** |
| **`M`** | Toggle optional **Grey Desk Mat** (when in Desk BG) |
| **`R`** / Double-click background | Reset camera angle and model rotation |
| **Left-drag on model** | Spin model upright around vertical axis |
| **Left-drag on background** (or `Alt`+drag) | Orbit camera (clamped above desk in Desk mode) |
| **Scroll / pinch** | Zoom camera |
| **Right-drag / `Shift`+drag** | Pan camera |

---

## MCP Tools

| Tool | Visibility | Surface | Purpose |
| :--- | :--- | :--- | :--- |
| `open_3d_viewer` | Model & App | Side Panel (`aux_pane`) | Primary viewer for 1–5 3D models; restores last session on `{}` |
| `preview_3d_models_inline` | Model & App | Inline Chat | Compact interactive 3D preview card with zero-turn **Side Panel ↗** promotion |
| `view_3d_file` | Host / App | File Viewer (`file`) | Native custom viewer for `.3mf`, `.stl`, `.glb`, `.gltf`, `.obj`, `.ply` |
| `load_model_chunk` | App-only | Internal | Streams compiled binary `M3DV` buffers or raw assets/textures in chunks |
| `promote_inline_session` | App-only | Internal | Snapshots inline state for instant `toggle-aux-pane` handoff |
| `export_3d_model` | App-only | Internal | Full-resolution server-side Bambu `.3mf` and binary `.stl` export |
| `save_exported_file_chunk` | App-only | Internal | Chunked saver for client-side `.glb`/`.obj`/`.ply` exports |

---

## Development

To modify the TypeScript server or Three.js MCP App UI and rebuild the single-file bundle:

```bash
cd ~/.gemini/config/plugins/model3d-viewer
npm install
npm run typecheck
npm run build
```

- `npm run build:app` bundles `src/app/` into a CSP-safe single-file HTML document at `dist/index.html` using Vite + `vite-plugin-singlefile`.
- `npm run build:server` bundles `src/server/index.ts` into `dist/server.mjs` using `esbuild`.
- After editing server code, restart the MCP server from **Customizations → Installed → 3D Print Model Viewer → MCP → Restart**.

---

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
