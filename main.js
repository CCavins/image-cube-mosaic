import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

const canvas = document.getElementById("scene");
const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const imageListEl = document.getElementById("image-list");
const clearAllBtn = document.getElementById("clear-all");
const presetListEl = document.getElementById("preset-list");
const statusEl = document.getElementById("status");
const densitySlider = document.getElementById("density-slider");
const densityValueEl = document.getElementById("density-value");
const dwellSlider = document.getElementById("dwell-slider");
const dwellValueEl = document.getElementById("dwell-value");
const cubeColorInput = document.getElementById("cube-color");
const cubeColorValueEl = document.getElementById("cube-color-value");

const PRESETS = [
  { id: "cluster", label: "Cluster" },
  { id: "orbit", label: "Orbit" },
  { id: "spiral", label: "Spiral" },
  { id: "wave", label: "Wave" },
  { id: "sphere", label: "Sphere" },
  { id: "helix", label: "Helix" },
  { id: "grid", label: "Grid" },
  { id: "scatter", label: "Scatter" },
];

const MAX_TILES = 52;
const MIN_TILES = 8;
const CUBE_SIZE = 0.72;
const MIN_GAP = 0.42; // extra air gap beyond non-overlap spheres
const FACE_COVERAGE = 0.82; // try to keep ~82% of active faces imaged
const FADE_MS = 900; // smooth crossfade duration
const MAX_TEX_SIZE = 512; // downscale library images for GPU
const MAX_ACTIVE_FADES = 18; // limit simultaneous face fades per frame

const images = [];
let nextImageId = 1;
let activePreset = "cluster";
let activeTileCount = MAX_TILES;
let dwellMs = 4000;
let coverageTimer = 0;
let densityApplyTimer = 0;

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: window.devicePixelRatio < 1.5,
  alpha: false,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050506);
scene.fog = new THREE.FogExp2(0x050506, 0.018);

const camera = new THREE.PerspectiveCamera(
  38,
  window.innerWidth / window.innerHeight,
  0.1,
  100
);
camera.position.set(2.8, 1.6, 10.5);

const pmrem = new THREE.PMREMGenerator(renderer);

function buildGlowEnvironment() {
  // Small smooth env — enough for metal response without heavy PMREM cost
  const width = 256;
  const height = 128;
  const data = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y++) {
    const v = y / (height - 1);
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1);
      const wave = 0.5 + 0.5 * Math.sin(u * Math.PI * 2 + v * 1.2);
      const r = Math.floor(12 + wave * 40 + (1 - v) * 30);
      const g = Math.floor(14 + wave * 35 + v * 20);
      const b = Math.floor(22 + (1 - v) * 55 + wave * 45);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.needsUpdate = true;
  texture.colorSpace = THREE.SRGBColorSpace;
  const envMap = pmrem.fromEquirectangular(texture).texture;
  texture.dispose();
  pmrem.dispose();
  return envMap;
}

scene.environment = buildGlowEnvironment();
scene.environmentIntensity = 0.95;

const keyLight = new THREE.DirectionalLight(0xa8c4ff, 2.8);
keyLight.position.set(5, 7, 6);
scene.add(keyLight);

const rimLight = new THREE.DirectionalLight(0x5ef0d0, 1.6);
rimLight.position.set(-6, 3, -4);
scene.add(rimLight);

const fillLight = new THREE.AmbientLight(0x4a5a80, 0.65);
scene.add(fillLight);

const root = new THREE.Group();
scene.add(root);

// Fewer segments = much cheaper geometry while keeping soft edges
const geometry = new RoundedBoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE, 1, 0.08);
const cubeColor = new THREE.Color(0x10131c);

function makeBaseMaterial() {
  // Standard is far cheaper than Physical+clearcoat+iridescence
  return new THREE.MeshStandardMaterial({
    color: cubeColor.clone(),
    metalness: 0.85,
    roughness: 0.34,
    envMapIntensity: 0.85,
  });
}

const sharedBaseMaterial = makeBaseMaterial();

function boundingRadius(scale) {
  // Sphere that fully contains a cube of side CUBE_SIZE at the given scale
  return (CUBE_SIZE * scale * Math.sqrt(3)) / 2;
}

function minCenterDistance(scaleA, scaleB) {
  return boundingRadius(scaleA) + boundingRadius(scaleB) + MIN_GAP;
}

/** Push targets apart in 3D until every pair clears the minimum distance. */
function separateTargets(targets, iterations = 36) {
  const scratch = new THREE.Vector3();
  for (let iter = 0; iter < iterations; iter++) {
    let moved = false;
    for (let i = 0; i < targets.length; i++) {
      for (let j = i + 1; j < targets.length; j++) {
        const a = targets[i];
        const b = targets[j];
        scratch.subVectors(b.position, a.position);
        let dist = scratch.length();
        const minDist = minCenterDistance(a.scale, b.scale);

        if (dist < 1e-6) {
          // Identical positions — nudge apart on a stable axis
          scratch.set(
            seededNoise(i + j, 31) - 0.5,
            seededNoise(i + j, 32) - 0.5,
            seededNoise(i + j, 33) - 0.5
          );
          if (scratch.lengthSq() < 1e-8) scratch.set(1, 0, 0);
          dist = 0;
        }

        if (dist < minDist) {
          const push = (minDist - Math.max(dist, 1e-6)) * 0.55;
          scratch.normalize().multiplyScalar(push);
          a.position.sub(scratch);
          b.position.add(scratch);
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  return targets;
}

function buildAllTargets(preset, count) {
  const targets = [];
  for (let i = 0; i < count; i++) {
    targets.push(getTargets(preset, i, count));
  }
  return separateTargets(targets);
}

function makeImageMaterial(texture) {
  const mat = new THREE.MeshStandardMaterial({
    map: texture,
    color: cubeColor.clone(),
    metalness: 0.4,
    roughness: 0.4,
    envMapIntensity: 0.65,
    // Stay opaque — PNG alpha composites over cube color, not the scene
    transparent: false,
    opacity: 1,
    depthWrite: true,
  });

  // 0 = cube color only, 1 = full image composite (for smooth fades)
  mat.userData.imageMix = { value: 0 };

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uImageMix = mat.userData.imageMix;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform float uImageMix;`
      )
      .replace(
        "#include <map_fragment>",
        `
#ifdef USE_MAP
	vec4 sampledDiffuseColor = texture2D( map, vMapUv );
	float imgA = clamp(sampledDiffuseColor.a * uImageMix, 0.0, 1.0);
	// Transparent PNG pixels show the cube color underneath
	diffuseColor = vec4(mix(diffuseColor.rgb, sampledDiffuseColor.rgb, imgA), 1.0);
#endif
`
      );
  };
  mat.customProgramCacheKey = () => "image-over-cube-std-v1";

  return mat;
}

function downscaleImageElement(img, maxSize) {
  const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
  if (scale >= 1) return img;
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);
  return c;
}

/** One GPU texture per library image — shared across all faces. */
function ensureImageTexture(image) {
  if (image.texture) return image.texture;

  const texture = new THREE.Texture();
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  image.texture = texture;

  const img = new Image();
  img.onload = () => {
    texture.image = downscaleImageElement(img, MAX_TEX_SIZE);
    texture.needsUpdate = true;
  };
  img.onerror = () => {
    console.warn("Failed to load texture", image.name);
  };
  img.src = image.url;

  return texture;
}

function disposeImageTexture(image) {
  if (image?.texture) {
    image.texture.dispose();
    image.texture = null;
  }
}

function setCubeColor(hex) {
  cubeColor.set(hex);
  const label = `#${cubeColor.getHexString()}`;
  cubeColorInput.value = label;
  cubeColorValueEl.textContent = label;

  sharedBaseMaterial.color.copy(cubeColor);
  for (const tile of tiles) {
    for (const slot of tile.faceSlots) {
      if (slot.material) slot.material.color.copy(cubeColor);
    }
  }
}

function seededNoise(i, salt = 0) {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function buildClusterTargets(i, count) {
  // Asymmetric plus / Decart-like silhouette — unique cells only
  const seen = new Set();
  const cells = [];
  const add = (x, y, z) => {
    const key = `${x},${y},${z}`;
    if (seen.has(key)) return;
    seen.add(key);
    cells.push([x, y, z]);
  };

  for (let y = -4; y <= 5; y++) add(0, y, 0);
  for (let x = -5; x <= 4; x++) if (x !== 0) add(x, 0, 0);
  // Keep Z shallow so the plus reads clearly (depth stacking looks like overlap on screen)
  for (let z = -1; z <= 1; z++) if (z !== 0) add(0, 0, z);

  [
    [1, 1, 0], [1, -1, 0], [-1, 1, 0], [-1, -1, 0],
    [2, 1, 0], [-2, 1, 0], [3, 0, 1], [-3, 0, -1],
    [0, 2, 1], [0, -2, -1], [1, 0, 1], [-1, 0, -1],
    [2, 0, -1], [-2, 0, 1], [0, 1, 1], [0, -1, -1],
    [4, 1, 0], [-4, -1, 0], [1, 2, 0], [-1, -2, 0],
    [5, 0, 0], [-5, 0, 0], [0, 6, 0], [0, -5, 0],
    [2, -1, 0], [-2, -1, 0], [3, 1, 0], [-3, -1, 0],
    [1, 0, -1], [-1, 0, 1], [0, 2, -1], [0, -3, 1],
    [2, 2, 0], [-2, 2, 0], [1, 3, 0], [-1, 3, 0],
    [3, -1, 0], [0, 1, -1], [4, -1, 0], [-4, 1, 0],
    [0, 3, 1], [0, -4, 0], [6, 0, 0], [-6, 0, 0],
  ].forEach(([x, y, z]) => add(x, y, z));

  let guard = 0;
  while (cells.length < count && guard < 400) {
    const arm = guard % 3;
    if (arm === 0) add(Math.floor(guard / 3) - 8, (guard % 5) - 2, 0);
    else if (arm === 1) add((guard % 5) - 2, Math.floor(guard / 3) - 8, 0);
    else add(0, (guard % 5) - 2, Math.floor(guard / 3) - 4);
    guard++;
  }

  const [cx, cy, cz] = cells[i % cells.length];
  // Spacing >= cube diagonal so neighbors clear even while spinning
  const spacing = minCenterDistance(0.95, 0.95);
  return {
    position: new THREE.Vector3(cx * spacing, cy * spacing, cz * spacing),
    rotation: new THREE.Euler(0, 0, 0),
    scale: 0.95,
  };
}

function buildOrbitTargets(i, count) {
  const ring = i % 3;
  const inRing = Math.floor(i / 3);
  const ringCount = Math.ceil(count / 3);
  const radius = 2.4 + ring * 1.55;
  const angle = (inRing / ringCount) * Math.PI * 2 + ring * 0.4;
  const y = Math.sin(angle * 2 + ring) * 0.7 + (ring - 1) * 0.55;
  return {
    position: new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius),
    rotation: new THREE.Euler(0, -angle + Math.PI / 2, ring * 0.15),
    scale: 0.85 + ring * 0.08,
  };
}

function buildSpiralTargets(i, count) {
  const t = i / count;
  const turns = 3.2;
  const angle = t * Math.PI * 2 * turns;
  const radius = 1.1 + t * 3.2;
  const y = (t - 0.5) * 6.2;
  return {
    position: new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius),
    rotation: new THREE.Euler(0.2, -angle, 0.1),
    scale: 0.78 + (1 - t) * 0.3,
  };
}

function buildWaveTargets(i, count) {
  const cols = 9;
  const rows = Math.ceil(count / cols);
  const x = (i % cols) - (cols - 1) / 2;
  const z = Math.floor(i / cols) - (rows - 1) / 2;
  const y = Math.sin(x * 0.75) * Math.cos(z * 0.7) * 1.4;
  return {
    position: new THREE.Vector3(x * 1.2, y, z * 1.2),
    rotation: new THREE.Euler(y * 0.15, 0, x * 0.05),
    scale: 0.88,
  };
}

function buildSphereTargets(i, count) {
  // Fibonacci sphere
  const golden = Math.PI * (3 - Math.sqrt(5));
  const y = 1 - (i / (count - 1)) * 2;
  const radiusAtY = Math.sqrt(1 - y * y);
  const theta = golden * i;
  const r = 4.2;
  return {
    position: new THREE.Vector3(
      Math.cos(theta) * radiusAtY * r,
      y * r,
      Math.sin(theta) * radiusAtY * r
    ),
    rotation: new THREE.Euler(y * 0.5, theta, 0),
    scale: 0.82,
  };
}

function buildHelixTargets(i, count) {
  const strand = i % 2;
  const t = Math.floor(i / 2) / Math.ceil(count / 2);
  const angle = t * Math.PI * 2 * 3.5 + strand * Math.PI;
  const radius = 2.1;
  const y = (t - 0.5) * 7.2;
  return {
    position: new THREE.Vector3(
      Math.cos(angle) * radius,
      y,
      Math.sin(angle) * radius
    ),
    rotation: new THREE.Euler(0.15, -angle + Math.PI / 2, strand * 0.2),
    scale: 0.86,
  };
}

function buildGridTargets(i, count) {
  const side = Math.ceil(Math.cbrt(count));
  const x = (i % side) - (side - 1) / 2;
  const y = (Math.floor(i / side) % side) - (side - 1) / 2;
  const z = Math.floor(i / (side * side)) - (side - 1) / 2;
  return {
    position: new THREE.Vector3(x * 1.35, y * 1.35, z * 1.35),
    rotation: new THREE.Euler(0, 0, 0),
    scale: 0.9,
  };
}

function buildScatterTargets(i) {
  const r = 2.2 + seededNoise(i, 11) * 4.2;
  const theta = seededNoise(i, 12) * Math.PI * 2;
  const phi = Math.acos(2 * seededNoise(i, 13) - 1);
  return {
    position: new THREE.Vector3(
      r * Math.sin(phi) * Math.cos(theta),
      r * Math.cos(phi) * 0.85,
      r * Math.sin(phi) * Math.sin(theta)
    ),
    rotation: new THREE.Euler(
      seededNoise(i, 14) * Math.PI,
      seededNoise(i, 15) * Math.PI,
      seededNoise(i, 16) * Math.PI
    ),
    scale: 0.7 + seededNoise(i, 17) * 0.45,
  };
}

function getTargets(preset, i, count) {
  switch (preset) {
    case "orbit":
      return buildOrbitTargets(i, count);
    case "spiral":
      return buildSpiralTargets(i, count);
    case "wave":
      return buildWaveTargets(i, count);
    case "sphere":
      return buildSphereTargets(i, count);
    case "helix":
      return buildHelixTargets(i, count);
    case "grid":
      return buildGridTargets(i, count);
    case "scatter":
      return buildScatterTargets(i);
    case "cluster":
    default:
      return buildClusterTargets(i, count);
  }
}

const tiles = [];
const initialTargets = buildAllTargets("cluster", MAX_TILES);

for (let i = 0; i < MAX_TILES; i++) {
  // Shared base material across all empty faces → far fewer GPU programs
  const materials = [
    sharedBaseMaterial,
    sharedBaseMaterial,
    sharedBaseMaterial,
    sharedBaseMaterial,
    sharedBaseMaterial,
    sharedBaseMaterial,
  ];
  const mesh = new THREE.Mesh(geometry, materials);
  mesh.matrixAutoUpdate = true;
  const target = initialTargets[i];

  mesh.position.copy(target.position);
  mesh.rotation.copy(target.rotation);
  mesh.scale.setScalar(target.scale);
  root.add(mesh);

  const faceSlots = Array.from({ length: 6 }, () => ({
    imageId: null,
    material: null,
    fade: 0,
    state: "empty", // empty | fadingIn | holding | fadingOut
    holdUntil: 0,
    pendingImage: null,
  }));

  tiles.push({
    mesh,
    index: i,
    active: true,
    phase: seededNoise(i, 20) * Math.PI * 2,
    spin: new THREE.Vector3(
      (seededNoise(i, 21) - 0.5) * 0.4,
      (seededNoise(i, 22) - 0.5) * 0.55,
      (seededNoise(i, 23) - 0.5) * 0.35
    ),
    current: {
      position: target.position.clone(),
      rotation: target.rotation.clone(),
      scale: target.scale,
    },
    target: {
      position: target.position.clone(),
      rotation: target.rotation.clone(),
      scale: target.scale,
    },
    faceSlots,
  });
}

function layoutActiveTiles(preset = activePreset, { snap = false } = {}) {
  const nextTargets = buildAllTargets(preset, activeTileCount);
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    if (i < activeTileCount) {
      const next = nextTargets[i];
      tile.active = true;
      tile.mesh.visible = true;
      tile.target.position.copy(next.position);
      tile.target.rotation.copy(next.rotation);
      tile.target.scale = next.scale;
      if (snap) {
        tile.current.position.copy(next.position);
        tile.current.rotation.copy(next.rotation);
        tile.current.scale = next.scale;
        tile.mesh.position.copy(next.position);
        tile.mesh.rotation.copy(next.rotation);
        tile.mesh.scale.setScalar(next.scale);
      }
    } else {
      tile.active = false;
      tile.mesh.visible = false;
      for (let f = 0; f < 6; f++) clearFaceSlot(tile, f);
    }
  }
}

function setPreset(id) {
  activePreset = id;
  layoutActiveTiles(id, { snap: false });
  [...presetListEl.querySelectorAll(".preset-btn")].forEach((btn) => {
    const on = btn.dataset.preset === id;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  statusEl.textContent = `Motion · ${PRESETS.find((p) => p.id === id)?.label ?? id}`;
}

function setDensity(count) {
  activeTileCount = Math.max(MIN_TILES, Math.min(MAX_TILES, Math.round(count)));
  densitySlider.value = String(activeTileCount);
  densityValueEl.textContent = String(activeTileCount);
  layoutActiveTiles(activePreset, { snap: true });
  ensureFaceCoverage(true);
  statusEl.textContent = `Density · ${activeTileCount} cubes`;
}

function setDwellSeconds(seconds) {
  dwellMs = Math.max(1000, Math.min(12000, seconds * 1000));
  dwellSlider.value = String(seconds);
  dwellValueEl.textContent = `${Number(seconds).toFixed(1)}s`;

  // Stretch/compress remaining hold time proportionally for faces already holding
  const now = performance.now();
  for (let i = 0; i < activeTileCount; i++) {
    const tile = tiles[i];
    for (const slot of tile.faceSlots) {
      if (slot.state !== "holding") continue;
      const remaining = Math.max(0, slot.holdUntil - now);
      // Keep relative progress: remap leftover into new dwell window (capped)
      slot.holdUntil = now + Math.min(dwellMs, remaining || dwellMs * (0.2 + Math.random() * 0.8));
    }
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderImageList() {
  clearAllBtn.disabled = images.length === 0;

  if (images.length === 0) {
    imageListEl.innerHTML = `<li class="empty-state">Drop images to begin</li>`;
    return;
  }

  imageListEl.innerHTML = images
    .map(
      (img) => `
      <li class="image-item" data-id="${img.id}">
        <img src="${img.url}" alt="" />
        <div class="meta">
          <span class="name" title="${img.name}">${img.name}</span>
          <span class="size">${formatBytes(img.size)}</span>
        </div>
        <button type="button" class="remove-btn" data-remove="${img.id}" aria-label="Remove ${img.name}">×</button>
      </li>`
    )
    .join("");
}

function clearFaceSlot(tile, faceIndex) {
  const slot = tile.faceSlots[faceIndex];
  // Keep slot.material around for reuse (avoids shader recompiles / GC spikes)
  if (slot.material) {
    slot.material.userData.imageMix.value = 0;
  }
  tile.mesh.material[faceIndex] = sharedBaseMaterial;
  slot.imageId = null;
  slot.fade = 0;
  slot.state = "empty";
  slot.holdUntil = 0;
  slot.pendingImage = null;
}

function applyTextureToSlot(tile, faceIndex, image, { fadeIn = true, holdJitter = true } = {}) {
  const slot = tile.faceSlots[faceIndex];
  const texture = ensureImageTexture(image);

  if (!slot.material) {
    slot.material = makeImageMaterial(texture);
  } else {
    slot.material.map = texture;
    slot.material.color.copy(cubeColor);
    slot.material.needsUpdate = true;
  }

  const mat = slot.material;
  slot.imageId = image.id;
  slot.pendingImage = null;
  tile.mesh.material[faceIndex] = mat;

  if (fadeIn) {
    slot.fade = 0;
    mat.userData.imageMix.value = 0;
    slot.state = "fadingIn";
    slot.holdUntil = 0;
  } else {
    slot.fade = 1;
    mat.userData.imageMix.value = 1;
    slot.state = "holding";
    const jitter = holdJitter ? 0.25 + Math.random() * 0.9 : 1;
    slot.holdUntil = performance.now() + dwellMs * jitter;
  }
}

function beginFaceCycle(tile, faceIndex, image) {
  const slot = tile.faceSlots[faceIndex];
  if (!image) return;

  // Empty face — fade in directly
  if (slot.state === "empty" || !slot.material) {
    applyTextureToSlot(tile, faceIndex, image, { fadeIn: true });
    return;
  }

  // Already showing something — fade out, then swap
  if (slot.state === "holding" || slot.state === "fadingIn") {
    slot.pendingImage = image;
    slot.state = "fadingOut";
  }
}

function removeImageFromTiles(imageId) {
  for (const tile of tiles) {
    for (let f = 0; f < 6; f++) {
      const slot = tile.faceSlots[f];
      if (slot.imageId === imageId || slot.pendingImage?.id === imageId) {
        if (slot.pendingImage?.id === imageId) slot.pendingImage = null;
        if (slot.imageId === imageId) {
          if (slot.state === "holding" || slot.state === "fadingIn") {
            slot.state = "fadingOut";
            slot.pendingImage = images.length ? pickRandomImage(imageId) : null;
          } else {
            clearFaceSlot(tile, f);
          }
        }
      }
    }
  }
}

function pickRandomImage(excludeId = null) {
  if (images.length === 0) return null;
  if (images.length === 1) return images[0];
  let pick = images[Math.floor(Math.random() * images.length)];
  let guard = 0;
  while (pick.id === excludeId && guard < 8) {
    pick = images[Math.floor(Math.random() * images.length)];
    guard++;
  }
  return pick;
}

function listActiveFaceRefs() {
  const refs = [];
  for (let i = 0; i < activeTileCount; i++) {
    const tile = tiles[i];
    for (let f = 0; f < 6; f++) {
      refs.push({ tile, face: f, slot: tile.faceSlots[f] });
    }
  }
  return refs;
}

/** Keep most cube faces in the rotation, preferring empties / least-recent. */
function ensureFaceCoverage(force = false) {
  if (images.length === 0) return;

  const refs = listActiveFaceRefs();
  const busy = refs.filter((r) => r.slot.state !== "empty");
  const targetFilled = Math.max(1, Math.floor(refs.length * FACE_COVERAGE));
  let need = targetFilled - busy.length;
  if (!force && need <= 0) return;
  if (force) need = Math.max(need, Math.floor(refs.length * 0.5));

  const empties = refs
    .filter((r) => r.slot.state === "empty")
    .sort(() => Math.random() - 0.5);

  const fillCount = Math.min(need, empties.length);
  for (let i = 0; i < fillCount; i++) {
    const { tile, face } = empties[i];
    const image = pickRandomImage();
    if (image) beginFaceCycle(tile, face, image);
  }
}

function updateFaceTransitions(dt, now) {
  const fadeSpeed = 1000 / FADE_MS;
  let activeFades = 0;

  // Count current fades so we don't start too many in one frame
  for (let i = 0; i < activeTileCount; i++) {
    const tile = tiles[i];
    for (let f = 0; f < 6; f++) {
      const st = tile.faceSlots[f].state;
      if (st === "fadingIn" || st === "fadingOut") activeFades++;
    }
  }

  for (let i = 0; i < activeTileCount; i++) {
    const tile = tiles[i];
    for (let f = 0; f < 6; f++) {
      const slot = tile.faceSlots[f];

      if (slot.state === "fadingIn") {
        slot.fade = Math.min(1, slot.fade + dt * fadeSpeed);
        if (slot.material) {
          slot.material.userData.imageMix.value = smoothstep(slot.fade);
        }
        if (slot.fade >= 1) {
          slot.state = "holding";
          // Stagger holds so faces don't all swap together
          slot.holdUntil = now + dwellMs * (0.55 + Math.random() * 0.7);
          activeFades--;
        }
      } else if (slot.state === "holding") {
        if (images.length === 0) {
          if (activeFades < MAX_ACTIVE_FADES) {
            slot.state = "fadingOut";
            slot.pendingImage = null;
            activeFades++;
          }
        } else if (now >= slot.holdUntil) {
          if (activeFades < MAX_ACTIVE_FADES) {
            slot.pendingImage = pickRandomImage(slot.imageId);
            slot.state = "fadingOut";
            activeFades++;
          } else {
            // Delay swap until a fade slot frees up
            slot.holdUntil = now + 120 + Math.random() * 200;
          }
        }
      } else if (slot.state === "fadingOut") {
        slot.fade = Math.max(0, slot.fade - dt * fadeSpeed);
        if (slot.material) {
          slot.material.userData.imageMix.value = smoothstep(slot.fade);
        }
        if (slot.fade <= 0) {
          let next = slot.pendingImage;
          if (!next || !images.some((img) => img.id === next.id)) {
            next = images.length ? pickRandomImage(slot.imageId) : null;
          }
          if (next) {
            applyTextureToSlot(tile, f, next, { fadeIn: true });
          } else {
            clearFaceSlot(tile, f);
            activeFades--;
          }
        }
      }
    }
  }
}

function smoothstep(t) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

function seedFacesFromLibrary() {
  ensureFaceCoverage(true);
}

async function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith("image/"));
  if (files.length === 0) {
    statusEl.textContent = "No image files found";
    return;
  }

  for (const file of files) {
    const url = URL.createObjectURL(file);
    images.push({
      id: nextImageId++,
      name: file.name,
      size: file.size,
      url,
    });
  }

  renderImageList();
  seedFacesFromLibrary();
  statusEl.textContent = `${files.length} image${files.length === 1 ? "" : "s"} added · cycling across faces`;
}

function removeImage(id) {
  const idx = images.findIndex((img) => img.id === id);
  if (idx === -1) return;
  const [removed] = images.splice(idx, 1);
  removeImageFromTiles(removed.id);
  disposeImageTexture(removed);
  URL.revokeObjectURL(removed.url);
  renderImageList();

  if (images.length > 0) {
    ensureFaceCoverage(true);
    statusEl.textContent = "Image removed";
  } else {
    statusEl.textContent = "Library empty · drop images to begin";
  }
}

function clearAll() {
  for (const tile of tiles) {
    for (let f = 0; f < 6; f++) clearFaceSlot(tile, f);
  }
  for (const img of images) {
    disposeImageTexture(img);
    URL.revokeObjectURL(img.url);
  }
  images.length = 0;
  renderImageList();
  statusEl.textContent = "Library cleared";
}

// UI wiring
PRESETS.forEach((preset) => {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "preset-btn" + (preset.id === activePreset ? " active" : "");
  btn.dataset.preset = preset.id;
  btn.textContent = preset.label;
  btn.setAttribute("role", "option");
  btn.setAttribute("aria-selected", preset.id === activePreset ? "true" : "false");
  btn.addEventListener("click", () => {
    setPreset(preset.id);
    [...presetListEl.querySelectorAll(".preset-btn")].forEach((b) => {
      b.setAttribute("aria-selected", b.dataset.preset === preset.id ? "true" : "false");
    });
  });
  presetListEl.appendChild(btn);
});

dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});

fileInput.addEventListener("change", () => {
  if (fileInput.files?.length) addFiles(fileInput.files);
  fileInput.value = "";
});

["dragenter", "dragover"].forEach((type) => {
  dropZone.addEventListener(type, (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach((type) => {
  dropZone.addEventListener(type, (e) => {
    e.preventDefault();
    if (type === "dragleave" && e.target !== dropZone) return;
    dropZone.classList.remove("dragover");
  });
});

dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});

window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

imageListEl.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-remove]");
  if (!btn) return;
  removeImage(Number(btn.dataset.remove));
});

clearAllBtn.addEventListener("click", clearAll);

densitySlider.min = String(MIN_TILES);
densitySlider.max = String(MAX_TILES);
densitySlider.value = String(activeTileCount);
densityValueEl.textContent = String(activeTileCount);
densitySlider.addEventListener("input", () => {
  // Update label immediately; debounce the expensive reflow
  densityValueEl.textContent = densitySlider.value;
  clearTimeout(densityApplyTimer);
  densityApplyTimer = setTimeout(() => {
    setDensity(Number(densitySlider.value));
  }, 80);
});
densitySlider.addEventListener("change", () => {
  clearTimeout(densityApplyTimer);
  setDensity(Number(densitySlider.value));
});

dwellSlider.addEventListener("input", () => {
  setDwellSeconds(Number(dwellSlider.value));
});
setDwellSeconds(Number(dwellSlider.value));

cubeColorInput.addEventListener("input", () => {
  setCubeColor(cubeColorInput.value);
});
setCubeColor(cubeColorInput.value);

let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }, 100);
});

const clock = new THREE.Clock();
const tmpEuler = new THREE.Euler();
let wobbleScale = 0.4;

function animate() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  const now = performance.now();

  updateFaceTransitions(dt, now);

  coverageTimer += dt;
  if (coverageTimer >= 1.25) {
    coverageTimer = 0;
    ensureFaceCoverage(false);
  }

  // Global group motion varies by preset
  const breathe = Math.sin(t * 0.35) * 0.04;
  root.rotation.y = t * (activePreset === "orbit" ? 0.22 : activePreset === "cluster" ? 0.12 : 0.08);
  root.rotation.x = Math.sin(t * 0.18) * 0.08 + breathe;
  root.position.y = Math.sin(t * 0.4) * 0.12;

  wobbleScale =
    activePreset === "scatter"
      ? 0.7
      : activePreset === "wave"
        ? 0.55
        : activePreset === "cluster"
          ? 0.25
          : 0.4;

  const settle = 1 - Math.exp(-dt * 2.4);
  const spinMul = activePreset === "grid" ? 0.15 : 1;

  for (let i = 0; i < activeTileCount; i++) {
    const tile = tiles[i];

    tile.current.position.lerp(tile.target.position, settle);
    tile.current.scale += (tile.target.scale - tile.current.scale) * settle;

    tile.current.rotation.x += (tile.target.rotation.x - tile.current.rotation.x) * settle;
    tile.current.rotation.y += (tile.target.rotation.y - tile.current.rotation.y) * settle;
    tile.current.rotation.z += (tile.target.rotation.z - tile.current.rotation.z) * settle;

    const ox = Math.sin(t * 0.7 + tile.phase) * 0.02 * wobbleScale;
    const oy = Math.cos(t * 0.55 + tile.phase * 1.3) * 0.025 * wobbleScale;
    const oz = Math.sin(t * 0.4 + tile.phase * 0.7) * 0.015 * wobbleScale;

    tile.mesh.position.set(
      tile.current.position.x + ox,
      tile.current.position.y + oy,
      tile.current.position.z + oz
    );
    tile.mesh.scale.setScalar(tile.current.scale);

    tmpEuler.set(
      tile.current.rotation.x + t * tile.spin.x * spinMul,
      tile.current.rotation.y + t * tile.spin.y * spinMul,
      tile.current.rotation.z + t * tile.spin.z * spinMul
    );
    tile.mesh.rotation.copy(tmpEuler);
  }

  // Subtle camera drift around the fixed framing
  camera.position.x = 2.8 + Math.sin(t * 0.12) * 0.35;
  camera.position.y = 1.6 + Math.sin(t * 0.17) * 0.15;
  camera.lookAt(0, 0, 0);

  renderer.render(scene, camera);
}

renderImageList();
renderer.setAnimationLoop(animate);

// Handy for demos / debugging
window.tileField = {
  addFiles,
  setPreset,
  clearAll,
  images,
  tiles,
  minCenterDistance,
  getMinPairDistance() {
    let min = Infinity;
    const d = new THREE.Vector3();
    for (let i = 0; i < tiles.length; i++) {
      for (let j = i + 1; j < tiles.length; j++) {
        d.subVectors(tiles[i].target.position, tiles[j].target.position);
        min = Math.min(min, d.length());
      }
    }
    return min;
  },
};
