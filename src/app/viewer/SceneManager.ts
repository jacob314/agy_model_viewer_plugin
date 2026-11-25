import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { BackdropMode } from '../../shared/types.js';
import type { BambuPaletteScope } from '../bambu/palette.js';
import { DeskEnvironment } from './deskEnvironment.js';
import { InteractionController, type DragState } from './InteractionController.js';
import type { LoadedModelBundle } from './loadModel.js';
import type { SwatchEntry } from './materials.js';

export interface SceneEvents {
  onDragState?: (state: DragState, hoveringModel: boolean) => void;
}

export class SceneManager {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly interaction: InteractionController;
  private readonly desk: DeskEnvironment;
  private readonly envRT: THREE.WebGLRenderTarget;

  private readonly keyLight: THREE.DirectionalLight;
  private readonly fillLight: THREE.DirectionalLight;
  private readonly rimLight: THREE.DirectionalLight;
  private readonly hemiLight: THREE.HemisphereLight;

  private activeBundle: LoadedModelBundle | null = null;
  private backdrop: BackdropMode = 'black';
  private deskMatVisible = false;
  private colorOn = true;
  private bambuMatch = false;
  private bambuScope: BambuPaletteScope = 'basic-matte';

  private rafId = 0;
  private resizeObserver: ResizeObserver;

  constructor(container: HTMLElement, events: SceneEvents = {}) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.96;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#000000');

    // Procedural studio reflections (subtle IBL so matte white self-shadows are never washed out)
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 0.26;
    pmrem.dispose();

    const w = Math.max(container.clientWidth, 1);
    const h = Math.max(container.clientHeight, 1);
    this.camera = new THREE.PerspectiveCamera(38, w / h, 0.05, 100);
    this.renderer.setSize(w, h, false);

    // Calibrated ~4.5:1 key-to-fill studio lighting so self-shadows stay crisp on pure white & vibrant colors
    this.hemiLight = new THREE.HemisphereLight('#F8FAFC', '#1E293B', 0.26);
    this.scene.add(this.hemiLight);

    this.keyLight = new THREE.DirectionalLight('#FFFBF2', 2.45);
    // Classic ~55° off-axis upper-left-front studio key light so raised relief & self-shadows fall cleanly into view
    this.keyLight.position.set(-2.8, 4.8, 3.0);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.camera.near = 1.0;
    this.keyLight.shadow.camera.far = 12.0;
    const d = 2.0;
    this.keyLight.shadow.camera.left = -d;
    this.keyLight.shadow.camera.right = d;
    this.keyLight.shadow.camera.top = d;
    this.keyLight.shadow.camera.bottom = -d;
    this.keyLight.shadow.bias = -0.00012;
    this.keyLight.shadow.normalBias = 0.014;
    this.keyLight.shadow.radius = 1.8;
    this.scene.add(this.keyLight);

    this.fillLight = new THREE.DirectionalLight('#DCEBFF', 0.28);
    this.fillLight.position.set(4.2, 2.2, 2.0);
    this.scene.add(this.fillLight);

    // Back rim light separates dark filaments (black / espresso) without washing out front-face shadows
    this.rimLight = new THREE.DirectionalLight('#E0F2FE', 0.78);
    this.rimLight.position.set(1.8, 3.4, -4.6);
    this.scene.add(this.rimLight);

    this.desk = new DeskEnvironment();
    this.scene.add(this.desk.group);

    this.interaction = new InteractionController(this.camera, this.renderer.domElement, {
      onStateChange: events.onDragState,
    });
    this.interaction.setDefaultView(new THREE.Vector3(2.55, 1.85, 3.0), new THREE.Vector3(0, 0.75, 0));

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);

    this.animate();
  }

  private handleResize(): void {
    const w = Math.max(this.container.clientWidth, 1);
    const h = Math.max(this.container.clientHeight, 1);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  private animate = (): void => {
    this.rafId = requestAnimationFrame(this.animate);
    this.interaction.update();
    this.renderer.render(this.scene, this.camera);
  };

  public setBackdrop(mode: BackdropMode): void {
    this.backdrop = mode;
    if (mode === 'desk') {
      this.desk.setVisible(true);
      this.desk.setMatVisible(this.deskMatVisible);
      this.scene.background = this.desk.backdropTexture;
      this.keyLight.color.set('#FFF6E8');
      this.keyLight.intensity = 2.55;
      this.hemiLight.intensity = 0.30;
      this.fillLight.intensity = 0.28;
      this.rimLight.intensity = 0.45;
      this.scene.environmentIntensity = 0.28;
      this.interaction.setDeskClearance(true);
    } else {
      this.desk.setVisible(false);
      this.scene.background = new THREE.Color('#000000');
      this.keyLight.color.set('#FFFFFF');
      this.keyLight.intensity = 2.45;
      this.hemiLight.intensity = 0.24;
      this.fillLight.intensity = 0.26;
      this.rimLight.intensity = 0.80;
      this.scene.environmentIntensity = 0.24;
      this.interaction.setDeskClearance(false);
    }
  }

  public setDeskMatVisible(visible: boolean): void {
    this.deskMatVisible = visible;
    this.desk.setMatVisible(visible);
  }

  public showModel(bundle: LoadedModelBundle): SwatchEntry[] {
    if (this.activeBundle) {
      this.scene.remove(this.activeBundle.pivotGroup);
    }
    this.activeBundle = bundle;
    this.scene.add(bundle.pivotGroup);

    // Frame camera smoothly around model's center
    const centerY = bundle.basePivotY;
    this.interaction.setModelPivot(bundle.pivotGroup, bundle.basePivotY);
    this.interaction.setDeskClearance(this.backdrop === 'desk');
    this.interaction.setDefaultView(
      new THREE.Vector3(2.45, centerY + 1.15, 2.85),
      new THREE.Vector3(0, centerY, 0),
    );
    bundle.pivotGroup.quaternion.identity();
    bundle.pivotGroup.position.y = bundle.basePivotY;

    return this.applyAppearance(this.colorOn, this.bambuMatch, this.bambuScope);
  }

  public applyAppearance(
    colorOn: boolean,
    bambuMatch: boolean,
    scope: BambuPaletteScope,
  ): SwatchEntry[] {
    this.colorOn = colorOn;
    this.bambuMatch = bambuMatch;
    this.bambuScope = scope;
    if (!this.activeBundle) return [];
    return this.activeBundle.appearance.applyAppearance(colorOn, bambuMatch, scope);
  }

  public toggleSwatchMuted(swatchKey: string): SwatchEntry[] {
    if (!this.activeBundle) return [];
    this.activeBundle.appearance.toggleSwatchMuted(swatchKey);
    return this.activeBundle.appearance.applyAppearance(this.colorOn, this.bambuMatch, this.bambuScope);
  }

  public resetView(): void {
    this.interaction.reset();
  }

  public dispose(): void {
    cancelAnimationFrame(this.rafId);
    this.resizeObserver.disconnect();
    this.interaction.dispose();
    this.desk.dispose();
    this.envRT.dispose();
    this.renderer.dispose();
  }
}
