/**
 * 手持/背包操作辅助: 把物品换到快捷栏并选中、放置方块、关窗口。
 * 槽位一律用玩家窗口 (窗口 0) 编号: 9-35 背包, 36-44 快捷栏, 45 副手。
 */
import type { BotAgent } from '../conn/bot.js'
import type { AsyncAction } from './base.js'
import { toolKind, foodScore, weaponScore } from '../game/knowledge.js'

/** 有容器窗口开着时, 窗口 0 的点击会被服务器忽略; 先关掉 */
export function closeContainer (bot: BotAgent) {
  const wid = bot.inventory.activeWindowId
  if (wid !== null) bot.closeWindow(wid)
}

/** 选一个快捷栏位来接收新物品: 空位优先, 否则挑最"不重要"的 (非工具/武器/食物) */
function pickHotbarTarget (bot: BotAgent): number {
  const hb = bot.inventory.hotbar()
  const empty = hb.findIndex(s => !s)
  if (empty >= 0) return empty
  const value = (i: number) => {
    const n = hb[i]!.name
    return (toolKind(n) ? 3 : 0) + (weaponScore(n) ? 3 : 0) + (foodScore(n) ? 2 : 0)
  }
  let best = 8
  for (let i = 8; i >= 0; i--) if (value(i) < value(best)) best = i
  return best
}

/** 把 slot 的物品放到快捷栏, 返回快捷栏下标 (已在快捷栏则直接返回) */
export async function toHotbar (act: AsyncAction, bot: BotAgent, slot: number): Promise<number> {
  if (slot >= 36 && slot <= 44) return slot - 36
  const name = bot.inventory.slots[slot]?.name
  if (!name) throw new Error(`槽位 ${slot} 是空的`)
  closeContainer(bot)
  const target = pickHotbarTarget(bot)
  bot.clickSlot(0, slot, target, 2) // mode 2 = 与快捷栏 button 位交换
  await act.until(() => bot.inventory.slots[36 + target]?.name === name, 2000, '物品换到快捷栏')
  return target
}

/** 让手里拿着 slot 的物品 */
export async function holdSlot (act: AsyncAction, bot: BotAgent, slot: number) {
  const idx = await toHotbar(act, bot, slot)
  if (bot.inventory.heldSlot !== idx) {
    bot.selectSlot(idx)
    await act.sleep(60) // 留一个 tick 让服务器先处理切换
  }
}

/** 拿起名为 name 的物品; 没有则抛错 */
export async function holdItem (act: AsyncAction, bot: BotAgent, name: string) {
  const hit = bot.inventory.find(s => s.name === name)[0]
  if (!hit) throw new Error(`背包里没有 ${name}`)
  await holdSlot(act, bot, hit.slot)
}

/** 空出手: 选一个空的或非方块物品的快捷栏位 (右键交互时避免误放方块) */
export async function holdNothing (act: AsyncAction, bot: BotAgent) {
  const hb = bot.inventory.hotbar()
  let idx = hb.findIndex(s => !s)
  if (idx < 0) idx = hb.findIndex(s => !!s && (!!toolKind(s.name) || !!foodScore(s.name)))
  if (idx < 0) idx = 8
  if (bot.inventory.heldSlot !== idx) { bot.selectSlot(idx); await act.sleep(60) }
}

/**
 * 同步版 (给逐 tick 的 MoveTo 用): 目标已在快捷栏 → 选中并返回 true;
 * 否则发一次交换点击并返回 false, 调用方下个 tick 再试。
 */
export function prepareHeld (bot: BotAgent, slot: number): boolean {
  if (slot >= 36 && slot <= 44) {
    if (bot.inventory.heldSlot !== slot - 36) bot.selectSlot(slot - 36)
    return true
  }
  const now = Date.now()
  if (now - (lastSwapAt.get(bot.name) ?? 0) < 600) return false
  lastSwapAt.set(bot.name, now)
  closeContainer(bot)
  bot.clickSlot(0, slot, pickHotbarTarget(bot), 2)
  return false
}
const lastSwapAt = new Map<string, number>()

/** 在 (x,y,z) 放置手里的方块 (空气/可替换格可直接放, 不需要相邻支撑) */
export function placeBlockAt (bot: BotAgent, x: number, y: number, z: number, face = 1) {
  bot.client.write('block_place', {
    hand: 'main_hand',
    location: { x, y, z },
    direction: face,
    cursorX: 0.5, cursorY: 0.5, cursorZ: 0.5,
    insideBlock: false,
    worldBorderHit: false,
    sequence: bot.nextSequence(),
  })
  bot.client.write('arm_animation', { hand: 'main_hand' })
}

/** 面向某点 (更新 yaw/pitch, 随下一 tick 的 position_look 发给服务器) */
export function faceTowards (bot: BotAgent, x: number, y: number, z: number) {
  const dx = x - bot.pos.x, dy = y - (bot.pos.y + 1.62), dz = z - bot.pos.z
  bot.yaw = Math.atan2(-dx, dz) * 180 / Math.PI
  bot.pitch = -Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI
}

/** 眼睛到方块中心的距离 (粗略; 判断够不够得着用 canReach) */
export function reachTo (bot: BotAgent, x: number, y: number, z: number) {
  return Math.hypot(x + 0.5 - bot.pos.x, y + 0.5 - (bot.pos.y + 1.62), z + 0.5 - bot.pos.z)
}

// ---------- 触及与视线 ----------

/** 交互/挖/放的触及范围: 眼睛到方块包围盒最近点 (原版客户端 4.5, 留 0.1 余量; 服务器校验更宽) */
export const REACH = 4.4

type P3 = { x: number, y: number, z: number }
export const eyeOf = (bot: BotAgent): P3 => ({ x: bot.pos.x, y: bot.pos.y + 1.62, z: bot.pos.z })

/** 点 p 到方块 (x,y,z) 包围盒的最近距离 */
export function boxDist (p: P3, x: number, y: number, z: number) {
  const d = (v: number, lo: number) => Math.max(lo - v, 0, v - (lo + 1))
  return Math.hypot(d(p.x, x), d(p.y, y), d(p.z, z))
}

/** 站在当前位置够不够得着方块 (x,y,z) */
export const canReach = (bot: BotAgent, x: number, y: number, z: number) => boxDist(eyeOf(bot), x, y, z) <= REACH

/** 一条射线 from→to (to 在目标方块内) 途中有没有被别的实心方块挡住 (体素 DDA) */
function rayClear (world: BotAgent['world'], from: P3, to: P3, tx: number, ty: number, tz: number): boolean {
  let cx = Math.floor(from.x), cy = Math.floor(from.y), cz = Math.floor(from.z)
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z
  const sx = Math.sign(dx), sy = Math.sign(dy), sz = Math.sign(dz)
  const inv = (v: number) => v !== 0 ? Math.abs(1 / v) : Infinity
  const tdx = inv(dx), tdy = inv(dy), tdz = inv(dz)
  const first = (f: number, c: number, s: number, td: number) => s > 0 ? (c + 1 - f) * td : s < 0 ? (f - c) * td : Infinity
  let tmx = first(from.x, cx, sx, tdx), tmy = first(from.y, cy, sy, tdy), tmz = first(from.z, cz, sz, tdz)
  for (let i = 0; i < 64; i++) {
    if (cx === tx && cy === ty && cz === tz) return true
    if (i > 0 && world.isSolid(cx, cy, cz)) return false // 起点 (眼睛所在格) 不算
    if (tmx < tmy && tmx < tmz) { if (tmx > 1) return false; cx += sx; tmx += tdx } else if (tmy < tmz) { if (tmy > 1) return false; cy += sy; tmy += tdy } else { if (tmz > 1) return false; cz += sz; tmz += tdz }
  }
  return false
}

/** 从 eye 到某点 (如实体身体中心) 的视线有没有被实心方块挡住 */
export const canSeePoint = (world: BotAgent['world'], eye: P3, p: P3) => rayClear(world, eye, p, Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))

/** 眼睛到实体碰撞箱的最近距离 (原版实体交互/攻击距离 3.0) */
export function entityBoxDist (eye: P3, e: { x: number, y: number, z: number }, w: number, h: number) {
  const d = (v: number, lo: number, hi: number) => Math.max(lo - v, 0, v - hi)
  return Math.hypot(d(eye.x, e.x - w / 2, e.x + w / 2), d(eye.y, e.y, e.y + h), d(eye.z, e.z - w / 2, e.z + w / 2))
}

/** 从 eye 看不看得见方块 (x,y,z): 中心与 6 个面 (内缩 0.1) 共 7 个采样点, 有一条没被挡住即可 */
export function canSee (world: BotAgent['world'], eye: P3, x: number, y: number, z: number): boolean {
  const pts: P3[] = [{ x: x + 0.5, y: y + 0.5, z: z + 0.5 },
    { x: x + 0.1, y: y + 0.5, z: z + 0.5 }, { x: x + 0.9, y: y + 0.5, z: z + 0.5 },
    { x: x + 0.5, y: y + 0.1, z: z + 0.5 }, { x: x + 0.5, y: y + 0.9, z: z + 0.5 },
    { x: x + 0.5, y: y + 0.5, z: z + 0.1 }, { x: x + 0.5, y: y + 0.5, z: z + 0.9 }]
  return pts.some(p => rayClear(world, eye, p, x, y, z))
}
