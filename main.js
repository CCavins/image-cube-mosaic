import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

const canvas = document.getElementById("scene");
const controlsPanel = document.getElementById("controls-panel");
const panelToggle = document.getElementById("panel-toggle");
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
const showcaseHoldRow = document.getElementById("showcase-hold-row");
const showcaseHoldSlider = document.getElementById("showcase-hold-slider");
const showcaseHoldValueEl = document.getElementById("showcase-hold-value");

const PRESETS = [
  { id: "cluster", label: "Cluster" },
  { id: "orbit", label: "Orbit" },
  { id: "spiral", label: "Spiral" },
  { id: "wave", label: "Wave" },
  { id: "sphere", label: "Sphere" },
  { id: "helix", label: "Helix" },
  { id: "grid", label: "Grid" },
  { id: "scatter", label: "Scatter" },
  { id: "showcase", label: "Showcase" },
  { id: "depth", label: "Depth Field" },
];

// Box face order: +X, -X, +Y, -Y, +Z, -Z
const SIDE_FACES = [0, 1, 4, 5];
const ALL_FACES = [0, 1, 2, 3, 4, 5];

// Local UV basis per face (must match orientCubeFaceUVs): U = right, V = up on face
const FACE_BASIS_LOCAL = [
  { u: new THREE.Vector3(0, 0, -1), v: new THREE.Vector3(0, 1, 0), n: new THREE.Vector3(1, 0, 0) }, // +X
  { u: new THREE.Vector3(0, 0, 1), v: new THREE.Vector3(0, 1, 0), n: new THREE.Vector3(-1, 0, 0) }, // -X
  { u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 0, -1), n: new THREE.Vector3(0, 1, 0) }, // +Y
  { u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 0, 1), n: new THREE.Vector3(0, -1, 0) }, // -Y
  { u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 1, 0), n: new THREE.Vector3(0, 0, 1) }, // +Z
  { u: new THREE.Vector3(-1, 0, 0), v: new THREE.Vector3(0, 1, 0), n: new THREE.Vector3(0, 0, -1) }, // -Z
];

const _faceN = new THREE.Vector3();
const _faceU = new THREE.Vector3();
const _faceV = new THREE.Vector3();
const _desiredUp = new THREE.Vector3();
const _screenUp = new THREE.Vector3();
const _viewDir = new THREE.Vector3();
const _worldPos = new THREE.Vector3();
const _spinAxis = new THREE.Vector3();
const _tmpQuat = new THREE.Quaternion();

const SHOWCASE_MAX_FEATURED = 3;
// Swap motion speeds stay fixed — hold slider only changes time spent presenting
const SHOWCASE_APPROACH_S = 1.35;
const SHOWCASE_RETREAT_S = 1.2;
const SHOWCASE_PRESENT_SCALE = 1.15;
const SHOWCASE_HOLD_MIN_S = 1.5;
const SHOWCASE_HOLD_MAX_S = 12;
// Spaced so featured cubes never overlap at present scale (centers ≥ ~2.1 apart)
const SHOWCASE_PRESENT_SLOTS = [
  new THREE.Vector3(-2.25, 0.3, 5.55),
  new THREE.Vector3(0.0, 0.55, 5.85),
  new THREE.Vector3(2.25, 0.3, 5.55),
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
let showcaseHoldS = 3.5;
let coverageTimer = 0;
let densityApplyTimer = 0;
const PLACEHOLDER_CANVAS = (() => {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 4;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#10131c";
  ctx.fillRect(0, 0, 4, 4);
  return c;
})();

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
orientCubeFaceUVs(geometry);
const cubeColor = new THREE.Color(0x10131c);

/**
 * Rebuild 6 material groups and remap side-face UVs so V follows local +Y
 * (texture "up" ≈ world up when the cube isn't tumbled).
 */
function orientCubeFaceUVs(geom) {
  const pos = geom.attributes.position;
  const uv = geom.attributes.uv;
  if (!pos || !uv) return;

  const vertCount = pos.count;
  const perFace = Math.floor(vertCount / 6);
  if (perFace < 3) return;

  geom.clearGroups();
  for (let face = 0; face < 6; face++) {
    geom.addGroup(face * perFace, perFace, face);
  }

  // Looking from outside: U = right, V = image-up (matches FACE_BASIS_LOCAL)
  const faceAxes = {
    0: { uAxis: "z", uSign: -1, vAxis: "y", vSign: 1 }, // +X
    1: { uAxis: "z", uSign: 1, vAxis: "y", vSign: 1 }, // -X
    2: { uAxis: "x", uSign: 1, vAxis: "z", vSign: -1 }, // +Y
    3: { uAxis: "x", uSign: 1, vAxis: "z", vSign: 1 }, // -Y
    4: { uAxis: "x", uSign: 1, vAxis: "y", vSign: 1 }, // +Z
    5: { uAxis: "x", uSign: -1, vAxis: "y", vSign: 1 }, // -Z
  };

  const axisGetter = {
    x: (i) => pos.getX(i),
    y: (i) => pos.getY(i),
    z: (i) => pos.getZ(i),
  };

  for (const face of ALL_FACES) {
    const axes = faceAxes[face];
    const start = face * perFace;
    const end = start + perFace;
    let uMin = Infinity;
    let uMax = -Infinity;
    let vMin = Infinity;
    let vMax = -Infinity;

    for (let i = start; i < end; i++) {
      const u = axisGetter[axes.uAxis](i) * axes.uSign;
      const v = axisGetter[axes.vAxis](i) * axes.vSign;
      if (u < uMin) uMin = u;
      if (u > uMax) uMax = u;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }

    const uSpan = Math.max(1e-6, uMax - uMin);
    const vSpan = Math.max(1e-6, vMax - vMin);

    for (let i = start; i < end; i++) {
      const u = (axisGetter[axes.uAxis](i) * axes.uSign - uMin) / uSpan;
      const v = (axisGetter[axes.vAxis](i) * axes.vSign - vMin) / vSpan;
      uv.setXY(i, u, v);
    }
  }

  uv.needsUpdate = true;
}

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
const sharedBgMaterial = makeBaseMaterial();
sharedBgMaterial.color.multiplyScalar(0.55);
sharedBgMaterial.envMapIntensity = 0.35;
sharedBgMaterial.roughness = 0.55;
sharedBgMaterial.metalness = 0.7;

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
  if (preset === "depth") {
    separateTargets(
      targets.filter((t) => t.layer === "fg"),
      28
    );
    separateTargets(
      targets.filter((t) => t.layer === "bg"),
      28
    );
    return targets;
  }
  if (preset === "showcase") {
    // Shuffle home slots so tile index isn't tied to a screen region
    for (let i = targets.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = targets[i];
      targets[i] = targets[j];
      targets[j] = tmp;
    }
    separateTargets(targets, 8);
    // Pull anything that separation nudged off-screen back into the view
    for (const t of targets) {
      const { halfW, halfH } = frustumHalfExtentsAtZ(t.position.z, 0.86);
      const pad = boundingRadius(t.scale) * 0.5;
      const maxX = Math.max(0.15, halfW - pad);
      const maxY = Math.max(0.15, halfH - pad);
      t.position.x = THREE.MathUtils.clamp(t.position.x, -maxX, maxX);
      t.position.y = THREE.MathUtils.clamp(t.position.y, -maxY, maxY);
    }
    return targets;
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
	if (uImageMix > 0.001) {
		vec4 sampledDiffuseColor = texture2D( map, vMapUv );
		float imgA = clamp(sampledDiffuseColor.a * uImageMix, 0.0, 1.0);
		diffuseColor = vec4(mix(diffuseColor.rgb, sampledDiffuseColor.rgb, imgA), 1.0);
	}
#endif
`
      );
  };
  mat.customProgramCacheKey = () => "image-over-cube-std-v2";

  return mat;
}

/**
 * Center-cover into a square canvas: portrait scales to width (crop top/bottom),
 * landscape scales to height (crop sides). One clean image per face texture.
 */
function makeCoverSquareCanvas(img, maxSize) {
  const srcW = img.width || 1;
  const srcH = img.height || 1;
  const out = Math.max(1, Math.min(maxSize, Math.max(srcW, srcH)));
  const scale = Math.max(out / srcW, out / srcH);
  const dw = srcW * scale;
  const dh = srcH * scale;
  const canvas = document.createElement("canvas");
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, out, out);
  ctx.drawImage(img, (out - dw) / 2, (out - dh) / 2, dw, dh);
  return canvas;
}

/** One GPU texture per library image — shared across faces; never clone (Source sharing bugs). */
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
  texture.flipY = true;
  image.texture = texture;

  const img = new Image();
  img.onload = () => {
    texture.image = makeCoverSquareCanvas(img, MAX_TEX_SIZE);
    texture.needsUpdate = true;
    // Per-face slot textures share the canvas pixels but keep their own rotation
    for (const tile of tiles) {
      for (let f = 0; f < 6; f++) {
        const slot = tile.faceSlots[f];
        if (slot.imageId === image.id && slot.faceTexture) {
          slot.faceTexture.image = texture.image;
          slot.faceTexture.needsUpdate = true;
          if (slot.material) {
            slot.material.map = slot.faceTexture;
            slot.material.needsUpdate = true;
          }
        }
      }
    }
  };
  img.onerror = () => {
    console.warn("Failed to load texture", image.name);
  };
  img.src = image.url;

  return texture;
}

function disposeImageTexture(image) {
  if (!image?.texture) return;
  for (const tile of tiles) {
    for (const slot of tile.faceSlots) {
      if (slot.imageId === image.id) {
        if (slot.material) slot.material.map = null;
        if (slot.faceTexture) {
          slot.faceTexture.dispose();
          slot.faceTexture = null;
        }
      }
    }
  }
  image.texture.dispose();
  image.texture = null;
}

function setCubeColor(hex) {
  cubeColor.set(hex);
  const label = `#${cubeColor.getHexString()}`;
  cubeColorInput.value = label;
  cubeColorValueEl.textContent = label;

  sharedBaseMaterial.color.copy(cubeColor);
  sharedBgMaterial.color.copy(cubeColor).multiplyScalar(0.55);
  for (const tile of tiles) {
    for (const slot of tile.faceSlots) {
      if (slot.material) {
        slot.material.color.copy(cubeColor);
        if (tile.layer === "bg" && activePreset === "depth") {
          slot.material.color.multiplyScalar(0.65);
          slot.material.envMapIntensity = 0.35;
        } else {
          slot.material.envMapIntensity = 0.65;
        }
      }
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

/** Visible half-width/height at a world Z for the current camera/FOV. */
function frustumHalfExtentsAtZ(z, margin = 0.88) {
  const aspect = Math.max(0.65, Math.min(2.4, window.innerWidth / window.innerHeight));
  // Showcase camera sits at z≈10.5 looking at origin
  const dist = Math.max(3.5, 10.5 - z);
  const halfH = Math.tan((38 * Math.PI) / 360) * dist * margin;
  const halfW = halfH * aspect * margin;
  return { halfW, halfH };
}

/** Idle field for Showcase — pack into the visible window; denser → smaller cubes. */
function buildShowcaseTargets(i, count) {
  // Keep all idle cubes in a shallow band that stays on-screen
  const layers = Math.min(4, Math.max(2, Math.ceil(count / 18)));
  const layer = i % layers;
  const z = 0.6 + layer * 0.85 + (seededNoise(i, 43) - 0.5) * 0.2;
  const { halfW, halfH } = frustumHalfExtentsAtZ(z, 0.86);

  const aspect = halfW / Math.max(1e-6, halfH);
  const cols = Math.max(3, Math.ceil(Math.sqrt(count * aspect)));
  const rows = Math.max(3, Math.ceil(count / cols));

  const col = i % cols;
  const row = Math.floor(i / cols) % rows;
  const u = cols <= 1 ? 0.5 : (col + 0.5) / cols;
  const v = rows <= 1 ? 0.5 : (row + 0.5) / rows;

  // Scale down as density rises so the field still fits the window
  const pack = Math.sqrt(28 / Math.max(8, count));
  const scale = THREE.MathUtils.clamp(0.48 * pack + seededNoise(i, 47) * 0.08, 0.38, 0.85);
  const pad = boundingRadius(scale) * 0.55;
  const maxX = Math.max(0.2, halfW - pad);
  const maxY = Math.max(0.2, halfH - pad);

  let x = (u - 0.5) * 2 * maxX + (seededNoise(i, 41) - 0.5) * 0.25;
  let y = (v - 0.5) * 2 * maxY + (seededNoise(i, 42) - 0.5) * 0.2;
  x = THREE.MathUtils.clamp(x, -maxX, maxX);
  y = THREE.MathUtils.clamp(y, -maxY, maxY);

  return {
    position: new THREE.Vector3(x, y, z),
    rotation: new THREE.Euler(
      (seededNoise(i, 44) - 0.5) * 0.08,
      (seededNoise(i, 45) - 0.5) * 0.35,
      (seededNoise(i, 46) - 0.5) * 0.06
    ),
    scale,
    layer: "bg",
  };
}

/** Two-layer floating grids: ~60% foreground, ~40% soft background. */
function buildDepthTargets(i, count) {
  const fgCount = Math.max(1, Math.ceil(count * 0.6));
  if (i < fgCount) {
    const cols = Math.ceil(Math.sqrt(fgCount * 1.45));
    const rows = Math.ceil(fgCount / cols);
    const col = i % cols;
    const row = Math.floor(i / cols);
    const spacing = minCenterDistance(0.9, 0.9) * 1.08;
    return {
      position: new THREE.Vector3(
        (col - (cols - 1) / 2) * spacing,
        (row - (rows - 1) / 2) * spacing * 0.92,
        2.4 + (seededNoise(i, 50) - 0.5) * 0.85
      ),
      rotation: new THREE.Euler(
        (seededNoise(i, 51) - 0.5) * 0.12,
        (seededNoise(i, 52) - 0.5) * 0.35,
        (seededNoise(i, 53) - 0.5) * 0.08
      ),
      scale: 0.88 + seededNoise(i, 54) * 0.1,
      layer: "fg",
    };
  }

  const bi = i - fgCount;
  const bgCount = Math.max(1, count - fgCount);
  const cols = Math.ceil(Math.sqrt(bgCount * 1.6));
  const rows = Math.ceil(bgCount / cols);
  const col = bi % cols;
  const row = Math.floor(bi / cols);
  const spacing = minCenterDistance(0.55, 0.55) * 1.15;
  return {
    position: new THREE.Vector3(
      (col - (cols - 1) / 2) * spacing * 1.15,
      (row - (rows - 1) / 2) * spacing,
      -3.2 + (seededNoise(i, 55) - 0.5) * 1.2
    ),
    rotation: new THREE.Euler(0, (seededNoise(i, 56) - 0.5) * 0.5, 0),
    scale: 0.48 + seededNoise(i, 57) * 0.12,
    layer: "bg",
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
    case "showcase":
      return buildShowcaseTargets(i, count);
    case "depth":
      return buildDepthTargets(i, count);
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
    faceTexture: null, // per-slot map with upright rotation
    faceTextureImageId: null,
    fade: 0,
    state: "empty", // empty | fadingIn | holding | fadingOut
    holdUntil: 0,
    pendingImage: null,
  }));

  tiles.push({
    mesh,
    index: i,
    active: true,
    layer: target.layer || "fg",
    role: "idle", // showcase: idle | approach | present | retreat
    roleT: 0,
    roleDuration: 1,
    presentSlot: null,
    presentAnchor: new THREE.Vector3(),
    phase: seededNoise(i, 20) * Math.PI * 2,
    spin: new THREE.Vector3(
      (seededNoise(i, 21) - 0.5) * 0.4,
      (seededNoise(i, 22) - 0.5) * 0.55,
      (seededNoise(i, 23) - 0.5) * 0.35
    ),
    home: {
      position: target.position.clone(),
      rotation: target.rotation.clone(),
      scale: target.scale,
    },
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

function emptyFaceMaterial(tile) {
  return tile.layer === "bg" && activePreset === "depth"
    ? sharedBgMaterial
    : sharedBaseMaterial;
}

function applySpinForPreset(tile, preset) {
  if (preset === "showcase") {
    // Only featured cubes spin (Y); idle field stays float-only
    const dir = seededNoise(tile.index, 22) > 0.5 ? 1 : -1;
    tile.spin.set(0, dir * 0.32, 0);
  } else if (preset === "depth") {
    // Y-dominant spin keeps side-face images upright while turning
    const dir = seededNoise(tile.index, 22) > 0.5 ? 1 : -1;
    tile.spin.set(
      (seededNoise(tile.index, 21) - 0.5) * 0.05,
      dir * (0.28 + seededNoise(tile.index, 24) * 0.2),
      (seededNoise(tile.index, 23) - 0.5) * 0.04
    );
  } else {
    tile.spin.set(
      (seededNoise(tile.index, 21) - 0.5) * 0.4,
      (seededNoise(tile.index, 22) - 0.5) * 0.55,
      (seededNoise(tile.index, 23) - 0.5) * 0.35
    );
  }
}

function syncTileLayerMaterials(tile) {
  const emptyMat = emptyFaceMaterial(tile);
  for (let f = 0; f < 6; f++) {
    const slot = tile.faceSlots[f];
    if (slot.state === "empty" || !slot.material) {
      tile.mesh.material[f] = emptyMat;
    } else if (slot.material) {
      if (tile.layer === "bg" && activePreset === "depth") {
        slot.material.color.copy(cubeColor).multiplyScalar(0.65);
        slot.material.envMapIntensity = 0.35;
        slot.material.roughness = 0.5;
      } else {
        slot.material.color.copy(cubeColor);
        slot.material.envMapIntensity = 0.65;
        slot.material.roughness = 0.4;
      }
    }
  }
}

function layoutActiveTiles(preset = activePreset, { snap = false } = {}) {
  const nextTargets = buildAllTargets(preset, activeTileCount);
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    if (i < activeTileCount) {
      const next = nextTargets[i];
      tile.active = true;
      tile.mesh.visible = true;
      tile.layer = next.layer || "fg";
      tile.target.position.copy(next.position);
      tile.target.rotation.copy(next.rotation);
      tile.target.scale = next.scale;
      tile.home.position.copy(next.position);
      tile.home.rotation.copy(next.rotation);
      tile.home.scale = next.scale;
      applySpinForPreset(tile, preset);

      if (preset === "showcase") {
        tile.role = "idle";
        tile.roleT = 0;
        // Randomize readiness so promotions aren't biased by tile index / grid row
        tile.roleDuration = 0.4 + Math.random() * 5.5;
        tile.presentSlot = null;
      } else {
        tile.role = "idle";
        tile.roleT = 0;
        tile.presentSlot = null;
      }

      if (snap) {
        tile.current.position.copy(next.position);
        tile.current.rotation.copy(next.rotation);
        tile.current.scale = next.scale;
        tile.mesh.position.copy(next.position);
        tile.mesh.rotation.copy(next.rotation);
        tile.mesh.scale.setScalar(next.scale);
      }
      syncTileLayerMaterials(tile);
    } else {
      tile.active = false;
      tile.mesh.visible = false;
      tile.role = "idle";
      for (let f = 0; f < 6; f++) clearFaceSlot(tile, f);
    }
  }
}

function setShowcaseHoldSeconds(seconds) {
  showcaseHoldS = Math.max(
    SHOWCASE_HOLD_MIN_S,
    Math.min(SHOWCASE_HOLD_MAX_S, Number(seconds) || 3.5)
  );
  if (showcaseHoldSlider) showcaseHoldSlider.value = String(showcaseHoldS);
  if (showcaseHoldValueEl) {
    showcaseHoldValueEl.textContent = `${showcaseHoldS.toFixed(1)}s`;
  }
  // Remap hold for cubes already presenting — does not change approach/retreat speed
  for (let i = 0; i < activeTileCount; i++) {
    const tile = tiles[i];
    if (tile.role !== "present") continue;
    const remaining = Math.max(0.2, tile.roleDuration - tile.roleT);
    const frac = Math.min(1, remaining / Math.max(0.2, tile.roleDuration));
    tile.roleDuration = showcaseHoldS;
    tile.roleT = showcaseHoldS * (1 - frac);
  }
}

function syncShowcaseHoldVisibility() {
  if (!showcaseHoldRow) return;
  showcaseHoldRow.hidden = activePreset !== "showcase";
}

function setPreset(id) {
  activePreset = id;
  layoutActiveTiles(id, { snap: false });
  [...presetListEl.querySelectorAll(".preset-btn")].forEach((btn) => {
    const on = btn.dataset.preset === id;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  syncShowcaseHoldVisibility();
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
  tile.mesh.material[faceIndex] = emptyFaceMaterial(tile);
  slot.imageId = null;
  slot.fade = 0;
  slot.state = "empty";
  slot.holdUntil = 0;
  slot.pendingImage = null;
}

/**
 * Rotation that makes texture V align with screen-up on this face,
 * given the cube's current world orientation and the browser camera.
 */
function computeUprightTextureRotation(tile, faceIndex) {
  const basis = FACE_BASIS_LOCAL[faceIndex];
  tile.mesh.updateMatrixWorld(true);
  tile.mesh.getWorldQuaternion(_tmpQuat);

  _faceN.copy(basis.n).applyQuaternion(_tmpQuat).normalize();
  _faceU.copy(basis.u).applyQuaternion(_tmpQuat).normalize();
  _faceV.copy(basis.v).applyQuaternion(_tmpQuat).normalize();

  camera.updateMatrixWorld(true);
  _screenUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();

  // Project screen-up onto the face plane → desired image "up"
  _desiredUp.copy(_screenUp).addScaledVector(_faceN, -_screenUp.dot(_faceN));
  if (_desiredUp.lengthSq() < 1e-8) {
    // Looking straight onto top/bottom: aim image up toward top of the window
    // using the camera's view-up via the facing direction
    tile.mesh.getWorldPosition(_worldPos);
    _viewDir.subVectors(camera.position, _worldPos).normalize();
    _desiredUp.crossVectors(_faceN, _viewDir).cross(_faceN);
    if (_desiredUp.lengthSq() < 1e-8) {
      _desiredUp.set(0, 0, -1).applyQuaternion(_tmpQuat);
      _desiredUp.addScaledVector(_faceN, -_desiredUp.dot(_faceN));
    }
  }
  _desiredUp.normalize();

  // Angle of desiredUp relative to current V axis in the face plane
  const cos = THREE.MathUtils.clamp(_desiredUp.dot(_faceV), -1, 1);
  const sin = _desiredUp.dot(_faceU);
  return -Math.atan2(sin, cos);
}

function ensureSlotFaceTexture(slot, image, baseTexture, rotation) {
  // Fresh texture whenever the image changes — avoids Source/GPU stacking glitches
  if (slot.faceTexture && slot.faceTextureImageId !== image.id) {
    slot.faceTexture.dispose();
    slot.faceTexture = null;
  }
  if (!slot.faceTexture) {
    slot.faceTexture = new THREE.Texture();
    slot.faceTexture.colorSpace = THREE.SRGBColorSpace;
    slot.faceTexture.wrapS = THREE.ClampToEdgeWrapping;
    slot.faceTexture.wrapT = THREE.ClampToEdgeWrapping;
    slot.faceTexture.center.set(0.5, 0.5);
    slot.faceTexture.generateMipmaps = true;
    slot.faceTexture.minFilter = THREE.LinearMipmapLinearFilter;
    slot.faceTexture.magFilter = THREE.LinearFilter;
    slot.faceTexture.anisotropy = baseTexture.anisotropy;
    slot.faceTexture.flipY = true;
    slot.faceTextureImageId = image.id;
  }
  slot.faceTexture.image = baseTexture.image || PLACEHOLDER_CANVAS;
  slot.faceTexture.rotation = rotation;
  slot.faceTexture.needsUpdate = true;
  return slot.faceTexture;
}

function applyTextureToSlot(tile, faceIndex, image, { fadeIn = true, holdJitter = true } = {}) {
  const slot = tile.faceSlots[faceIndex];
  const baseTexture = ensureImageTexture(image);
  const rotation = computeUprightTextureRotation(tile, faceIndex);
  const texture = ensureSlotFaceTexture(slot, image, baseTexture, rotation);

  // Reset mix before swapping maps so the previous image never composites over the new one
  if (slot.material?.userData?.imageMix) {
    slot.material.userData.imageMix.value = 0;
  }

  if (!slot.material) {
    slot.material = makeImageMaterial(texture);
  } else {
    slot.material.map = texture;
    slot.material.needsUpdate = true;
  }

  const mat = slot.material;
  if (tile.layer === "bg" && activePreset === "depth") {
    mat.color.copy(cubeColor).multiplyScalar(0.65);
    mat.envMapIntensity = 0.35;
    mat.roughness = 0.5;
  } else {
    mat.color.copy(cubeColor);
    mat.envMapIntensity = 0.65;
    mat.roughness = 0.4;
  }

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

/**
 * Prefer faces that face the camera and stay upright under the cube's spin
 * (e.g. side faces when spinning mostly on Y).
 */
function faceUprightScore(faceIndex, tile) {
  const basis = FACE_BASIS_LOCAL[faceIndex];
  tile.mesh.updateMatrixWorld(true);
  tile.mesh.getWorldQuaternion(_tmpQuat);
  tile.mesh.getWorldPosition(_worldPos);

  _faceN.copy(basis.n).applyQuaternion(_tmpQuat).normalize();
  _faceV.copy(basis.v).applyQuaternion(_tmpQuat).normalize();

  _viewDir.subVectors(camera.position, _worldPos).normalize();
  const facing = Math.max(0, _faceN.dot(_viewDir));

  // Spin axis in world (local spin applied as Euler rates ≈ object axes)
  _spinAxis.set(tile.spin.x, tile.spin.y, tile.spin.z);
  const spinLen = _spinAxis.length();
  let uprightStable = 0.5;
  if (spinLen > 1e-4) {
    _spinAxis.multiplyScalar(1 / spinLen).applyQuaternion(_tmpQuat).normalize();
    // Image stays upright while spinning if V stays aligned with screen-up
    // ≈ spin axis parallel to world/screen up, and V parallel to spin axis
    camera.updateMatrixWorld(true);
    _screenUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    const spinAlongUp = Math.abs(_spinAxis.dot(_screenUp));
    const vAlongSpin = Math.abs(_faceV.dot(_spinAxis));
    uprightStable = spinAlongUp * vAlongSpin;
    // Top/bottom: normal ‖ spin (Y) → in-plane image tumbles; down-weight
    const normalAlongSpin = Math.abs(_faceN.dot(_spinAxis));
    uprightStable *= 1 - normalAlongSpin * 0.85;
  } else if (SIDE_FACES.includes(faceIndex)) {
    uprightStable = 0.9;
  }

  let score = facing * 10 + uprightStable * 12;
  if (tile.role === "present" || tile.role === "approach") score += 4;
  if (tile.layer === "fg") score += 2;
  if (tile.layer === "bg" && activePreset === "depth") score -= 1;
  score += tile.current.position.z * 0.25;
  return score;
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
            slot.pendingImage = images.length
              ? pickImageForTile(tile, { excludeFace: f, alsoExcludeId: imageId })
              : null;
          } else {
            clearFaceSlot(tile, f);
          }
        }
      }
    }
  }
}

/** Image ids currently on a cube (shown or pending), optionally ignoring one face. */
function imagesOnTile(tile, excludeFace = -1) {
  const ids = new Set();
  for (let f = 0; f < 6; f++) {
    if (f === excludeFace) continue;
    const slot = tile.faceSlots[f];
    if (slot.imageId != null) ids.add(slot.imageId);
    if (slot.pendingImage?.id != null) ids.add(slot.pendingImage.id);
  }
  return ids;
}

/** Global usage counts across active faces (shown + pending). */
function countImageUsage() {
  const counts = new Map();
  for (const img of images) counts.set(img.id, 0);
  for (let i = 0; i < activeTileCount; i++) {
    const tile = tiles[i];
    for (let f = 0; f < 6; f++) {
      const slot = tile.faceSlots[f];
      if (slot.imageId != null && counts.has(slot.imageId)) {
        counts.set(slot.imageId, counts.get(slot.imageId) + 1);
      }
      if (slot.pendingImage?.id != null && counts.has(slot.pendingImage.id)) {
        counts.set(
          slot.pendingImage.id,
          counts.get(slot.pendingImage.id) + 1
        );
      }
    }
  }
  return counts;
}

/**
 * Pick an image for a face: avoid other faces on the same cube when possible,
 * and prefer globally underused library images.
 * Pass a mutable `usage` map when filling many faces in one batch.
 */
function pickImageForTile(
  tile,
  { excludeFace = -1, alsoExcludeId = null, usage = null } = {}
) {
  if (images.length === 0) return null;
  if (images.length === 1) return images[0];

  const onTile = imagesOnTile(tile, excludeFace);
  if (alsoExcludeId != null) onTile.add(alsoExcludeId);

  const counts = usage ?? countImageUsage();
  let candidates = images.filter((img) => !onTile.has(img.id));

  // Last resort if the library is smaller than faces on the cube
  if (candidates.length === 0) {
    candidates = images.filter((img) => img.id !== alsoExcludeId);
    if (candidates.length === 0) candidates = [...images];
  }

  let best = candidates[0];
  let bestScore = Infinity;
  for (const img of candidates) {
    const used = counts.get(img.id) ?? 0;
    const score = used + Math.random() * 0.35;
    if (score < bestScore) {
      bestScore = score;
      best = img;
    }
  }
  counts.set(best.id, (counts.get(best.id) ?? 0) + 1);
  return best;
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

/** Keep most faces imaged; prefer camera-facing / upright-stable faces first. */
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
    .sort((a, b) => {
      const scoreDiff =
        faceUprightScore(b.face, b.tile) - faceUprightScore(a.face, a.tile);
      return scoreDiff + (Math.random() - 0.5) * 0.35;
    });

  const usage = countImageUsage();
  const fillCount = Math.min(need, empties.length);
  for (let i = 0; i < fillCount; i++) {
    const { tile, face } = empties[i];
    const image = pickImageForTile(tile, { excludeFace: face, usage });
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
            slot.pendingImage = pickImageForTile(tile, {
              excludeFace: f,
              alsoExcludeId: slot.imageId,
            });
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
            next = images.length
              ? pickImageForTile(tile, {
                  excludeFace: f,
                  alsoExcludeId: slot.imageId,
                })
              : null;
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

function assignShowcasePresentAnchor(tile, slotIndex) {
  const slot = SHOWCASE_PRESENT_SLOTS[slotIndex % SHOWCASE_PRESENT_SLOTS.length];
  // Tiny jitter only — keep clear gaps between the three foreground slots
  tile.presentAnchor.set(
    slot.x + (seededNoise(tile.index, 70) - 0.5) * 0.08,
    slot.y + (seededNoise(tile.index, 71) - 0.5) * 0.06,
    slot.z + (seededNoise(tile.index, 72) - 0.5) * 0.06
  );
}

function pickRandomShowcaseCandidate(ready) {
  if (ready.length === 0) return null;
  const idx = Math.floor(Math.random() * ready.length);
  return ready[idx];
}

function beginShowcaseApproach(tile, slotIndex) {
  tile.role = "approach";
  tile.roleT = 0;
  tile.roleDuration = SHOWCASE_APPROACH_S;
  tile.presentSlot = slotIndex;
  assignShowcasePresentAnchor(tile, slotIndex);
}

function beginShowcaseRetreat(tile) {
  tile.role = "retreat";
  tile.roleT = 0;
  tile.roleDuration = SHOWCASE_RETREAT_S;
}

/**
 * Showcase choreography:
 * - Up to 3 cubes hold in spaced foreground slots
 * - Hold slider = how long they stay (not swap motion speed)
 * - Only one approach OR retreat runs at a time
 */
function updateShowcase(dt, t) {
  const usedSlots = new Set();
  const readyIdle = [];
  const presenting = [];
  let approaching = null;
  let retreating = null;

  for (let i = 0; i < activeTileCount; i++) {
    const tile = tiles[i];
    tile.roleT += dt;

    if (tile.role === "approach") approaching = tile;
    else if (tile.role === "retreat") retreating = tile;
    else if (tile.role === "present") {
      presenting.push(tile);
      if (tile.presentSlot != null) usedSlots.add(tile.presentSlot);
    } else if (tile.role === "idle" && tile.roleT >= tile.roleDuration) {
      readyIdle.push(tile);
    }

    if (tile.presentSlot != null && tile.role !== "idle") {
      usedSlots.add(tile.presentSlot);
    }
  }

  const transitioning = !!(approaching || retreating);

  // Finish approach → present (hold duration from slider only)
  if (approaching && approaching.roleT >= approaching.roleDuration) {
    approaching.role = "present";
    approaching.roleT = 0;
    approaching.roleDuration = showcaseHoldS;
    presenting.push(approaching);
    approaching = null;
  }

  // Finish retreat → idle
  if (retreating && retreating.roleT >= retreating.roleDuration) {
    retreating.role = "idle";
    retreating.roleT = 0;
    retreating.roleDuration = 1.2 + Math.random() * 4.5;
    retreating.presentSlot = null;
    retreating = null;
  }

  // Only one swap motion at a time. Fill empty foreground slots first, then rotate out.
  if (!approaching && !retreating) {
    const expired = presenting
      .filter((tile) => tile.roleT >= tile.roleDuration)
      .sort((a, b) => b.roleT - a.roleT);

    if (presenting.length < SHOWCASE_MAX_FEATURED) {
      const tile = pickRandomShowcaseCandidate(readyIdle);
      if (tile) {
        let slotIndex = 0;
        while (usedSlots.has(slotIndex) && slotIndex < SHOWCASE_MAX_FEATURED) {
          slotIndex++;
        }
        if (slotIndex < SHOWCASE_MAX_FEATURED) {
          beginShowcaseApproach(tile, slotIndex);
        }
      }
    } else if (expired.length > 0) {
      beginShowcaseRetreat(expired[0]);
    }
  }

  for (let i = 0; i < activeTileCount; i++) {
    const tile = tiles[i];

    if (tile.role === "idle") {
      tile.target.position.copy(tile.home.position);
      tile.target.rotation.copy(tile.home.rotation);
      tile.target.scale = tile.home.scale;
      continue;
    }

    if (tile.role === "approach") {
      const u = smoothstep(Math.min(1, tile.roleT / SHOWCASE_APPROACH_S));
      tile.target.position.lerpVectors(tile.home.position, tile.presentAnchor, u);
      tile.target.scale = THREE.MathUtils.lerp(
        tile.home.scale,
        SHOWCASE_PRESENT_SCALE,
        u
      );
      tile.target.rotation.set(
        THREE.MathUtils.lerp(tile.home.rotation.x, 0.04, u),
        THREE.MathUtils.lerp(tile.home.rotation.y, 0, u),
        THREE.MathUtils.lerp(tile.home.rotation.z, 0, u)
      );
      continue;
    }

    if (tile.role === "present") {
      // Subtle bob only — keep clear of neighboring foreground slots
      tile.target.position.set(
        tile.presentAnchor.x + Math.sin(t * 0.7 + tile.phase) * 0.03,
        tile.presentAnchor.y + Math.cos(t * 0.55 + tile.phase) * 0.04,
        tile.presentAnchor.z
      );
      tile.target.scale = SHOWCASE_PRESENT_SCALE;
      tile.target.rotation.set(0.04, 0, 0);
      continue;
    }

    if (tile.role === "retreat") {
      const u = smoothstep(Math.min(1, tile.roleT / SHOWCASE_RETREAT_S));
      tile.target.position.lerpVectors(tile.presentAnchor, tile.home.position, u);
      tile.target.scale = THREE.MathUtils.lerp(
        SHOWCASE_PRESENT_SCALE,
        tile.home.scale,
        u
      );
      tile.target.rotation.x = THREE.MathUtils.lerp(0.04, tile.home.rotation.x, u);
      tile.target.rotation.y = THREE.MathUtils.lerp(0, tile.home.rotation.y, u);
      tile.target.rotation.z = THREE.MathUtils.lerp(0, tile.home.rotation.z, u);
    }
  }
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
function setPanelCollapsed(collapsed) {
  controlsPanel.classList.toggle("collapsed", collapsed);
  panelToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  panelToggle.title = collapsed ? "Expand panel" : "Collapse panel";
}

panelToggle.addEventListener("click", () => {
  setPanelCollapsed(!controlsPanel.classList.contains("collapsed"));
});

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

if (showcaseHoldSlider) {
  showcaseHoldSlider.min = String(SHOWCASE_HOLD_MIN_S);
  showcaseHoldSlider.max = String(SHOWCASE_HOLD_MAX_S);
  showcaseHoldSlider.step = "0.5";
  showcaseHoldSlider.addEventListener("input", () => {
    setShowcaseHoldSeconds(Number(showcaseHoldSlider.value));
  });
  setShowcaseHoldSeconds(Number(showcaseHoldSlider.value) || showcaseHoldS);
}
syncShowcaseHoldVisibility();

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
    if (activePreset === "showcase") {
      layoutActiveTiles("showcase", { snap: false });
    }
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

  if (activePreset === "showcase") {
    updateShowcase(dt, t);
  }

  // Global group motion varies by preset
  const breathe = Math.sin(t * 0.35) * 0.04;
  if (activePreset === "showcase") {
    // No group spiral — field stays screen-filling; only individual float
    root.rotation.set(0, 0, 0);
    root.position.set(0, 0, 0);
  } else if (activePreset === "depth") {
    root.rotation.y = Math.sin(t * 0.12) * 0.1;
    root.rotation.x = Math.sin(t * 0.16) * 0.05 + breathe * 0.6;
    root.position.y = Math.sin(t * 0.35) * 0.1;
  } else {
    root.rotation.y =
      t *
      (activePreset === "orbit" ? 0.22 : activePreset === "cluster" ? 0.12 : 0.08);
    root.rotation.x = Math.sin(t * 0.18) * 0.08 + breathe;
    root.position.y = Math.sin(t * 0.4) * 0.12;
  }

  wobbleScale =
    activePreset === "scatter"
      ? 0.7
      : activePreset === "wave" || activePreset === "depth"
        ? 0.55
        : activePreset === "showcase"
          ? 1.15
          : activePreset === "cluster"
            ? 0.25
            : 0.4;

  const settle = 1 - Math.exp(-dt * 2.4);
  const baseSpinMul =
    activePreset === "grid" ? 0.15 : activePreset === "depth" ? 0.45 : 1;

  for (let i = 0; i < activeTileCount; i++) {
    const tile = tiles[i];

    tile.current.position.lerp(tile.target.position, settle);
    tile.current.scale += (tile.target.scale - tile.current.scale) * settle;

    tile.current.rotation.x += (tile.target.rotation.x - tile.current.rotation.x) * settle;
    tile.current.rotation.y += (tile.target.rotation.y - tile.current.rotation.y) * settle;
    tile.current.rotation.z += (tile.target.rotation.z - tile.current.rotation.z) * settle;

    let localWobble = wobbleScale;
    if (activePreset === "depth" && tile.layer === "fg") localWobble = 0.7;
    if (activePreset === "depth" && tile.layer === "bg") localWobble = 0.35;
    if (activePreset === "showcase" && tile.role === "present") localWobble = 0.25;
    if (activePreset === "showcase" && tile.role === "idle") localWobble = 1.35;
    if (
      activePreset === "showcase" &&
      (tile.role === "approach" || tile.role === "retreat")
    ) {
      localWobble = 0.45;
    }

    const ox = Math.sin(t * 0.7 + tile.phase) * 0.02 * localWobble;
    const oy = Math.cos(t * 0.55 + tile.phase * 1.3) * 0.025 * localWobble;
    const oz = Math.sin(t * 0.4 + tile.phase * 0.7) * 0.015 * localWobble;

    tile.mesh.position.set(
      tile.current.position.x + ox,
      tile.current.position.y + oy,
      tile.current.position.z + oz
    );
    tile.mesh.scale.setScalar(tile.current.scale);

    let spinMul = baseSpinMul;
    if (activePreset === "showcase") {
      // Background floats only; spin while showcased in center FOV
      spinMul = tile.role === "present" ? 1.05 : 0;
    }

    if (spinMul === 0 && activePreset === "showcase") {
      tile.mesh.rotation.copy(tile.current.rotation);
    } else {
      tmpEuler.set(
        tile.current.rotation.x + t * tile.spin.x * spinMul,
        tile.current.rotation.y + t * tile.spin.y * spinMul,
        tile.current.rotation.z + t * tile.spin.z * spinMul
      );
      tile.mesh.rotation.copy(tmpEuler);
    }
  }

  // Subtle camera drift around the fixed framing ( steadier for Showcase )
  if (activePreset === "showcase") {
    camera.position.x = 0.15 + Math.sin(t * 0.08) * 0.12;
    camera.position.y = 0.35 + Math.sin(t * 0.11) * 0.08;
    camera.position.z = 10.5;
  } else {
    camera.position.x = 2.8 + Math.sin(t * 0.12) * 0.35;
    camera.position.y = 1.6 + Math.sin(t * 0.17) * 0.15;
  }
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
