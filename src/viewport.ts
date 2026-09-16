import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { NodeId } from './core/types.js';
import type { FaceInfo } from './geometry/kernel.js';
import type { MeshKind, MeshPayload } from './worker/protocol.js';

export interface FaceHit {
  nodeId: NodeId;
  faceIndex: number | null;
}

export class Viewport {
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly meshes = new Map<NodeId, THREE.Mesh>();
  private readonly kinds = new Map<NodeId, MeshKind>();
  private readonly faces = new Map<NodeId, FaceInfo[]>();
  private readonly faceIds = new Map<NodeId, Uint32Array>();

  private readonly material = new THREE.MeshStandardMaterial({
    color: 0xe8944a,
    metalness: 0.0,
    roughness: 0.45,
  });
  private readonly sketchMaterial = new THREE.MeshStandardMaterial({
    color: 0x6ad3a8,
    metalness: 0.0,
    roughness: 0.6,
    transparent: true,
    opacity: 0.42,
    side: THREE.DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  private readonly highlightMaterial = new THREE.MeshStandardMaterial({
    color: 0xffc98a,
    metalness: 0.0,
    roughness: 0.35,
    emissive: 0x4a2c0c,
  });
  private readonly sketchHighlightMaterial = new THREE.MeshStandardMaterial({
    color: 0x9cf5cd,
    metalness: 0.0,
    roughness: 0.5,
    emissive: 0x1d5540,
    transparent: true,
    opacity: 0.65,
    side: THREE.DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  private readonly faceMaterial = new THREE.MeshStandardMaterial({
    color: 0x5fb0ff,
    metalness: 0.0,
    roughness: 0.4,
    emissive: 0x12355c,
  });

  private readonly raycaster = new THREE.Raycaster();
  private pickListener: ((hit: FaceHit | null) => void) | null = null;
  private highlighted: NodeId | null = null;
  private highlightedFace: FaceHit | null = null;
  private framed = false;

  constructor(private readonly container: HTMLElement) {
    this.scene.background = new THREE.Color(0x14171c);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.5, 20000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(120, -150, 110);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.domElement.style.display = 'block';
    container.append(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    this.scene.add(new THREE.HemisphereLight(0xdfe7f5, 0x1a1e25, 1.2));

    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(80, -120, 160);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0x9fc0ff, 0.6);
    fill.position.set(-120, 90, 40);
    this.scene.add(fill);

    const grid = new THREE.GridHelper(400, 40, 0x3c4553, 0x262c36);
    grid.rotation.x = Math.PI / 2;
    this.scene.add(grid);

    this.installPicking();

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();

    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  /** Distinguishes a click from an orbit drag so picking does not fight the camera. */
  private installPicking(): void {
    const canvas = this.renderer.domElement;
    let downX = 0;
    let downY = 0;

    canvas.addEventListener('pointerdown', (event) => {
      downX = event.clientX;
      downY = event.clientY;
    });

    canvas.addEventListener('pointerup', (event) => {
      if (Math.hypot(event.clientX - downX, event.clientY - downY) > 4) return;

      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );

      this.raycaster.setFromCamera(ndc, this.camera);
      const hits = this.raycaster.intersectObjects([...this.meshes.values()], false);
      const hit = hits[0];
      if (hit === undefined) {
        this.pickListener?.(null);
        return;
      }

      const nodeId = hit.object.userData.nodeId;
      if (typeof nodeId !== 'string') {
        this.pickListener?.(null);
        return;
      }

      // Three's faceIndex is the triangle index; map it back to the B-rep face.
      const ids = this.faceIds.get(nodeId);
      const triangle = hit.faceIndex;
      const faceIndex =
        triangle !== undefined && triangle !== null && ids !== undefined && triangle < ids.length
          ? (ids[triangle] ?? null)
          : null;

      this.pickListener?.({ nodeId, faceIndex });
    });
  }

  onPick(listener: (hit: FaceHit | null) => void): void {
    this.pickListener = listener;
  }

  private baseMaterial(nodeId: NodeId): THREE.Material {
    const isSketch = this.kinds.get(nodeId) === 'sketch';
    if (nodeId === this.highlighted) {
      return isSketch ? this.sketchHighlightMaterial : this.highlightMaterial;
    }
    return isSketch ? this.sketchMaterial : this.material;
  }

  /** One render group per B-rep face, so a single face can carry its own material. */
  private applyMaterials(nodeId: NodeId): void {
    const mesh = this.meshes.get(nodeId);
    if (mesh === undefined) return;

    const faces = this.faces.get(nodeId) ?? [];
    const base = this.baseMaterial(nodeId);

    if (faces.length === 0) {
      mesh.geometry.clearGroups();
      mesh.material = base;
      return;
    }

    const hot: number =
      this.highlightedFace !== null && this.highlightedFace.nodeId === nodeId
        ? (this.highlightedFace.faceIndex ?? -1)
        : -1;

    mesh.geometry.clearGroups();
    for (let index = 0; index < faces.length; index++) {
      const face = faces[index]!;
      mesh.geometry.addGroup(
        face.triangleStart * 3,
        face.triangleCount * 3,
        index === hot ? 1 : 0,
      );
    }
    mesh.material = [base, this.faceMaterial];
  }

  setHighlight(nodeId: NodeId | null): void {
    if (this.highlighted === nodeId) return;
    this.highlighted = nodeId;
    for (const id of this.meshes.keys()) this.applyMaterials(id);
  }

  setFaceHighlight(hit: FaceHit | null): void {
    const same =
      this.highlightedFace?.nodeId === hit?.nodeId &&
      this.highlightedFace?.faceIndex === hit?.faceIndex;
    if (same) return;

    const previous = this.highlightedFace;
    this.highlightedFace = hit !== null && hit.faceIndex !== null ? hit : null;
    if (previous !== null) this.applyMaterials(previous.nodeId);
    if (this.highlightedFace !== null) this.applyMaterials(this.highlightedFace.nodeId);
  }

  facesOf(nodeId: NodeId): readonly FaceInfo[] | undefined {
    return this.faces.get(nodeId);
  }

  setMesh(payload: MeshPayload): void {
    this.kinds.set(payload.nodeId, payload.kind);
    this.faces.set(payload.nodeId, payload.faces);
    this.faceIds.set(payload.nodeId, payload.faceIds);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(payload.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(payload.normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(payload.indices, 1));
    geometry.computeBoundingSphere();

    const existing = this.meshes.get(payload.nodeId);
    if (existing !== undefined) {
      existing.geometry.dispose();
      existing.geometry = geometry;
    } else {
      const mesh = new THREE.Mesh(geometry, this.material);
      mesh.userData.nodeId = payload.nodeId;
      mesh.renderOrder = payload.kind === 'sketch' ? 1 : 0;
      this.meshes.set(payload.nodeId, mesh);
      this.scene.add(mesh);
    }

    this.applyMaterials(payload.nodeId);
  }

  retain(visible: readonly NodeId[]): void {
    const keep = new Set(visible);
    for (const [nodeId, mesh] of this.meshes) {
      if (keep.has(nodeId)) continue;
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      this.meshes.delete(nodeId);
      this.kinds.delete(nodeId);
      this.faces.delete(nodeId);
      this.faceIds.delete(nodeId);
      if (this.highlightedFace?.nodeId === nodeId) this.highlightedFace = null;
    }
  }

  frameOnce(): void {
    if (this.framed || this.meshes.size === 0) return;

    const box = new THREE.Box3();
    for (const mesh of this.meshes.values()) box.expandByObject(mesh);
    if (box.isEmpty()) return;

    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length();

    this.controls.target.copy(center);
    this.camera.position
      .copy(center)
      .add(new THREE.Vector3(1, -1.3, 0.85).normalize().multiplyScalar(radius * 1.5));
    this.camera.near = Math.max(radius / 500, 0.01);
    this.camera.far = radius * 200;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.framed = true;
  }

  private resize(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
}
