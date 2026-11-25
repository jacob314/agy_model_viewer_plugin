import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type DragState = 'idle' | 'orbit' | 'rotate-object';

export interface InteractionCallbacks {
  onStateChange?: (state: DragState, hoveringModel: boolean) => void;
}

/**
 * Dual-mode mouse controller:
 * - Click & drag ON the 3D model -> rotates the object itself around its visual center (camera-relative arcball)
 * - Click & drag on background (or Alt+drag anywhere) -> orbits the camera around the model
 * - Scroll -> zoom; Right-drag / Shift+drag -> pan; Double-click background -> reset view & object
 */
export class InteractionController {
  public readonly controls: OrbitControls;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly domElement: HTMLElement;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  private readonly callbacks: InteractionCallbacks;

  private modelPivot: THREE.Object3D | null = null;
  private deskClearanceEnabled = false;
  private basePivotY = 0;

  private dragState: DragState = 'idle';
  private hoveringModel = false;
  private activePointerId: number | null = null;
  private lastX = 0;

  private defaultCamPos = new THREE.Vector3(2.8, 2.0, 3.2);
  private defaultTarget = new THREE.Vector3(0, 0.7, 0);

  constructor(
    camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
    callbacks: InteractionCallbacks = {},
  ) {
    this.camera = camera;
    this.domElement = domElement;
    this.callbacks = callbacks;

    this.controls = new OrbitControls(camera, domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.85;
    this.controls.zoomSpeed = 1.05;
    this.controls.panSpeed = 0.8;
    this.controls.minDistance = 0.6;
    this.controls.maxDistance = 18;
    this.controls.minPolarAngle = 0.06;
    this.controls.maxPolarAngle = Math.PI - 0.06;

    // Bind in capture phase so we intercept model clicks BEFORE OrbitControls starts orbiting!
    this.domElement.addEventListener('pointerdown', this.onPointerDown, { capture: true });
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    this.domElement.addEventListener('dblclick', this.onDoubleClick);
  }

  public setModelPivot(pivot: THREE.Object3D | null, baseY = 0): void {
    this.modelPivot = pivot;
    this.basePivotY = baseY;
  }

  public setDeskClearance(enabled: boolean): void {
    this.deskClearanceEnabled = enabled;
    // Prevent camera from orbiting underneath the desk surface
    this.controls.maxPolarAngle = enabled ? Math.PI / 2 - 0.05 : Math.PI - 0.06;
    if (enabled) {
      if (this.controls.target.y < 0.05) {
        this.controls.target.y = 0.05;
      }
      if (this.camera.position.y < 0.16) {
        this.camera.position.y = Math.max(0.45, this.defaultCamPos.y * 0.5);
      }
      this.controls.update();
    }
  }

  public setDefaultView(camPos: THREE.Vector3, target: THREE.Vector3): void {
    this.defaultCamPos.copy(camPos);
    this.defaultTarget.copy(target);
    this.camera.position.copy(camPos);
    this.controls.target.copy(target);
    this.controls.update();
  }

  public reset(): void {
    if (this.modelPivot) {
      this.modelPivot.rotation.set(0, 0, 0);
      this.modelPivot.position.y = this.basePivotY;
    }
    this.camera.position.copy(this.defaultCamPos);
    this.controls.target.copy(this.defaultTarget);
    this.controls.update();
  }

  public update(): void {
    this.controls.update();
    if (this.deskClearanceEnabled) {
      let clamped = false;
      if (this.controls.target.y < 0.05) {
        this.controls.target.y = 0.05;
        clamped = true;
      }
      if (this.camera.position.y < 0.14) {
        this.camera.position.y = 0.14;
        clamped = true;
      }
      if (clamped) {
        this.camera.lookAt(this.controls.target);
      }
    }
  }

  private hitTestModel(clientX: number, clientY: number): boolean {
    if (!this.modelPivot || !this.modelPivot.visible) return false;
    const rect = this.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    this.pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const hits = this.raycaster.intersectObject(this.modelPivot, true);
    return hits.length > 0;
  }

  private updateCursor(): void {
    if (this.dragState === 'rotate-object') {
      this.domElement.style.cursor = 'grabbing';
    } else if (this.dragState === 'orbit') {
      this.domElement.style.cursor = 'move';
    } else if (this.hoveringModel) {
      this.domElement.style.cursor = 'grab';
    } else {
      this.domElement.style.cursor = 'default';
    }
    this.callbacks.onStateChange?.(this.dragState, this.hoveringModel);
  }

  private onPointerDown = (ev: PointerEvent): void => {
    // Only intercept primary left-click without Alt/Shift/Ctrl/Meta
    if (ev.button !== 0 || ev.altKey || ev.shiftKey || ev.ctrlKey || ev.metaKey) {
      this.dragState = 'orbit';
      this.updateCursor();
      return;
    }

    if (this.hitTestModel(ev.clientX, ev.clientY)) {
      // Stop OrbitControls from receiving this pointerdown so we spin the object directly!
      ev.stopImmediatePropagation();
      ev.preventDefault();
      this.controls.enabled = false;
      this.dragState = 'rotate-object';
      this.activePointerId = ev.pointerId;
      this.lastX = ev.clientX;
      try {
        this.domElement.setPointerCapture(ev.pointerId);
      } catch {
        // Ignore if capture unsupported
      }
      this.updateCursor();
    } else {
      this.dragState = 'orbit';
      this.updateCursor();
    }
  };

  private onPointerMove = (ev: PointerEvent): void => {
    if (this.dragState === 'rotate-object' && this.modelPivot) {
      const dx = ev.clientX - this.lastX;
      this.lastX = ev.clientX;

      // Pure upright turntable spin around world vertical Y-axis (never tilts or flips upside down)
      const sensitivity = 0.0095;
      this.modelPivot.rotation.y += dx * sensitivity;
      return;
    }

    if (this.dragState === 'idle') {
      const over = this.hitTestModel(ev.clientX, ev.clientY);
      if (over !== this.hoveringModel) {
        this.hoveringModel = over;
        this.updateCursor();
      }
    }
  };

  private onPointerUp = (ev: PointerEvent): void => {
    if (this.dragState === 'rotate-object') {
      if (this.activePointerId !== null) {
        try {
          this.domElement.releasePointerCapture(this.activePointerId);
        } catch {
          // Ignore
        }
      }
      this.activePointerId = null;
      this.controls.enabled = true;
    }
    if (this.dragState !== 'idle') {
      this.dragState = 'idle';
      this.hoveringModel = this.hitTestModel(ev.clientX, ev.clientY);
      this.updateCursor();
    }
  };

  private onDoubleClick = (ev: MouseEvent): void => {
    if (!this.hitTestModel(ev.clientX, ev.clientY)) {
      this.reset();
    }
  };

  public dispose(): void {
    this.domElement.removeEventListener('pointerdown', this.onPointerDown, { capture: true });
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    this.domElement.removeEventListener('dblclick', this.onDoubleClick);
    this.controls.dispose();
  }
}
