/**
 * 视觉合成: DDA raycast 第一人称 PNG + 顶视地图 PNG。
 */
import { PNG } from 'pngjs'
import type { World } from '../world/world.js'
import { blockColor, SKY, VOID_COLOR } from './colors.js'

export interface ViewParams {
  width?: number
  height?: number
  fovDeg?: number   // 水平 FOV
  entities?: { x: number, y: number, z: number, type: string, hostile?: boolean }[]
}

const FACE_SHADE = [0.72, 0.72, 1.0, 0.5, 0.82, 0.82] // -x +x +y -y -z +z (模拟平行光)
const MAX_DIST = 64
let __dbgHits = 0

/** 第一人称 raycast 视图 */
export function renderView (world: World, eye: { x: number, y: number, z: number }, yawDeg: number, pitchDeg: number, params: ViewParams = {}): PNG {
  const W = Math.max(16, Math.min(320, params.width ?? 96))
  const H = Math.max(9, Math.min(180, params.height ?? Math.round(W * 9 / 16)))
  const fov = ((params.fovDeg ?? 70) * Math.PI) / 180

  const png = new PNG({ width: W, height: H })
  const yaw = (yawDeg * Math.PI) / 180
  const pitch = (pitchDeg * Math.PI) / 180
  // 视线基向量 (原版语义: yaw 0=+z(南), pitch +90=正下 -90=正上)
  const forward = {
    x: -Math.sin(yaw) * Math.cos(pitch),
    y: -Math.sin(pitch),
    z: Math.cos(yaw) * Math.cos(pitch),
  }
  const right = {
    x: -Math.cos(yaw),
    y: 0,
    z: -Math.sin(yaw),
  }
  const up = {
    x: right.y * forward.z - right.z * forward.y,
    y: right.z * forward.x - right.x * forward.z,
    z: right.x * forward.y - right.y * forward.x,
  }
  const aspect = W / H

  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      // 归一化设备坐标 -> 方向 (fov 参数=水平 FOV; 垂直 = 水平 / aspect)
      const ndcX = (px / (W - 1)) * 2 - 1
      const ndcY = 1 - (py / (H - 1)) * 2
      const tanHalf = Math.tan(fov / 2)
      const vTan = tanHalf / aspect
      let dx = forward.x + right.x * ndcX * tanHalf + up.x * ndcY * vTan
      let dy = forward.y + right.y * ndcX * tanHalf + up.y * ndcY * vTan
      let dz = forward.z + right.z * ndcX * tanHalf + up.z * ndcY * vTan
      const len = Math.hypot(dx, dy, dz) || 1
      dx /= len; dy /= len; dz /= len

      const c = raycastColor(world, eye.x, eye.y, eye.z, dx, dy, dz)
      const idx = (py * W + px) << 2
      png.data[idx] = c.r
      png.data[idx + 1] = c.g
      png.data[idx + 2] = c.b
      png.data[idx + 3] = 255
    }
  }
  drawEntities(png, params.entities ?? [], eye, yaw, pitch, fov, W, H)
  return png
}

/** 实体叠加: 针孔投影到屏幕, 画色块 + 类型标签点 */
function drawEntities (png: PNG, ents: { x: number, y: number, z: number, type: string, hostile?: boolean }[], eye: { x: number, y: number, z: number }, yawDeg: number, pitchDeg: number, fov: number, W: number, H: number) {
  if (!ents.length) return
  const yaw = (yawDeg * Math.PI) / 180
  const pitch = (pitchDeg * Math.PI) / 180
  const forward = { x: -Math.sin(yaw) * Math.cos(pitch), y: -Math.sin(pitch), z: Math.cos(yaw) * Math.cos(pitch) }
  const right = { x: -Math.cos(yaw), y: 0, z: -Math.sin(yaw) }
  const up = { x: right.y * forward.z - right.z * forward.y, y: right.z * forward.x - right.x * forward.z, z: right.x * forward.y - right.y * forward.x }
  const aspect = W / H
  const tanHalf = Math.tan(fov / 2)
  const vTan = tanHalf / aspect
  for (const e of ents) {
    const dx = e.x - eye.x, dy = (e.y + 1) - eye.y, dz = e.z - eye.z   // 实体中心(约+1)
    const dist = Math.hypot(dx, dy, dz)
    if (dist > 40 || dist < 0.5) continue
    // 相机空间
    const cx = dx * right.x + dy * right.y + dz * right.z
    const cy = dx * up.x + dy * up.y + dz * up.z
    const cz = dx * forward.x + dy * forward.y + dz * forward.z
    if (cz <= 0.1) continue  // 背后
    const sx = Math.round((cx / (cz * tanHalf * aspect) * 0.5 + 0.5) * (W - 1))
    const sy = Math.round((0.5 - cy / (cz * vTan) * 0.5) * (H - 1))
    if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue
    // 尺寸随距离
    const size = Math.max(2, Math.round(W / 24 / Math.max(1, dist / 6)))
    const color = e.hostile ? [255, 50, 50] : /cow|pig|sheep|chicken|horse|villager|wolf|cat/.test(e.type) ? [40, 170, 255] : /item/.test(e.type) ? [255, 220, 60] : [255, 160, 0]
    for (let yy = sy; yy < Math.min(H, sy + size); yy++) {
      for (let xx = sx; xx < Math.min(W, sx + size); xx++) {
        const i = (yy * W + xx) << 2
        png.data[i] = color[0]; png.data[i + 1] = color[1]; png.data[i + 2] = color[2]
      }
    }
  }
}

function raycastColor (world: World, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): { r: number, g: number, b: number } {
  let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz)
  const stepX = dx > 0 ? 1 : -1
  const stepY = dy > 0 ? 1 : -1
  const stepZ = dz > 0 ? 1 : -1
  const tDeltaX = Math.abs(1 / (dx || 1e-9))
  const tDeltaY = Math.abs(1 / (dy || 1e-9))
  const tDeltaZ = Math.abs(1 / (dz || 1e-9))
  let tMaxX = tDeltaX * (dx > 0 ? (x + 1 - ox) : (ox - x))
  let tMaxY = tDeltaY * (dy > 0 ? (y + 1 - oy) : (oy - y))
  let tMaxZ = tDeltaZ * (dz > 0 ? (z + 1 - oz) : (oz - z))
  let dist = 0
  let face = 2

  for (let i = 0; i < MAX_DIST * 3; i++) {
    const b = world.getBlock(x, y, z)
    if (b && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'void_air') {
      const base = blockColor(b.name)
      if (process.env.MC_RENDER_DEBUG && __dbgHits < 5) {
        __dbgHits++
        console.error(`[raydbg] hit ${b.name} at cell(${x},${y},${z}) dist=${dist.toFixed(1)} face=${face} dir=(${dx.toFixed(2)},${dy.toFixed(2)},${dz.toFixed(2)}) base=(${base.r},${base.g},${base.b})`)
      }
      // 水体半透明: 继续走几格混色
      if (b.name === 'water') {
        const under = raycastColor(world, x + 0.5 + stepX * 0.5, y, z + 0.5 + stepZ * 0.5, dx, dy, dz)
        const a = 0.45
        return mix(base, under, a)
      }
      const shade = FACE_SHADE[face]
      const fog = Math.max(0.35, 1 - dist / MAX_DIST)
      return {
        r: Math.min(255, base.r * shade * fog + SKY.r * (1 - fog) * 0.3),
        g: Math.min(255, base.g * shade * fog + SKY.g * (1 - fog) * 0.3),
        b: Math.min(255, base.b * shade * fog + SKY.b * (1 - fog) * 0.3),
      }
    }
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      dist = tMaxX; x += stepX; tMaxX += tDeltaX; face = dx > 0 ? 0 : 1 // 看到 -x 面
    } else if (tMaxY < tMaxZ) {
      dist = tMaxY; y += stepY; tMaxY += tDeltaY; face = dy > 0 ? 3 : 2 // 从上方进入看到顶面
    } else {
      dist = tMaxZ; z += stepZ; tMaxZ += tDeltaZ; face = dz > 0 ? 4 : 5
    }
    if (dist > MAX_DIST) break
  }
  // 没打中: 地平线以下用虚空色, 以上用天空色
  return dy < 0 ? VOID_COLOR : SKY
}

function mix (a: { r: number, g: number, b: number }, b: { r: number, g: number, b: number }, alphaA: number) {
  return {
    r: a.r * alphaA + b.r * (1 - alphaA),
    g: a.g * alphaA + b.g * (1 - alphaA),
    b: a.b * alphaA + b.b * (1 - alphaA),
  }
}

export interface MapParams {
  radius?: number  // 半径(格)
  scale?: number   // 每格像素
  entities?: { x: number, z: number, color: string }[]
  self?: { x: number, z: number }
}

/** 顶视地图: 每列最高方块的颜色, 叠加实体标记 */
export function renderMap (world: World, center: { x: number, z: number }, params: MapParams = {}): PNG {
  const R = Math.max(4, Math.min(96, params.radius ?? 32))
  const scale = Math.max(1, Math.min(8, params.scale ?? 4))
  const W = R * 2 * scale
  const H = W
  const png = new PNG({ width: W, height: H })

  // 每个世界列只算一次 (scale 倍放大时同一列对应 scale² 个像素)
  const N = R * 2
  const colRgb = new Uint8Array(N * N * 3)
  for (let cz = 0; cz < N; cz++) {
    for (let cx = 0; cx < N; cx++) {
      const wx = Math.floor(center.x) - R + cx
      const wz = Math.floor(center.z) - R + cz
      const o = (cz * N + cx) * 3
      const hy = world.highestBlockY(wx, wz)
      if (hy < world.min_y) {
        // 未知区块: 深灰
        colRgb[o] = 40; colRgb[o + 1] = 40; colRgb[o + 2] = 46
        continue
      }
      const b = world.getBlock(wx, hy, wz)
      const c = b ? blockColor(b.name) : { r: 120, g: 120, b: 120 }
      // 高度着色: 越高越亮
      const h = Math.max(0, Math.min(1, (hy - world.min_y) / world.world_height))
      const shade = 0.55 + h * 0.45
      colRgb[o] = Math.min(255, c.r * shade)
      colRgb[o + 1] = Math.min(255, c.g * shade)
      colRgb[o + 2] = Math.min(255, c.b * shade)
    }
  }
  for (let pz = 0; pz < H; pz++) {
    for (let px = 0; px < W; px++) {
      const o = (Math.floor(pz / scale) * N + Math.floor(px / scale)) * 3
      const idx = (pz * W + px) << 2
      png.data[idx] = colRgb[o]
      png.data[idx + 1] = colRgb[o + 1]
      png.data[idx + 2] = colRgb[o + 2]
      png.data[idx + 3] = 255
    }
  }

  // 实体标记
  const mark = (mx: number, mz: number, color: [number, number, number], size: number) => {
    const px = Math.round((mx - (Math.floor(center.x) - R)) * scale)
    const pz = Math.round((mz - (Math.floor(center.z) - R)) * scale)
    for (let dy = -size; dy <= size; dy++) {
      for (let dx = -size; dx <= size; dx++) {
        const x = px + dx, y = pz + dy
        if (x < 0 || y < 0 || x >= W || y >= H) continue
        const idx = (y * W + x) << 2
        png.data[idx] = color[0]
        png.data[idx + 1] = color[1]
        png.data[idx + 2] = color[2]
      }
    }
  }
  for (const e of params.entities ?? []) {
    const c = hexToRgb(e.color)
    mark(e.x, e.z, c, Math.max(1, Math.round(scale / 2)))
  }
  if (params.self) mark(params.self.x, params.self.z, [255, 60, 60], Math.max(1, Math.round(scale / 2)))
  return png
}

function hexToRgb (hex: string): [number, number, number] {
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
}

export function pngBuffer (png: PNG): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    png.pack()
      .on('data', (c: Buffer) => chunks.push(c))
      .on('end', () => resolve(Buffer.concat(chunks)))
  })
}

/** 调试: 视锥射线命中方块直方图 */
export function viewHitHistogram (world: World, eye: { x: number, y: number, z: number }, yawDeg: number, pitchDeg: number, W: number, H: number, fovDeg: number): Record<string, number> {
  const hist: Record<string, number> = {}
  const fov = (fovDeg * Math.PI) / 180
  const yaw = (yawDeg * Math.PI) / 180
  const pitch = (pitchDeg * Math.PI) / 180
  const forward = { x: -Math.sin(yaw) * Math.cos(pitch), y: -Math.sin(pitch), z: Math.cos(yaw) * Math.cos(pitch) }
  const right = { x: -Math.cos(yaw), y: 0, z: -Math.sin(yaw) }
  const up = { x: right.y * forward.z - right.z * forward.y, y: right.z * forward.x - right.x * forward.z, z: right.x * forward.y - right.y * forward.x }
  const aspect = W / H
  const tanHalf = Math.tan(fov / 2)
  const vTan = tanHalf / aspect
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const ndcX = (px / (W - 1)) * 2 - 1
      const ndcY = 1 - (py / (H - 1)) * 2
      let dx = forward.x + right.x * ndcX * tanHalf + up.x * ndcY * vTan
      let dy = forward.y + right.y * ndcX * tanHalf + up.y * ndcY * vTan
      let dz = forward.z + right.z * ndcX * tanHalf + up.z * ndcY * vTan
      const len = Math.hypot(dx, dy, dz) || 1
      dx /= len; dy /= len; dz /= len
      // 与 raycastColor 相同的 DDA, 只记名字
      let x = Math.floor(eye.x), y = Math.floor(eye.y), z = Math.floor(eye.z)
      const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1
      const tDX = Math.abs(1 / (dx || 1e-9)), tDY = Math.abs(1 / (dy || 1e-9)), tDZ = Math.abs(1 / (dz || 1e-9))
      let tMX = tDX * (dx > 0 ? x + 1 - eye.x : eye.x - x)
      let tMY = tDY * (dy > 0 ? y + 1 - eye.y : eye.y - y)
      let tMZ = tDZ * (dz > 0 ? z + 1 - eye.z : eye.z - z)
      let dist = 0
      let name = 'SKY'
      for (let i = 0; i < MAX_DIST * 3; i++) {
        const b = world.getBlock(x, y, z)
        if (b && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'void_air') { name = `${b.name}`; break }
        if (tMX < tMY && tMX < tMZ) { dist = tMX; x += stepX; tMX += tDX }
        else if (tMY < tMZ) { dist = tMY; y += stepY; tMY += tDY }
        else { dist = tMZ; z += stepZ; tMZ += tDZ }
        if (dist > MAX_DIST) break
      }
      const key = name === 'SKY' ? 'SKY' : `${name}@${Math.min(64, Math.round(dist / 8) * 8)}`
      hist[key] = (hist[key] ?? 0) + 1
    }
  }
  return Object.fromEntries(Object.entries(hist).sort((a, b) => b[1] - a[1]))
}

/** 准星射线: 返回指向的方块与距离 (场景 JSON 用) */
export function lookAtBlock (world: World, eye: { x: number, y: number, z: number }, yawDeg: number, pitchDeg: number): { name: string, x: number, y: number, z: number, dist: number } | null {
  const yaw = (yawDeg * Math.PI) / 180
  const pitch = (pitchDeg * Math.PI) / 180
  const dx = -Math.sin(yaw) * Math.cos(pitch)
  const dy = -Math.sin(pitch)
  const dz = Math.cos(yaw) * Math.cos(pitch)

  let x = Math.floor(eye.x), y = Math.floor(eye.y), z = Math.floor(eye.z)
  const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1
  const tDeltaX = Math.abs(1 / (dx || 1e-9)), tDeltaY = Math.abs(1 / (dy || 1e-9)), tDeltaZ = Math.abs(1 / (dz || 1e-9))
  let tMaxX = tDeltaX * (dx > 0 ? x + 1 - eye.x : eye.x - x)
  let tMaxY = tDeltaY * (dy > 0 ? y + 1 - eye.y : eye.y - y)
  let tMaxZ = tDeltaZ * (dz > 0 ? z + 1 - eye.z : eye.z - z)
  for (let i = 0; i < MAX_DIST * 3; i++) {
    const b = world.getBlock(x, y, z)
    if (b && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'void_air') {
      return { name: b.name, x, y, z, dist: Math.min(tMaxX, tMaxY, tMaxZ) }
    }
    if (tMaxX < tMaxY && tMaxX < tMaxZ) { const d = tMaxX; x += stepX; tMaxX += tDeltaX; if (d > MAX_DIST) break }
    else if (tMaxY < tMaxZ) { const d = tMaxY; y += stepY; tMaxY += tDeltaY; if (d > MAX_DIST) break }
    else { const d = tMaxZ; z += stepZ; tMaxZ += tDeltaZ; if (d > MAX_DIST) break }
  }
  return null
}
