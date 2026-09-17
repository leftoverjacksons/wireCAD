import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { NodeId, PlaneValue, Vec3 } from './core/types.js';
import type { EdgeInfo, FaceInfo } from './geometry/kernel.js';
import { planeYAxis } from './geometry/plane.js';
import type { MeshKind, MeshPayload } from './worker/protocol.js';

export interface FaceHit {
  nodeId: NodeId;
  faceIndex: number | null;
}

export interface EdgeHit {
  nodeId: NodeId;
  edgeIndex: number;
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
  private readonly edgeLines = new Map<NodeId, THREE.LineSegments>();
  private readonly edges = new Map<NodeId, EdgeInfo[]>();

  private readonly material = new THREE.MeshStandardMaterial({
    color: 0xff9900,
    metalness: 0.0,
    roughness: 0.45,
  });
  private readonly sketchMaterial = new THREE.MeshStandardMaterial({
    color: 0xf4ff61,
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
    color: 0xffc061,
    metalness: 0.0,
    roughness: 0.35,
    emissive: 0x5c2a00,
  });
  private readonly sketchHighlightMaterial = new THREE.MeshStandardMaterial({
    color: 0xfaffb0,
    metalness: 0.0,
    roughness: 0.5,
    emissive: 0x4a4a00,
    transparent: true,
    opacity: 0.65,
    side: THREE.DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  private readonly faceMaterial = new THREE.MeshStandardMaterial({
    color: 0x5cecff,
    metalness: 0.0,
    roughness: 0.4,
    emissive: 0x0a3d52,
  });

  private readonly edgeMaterial = new THREE.LineBasicMaterial({ color: 0x2a2f63 });
  // WebGL ignores line width, so a picked edge has to read by colour alone.
  private readonly edgeHoverMaterial = new THREE.LineBasicMaterial({ color: 0xaff6ff });
  private readonly edgeChosenMaterial = new THREE.LineBasicMaterial({ color: 0xff61c6 });

  private readonly raycaster = new THREE.Raycaster();
  private pickListener: ((hit: FaceHit | null) => void) | null = null;
  private edgePickListener: ((hit: EdgeHit | null) => void) | null = null;
  private highlighted: NodeId | null = null;
  private highlightedFace: FaceHit | null = null;
  private hoveredEdge: EdgeHit | null = null;
  private chosenEdges = new Map<NodeId, Set<number>>();
  private edgePicking = false;
  private framed = false;
  private pickingEnabled = true;
  /** Where the camera was before a sketch took it, so leaving can give it back. */
  private savedView: { position: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3 } | null =
    null;

  private readonly overlay: Array<THREE.LineSegments | THREE.Points> = [];
  // The sketch being edited sits on the face it defines, so it is drawn without
  // depth testing: what you are editing is never hidden by what it produces.
  private readonly overlayMaterial = new THREE.LineBasicMaterial({
    color: 0x5cecff,
    depthTest: false,
  });
  private readonly overlayPickedMaterial = new THREE.LineBasicMaterial({
    color: 0xff61c6,
    depthTest: false,
  });
  private readonly overlayPointMaterial = new THREE.PointsMaterial({
    color: 0xf4ff61,
    size: 8,
    sizeAttenuation: false,
    depthTest: false,
  });
  private readonly overlayPickedPointMaterial = new THREE.PointsMaterial({
    color: 0xff61c6,
    size: 11,
    sizeAttenuation: false,
    depthTest: false,
  });

  private sketchLine: THREE.LineLoop | THREE.Line | null = null;
  private sketchPoints: THREE.Points | null = null;
  private readonly sketchLineMaterial = new THREE.LineBasicMaterial({ color: 0xf4ff61 });
  private readonly sketchPointMaterial = new THREE.PointsMaterial({
    color: 0xff61c6,
    size: 7,
    sizeAttenuation: false,
  });

  constructor(private readonly container: HTMLElement) {
    this.scene.background = new THREE.Color(0x07081c);

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

    this.scene.add(new THREE.HemisphereLight(0xe8ecff, 0x171b45, 1.2));

    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(80, -120, 160);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0x5cecff, 0.7);
    fill.position.set(-120, 90, 40);
    this.scene.add(fill);

    const grid = new THREE.GridHelper(400, 40, 0x3f6f9c, 0x232a52);
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
    let armed = false;

    canvas.addEventListener('pointerdown', (event) => {
      downX = event.clientX;
      downY = event.clientY;
      armed = this.pickingEnabled;
    });

    canvas.addEventListener('pointerup', (event) => {
      // A click that began in another mode belongs to that mode, even if the
      // mode ended between pointerdown and pointerup.
      const wasArmed = armed;
      armed = false;
      if (!wasArmed || !this.pickingEnabled) return;
      if (Math.hypot(event.clientX - downX, event.clientY - downY) > 4) return;

      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );

      this.raycaster.setFromCamera(ndc, this.camera);

      // While picking edges, a nearby line beats the surface behind it.
      if (this.edgePicking) {
        const edgeHit = this.pickEdge();
        this.edgePickListener?.(edgeHit);
        return;
      }

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

  onEdgePick(listener: (hit: EdgeHit | null) => void): void {
    this.edgePickListener = listener;
  }

  /**
   * Line picking needs a world-space tolerance, and "close enough to click" is a
   * screen distance, so the threshold is scaled from how big the model is.
   */
  private edgeThreshold(): number {
    const box = new THREE.Box3();
    for (const mesh of this.meshes.values()) box.expandByObject(mesh);
    if (box.isEmpty()) return 1;
    return Math.max(box.getSize(new THREE.Vector3()).length() * 0.006, 1e-4);
  }

  private pickEdge(): EdgeHit | null {
    // Only bodies have edges worth filleting; a profile's outline sitting in the
    // same place would otherwise swallow the click.
    const lines = [...this.edgeLines]
      .filter(([nodeId]) => this.kinds.get(nodeId) === 'solid')
      .map(([, lines]) => lines);
    if (lines.length === 0) return null;

    const previous = this.raycaster.params.Line?.threshold;
    this.raycaster.params.Line = { threshold: this.edgeThreshold() };
    const hits = this.raycaster.intersectObjects(lines, false);
    if (previous !== undefined) this.raycaster.params.Line = { threshold: previous };

    const hit = hits[0];
    if (hit === undefined) return null;

    const nodeId = hit.object.userData.nodeId;
    if (typeof nodeId !== 'string') return null;

    // Three reports the segment index; map it back to the B-rep edge that owns it.
    const segment = hit.index === undefined || hit.index === null ? null : Math.floor(hit.index / 2);
    if (segment === null) return null;

    const edges = this.edges.get(nodeId) ?? [];
    for (const [index, edge] of edges.entries()) {
      if (segment >= edge.segmentStart && segment < edge.segmentStart + edge.segmentCount) {
        return { nodeId, edgeIndex: index };
      }
    }
    return null;
  }

  /** Turns on line picking and makes the edges legible while it is on. */
  setEdgePicking(enabled: boolean): void {
    if (this.edgePicking === enabled) return;
    this.edgePicking = enabled;
    this.edgeMaterial.color.set(enabled ? 0x5a63b0 : 0x2a2f63);
    if (!enabled) {
      this.hoveredEdge = null;
      for (const nodeId of this.edgeLines.keys()) this.applyEdgeMaterials(nodeId);
    }
  }

  setHoveredEdge(hit: EdgeHit | null): void {
    const same =
      this.hoveredEdge?.nodeId === hit?.nodeId && this.hoveredEdge?.edgeIndex === hit?.edgeIndex;
    if (same) return;

    const previous = this.hoveredEdge;
    this.hoveredEdge = hit;
    if (previous !== null) this.applyEdgeMaterials(previous.nodeId);
    if (hit !== null) this.applyEdgeMaterials(hit.nodeId);
  }

  /** The edges currently in a selection, drawn so the user can see the set grow. */
  setChosenEdges(nodeId: NodeId, indices: readonly number[]): void {
    if (indices.length === 0) this.chosenEdges.delete(nodeId);
    else this.chosenEdges.set(nodeId, new Set(indices));
    this.applyEdgeMaterials(nodeId);
  }

  clearChosenEdges(): void {
    const touched = [...this.chosenEdges.keys()];
    this.chosenEdges.clear();
    for (const nodeId of touched) this.applyEdgeMaterials(nodeId);
  }

  edgesOf(nodeId: NodeId): readonly EdgeInfo[] | undefined {
    return this.edges.get(nodeId);
  }

  /** Where a model point lands on screen, in client coordinates. */
  screenPositionOf(point: Vec3): { x: number; y: number } {
    const projected = new THREE.Vector3(point.x, point.y, point.z).project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return {
      x: rect.left + ((projected.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - projected.y) / 2) * rect.height,
    };
  }

  /** Hit-test for hover, without the click-versus-drag gate that picking uses. */
  edgeAt(clientX: number, clientY: number): EdgeHit | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.pickEdge();
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  // ------------------------------------------------------------ sketch mode

  setPickingEnabled(enabled: boolean): void {
    this.pickingEnabled = enabled;
  }

  /** Look straight down a plane's normal, with the plane's V axis pointing up. */
  alignToPlane(plane: PlaneValue): void {
    // Only the first alignment saves: a session that re-enters mid-edit must
    // not overwrite the view the person actually came from.
    if (this.savedView === null) {
      this.savedView = {
        position: this.camera.position.clone(),
        target: this.controls.target.clone(),
        up: this.camera.up.clone(),
      };
    }

    const origin = new THREE.Vector3(plane.origin.x, plane.origin.y, plane.origin.z);
    const normal = new THREE.Vector3(plane.normal.x, plane.normal.y, plane.normal.z);
    const up = planeYAxis(plane);

    const box = new THREE.Box3();
    for (const mesh of this.meshes.values()) box.expandByObject(mesh);
    const span = box.isEmpty() ? 120 : box.getSize(new THREE.Vector3()).length();

    this.camera.up.set(up.x, up.y, up.z);
    this.controls.target.copy(origin);
    this.camera.position.copy(origin).add(normal.multiplyScalar(span * 1.2));
    this.camera.updateProjectionMatrix();
    this.controls.enableRotate = false;
    this.controls.update();
  }

  /**
   * Hands the camera back to wherever it was before the sketch.
   *
   * Without this, leaving a sketch leaves you looking straight down its plane,
   * where a body extruded from it is exactly the outline you drew and nothing
   * appears to have happened.
   */
  releasePlaneAlignment(): void {
    const saved = this.savedView;
    this.savedView = null;
    this.controls.enableRotate = true;

    if (saved === null) {
      this.camera.up.set(0, 0, 1);
    } else {
      this.camera.up.copy(saved.up);
      this.camera.position.copy(saved.position);
      this.controls.target.copy(saved.target);
    }

    this.controls.update();
  }

  /** Where a screen position lands on the plane, in the plane's own U/V axes. */
  planePoint(clientX: number, clientY: number, plane: PlaneValue): { u: number; v: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);

    const normal = new THREE.Vector3(plane.normal.x, plane.normal.y, plane.normal.z);
    const origin = new THREE.Vector3(plane.origin.x, plane.origin.y, plane.origin.z);
    const mathPlane = new THREE.Plane(normal, -normal.dot(origin));

    const hit = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(mathPlane, hit) === null) return null;

    const relative = hit.sub(origin);
    const yAxis = planeYAxis(plane);
    return {
      u: relative.x * plane.xAxis.x + relative.y * plane.xAxis.y + relative.z * plane.xAxis.z,
      v: relative.x * yAxis.x + relative.y * yAxis.y + relative.z * yAxis.z,
    };
  }

  setSketchPreview(points: readonly Vec3[], closed: boolean): void {
    this.clearSketchPreview();
    if (points.length === 0) return;

    const flat = new Float32Array(points.length * 3);
    points.forEach((point, index) => {
      flat[index * 3] = point.x;
      flat[index * 3 + 1] = point.y;
      flat[index * 3 + 2] = point.z;
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(flat, 3));

    if (points.length > 1) {
      this.sketchLine = closed
        ? new THREE.LineLoop(geometry, this.sketchLineMaterial)
        : new THREE.Line(geometry, this.sketchLineMaterial);
      this.sketchLine.renderOrder = 4;
      this.scene.add(this.sketchLine);
    }

    this.sketchPoints = new THREE.Points(geometry, this.sketchPointMaterial);
    this.sketchPoints.renderOrder = 5;
    this.scene.add(this.sketchPoints);
  }

  /**
   * The sketch being edited: its entities, and which of them are picked. Drawn
   * as its own overlay so it can be hit-tested and highlighted independently of
   * the solved profile the worker sends back.
   */
  setSketchOverlay(
    segments: ReadonlyArray<{ points: readonly Vec3[]; selected: boolean }>,
    vertices: ReadonlyArray<{ at: Vec3; selected: boolean }>,
  ): void {
    this.clearSketchOverlay();

    for (const group of [false, true]) {
      const flat: number[] = [];
      for (const segment of segments) {
        if (segment.selected !== group) continue;
        for (let i = 0; i + 1 < segment.points.length; i++) {
          const a = segment.points[i]!;
          const b = segment.points[i + 1]!;
          flat.push(a.x, a.y, a.z, b.x, b.y, b.z);
        }
      }
      if (flat.length === 0) continue;

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(flat), 3));
      const lines = new THREE.LineSegments(
        geometry,
        group ? this.overlayPickedMaterial : this.overlayMaterial,
      );
      lines.renderOrder = 6;
      this.overlay.push(lines);
      this.scene.add(lines);
    }

    for (const group of [false, true]) {
      const flat: number[] = [];
      for (const vertex of vertices) {
        if (vertex.selected !== group) continue;
        flat.push(vertex.at.x, vertex.at.y, vertex.at.z);
      }
      if (flat.length === 0) continue;

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(flat), 3));
      const points = new THREE.Points(
        geometry,
        group ? this.overlayPickedPointMaterial : this.overlayPointMaterial,
      );
      points.renderOrder = 7;
      this.overlay.push(points);
      this.scene.add(points);
    }
  }

  clearSketchOverlay(): void {
    for (const object of this.overlay) {
      this.scene.remove(object);
      object.geometry.dispose();
    }
    this.overlay.length = 0;
  }

  /** How far a click may miss, in model units, for a given screen slack. */
  pickTolerance(plane: PlaneValue, pixels: number): number {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const centre = this.planePoint(rect.left + rect.width / 2, rect.top + rect.height / 2, plane);
    const offset = this.planePoint(
      rect.left + rect.width / 2 + pixels,
      rect.top + rect.height / 2,
      plane,
    );
    if (centre === null || offset === null) return 1;
    return Math.max(Math.hypot(offset.u - centre.u, offset.v - centre.v), 1e-6);
  }

  clearSketchPreview(): void {
    if (this.sketchLine !== null) {
      this.scene.remove(this.sketchLine);
      this.sketchLine = null;
    }
    if (this.sketchPoints !== null) {
      this.scene.remove(this.sketchPoints);
      this.sketchPoints.geometry.dispose();
      this.sketchPoints = null;
    }
  }

  setDimmed(dimmed: boolean): void {
    for (const material of [this.material, this.highlightMaterial]) {
      material.transparent = dimmed;
      material.opacity = dimmed ? 0.25 : 1;
      material.needsUpdate = true;
    }
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

  /** Visible bodies, excluding sketch profiles, which do not belong in an export. */
  solidNodes(): NodeId[] {
    return [...this.kinds].filter(([, kind]) => kind === 'solid').map(([nodeId]) => nodeId);
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
    this.setEdgeGeometry(payload);
  }

  /** Edges are their own object: line picking and surface picking do not mix. */
  private setEdgeGeometry(payload: MeshPayload): void {
    this.edges.set(payload.nodeId, payload.edges);

    const existing = this.edgeLines.get(payload.nodeId);
    if (payload.edges.length === 0) {
      if (existing !== undefined) {
        this.scene.remove(existing);
        existing.geometry.dispose();
        this.edgeLines.delete(payload.nodeId);
      }
      return;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(payload.edgePositions, 3));
    geometry.computeBoundingSphere();

    if (existing !== undefined) {
      existing.geometry.dispose();
      existing.geometry = geometry;
    } else {
      const lines = new THREE.LineSegments(geometry, this.edgeMaterial);
      lines.userData.nodeId = payload.nodeId;
      lines.renderOrder = 2;
      this.edgeLines.set(payload.nodeId, lines);
      this.scene.add(lines);
    }

    this.applyEdgeMaterials(payload.nodeId);
  }

  /** One render group per B-rep edge, mirroring how faces carry their own material. */
  private applyEdgeMaterials(nodeId: NodeId): void {
    const lines = this.edgeLines.get(nodeId);
    if (lines === undefined) return;

    const edges = this.edges.get(nodeId) ?? [];
    const chosen = this.chosenEdges.get(nodeId);
    const hot = this.hoveredEdge?.nodeId === nodeId ? this.hoveredEdge.edgeIndex : -1;

    lines.geometry.clearGroups();
    if (edges.length === 0 || (hot < 0 && (chosen === undefined || chosen.size === 0))) {
      lines.material = this.edgeMaterial;
      return;
    }

    for (const [index, edge] of edges.entries()) {
      const slot = index === hot ? 1 : (chosen?.has(index) ?? false) ? 2 : 0;
      lines.geometry.addGroup(edge.segmentStart * 2, edge.segmentCount * 2, slot);
    }
    lines.material = [this.edgeMaterial, this.edgeHoverMaterial, this.edgeChosenMaterial];
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
      const lines = this.edgeLines.get(nodeId);
      if (lines !== undefined) {
        this.scene.remove(lines);
        lines.geometry.dispose();
        this.edgeLines.delete(nodeId);
      }
      this.edges.delete(nodeId);
      this.chosenEdges.delete(nodeId);
      if (this.highlightedFace?.nodeId === nodeId) this.highlightedFace = null;
      if (this.hoveredEdge?.nodeId === nodeId) this.hoveredEdge = null;
    }
  }

  frameOnce(): void {
    // Not while a sketch holds the camera: the first mesh a new sketch produces
    // would otherwise swing the view off the plane being drawn on.
    if (this.savedView !== null) return;
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
