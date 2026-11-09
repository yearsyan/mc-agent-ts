/**
 * 视觉合成: DDA raycast 第一人称 PNG + 顶视地图 PNG。
 * - 方块按真实碰撞形状求交 (台阶/栅栏/门/地毯); 草花火把等无碰撞方块画成细小体块, 不再挡视线
 * - 玻璃/水半透明合成; 方块边缘描线 (数格子/判距离); 远处雾化
 * - 深度缓冲: 实体按真实尺寸投影, 被方块挡住的部分不画; 标注 #编号 (= act 的 entity_id)
 * - HUD: 准星 + 顶部罗盘
 */
import { PNG } from 'pngjs'
import { blockName, type World } from '../world/world.js'
import { blockColor, SKY, VOID_COLOR, type RGB } from './colors.js'
import { drawText, textWidth, textHeight, blend, fillRect, LabelLayout, type RGBA } from './font.js'

import { mcData, Block } from '../version.js'

const MAX_DIST = 80

// ---------- 方块渲染形状 ----------

interface Shape {
  /** null = 整格立方体; 否则为格内局部坐标的盒子 [x0,y0,z0,x1,y1,z1] */
  boxes: number[][] | null
  /** 1 = 不透明 */
  alpha: number
  skip?: boolean
  fluid?: 'water' | 'lava'
}
const SKIP: Shape = { boxes: null, alpha: 0, skip: true }
const FULL: Shape = { boxes: null, alpha: 1 }
const SHAPES: (Shape | undefined)[] = []

const INVISIBLE = /^(air|cave_air|void_air|structure_void|light|barrier|vine|glow_lichen|sculk_vein|cave_vines(_plant)?|twisting_vines(_plant)?|weeping_vines(_plant)?|tripwire|moving_piston)$/
const WATERY = /^(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/
const FLAT = /(rail|redstone_wire|pressure_plate|lily_pad|_carpet|moss_carpet|pink_petals|leaf_litter|wildflowers)$/
const TALL_PLANT = /^(tall_grass|large_fern|sunflower|lilac|rose_bush|peony|sugar_cane|bamboo_sapling|pitcher_plant|tall_dry_grass)$/

function shapeOf (stateId: number, name: string): Shape {
  const cached = SHAPES[stateId]
  if (cached) return cached
  let s: Shape
  if (INVISIBLE.test(name)) s = SKIP
  else if (WATERY.test(name)) s = { boxes: null, alpha: 1, fluid: 'water' }
  else if (name === 'lava') s = { boxes: null, alpha: 1, fluid: 'lava' }
  else {
    let shapes: number[][] = []
    let props: any = {}
    try { const b = Block.fromStateId(stateId, 0); shapes = b.shapes ?? []; props = b.getProperties?.() ?? {} } catch {}
    const glass = /glass/.test(name)
    const alpha = glass ? (/stained|tinted/.test(name) ? 0.5 : 0.22) : name === 'cobweb' ? 0.35 : /fire$/.test(name) ? 0.8 : 1
    if (name === 'snow') s = { boxes: [[0, 0, 0, 1, Math.max(1, Number(props.layers ?? 1)) / 8, 1]], alpha: 1 }
    else if (name === 'cobweb' || /fire$/.test(name)) s = { boxes: [[0.05, 0, 0.05, 0.95, 0.9, 0.95]], alpha }
    else if (!shapes.length) {
      // 无碰撞的装饰方块: 用小体块示意, 不挡视线
      if (FLAT.test(name)) s = { boxes: [[0, 0, 0, 1, 0.0625, 1]], alpha: 1 }
      else if (/torch/.test(name)) s = { boxes: [[0.42, 0, 0.42, 0.58, 0.65, 0.58]], alpha: 1 }
      else if (TALL_PLANT.test(name)) s = { boxes: [[0.3, 0, 0.3, 0.7, 1, 0.7]], alpha: 1 }
      else if (/sign|banner|button|lever|tripwire_hook|frame/.test(name)) s = { boxes: [[0.3, 0.2, 0.3, 0.7, 0.8, 0.7]], alpha: 1 }
      else s = { boxes: [[0.3, 0, 0.3, 0.7, 0.55, 0.7]], alpha: 1 }
    } else {
      const boxes = shapes.map(b => [b[0], b[1], b[2], b[3], Math.min(1, b[4]), b[5]])
      const full = boxes.length === 1 && boxes[0].every((v, i) => v === (i < 3 ? 0 : 1))
      s = full ? (alpha === 1 ? FULL : { boxes: null, alpha }) : { boxes, alpha }
    }
  }
  SHAPES[stateId] = s
  return s
}

// ---------- 光线求交 ----------

const FACE_SHADE = [0.72, 0.72, 1.0, 0.5, 0.84, 0.84] // -x +x +y -y -z +z (模拟平行光)
const faceOf = (axis: number, d: number) => axis === 0 ? (d > 0 ? 0 : 1) : axis === 1 ? (d > 0 ? 3 : 2) : (d > 0 ? 4 : 5)

/** 射线与 AABB (世界坐标) 求交, 限定 t∈[tMin,tMax]; 返回命中 t 与命中轴 (-1 = 起点在盒内) */
function boxHit (o: number[], d: number[], b: number[], tMin: number, tMax: number): { t: number, axis: number } | null {
  let tNear = -Infinity, tFar = Infinity, axis = -1
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-12) {
      if (o[a] < b[a] || o[a] > b[a + 3]) return null
      continue
    }
    let t0 = (b[a] - o[a]) / d[a], t1 = (b[a + 3] - o[a]) / d[a]
    if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp }
    if (t0 > tNear) { tNear = t0; axis = a }
    if (t1 < tFar) tFar = t1
  }
  if (tNear > tFar || tFar < tMin) return null
  if (tNear < tMin) return { t: tMin, axis: -1 }
  if (tNear > tMax + 1e-9) return null
  return { t: tNear, axis }
}

function shadeHit (base: RGB, t: number, face: number, edge: number) {
  const k = FACE_SHADE[face] * (edge ? 0.7 : 1)
  const fog = Math.max(0, Math.min(0.75, (t - MAX_DIST * 0.35) / (MAX_DIST * 0.65)))
  return [
    base.r * k * (1 - fog) + SKY.r * fog,
    base.g * k * (1 - fog) + SKY.g * fog,
    base.b * k * (1 - fog) + SKY.b * fog,
  ]
}

/** 命中点是否在所在盒子某个面的边缘 (像素张角越大线越宽, 太远不画, 免得糊成一片) */
function onEdge (o: number[], d: number[], pixAngle: number, t: number, axis: number, box: number[]) {
  const px = t * pixAngle
  if (axis < 0 || px > 0.22) return 0
  const w = Math.max(0.035, px * 0.8)
  let e = Infinity
  for (let a = 0; a < 3; a++) {
    if (a === axis) continue
    const p = o[a] + d[a] * t
    e = Math.min(e, p - box[a], box[a + 3] - p)
  }
  return e < w ? 1 : 0
}

interface RayResult { r: number, g: number, b: number, depth: number }

/**
 * 沿射线走 DDA, 前到后合成半透明层, 直到不透明命中。
 * pixAngle = 每像素张角 (弧度), 用于按距离决定边缘线宽度。
 */
function castRay (world: World, o: number[], d: number[], pixAngle: number): RayResult {
  let x = Math.floor(o[0]), y = Math.floor(o[1]), z = Math.floor(o[2])
  const step = [d[0] > 0 ? 1 : -1, d[1] > 0 ? 1 : -1, d[2] > 0 ? 1 : -1]
  const tDelta = [Math.abs(1 / (d[0] || 1e-9)), Math.abs(1 / (d[1] || 1e-9)), Math.abs(1 / (d[2] || 1e-9))]
  const tMax = [
    tDelta[0] * (d[0] > 0 ? x + 1 - o[0] : o[0] - x),
    tDelta[1] * (d[1] > 0 ? y + 1 - o[1] : o[1] - y),
    tDelta[2] * (d[2] > 0 ? z + 1 - o[2] : o[2] - z),
  ]
  let tEnter = 0, enterAxis = -1
  let ar = 0, ag = 0, ab = 0, T = 1 // 累积颜色与剩余透射率
  let prevTranslucent = '' // 连续同种半透明方块只算一次表面 (水按深度另算)

  for (let i = 0; i < MAX_DIST * 3; i++) {
    const sid = world.stateAt(x, y, z)
    const tExit = Math.min(tMax[0], tMax[1], tMax[2])
    const s = sid > 0 ? (SHAPES[sid] ?? shapeOf(sid, blockName(sid))) : SKIP
    if (!s.skip) {
      if (s.fluid) {
        // 水面比整格低一点 (上面不是水时)
        const above = s.fluid === 'water' ? world.stateAt(x, y + 1, z) : -1
        const top = s.fluid === 'water' && !(above > 0 && SHAPES[above]?.fluid === 'water') ? 0.875 : 1
        const box = [x, y, z, x + 1, y + top, z + 1]
        const h = boxHit(o, d, box, tEnter, tExit)
        if (h) {
          const base = blockColor(s.fluid)
          if (s.fluid === 'lava') {
            const c = shadeHit(base, h.t, h.axis < 0 ? 2 : faceOf(h.axis, d[h.axis]), 0)
            return { r: ar + T * c[0], g: ag + T * c[1], b: ab + T * c[2], depth: h.t }
          }
          const surface = prevTranslucent !== 'water'
          const a = surface ? 0.45 : 0.1 * Math.min(1, tExit - h.t + 0.2)
          const c = surface ? shadeHit(base, h.t, h.axis < 0 ? 2 : faceOf(h.axis, d[h.axis]), 0) : [base.r * 0.6, base.g * 0.6, base.b * 0.6]
          ar += T * a * c[0]; ag += T * a * c[1]; ab += T * a * c[2]; T *= 1 - a
          prevTranslucent = 'water'
          if (T < 0.04) return { r: ar, g: ag, b: ab, depth: h.t }
        } else prevTranslucent = ''
      } else {
        let hit: { t: number, axis: number, box: number[] } | null = null
        if (!s.boxes) {
          hit = { t: tEnter, axis: enterAxis, box: [x, y, z, x + 1, y + 1, z + 1] }
        } else {
          for (const lb of s.boxes) {
            const wb = [x + lb[0], y + lb[1], z + lb[2], x + lb[3], y + lb[4], z + lb[5]]
            const h = boxHit(o, d, wb, tEnter, tExit)
            if (h && (!hit || h.t < hit.t)) hit = { ...h, box: wb }
          }
        }
        if (hit) {
          const face = hit.axis < 0 ? 2 : faceOf(hit.axis, d[hit.axis])
          const name = blockName(sid)
          const c = shadeHit(blockColor(name), hit.t, face, onEdge(o, d, pixAngle, hit.t, hit.axis, hit.box))
          if (s.alpha >= 1) return { r: ar + T * c[0], g: ag + T * c[1], b: ab + T * c[2], depth: hit.t }
          if (prevTranslucent !== name) {
            ar += T * s.alpha * c[0]; ag += T * s.alpha * c[1]; ab += T * s.alpha * c[2]; T *= 1 - s.alpha
          }
          prevTranslucent = name
        } else prevTranslucent = ''
      }
    } else prevTranslucent = ''

    // 下一格
    if (tMax[0] < tMax[1] && tMax[0] < tMax[2]) { tEnter = tMax[0]; x += step[0]; tMax[0] += tDelta[0]; enterAxis = 0 }
    else if (tMax[1] < tMax[2]) { tEnter = tMax[1]; y += step[1]; tMax[1] += tDelta[1]; enterAxis = 1 }
    else { tEnter = tMax[2]; z += step[2]; tMax[2] += tDelta[2]; enterAxis = 2 }
    if (tEnter > MAX_DIST) break
  }
  // 没打中: 80 格外按雾 (天空色) 处理; 只有明显朝下 (掉进虚空/超深峡谷) 才用虚空色
  const bg = d[1] < -0.5 ? VOID_COLOR : SKY
  return { r: ar + T * bg.r, g: ag + T * bg.g, b: ab + T * bg.b, depth: Infinity }
}

// ---------- 相机 ----------

function camera (yawDeg: number, pitchDeg: number) {
  const yaw = (yawDeg * Math.PI) / 180
  const pitch = (pitchDeg * Math.PI) / 180
  // 原版语义: yaw 0=+z(南), 增大向右转 (朝南时右手是西); pitch +90=正下
  const forward = [-Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)]
  const right = [-Math.cos(yaw), 0, -Math.sin(yaw)]
  const up = [
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0],
  ]
  return { forward, right, up }
}

// ---------- 第一人称 ----------

export type EntityKind = 'hostile' | 'animal' | 'item' | 'player' | 'other'
export interface ViewEntity { id: number, x: number, y: number, z: number, type: string, label: string, kind: EntityKind, w: number, h: number }

export interface ViewParams {
  width?: number
  height?: number
  fovDeg?: number   // 水平 FOV
  entities?: ViewEntity[]
}

export interface ViewEntityInfo {
  id: number, label: string, kind: EntityKind, dist: number
  /** 屏幕中心坐标 (像素) */
  sx: number, sy: number
  /** 未被方块遮挡的比例 0..1 */
  visible: number
  labeled: boolean
}

export const KIND_COLOR: Record<EntityKind, RGBA> = {
  hostile: [255, 55, 45], animal: [70, 175, 255], item: [255, 215, 40], player: [255, 255, 255], other: [255, 150, 30],
}

/** 第一人称 raycast 视图 */
export async function renderView (world: World, eye: { x: number, y: number, z: number }, yawDeg: number, pitchDeg: number, params: ViewParams = {}): Promise<{ png: PNG, entities: ViewEntityInfo[] }> {
  const W = Math.max(16, Math.min(640, Math.round(params.width ?? 480)))
  const H = Math.max(9, Math.min(360, Math.round(params.height ?? W * 9 / 16)))
  const fov = (Math.max(30, Math.min(120, params.fovDeg ?? 70)) * Math.PI) / 180
  const png = new PNG({ width: W, height: H })
  const { forward, right, up } = camera(yawDeg, pitchDeg)
  const tanHalf = Math.tan(fov / 2)
  const vTan = tanHalf * H / W
  const pixAngle = 2 * tanHalf / W
  const depth = new Float32Array(W * H)
  const o = [eye.x, eye.y, eye.z]

  const rayDir = (px: number, py: number) => {
    const ndcX = ((px + 0.5) / W) * 2 - 1, ndcY = 1 - ((py + 0.5) / H) * 2
    const d = [0, 1, 2].map(a => forward[a] + right[a] * ndcX * tanHalf + up[a] * ndcY * vTan)
    const len = Math.hypot(d[0], d[1], d[2]) || 1
    return [d[0] / len, d[1] / len, d[2] / len]
  }
  let lastYield = Date.now()
  for (let py = 0; py < H; py++) {
    // 渲染与 bot tick 同一线程: 每 ~15ms 让出事件循环, 不卡物理/反射
    if (Date.now() - lastYield > 15) { await new Promise(r => setImmediate(r)); lastYield = Date.now() }
    for (let px = 0; px < W; px++) {
      const c = castRay(world, o, rayDir(px, py), pixAngle)
      const i = py * W + px
      // 深度存沿射线距离 (欧氏), 与实体距离可直接比较
      depth[i] = c.depth
      png.data[i * 4] = Math.min(255, c.r)
      png.data[i * 4 + 1] = Math.min(255, c.g)
      png.data[i * 4 + 2] = Math.min(255, c.b)
      png.data[i * 4 + 3] = 255
    }
  }

  const fs = W >= 400 ? 2 : 1
  const layout = new LabelLayout(W, H)
  layout.reserve({ x: W / 2 - 6 * fs, y: H / 2 - 6 * fs, w: 12 * fs, h: 12 * fs }) // 准星
  drawCompass(png, yawDeg, fov, fs, layout)
  const project = (p: number[]) => {
    const v = [p[0] - o[0], p[1] - o[1], p[2] - o[2]]
    const cx = v[0] * right[0] + v[1] * right[1] + v[2] * right[2]
    const cy = v[0] * up[0] + v[1] * up[1] + v[2] * up[2]
    const cz = v[0] * forward[0] + v[1] * forward[1] + v[2] * forward[2]
    return { sx: (cx / (cz * tanHalf) * 0.5 + 0.5) * W, sy: (0.5 - cy / (cz * vTan) * 0.5) * H, cz }
  }
  const infos = drawViewEntities(png, depth, params.entities ?? [], o, project, rayDir, pixAngle, W, H, fs, layout)
  drawCrosshair(png, W, H, fs)
  return { png, entities: infos }
}

function drawViewEntities (png: PNG, depth: Float32Array, ents: ViewEntity[], o: number[], project: (p: number[]) => { sx: number, sy: number, cz: number }, rayDir: (px: number, py: number) => number[], pixAngle: number, W: number, H: number, fs: number, layout: LabelLayout): ViewEntityInfo[] {
  const out: (ViewEntityInfo & { rect: number[], mask: Uint8Array })[] = []
  for (const e of ents) {
    const dist = Math.hypot(e.x - o[0], e.y + e.h / 2 - o[1], e.z - o[2])
    if (dist > MAX_DIST || dist < 0.3) continue
    const center = project([e.x, e.y + e.h / 2, e.z])
    if (center.cz <= 0.05) continue
    // 太小的 (远处/掉落物) 放大到至少约 5 像素, 免得看不见
    const minSize = dist * pixAngle * 5
    const w = Math.max(e.w, minSize), h = Math.max(e.h, minSize)
    const box = [e.x - w / 2, e.y + e.h / 2 - h / 2, e.z - w / 2, e.x + w / 2, e.y + e.h / 2 + h / 2, e.z + w / 2]
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (let k = 0; k < 8; k++) {
      const p = project([box[k & 1 ? 3 : 0], box[k & 2 ? 4 : 1], box[k & 4 ? 5 : 2]])
      if (p.cz <= 0.05) { x0 = 0; y0 = 0; x1 = W; y1 = H; break } // 有角在身后: 退化为全屏扫描
      x0 = Math.min(x0, p.sx); x1 = Math.max(x1, p.sx); y0 = Math.min(y0, p.sy); y1 = Math.max(y1, p.sy)
    }
    const rx0 = Math.max(0, Math.floor(x0)), ry0 = Math.max(0, Math.floor(y0)), rx1 = Math.min(W - 1, Math.ceil(x1)), ry1 = Math.min(H - 1, Math.ceil(y1))
    if (rx0 > rx1 || ry0 > ry1) continue
    // 逐像素: 射线打到实体盒子 → 属于实体; 方块深度比它近 → 被挡
    const rw = rx1 - rx0 + 1
    const mask = new Uint8Array(rw * (ry1 - ry0 + 1)) // 0 不属于实体, 1 被挡, 2 可见
    let vis = 0, tot = 0
    for (let y = ry0; y <= ry1; y++) {
      for (let x = rx0; x <= rx1; x++) {
        const hit = boxHit(o, rayDir(x, y), box, 0, Infinity)
        if (!hit) continue
        tot++
        const v = depth[y * W + x] >= hit.t - 0.05
        if (v) vis++
        mask[(y - ry0) * rw + (x - rx0)] = v ? 2 : 1
      }
    }
    if (!tot) continue
    out.push({ id: e.id, label: e.label, kind: e.kind, dist: +dist.toFixed(1), sx: Math.round(center.sx), sy: Math.round(center.sy), visible: +(vis / tot).toFixed(2), labeled: false, rect: [rx0, ry0, rx1, ry1], mask })
  }
  // 远的先画, 近的盖在上面; 剪影内部淡色填充, 剪影边缘实线
  out.sort((a, b) => b.dist - a.dist)
  for (const e of out) {
    if (!e.visible) continue
    const [rx0, ry0, rx1, ry1] = e.rect
    const rw = rx1 - rx0 + 1, rh = ry1 - ry0 + 1
    const col = KIND_COLOR[e.kind]
    const m = (x: number, y: number) => x < 0 || y < 0 || x >= rw || y >= rh ? 0 : e.mask[y * rw + x]
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        if (m(x, y) !== 2) continue
        let border = false
        for (let k = 1; k <= fs && !border; k++) border = !m(x - k, y) || !m(x + k, y) || !m(x, y - k) || !m(x, y + k)
        blend(png, rx0 + x, ry0 + y, col, border ? 1 : 0.25)
      }
    }
  }
  // 标签: 近的优先占位; 先试剪影正上方, 再试下方/左右, 最后往上叠
  const byNear = out.filter(e => e.visible > 0).sort((a, b) => a.dist - b.dist)
  for (const e of byNear.slice(0, 14)) {
    const [rx0, ry0, rx1, ry1] = e.rect
    const text = `#${e.id} ${e.label}`.slice(0, 26)
    const w = textWidth(text, fs) + 2 * fs, h = textHeight(fs) + 2 * fs
    const cx = Math.round((rx0 + rx1) / 2 - w / 2)
    const pos = layout.place(cx, ry0 - h - fs, w, h, 0, 1) ?? layout.place(cx, ry1 + 2 * fs, w, h, 0, 1) ??
      layout.place(rx0 - w - 2 * fs, Math.round((ry0 + ry1) / 2 - h / 2), w, h, 0, 1) ?? layout.place(rx1 + 2 * fs, Math.round((ry0 + ry1) / 2 - h / 2), w, h, 0, 1) ??
      layout.place(cx, ry0 - 2 * h - fs, w, h, h + fs, 4)
    if (!pos) continue
    drawText(png, pos.x + fs, pos.y + fs, text, KIND_COLOR[e.kind], fs, [0, 0, 0, 0.65])
    // 标签离剪影远时画一条引线
    const ly = pos.y + h, lx = pos.x + w / 2
    if (ly < ry0 - 2 * fs || pos.y > ry1 + 2 * fs || pos.x > rx1 + 2 * fs || pos.x + w < rx0 - 2 * fs) {
      const tx = (rx0 + rx1) / 2, ty = pos.y > ry1 ? ry1 : ry0
      const fy = pos.y > ry1 ? pos.y : ly
      const n = Math.ceil(Math.hypot(tx - lx, ty - fy))
      for (let k = 0; k <= n; k++) blend(png, Math.round(lx + (tx - lx) * k / n), Math.round(fy + (ty - fy) * k / n), KIND_COLOR[e.kind], 0.8)
    }
    e.labeled = true
  }
  return out.sort((a, b) => a.dist - b.dist).map(({ rect, mask, ...rest }) => rest)
}

function drawCrosshair (png: PNG, W: number, H: number, fs: number) {
  const cx = Math.floor(W / 2), cy = Math.floor(H / 2), L = 4 * fs
  for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
    for (let k = 1; k <= L; k++) {
      for (let s = -fs; s <= fs; s++) blend(png, cx + dx * k + (dy ? s : 0), cy + dy * k + (dx ? s : 0), [0, 0, 0], 0.6)
    }
  }
  for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
    for (let k = 1; k <= L; k++) blend(png, cx + dx * k, cy + dy * k, [255, 255, 255])
  }
  blend(png, cx, cy, [255, 255, 255])
}

const HEADINGS: [string, number][] = [['S', 0], ['SW', 45], ['W', 90], ['NW', 135], ['N', 180], ['NE', -135], ['E', -90], ['SE', -45]]

/** 顶部罗盘: 按方位角投到屏幕水平位置 (与俯仰无关) */
function drawCompass (png: PNG, yawDeg: number, fov: number, fs: number, layout: LabelLayout) {
  const W = png.width
  const tanHalf = Math.tan(fov / 2)
  for (const [name, h] of HEADINGS) {
    const rel = ((h - yawDeg + 540) % 360) - 180
    if (Math.abs(rel) >= (fov / 2) * 180 / Math.PI) continue
    const sx = Math.round(W / 2 + Math.tan(rel * Math.PI / 180) / tanHalf * W / 2)
    const main = name.length === 1
    const tw = textWidth(name, fs)
    fillRect(png, sx - fs, 0, 2 * fs, 3 * fs, [255, 255, 255], main ? 0.9 : 0.5)
    const r = drawText(png, sx - Math.floor(tw / 2), 4 * fs, name, main ? [255, 255, 255] : [200, 200, 200], fs, [0, 0, 0, 0.45])
    layout.reserve(r)
  }
}

// ---------- 顶视地图 ----------

export interface MapEntity { id: number, x: number, y: number, z: number, label: string, kind: EntityKind }
export interface MapParams {
  radius?: number  // 半径(格)
  scale?: number   // 每格像素
  entities?: MapEntity[]
  self?: { x: number, y: number, z: number, yaw: number }
  /** surface=地表; slice=按脚下高度横切 (地下/室内); auto=头顶大面积有方块时用 slice */
  mode?: 'auto' | 'surface' | 'slice'
}
export interface MapInfo { mode: 'surface' | 'slice', sliceY?: number, x0: number, z0: number, x1: number, z1: number, scale: number, grid: number, labeled: number[] }

const UNKNOWN: RGB = { r: 40, g: 40, b: 46 }

/** 当前位置是否被大面积覆盖 (地下/室内): 周围 5×5 列里至少 21 列头顶 2 格以上有方块 */
export function isCovered (world: World, x: number, y: number, z: number) {
  let n = 0
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if (world.highestBlockY(Math.floor(x) + dx, Math.floor(z) + dz) > Math.floor(y) + 2) n++
  return n >= 21
}

export function renderMap (world: World, center: { x: number, y: number, z: number }, params: MapParams = {}): { png: PNG, info: MapInfo } {
  const R = Math.max(4, Math.min(96, Math.round(params.radius ?? 32)))
  let scale = Math.max(1, Math.min(8, Math.round(params.scale ?? 6)))
  while (R * 2 * scale > 1024 && scale > 1) scale--
  const N = R * 2
  const W = N * scale, H = W
  const png = new PNG({ width: W, height: H })
  const x0 = Math.floor(center.x) - R, z0 = Math.floor(center.z) - R
  const y0 = Math.floor(center.y)
  const mode = params.mode === 'surface' || params.mode === 'slice' ? params.mode : (isCovered(world, center.x, center.y, center.z) ? 'slice' : 'surface')

  // 每列一次; 多算一行一列给山体明暗用
  const heights = new Int32Array((N + 1) * (N + 1))
  for (let cz = 0; cz <= N; cz++) for (let cx = 0; cx <= N; cx++) heights[cz * (N + 1) + cx] = world.highestBlockY(x0 + cx - 1, z0 + cz - 1)
  const col = new Uint8Array(N * N * 3)
  for (let cz = 0; cz < N; cz++) {
    for (let cx = 0; cx < N; cx++) {
      const wx = x0 + cx, wz = z0 + cz
      const c = mode === 'surface' ? surfaceColor(world, wx, wz, heights, N, cx, cz) : sliceColor(world, wx, y0, wz)
      const o = (cz * N + cx) * 3
      col[o] = Math.min(255, c.r); col[o + 1] = Math.min(255, c.g); col[o + 2] = Math.min(255, c.b)
    }
  }
  for (let pz = 0; pz < H; pz++) {
    for (let px = 0; px < W; px++) {
      const o = (Math.floor(pz / scale) * N + Math.floor(px / scale)) * 3
      const i = (pz * W + px) << 2
      png.data[i] = col[o]; png.data[i + 1] = col[o + 1]; png.data[i + 2] = col[o + 2]; png.data[i + 3] = 255
    }
  }

  // 网格: 每 grid 格一条线 (16 = 区块边界), 坐标标在上/左边缘
  const fs = W >= 384 ? 2 : 1
  const layout = new LabelLayout(W, H)
  let grid = 16
  while (grid * scale < textWidth('-0000', fs) + 6) grid *= 2
  const gx0 = Math.ceil(x0 / grid) * grid, gz0 = Math.ceil(z0 / grid) * grid
  for (let gx = gx0; gx <= x0 + N; gx += grid) {
    const px = (gx - x0) * scale
    for (let y = 0; y < H; y++) blend(png, px, y, [0, 0, 0], 0.4)
  }
  for (let gz = gz0; gz <= z0 + N; gz += grid) {
    const py = (gz - z0) * scale
    for (let x = 0; x < W; x++) blend(png, x, py, [0, 0, 0], 0.4)
  }
  for (let gx = gx0; gx <= x0 + N; gx += grid) {
    const t = String(gx), px = (gx - x0) * scale
    if (px + 2 + textWidth(t, fs) > W - 1) continue
    layout.reserve(drawText(png, px + 2 * fs, fs, t, [255, 255, 255], fs, [0, 0, 0, 0.55]))
  }
  for (let gz = gz0; gz <= z0 + N; gz += grid) {
    const t = String(gz), py = (gz - z0) * scale
    if (py + 2 * fs + textHeight(fs) > H - 1 || py < textHeight(fs) + 4 * fs) continue
    layout.reserve(drawText(png, fs, py + 2 * fs, t, [255, 255, 255], fs, [0, 0, 0, 0.55]))
  }
  drawNorth(png, fs, layout)

  // 实体
  const toPx = (x: number, z: number) => [(x - x0) * scale, (z - z0) * scale]
  const ents = (params.entities ?? []).filter(e => e.x >= x0 && e.x < x0 + N && e.z >= z0 && e.z < z0 + N)
  const dot = Math.max(2, Math.round(scale * 0.6))
  for (const e of ents) {
    const [px, py] = toPx(e.x, e.z)
    const r = e.kind === 'item' ? Math.max(1, dot - 1) : dot
    fillRect(png, Math.round(px - r - 1), Math.round(py - r - 1), 2 * r + 3, 2 * r + 3, [0, 0, 0], 0.7)
    fillRect(png, Math.round(px - r), Math.round(py - r), 2 * r + 1, 2 * r + 1, KIND_COLOR[e.kind])
  }
  if (params.self) drawArrow(png, ...toPx(params.self.x, params.self.z) as [number, number], params.self.yaw, Math.max(6, scale * 1.6))
  const labeled: number[] = []
  if (params.self) {
    const [sx, sy] = toPx(params.self.x, params.self.z), r = Math.max(6, scale * 1.6)
    layout.reserve({ x: sx - r, y: sy - r, w: 2 * r, h: 2 * r })
  }
  const near = ents.filter(e => e.kind !== 'item')
    .sort((a, b) => Math.hypot(a.x - center.x, a.z - center.z) - Math.hypot(b.x - center.x, b.z - center.z))
  for (const e of near.slice(0, 14)) {
    const [px, py] = toPx(e.x, e.z)
    const t = `#${e.id}`
    const w = textWidth(t, fs) + 2 * fs, h = textHeight(fs) + 2 * fs
    const pos = layout.place(Math.round(px + dot + 2), Math.round(py - h / 2), w, h, h)
    if (!pos) continue
    drawText(png, pos.x + fs, pos.y + fs, t, KIND_COLOR[e.kind], fs, [0, 0, 0, 0.6])
    labeled.push(e.id)
  }
  return { png, info: { mode, ...(mode === 'slice' ? { sliceY: y0 } : {}), x0, z0, x1: x0 + N - 1, z1: z0 + N - 1, scale, grid, labeled } }
}

/** 地表: 最高方块颜色 × 山体明暗 (比北侧高=亮, 低=暗, 同原版地图); 水按深度变暗 */
function surfaceColor (world: World, wx: number, wz: number, heights: Int32Array, N: number, cx: number, cz: number): RGB {
  const hy = heights[(cz + 1) * (N + 1) + cx + 1]
  if (hy < world.min_y) return UNKNOWN
  const b = world.getBlock(wx, hy, wz)
  const base = b ? blockColor(b.name) : { r: 120, g: 120, b: 120 }
  let k = 1
  if (b && WATERY.test(b.name)) {
    let depth = 1
    while (depth < 12) { const u = world.getBlock(wx, hy - depth, wz); if (!u || !WATERY.test(u.name)) break; depth++ }
    k = 1.08 - Math.min(depth, 10) * 0.05
  } else {
    const hn = heights[cz * (N + 1) + cx + 1], hw = heights[(cz + 1) * (N + 1) + cx]
    if (hn >= world.min_y) k *= hy > hn ? 1.15 : hy < hn ? 0.78 : 1
    if (hw >= world.min_y) k *= hy > hw ? 1.06 : hy < hw ? 0.92 : 1
  }
  return { r: base.r * k, g: base.g * k, b: base.b * k }
}

/** 切片: 以脚下 y 为准: 亮=可站的地面 (地面方块色), 暗=墙 (身体高度有实心方块), 越黑=坑越深 */
function sliceColor (world: World, wx: number, y: number, wz: number): RGB {
  const feet = world.getBlock(wx, y, wz)
  if (!feet) return UNKNOWN
  const head = world.getBlock(wx, y + 1, wz)
  const wallAt = world.isSolid(wx, y + 1, wz) ? head : world.isSolid(wx, y, wz) ? feet : null
  if (wallAt) { const c = blockColor(wallAt.name); return { r: c.r * 0.38, g: c.g * 0.38, b: c.b * 0.38 } }
  if (WATERY.test(feet.name) || feet.name === 'lava') return blockColor(feet.name)
  for (let k = 1; k <= 6; k++) {
    if (world.isSolid(wx, y - k, wz)) {
      const f = world.getBlock(wx, y - k, wz)!
      const c = blockColor(f.name)
      const m = k === 1 ? 1.05 : 0.75 - k * 0.08
      return { r: c.r * m + 20 * (k === 1 ? 1 : 0), g: c.g * m + 20 * (k === 1 ? 1 : 0), b: c.b * m + 20 * (k === 1 ? 1 : 0) }
    }
    const f = world.getBlock(wx, y - k, wz)
    if (f && (WATERY.test(f.name) || f.name === 'lava')) { const c = blockColor(f.name); return { r: c.r * 0.8, g: c.g * 0.8, b: c.b * 0.8 } }
  }
  return { r: 8, g: 8, b: 22 } // 深坑
}

/** 自己: 朝向箭头 (白边红芯) */
function drawArrow (png: PNG, cx: number, cy: number, yawDeg: number, L: number) {
  const yaw = yawDeg * Math.PI / 180
  const f = [-Math.sin(yaw), Math.cos(yaw)] // 地图坐标 (x 向右, z 向下)
  const p = [-f[1], f[0]]
  const tri = (s: number) => [
    [cx + f[0] * L * s, cy + f[1] * L * s],
    [cx - f[0] * L * 0.6 * s + p[0] * L * 0.6 * s, cy - f[1] * L * 0.6 * s + p[1] * L * 0.6 * s],
    [cx - f[0] * L * 0.6 * s - p[0] * L * 0.6 * s, cy - f[1] * L * 0.6 * s - p[1] * L * 0.6 * s],
  ]
  fillTri(png, tri(1.35), [255, 255, 255])
  fillTri(png, tri(1), [235, 30, 30])
}

function fillTri (png: PNG, t: number[][], c: RGBA) {
  const xs = t.map(p => p[0]), ys = t.map(p => p[1])
  const sign = (a: number[], b: number[], q: number[]) => (q[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (q[1] - b[1])
  for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
    for (let x = Math.floor(Math.min(...xs)); x <= Math.ceil(Math.max(...xs)); x++) {
      const q = [x + 0.5, y + 0.5]
      const d1 = sign(q, t[0], t[1]), d2 = sign(q, t[1], t[2]), d3 = sign(q, t[2], t[0])
      const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0
      if (!(neg && pos)) blend(png, x, y, c)
    }
  }
}

/** 右上角指北针 */
function drawNorth (png: PNG, fs: number, layout: LabelLayout) {
  const W = png.width
  const s = 6 * fs, cx = W - 6 * fs - 4, top = 4 * fs
  fillRect(png, cx - s, top - 2 * fs, 2 * s, s + textHeight(fs) + 6 * fs, [0, 0, 0], 0.55)
  fillTri(png, [[cx, top], [cx - s * 0.6, top + s], [cx + s * 0.6, top + s]], [255, 255, 255])
  drawText(png, cx - Math.floor(textWidth('N', fs) / 2), top + s + 2 * fs, 'N', [255, 255, 255], fs, null)
  layout.reserve({ x: cx - s, y: 0, w: 2 * s, h: top + s + textHeight(fs) + 6 * fs })
}

export function pngBuffer (png: PNG): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    png.pack()
      .on('data', (c: Buffer) => chunks.push(c))
      .on('end', () => resolve(Buffer.concat(chunks)))
  })
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
  let tEnter = 0
  for (let i = 0; i < MAX_DIST * 3; i++) {
    const b = world.getBlock(x, y, z)
    if (b && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'void_air') {
      return { name: b.name, x, y, z, dist: +tEnter.toFixed(1) }
    }
    if (tMaxX < tMaxY && tMaxX < tMaxZ) { tEnter = tMaxX; x += stepX; tMaxX += tDeltaX }
    else if (tMaxY < tMaxZ) { tEnter = tMaxY; y += stepY; tMaxY += tDeltaY }
    else { tEnter = tMaxZ; z += stepZ; tMaxZ += tDeltaZ }
    if (tEnter > MAX_DIST) break
  }
  return null
}
