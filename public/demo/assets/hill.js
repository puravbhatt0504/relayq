// The hill on /demo. Every boulder is a real job: nothing moves unless /demo/stats says something
// happened. The page calls window.relayqHill.ingest(stats) once a second.
// Assets: Poly Haven rock_07, rocky_terrain_02 and kloofendal_48d_partly_cloudy_puresky (CC0);
// Soldier.glb from the three.js examples (Mixamo character and animations).
/* global window, document, console, matchMedia, getComputedStyle, addEventListener, performance, requestAnimationFrame, IntersectionObserver, ResizeObserver */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";

const $ = (id) => document.getElementById(id);
const host = $("scene"), canvas = $("gl"), hint = $("hint");
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const darkMQ = matchMedia("(prefers-color-scheme: dark)");
const BASE = "/demo/assets/";

// ---- World layout, in metres. The slope climbs along +x from X0 to X1, then a plateau with the flag.
const X0 = 0, X1 = 12, H = 6, R = 0.8;
const LANES = [-7.5, -4.5, -1.5, 1.5, 4.5, 7.5];
const SLAB = { x: -10.5, top: 1.1 }, FLAG_X = 16, HOME = -1.6, VIS = 15, MAX_PENDING = 24;
const smooth = (t) => t * t * (3 - 2 * t);
const hill = (x) => (x <= X0 ? 0 : x >= X1 ? H : H * smooth((x - X0) / (X1 - X0)));
const slope = (x) => { if (x <= X0 || x >= X1) return 0; const t = (x - X0) / (X1 - X0); return (H * 6 * t * (1 - t)) / (X1 - X0); };
const MAX_SLOPE = (H * 1.5) / (X1 - X0);
// The hill is a ridge across the lanes. In front it falls away so the camera sees its profile;
// behind it, rolling country. The lanes stay smooth so boulders and feet sit on the ground.
const S = THREE.MathUtils.smoothstep;
function ground(x, z) {
  const ridge = 1 - S(z, 10, 17);
  const back = S(-z, 12, 30), front = S(z, 14, 26);
  const n = Math.sin(x * 0.09 + z * 0.06) * 2.4 + Math.sin(x * 0.21 - z * 0.17) * 1.2 + Math.sin(z * 0.29 + 1.3) * 0.7;
  const dunes = Math.sin(x * 0.23 + 0.7) * Math.sin(z * 0.31) * 0.5;
  return hill(x) * ridge + back * (n + 3.5) + front * dunes + Math.sin(x * 1.7) * Math.sin(z * 1.3) * 0.03;
}

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
  gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  gl.toneMapping = THREE.ACESFilmicToneMapping;
  gl.shadowMap.enabled = true;
  gl.shadowMap.type = THREE.PCFSoftShadowMap;

  const manager = new THREE.LoadingManager();
  manager.onProgress = (_url, done, total) => { if (hint) hint.textContent = `Loading the hill, ${done} of ${total} files`; };
  const texLoader = new THREE.TextureLoader(manager);
  const gltfLoader = new GLTFLoader(manager);
  const rgbe = new RGBELoader(manager).setDataType(THREE.FloatType);
  const [sky, rockGltf, soldier, tDiff, tNor, tRough] = await Promise.all([
    rgbe.loadAsync(BASE + "sky_1k.hdr"),
    gltfLoader.loadAsync(BASE + "rock/rock_07_1k.gltf"),
    gltfLoader.loadAsync(BASE + "Soldier.glb"),
    texLoader.loadAsync(BASE + "terrain_rocky_terrain_02_diff_1k.jpg"),
    texLoader.loadAsync(BASE + "terrain_rocky_terrain_02_nor_gl_1k.jpg"),
    texLoader.loadAsync(BASE + "terrain_rocky_terrain_02_rough_1k.jpg"),
  ]);

  // ---- Sky, light and atmosphere. Fog takes the HDRI's own horizon colour so land meets sky cleanly.
  const scene = new THREE.Scene();
  sky.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = sky;
  const pmrem = new THREE.PMREMGenerator(gl);
  scene.environment = pmrem.fromEquirectangular(sky).texture;
  const horizon = (() => {
    const { data, width, height } = sky.image, c = new THREE.Color(0, 0, 0);
    const row = Math.floor(height * 0.47);
    for (let x = 0; x < width; x++) { const i = (row * width + x) * 4; c.r += data[i]; c.g += data[i + 1]; c.b += data[i + 2]; }
    return c.multiplyScalar(1 / width);
  })();
  scene.fog = new THREE.FogExp2(horizon.clone(), 0.005);

  const sun = new THREE.DirectionalLight(0xfff0dc, 3);
  sun.position.set(-28, 42, 22);
  sun.target.position.set(2, 0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 22, bottom: -22, near: 5, far: 120 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);

  // ---- Terrain: one heightfield with scanned rocky-ground textures.
  for (const t of [tDiff, tNor, tRough]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(48, 32); t.anisotropy = gl.capabilities.getMaxAnisotropy(); }
  tDiff.colorSpace = THREE.SRGBColorSpace;
  const tg = new THREE.PlaneGeometry(240, 160, 360, 240);
  tg.rotateX(-Math.PI / 2);
  const tp = tg.attributes.position;
  for (let i = 0; i < tp.count; i++) tp.setY(i, ground(tp.getX(i), tp.getZ(i)));
  tg.computeVertexNormals();
  const terrain = new THREE.Mesh(tg, new THREE.MeshStandardMaterial({ map: tDiff, normalMap: tNor, roughnessMap: tRough, normalScale: new THREE.Vector2(1.3, 1.3) }));
  terrain.receiveShadow = true;
  scene.add(terrain);

  // ---- Boulders: the scanned rock, centred and sized to radius R. One geometry, a material per state.
  let rockMesh;
  rockGltf.scene.traverse((o) => { if (o.isMesh && !rockMesh) rockMesh = o; });
  const rockGeo = rockMesh.geometry.clone();
  rockGeo.computeBoundingBox();
  const bb = rockGeo.boundingBox, size = bb.getSize(new THREE.Vector3()), mid = bb.getCenter(new THREE.Vector3());
  rockGeo.translate(-mid.x, -mid.y, -mid.z);
  rockGeo.scale((2 * R) / size.x, (2 * R) / size.y, (2 * R) / size.z); // the scan is a tall shard; even it out into a boulder
  const rockMat = rockMesh.material;
  const glowMat = (key) => { const m = rockMat.clone(); m.emissive = new THREE.Color(); m.userData.glow = key; return m; };
  const MAT = { rock: rockMat, warn: glowMat("warn"), accent: glowMat("accent"), bad: glowMat("bad") };

  // Postgres: a cut stone block every boulder lands on first.
  const slabMat = new THREE.MeshStandardMaterial({ map: rockMat.map, normalMap: rockMat.normalMap, roughness: 0.85 });
  const slab = new THREE.Mesh(new THREE.BoxGeometry(3.6, SLAB.top, 4.4), slabMat);
  slab.position.set(SLAB.x, SLAB.top / 2 + ground(SLAB.x, 0) - 0.05, 0);
  slab.castShadow = slab.receiveShadow = true;
  scene.add(slab);

  // The webhook: a flag on the plateau. The cloth ripples, harder when a job lands.
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 4.2, 12), new THREE.MeshStandardMaterial({ color: 0x3a342e, roughness: 0.7 }));
  pole.position.set(FLAG_X, H + 2.1, 0);
  pole.castShadow = true;
  const flagGeo = new THREE.PlaneGeometry(2.0, 1.25, 24, 10);
  flagGeo.translate(1.0, 0, 0);
  const flagX = Array.from({ length: flagGeo.attributes.position.count }, (_, i) => flagGeo.attributes.position.getX(i));
  const flagMat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.8, emissive: new THREE.Color() });
  flagMat.userData.glow = "accent";
  const flag = new THREE.Mesh(flagGeo, flagMat);
  flag.position.set(FLAG_X + 0.06, H + 3.55, 0);
  flag.castShadow = true;
  scene.add(pole, flag);

  // Dust: a small pool of soft sprites for landings and slips.
  const dustTex = (() => {
    const c = document.createElement("canvas"); c.width = c.height = 64;
    const g = c.getContext("2d"), r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, "rgba(255,255,255,0.9)"); r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r; g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();
  const dust = Array.from({ length: 48 }, () => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: dustTex, color: 0xb8a58c, transparent: true, opacity: 0, depthWrite: false }));
    s.userData = { life: 0, v: new THREE.Vector3() };
    scene.add(s);
    return s;
  });
  let dustI = 0;
  function puff(x, y, z, n = 6) {
    for (let k = 0; k < n; k++) {
      const s = dust[dustI++ % dust.length];
      s.position.set(x + (Math.random() - 0.5), y + 0.2, z + (Math.random() - 0.5));
      s.userData.life = 1;
      s.userData.v.set((Math.random() - 0.5) * 2.2, 0.6 + Math.random() * 0.8, (Math.random() - 0.5) * 2.2);
      s.scale.setScalar(0.6);
    }
  }

  // ---- Workers: the rigged Soldier, cloned per lane, with idle, walk and run blended by weight.
  const clip = (name) => soldier.animations.find((a) => a.name === name);
  const FWD = Math.PI; // the Soldier faces -z
  const faceTo = (dx, dz) => Math.atan2(dx, dz) - FWD;
  function worker(z, i) {
    const model = cloneSkinned(soldier.scene);
    model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
    const mixer = new THREE.AnimationMixer(model);
    const acts = {};
    for (const n of ["Idle", "Walk", "Run"]) { const a = mixer.clipAction(clip(n)); a.play(); a.setEffectiveWeight(n === "Idle" ? 1 : 0); a.time = Math.random() * a.getClip().duration; acts[n] = a; }
    const bone = (n) => model.getObjectByName("mixamorig" + n);
    const w = {
      model, mixer, acts, z, x: HOME, zz: z + 1.4, state: "idle", b: null, ev: null, t: 0,
      weights: { Idle: 1, Walk: 0, Run: 0 }, target: { Idle: 1, Walk: 0, Run: 0 }, speed: 0, face: faceTo(1, 0), pose: "none", poseW: 0, lean: 0,
      bones: { spine: bone("Spine1"), neck: bone("Neck"), lArm: bone("LeftArm"), rArm: bone("RightArm"), lFore: bone("LeftForeArm"), rFore: bone("RightForeArm") },
    };
    model.position.set(w.x, ground(w.x, w.zz), w.zz);
    model.rotation.y = w.face + (i % 2 ? 0.3 : -0.3);
    scene.add(model);
    return w;
  }
  const workers = LANES.map(worker);

  // Bend one bone so its length axis (+y for Mixamo bones) points along a world direction.
  const _q = new THREE.Quaternion(), _pq = new THREE.Quaternion(), _d = new THREE.Vector3(), _t = new THREE.Quaternion();
  const UP = new THREE.Vector3(0, 1, 0);
  function aim(b, dir, k) {
    b.getWorldQuaternion(_q);
    _d.set(0, 1, 0).applyQuaternion(_q);
    _t.setFromUnitVectors(_d, dir).multiply(_q);
    b.parent.getWorldQuaternion(_pq);
    b.quaternion.slerp(_pq.invert().multiply(_t), k);
    b.updateMatrixWorld(true);
  }
  const _f = new THREE.Vector3(), _s = new THREE.Vector3(), _a = new THREE.Vector3();
  function overlayPose(w) {
    if (w.poseW < 0.01) return;
    const B = w.bones, k = w.poseW;
    w.model.updateMatrixWorld(true);
    if (w.pose === "push") {
      const ang = Math.atan(slope(w.x + 1.2));
      _f.set(Math.cos(ang), Math.sin(ang), 0);
      aim(B.spine, _a.copy(UP).multiplyScalar(Math.cos(w.lean)).addScaledVector(_f, Math.sin(w.lean)).normalize(), k);
      for (const [arm, fore, side] of [[B.lArm, B.lFore, -1], [B.rArm, B.rFore, 1]]) {
        _s.copy(_f).add(new THREE.Vector3(0, -0.12, side * 0.18)).normalize();
        aim(arm, _s, k); aim(fore, _s, k * 0.9);
      }
      aim(B.neck, _a.copy(UP).addScaledVector(_f, 0.5).normalize(), k * 0.6);
    } else if (w.pose === "cheer") {
      for (const [arm, fore, side] of [[B.lArm, B.lFore, -1], [B.rArm, B.rFore, 1]]) {
        _s.set(0.1, 1, side * 0.35).normalize();
        aim(arm, _s, k); aim(fore, _s, k);
      }
    }
  }

  // ---- HTML labels pinned to points in the world.
  const tags = [["API", SLAB.x, 11, 0], ["Postgres", SLAB.x, 0, 3.2], ["Queue", -5, 0, 6.2], ["Workers", 6.5, hill(6.5) + 3.6, -9.5], ["Your webhook", FLAG_X, H + 5.2, 0]]
    .map(([text, x, y, z]) => { const el = document.createElement("div"); el.className = "tag"; el.textContent = text; host.appendChild(el); return { el, v: new THREE.Vector3(x, y, z) }; });

  // ---- Boulders and the line.
  const stones = [], queue = [];
  let pending = [], spawnLeft = 0, spawnT = 0, inbound = 0, delivered = 0, slipped = 0, base0 = null;
  const _roll = new THREE.Quaternion(), ZAX = new THREE.Vector3(0, 0, 1), XAX = new THREE.Vector3(1, 0, 0);
  const roll = (b, dx, axis = ZAX) => { b.m.quaternion.premultiply(_roll.setFromAxisAngle(axis, -dx / R)); };
  function slot(i) {
    i = Math.min(i, VIS - 1);
    const row = i % 5, col = Math.floor(i / 5), x = -3 - col * 1.9, z = (row - 2) * 2.3 + (col % 2) * 0.6;
    return new THREE.Vector3(x, ground(x, z) + R, z);
  }
  function stone(at) {
    const m = new THREE.Mesh(rockGeo, MAT.rock);
    m.castShadow = m.receiveShadow = true;
    m.position.copy(at);
    m.quaternion.setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6));
    m.scale.setScalar(0.9 + Math.random() * 0.2);
    scene.add(m);
    const b = { m, state: "new", t: 0, v: 0 };
    stones.push(b);
    return b;
  }
  const tint = (b, key) => { b.m.material = MAT[key]; };
  const join = (b) => { b.state = "q"; queue.push(b); };
  function kill(b, i) { scene.remove(b.m); stones.splice(i, 1); }
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  function spawn() {
    if (queue.length + inbound >= VIS) { const h = stone(slot(VIS)); h.m.visible = false; join(h); return; }
    const b = stone(new THREE.Vector3(SLAB.x + (Math.random() - 0.5) * 1.5, 13, (Math.random() - 0.5) * 2));
    b.state = "drop"; b.v = 0; inbound++;
  }

  // A free worker takes the boulder at the head of the line and the next real event (ok, fail or dead).
  function dispatch() {
    for (const w of workers) {
      if (w.state !== "idle" || !pending.length) continue;
      let b = queue.shift();
      if (!b) { if (inbound > 0) return; b = stone(slot(0)); } // the picture fell behind the real queue
      b.m.visible = true; b.m.scale.setScalar(1);
      b.state = "fetch"; b.t = 0; b.from = b.m.position.clone();
      b.to = new THREE.Vector3(0.9, ground(0.9, w.z) + R, w.z);
      w.b = b; w.ev = pending.shift(); w.state = "wait";
    }
  }

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
    // The hill walks at human pace; the real queue doesn't. Jobs beyond what the workers can show
    // are delivered out of sight, straight from the hidden end of the line.
    while (pending.length > MAX_PENDING) {
      const i = pending.indexOf("ok");
      if (i < 0) { pending.length = MAX_PENDING; break; }
      pending.splice(i, 1);
      const hidden = queue.length > VIS ? queue.pop() : null;
      if (hidden) { const k = stones.indexOf(hidden); if (k >= 0) kill(hidden, k); } else if (spawnLeft > 0) spawnLeft--;
      delivered++;
    }
  }

  function stepStones(dt) {
    for (let i = stones.length - 1; i >= 0; i--) {
      const b = stones[i], p = b.m.position, ox = p.x;
      if (b.state === "drop") {
        b.v -= 16 * dt; p.y += b.v * dt;
        const floor = SLAB.top + R + ground(SLAB.x, 0) - 0.05;
        if (p.y <= floor) {
          p.y = floor;
          if (b.v < -4) { b.v *= -0.22; puff(p.x, floor - R, p.z, 5); } else { inbound--; join(b); }
        }
        roll(b, b.v * dt * 0.15, XAX);
      } else if (b.state === "q") {
        const qi = queue.indexOf(b);
        if (qi >= VIS) { b.m.visible = false; p.copy(slot(VIS)); continue; }
        if (!b.m.visible) { b.m.visible = true; b.m.scale.setScalar(0.01); }
        if (b.m.scale.x < 1) b.m.scale.setScalar(Math.min(1, b.m.scale.x + dt * 3));
        p.lerp(slot(qi), 1 - Math.exp(-dt * 2.5)); roll(b, p.x - ox);
      } else if (b.state === "fetch") {
        b.t += dt / 1.1; const k = ease(Math.min(1, b.t));
        p.lerpVectors(b.from, b.to, k); p.y = ground(p.x, p.z) + R; roll(b, p.x - ox);
        if (b.t >= 1) b.state = "ready";
      } else if (b.state === "slip") {
        b.v -= (2 + 9.8 * Math.sin(Math.atan(slope(p.x)))) * dt;
        p.x += b.v * dt; p.y = ground(p.x, p.z) + R; roll(b, p.x - ox);
        if (p.x < 0.8) {
          puff(p.x, ground(p.x, p.z), p.z, 7);
          if (b.dead) { tint(b, "bad"); b.state = "fall"; b.v = 0; }
          else { tint(b, "warn"); slipped++; b.state = "q"; queue.splice(Math.min(queue.length, VIS - 1), 0, b); }
        }
      } else if (b.state === "fall") { // dead letter: rolls off the side of the lane and away
        const oz = p.z; p.z -= 3.5 * dt; p.x -= dt; p.y = ground(p.x, p.z) + R; roll(b, oz - p.z, XAX);
        if (p.z < -24) { kill(b, i); continue; }
      } else if (b.state === "deliver") {
        b.t += dt / 1.4; const k = ease(Math.min(1, b.t));
        p.lerpVectors(b.from, b.to, k); p.y = ground(p.x, p.z) + R; roll(b, p.x - ox);
        if (b.t >= 1) { tint(b, "accent"); flag.userData.pulse = 1; delivered++; b.state = "rest"; b.t = 0; }
      } else if (b.state === "rest") { // sits by the flag a moment, then sinks out of the way
        b.t += dt;
        if (b.t > 2.2) { p.y -= dt * 0.9; if (b.t > 4.2) { kill(b, i); continue; } }
      }
    }
  }

  const angLerp = (a, b, k) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k;
  function stepWorkers(dt) {
    for (const w of workers) {
      const b = w.b;
      let speed = 0;
      w.target = { Idle: 1, Walk: 0, Run: 0 }; w.pose = "none";
      if (w.state === "idle") {
        w.x += (HOME - w.x) * Math.min(1, dt * 3); w.zz += (w.z + 1.4 - w.zz) * Math.min(1, dt * 3);
        w.face = faceTo(1, 0);
      } else if (w.state === "wait") {
        w.face = faceTo(1, 0);
        if (b.state === "ready") { w.state = "step"; w.t = 0; }
      } else if (w.state === "step") {
        const tx = b.m.position.x - R - 0.95;
        const dx = tx - w.x, dz = w.z - w.zz, d = Math.hypot(dx, dz);
        const st = Math.min(d, 1.6 * dt); if (d > 1e-3) { w.x += (dx / d) * st; w.zz += (dz / d) * st; w.face = faceTo(dx, dz); }
        speed = 1.6; w.target = { Idle: 0, Walk: 1, Run: 0 };
        if (d < 0.05) { w.state = "push"; b.state = "push"; w.face = faceTo(1, 0); w.goal = w.ev === "ok" ? X1 + 0.6 : X0 + 2 + Math.random() * (X1 - X0) * 0.6; }
      } else if (w.state === "push") {
        const bp = b.m.position, ox = bp.x, steep = slope(bp.x) / MAX_SLOPE;
        speed = Math.min(3.2, 1.5 * (1 + pending.length / 12)) * (1 - 0.3 * steep);
        bp.x = Math.min(w.goal, bp.x + speed * dt); bp.z = w.z; bp.y = ground(bp.x, bp.z) + R; roll(b, bp.x - ox);
        w.x = bp.x - R - 0.95; w.zz = w.z; w.face = faceTo(1, 0);
        w.target = speed > 2.4 ? { Idle: 0, Walk: 0, Run: 1 } : { Idle: 0, Walk: 1, Run: 0 };
        w.pose = "push"; w.lean = 0.45 + 0.35 * steep;
        if (bp.x >= w.goal) {
          if (w.ev === "ok") {
            b.state = "deliver"; b.t = 0; b.from = bp.clone();
            b.to = new THREE.Vector3(FLAG_X - 2.2 + Math.random() * 1.2, 0, w.z * 0.35); b.to.y = ground(b.to.x, b.to.z) + R;
            w.state = "cheer"; w.t = 1.1;
          } else { b.state = "slip"; b.v = 0; b.dead = w.ev === "dead"; w.state = "dodge"; w.t = 0.7; }
          w.b = null;
        }
      } else if (w.state === "cheer") {
        w.t -= dt; w.pose = "cheer"; if (w.t <= 0) w.state = "down";
      } else if (w.state === "dodge") { // the boulder slips: jump out of its way
        w.t -= dt; speed = 3; w.zz += 3.2 * dt; w.face = faceTo(0.2, 1); w.target = { Idle: 0, Walk: 0, Run: 1 };
        if (w.t <= 0) w.state = "down";
      } else if (w.state === "down") {
        const dx = HOME - w.x, dz = w.z + 1.4 - w.zz, d = Math.hypot(dx, dz);
        speed = Math.min(5, 3.6 * (1 + pending.length / 30));
        const st = Math.min(d, speed * dt); if (d > 1e-3) { w.x += (dx / d) * st; w.zz += (dz / d) * st; w.face = faceTo(dx, dz); }
        w.target = { Idle: 0, Walk: 0, Run: 1 };
        if (d < 0.05) w.state = "idle";
      }
      // Blend animations toward their targets; walk and run play at the speed the body actually moves.
      for (const n of ["Idle", "Walk", "Run"]) {
        w.weights[n] += (w.target[n] - w.weights[n]) * Math.min(1, dt * 6);
        w.acts[n].setEffectiveWeight(w.weights[n]);
      }
      w.acts.Walk.timeScale = THREE.MathUtils.clamp(speed / 1.4, 0.5, 2);
      w.acts.Run.timeScale = THREE.MathUtils.clamp(speed / 3.8, 0.6, 1.5);
      const want = w.pose === "none" ? 0 : 1;
      w.poseW += (want - w.poseW) * Math.min(1, dt * 7);
      if (w.pose === "none" && w.poseW > 0.01) w.pose = w.lastPose; else if (w.pose !== "none") w.lastPose = w.pose;
      w.mixer.update(dt);
      w.model.position.set(w.x, ground(w.x, w.zz), w.zz);
      w.model.rotation.y = angLerp(w.model.rotation.y, w.face, Math.min(1, dt * 8));
      overlayPose(w);
    }
  }

  // ---- Camera: a three-quarter view up the slope. On wide screens the frame shifts right so the
  // copy on the left sits over open sky. Drag to swing it a little.
  const cam = new THREE.PerspectiveCamera(30, 1, 0.5, 600);
  const look = new THREE.Vector3(5.5, 2.6, 0);
  let sway = 0, swayT = 0, yaw = 0, yawT = 0, drag = null;
  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    gl.setSize(w, h, false);
    cam.aspect = w / h;
    const wide = w > 900;
    cam.userData = { yaw0: wide ? -0.3 : -0.4, dist: wide ? 48 : Math.max(46, 50 / cam.aspect), pitch: wide ? 0.2 : 0.28, shift: wide ? -0.12 : 0 };
    look.x = wide ? 5.5 : 3.5;
    cam.filmOffset = cam.userData.shift * cam.getFilmWidth();
    cam.updateProjectionMatrix();
    render();
  }
  function place() {
    const { yaw0 = -0.34, dist = 46, pitch = 0.3 } = cam.userData, a = yaw0 + yaw + sway * 0.06;
    cam.position.set(look.x + Math.sin(a) * dist, look.y + dist * pitch, look.z + Math.cos(a) * dist);
    cam.lookAt(look);
  }
  host.addEventListener("pointermove", (e) => {
    const r = host.getBoundingClientRect();
    swayT = ((e.clientX - r.left) / r.width - 0.5) * 2;
    if (drag) yawT = THREE.MathUtils.clamp(drag.y0 + (e.clientX - drag.x) / 320, -0.6, 0.6);
  });
  host.addEventListener("pointerleave", () => { swayT = 0; drag = null; });
  host.addEventListener("pointerdown", (e) => { if (e.target === canvas) { drag = { x: e.clientX, y0: yawT }; canvas.style.cursor = "grabbing"; } });
  addEventListener("pointerup", () => { drag = null; canvas.style.cursor = ""; });

  let visible = true;
  new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (!visible) { pending = []; spawnLeft = 0; } }).observe(host);

  const _p = new THREE.Vector3();
  function labels() {
    const w = host.clientWidth, h = host.clientHeight;
    for (const t of tags) {
      _p.copy(t.v).project(cam);
      const half = t.el.offsetWidth / 2 + 8, x = THREE.MathUtils.clamp((_p.x + 1) / 2 * w, half, w - half);
      t.el.style.transform = `translate(${x.toFixed(1)}px,${((1 - _p.y) / 2 * h).toFixed(1)}px) translate(-50%,-50%)`;
      t.el.style.opacity = _p.z < 1 ? "" : "0";
    }
  }
  function render() { place(); gl.render(scene, cam); labels(); }

  // ---- Theme: daylight for light mode, a dim dusk for dark mode. Glow colours come from the page tokens.
  function applyTheme() {
    const dark = darkMQ.matches, cs = getComputedStyle(document.documentElement);
    const tok = (k) => new THREE.Color(cs.getPropertyValue("--" + k).trim());
    gl.toneMappingExposure = dark ? 0.42 : 0.95;
    scene.backgroundIntensity = dark ? 0.5 : 1;
    scene.environmentIntensity = dark ? 0.6 : 1;
    sun.intensity = dark ? 1.4 : 3;
    sun.color.set(dark ? 0xc8d4ff : 0xfff0dc);
    scene.fog.color.copy(horizon).multiplyScalar(dark ? 0.55 : 1);
    flagMat.color.copy(tok("accent"));
    for (const m of [MAT.warn, MAT.accent, MAT.bad, flagMat]) m.emissive.copy(tok(m.userData.glow));
    MAT.warn.emissiveIntensity = dark ? 0.3 : 0.16;
    MAT.accent.emissiveIntensity = dark ? 0.45 : 0.25;
    MAT.bad.emissiveIntensity = dark ? 0.4 : 0.25;
  }

  let last = performance.now(), hudT = 0;
  const perf = { n: 0, sum: 0 };
  function frame(now) {
    requestAnimationFrame(frame);
    const raw = Math.min(0.5, (now - last) / 1000);
    last = now;
    if (!visible || document.hidden) return;
    // Slow device: after 60 normal frames, drop shadows and render at 1x so the hill keeps moving.
    if (perf.n < 60 && raw < 0.25) {
      perf.n++; perf.sum += raw;
      if (perf.n === 60 && perf.sum / 60 > 1 / 30) {
        gl.shadowMap.enabled = false; gl.setPixelRatio(1);
        scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
        resize();
      }
    }
    // Fixed substeps keep the physics stable and in real time even when frames are slow.
    for (let left = raw; left > 1e-4; left -= 0.04) {
      const dt = Math.min(0.04, left);
      sway += (swayT - sway) * Math.min(1, dt * 2); yaw += (yawT - yaw) * Math.min(1, dt * 4); if (!drag) yawT *= Math.pow(0.4, dt);
      spawnT -= dt;
      while (spawnLeft > 0 && spawnT <= 0) { spawn(); spawnLeft--; spawnT += 0.12; }
      if (spawnT < 0) spawnT = 0;
      dispatch(); stepStones(dt); stepWorkers(dt);
      for (const s of dust) {
        const u = s.userData; if (u.life <= 0) continue;
        u.life -= dt * 0.8; s.position.addScaledVector(u.v, dt); u.v.multiplyScalar(1 - dt * 1.5);
        s.scale.setScalar(0.6 + (1 - u.life) * 2.4); s.material.opacity = Math.max(0, u.life) * 0.45;
      }
      if (flag.userData.pulse > 0) flag.userData.pulse = Math.max(0, flag.userData.pulse - dt * 1.5);
      hudT -= dt;
    }
    const fl = flag.userData.pulse || 0, fp = flagGeo.attributes.position;
    for (let i = 0; i < fp.count; i++) { const x = flagX[i]; fp.setZ(i, Math.sin(x * 3.2 - now / 160) * (0.12 + fl * 0.2) * (x / 2)); }
    fp.needsUpdate = true; flagGeo.computeVertexNormals();
    flagMat.emissiveIntensity = 0.15 + fl * 0.9;
    if (hudT <= 0) {
      hudT = 0.15;
      $("hq").textContent = queue.length + inbound;
      $("hw").textContent = workers.filter((w) => w.state === "push" || w.state === "step" || w.state === "wait").length;
      $("hd").textContent = delivered; $("hs").textContent = slipped;
      tags[2].el.textContent = queue.length > VIS ? `Queue, ${queue.length - VIS} more out of sight` : "Queue";
      if (hint) { hint.textContent = "The hill is quiet. Press Run 100 jobs and one in five will slip on its first try."; hint.className = "hint" + (stones.length || pending.length || spawnLeft ? " off" : ""); }
    }
    render();
  }

  applyTheme();
  darkMQ.addEventListener("change", () => { applyTheme(); render(); });
  new ResizeObserver(resize).observe(host);
  resize();
  host.classList.add("ready");
  window.relayqHill = { ingest };
  if (reduce) {
    stepWorkers(0); render();
    if (hint) { hint.textContent = "Animation is off because your system asks for reduced motion. The numbers below are live."; hint.className = "hint"; }
  } else {
    if (hint) hint.className = "hint";
    requestAnimationFrame(frame);
  }
}
