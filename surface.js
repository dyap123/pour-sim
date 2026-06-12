/* ============================================================
   OpenPour — realistic concrete surface (surface nets)
   Builds a smooth isosurface over the concrete voxel field:
   binary occupancy → 1-2-1 separable blur → surface nets
   (one vertex per sign-change cell at the average of its edge
   crossings, quads across every sign-change lattice edge).
   Table-free and CPU-cheap; rebuilds are bbox-restricted.
   ============================================================ */
import * as THREE from 'three';

const ISO = 0.4;

// 128px tileable value-noise texture for albedo detail + bump
function makeNoiseTex() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const img = g.createImageData(128, 128);
  // low-frequency lattice noise, bilinear-ish via two octaves of random blocks
  const lat = (n) => {
    const v = new Float32Array(n * n);
    for (let i = 0; i < v.length; i++) v[i] = Math.random();
    return (x, y) => {
      const gx = (x * n) % n, gy = (y * n) % n;
      const x0 = gx | 0, y0 = gy | 0, fx = gx - x0, fy = gy - y0;
      const x1 = (x0 + 1) % n, y1 = (y0 + 1) % n;
      const a = v[x0 + y0 * n] * (1 - fx) + v[x1 + y0 * n] * fx;
      const b = v[x0 + y1 * n] * (1 - fx) + v[x1 + y1 * n] * fx;
      return a * (1 - fy) + b * fy;
    };
  };
  const n1 = lat(8), n2 = lat(23), n3 = lat(61);
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 128; x++) {
      const u = x / 128, w = y / 128;
      const v = 0.5 * n1(u, w) + 0.32 * n2(u, w) + 0.18 * n3(u, w);
      const k = (x + y * 128) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = (v * 255) | 0;
      img.data[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export function createSurface(ctx) {
  const { GX, GY, GZ, FORM, CONC, grid, born, idx, inB } = ctx;
  // sample lattice covers grid coords -1 .. G+1 (sample index = coord + 1)
  const SX = GX + 3, SY = GY + 3, SZ = GZ + 3;
  const NS = SX * SY * SZ;
  const sidx = (x, y, z) => x + z * SX + y * SX * SZ;
  const dens = new Float32Array(NS);
  const tmp = new Float32Array(NS);
  const cellV = new Int32Array(NS);

  const MAXV = Math.min(200000, Math.max(90000, GX * GZ * 22));
  const MAXI = Math.ceil(MAXV * 16 / 3);
  const pos = new Float32Array(MAXV * 3);
  const nrm = new Float32Array(MAXV * 3);
  const col = new Float32Array(MAXV * 3);
  const wet = new Float32Array(MAXV);
  const index = new Uint32Array(MAXI);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('wet', new THREE.BufferAttribute(wet, 1));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.setDrawRange(0, 0);

  const noiseTex = makeNoiseTex();
  const mat = new THREE.MeshPhongMaterial({
    vertexColors: true,
    specular: new THREE.Color(0x9aa2aa),
    shininess: 70,
    side: THREE.DoubleSide,
  });
  // per-vertex wet sheen (fresh = glossy) + world-projected concrete detail:
  // albedo mottling and a hand-rolled bump from noise derivatives (the mesh
  // has no UVs, so the built-in bump-map chain can't be used).
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.detailMap = { value: noiseTex };
    shader.vertexShader =
      'attribute float wet;\nvarying float vWet;\nvarying vec3 vWp;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvWet = wet;\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;'
      );
    shader.fragmentShader =
      'uniform sampler2D detailMap;\nvarying float vWet;\nvarying vec3 vWp;\n' +
      shader.fragmentShader
        .replace(
          '#include <map_fragment>',
          '#include <map_fragment>\n' +
          'float dN = texture2D(detailMap, vWp.xz * 0.22).r;\n' +
          'float dN2 = texture2D(detailMap, vWp.xz * 0.045 + vec2(vWp.y * 0.1)).r;\n' +
          'diffuseColor.rgb *= 0.88 + 0.18 * dN + 0.08 * dN2;'
        )
        .replace(
          '#include <normal_fragment_maps>',
          '#include <normal_fragment_maps>\n' +
          'vec2 bUv = vWp.xz * 0.22;\n' +
          'float bH  = texture2D(detailMap, bUv).r;\n' +
          'float bHx = texture2D(detailMap, bUv + vec2(0.012, 0.0)).r;\n' +
          'float bHz = texture2D(detailMap, bUv + vec2(0.0, 0.012)).r;\n' +
          'normal = normalize(normal + vec3(bH - bHx, 0.0, bH - bHz) * (2.2 - 1.4 * vWet));'
        )
        .replace('#include <specularmap_fragment>', 'float specularStrength = 0.08 + 0.9 * vWet;');
  };

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.visible = false;

  const colFresh = new THREE.Color(0x6f746c);
  const colCured = new THREE.Color(0xa7a79f);
  const _c = new THREE.Color();

  // 8 dual-cell corner offsets and the 12 edges between them
  const CORN = [[0,0,0],[1,0,0],[0,1,0],[1,1,0],[0,0,1],[1,0,1],[0,1,1],[1,1,1]];
  const EDGE = [[0,1],[2,3],[4,5],[6,7],[0,2],[1,3],[4,6],[5,7],[0,4],[1,5],[2,6],[3,7]];

  let stats = { verts: 0, tris: 0, ms: 0 };

  function densityAt(gx, gy, gz) {
    if (inB(gx, gy, gz)) {
      const v = grid[idx(gx, gy, gz)];
      if (v === CONC) return 1;
      if (v !== FORM) return 0;
    } else if (gy !== -1 || gx < 0 || gx >= GX || gz < 0 || gz >= GZ) {
      return 0;
    }
    // FORM cell or floor cell: solid backing iff it touches concrete,
    // so the surface runs into forms/ground instead of pulling away
    for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
      const nx = gx + dx, ny = gy + dy, nz = gz + dz;
      if (inB(nx, ny, nz) && grid[idx(nx, ny, nz)] === CONC) return 1;
    }
    return 0;
  }

  /* bbox in grid coords (inclusive). simTime/setSec for cure coloring. */
  function rebuild(bbox, simTime, setSec) {
    const t0 = performance.now();
    // padded region in sample coords
    const x0 = Math.max(0, bbox[0][0] - 1), x1 = Math.min(SX - 1, bbox[1][0] + 3);
    const y0 = Math.max(0, bbox[0][1] - 1), y1 = Math.min(SY - 1, bbox[1][1] + 3);
    const z0 = Math.max(0, bbox[0][2] - 1), z1 = Math.min(SZ - 1, bbox[1][2] + 3);
    if (x1 <= x0 || y1 <= y0 || z1 <= z0) { geo.setDrawRange(0, 0); stats = { verts: 0, tris: 0, ms: 0 }; return stats; }

    // 1. occupancy
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++)
          dens[sidx(x, y, z)] = densityAt(x - 1, y - 1, z - 1);

    // 2. separable 1-2-1 blur (x, then z, then y); out-of-region taps read 0
    const blur = (stride, axis) => {
      const a0 = [x0, y0, z0][axis], a1 = [x1, y1, z1][axis];
      for (let y = y0; y <= y1; y++)
        for (let z = z0; z <= z1; z++)
          for (let x = x0; x <= x1; x++) {
            const i = sidx(x, y, z);
            const c = [x, y, z][axis];
            const lo = c > a0 ? dens[i - stride] : 0;
            const hi = c < a1 ? dens[i + stride] : 0;
            tmp[i] = (lo + 2 * dens[i] + hi) / 4;
          }
      for (let y = y0; y <= y1; y++)
        for (let z = z0; z <= z1; z++)
          for (let x = x0; x <= x1; x++) {
            const i = sidx(x, y, z);
            dens[i] = tmp[i];
          }
    };
    blur(1, 0);          // x
    blur(SX, 2);         // z
    blur(SX * SZ, 1);    // y

    // 3. surface nets — vertices
    let nv = 0, ni = 0;
    const ex = [0, 0, 0]; // edge-crossing accumulator
    for (let y = y0; y < y1; y++)
      for (let z = z0; z < z1; z++)
        for (let x = x0; x < x1; x++) {
          const ci = sidx(x, y, z);
          let mask = 0;
          for (let k = 0; k < 8; k++) {
            if (dens[sidx(x + CORN[k][0], y + CORN[k][1], z + CORN[k][2])] >= ISO) mask |= 1 << k;
          }
          if (mask === 0 || mask === 255) { cellV[ci] = -1; continue; }
          if (nv >= MAXV) { cellV[ci] = -1; continue; }
          ex[0] = 0; ex[1] = 0; ex[2] = 0;
          let ne = 0;
          for (const [a, b] of EDGE) {
            const da = dens[sidx(x + CORN[a][0], y + CORN[a][1], z + CORN[a][2])];
            const db = dens[sidx(x + CORN[b][0], y + CORN[b][1], z + CORN[b][2])];
            if ((da >= ISO) === (db >= ISO)) continue;
            const t = (ISO - da) / (db - da);
            ex[0] += CORN[a][0] + t * (CORN[b][0] - CORN[a][0]);
            ex[1] += CORN[a][1] + t * (CORN[b][1] - CORN[a][1]);
            ex[2] += CORN[a][2] + t * (CORN[b][2] - CORN[a][2]);
            ne++;
          }
          // sample coord → world: grid coord = sample - 1, cell center offset +0.5
          pos[nv * 3] = x - 1 + ex[0] / ne + 0.5;
          pos[nv * 3 + 1] = y - 1 + ex[1] / ne + 0.5;
          pos[nv * 3 + 2] = z - 1 + ex[2] / ne + 0.5;
          // gradient normal from corner sums (points out of the concrete)
          let gx = 0, gy = 0, gz = 0;
          for (let k = 0; k < 8; k++) {
            const d = dens[sidx(x + CORN[k][0], y + CORN[k][1], z + CORN[k][2])];
            gx += CORN[k][0] ? d : -d;
            gy += CORN[k][1] ? d : -d;
            gz += CORN[k][2] ? d : -d;
          }
          const gl = Math.hypot(gx, gy, gz) || 1;
          nrm[nv * 3] = -gx / gl;
          nrm[nv * 3 + 1] = -gy / gl;
          nrm[nv * 3 + 2] = -gz / gl;
          // cure color from the youngest CONC corner of this cell
          let bn = -1;
          for (let k = 0; k < 8; k++) {
            const cx = x - 1 + CORN[k][0], cy = y - 1 + CORN[k][1], cz = z - 1 + CORN[k][2];
            if (inB(cx, cy, cz) && grid[idx(cx, cy, cz)] === CONC) {
              const b = born[idx(cx, cy, cz)];
              if (bn < 0 || b > bn) bn = b;
            }
          }
          const age = bn < 0 ? 1 : Math.min(1, (simTime - bn) / setSec);
          _c.copy(colFresh).lerp(colCured, age);
          col[nv * 3] = _c.r; col[nv * 3 + 1] = _c.g; col[nv * 3 + 2] = _c.b;
          wet[nv] = 1 - age;
          cellV[ci] = nv;
          nv++;
        }

    // 4. quads across sign-change lattice edges (two triangles each)
    const axes = [
      { d: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
      { d: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0] },
      { d: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    ];
    for (let y = y0 + 1; y < y1; y++)
      for (let z = z0 + 1; z < z1; z++)
        for (let x = x0 + 1; x < x1; x++) {
          const d0 = dens[sidx(x, y, z)];
          for (const { d, u, v } of axes) {
            const nx = x + d[0], ny = y + d[1], nz = z + d[2];
            if (nx >= x1 + 1 || ny >= y1 + 1 || nz >= z1 + 1) continue;
            const d1 = dens[sidx(nx, ny, nz)];
            if ((d0 >= ISO) === (d1 >= ISO)) continue;
            const c00 = cellV[sidx(x - u[0] - v[0], y - u[1] - v[1], z - u[2] - v[2])];
            const c10 = cellV[sidx(x - v[0], y - v[1], z - v[2])];
            const c01 = cellV[sidx(x - u[0], y - u[1], z - u[2])];
            const c11 = cellV[sidx(x, y, z)];
            if (c00 < 0 || c10 < 0 || c01 < 0 || c11 < 0) continue;
            if (ni + 6 > MAXI) break;
            if (d0 >= ISO) {
              index[ni++] = c00; index[ni++] = c10; index[ni++] = c11;
              index[ni++] = c00; index[ni++] = c11; index[ni++] = c01;
            } else {
              index[ni++] = c00; index[ni++] = c11; index[ni++] = c10;
              index[ni++] = c00; index[ni++] = c01; index[ni++] = c11;
            }
          }
        }

    geo.setDrawRange(0, ni);
    for (const k of ['position', 'normal', 'color', 'wet']) geo.attributes[k].needsUpdate = true;
    geo.index.needsUpdate = true;
    stats = { verts: nv, tris: ni / 3, ms: performance.now() - t0 };
    return stats;
  }

  function dispose() {
    geo.dispose();
    mat.dispose();
    noiseTex.dispose();
  }

  return { mesh, rebuild, dispose, stats: () => stats };
}
