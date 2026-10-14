// The hill on /demo. Every boulder is a real job: nothing moves unless /demo/stats says something
// happened. The page calls window.relayqHill.ingest(stats) once a second.
// Assets: Poly Haven rock_07, rocky_terrain_02 and kloofendal_48d_partly_cloudy_puresky (CC0);
// Soldier.glb from the three.js examples (Mixamo character and animations).
/* global window, document, console, matchMedia, getComputedStyle, addEventListener, performance, requestAnimationFrame, IntersectionObserver, ResizeObserver */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { createSound } from "./sound.js?v=1";

const $ = (id) => document.getElementById(id);
const host = $("scene"), canvas = $("gl"), hint = $("hint");
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const darkMQ = matchMedia("(prefers-color-scheme: dark)");
const sfx = createSound();
const BASE = "/demo/assets/";
const { smoothstep: S, clamp } = THREE.MathUtils;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0), XAX = V(1, 0, 0);

// ---- World, in metres. Boulders land on the Postgres slab, roll into the hollow at the foot of the
// hill and wait. A worker pushes one up its lane from X0 to X1, across the plateau past the flag,
// and over the far edge at X2. A slip sends it rolling back into the hollow.
const X0 = 0, X1 = 12, X2 = 17.5, H = 6, R = 0.8, G = 9.8;
const LANES = [-7.5, -4.5, -1.5, 1.5, 4.5, 7.5];
const FLAG_X = 15, START_X = -0.6, VIS = 16, MAX_PENDING = 24;
const SLAB = { x: -8.5, len: 4.4, wid: 4.6, tilt: 0.2, lift: 1.1 };

function profile(x) {
  if (x <= X0) return 0.07 * Math.min(-x, 10); // the meadow drains gently toward the foot of the hill
  if (x <= X1) return H * S(x, X0, X1);
  if (x <= X2) return H;
  return H - H * 0.75 * S(x, X2, X2 + 10);
}
// The hill is a ridge across the lanes. In front it falls away so the camera sees its profile;
// behind it, rolling country, and far off, mountains.
function ground(x, z) {
  const ridge = 1 - S(z, 10, 17), back = S(-z, 12, 30), front = S(z, 14, 26), far = S(Math.hypot(x - 4, z), 70, 260);
  const hills = Math.sin(x * 0.09 + z * 0.06) * 2.4 + Math.sin(x * 0.21 - z * 0.17) * 1.2 + Math.sin(z * 0.29 + 1.3) * 0.7;
  const peaks = Math.sin(x * 0.013 + 1.1) * Math.sin(z * 0.017 - 0.4) * 30 + Math.sin(x * 0.031 - z * 0.027) * 9;
  const rough = Math.sin(x * 1.9) * Math.sin(z * 1.6) * 0.04 + Math.sin(x * 0.7 + z * 0.9) * Math.sin(z * 0.6 - x * 0.4) * 0.08;
  return profile(x) * ridge + back * (hills + 3.5) + front * Math.sin(x * 0.23 + 0.7) * Math.sin(z * 0.31) * 0.5 + far * (peaks + 12) + rough;
}
const SLAB_TOP = profile(SLAB.x) + SLAB.lift, SLAB_TAN = Math.tan(SLAB.tilt);
function slabTop(x, z) {
  const dx = x - SLAB.x;
  return Math.abs(dx) > SLAB.len / 2 || Math.abs(z) > SLAB.wid / 2 ? -Infinity : SLAB_TOP - dx * SLAB_TAN;
}
const floorAt = (x, z) => Math.max(ground(x, z), slabTop(x, z));
function grad(x, z) {
  const e = 0.05;
  const gx = (floorAt(x + e, z) - floorAt(x - e, z)) / (2 * e), gz = (floorAt(x, z + e) - floorAt(x, z - e)) / (2 * e);
  const m = Math.hypot(gx, gz);
  return m > 1.5 ? [(gx * 1.5) / m, (gz * 1.5) / m] : [gx, gz]; // the slab's edge is a cliff, not a slope
}
// How worn the ground is: the lanes up the hill and the hollow where boulders wait.
function wear(x, z) {
  let lane = 0;
  for (const l of LANES) lane = Math.max(lane, 1 - S(Math.abs(z - l), 0.35, 1.0));
  lane *= S(x, -2, 0) * (1 - S(x, X2 + 2, X2 + 6));
  const hollow = 1 - S(Math.hypot((x + 4) / 1.6, z / 1.3), 2.5, 6.5);
  return Math.max(lane, hollow * 0.7);
}
// three's ACES filmic curve, so the fog can be set to exactly the sky's colour at the horizon.
function aces(c, exposure) {
  const k = exposure / 0.6, r = c.r * k, g = c.g * k, b = c.b * k;
  const f = (v) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
  const x = f(0.59719 * r + 0.35458 * g + 0.04823 * b), y = f(0.076 * r + 0.90834 * g + 0.01566 * b), z = f(0.0284 * r + 0.13383 * g + 0.83777 * b);
  return new THREE.Color(clamp(1.60475 * x - 0.53108 * y - 0.07367 * z, 0, 1), clamp(-0.10208 * x + 1.10813 * y - 0.00605 * z, 0, 1), clamp(-0.00327 * x - 0.07276 * y + 1.07602 * z, 0, 1));
}
function rng(seed) { return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function fail(msg) {
  canvas.remove();
  const d = document.createElement("div");
  d.className = "nogl";
  d.textContent = msg;
  host.appendChild(d);
  if (hint) hint.remove();
}

let gl;
try {
  gl = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
} catch {
  fail("Your browser couldn't start 3D here. The short version: each job lands in Postgres, waits in line, and a worker pushes it up the hill. If it slips, it rolls back and gets pushed again. The numbers below are live either way.");
}
if (gl) start().catch((e) => {
  console.error(e);
  fail("The hill didn't load this time. The numbers below are live either way.");
});

async function start() {
  const small = host.clientWidth < 700;
  gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  gl.toneMapping = THREE.ACESFilmicToneMapping;
  gl.shadowMap.enabled = true;
  gl.shadowMap.type = THREE.PCFSoftShadowMap;

  const manager = new THREE.LoadingManager();
  manager.onProgress = (_url, done, total) => { if (hint) hint.textContent = `Loading the hill, ${done} of ${total} files`; };
  const texLoader = new THREE.TextureLoader(manager), gltfLoader = new GLTFLoader(manager);
  const [sky, rockGltf, soldier, tDiff, tNor, tRough] = await Promise.all([
    new RGBELoader(manager).setDataType(THREE.FloatType).loadAsync(BASE + "sky_1k.hdr"),
    gltfLoader.loadAsync(BASE + "rock/rock_07_1k.gltf"),
    gltfLoader.loadAsync(BASE + "Soldier.glb"),
    texLoader.loadAsync(BASE + "terrain_rocky_terrain_02_diff_1k.jpg"),
    texLoader.loadAsync(BASE + "terrain_rocky_terrain_02_nor_gl_1k.jpg"),
    texLoader.loadAsync(BASE + "terrain_rocky_terrain_02_rough_1k.jpg"),
  ]);

  // ---- Sky. Spin the HDRI so its sun sits to the left of the hill, then put the shadow-casting sun
  // exactly there. The sun's hot spot is clipped out of the sky used for ambient light, so shaded
  // sides stay shaded instead of being lit a second time by the sky.
  const scene = new THREE.Scene();
  const { data, width: W, height: HH } = sky.image;
  let sunI = 0, sunL = 0;
  for (let i = 0; i < W * HH; i++) { const l = data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]; if (l > sunL) { sunL = l; sunI = i; } }
  const sunRow = Math.floor(sunI / W), sunCol = sunI % W, want = Math.atan2(-0.25, -0.85);
  const shift = (((Math.round(((want / (2 * Math.PI) + 0.5) * W - 0.5 - sunCol)) % W) + W) % W);
  const copy = data.slice();
  for (let r = 0; r < HH; r++) for (let c = 0; c < W; c++) {
    const from = (r * W + c) * 4, to = (r * W + ((c + shift) % W)) * 4;
    let k = 1; const l = (copy[from] + copy[from + 1] + copy[from + 2]) / 3;
    if (l > 6) k = 6 / l;
    data[to] = copy[from] * k; data[to + 1] = copy[from + 1] * k; data[to + 2] = copy[from + 2] * k;
  }
  sky.needsUpdate = true;
  const sunEl = Math.max(0.42, (0.5 - (sunRow + 0.5) / HH) * Math.PI);
  const sunDir = V(Math.cos(want) * Math.cos(sunEl), Math.sin(sunEl), Math.sin(want) * Math.cos(sunEl));
  const horizon = new THREE.Color(0, 0, 0);
  { let n = 0; for (let r = Math.floor(HH * 0.478); r < Math.floor(HH * 0.497); r++) for (let c = 0; c < W; c++) { const i = (r * W + c) * 4; horizon.r += data[i]; horizon.g += data[i + 1]; horizon.b += data[i + 2]; n++; } horizon.multiplyScalar(1 / n); }

  sky.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = sky;
  const pmrem = new THREE.PMREMGenerator(gl);
  scene.environment = pmrem.fromEquirectangular(sky).texture;
  scene.fog = new THREE.FogExp2(0xffffff, 0.003);

  const sun = new THREE.DirectionalLight(0xfff1de, 3.2);
  sun.target.position.set(3, 2, 1);
  sun.position.copy(sun.target.position).addScaledVector(sunDir, 70);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 26, bottom: -26, near: 20, far: 130 });
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  // ---- Terrain: a detailed patch where things happen, a coarse one out to the mountains. UVs are in
  // world units so the scanned ground texture has the same scale on both; worn ground is browner.
  for (const t of [tDiff, tNor, tRough]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = gl.capabilities.getMaxAnisotropy(); }
  tDiff.colorSpace = THREE.SRGBColorSpace;
  const groundMat = new THREE.MeshStandardMaterial({ map: tDiff, normalMap: tNor, roughnessMap: tRough, normalScale: new THREE.Vector2(1.2, 1.2), vertexColors: true });
  const NEAR = { x0: -34, x1: 46, z0: -30, z1: 26 };
  const inNear = (x, z) => x > NEAR.x0 + 1 && x < NEAR.x1 - 1 && z > NEAR.z0 + 1 && z < NEAR.z1 - 1;
  function terrain(w, d, cx, cz, step, sink) {
    const g = new THREE.PlaneGeometry(w, d, Math.round(w / step), Math.round(d / step));
    g.rotateX(-Math.PI / 2); g.translate(cx, 0, cz);
    const p = g.attributes.position, uv = g.attributes.uv, col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i), wr = wear(x, z) * 0.75;
      p.setY(i, ground(x, z) - (sink && inNear(x, z) ? 0.8 : 0));
      uv.setXY(i, x / 6, z / 6);
      col[i * 3] = 1 - wr * 0.05; col[i * 3 + 1] = 1 - wr * 0.2; col[i * 3 + 2] = 1 - wr * 0.38;
    }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, groundMat);
    m.receiveShadow = true;
    scene.add(m);
  }
  terrain(NEAR.x1 - NEAR.x0, NEAR.z1 - NEAR.z0, (NEAR.x0 + NEAR.x1) / 2, (NEAR.z0 + NEAR.z1) / 2, small ? 0.4 : 0.25, false);
  terrain(1000, 1000, 4, 0, 6, true);

  // ---- Grass: tufts of blades that sway in the wind. Short and sparse where the ground is worn.
  const grass = (() => {
    const ys = [0, 0.35, 0.7, 1], ws = [0.5, 0.4, 0.24], pos = [], idx = [];
    for (let k = 0; k < 3; k++) pos.push(-ws[k] / 2, ys[k], 0.25 * ys[k] ** 2, ws[k] / 2, ys[k], 0.25 * ys[k] ** 2);
    pos.push(0, 1, 0.25);
    for (const [a, b, c] of [[0, 1, 2], [1, 3, 2], [2, 3, 4], [3, 5, 4], [4, 5, 6]]) idx.push(a, b, c, a, c, b); // both sides
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(Array.from({ length: 7 }, () => [0, 1, 0]).flat(), 3));
    g.setIndex(idx);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.9 });
    const uTime = { value: 0 };
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = uTime;
      sh.vertexShader = "uniform float uTime;\nvarying float vH;\n" + sh.vertexShader
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvH = position.y;")
        .replace("#include <project_vertex>", [
          "vec4 mvPosition = vec4( transformed, 1.0 );",
          "#ifdef USE_INSTANCING",
          "mvPosition = instanceMatrix * mvPosition;",
          "#endif",
          "float ph = mvPosition.x * 0.31 + mvPosition.z * 0.23;",
          "float gust = 0.5 + 0.5 * sin( uTime * 0.7 + mvPosition.x * 0.06 - mvPosition.z * 0.03 );",
          "vec2 wind = vec2( sin( uTime * 1.9 + ph ) * 0.5 + gust * 1.1, cos( uTime * 1.4 + ph * 1.7 ) * 0.3 );",
          "mvPosition.xz += wind * 0.13 * vH * vH;",
          "mvPosition.y -= dot( wind, wind ) * 0.02 * vH * vH;",
          "mvPosition = modelViewMatrix * mvPosition;",
          "gl_Position = projectionMatrix * mvPosition;",
        ].join("\n"));
      sh.fragmentShader = "varying float vH;\n" + sh.fragmentShader
        .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.rgb *= mix( 0.3, 1.0, vH );");
    };
    const N = small ? 30000 : 72000, mesh = new THREE.InstancedMesh(g, mat, N), r = rng(7);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = V(), at = V(), c = new THREE.Color();
    const palette = [new THREE.Color(0.06, 0.1, 0.02), new THREE.Color(0.1, 0.14, 0.03), new THREE.Color(0.16, 0.16, 0.05), new THREE.Color(0.12, 0.13, 0.035)];
    let n = 0;
    while (n < N) {
      const cx = -20 + r() * 50, cz = -16 + r() * 40;
      if (slabTop(cx, cz) > -Infinity) continue;
      const wr = wear(cx, cz), tall = (0.18 + r() * 0.42) * (1 - wr * 0.85), base = palette[Math.floor(r() * palette.length)];
      if (wr > 0.6 && r() < 0.6) continue;
      for (let k = 0; k < 9 && n < N; k++, n++) {
        const x = cx + (r() - 0.5) * 0.45, z = cz + (r() - 0.5) * 0.45;
        at.set(x, ground(x, z) - 0.02, z);
        q.setFromAxisAngle(UP, r() * Math.PI * 2);
        const s = 0.06 + r() * 0.04;
        sc.set(s, tall * (0.6 + r() * 0.5), s);
        mesh.setMatrixAt(n, m4.compose(at, q, sc));
        mesh.setColorAt(n, c.copy(base).multiplyScalar(0.85 + r() * 0.3));
      }
    }
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    scene.add(mesh);
    return { mesh, uTime, N };
  })();

  // ---- The scanned rock, centred and evened out from a tall shard into a boulder of radius R.
  let rockMesh;
  rockGltf.scene.traverse((o) => { if (o.isMesh && !rockMesh) rockMesh = o; });
  const rockGeo = rockMesh.geometry.clone();
  rockGeo.computeBoundingBox();
  { const bb = rockGeo.boundingBox, size = bb.getSize(V()), mid = bb.getCenter(V()); rockGeo.translate(-mid.x, -mid.y, -mid.z); rockGeo.scale((2 * R) / size.x, (2 * R) / size.y, (2 * R) / size.z); }
  const rockMat = rockMesh.material;
  // The scan reads wet in full sun: keep it matte, and a touch greyer so the amber retry tint stands out.
  const matte = (m) => { m.envMapIntensity = 0.6; m.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = max( roughnessFactor, 0.8 );"); }; return m; };
  matte(rockMat).color.setRGB(0.9, 0.93, 1);
  // A few hundred surface points, used to find which part of a tumbling rock touches the ground.
  const hull = [];
  { const p = rockGeo.attributes.position, step = Math.max(1, Math.floor(p.count / 300)); for (let i = 0; i < p.count; i += step) hull.push(p.getX(i), p.getY(i), p.getZ(i)); }

  // Outcrops on the hillsides and loose stones in the grass, so the hill isn't a lawn.
  {
    const r = rng(3), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const big = [[3.5, -10.8], [8.5, -11.5], [12, -10.6], [-12.5, -7], [-15, 7.5], [21, 9], [22, -6], [-3, -12.5]];
    const outcrops = new THREE.InstancedMesh(rockGeo, rockMat, big.length);
    big.forEach(([x, z], i) => {
      const s = 0.9 + r() * 1.1;
      e.set(r() * 6, r() * 6, r() * 6);
      outcrops.setMatrixAt(i, m4.compose(V(x, ground(x, z) + R * s * 0.25, z), q.setFromEuler(e), V(s * (0.9 + r() * 0.5), s * (0.6 + r() * 0.3), s * (0.9 + r() * 0.5))));
    });
    outcrops.castShadow = outcrops.receiveShadow = true;
    const pebbleGeo = new THREE.SphereGeometry(1, 18, 12); // bumps depend on position only, so the seam stays closed
    { const p = pebbleGeo.attributes.position; for (let i = 0; i < p.count; i++) { const k = 0.8 + 0.35 * (0.5 + 0.5 * Math.sin(p.getX(i) * 12.9 + p.getY(i) * 78.2 + p.getZ(i) * 37.7)); p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.7, p.getZ(i) * k); } pebbleGeo.computeVertexNormals(); }
    const pebbles = new THREE.InstancedMesh(pebbleGeo, new THREE.MeshStandardMaterial({ map: rockMat.map, normalMap: rockMat.normalMap, roughness: 0.9, color: 0xb5ada3 }), 70);
    for (let i = 0; i < 70; i++) {
      let x, z;
      do { x = -18 + r() * 44; z = -14 + r() * 30; } while (wear(x, z) > 0.3 || slabTop(x, z) > -Infinity);
      const s = 0.08 + r() ** 2 * 0.3;
      pebbles.setMatrixAt(i, m4.compose(V(x, ground(x, z) + s * 0.2, z), q.setFromAxisAngle(UP, r() * 6), V(s, s, s)));
    }
    pebbles.receiveShadow = true;
    scene.add(outcrops, pebbles);
  }

  // Postgres: a tilted slab of stone. Boulders land on it and roll off into the hollow.
  const slabTex = (t) => { const c = t.clone(); c.repeat.set(1.2, 1.2); c.needsUpdate = true; return c; };
  const slab = new THREE.Mesh(new THREE.BoxGeometry(SLAB.len, 2.4, SLAB.wid), new THREE.MeshStandardMaterial({ map: slabTex(tDiff), normalMap: slabTex(tNor), color: 0x8f8a82, roughness: 0.95 }));
  slab.rotation.z = -SLAB.tilt;
  slab.position.set(SLAB.x - Math.sin(SLAB.tilt) * 1.2, SLAB_TOP - Math.cos(SLAB.tilt) * 1.2, 0);
  slab.castShadow = slab.receiveShadow = true;
  scene.add(slab);

  // The webhook: a flag on the plateau. The cloth ripples, harder when a job lands.
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 4.2, 12), new THREE.MeshStandardMaterial({ color: 0x3a342e, roughness: 0.6, metalness: 0.3 }));
  pole.position.set(FLAG_X, H + 2.05, 0);
  pole.castShadow = true;
  const flagGeo = new THREE.PlaneGeometry(2.0, 1.25, 24, 10);
  flagGeo.translate(1.0, 0, 0);
  const flagX = Array.from({ length: flagGeo.attributes.position.count }, (_, i) => flagGeo.attributes.position.getX(i));
  const flagMat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.85, emissive: new THREE.Color() });
  flagMat.userData.glow = "accent";
  const flag = new THREE.Mesh(flagGeo, flagMat);
  flag.position.set(FLAG_X + 0.05, H + 3.5, 0);
  flag.castShadow = true;
  scene.add(pole, flag);

  // Dust: soft sprites for landings, slips and fast rolling.
  const dustTex = (() => {
    const c = document.createElement("canvas"); c.width = c.height = 64;
    const g = c.getContext("2d"), r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, "rgba(255,255,255,0.8)"); r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r; g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();
  const dust = Array.from({ length: 64 }, () => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: dustTex, color: 0xa89478, transparent: true, opacity: 0, depthWrite: false }));
    s.userData = { life: 0, v: V(), a: 0.4, size: 1 };
    scene.add(s);
    return s;
  });
  let dustI = 0;
  function puff(x, y, z, n, strength = 1, size = 1) {
    for (let k = 0; k < n; k++) {
      const s = dust[dustI++ % dust.length], u = s.userData;
      s.position.set(x + (Math.random() - 0.5) * 1.2 * size, y + 0.15 * size, z + (Math.random() - 0.5) * 1.2 * size);
      u.life = 1; u.a = Math.min(0.55, 0.18 + strength * 0.06); u.size = size;
      u.v.set((Math.random() - 0.5) * 2, 0.4 + Math.random() * 0.7, (Math.random() - 0.5) * 2).multiplyScalar(size);
      s.scale.setScalar(0.5 * size);
    }
  }

  // ---- Boulders.
  const tintMat = (key) => { const m = matte(rockMat.clone()); m.emissive = new THREE.Color(); m.userData.glow = key; return m; };
  const MAT = { rock: rockMat, warn: tintMat("warn"), accent: tintMat("accent"), bad: tintMat("bad") };
  const stones = [];
  let seq = 0;
  const _q = new THREE.Quaternion(), _ax = V();
  function support(b) {
    const { x, y, z, w } = b.m.quaternion, s = b.m.scale;
    const m10 = 2 * (x * y + w * z), m11 = 1 - 2 * (x * x + z * z), m12 = 2 * (y * z - w * x);
    let low = 0;
    for (let i = 0; i < hull.length; i += 3) low = Math.min(low, m10 * hull[i] * s.x + m11 * hull[i + 1] * s.y + m12 * hull[i + 2] * s.z);
    b.lift = -low;
  }
  function roll(b, dx, dz) {
    const d = Math.hypot(dx, dz);
    if (d < 1e-6) return;
    b.m.quaternion.premultiply(_q.setFromAxisAngle(_ax.set(dz / d, 0, -dx / d), d / b.r));
    support(b);
  }
  function boulder() {
    const m = new THREE.Mesh(rockGeo, MAT.rock);
    m.castShadow = m.receiveShadow = true;
    m.quaternion.setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6));
    m.scale.set(0.88 + Math.random() * 0.22, 0.88 + Math.random() * 0.22, 0.88 + Math.random() * 0.22);
    scene.add(m);
    const b = { m, p: m.position, v: V(), r: R * (m.scale.x + m.scale.y + m.scale.z) / 3, lift: R, air: true, held: false, claimed: false, dead: false, seq: seq++, gone: false, spin: V(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(), spinRate: 0 };
    support(b);
    stones.push(b);
    return b;
  }
  function drop() {
    const b = boulder();
    b.p.set(SLAB.x - 1 + Math.random() * 1.4, 18 + Math.random() * 2, (Math.random() - 0.5) * 2.6); // falls in from above the frame
    b.v.set(0, -3, 0); b.spinRate = 1 + Math.random() * 2;
  }
  // A landing: a thud you can feel, and for the big ones a small jolt of the camera.
  function impact(b, hit) {
    sfx.thud(hit, panOf(b.p));
    if (hit > 8 && !reduce) shake = Math.max(shake, Math.min(0.2, (hit - 8) * 0.02));
  }
  const _sp = V();
  function panOf(p) { _sp.copy(p).project(cam); return clamp(_sp.x * 0.8, -0.9, 0.9); }
  function remove(b) { b.gone = true; scene.remove(b.m); stones.splice(stones.indexOf(b), 1); }
  const waiting = (b) => !b.gone && !b.held && !b.claimed && !b.dead && !b.out && b.fade === undefined;

  // Rolling physics for every boulder nobody is holding: gravity along the slope, rolling friction,
  // bounces, leaving the ground over an edge, and knocking into each other.
  function physics(b, dt) {
    const p = b.p, v = b.v;
    if (b.air) {
      v.y -= G * dt;
      p.addScaledVector(v, dt);
      roll(b, v.x * dt * 0.4, v.z * dt * 0.4);
      if (b.spinRate > 0.01) { b.m.quaternion.premultiply(_q.setFromAxisAngle(b.spin, b.spinRate * dt)); support(b); }
      const f = floorAt(p.x, p.z) + b.lift;
      if (p.y <= f) {
        const [gx, gz] = grad(p.x, p.z), vg = gx * v.x + gz * v.z, hit = vg - v.y;
        p.y = f; b.spinRate *= 0.4;
        if (hit > 3) { v.y = vg + hit * 0.2; v.x *= 0.8; v.z *= 0.8; puff(p.x, f - b.lift, p.z, 6, hit); impact(b, hit); }
        else { b.air = false; v.y = vg; if (hit > 1.2) { puff(p.x, f - b.lift, p.z, 3, hit); impact(b, hit); } }
      }
      return;
    }
    const [gx, gz] = grad(p.x, p.z), k = ((5 / 7) * G) / Math.sqrt(1 + gx * gx + gz * gz);
    v.x -= gx * k * dt; v.z -= gz * k * dt;
    const mu = slabTop(p.x, p.z) > ground(p.x, p.z) ? 0.07 : 0.17;
    let sp = Math.hypot(v.x, v.z);
    if (sp > 0) { const ns = Math.max(0, sp - (mu * G + 0.06 * sp * sp) * dt); v.x *= ns / sp; v.z *= ns / sp; sp = ns; }
    if (sp < 0.04 && Math.hypot(gx, gz) * k < mu * G) { v.x = v.z = 0; b.rest = (b.rest || 0) + dt; return; }
    b.rest = 0;
    const nx = p.x + v.x * dt, nz = p.z + v.z * dt;
    if (floorAt(nx, nz) + b.lift > p.y + 0.3) { v.x *= -0.3; v.z *= -0.3; return; } // the slab's edge is a wall
    const vg = gx * v.x + gz * v.z;
    roll(b, nx - p.x, nz - p.z);
    p.x = nx; p.z = nz;
    const fy = floorAt(nx, nz) + b.lift;
    if (fy < p.y + vg * dt - 0.06) { b.air = true; v.y = vg; p.y += vg * dt; } // the ground drops away faster than it rolls
    else {
      p.y = fy; v.y = vg;
      if (sp > 3.5 && Math.random() < dt * 2) { b.air = true; v.y = vg + 0.6 + Math.random() * 1.2; }
    }
    if (sp > 2.5 && Math.random() < dt * 5) puff(p.x, fy - b.lift, p.z, 1, sp * 0.5);
  }
  const _n = V();
  function collide() {
    for (let i = 0; i < stones.length; i++) for (let j = i + 1; j < stones.length; j++) {
      const a = stones[i], b = stones[j];
      if (a.held && b.held) continue;
      _n.subVectors(b.p, a.p);
      const min = (a.r + b.r) * 0.9, d2 = _n.lengthSq();
      if (d2 >= min * min) continue;
      const d = Math.sqrt(d2) || 1e-4, over = min - d;
      _n.multiplyScalar(1 / d);
      const wa = a.held ? 0 : b.held ? 1 : 0.5, wb = b.held ? 0 : a.held ? 1 : 0.5;
      for (const [s, w, sign] of [[a, wa, -1], [b, wb, 1]]) {
        if (!w) continue;
        s.p.x += sign * _n.x * over * w; s.p.z += sign * _n.z * over * w;
        if (s.air) s.p.y += sign * _n.y * over * w;
        s.rest = 0;
      }
      const rv = (b.v.x - a.v.x) * _n.x + (b.v.y - a.v.y) * _n.y + (b.v.z - a.v.z) * _n.z;
      if (rv < 0) {
        if (rv < -1.2) sfx.knock(-rv, panOf(a.p));
        const jn = (-(1 + 0.25) * rv) / (wa + wb);
        a.v.addScaledVector(_n, -jn * wa); b.v.addScaledVector(_n, jn * wb);
      }
    }
  }
  function carry(b, d, speed, dt) {
    const dx = d.x * speed * dt, dz = d.z * speed * dt;
    roll(b, dx, dz);
    b.p.x += dx; b.p.z += dz;
    b.p.y = floorAt(b.p.x, b.p.z) + b.lift;
    b.v.set(d.x * speed, 0, d.z * speed);
  }

  // ---- Workers: the rigged Soldier, one per lane. Walk and run play at the speed the body moves, so
  // feet don't skate. Pushing leans the whole body into the rock and plants both hands on it.
  const clip = (name) => soldier.animations.find((a) => a.name === name);
  let FOOT0 = Infinity; // ankle height when a foot is planted, measured from the walk and run
  function natural(name, fallback) {
    const root = soldier.scene, mixer = new THREE.AnimationMixer(root), act = mixer.clipAction(clip(name));
    act.play();
    const feet = ["mixamorigLeftFoot", "mixamorigRightFoot"].map((n) => root.getObjectByName(n)), N = 90, dur = act.getClip().duration, tracks = [[], []];
    for (let i = 0; i <= N; i++) { mixer.setTime((i / N) * dur); root.updateMatrixWorld(true); feet.forEach((f, k) => tracks[k].push(f.getWorldPosition(V()))); }
    mixer.stopAllAction(); mixer.uncacheRoot(root);
    const speeds = [];
    for (const P of tracks) {
      const low = Math.min(...P.map((p) => p.y));
      FOOT0 = Math.min(FOOT0, low);
      for (let i = 1; i < P.length; i++) if (P[i].y < low + 0.03 && P[i - 1].y < low + 0.03) speeds.push(Math.abs(P[i].z - P[i - 1].z) / (dur / N));
    }
    speeds.sort((a, b) => a - b);
    const s = speeds[speeds.length >> 1] || 0;
    return s > 0.3 && s < 8 ? s : fallback;
  }
  const WALK = natural("Walk", 1.4), RUN = natural("Run", 3.6);
  if (!Number.isFinite(FOOT0)) FOOT0 = 0.1;
  soldier.scene.updateMatrixWorld(true);
  const bonePos = (n) => soldier.scene.getObjectByName("mixamorig" + n).getWorldPosition(V());
  const SH = clamp(bonePos("LeftArm").y, 1.2, 1.7);
  const HIP = clamp(bonePos("Hips").y, 0.75, 1.15);
  const LEG = bonePos("LeftUpLeg").distanceTo(bonePos("LeftLeg")) + bonePos("LeftLeg").distanceTo(bonePos("LeftFoot"));
  // Pushing: TILT of the lean tips the whole body from the ankles, so the drive leg runs back in a
  // line with it; the rest pitches the pelvis and bends the back. The hips sink DROP metres and the
  // steps shorten to STRIDE of a walking step.
  const TILT = 0.2, DROP = 0.06, STRIDE = 0.6;
  const shoulderAt = (lean) => [Math.sin(lean * TILT) * (HIP - DROP) + Math.sin(lean) * (SH - HIP), Math.cos(lean * TILT) * (HIP - DROP) + Math.cos(lean) * (SH - HIP)];
  const ARM = clamp(bonePos("LeftArm").distanceTo(bonePos("LeftForeArm")) + bonePos("LeftForeArm").distanceTo(bonePos("LeftHand")), 0.4, 0.8);
  const faceTo = (dx, dz) => Math.atan2(-dx, -dz); // the Soldier faces -z
  const steepness = (x, z, d) => { const [gx, gz] = grad(x, z); return Math.atan(gx * d.x + gz * d.z); };

  function worker(lane, i) {
    const model = cloneSkinned(soldier.scene);
    model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
    const mixer = new THREE.AnimationMixer(model), acts = {};
    for (const n of ["Idle", "Walk", "Run"]) { const a = mixer.clipAction(clip(n)); a.play(); a.setEffectiveWeight(n === "Idle" ? 1 : 0); a.time = Math.random() * a.getClip().duration; acts[n] = a; }
    const bone = (n) => model.getObjectByName("mixamorig" + n);
    const home = V(-3.4 + i * 1.15 + Math.random() * 0.3, 0, 10.2 + (i % 2) * 1.3 + Math.random() * 0.4);
    const w = {
      model, mixer, acts, lane, home, x: home.x, z: home.z, face: faceTo(-4 - home.x, -home.z) + (Math.random() - 0.5) * 0.8,
      spd: 0, lean: 0, leanT: 0, poseW: 0, poseT: 0, scrabble: false, state: "idle", t: 0, b: null, ev: null, d: V(1, 0, 0), up: false,
      pb: V(), pr: R, feet: [{ up: false, p: V() }, { up: false, p: V() }],
      bones: {
        neck: bone("Neck"), hips: bone("Hips"), spine: ["Spine", "Spine1", "Spine2"].map(bone),
        arms: [["LeftArm", "LeftForeArm", "LeftHand"], ["RightArm", "RightForeArm", "RightHand"]].map((a) => a.map(bone)),
        legs: [["LeftUpLeg", "LeftLeg", "LeftFoot"], ["RightUpLeg", "RightLeg", "RightFoot"]].map((a) => a.map(bone)),
      },
    };
    scene.add(model);
    return w;
  }
  const workers = LANES.map(worker);

  // Walk toward a point, easing in and out; returns true on arrival.
  function walkTo(w, tx, tz, top, dt) {
    const dx = tx - w.x, dz = tz - w.z, d = Math.hypot(dx, dz);
    const want = Math.min(top, d * 1.6);
    w.spd += clamp(want - w.spd, -4 * dt, 2.5 * dt);
    if (d > 0.02) {
      const st = Math.min(d, w.spd * dt);
      w.x += (dx / d) * st; w.z += (dz / d) * st;
      if (d > 0.25) w.face = faceTo(dx, dz);
    }
    return d < 0.1;
  }
  // Where hands go on a rock: its back, measured along the slope and a little below its middle, so
  // going uphill they push low and forward instead of reaching over their heads.
  const _ds = V(), _dn = V(), _ct = V();
  function contact(o, p, r, d) {
    const [gx, gz] = grad(p.x, p.z);
    _ds.set(d.x, gx * d.x + gz * d.z, d.z).normalize();
    _dn.set(-gx, 1, -gz).normalize();
    return o.copy(p).addScaledVector(_ds, -r * 0.86).addScaledVector(_dn, -r * 0.28);
  }
  // Where to stand so the shoulders are a slightly bent arm's length from that contact, leaning `lean`.
  const _f = V();
  function stance(b, d, lean) {
    const c = contact(_ct, b.p, b.r, d), [sl, cl] = shoulderAt(lean), goal = ARM * 0.85;
    let lo = b.r * 0.9 + sl, hi = 4;
    for (let k = 0; k < 14; k++) {
      const s = (lo + hi) / 2, fx = b.p.x - d.x * s, fz = b.p.z - d.z * s, fy = ground(fx, fz);
      if (Math.hypot(fx + d.x * sl - c.x, fy + cl - c.y, fz + d.z * sl - c.z) < goal) lo = s; else hi = s;
    }
    const s = (lo + hi) / 2;
    return _f.set(b.p.x - d.x * s, 0, b.p.z - d.z * s);
  }
  const leanFor = (b, d) => 0.85 + 0.35 * Math.max(0, steepness(b.p.x, b.p.z, d));

  let pending = [], spawnLeft = 0, spawnT = 0, delivered = 0, slipped = 0, base0 = null;
  const _d = V();
  function pushDir(w, b) {
    if (!w.up) {
      _d.set(START_X - b.p.x, 0, w.lane - b.p.z);
      if (_d.length() < 0.2) w.up = true; else return _d.normalize();
    }
    return _d.set(1, 0, (w.lane - b.p.z) * 0.6).normalize();
  }
  function stepWorker(w, dt) {
    const b = w.b;
    w.poseT = 0; w.leanT = 0; w.scrabble = false;
    if (b && b.gone) { w.b = null; w.state = "return"; return; }
    if (w.state === "idle") {
      walkTo(w, w.home.x, w.home.z, 1.2, dt);
    } else if (w.state === "return") {
      if (walkTo(w, w.home.x, w.home.z, pending.length > 4 ? RUN * 0.85 : WALK, dt)) w.state = "idle";
    } else if (w.state === "go") {
      const d = pushDir(w, b), f = stance(b, d, leanFor(b, d));
      if (walkTo(w, f.x, f.z, pending.length > 6 ? RUN * 0.8 : WALK * 1.1, dt)) { w.state = "brace"; w.t = 0; b.held = true; }
    } else if (w.state === "brace" || w.state === "push" || w.state === "strain") {
      const d = pushDir(w, b), lean = leanFor(b, d);
      w.d.copy(d); w.poseT = 1; w.leanT = lean;
      let speed = 0;
      if (w.state === "brace") { w.t += dt; if (w.t > 0.5) w.state = "push"; }
      else if (w.state === "push") {
        const steep = clamp(steepness(b.p.x, b.p.z, d) / 0.7, 0, 1);
        speed = 0.95 * (1 + Math.min(pending.length, 20) / 30) * (1 - 0.45 * steep);
        if (w.up && b.p.x >= w.goal) {
          if (w.ev === "ok") { b.held = false; b.out = true; b.air = false; b.v.set(2.6, 0, 0); w.state = "rest"; w.t = 1.4; w.b = null; }
          else { w.state = "strain"; w.t = 0.9; }
        }
        if (w.ev === "ok" && !b.flagged && b.p.x >= FLAG_X) { b.flagged = true; b.m.material = MAT.accent; flag.userData.pulse = 1; delivered++; sfx.chime(panOf(b.p)); }
      } else { // strain: the rock wins by inches. Boots churn and slide back, then it gets away from them
        w.t -= dt; w.scrabble = true; w.leanT = lean + 0.15;
        speed = -(0.06 + (0.9 - w.t) * 0.45) + Math.sin(w.t * 23) * 0.05;
        if (w.t <= 0) {
          b.held = false; b.claimed = false; b.air = false; b.v.set(-0.9 * d.x, 0, -0.9 * d.z);
          if (w.ev === "dead") { b.dead = true; b.v.z = 1.6; b.m.material = MAT.bad; deadQueue.push(b); sfx.dead(panOf(b.p)); }
          else { b.m.material = MAT.warn; slipped++; }
          sfx.slip(panOf(b.p));
          w.state = "dodge"; w.t = 0.7; w.side = w.lane > 6 ? -1 : 1; w.b = null; w.watch = b;
        }
      }
      if (w.b) {
        w.spd += (Math.abs(speed) - w.spd) * Math.min(1, dt * 6);
        carry(b, d, w.state === "strain" ? speed : w.spd, dt);
        w.pb.copy(b.p); w.pr = b.r;
        const f = stance(b, d, w.lean);
        if (w.state === "brace") { w.x += (f.x - w.x) * Math.min(1, dt * 8); w.z += (f.z - w.z) * Math.min(1, dt * 8); }
        else { w.x = f.x; w.z = f.z; }
        w.face = faceTo(d.x, d.z);
      }
    } else if (w.state === "dodge") { // jump clear of the rolling rock
      w.t -= dt;
      walkTo(w, w.x, w.z + w.side * 3, RUN * 0.9, dt);
      if (w.t <= 0) { w.state = "watch"; w.t = 1; }
    } else if (w.state === "watch" || w.state === "rest") {
      w.t -= dt;
      w.spd = Math.max(0, w.spd - dt * 4);
      const o = w.watch && !w.watch.gone ? w.watch.p : V(X2 + 4, 0, w.lane);
      if (w.state === "watch") w.face = faceTo(o.x - w.x, o.z - w.z);
      if (w.t <= 0) { w.state = "return"; w.watch = null; }
    }
  }

  // Bone helpers for the pushing pose, all in world space so they don't care about bone axes.
  const _a = V(), _b = V(), _c = V(), _e = V(), _t = V(), _p = V(), _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
  function aimChild(bone, child, goal, k) { // rotate `bone` so that `child` moves toward `goal`
    bone.getWorldPosition(_p);
    child.getWorldPosition(_c);
    _qa.setFromUnitVectors(_c.sub(_p).normalize(), _t.copy(goal).sub(_p).normalize());
    bone.getWorldQuaternion(_qb);
    _qa.multiply(_qb);
    bone.parent.getWorldQuaternion(_qb);
    bone.quaternion.slerp(_qb.invert().multiply(_qa), k);
    bone.updateMatrixWorld(true);
  }
  function reach([upper, lower, hand], target, pole, k) { // two-bone IK
    upper.getWorldPosition(_a); lower.getWorldPosition(_b); hand.getWorldPosition(_c);
    const la = _a.distanceTo(_b), lb = _b.distanceTo(_c);
    _t.subVectors(target, _a);
    const dist = clamp(_t.length(), Math.abs(la - lb) + 0.01, (la + lb) * 0.98);
    _t.normalize();
    const cos = (la * la + dist * dist - lb * lb) / (2 * la * dist), sin = Math.sqrt(Math.max(0, 1 - cos * cos));
    const bend = _e.copy(pole).addScaledVector(_t, -pole.dot(_t)).normalize();
    const elbow = V().copy(_a).addScaledVector(_t, la * cos).addScaledVector(bend, la * sin);
    const wrist = V().copy(_a).addScaledVector(_t, dist);
    aimChild(upper, lower, elbow, k);
    aimChild(lower, hand, wrist, k);
  }
  function turnWorld(bone, axis, angle) {
    bone.getWorldQuaternion(_qb);
    _qa.setFromAxisAngle(axis, angle).multiply(_qb);
    bone.parent.getWorldQuaternion(_qb);
    bone.quaternion.copy(_qb.invert().multiply(_qa));
    bone.updateMatrixWorld(true);
  }
  const _r = V(), _sh = V(), _nk = V(), _goal = V(), _pole = V(), _hp = V(), _fw = V(), qYaw = new THREE.Quaternion(), qLean = new THREE.Quaternion();
  function animate(w, dt) {
    w.lean += (w.leanT - w.lean) * Math.min(1, dt * 5);
    w.poseW += (w.poseT - w.poseW) * Math.min(1, dt * 6);
    const s = w.spd, k = w.poseW, idle = clamp(1 - s / 0.45, 0, 1), run = S(s, WALK * 1.25, RUN * 0.75);
    const stride = 1 - (1 - STRIDE) * k; // pushing takes short, quick steps that still match the ground speed
    const weights = w.scrabble ? { Idle: 0, Walk: 1, Run: 0 } : { Idle: idle, Walk: (1 - idle) * (1 - run), Run: (1 - idle) * run };
    for (const n in weights) w.acts[n].setEffectiveWeight(weights[n]);
    w.acts.Walk.timeScale = w.scrabble ? 1.5 : clamp(s / (WALK * stride), 0.35, 2);
    w.acts.Run.timeScale = clamp(s / RUN, 0.6, 1.4);
    w.mixer.update(dt);
    const base = ground(w.x, w.z);
    w.model.position.set(w.x, base, w.z);
    const cur = Math.atan2(Math.sin(w.face - (w.yaw ?? w.face)), Math.cos(w.face - (w.yaw ?? w.face)));
    w.yaw = (w.yaw ?? w.face) + cur * Math.min(1, dt * 7);
    w.model.quaternion.copy(qYaw.setFromAxisAngle(UP, w.yaw));
    w.model.updateMatrixWorld(true);
    const B = w.bones;
    _fw.set(-Math.sin(w.yaw), 0, -Math.cos(w.yaw));
    // Feet: where the clip puts them before any lean, pulled in for short steps, set onto the slope.
    for (let i = 0; i < 2; i++) {
      const f = w.feet[i], p = B.legs[i][2].getWorldPosition(f.p), h = p.y - base;
      p.x = w.x + (p.x - w.x) * stride; p.z = w.z + (p.z - w.z) * stride;
      p.y = ground(p.x, p.z) + h;
      if (h > FOOT0 + 0.06) f.up = true;
      else if (f.up && h < FOOT0 + 0.025) { f.up = false; footfall(w, p); }
    }
    w.model.quaternion.multiply(qLean.setFromAxisAngle(XAX, -w.lean * TILT));
    w.model.updateMatrixWorld(true);
    // Hips sink on bent knees when pushing, and only as far as a downhill foot needs to reach.
    let drop = DROP * k;
    for (let i = 0; i < 2; i++) {
      const p = w.feet[i].p;
      B.legs[i][0].getWorldPosition(_hp);
      const hd = Math.hypot(_hp.x - p.x, _hp.z - p.z), reachY = Math.sqrt(Math.max(0, (LEG * 0.97) ** 2 - hd * hd));
      drop = Math.max(drop, _hp.y - p.y - reachY);
    }
    if (drop > 0.002) {
      B.hips.getWorldPosition(_hp).addScaledVector(UP, -drop);
      B.hips.parent.worldToLocal(_hp); B.hips.position.copy(_hp); B.hips.updateMatrixWorld(true);
    }
    _r.crossVectors(_fw, UP).normalize();
    const bend = w.lean * (1 - TILT);
    if (k > 0.02) turnWorld(B.hips, _r, -bend * 0.45); // pelvis pitches forward; the legs are solved after
    _pole.copy(_fw).addScaledVector(UP, 0.1);
    for (let i = 0; i < 2; i++) reach(B.legs[i], w.feet[i].p, _pole, 1);
    if (k < 0.02) return;
    // The back takes the rest of the lean; the head comes up to look up the hill, not at the dirt.
    for (const sp of B.spine) turnWorld(sp, _r, (-bend * 0.55) / B.spine.length);
    if (w.scrabble) turnWorld(B.spine[2], _r, Math.sin(clock * 41) * 0.03); // straining: the back trembles
    turnWorld(B.neck, _r, w.lean * 0.7);
    B.neck.getWorldPosition(_nk);
    // Hands on the rock. After a release they stay reaching for where it was while the pose eases off.
    const d = w.d;
    for (const arm of B.arms) {
      arm[0].getWorldPosition(_sh);
      const side = Math.sign(_sh.sub(_nk).dot(_r)) || 1;
      contact(_goal, w.pb, w.pr, d).addScaledVector(_r, side * 0.26);
      _pole.copy(UP).multiplyScalar(-1).addScaledVector(_r, side * 0.7).addScaledVector(d, -0.3);
      reach(arm, _goal, _pole, k);
    }
  }
  // A boot hitting the ground: a crunch, and a little dust when running or digging in.
  function footfall(w, p) {
    const dig = w.poseW > 0.5 || w.scrabble;
    if (w.spd < 0.3 && !w.scrabble) return;
    sfx.step(panOf(p), clamp(w.spd / RUN, 0.3, 1) + (dig ? 0.5 : 0));
    if (w.spd > WALK * 1.3 || dig) puff(p.x, ground(p.x, p.z), p.z, 1, 0.15, 0.3);
  }

  // A free worker takes the oldest boulder that has come to rest, and the next real event.
  function dispatch() {
    for (const w of workers) {
      if (!pending.length) return;
      if (w.state !== "idle" && w.state !== "return") continue;
      let b = null;
      for (const s of stones) if (waiting(s) && !s.air && s.rest > 0.3 && s.p.x > SLAB.x + SLAB.len / 2 && (!b || s.seq < b.seq)) b = s; // never one stranded behind the slab
      if (!b) {
        if (!spawnLeft && !stones.some(waiting)) spawnLeft = 1; // the picture fell behind the real queue
        return;
      }
      b.claimed = true; w.b = b; w.ev = pending.shift(); w.state = "go"; w.up = false;
      w.goal = w.ev === "ok" ? X2 - 0.3 : X0 + 2.5 + Math.random() * (X1 - X0) * 0.55;
    }
  }
  const deadQueue = [];

  // Turn the change between two stats snapshots into boulder events.
  function ingest(s) {
    let tot = 0; for (const k in s.jobs) tot += s.jobs[k];
    const now = { tot, ok: s.jobs.completed || 0, dead: s.jobs.dead || 0, del: s.sink.deliveries };
    if (!base0 || !visible || document.hidden || reduce) { base0 = now; return; }
    const nNew = Math.max(0, now.tot - base0.tot), nOk = Math.max(0, now.ok - base0.ok), nDead = Math.max(0, now.dead - base0.dead);
    const nFail = Math.max(0, now.del - base0.del - nOk - nDead);
    base0 = now;
    spawnLeft += Math.min(nNew, 150);
    const evs = Array(Math.min(nOk, 150)).fill("ok");
    const mix = (kind, n) => { for (let j = 0; j < Math.min(n, 40); j++) evs.splice(Math.floor(Math.random() * (evs.length + 1)), 0, kind); };
    mix("fail", nFail); mix("dead", nDead);
    pending = pending.concat(evs);
    // The hill moves at human pace; the real queue doesn't. Jobs beyond what the workers can show
    // are delivered out of sight, from the part of the line nobody can see.
    while (pending.length > MAX_PENDING) {
      const i = pending.indexOf("ok");
      if (i < 0) { pending.length = MAX_PENDING; break; }
      pending.splice(i, 1);
      if (spawnLeft > 0) spawnLeft--;
      delivered++;
    }
  }

  function stepWorld(dt) {
    // New jobs fall onto the slab. Past VIS the line continues out of sight and the label keeps count.
    let shown = 0; for (const b of stones) if (waiting(b)) shown++;
    spawnT -= dt;
    if (spawnT <= 0 && shown < VIS && spawnLeft > 0) { spawnLeft--; drop(); spawnT = 0.3; }
    dispatch();
    for (const w of workers) stepWorker(w, dt);
    for (const b of stones) if (!b.held) physics(b, dt);
    collide();
    for (let i = stones.length - 1; i >= 0; i--) {
      const b = stones[i];
      if (b.out && !b.air && b.v.lengthSq() < 0.05 && b.p.x > X2 - 1) b.v.x += 0.6; // stalled on the brow: nudge it over
      if (b.p.x > X2 + 16 || b.p.y < -30 || Math.abs(b.p.z) > 40 || b.p.x < -40) remove(b);
      // Bounced behind the slab: nobody can push it over, so it fades and its job drops in again.
      else if (waiting(b) && b.rest > 1 && b.p.x < SLAB.x + SLAB.len / 2 + b.r * 0.5 && slabTop(b.p.x, b.p.z) === -Infinity) { b.fade = 1; b.m.material = matte(b.m.material.clone()); b.m.material.transparent = true; spawnLeft++; }
    }
    // Dead letters stay where they stop, red, until there are too many; the oldest ones fade out.
    while (deadQueue.length > 5) { const b = deadQueue.shift(); if (b.gone) continue; b.fade = 1; b.m.material = matte(MAT.bad.clone()); b.m.material.transparent = true; }
    for (let i = stones.length - 1; i >= 0; i--) {
      const b = stones[i];
      if (b.fade === undefined) continue;
      b.fade -= dt * 0.6; b.m.material.opacity = Math.max(0, b.fade);
      if (b.fade <= 0) { b.m.material.dispose(); remove(b); }
    }
    for (const s of dust) {
      const u = s.userData; if (u.life <= 0) continue;
      u.life -= dt * 0.55; s.position.addScaledVector(u.v, dt); u.v.multiplyScalar(1 - dt * 1.4);
      s.scale.setScalar((0.5 + (1 - u.life) * 3) * (u.size || 1)); s.material.opacity = Math.max(0, u.life) * u.a;
    }
    if (flag.userData.pulse > 0) flag.userData.pulse = Math.max(0, flag.userData.pulse - dt * 1.2);
  }

  // ---- Callouts, like waypoint markers in a game: each pill hangs off a leader line whose pin sits
  // on the thing it names, and follows it live. `at` is the pin, `top` (a world point) or `off`
  // (screen px) places the pill, `flat` pins lie on the ground, `dash` marks the API's drop column.
  const NS = "http://www.w3.org/2000/svg", leads = document.createElementNS(NS, "svg");
  leads.setAttribute("class", "leads"); leads.setAttribute("aria-hidden", "true");
  host.appendChild(leads);
  const svgEl = (n, cls) => { const e = document.createElementNS(NS, n); if (cls) e.setAttribute("class", cls); leads.appendChild(e); return e; };
  const queueAt = (v) => {
    let n = 0; v.set(0, 0, 0);
    for (const b of stones) if (waiting(b) && !b.air && b.p.x < -1 && slabTop(b.p.x, b.p.z) === -Infinity) { v.add(b.p); n++; }
    if (!n) return v.set(-4.2, ground(-4.2, 2.5), 2.5);
    v.multiplyScalar(1 / n); return v.setY(ground(v.x, v.z));
  };
  const workersAt = (v) => { // the head of the worker nearest the middle of the crew, so the pin always lands on someone
    let cx = 0, cz = 0; for (const w of workers) { cx += w.x; cz += w.z; } cx /= workers.length; cz /= workers.length;
    let best = workers[0], bd = Infinity; for (const w of workers) { const d = (w.x - cx) ** 2 + (w.z - cz) ** 2; if (d < bd) { bd = d; best = w; } }
    return v.set(best.x, best.model.position.y + SH + 0.45, best.z);
  };
  const tags = [
    { text: "API", sub: "jobs drop in", at: (v) => v.set(SLAB.x - 0.3, SLAB_TOP + 0.05, 0), top: V(SLAB.x - 0.3, 12.5, 0), dash: true, flat: true },
    { text: "Postgres", at: (v) => v.set(SLAB.x - 1.3, SLAB_TOP - 1.1, SLAB.wid / 2), off: [-54, 40] },
    { text: "Queue", at: queueAt, off: [-36, 52], flat: true, smooth: 1.5 },
    { text: "Workers", at: workersAt, off: [30, -54], smooth: 3 },
    { text: "Your webhook", at: (v) => v.set(FLAG_X, H + 4.15, 0), off: [-62, -34] },
  ].map((t) => {
    const el = document.createElement("div"); el.className = "tag"; el.textContent = t.text;
    if (t.sub) { const s = document.createElement("small"); s.textContent = t.sub; el.appendChild(s); }
    host.appendChild(el);
    return { ...t, el, line: svgEl("line", t.dash ? "dash" : ""), pin: svgEl(t.flat ? "ellipse" : "circle"), s: null, box: { x: 0, y: 0, w: 0, h: 0 } };
  });

  // ---- Camera: a three-quarter view up the slope. On wide screens the frame shifts right so the
  // copy on the left sits over open sky. Drag to swing it a little.
  const cam = new THREE.PerspectiveCamera(30, 1, 0.5, 1500);
  const look = V(5.5, 2.6, 0);
  let sway = 0, swayT = 0, yaw = 0, yawT = 0, drag = null, clock = 0, shake = 0;
  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    gl.setSize(w, h, false);
    cam.aspect = w / h;
    const wide = w > 900;
    cam.userData = { yaw0: wide ? -0.1 : -0.25, dist: wide ? 57 : Math.max(50, 54 / cam.aspect), pitch: wide ? 0.2 : 0.26 };
    look.x = wide ? 3.5 : 3;
    cam.filmOffset = (wide ? -0.2 : 0) * cam.getFilmWidth();
    cam.updateProjectionMatrix();
    render();
  }
  function place() {
    const { yaw0 = -0.1, dist = 57, pitch = 0.2 } = cam.userData, a = yaw0 + yaw + sway * 0.05;
    const hand = reduce ? 0 : 1; // a slow, small drift, as if the camera were held
    cam.position.set(look.x + Math.sin(a) * dist + Math.sin(clock * 0.31) * 0.15 * hand + Math.sin(clock * 47) * shake, look.y + dist * pitch + Math.sin(clock * 0.23 + 1) * 0.1 * hand + Math.sin(clock * 39 + 1) * shake * 0.7, look.z + Math.cos(a) * dist);
    cam.lookAt(look.x + Math.sin(clock * 0.19) * 0.06 * hand, look.y, look.z);
  }
  host.addEventListener("pointermove", (e) => {
    const r = host.getBoundingClientRect();
    swayT = ((e.clientX - r.left) / r.width - 0.5) * 2;
    if (drag) yawT = clamp(drag.y0 + (e.clientX - drag.x) / 320, -0.6, 0.6);
  });
  host.addEventListener("pointerleave", () => { swayT = 0; drag = null; });
  host.addEventListener("pointerdown", (e) => { if (e.target === canvas) { drag = { x: e.clientX, y0: yawT }; canvas.style.cursor = "grabbing"; } });
  addEventListener("pointerup", () => { drag = null; canvas.style.cursor = ""; });

  let visible = true;
  new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (!visible) { pending = []; spawnLeft = 0; } }).observe(host);

  const _l = V(), _at = V();
  let labelT = 0;
  function labels() {
    const w = host.clientWidth, h = host.clientHeight, now = performance.now(), k = labelT ? Math.min(1, (now - labelT) / 1000) : 1, sc = w < 640 ? 0.7 : 1;
    labelT = now;
    const toScreen = (v, o) => { _l.copy(v).project(cam); o.x = ((_l.x + 1) / 2) * w; o.y = ((1 - _l.y) / 2) * h; return _l.z < 1; };
    for (const t of tags) {
      t.at(_at);
      if (!t.s || !t.smooth || reduce) t.s = (t.s || V()).copy(_at); else t.s.lerp(_at, Math.min(1, k * t.smooth));
      t.pt = t.pt || {};
      t.ok = toScreen(t.s, t.pt);
      const b = t.box; b.w = t.el.offsetWidth; b.h = t.el.offsetHeight;
      if (t.top) { toScreen(t.top, b); b.x -= b.w / 2; b.y -= b.h; }
      else { b.x = t.pt.x + t.off[0] * sc - b.w / 2; b.y = t.pt.y + t.off[1] * sc - b.h / 2; }
      b.x = clamp(b.x, 8, w - b.w - 8); b.y = clamp(b.y, 8, h - b.h - 8);
    }
    // Pills that collide slide apart vertically, then stay inside the frame.
    for (let pass = 0; pass < 4; pass++) for (let i = 0; i < tags.length; i++) for (let j = i + 1; j < tags.length; j++) {
      const A = tags[i].box, B = tags[j].box;
      const ox = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x) + 6, oy = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y) + 6;
      if (ox <= 0 || oy <= 0) continue;
      const s = A.y + A.h / 2 < B.y + B.h / 2 ? -1 : 1;
      A.y += (s * oy) / 2; B.y -= (s * oy) / 2;
    }
    for (const t of tags) {
      const b = t.box, p = t.pt;
      b.x = clamp(b.x, 8, w - b.w - 8); b.y = clamp(b.y, 8, h - b.h - 8);
      t.el.style.transform = `translate(${b.x.toFixed(1)}px,${b.y.toFixed(1)}px)`;
      t.el.style.opacity = t.ok ? "" : "0";
      // The leader runs from the pin to the nearest edge of its pill.
      const ex = clamp(p.x, b.x, b.x + b.w), ey = clamp(p.y, b.y, b.y + b.h), show = t.ok && Math.hypot(ex - p.x, ey - p.y) > 4;
      t.line.setAttribute("x1", p.x.toFixed(1)); t.line.setAttribute("y1", p.y.toFixed(1));
      t.line.setAttribute("x2", ex.toFixed(1)); t.line.setAttribute("y2", ey.toFixed(1));
      t.line.style.display = t.pin.style.display = show ? "" : "none";
      t.pin.setAttribute("cx", p.x.toFixed(1)); t.pin.setAttribute("cy", p.y.toFixed(1));
      if (t.flat) { t.pin.setAttribute("rx", 6 * sc); t.pin.setAttribute("ry", 2.4 * sc); } else t.pin.setAttribute("r", 3 * sc);
    }
  }
  function render() { place(); gl.render(scene, cam); labels(); }

  // ---- Theme: daylight for light mode, dusk for dark mode. Tints come from the page's tokens.
  function applyTheme() {
    const dark = darkMQ.matches, cs = getComputedStyle(document.documentElement);
    const tok = (k) => new THREE.Color(cs.getPropertyValue("--" + k).trim());
    gl.toneMappingExposure = dark ? 0.42 : 0.9;
    scene.backgroundIntensity = dark ? 0.5 : 1;
    scene.environmentIntensity = dark ? 0.55 : 1;
    sun.intensity = dark ? 1.3 : 3.2;
    sun.color.set(dark ? 0xc8d4ff : 0xfff1de);
    scene.fog.color.copy(aces(horizon.clone().multiplyScalar(scene.backgroundIntensity), gl.toneMappingExposure));
    flagMat.color.copy(tok("accent"));
    flagMat.emissive.copy(tok("accent"));
    for (const key of ["warn", "accent", "bad"]) {
      const m = MAT[key], c = tok(key);
      m.color.set(0xffffff).lerp(c, 0.3);
      m.emissive.copy(c);
      m.emissiveIntensity = dark ? 0.22 : 0.1;
    }
  }

  let last = performance.now(), hudT = 0, tier = 0;
  const perf = { n: 0, sum: 0 };
  function frame(now) {
    requestAnimationFrame(frame);
    const raw = Math.min(0.5, (now - last) / 1000);
    last = now;
    if (!visible || document.hidden) { sfx.pause(true); return; }
    sfx.pause(false);
    // Slow device: step quality down after a couple of seconds, until the hill keeps moving.
    if (raw < 0.25) {
      perf.n++; perf.sum += raw;
      if (perf.n === 60) {
        if (perf.sum / 60 > 1 / 32 && tier < 2) {
          tier++;
          if (tier === 1) { gl.setPixelRatio(1); grass.mesh.count = Math.floor(grass.N / 2); resize(); }
          else { gl.shadowMap.enabled = false; grass.mesh.visible = false; scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; }); }
        }
        perf.n = perf.sum = 0;
        if (tier === 2) perf.n = -Infinity;
      }
    }
    // Fixed substeps keep the physics stable and in real time even when frames are slow.
    for (let left = raw; left > 1e-4; left -= 0.025) {
      const dt = Math.min(0.025, left);
      sway += (swayT - sway) * Math.min(1, dt * 2); yaw += (yawT - yaw) * Math.min(1, dt * 4); if (!drag) yawT *= Math.pow(0.4, dt);
      stepWorld(dt);
      hudT -= dt;
    }
    clock += raw;
    shake *= Math.exp(-raw * 6);
    grass.uTime.value = clock;
    if (sfx.on) { // rolling rock: louder the more of it is moving, panned toward where it is
      let roll = 0, pan = 0;
      for (const b of stones) {
        if (b.air || b.fade !== undefined) continue;
        const sp = Math.hypot(b.v.x, b.v.z) * (b.held ? 0.5 : 1);
        if (sp > 0.05) { roll += sp; pan += sp * panOf(b.p); }
      }
      sfx.update(raw, roll, roll ? pan / roll : 0);
    }
    for (const w of workers) animate(w, raw);
    const fl = flag.userData.pulse || 0, fp = flagGeo.attributes.position;
    for (let i = 0; i < fp.count; i++) { const x = flagX[i]; fp.setZ(i, (Math.sin(x * 3.2 - clock * 6) * 0.6 + Math.sin(x * 5.1 - clock * 9.3) * 0.25) * (0.16 + fl * 0.2) * (x / 2)); }
    fp.needsUpdate = true; flagGeo.computeVertexNormals();
    flagMat.emissiveIntensity = 0.05 + fl * 0.6;
    if (hudT <= 0) {
      hudT = 0.15;
      let shown = 0; for (const b of stones) if (waiting(b)) shown++;
      $("hq").textContent = shown + spawnLeft;
      $("hw").textContent = workers.filter((w) => w.b).length;
      $("hd").textContent = delivered; $("hs").textContent = slipped;
      tags[2].el.textContent = spawnLeft > 0 ? `Queue, ${spawnLeft} more out of sight` : "Queue";
      if (hint) { hint.textContent = "The hill is quiet. Press Run 100 jobs and one in five will slip on its first try."; hint.className = "hint" + (stones.some(waiting) || pending.length || spawnLeft ? " off" : ""); }
    }
    render();
  }

  applyTheme();
  darkMQ.addEventListener("change", () => { applyTheme(); render(); });
  new ResizeObserver(resize).observe(host);
  resize();
  host.classList.add("ready");
  const snd = $("snd");
  if (snd && !reduce) {
    snd.hidden = false;
    snd.addEventListener("click", () => {
      const on = sfx.toggle();
      snd.setAttribute("aria-pressed", String(on));
      snd.lastChild.textContent = on ? "Sound on" : "Sound off";
    });
  }
  window.relayqHill = { ingest };
  if (reduce) {
    // One still frame: a few boulders that have rolled off the slab and settled, workers at rest.
    for (let i = 0; i < 6; i++) { drop(); for (let k = 0; k < 40; k++) { for (const b of stones) physics(b, 0.025); collide(); } }
    for (let k = 0; k < 240; k++) { for (const b of stones) physics(b, 0.025); collide(); }
    for (const w of workers) animate(w, 0);
    render();
    if (hint) { hint.textContent = "Animation is off because your system asks for reduced motion. The numbers below are live."; hint.className = "hint"; }
  } else {
    if (hint) hint.className = "hint";
    requestAnimationFrame(frame);
  }
}
