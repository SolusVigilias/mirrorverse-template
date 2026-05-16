#!/usr/bin/env node

/* 抽取环境关键信息（GPU/驱动/适配器）。
 * 为每一帧生成 tile→SHA 映射与 64-bit pHash（感知哈希，便于模糊比对）。
 * 摘取 pdffonts / qpdf 的检查输出（若存在）。
 * 基于启发式给出前三大可能原因的排序：驱动非确定性 / 字体嵌入或 qpdf 错误 / 算法漂移。
*/
 
/*
 * Tiny triage: provenance + artifacts → compact triage.json
 * 输入: provenance-with-sha.json
 * 输出: triage.json（写到 stdout）
 *
 * 输出结构:
 * {
 *   meta: { adapter, driver, date, ci: {...} },
 *   frames: {
 *     "0": { tiles: {"0,0": "sha256:...", ...}, phash64: "0x...." },
 *     "1": { ... }
 *   },
 *   checks: { pdffonts: "...", qpdf: "..." },
 *   diagnosis: {
 *     ranked: [
 *       { cause: "driver-nondeterminism", score: 0.73, signals: [...] },
 *       { cause: "font-embed-or-qpdf",    score: 0.19, signals: [...] },
 *       { cause: "algorithmic-drift",     score: 0.08, signals: [...] }
 *     ]
 *   }
 * }
 */

import fs from "fs";
import path from "path";
import sharp from "sharp";

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("用法: node parse-provenance.js provenance-with-sha.json > triage.json");
  process.exit(1);
}
const artifactSummaryPath = process.argv[3];

let artifactSummary = null;
if (artifactSummaryPath && fs.existsSync(artifactSummaryPath)) {
  artifactSummary = JSON.parse(fs.readFileSync(artifactSummaryPath, "utf8"));
}

const PROV_PATH = args[0];
const ART_DIR = process.env.ARTIFACTS_DIR || "artifacts";
const prov = JSON.parse(fs.readFileSync(PROV_PATH, "utf8"));

// ---------- 小工具 ----------
const exists = (p) => fs.existsSync(p);
const readIf = (p) => (exists(p) ? fs.readFileSync(p, "utf8") : "");

// 2D DCT（简洁实现，N×N）
function dct2D(matrix) {
  const N = matrix.length;
  const C = Array.from({ length: N }, () => Array(N).fill(0));
  const alpha = (k) => (k === 0 ? Math.sqrt(1 / N) : Math.sqrt(2 / N));
  for (let u = 0; u < N; u++) {
    for (let v = 0; v < N; v++) {
      let sum = 0;
      for (let x = 0; x < N; x++) {
        for (let y = 0; y < N; y++) {
          sum +=
            matrix[x][y] *
            Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N)) *
            Math.cos(((2 * y + 1) * v * Math.PI) / (2 * N));
        }
      }
      C[u][v] = alpha(u) * alpha(v) * sum;
    }
  }
  return C;
}

// 64-bit pHash：32×32 灰度 → DCT → 取左上 8×8 去掉 DC，阈值=中位数
async function pHash64(imagePath) {
  if (!exists(imagePath)) return null;
  const N = 32;
  const buf = await sharp(imagePath).grayscale().resize(N, N, { fit: "fill" }).raw().toBuffer();
  // 构成矩阵
  const M = Array.from({ length: N }, () => Array(N).fill(0));
  for (let i = 0; i < buf.length; i++) {
    const r = Math.floor(i / N);
    const c = i % N;
    M[r][c] = buf[i]; // 0..255
  }
  const C = dct2D(M);
  // 取 8×8（u,v ∈ [0..7]），跳过 (0,0)
  const small = [];
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      if (u === 0 && v === 0) continue;
      small.push(C[u][v]);
    }
  }
  // 阈值用中位数
  const sorted = [...small].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  // 取前 64 位（含 DC 会 63+1=64，这里 DC 略过，所以我们取 small 的前 64 个）
  const take = small.slice(0, 64);
  let bits = BigInt(0);
  for (let i = 0; i < take.length; i++) {
    if (i >= 64) break;
    bits = (bits << 1n) | (take[i] > median ? 1n : 0n);
  }
  return "0x" + bits.toString(16).padStart(16, "0"); // 64-bit
}
function hammingHex64(a, b) {
  if (!a || !b) return null;

  const x = BigInt("0x" + a) ^ BigInt("0x" + b);

  let n = x;
  let count = 0;

  while (n > 0n) {
    count += Number(n & 1n);
    n >>= 1n;
  }

  return count;
}
// 统计工具
const uniq = (arr) => Array.from(new Set(arr));
const ratio = (a, b) => (b === 0 ? 0 : a / b);

// ---------- 抽取 meta ----------
const meta = {
  adapter: prov?.env?.gpu?.adapter || prov?.env?.adapter || "",
  driver: prov?.env?.gpu?.driver || prov?.env?.driver || "",
  date: prov?.build?.date || new Date().toISOString(),
  ci: {
    provider: prov?.ci?.provider || "",
    jobId: prov?.ci?.jobId || "",
    runner: prov?.ci?.runner || ""
  }
};

// ---------- 提取 frames: tiles + pHash ----------
const frames = {};
let frameEntries =
  Array.isArray(prov?.frames) ? prov.frames :
  Array.isArray(prov?.outputs) ? prov.outputs :
  Array.isArray(prov?.trajectory) ? prov.trajectory :
  Array.isArray(prov?.artifacts?.frames) ? prov.artifacts.frames :
  Array.isArray(prov?.render?.frames) ? prov.render.frames :
  Array.isArray(prov?.artifacts) ? prov.artifacts :
  [];
if (frameEntries && !Array.isArray(frameEntries) && typeof frameEntries === "object") {
  frameEntries = Object.entries(frameEntries).map(([key, value]) => ({
    id: key,
    ...(value && typeof value === "object" ? value : { value })
  }));
}

if (!Array.isArray(frameEntries)) {
  frameEntries = [];
}
for (const f of frameEntries) {
  const id = String(f.index ?? f.id ?? f.frame ?? 0);
  const tiles = {};
  if (f.tiles) {
    for (const t of f.tiles) {
      const key = `${t.x},${t.y}`;
      tiles[key] = t.sha || t.sha256 || t.hash || "";
    }
  }
  // 按约定位置寻找帧图（可自定义）
  const guessPng = path.join(ART_DIR, "frames", `${id}.png`);
  const phash64 = await pHash64(guessPng);
  frames[id] = { tiles, phash64 };
  const frameIds = Object.keys(frames).sort((a, b) => Number(a) - Number(b));

  for (let i = 0; i < frameIds.length; i++) {
    const id = frameIds[i];
    const prevId = frameIds[i - 1];

    frames[id].hammingFromPrev =
      i === 0 ? null : hammingHex64(frames[id].phash64, frames[prevId].phash64);
  }
}

// ---------- 读检查输出 ----------
const checks = {
  pdffonts: readIf(path.join(ART_DIR, "pdffonts.txt")).trim(),
  qpdf: readIf(path.join(ART_DIR, "qpdf-check.txt")).trim()
};

// ---------- 诊断启发式（简单可扩展） ----------
function diagnose({ meta, frames, checks }) {
  // 信号提取
  const driverSig = `${meta.adapter} ${meta.driver}`.toLowerCase();
  const hasNvidia = /nvidia|geforce|rtx|gtx/.test(driverSig);
  const hasAmd = /amd|radeon/.test(driverSig);
  const hasIntel = /intel|arc|uhd|iris/.test(driverSig);

  const phashes = Object.values(frames).map((f) => f.phash64).filter(Boolean);
  const uniqueP = uniq(phashes).length;
  const phashVar = ratio(uniqueP - 1, Math.max(1, phashes.length - 1)); // 0..1

  const allTileShas = [];
  for (const f of Object.values(frames)) allTileShas.push(...Object.values(f.tiles));
  const uniqueTile = uniq(allTileShas).length;
  const tileVar = ratio(uniqueTile - 1, Math.max(1, allTileShas.length - 1));

  const fontWarn = /missing font|not embedded|substitut|encoding/i.test(checks.pdffonts || "");
  const qpdfWarn = /WARNING|error|mismatch|xref|object stream/i.test(checks.qpdf || "");

  // 评分（0..1），越高越可能
  // 1) 驱动非确定性：显卡相关 + pHash/tile 轻微抖动
  let sDriver = 0.0;
  if (hasNvidia || hasAmd || hasIntel) sDriver += 0.2;
  sDriver += 0.4 * Math.min(1, phashVar * 2);
  sDriver += 0.4 * Math.min(1, tileVar * 2);

  // 2) 字体/嵌入/qpdf：检测到 pdffonts/qpdf 警告
  let sFont = 0.0;
  if (fontWarn) sFont += 0.6;
  if (qpdfWarn) sFont += 0.4;

  // 3) 算法漂移：哈希变化显著但非字体类，且驱动信号弱
  let sAlgo = 0.0;
  sAlgo += 0.6 * Math.max(0, phashVar - 0.2);
  sAlgo += 0.4 * Math.max(0, tileVar - 0.2);
  if (sFont > 0.1) sAlgo *= 0.5; // 字体问题优先

  // 归一化
  const sum = sDriver + sFont + sAlgo || 1;
  const ranked = [
    { cause: "driver-nondeterminism", score: sDriver / sum, signals: [`phashVar=${phashVar.toFixed(2)}`, `tileVar=${tileVar.toFixed(2)}`, driverSig.trim()] },
    { cause: "font-embed-or-qpdf",    score: sFont / sum,   signals: [fontWarn ? "pdffonts:warn" : "pdffonts:ok", qpdfWarn ? "qpdf:warn" : "qpdf:ok"] },
    { cause: "algorithmic-drift",     score: sAlgo / sum,   signals: [`phashVar=${phashVar.toFixed(2)}`, `tileVar=${tileVar.toFixed(2)}`] }
  ].sort((a, b) => b.score - a.score);

  return { ranked };
}
if (artifactSummary?.summary) {
  for (const row of artifactSummary.summary) {
    
    
    const f = String(row.frame);

    if (!frames[f]) {
      frames[f] = {
        tiles: {},
        phash64: null,
        hammingFromPrev: null
      };
    }

    frames[f].sha256 = row.sha256;
    frames[f].phash64 = row.phash64;
    const thumbPath =
      path.join(
        "out",
        "frames",
        `${String(row.frame).padStart(4, "0")}.png`
      );

    if (fs.existsSync(thumbPath)) {
      frames[f].thumb_b64 = fs.readFileSync(thumbPath).toString("base64");
    }
  }
}
const tilesDir = path.join("out", "artifacts", "tiles");

if (fs.existsSync(tilesDir)) {
  const tileFiles = fs.readdirSync(tilesDir)
    .filter(name => /^frame-\d+\.ndjson$/.test(name))
    .sort((a, b) => {
      const ai = Number(a.match(/\d+/)[0]);
      const bi = Number(b.match(/\d+/)[0]);
      return ai - bi;
    });

  for (const file of tileFiles) {
    const fullPath = path.join(tilesDir, file);
    const lines = fs.readFileSync(fullPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean);

    for (const line of lines) {
      const row = JSON.parse(line);
      const f = String(row.frame);

      if (!frames[f]) {
        frames[f] = {
          tiles: {},
          phash64: null,
          hammingFromPrev: null
        };
      }

      frames[f].tiles ??= {};

      for (const tile of row.tiles ?? []) {
        const key = `${tile.tx},${tile.ty}`;
        frames[f].tiles[key] = tile.sha256;
      }
    }
  }
}
const diagnosis = diagnose({ meta, frames, checks });

// ---------- 输出 ----------
const out = { meta, frames, checks, diagnosis };
process.stdout.write(JSON.stringify(out, null, 2));