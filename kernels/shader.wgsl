// shader.wgsl
// 单通道演示（可扩展到 RGBA）；输入/输出分离；固定点 16.16 速度场；手写双线性采样。
// 约定：贴图尺寸 W×H，工作组 8×8。边界采用 clamp。

struct Params {
  width: u32,
  height: u32,
  pitch: u32,            // 行步长（字节/样本数，视缓冲布局而定）
  frame_index: u32,
  dt_q16: u32,           // Δt（Q16.16）
};

@group(0) @binding(0) var<storage, read>  srcTex : array<f32>;
@group(0) @binding(1) var<storage, read>  velFP  : array<u32>; // 16.16 packed vx,vy  (vx in high 32? 见 pack 规则)
@group(0) @binding(2) var<storage, read_write> dstTex : array<f32>;
@group(0) @binding(3) var<uniform> params : Params;

// 读写辅助
fn idx(x: u32, y: u32, w: u32) -> u32 {
  return y*w + x;
}

fn clampU(v:i32, lo:i32, hi:i32) -> u32 {
  return u32(max(lo, min(v, hi)));
}

// 解包 16.16 -> f32
fn q16_to_f32(q:u32) -> f32 {
  return f32(i32(q)) / 65536.0;
}

// 速度打包规则：每像素两个 u32：vx_q16, vy_q16
fn load_v(x:u32, y:u32, w:u32) -> vec2<f32> {
  let base = (y*w + x) * 2u;
  let vx = q16_to_f32(velFP[base+0u]);
  let vy = q16_to_f32(velFP[base+1u]);
  return vec2<f32>(vx, vy);
}

// 手写 bilinear：传入浮点坐标（源域）
fn bilinear_clamped(u:f32, v:f32, w:u32, h:u32) -> f32 {
  let x = clamp(u, 0.0, f32(w-1u));
  let y = clamp(v, 0.0, f32(h-1u));
  let x0 = i32(floor(x));
  let y0 = i32(floor(y));
  let x1 = x0 + 1;
  let y1 = y0 + 1;
  let fx = x - f32(x0);
  let fy = y - f32(y0);

  let x0c = clampU(x0, 0, i32(w)-1);
  let x1c = clampU(x1, 0, i32(w)-1);
  let y0c = clampU(y0, 0, i32(h)-1);
  let y1c = clampU(y1, 0, i32(h)-1);

  let s00 = srcTex[idx(x0c, y0c, w)];
  let s10 = srcTex[idx(x1c, y0c, w)];
  let s01 = srcTex[idx(x0c, y1c, w)];
  let s11 = srcTex[idx(x1c, y1c, w)];

  let a = mix(s00, s10, fx);
  let b = mix(s01, s11, fx);
  return mix(a, b, fy);
}

@compute @workgroup_size(8,8,1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let w = params.width;
  let h = params.height;
  if (gid.x >= w || gid.y >= h) { return; }

  let x = gid.x;
  let y = gid.y;

  let xm = select(x - 1u, x, x == 0u);
  let xp = select(x + 1u, x, x == w - 1u);

  let ym = select(y - 1u, y, y == 0u);
  let yp = select(y + 1u, y, y == h - 1u);

  let c  = srcTex[idx(x , y , w)];
  let l  = srcTex[idx(xm, y , w)];
  let r  = srcTex[idx(xp, y , w)];
  let u  = srcTex[idx(x , ym, w)];
  let d  = srcTex[idx(x , yp, w)];

  let lap =
      l + r + u + d - 4.0 * c;

  let dt = f32(params.dt_q16) / 65536.0;

  let D = 0.25;
  let omega = 0.6;

  let reaction = -omega * sin(c * 6.28318);

  let outVal =
      c
      + dt * (
          D * lap
          + reaction
        );

  dstTex[idx(x,y,w)] = clamp(outVal, -4.0, 4.0);
}