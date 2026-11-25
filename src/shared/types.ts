export type BackdropMode = 'black' | 'desk';
export type ColorMode = 'color' | 'grey';
export type ViewerLayout = 'pane' | 'inline';
export type SupportedFormat = '3mf' | 'stl' | 'glb' | 'gltf' | 'obj' | 'ply' | 'blend';

export interface ModelSlotMeta {
  id: string;
  label: string;
  fileName: string;
  format: SupportedFormat;
  sizeBytes: number;
  defaultColor?: string;
  /** 'm3dv' for server-compiled binary geometry (.3mf, .stl), 'raw' for client-parsed (.glb/.gltf/.obj/.ply) */
  transport: 'm3dv' | 'raw';
}

export interface ViewerSessionPayload {
  kind?: 'session';
  sessionId: string;
  layout: ViewerLayout;
  title: string;
  activeIndex: number;
  background: BackdropMode;
  colorMode: ColorMode;
  bambuMatch: boolean;
  deskMat?: boolean;
  models: ModelSlotMeta[];
}

export interface FileViewerPayload {
  kind: 'file_viewer';
  layout: 'pane';
  file: {
    name: string;
    resourceUri: string;
  };
}

export type AnyViewerPayload = ViewerSessionPayload | FileViewerPayload;

export interface M3dvGroupMeta {
  name: string;
  color: string; // #RRGGBB
  filamentName?: string;
  vertexOffset: number; // in floats (always multiple of 3)
  vertexCount: number;
  indexOffset: number; // in uint32 elements
  indexCount: number;
  isMonochromeDefault?: boolean;
}

export interface M3dvHeader {
  version: 1;
  format: '3mf' | 'stl';
  upAxis: 'z' | 'y';
  /** Original real-world dimensions in millimeters [widthX, depthY, heightZ] */
  dimensionsMm: [number, number, number];
  /** Bounding box min [x, y, z] in model space */
  bboxMin: [number, number, number];
  /** Bounding box max [x, y, z] in model space */
  bboxMax: [number, number, number];
  originalTriangleCount: number;
  displayedTriangleCount: number;
  decimated: boolean;
  hasExplicitColors: boolean;
  totalVertexFloats: number;
  totalIndices: number;
  groups: M3dvGroupMeta[];
}

export interface LoadChunkResponse {
  modelId: string;
  assetName: string;
  transport: 'm3dv' | 'raw';
  totalBytes: number;
  chunkIndex: number;
  totalChunks: number;
  mimeType: string;
  dataBase64: string;
}

export interface PromoteInlineResponse {
  fileUri: string;
  fileName: string;
}

export type ExportFormatOption = 'bambu-3mf' | 'bambu-3mf-matched' | 'stl';

export interface ExportResultResponse {
  savedPath: string;
  fileName: string;
  sizeBytes: number;
  exportFormat: ExportFormatOption;
  triangleCount: number;
  filamentCount?: number;
  filaments?: Array<{ slot: number; name: string; hex: string }>;
}
