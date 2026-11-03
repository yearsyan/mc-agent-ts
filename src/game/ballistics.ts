/**
 * 箭的弹道 (原版 AbstractArrow): 每 tick 先位移, 再速度 ×0.99 (水中 0.6), 再 y -= 0.05。
 * 满弓初速 3 格/tick (BowItem: power×3), 从眼睛下方 0.1 格射出。
 * 角度约定与 bot 一致: yaw 0=南(+z) 90=西(-x); pitch 正=向下 (度)。
 */
import type { World, TrackedEntity } from '../world/world.js'
import { entitySize, isHostile, isIgnorableEntity } from './knowledge.js'

export const ARROW_SPEED = 3.0
const DRAG = 0.99
const GRAVITY = 0.05

/** 仰角 theta (弧度, 向上为正) 射出后, 水平飞到 D 时的高度与用时; 到不了返回 null */
function heightAt (theta: number, D: number, v0: number): { y: number, t: number } | null {
  let h = 0, y = 0, vh = v0 * Math.cos(theta), vy = v0 * Math.sin(theta)
  for (let i = 0; i < 300; i++) {
    const nh = h + vh, ny = y + vy
    if (nh >= D) { const f = (D - h) / (nh - h); return { y: y + (ny - y) * f, t: i + f } }
    h = nh; y = ny; vh *= DRAG; vy = vy * DRAG - GRAVITY
    if (vh < 1e-3 || y < -200) return null
  }
  return null
}

/** 低抛物线解: 让箭在水平距离 D 处高度差为 dy 的仰角 (弧度) 与飞行 tick; 超出射程返回 null */
export function solvePitch (D: number, dy: number, v0 = ARROW_SPEED): { theta: number, ticks: number } | null {
  if (D < 0.05) return { theta: dy >= 0 ? Math.PI / 2 : -Math.PI / 2, ticks: Math.abs(dy) / v0 }
  // 先三分搜索出"水平距离 D 处能达到的最高点"对应的仰角 (近距离打高处时可达 80°+), 低抛解在它下方单调区间内
  const yAt = (t: number) => heightAt(t, D, v0)?.y ?? -Infinity
  let a = -1.45, b = 1.55
  for (let i = 0; i < 50; i++) { const m1 = a + (b - a) / 3, m2 = b - (b - a) / 3; if (yAt(m1) < yAt(m2)) a = m1; else b = m2 }
  let lo = -1.45, hi = (a + b) / 2
  if (yAt(hi) < dy) return null
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    const r = heightAt(mid, D, v0)
    if (!r || r.y < dy) lo = mid; else hi = mid
  }
  const r = heightAt(hi, D, v0)
  return r ? { theta: hi, ticks: r.t } : null
}

export interface Aim { yaw: number, pitch: number, ticks: number, point: { x: number, y: number, z: number }, dist: number }

/**
 * 瞄准: 从 from 射向以速度 vel (格/tick) 移动的目标点 target, 迭代求提前量。
 * 地面生物只预判水平速度 (垂直方向多是跳跃噪声), 飞行生物三维预判。
 */
export function aimAt (from: { x: number, y: number, z: number }, target: { x: number, y: number, z: number }, vel: { x: number, y: number, z: number }, flying = false, extraTicks = 1): Aim | null {
  let p = { ...target }
  let sol: { theta: number, ticks: number } | null = null
  for (let i = 0; i < 4; i++) {
    sol = solvePitch(Math.hypot(p.x - from.x, p.z - from.z), p.y - from.y)
    if (!sol) return null
    const t = sol.ticks + extraTicks
    p = { x: target.x + vel.x * t, y: target.y + (flying ? vel.y * t : 0), z: target.z + vel.z * t }
  }
  sol = solvePitch(Math.hypot(p.x - from.x, p.z - from.z), p.y - from.y)
  if (!sol) return null
  const dx = p.x - from.x, dz = p.z - from.z
  return { yaw: Math.atan2(-dx, dz) * 180 / Math.PI, pitch: -sol.theta * 180 / Math.PI, ticks: sol.ticks, point: p, dist: Math.hypot(dx, p.y - from.y, dz) }
}

/** 朝向 → 单位方向向量 */
export function dirOf (yawDeg: number, pitchDeg: number) {
  const y = yawDeg * Math.PI / 180, p = pitchDeg * Math.PI / 180
  return { x: -Math.sin(y) * Math.cos(p), y: -Math.sin(p), z: Math.cos(y) * Math.cos(p) }
}

/**
 * 按弹道逐 tick 追踪箭 (0.25 格细分), 看在到达瞄准点之前会不会撞到方块或别的实体。
 * 敌对生物不算阻挡 (射中也无妨), 其余活物 (玩家/村民/动物/宠物) 算误伤风险。
 */
export function traceArrow (world: World, from: { x: number, y: number, z: number }, aim: Aim, entities: Iterable<TrackedEntity>, targetId: number):
  { clear: true } | { clear: false, reason: string } {
  const d = dirOf(aim.yaw, aim.pitch)
  const v = { x: d.x * ARROW_SPEED, y: d.y * ARROW_SPEED, z: d.z * ARROW_SPEED }
  const p = { ...from }
  const goal = Math.hypot(aim.point.x - from.x, aim.point.z - from.z) - 0.4 // 到目标碰撞箱边缘为止
  const blockers = [...entities].filter(e => e.id !== targetId && !isHostile(e.type) && !isIgnorableEntity(e.type))
    .filter(e => Math.hypot(e.x - from.x, e.z - from.z) < goal + 2)
  for (let tick = 0; tick < 200; tick++) {
    const steps = Math.max(1, Math.ceil(Math.hypot(v.x, v.y, v.z) / 0.25))
    for (let s = 0; s < steps; s++) {
      p.x += v.x / steps; p.y += v.y / steps; p.z += v.z / steps
      if (Math.hypot(p.x - from.x, p.z - from.z) >= goal) return { clear: true }
      if (world.isSolid(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))) return { clear: false, reason: '视线被方块挡住' }
      for (const e of blockers) {
        const { w, h } = entitySize(e.type)
        if (Math.abs(p.x - e.x) < w / 2 + 0.3 && Math.abs(p.z - e.z) < w / 2 + 0.3 && p.y > e.y - 0.3 && p.y < e.y + h + 0.3) return { clear: false, reason: `射线上有 ${e.type}#${e.id}, 可能误伤` }
      }
    }
    v.x *= DRAG; v.y = v.y * DRAG - GRAVITY; v.z *= DRAG
  }
  return { clear: false, reason: '弹道追踪超时' }
}

/**
 * 弹射物是否会打到 body (脚底坐标 + 高 1.8 宽 0.6 的盒子): 用服务器下发的速度外推。
 * 返回预计命中的 tick 数, 不会命中返回 null。
 */
export function projectileEta (e: TrackedEntity, body: { x: number, y: number, z: number }, now = Date.now(), horizon = 30): number | null {
  if (!e.sv) return null
  const gravity = /arrow|trident|potion|snowball|egg|spit/.test(e.type)
  // 基准: 最近一次位置更新; 速度从 sv 下发时刻推进到该时刻
  const base = Math.max(e.lastUpdate, e.sv.at)
  const v = { ...e.sv }
  const adv = (n: number) => { for (let i = 0; i < n; i++) { v.x *= DRAG; v.z *= DRAG; v.y = gravity ? v.y * DRAG - GRAVITY : v.y * DRAG } }
  adv(Math.round((base - e.sv.at) / 50))
  const p = { x: e.x, y: e.y, z: e.z }
  const elapsed = Math.round((now - base) / 50)
  if (elapsed > 60) return null // 太久没消息, 多半已落地/消失
  for (let i = 0; i < elapsed + horizon; i++) {
    p.x += v.x; p.y += v.y; p.z += v.z
    adv(1)
    if (i < elapsed) continue
    if (Math.abs(p.x - body.x) < 0.9 && Math.abs(p.z - body.z) < 0.9 && p.y > body.y - 0.4 && p.y < body.y + 2.2) return i - elapsed + 1
    if (Math.hypot(v.x, v.y, v.z) < 0.05) return null
  }
  return null
}
