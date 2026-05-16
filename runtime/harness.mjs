// harness.js
// Node 18+
// 依赖：npm i @webgpu/types pngjs crypto-js minimist
// 若需纯 Node PNG：使用 pngjs；SHA-256 用 crypto-js；pHash/DCT 手写。

import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import minimist from 'minimist';
import CryptoJS from 'crypto-js';

// ---- WebGPU 获取（Chrome/Node with Dawn/edge-runtime 均可） ----
if (!globalThis.navigator) globalThis.navigator = {};
// 在 Node 环境使用 @webgpu/types 的全局声明，实际 runtime 需带 WebGPU 支持
// 若你在纯 Node 无适配，可切换到 headless-webgpu 之类运行时。

const args = minimist(process.argv.slice(2), {
  default: { frames: 30, w: 256, h: 256, tiles: 4, dt: 0.5, verbose: false }
});
const W = +args.w, H = +args.h, FRAMES = +args.frames, TILES = +args.tiles;
const DT_Q16 = Math.round(args.dt * 65536);

const OUT = path.join('..', 'out', 'artifacts');
const TILES_DIR = path.join(OUT, 'tiles');
const THUMBS_DIR = path.join(OUT, 'thumbs');
fs.mkdirSync(TILES_DIR, { recursive: true });
fs.mkdirSync(THUMBS_DIR, { recursive: true });

function sha256_hex(u8) {
  const w = CryptoJS.lib.WordArray.create(u8);
  return CryptoJS.SHA256(w).toString(CryptoJS.enc.Hex);
}

// 简易 8x8 DCT + 中值阈得 64-bit pHash
function phash64(grayU8, w, h) {
  const N = 8;
  // 缩放到 32x32 再做 DCT→取左上 8x8，演示用最近邻
  const S = 32, sBuf = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const sx = Math.min(w - 1, Math.round(x * (w / S)));
    const sy = Math.min(h - 1, Math.round(y * (h / S)));
    sBuf[y*S + x] = grayU8[sy*w + sx] / 255;
  }
  // DCT-II（慢版）
  const C = (n,k) => (k===0? Math.sqrt(1/n): Math.sqrt(2/n));
  const dct = new Float32Array(S*S);
  for (let v=0; v<S; v++) for (let u=0; u<S; u++) {
    let sum = 0;
    for (let y=0; y<S; y++) for (let x=0; x<S; x++) {
      sum += sBuf[y*S+x] *
        Math.cos((Math.PI*(2*x+1)*u)/(2*S)) *
        Math.cos((Math.PI*(2*y+1)*v)/(2*S));
    }
    dct[v*S+u] = C(S,u)*C(S,v)*sum;
  }
  // 取 8x8 去掉 DC，再做中值阈
  const block = [];
  for (let v=0; v<8; v++) for (let u=0; u<8; u++) block.push(dct[v*S+u]);
  const dc = block[0];
  const rest = block.slice(1);
  const med = rest.slice().sort((a,b)=>a-b)[Math.floor(rest.length/2)];
  let bitsBigInt = 0n;
  for (let i=0;i<64;i++){
    const val = (i===0? dc : rest[i-1]);
    bitsBigInt = (bitsBigInt<<1n) | (val > med ? 1n : 0n);
  }
  return bitsBigInt; // BigInt 64-bit
}

// 生成初始纹理与速度（确定性）
function makeInitialFields(w,h){
  const src = new Float32Array(w*h);
  const vel = new Uint32Array(w*h*2);
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){
    // 演示：中心高斯斑
    const dx = (x - w/2)/w, dy=(y - h/2)/h;
    src[y*w+x] = Math.exp(-(dx*dx+dy*dy)*80);

    // 速度：绕中心的匀角速度场（16.16 定点）
    const vx = -dy*80/ h; // 适度缩放
    const vy =  dx*80/ w;
    vel[(y*w+x)*2+0] = (vx * 65536) | 0;
    vel[(y*w+x)*2+1] = (vy * 65536) | 0;
  }
  return {src, vel};
}

// CPU 路径兜底（无 WebGPU 时仍可产物）——可与 WGSL 对拍
function cpuStep(dst, src, vel, w, h, dt){
  const clamp = (v,lo,hi)=>Math.max(lo,Math.min(v,hi));
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){
    const vx = (vel[(y*w+x)*2+0] |0) / 65536;
    const vy = (vel[(y*w+x)*2+1] |0) / 65536;
    const sx = clamp(x - vx*dt, 0, w-1);
    const sy = clamp(y - vy*dt, 0, h-1);
    const x0 = Math.floor(sx), y0 = Math.floor(sy);
    const x1 = Math.min(x0+1, w-1), y1 = Math.min(y0+1, h-1);
    const fx = sx - x0, fy = sy - y0;
    const s00 = src[y0*w+x0], s10=src[y0*w+x1], s01=src[y1*w+x0], s11=src[y1*w+x1];
    const a = s00*(1-fx)+s10*fx, b = s01*(1-fx)+s11*fx;
    dst[y*w+x]= a*(1-fy)+b*fy;
  }
}

// 写 PNG（灰度→RGBA）
function writePNGGray(fname, bufF32, w, h){
  const png = new PNG({width:w, height:h});
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){
    const v = Math.max(0, Math.min(1, bufF32[y*w+x]));
    const g = Math.round(v*255);
    const idx = (y*w+x)*4;
    png.data[idx+0]=g; png.data[idx+1]=g; png.data[idx+2]=g; png.data[idx+3]=255;
  }
  fs.writeFileSync(fname, PNG.sync.write(png));
}

(async () => {
  const summary = [];
  const {src, vel} = makeInitialFields(W,H);
  let A = new Float32Array(src);    // ping
  let B = new Float32Array(W*H);    // pong

  for (let f=0; f<FRAMES; f++){
    cpuStep(B, A, vel, W, H, DT_Q16/65536);
    // 交换
    const tmp=A; A=B; B=tmp;

    // 分瓦片哈希（lexicographic bytes）
    const tilesPer = TILES; // e.g. 4 -> 4x4
    const tw = Math.floor(W/tilesPer), th = Math.floor(H/tilesPer);
    const tilesLine = [];
    for (let ty=0; ty<tilesPer; ty++){
      for (let tx=0; tx<tilesPer; tx++){
        const bytes = new Uint8Array(tw*th);
        for (let y=0;y<th;y++) for (let x=0;x<tw;x++){
          const g = Math.max(0, Math.min(255, Math.round( A[(ty*th + y)*W + (tx*tw + x)]*255 )));
          bytes[y*tw+x]=g;
        }
        const hash = sha256_hex(bytes);
        tilesLine.push({tx,ty,sha256:hash});
      }
    }
    const ndjsonLine = { frame:f, tiles: tilesLine };
    fs.appendFileSync(path.join(TILES_DIR, `frame-${f}.ndjson`), JSON.stringify(ndjsonLine) + '\n');

    // 整帧缩略图与 pHash
    const thumbPath = path.join(THUMBS_DIR, `frame-${f}.png`);
    writePNGGray(thumbPath, A, W, H);
    // pHash on 8-bit灰度
    const gray8 = new Uint8Array(W*H);
    for (let i=0;i<gray8.length;i++) gray8[i]=Math.max(0, Math.min(255, Math.round(A[i]*255)));
    const p64 = phash64(gray8, W, H).toString(16).padStart(16,'0');
    const shaFull = sha256_hex(gray8);

    summary.push({ frame:f, sha256: shaFull, phash64: p64 });
    if (args.verbose) console.log(`[frame ${f}] sha=${shaFull.slice(0,12)}.. pHash=${p64}`);
  }

  fs.writeFileSync(path.join(OUT,'summary.json'), JSON.stringify({
    width: W, height: H, frames: FRAMES, tilesPerSide: TILES, dt_q16: DT_Q16, summary
  }, null, 2));

  console.log(`完成：${FRAMES} 帧 -> ${OUT}\n- summary.json\n- tiles/frame-*.ndjson\n- thumbs/frame-*.png`);
})();