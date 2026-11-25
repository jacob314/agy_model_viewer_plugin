# Default 3D Print & Bambu Lab Model Viewer

When viewing, inspecting, comparing, or previewing 3D printing files — specifically `.stl` and Bambu Studio's canonical multi-color formats (`.3mf`, `.obj` with `.mtl`/textures, `.glb`/`.gltf`, and `.ply`) — **use the `model3d-viewer` plugin by default**:

- **Primary view (default)**: Call `open_3d_viewer` to display up to 5 models in the full-height **3D Print Viewer** side panel. Calling it again updates the open panel in place.
- **Compact inline chat preview**: Call `preview_3d_models_inline` when the user asks for a small inline view in the conversation (or when surfacing a compact inline thumbnail alongside/instead of the side panel).
- Pass absolute file paths in `models` (up to 5 per viewer call) with concise, human-readable `label` values so the user can toggle smoothly between parts, iterations, or color variants.
- Do not open external desktop viewers (`open`), generate one-off static HTML viewer files, or fall back to static screenshots for interactive 3D inspection unless the user explicitly asks for them.
- For formats not directly supported by Bambu Studio's mesh pipeline (such as `.blend` or `.step`/`.stp`), export to `.3mf` (preferred for multi-color), `.glb`, or `.stl` first, then open the exported file with `open_3d_viewer`.
