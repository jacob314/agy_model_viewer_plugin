import * as THREE from 'three';
import oakTextureUrl from '../assets/natural_oak_desk.jpg';

function createOakTexture(): { map: THREE.Texture; bumpMap: THREE.CanvasTexture } {
  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = 512;
  bumpCanvas.height = 512;
  const bCtx = bumpCanvas.getContext('2d')!;
  bCtx.fillStyle = '#808080';
  bCtx.fillRect(0, 0, 512, 512);

  const bumpMap = new THREE.CanvasTexture(bumpCanvas);
  bumpMap.wrapS = THREE.ClampToEdgeWrapping;
  bumpMap.wrapT = THREE.ClampToEdgeWrapping;
  bumpMap.repeat.set(1, 1);

  const loader = new THREE.TextureLoader();
  const map = loader.load(oakTextureUrl, (tex) => {
    const img = tex.image as HTMLImageElement | undefined;
    if (img && img.width && img.height) {
      // Derive a gentle, non-repeating grain bump map directly from the natural oak photo
      bCtx.drawImage(img, 0, 0, 512, 512);
      const data = bCtx.getImageData(0, 0, 512, 512);
      const d = data.data;
      for (let i = 0; i < d.length; i += 4) {
        const lum = Math.round(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
        d[i] = lum;
        d[i + 1] = lum;
        d[i + 2] = lum;
      }
      bCtx.putImageData(data, 0, 0);
      bumpMap.needsUpdate = true;
    }
  });

  // Strictly non-repeating 1:1 mapping across the full desktop
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.ClampToEdgeWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;
  map.repeat.set(1, 1);
  map.anisotropy = 8;

  return { map, bumpMap };
}

function createDeskBackdropTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext('2d')!;

  // Quiet warm neutral studio backdrop that complements natural oak without distracting from the model
  const grad = ctx.createRadialGradient(256, 165, 20, 256, 260, 390);
  grad.addColorStop(0, '#36322E');
  grad.addColorStop(0.55, '#22201E');
  grad.addColorStop(1, '#121214');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 512, 512);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class DeskEnvironment {
  public readonly group = new THREE.Group();
  public readonly backdropTexture: THREE.CanvasTexture;
  private readonly matGroup = new THREE.Group();
  private readonly shadowPlane: THREE.Mesh;

  constructor() {
    this.group.name = 'SimulatedDeskEnvironment';
    const { map, bumpMap } = createOakTexture();
    this.backdropTexture = createDeskBackdropTexture();

    // Non-repeating natural oak tabletop with a subtle satin-gloss finish, top face cleanly at y = -0.002
    const topGeo = new THREE.BoxGeometry(11.5, 0.24, 9.5);
    const topMat = new THREE.MeshPhysicalMaterial({
      map,
      bumpMap,
      bumpScale: 0.004,
      roughness: 0.42,
      metalness: 0.02,
      clearcoat: 0.58,
      clearcoatRoughness: 0.2,
      reflectivity: 0.7,
      envMapIntensity: 0.95,
    });
    const tabletop = new THREE.Mesh(topGeo, topMat);
    tabletop.position.set(0, -0.122, 0);
    tabletop.receiveShadow = true;
    this.group.add(tabletop);

    // Optional dark grey maker desk mat + grid (toggleable ON/OFF)
    this.matGroup.name = 'DeskMatGroup';
    const matGeo = new THREE.BoxGeometry(4.2, 0.005, 3.2);
    const matMat = new THREE.MeshStandardMaterial({
      color: '#1F2937',
      roughness: 0.88,
      metalness: 0.02,
    });
    const deskMat = new THREE.Mesh(matGeo, matMat);
    deskMat.position.set(0, -0.003, 0);
    deskMat.receiveShadow = true;
    this.matGroup.add(deskMat);

    const grid = new THREE.GridHelper(3.0, 12, 0x475569, 0x334155);
    grid.position.set(0, -0.0002, 0);
    const gridMats = Array.isArray(grid.material) ? grid.material : [grid.material];
    for (const gm of gridMats) {
      gm.transparent = true;
      gm.opacity = 0.28;
    }
    this.matGroup.add(grid);
    this.matGroup.visible = false; // Default: show model directly on natural oak desk
    this.group.add(this.matGroup);

    // Soft contact shadow catcher directly above tabletop
    const shadowGeo = new THREE.PlaneGeometry(10, 10);
    shadowGeo.rotateX(-Math.PI / 2);
    const shadowMat = new THREE.ShadowMaterial({ opacity: 0.32 });
    this.shadowPlane = new THREE.Mesh(shadowGeo, shadowMat);
    this.shadowPlane.position.y = 0.0005;
    this.shadowPlane.receiveShadow = true;
    this.group.add(this.shadowPlane);

    this.group.visible = false;
  }

  public setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  public setMatVisible(visible: boolean): void {
    this.matGroup.visible = visible;
    this.shadowPlane.position.y = visible ? 0.0008 : 0.0005;
  }

  public dispose(): void {
    this.backdropTexture.dispose();
    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) m.dispose();
      }
    });
  }
}
