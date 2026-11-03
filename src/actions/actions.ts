/**
 * 基础动作: 移动 / 挖掘 / 放置 / 攻击 / 容器 / 简单动作。
 * act() -> actionId; 状态机式动作每 tick 由 BotAgent 驱动 step(), 多步动作用 AsyncAction.run()。
 */
import type { BotAgent } from '../conn/bot.js'
import { findPath, placementsIn, isOpenable, type PathNode } from './astar.js'
import { Action, AsyncAction } from './base.js'
import { fluidHeight } from '../physics/runner.js'
import { holdSlot, holdItem, holdNothing, prepareHeld, placeBlockAt, faceTowards, reachTo, closeContainer } from './hands.js'
import { bestToolFor, toolKind, weaponScore, blockProps, SCAFFOLD_BLOCKS, isWatery } from '../game/knowledge.js'

export { Action, AsyncAction } from './base.js'
export type { ActionStatus } from './base.js'

const AIRISH = new Set(['air', 'cave_air', 'void_air'])
const isSoft = (name: string) => ['snow', 'short_grass', 'tall_grass', 'fern', 'torch'].includes(name)

/** 背包里的垫脚方块 (按 SCAFFOLD_BLOCKS 优先级) */
export function scaffoldSlots (bot: BotAgent) {
  const hits = bot.inventory.find(s => SCAFFOLD_BLOCKS.includes(s.name))
  hits.sort((a, b) => SCAFFOLD_BLOCKS.indexOf(a.item.name) - SCAFFOLD_BLOCKS.indexOf(b.item.name))
  return hits
}
const scaffoldCount = (bot: BotAgent) => scaffoldSlots(bot).reduce((n, h) => n + h.item.count, 0)

/** 背包里所有工具 (挖掘选工具用) */
export const toolCandidates = (bot: BotAgent) => bot.inventory.find(s => !!toolKind(s.name)).map(h => ({ slot: h.slot, name: h.item.name }))

// ---------- 移动 ----------

export interface MoveOptions {
  /** 到达容差 (格); 0 = 必须站到目标格 */
  tolerance?: number
  timeoutMs?: number
  allowDig?: boolean
  /** 允许垫方块/搭桥 (默认 true, 背包有泥土/圆石等时生效) */
  allowPlace?: boolean
}

/** 单段规划的最远水平距离; 更远的目标分段前进 (每段重新规划, 区块会随移动加载) */
const SEGMENT = 64

export class MoveToAction extends Action {
  private path: PathNode[] | null = null
  private wpIdx = 0
  private lastProgressAt = 0
  private lastWpProgressAt = 0
  private lastDist = Infinity
  private lastJumpAt = 0
  private replans = 0
  private strafeUntil = 0
  private strafeDir = 1
  private startedAt = 0
  private readonly deadline: number
  /** 当前段是中途点 (目标太远或未加载) */
  private segmenting = false
  private segments = 0
  private tol: number
  // 挖掘子状态
  private digY: number | null = null
  private digSentAt = 0
  private digStopSent = false
  private digEstMs = 0
  private digTries = 0
  // 放置子状态
  private placeSentAt = 0
  private placeTries = 0
  private pillarBaseY: number | null = null
  // 开门
  private doorToggledAt = new Map<string, number>()
  private handOwner: string

  constructor (private bot: BotAgent, private target: { x: number, y?: number, z: number }, private opts: MoveOptions = {}) {
    super('move_to')
    this.tol = opts.tolerance ?? 1
    const dist = Math.hypot(target.x - bot.pos.x, target.z - bot.pos.z)
    this.deadline = Date.now() + (opts.timeoutMs ?? Math.max(90_000, dist * 1500))
    this.handOwner = `move#${this.id}`
  }

  private standableAt (x: number, y: number, z: number) {
    const w = this.bot.world
    const feet = w.getBlock(x, y, z), head = w.getBlock(x, y + 1, z), below = w.getBlock(x, y - 1, z)
    if (!feet || !head || !below) return false
    const ok = (n: string) => AIRISH.has(n) || isSoft(n) || isOpenable(n)
    // 脚可以在水里 (水面游泳), 头必须在空气里, 否则会把目标定到海底
    return (ok(feet.name) || isWatery(feet.name)) && ok(head.name) && !AIRISH.has(below.name) && below.name !== 'lava'
  }

  /** 目标列自适应: 指定高度不可站时上下扫 ±8 */
  private adaptY (x: number, y: number, z: number) {
    if (this.standableAt(x, y, z)) return y
    for (let dy = 1; dy <= 8; dy++) {
      if (this.standableAt(x, y + dy, z)) return y + dy
      if (this.standableAt(x, y - dy, z)) return y - dy
    }
    return y
  }

  private plan (): boolean {
    const bot = this.bot, w = bot.world
    const from = { x: Math.floor(bot.pos.x), y: Math.floor(bot.pos.y), z: Math.floor(bot.pos.z) }
    const tx = Math.floor(this.target.x), tz = Math.floor(this.target.z)
    const dist = Math.hypot(tx - from.x, tz - from.z)
    const targetLoaded = !!w.getChunk(tx >> 4, tz >> 4)
    const scaffold = this.opts.allowPlace === false ? 0 : scaffoldCount(bot)
    const allowDig = this.opts.allowDig ?? true
    const tryPath = (to: PathNode, tolerance: number, maxExpansions?: number) => {
      let p = findPath(w, from, to, { scaffold, tolerance, allowDig, maxExpansions })
      // 方块不够用, 或带放置的搜索没找到 (搜索空间大): 不放方块再试一次
      if ((p && placementsIn(p) > scaffold) || (!p && scaffold > 0)) p = findPath(w, from, to, { scaffold: 0, tolerance, allowDig, maxExpansions })
      return p
    }
    let path: PathNode[] | null = null
    let to: PathNode
    this.segmenting = dist > SEGMENT || !targetLoaded
    if (this.segmenting) {
      // 朝目标方向取已加载的中途点: 先直线, 不通再偏一点角度/缩短距离; 优先落在陆地上 (海面中途点很难规划)
      const base = Math.atan2(tz - from.z, tx - from.x)
      const cands: { p: PathNode, land: boolean, rank: number }[] = []
      for (const d of [SEGMENT, 40, 24]) {
        for (const da of [0, 0.5, -0.5, 1.0, -1.0]) {
          const dd = Math.min(d, dist)
          const sx = Math.floor(from.x + Math.cos(base + da) * dd), sz = Math.floor(from.z + Math.sin(base + da) * dd)
          if (!w.getChunk(sx >> 4, sz >> 4)) continue
          const top = w.highestBlockY(sx, sz)
          const land = w.getBlock(sx, top, sz)?.name !== 'water'
          cands.push({ p: { x: sx, y: this.adaptY(sx, top + 1, sz), z: sz }, land, rank: -dd + Math.abs(da) * 20 })
        }
      }
      cands.sort((a, b) => (a.land === b.land ? a.rank - b.rank : a.land ? -1 : 1))
      if (!cands.length) { this.fail(`目标 (${tx},${tz}) 方向上没有已加载的区块`); return false }
      to = cands[0].p
      for (const c of cands.slice(0, 6)) {
        path = tryPath(c.p, 3, 20000)
        if (path) { to = c.p; break }
      }
    } else {
      const ty = Math.floor(this.target.y ?? bot.pos.y)
      // 精确目标 (tolerance 0 且给了 y) 不做高度自适应: 调用方选的点可能是要垫方块上去的空中位置
      to = { x: tx, y: this.tol === 0 && this.target.y !== undefined ? ty : this.adaptY(tx, ty, tz), z: tz }
      path = tryPath(to, this.tol)
    }
    if (!path || path.length === 0) {
      this.fail(`无可行路径 ${from.x},${from.y},${from.z} -> ${to.x},${to.y},${to.z}${this.segmenting ? ' (远程中途点, 已试多个方向)' : ''}`)
      return false
    }
    this.path = path
    this.wpIdx = Math.min(1, path.length - 1)
    this.digY = null
    this.placeSentAt = 0
    this.pillarBaseY = null
    return true
  }

  start () {
    this.startedAt = this.lastProgressAt = this.lastWpProgressAt = Date.now()
    this.plan()
  }

  step (nowMs: number) {
    if (!this.path) return
    const bot = this.bot
    if (nowMs > this.deadline) { this.stopMoving(); return this.fail('超时') }
    if (nowMs - this.lastProgressAt > 18000) { this.stopMoving(); return this.fail('超时: 18 秒无进展') }

    const wp = this.path[this.wpIdx]
    const dx = wp.x + 0.5 - bot.pos.x
    const dz = wp.z + 0.5 - bot.pos.z
    const distWp = Math.hypot(dx, dz)
    const c = bot.physics.control
    const inWater = bot.physics.inWater

    // ---- 门: 目标格的门关着就先打开 ----
    if (wp.door && this.openDoorIfClosed(wp, nowMs)) { this.halt(); return }

    // ---- 挖穿航点 ----
    if (wp.dig && this.handleDig(wp, nowMs)) return

    // ---- 搭桥: 走上去前先在脚下放方块 ----
    if (wp.place === 'bridge' && this.handleBridge(wp, nowMs)) return

    // ---- 垫方块上升 ----
    if (wp.place === 'pillar') { this.handlePillar(wp, nowMs); return }

    // ---- 到达判定 ----
    const finalWp = this.wpIdx >= this.path.length - 1
    const dyWp = wp.y - bot.pos.y
    // 游泳姿态时身体在水面下 ~0.2-0.6 格, 竖直判定放宽
    const vertOk = bot.swimming ? Math.abs(dyWp) < 1.2 : wp.climb || wp.swim ? Math.abs(dyWp) < 0.45 : dyWp < 0.6
    const arriveR = finalWp ? (this.tol === 0 && !this.segmenting ? 0.4 : 2.0) : (wp.climb ? 0.6 : 1.6)
    if (distWp < arriveR && vertOk && !(finalWp && this.tol === 0 && !bot.onGround && !inWater && !wp.climb)) {
      if (finalWp) {
        if (this.segmenting) { this.segments++; this.lastProgressAt = nowMs; if (!this.plan()) this.stopMoving(); return }
        this.stopMoving()
        return this.finish(`到达 ${wp.x},${wp.y},${wp.z}${this.segments ? ` (分 ${this.segments + 1} 段)` : ''}`)
      }
      this.wpIdx++
      this.lastWpProgressAt = nowMs
      return
    }
    // 航点跳跃: 下一航点已比当前近则跳过 (特殊航点不跳)
    if (!finalWp && !wp.climb && !wp.swim) {
      const nxt = this.path[this.wpIdx + 1]
      if (!nxt.place && !nxt.dig && !nxt.door && !nxt.climb) {
        const dNext = Math.hypot(nxt.x + 0.5 - bot.pos.x, nxt.z + 0.5 - bot.pos.z)
        if (dNext < distWp - 0.3 && Math.abs(nxt.y - bot.pos.y) < 1.2) { this.wpIdx++; this.lastWpProgressAt = nowMs; return }
      }
    }

    // ---- 总体进展 ----
    const distFinal = Math.hypot(this.target.x - bot.pos.x, (this.target.y ?? bot.pos.y) - bot.pos.y, this.target.z - bot.pos.z)
    if (distFinal < this.lastDist - 0.4) { this.lastDist = distFinal; this.lastProgressAt = nowMs }

    // ---- 朝向 + 控制量 ----
    const targetYaw = Math.atan2(-dx, dz) * 180 / Math.PI
    bot.yaw = lerpAngle(bot.yaw, targetYaw, 0.35)
    bot.pitch = 0
    c.forward = distWp > (wp.climb ? 0.15 : 0.25)
    c.back = false
    c.sneak = false
    c.sprint = !finalWp && distWp > 6 && !inWater
    // 冲刺游泳: 前方连续深水航点够长才用 (进入要先下沉到眼睛没水, 短距离不划算); 快到岸时退出, 普通游上岸
    const swimRun = this.swimRunAhead()
    const sprintSwim = inWater && bot.food > 6 && (bot.swimming ? swimRun >= 3 : swimRun >= 6 && wp.swim)
    if (wp.climb) {
      c.jump = wp.y > bot.pos.y - 0.05 // 梯子上按跳 = 向上爬
      c.sprint = false
    } else if (sprintSwim) {
      c.sprint = true
      if (bot.swimming) this.holdSwimDepth()
      else { c.jump = false; c.sneak = true } // 按 shift 下潜, 眼睛没入水中后进入游泳姿态
    } else if (inWater) {
      c.jump = true // 水里按住跳保持浮在水面 / 上岸
    } else {
      c.jump = wp.y > Math.floor(bot.pos.y) && bot.onGround
      if (!c.jump) c.jump = this.stuckAgainstWall() && bot.onGround && nowMs - this.lastJumpAt > 700
    }
    if (c.jump && bot.onGround) this.lastJumpAt = nowMs

    // ---- 卡住恢复: 侧移 ----
    if (nowMs - this.lastWpProgressAt > 2200 && nowMs - this.lastJumpAt > 900 && bot.onGround && !wp.climb) {
      if (this.strafeUntil < nowMs) { this.strafeUntil = nowMs + 700; this.strafeDir *= -1 }
    }
    const strafing = nowMs < this.strafeUntil
    c.left = strafing && this.strafeDir > 0
    c.right = strafing && this.strafeDir < 0

    // ---- 重规划 ----
    if (nowMs - this.lastWpProgressAt > 5000) {
      if (++this.replans > 5) { this.stopMoving(); return this.fail(`重规划 5 次仍卡在 (${wp.x},${wp.y},${wp.z})`) }
      if (!this.plan()) return
      this.lastWpProgressAt = nowMs
    }
  }

  /** 门/栅栏门关着: 停下, 右键打开; 返回 true 表示本 tick 在处理门 */
  private openDoorIfClosed (wp: PathNode, nowMs: number): boolean {
    const w = this.bot.world
    for (const y of [wp.y, wp.y + 1]) {
      const b = w.getBlock(wp.x, y, wp.z)
      if (!b || !isOpenable(b.name)) continue
      if (blockProps(b.stateId).open === 'true') return false
      const k = `${wp.x},${y},${wp.z}`
      if (reachTo(this.bot, wp.x, y, wp.z) > 4) return false // 先走近
      if (nowMs - (this.doorToggledAt.get(k) ?? 0) > 1200) {
        this.doorToggledAt.set(k, nowMs)
        faceTowards(this.bot, wp.x + 0.5, y + 0.5, wp.z + 0.5)
        this.bot.interactBlock(wp.x, y, wp.z)
        this.lastProgressAt = nowMs
      }
      return true
    }
    return false
  }

  /** 挖穿航点; 返回 true 表示本 tick 在挖 (不走) */
  private handleDig (wp: PathNode, nowMs: number): boolean {
    const bot = this.bot
    if (this.digY === null) {
      const cells = wp.dig === 'up' ? [wp.y, wp.y + 1, wp.y + 2] : wp.dig === 'down' ? [wp.y] : [wp.y, wp.y + 1]
      const next = cells.find(y => { const b = bot.world.getBlock(wp.x, y, wp.z); return b && !AIRISH.has(b.name) && !isSoft(b.name) && b.name !== 'water' })
      if (next === undefined) { bot.releaseHand(this.handOwner); return false } // 已挖好, 正常走过去
      this.digY = next; this.digSentAt = 0; this.digTries = 0
    }
    const b = bot.world.getBlock(wp.x, this.digY, wp.z)
    if (!b || AIRISH.has(b.name) || isSoft(b.name) || b.name === 'water') {
      this.digY = null
      this.lastProgressAt = nowMs
      return true // 这格挖完了, 下个 tick 处理下一格
    }
    this.halt()
    if (!this.digSentAt) {
      if (!bot.tryLockHand(this.handOwner)) return true // 手被占用 (如在吃东西)
      const tool = bestToolFor(b.name, toolCandidates(bot))
      if (tool.slot !== null && !prepareHeld(bot, tool.slot)) return true // 工具换到快捷栏中, 下 tick 再挖
      this.digEstMs = Math.min(60_000, tool.ticks * 50 + 150)
      this.digSentAt = nowMs
      this.digStopSent = false
      faceTowards(bot, wp.x + 0.5, this.digY + 0.5, wp.z + 0.5)
      bot.client.write('block_dig', { status: 0, location: { x: wp.x, y: this.digY, z: wp.z }, face: this.digFace(wp), sequence: bot.nextSequence() })
      this.lastProgressAt = nowMs
    }
    if (!this.digStopSent && nowMs - this.digSentAt >= this.digEstMs) {
      this.digStopSent = true
      bot.client.write('block_dig', { status: 3, location: { x: wp.x, y: this.digY, z: wp.z }, face: this.digFace(wp), sequence: bot.nextSequence() })
    }
    if (nowMs - this.digSentAt > this.digEstMs + 4000) {
      // 服务器没破坏: 重来一次 (重发 START 会重置进度, 所以只在超时后)
      if (++this.digTries > 2) { this.stopMoving(); this.fail(`挖不动 ${b.name} (${wp.x},${this.digY},${wp.z})`); return true }
      this.digSentAt = 0
    }
    if (nowMs % 300 < 50) bot.client.write('arm_animation', { hand: 'main_hand' })
    this.lastProgressAt = Math.max(this.lastProgressAt, nowMs - 15000)
    return true
  }

  /** 搭桥: 目标格下方没支撑就放一块; 返回 true 表示本 tick 在放 */
  private handleBridge (wp: PathNode, nowMs: number): boolean {
    const bot = this.bot
    const support = bot.world.getBlock(wp.x, wp.y - 1, wp.z)
    if (support && !AIRISH.has(support.name) && support.name !== 'water' && !isSoft(support.name)) { this.placeSentAt = 0; this.placeTries = 0; return false }
    this.halt()
    this.bot.physics.control.sneak = true // 边缘下蹲, 防止掉下去
    return this.placeScaffold(wp.x, wp.y - 1, wp.z, nowMs)
  }

  /** 垫方块上升: 跳起, 升过一格后在原脚下放方块 */
  private handlePillar (wp: PathNode, nowMs: number) {
    const bot = this.bot, c = bot.physics.control
    const baseY = wp.y - 1
    const placed = bot.world.getBlock(wp.x, baseY, wp.z)
    const solid = placed && !AIRISH.has(placed.name) && !isSoft(placed.name)
    c.forward = c.left = c.right = c.sprint = false
    if (solid && bot.onGround && bot.pos.y >= wp.y - 0.1) {
      // 已站上新方块
      this.placeSentAt = 0
      this.placeTries = 0
      this.lastWpProgressAt = this.lastProgressAt = nowMs
      if (this.wpIdx < this.path!.length - 1) { this.wpIdx++; return }
      if (this.segmenting) { this.segments++; if (!this.plan()) this.stopMoving(); return }
      this.stopMoving()
      return this.finish(`到达 ${wp.x},${wp.y},${wp.z} (垫高上来)`)
    }
    // 先站到这一列正中 (前一航点按 1.6 格宽松判定, 可能还离得远), 对正了再起跳
    const dx = wp.x + 0.5 - bot.pos.x, dz = wp.z + 0.5 - bot.pos.z
    if (!solid && Math.hypot(dx, dz) > 0.3 && bot.pos.y < baseY + 0.5) {
      bot.yaw = Math.atan2(-dx, dz) * 180 / Math.PI
      bot.pitch = 0
      c.forward = true
      c.sneak = Math.hypot(dx, dz) < 1 // 快到时下蹲慢走, 防冲过头掉下去
      c.jump = false
      if (bot.onGround && nowMs - this.lastJumpAt > 700 && this.stuckAgainstWall()) { c.jump = true; this.lastJumpAt = nowMs }
      return
    }
    c.sneak = false
    bot.pitch = 90
    if (!solid) {
      if (bot.onGround && bot.pos.y < baseY + 0.5) { c.jump = true; this.lastJumpAt = nowMs } else c.jump = false
      if (bot.pos.y >= baseY + 1.0) this.placeScaffold(wp.x, baseY, wp.z, nowMs)
    } else c.jump = false
  }

  /** 在 (x,y,z) 放垫脚方块; 返回 true 表示还在处理 */
  private placeScaffold (x: number, y: number, z: number, nowMs: number): boolean {
    const bot = this.bot
    const blocks = scaffoldSlots(bot)
    if (!blocks.length) { this.stopMoving(); this.fail('没有可用于垫脚/搭桥的方块了'); return true }
    if (!prepareHeld(bot, blocks[0].slot)) return true
    if (nowMs - this.placeSentAt > 600) {
      if (++this.placeTries > 12) { this.stopMoving(); this.fail(`放置方块失败 (${x},${y},${z})`); return true }
      this.placeSentAt = nowMs
      faceTowards(bot, x + 0.5, y + 0.5, z + 0.5)
      placeBlockAt(bot, x, y, z)
      this.lastProgressAt = nowMs
    }
    return true
  }

  private digFace (wp: PathNode): number {
    if (wp.dig === 'down') return 1 // 挖脚下: 点顶面
    const dx = wp.x + 0.5 - this.bot.pos.x
    const dz = wp.z + 0.5 - this.bot.pos.z
    return Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 4 : 5) : (dz > 0 ? 2 : 3)
  }

  private stuckAgainstWall (): boolean {
    const yawRad = this.bot.yaw * Math.PI / 180
    const fx = Math.floor(this.bot.pos.x - Math.sin(yawRad))
    const fz = Math.floor(this.bot.pos.z + Math.cos(yawRad))
    const fy = Math.floor(this.bot.pos.y)
    return this.bot.world.isSolid(fx, fy, fz) || this.bot.world.isSolid(fx, fy + 1, fz)
  }

  /** 从当前航点起连续深水 (游泳) 航点数 */
  private swimRunAhead () {
    let n = 0
    for (let i = this.wpIdx; i < (this.path?.length ?? 0) && this.path![i].swim; i++) n++
    return n
  }

  /**
   * 游泳姿态下保持在水面: 身体顶部露出、眼睛 (眼高 0.4) 刚好在水面上能换气。
   * 高了低头下潜 (视线 y 分量决定竖直速度), 低了按跳上浮。
   */
  private holdSwimDepth () {
    const bot = this.bot, c = bot.physics.control
    const x = Math.floor(bot.pos.x), z = Math.floor(bot.pos.z)
    let by = Math.floor(bot.pos.y)
    for (let i = 0; i < 4 && fluidHeight(bot.world, x, by + 1, z) > 0; i++) by++
    const f = fluidHeight(bot.world, x, by, z)
    if (!f) { c.jump = false; bot.pitch = 0; return }
    // 目标: 箱底在水面下 0.15 (眼睛 = 箱底 +0.4 露出水面可换气; 箱底低于水面才算在水里, 否则会退出游泳姿态)
    // 不操作时竖直速度每 tick 约衰减到 0.75 倍, 还会再漂 ≈3.2·vy; 按预测的停稳位置决定上浮/下潜, 避免冲出水面来回振荡
    const pred = bot.pos.y - (by + f - 0.15) + bot.physics.velocity.y * 3.2
    c.sneak = false
    if (pred < -0.05) { bot.pitch = 0; c.jump = true } else if (pred > 0.05) { bot.pitch = Math.min(25, 4 + pred * 40); c.jump = false } else { bot.pitch = 0; c.jump = false }
  }

  /** 原地停住 (不结束动作) */
  private halt () {
    const c = this.bot.physics.control
    c.forward = c.back = c.left = c.right = c.sprint = false
    c.jump = this.bot.physics.inWater
  }

  private stopMoving () {
    const c = this.bot.physics.control
    c.forward = c.back = c.left = c.right = c.jump = c.sprint = c.sneak = false
    this.bot.releaseHand(this.handOwner)
  }

  cancel (reason = '') {
    super.cancel(reason)
    this.stopMoving()
  }

  finish (detail = '') { this.bot.releaseHand(this.handOwner); super.finish(detail) }
  fail (detail = '') { this.stopMoving(); super.fail(detail) }
}

function lerpAngle (a: number, b: number, t: number) {
  const d = ((b - a + 540) % 360) - 180
  return a + d * t
}

// ---------- 挖掘 ----------

export class DigAction extends AsyncAction {
  private owner = `dig#${this.id}`
  constructor (bot: BotAgent, private x: number, private y: number, private z: number) { super(bot, 'dig') }

  /** 选一个暴露的面 (法线朝向 agent 且相邻格是空气), 否则顶面 */
  private pickFace (): number {
    const { x, y, z } = this
    const dx = x + 0.5 - this.bot.pos.x, dy = y + 0.5 - (this.bot.pos.y + 1.62), dz = z + 0.5 - this.bot.pos.z
    const air = (ax: number, ay: number, az: number) => { const b = this.bot.world.getBlock(ax, ay, az); return !b || AIRISH.has(b.name) || isSoft(b.name) }
    // face: 0=-y 1=+y 2=-z 3=+z 4=-x 5=+x
    const cands: [number, number, number, number, number][] = [
      [dx > 0 ? 4 : 5, Math.abs(dx), dx > 0 ? -1 : 1, 0, 0],
      [dz > 0 ? 2 : 3, Math.abs(dz), 0, 0, dz > 0 ? -1 : 1],
      [dy > 0 ? 0 : 1, Math.abs(dy), 0, dy > 0 ? -1 : 1, 0],
    ]
    cands.sort((a, b) => b[1] - a[1])
    for (const [f, , ox, oy, oz] of cands) if (air(x + ox, y + oy, z + oz)) return f
    return 1
  }

  protected async run () {
    const { x, y, z, bot } = this
    const b = bot.world.getBlock(x, y, z)
    if (!b || AIRISH.has(b.name)) throw new Error(`(${x},${y},${z}) 没有可挖方块`)
    if (b.name === 'water' || b.name === 'lava') throw new Error(`(${x},${y},${z}) 是 ${b.name}, 挖不了`)
    // 挖穿进岩浆是最常见的死法: 旁边/上方有岩浆就不挖
    const lavaSide = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]].find(([ox, oy, oz]) => bot.world.getBlock(x + ox, y + oy, z + oz)?.name === 'lava')
    if (lavaSide) throw new Error(`(${x},${y},${z}) 旁边有岩浆 (${x + lavaSide[0]},${y + lavaSide[1]},${z + lavaSide[2]}), 挖开会流出来, 不挖`)
    const dist = reachTo(bot, x, y, z)
    if (dist > 4.6) throw new Error(`距离 ${dist.toFixed(1)} 超出触及范围 4.5`)
    await this.until(() => bot.tryLockHand(this.owner), 5000, '手空闲')
    const tool = bestToolFor(b.name, toolCandidates(bot))
    if (!Number.isFinite(tool.ticks)) throw new Error(`${b.name} 不可破坏`)
    if (tool.slot !== null) await holdSlot(this, bot, tool.slot)
    const estMs = tool.ticks * 50 + 150
    faceTowards(bot, x + 0.5, y + 0.5, z + 0.5)
    await this.sleep(60) // 朝向随下一 tick 发出
    const face = this.pickFace()
    const t0 = Date.now()
    bot.client.write('block_dig', { status: 0, location: { x, y, z }, face, sequence: bot.nextSequence() })
    let stopSent = false, lastSwing = 0
    for (;;) {
      const now = Date.now()
      const cur = bot.world.getBlock(x, y, z)
      if (!cur || cur.name !== b.name) {
        const how = tool.name ? `用 ${tool.name}` : '空手'
        return `已挖掉 ${b.name} (${x},${y},${z}) ${how}, ${((now - t0) / 1000).toFixed(1)}s${tool.harvest ? '' : ' (工具不对, 不会掉落)'}`
      }
      if (now - lastSwing > 300) { lastSwing = now; bot.client.write('arm_animation', { hand: 'main_hand' }) }
      // 26.3: 3=STOP_DESTROY (2 是 ABORT); 不重发 START (会重置服务器进度)
      if (!stopSent && now - t0 >= estMs) { stopSent = true; bot.client.write('block_dig', { status: 3, location: { x, y, z }, face, sequence: bot.nextSequence() }) }
      if (now - t0 > estMs + 5000) throw new Error(`方块未变化 (预计 ${(estMs / 1000).toFixed(1)}s)`)
      await this.sleep(50)
    }
  }

  protected cleanup () { this.bot.releaseHand(this.owner) }
}

// ---------- 放置 ----------

export class PlaceAction extends AsyncAction {
  constructor (bot: BotAgent, private x: number, private y: number, private z: number, private face: number, private opts: { hotbar?: number, item?: string } = {}) { super(bot, 'place') }

  protected async run () {
    const { x, y, z, bot } = this
    const b = bot.world.getBlock(x, y, z)
    if (b && !AIRISH.has(b.name) && !isSoft(b.name) && b.name !== 'water') throw new Error(`(${x},${y},${z}) 已有方块 ${b.name}`)
    const dist = reachTo(bot, x, y, z)
    if (dist > 4.6) throw new Error(`距离 ${dist.toFixed(1)} 超出触及范围`)
    if (this.opts.item) await holdItem(this, bot, this.opts.item)
    else if (this.opts.hotbar !== undefined) await holdSlot(this, bot, 36 + this.opts.hotbar)
    const held = bot.inventory.held()
    if (!held) throw new Error('手里没有东西可放')
    faceTowards(bot, x + 0.5, y + 0.5, z + 0.5)
    await this.sleep(60)
    placeBlockAt(bot, x, y, z, this.face)
    await this.until(() => { const n = bot.world.getBlock(x, y, z); return !!n && !AIRISH.has(n.name) && n.name !== 'water' }, 1500, `${held.name} 放置生效`)
    return `已在 (${x},${y},${z}) 放置 ${bot.world.getBlock(x, y, z)!.name}`
  }
}

// ---------- 攻击 ----------

export class AttackAction extends AsyncAction {
  constructor (bot: BotAgent, private entityId: number, private maxHits = 3) { super(bot, 'attack') }

  protected async run () {
    const bot = this.bot
    const weapons = bot.inventory.find(s => weaponScore(s.name) > 0).sort((a, b) => weaponScore(b.item.name) - weaponScore(a.item.name))
    if (weapons.length) await holdSlot(this, bot, weapons[0].slot)
    let hits = 0
    while (hits < this.maxHits) {
      const e = bot.world.entities.get(this.entityId)
      if (!e) return hits ? `攻击 ${hits} 次后目标消失 (可能已死亡)` : `实体 ${this.entityId} 不存在`
      const dist = Math.hypot(e.x - bot.pos.x, e.y + 0.9 - (bot.pos.y + 1.62), e.z - bot.pos.z)
      if (dist > 3.6) { if (!hits) throw new Error(`距离 ${dist.toFixed(1)} 太远 (需 ≤3.5)`); return `攻击 ${hits} 次后目标离开触及范围` }
      faceTowards(bot, e.x, e.y + 0.9, e.z)
      bot.reflex.lowerShield() // 举着盾不能攻击
      bot.client.write('attack', { entityId: this.entityId }) // 26.3: 攻击是独立的 attack 包
      bot.client.write('arm_animation', { hand: 'main_hand' })
      hits++
      await this.sleep(650) // 剑的攻击冷却 ~0.625s
    }
    return `攻击 ${hits} 次${weapons.length ? ` (用 ${weapons[0].item.name})` : ''}`
  }
}

// ---------- 库存 / 容器 ----------

export class SelectSlotAction extends Action {
  constructor (private bot: BotAgent, private slot: number) { super('select_slot') }
  start () {
    if (this.slot < 0 || this.slot > 8) return this.fail('slot 须为 0-8 (快捷栏)')
    this.bot.selectSlot(this.slot) // held_item_slot 取快捷栏下标 0-8 (不是窗口槽位 36-44)
    this.finish(`已选中快捷栏 ${this.slot}`)
  }
  step () {}
}

export class OpenContainerAction extends AsyncAction {
  constructor (bot: BotAgent, private x: number, private y: number, private z: number) { super(bot, 'open_container') }
  protected async run () {
    const { bot, x, y, z } = this
    const dist = reachTo(bot, x, y, z)
    if (dist > 4.6) throw new Error(`距离 ${dist.toFixed(1)} 超出触及范围`)
    closeContainer(bot)
    await holdNothing(this, bot) // 防止把手里的方块放上去
    faceTowards(bot, x + 0.5, y + 0.5, z + 0.5)
    await this.sleep(60)
    bot.interactBlock(x, y, z)
    await this.until(() => bot.inventory.activeWindowId !== null, 3000, '容器打开')
    const w = bot.inventory.windows.get(bot.inventory.activeWindowId!)
    await this.until(() => (w?.slots.length ?? 0) > 0, 1500, '容器内容')
    return `容器已打开 (窗口${bot.inventory.activeWindowId}, ${w?.slots.length ?? 0} 槽)`
  }
}

export class ChestOpAction extends Action {
  /** mode: take(从活动窗口拿) | put(放入活动窗口) */
  private phase: string
  constructor (private bot: BotAgent, initial: 'take' | 'put' | 'deposit', private slot: number) {
    super(`chest_${initial}`)
    this.phase = initial
  }
  private clickedAt = 0
  start () {
    const wid = this.bot.inventory.activeWindowId
    if (wid === null) return this.fail('没有打开的容器')
  }
  step (nowMs: number) {
    if (this.clickedAt && nowMs - this.clickedAt < 600) return
    const wid = this.bot.inventory.activeWindowId
    if (wid === null) return this.fail('容器已被关闭')
    const w = this.bot.inventory.windows.get(wid)
    const size = (w?.slots.length ?? 63) - 36 // 容器自身格数 (单箱 27, 大箱 54)
    // 窗口布局: 0..size-1 容器, size..size+26 背包, size+27..size+35 快捷栏
    if (this.phase === 'take') {
      if (this.slot < 0 || this.slot >= size) return this.fail(`take 槽位须为 0-${size - 1} (容器区), 收到 ${this.slot}`)
      if (!w?.slots[this.slot]) return this.fail(`容器槽位 ${this.slot} 是空的`)
      this.bot.clickSlot(wid, this.slot, 0, 1) // shift 点击: 直接进背包
      this.clickedAt = nowMs
      this.phase = 'done'
      return
    }
    if (this.phase === 'put') {
      // slot = 玩家背包槽(9-44) → 窗口坐标 size + (slot - 9)
      if (this.slot < 9 || this.slot > 44) return this.fail('put 槽位须为 9-44 (玩家物品)')
      if (!this.bot.inventory.slots[this.slot]) return this.fail(`背包槽位 ${this.slot} 是空的`)
      this.bot.clickSlot(wid, size + this.slot - 9, 0, 1) // shift 点击: 直接进容器
      this.clickedAt = nowMs
      this.phase = 'done'
      return
    }
    if (this.phase === 'done') return this.finish('操作完成')
  }
}

export class DropItemAction extends Action {
  constructor (private bot: BotAgent, private slot: number, private all: boolean) { super('drop_item') }
  start () {
    if (!this.bot.inventory.slots[this.slot]) return this.fail(`槽位 ${this.slot} 为空`)
    closeContainer(this.bot)
    this.bot.clickSlot(0, this.slot, this.all ? 1 : 0, 4) // mode 4 = drop
    this.finish(`已丢弃槽位 ${this.slot}${this.all ? ' 整组' : ' 单个'}`)
  }
  step () {}
}

export class CloseWindowAction extends Action {
  constructor (private bot: BotAgent) { super('close_window') }
  start () {
    const wid = this.bot.inventory.activeWindowId
    if (wid === null) return this.finish('本就没有打开的窗口')
    this.bot.closeWindow(wid)
    this.finish(`已关闭窗口 ${wid}`)
  }
  step () {}
}

// ---------- 简单动作 ----------

export class JumpAction extends Action {
  constructor (private bot: BotAgent) { super('jump') }
  start () { this.bot.physics.control.jump = true }
  step () { this.bot.physics.control.jump = false; this.finish('跳') }
}

export class StopAction extends Action {
  constructor (private bot: BotAgent) { super('stop') }
  start () {
    const c = this.bot.physics.control
    c.forward = c.back = c.left = c.right = c.jump = c.sprint = c.sneak = false
    this.bot.cancelActions('被 stop 停止')
    this.finish('已停止所有动作')
  }
  step () {}
}
