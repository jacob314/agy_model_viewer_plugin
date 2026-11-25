---
name: view-3d-models
description: >-
  Default workflow for viewing and comparing STL and canonical Bambu Studio
  multi-color 3D printing models (3MF, OBJ+MTL, GLB/GLTF, PLY) inside Jetski
  using the model3d-viewer plugin's side panel (primary) and compact inline
  chat previews. Use whenever the user asks to view, inspect, preview, compare,
  or check a 3D print model, or right after generating/exporting 3D print files.
---

# Viewing 3D Print Models in Jetski

Use the **`model3d-viewer`** MCP server tools (`model3d-viewer_model3d_viewer`) as the default way to render `.stl` and Bambu Studio's canonical multi-color 3D printing formats directly inside Jetski.

## Choosing Side Panel vs. Inline View

| Tool | Surface | When to Use |
| :--- | :--- | :--- |
| **`open_3d_viewer`** | **Side Panel (`aux_pane`)** — *Primary default* | Full-height interactive inspection, comparing up to 5 iterations/parts, inspecting Bambu 3MF multi-color prints, and whenever the user asks to view or open 3D files. Calling it again updates the open side panel directly. |
| **`preview_3d_models_inline`** | **Compact Inline Chat Card** | Small inline preview right inside the chat message (~340px tall). Use when the user asks for a quick inline preview, or to show a small visual preview in chat alongside/before opening the side panel. |

Both tools share the exact same interactive 3D engine and full controls:
- **Up to 5 toggleable models** (`1`–`5` tabs + keyboard shortcuts `1`–`5`).
- **Calibrated studio 3D lighting** with crisp self-shadows across white, dark, and vivid filament colors, plus creased CAD normals.
- **Multi-color toggle (`C`)**: Switch between full colors and neutral inspection **grey**.
- **Backdrop toggle (`D`) & Desk Mat (`M`)**: Pure **black** (`#000000`) for maximum contrast (default) or a **non-repeating natural oak desk** with grounded shadows and an optional toggleable grey desk mat (`Mat: Off` by default).
- **Dual mouse controls**: Drag the **background** to orbit the camera (clamped above the tabletop in Desk mode); click and drag **on the 3D model** to spin the object upright around its vertical axis; scroll to zoom; right-drag to pan.
- **Bambu Lab Filament Match toggle (`B`)**: Perceptually matches model colors (CIEDE2000) to 68 official **Bambu Lab PLA Basic, PLA Matte, and PLA Silk+** filament colors and displays matched spool names/codes.
- **Direct Export menu (`Export ▾`)** *(available in both inline and side panel views)*: Export the active model directly to a Bambu Studio AMS-ready **Multi-Color `.3mf`**, a **Bambu Spool-Matched `.3mf`** (auto-snapped to closest official Bambu Lab PLA filaments with `project_settings.config`), or a **Single-Color Binary `.stl`** (grounded at `Z = 0` in millimeters), saved cleanly next to the source file (or `~/Downloads`).

## Canonical Supported Formats

1. **`.3mf`** *(Bambu Studio canonical multi-color format)*:
   - Supports `<basematerials>`, `<m:colorgroup>`, per-triangle `pid`/`p1`/`p2`/`p3`, Bambu Studio / PrusaSlicer `paint_color` MMU painting, `Metadata/project_settings.config` filament palettes, `Metadata/model_settings.config` per-part extruder assignments, and multi-file `3D/Objects/*.model` assemblies.
   - Parsed server-side into compact binary geometry so even 30+ MB uncompressed 3MF XML files load smoothly.
2. **`.stl`** *(Binary & ASCII)*:
   - Supports standard monochrome STLs as well as VisCAM/Magics 15-bit per-triangle RGB STLs.
   - Large binary STLs (>25 MB, e.g. 50–135 MB multi-part plates) are automatically vertex-clustered/indexed server-side for smooth 60 FPS interaction while preserving true millimeter dimensions.
3. **`.obj`** *(+ sibling `.mtl` & textures)*:
   - Automatically streams referenced `.mtl` material libraries and texture maps from the same directory.
4. **`.glb` / `.gltf`**:
   - Full PBR materials, embedded/external textures, and vertex colors (Bambu color matching remaps textures in real time too).
5. **`.ply`**:
   - Supports per-vertex and per-face colors.

## Calling the Tools

Pass 1 to 5 files in `models` using **absolute file paths**:

```json
{
  "title": "Bambu 5-Color Model Comparison",
  "models": [
    {
      "path": "/path/to/models/figurine_proof_5color.3mf",
      "label": "Proof Print (5-Color)"
    },
    {
      "path": "/path/to/models/figurine_final_5color.3mf",
      "label": "Final Print (5-Color)"
    },
    {
      "path": "/path/to/models/bracket_v3.stl",
      "label": "Bracket v3",
      "color": "#00AE42"
    }
  ],
  "activeIndex": 0,
  "background": "black",
  "colorMode": "color",
  "bambuMatch": false
}
```

### Arguments Reference
- `models` *(array, 1–5 items, optional on `open_3d_viewer`)*:
  - `path` *(string, required)*: Absolute path to the `.3mf`, `.stl`, `.obj`, `.glb`, `.gltf`, or `.ply` file.
  - `label` *(string, optional)*: Short tab label (keep under ~24 chars for clean tabs).
  - `color` *(string, optional)*: Default `#RRGGBB` filament color for monochrome STLs when Colors are ON.
- `activeIndex` *(integer 0–4, optional)*: Which slot is active initially (default `0`).
- `title` *(string, optional)*: Compact title shown in the viewer header.
- `background` *(`"black"` | `"desk"`, optional)*: Initial backdrop (default `"black"`).
- `colorMode` *(`"color"` | `"grey"`, optional)*: Initial color state (default `"color"`).
- `bambuMatch` *(boolean, optional)*: Start with Bambu Lab filament color matching enabled (default `false`).

## Best Practices

- **Default to `open_3d_viewer`** (side panel) for main inspection, and use `preview_3d_models_inline` when the user wants a small inline view in chat (or when showing a compact preview card right next to your explanation).
- **Prefer `.3mf` over `.stl`** when both exist for a multi-color Bambu Lab model so all filament colors and painted regions display faithfully.
- **Give monochrome STLs distinct optional `color` hints** when comparing multiple parts (e.g., frame vs. seat vs. bar) so they are visually distinct in Color mode and snap cleanly to neutral grey when Color is toggled OFF.
- **More than 5 files**: Group into the most relevant 5 files (e.g., latest iterations or key sub-assemblies) and mention any omitted files so the user can swap them in.
- **CAD source files (`.blend`, `.step`, `.stp`, `.f3d`)**: Convert/export to `.3mf` (multi-color) or `.stl`/`.glb` first before passing to `open_3d_viewer`.
- **No ad-hoc HTML viewers**: Do not write standalone Three.js HTML files or launch external macOS apps with `open` unless the user explicitly requests an external file or desktop app.
