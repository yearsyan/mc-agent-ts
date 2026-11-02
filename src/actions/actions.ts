/**
 * 异步动作系统: act() -> actionId; 每 tick 由 BotAgent 驱动 step()。
 * 动作通过 BotAgent 的接口操作游戏 (写包 / 设 control)。
 */
import type { BotAgent } from '../conn/bot.js'
import { findPath, type PathNode } from './astar.js'
import { createRequire } from 'node:module'

const require2 = createRequire(import.meta.url)
const mcData: any = require2('minecraft-data')('26.3')

export type ActionStatus = 'running' | 'done' | 'failed' | 'cancelled'

export abstract class Action {
  id: number
  status: ActionStatus = 'running' as ActionStatus
  detail = ''
  private static nextId = 1
  constructor (readonly type: string) { this.id = Action.nextId++ }
  abstract start (): void
  abstract step (nowMs: number): void
  cancel () { if (this.status === 'running') this.status = 'cancelled' }
  finish (detail = '') { this.status = 'done'; this.detail = detail }
  fail (detail = '') { this.status = 'failed'; this.detail = detail }
}

// ---------- 移动 ----------

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
  /** 挖掘子状态: 当前正在挖的格 */
  private digY: number | null = null
  private digSentAt = 0
  private readonly timeoutMs: number

  constructor (private bot: BotAgent, private target: { x: number, y?: number, z: number }, timeoutMs = 150_000) {
    super('move_to')
    this.timeoutMs = timeoutMs
  }

  private plan (): boolean {
    const from = { x: Math.floor(this.bot.pos.x), y: Math.floor(this.bot.pos.y), z: Math.floor(this.bot.pos.z) }
    let to = { x: Math.floor(this.target.x), y: Math.floor(this.target.y ?? this.bot.pos.y), z: Math.floor(this.target.z) }
    // 目标列自适应: 指定高度不可站时扫 ±8
    const w = this.bot.world
    const standableAt = (x: number, y: number, z: number) => {
      const feet = w.getBlock(x, y, z)
      const head = w.getBlock(x, y + 1, z)
      const below = w.getBlock(x, y - 1, z)
      if (!feet || !head || !below) return false
      const ok = (n: string) => ['air', 'cave_air', 'void_air', 'snow', 'short_grass', 'tall_grass', 'fern'].includes(n)
      return ok(feet.name) && ok(head.name) && !['air', 'cave_air', 'void_air', 'water', 'lava'].includes(below.name)
    }
    if (!standableAt(to.x, to.y, to.z)) {
      let fixed: typeof to | null = null
      for (let dy = 0; dy <= 8 && !fixed; dy++) {
        if (standableAt(to.x, to.y + dy, to.z)) fixed = { ...to, y: to.y + dy }
        else if (dy > 0 && standableAt(to.x, to.y - dy, to.z)) fixed = { ...to, y: to.y - dy }
      }
      if (fixed) to = fixed
    }
    this.path = findPath(this.bot.world, from, to, { allowDeepWater: false })
    if (!this.path || this.path.length === 0) {
      this.fail(`无可行路径 ${from.x},${from.y},${from.z} -> ${to.x},${to.y},${to.z} (目标不可站或中途断崖/深水/未加载)`)
      return false
    }
    this.wpIdx = Math.min(1, this.path.length - 1)
    return true
  }

  start () {
    this.lastProgressAt = this.lastWpProgressAt = Date.now()
    this.plan()
  }

  step (nowMs: number) {
    if (!this.path) return
    if (nowMs - this.lastProgressAt > 18000) { this.stopMoving(); return this.fail('超时: 18 秒无进展') }

    const wp = this.path[this.wpIdx]
    const dx = wp.x + 0.5 - this.bot.pos.x
    const dz = wp.z + 0.5 - this.bot.pos.z
    const distWp = Math.hypot(dx, dz)

    // ---- 挖穿航点处理 ----
    if (wp.dig && this.digY === null) {
      const cells = wp.dig === 'up' ? [wp.y, wp.y + 1, wp.y + 2] : [wp.y, wp.y + 1]
      let next = -999
      for (const y of cells) {
        const b = this.bot.world.getBlock(wp.x, y, wp.z)
        if (b && b.name !== 'air' && !isSoft(b.name)) { next = y; break }
      }
      if (next > -900) { this.digY = next; this.digSentAt = 0 }
      else { this.wpIdx++; this.lastWpProgressAt = nowMs; return } // 已挖好
    }
    if (this.digY !== null) {
      const b = this.bot.world.getBlock(wp.x, this.digY, wp.z)
      if (!b || b.name === 'air' || isSoft(b.name)) {
        this.digY = null              // 这格挖完了, 下个 step 处理下一格
        this.digSentAt = 0
        this.lastProgressAt = nowMs
        return
      }
      // 每格只发一次 START (重发会重置服务器进度); 服务器 tick 自动完成, 本地轮询模型
      if (!this.digSentAt) {
        this.digSentAt = nowMs
        this.bot.yaw = Math.atan2(-(wp.x + 0.5 - this.bot.pos.x), wp.z + 0.5 - this.bot.pos.z) * 180 / Math.PI
        this.bot.client.write('block_dig', { status: 0, location: { x: wp.x, y: this.digY, z: wp.z }, face: this.digFace(wp), sequence: 1 })
        this.bot.client.write('arm_animation', { hand: 'main_hand' })
        // 兜底 STOP + 乐观更新 (服务器一般会自己完成)
        setTimeout(() => {
          try {
            this.bot.client.write('block_dig', { status: 3, location: { x: wp.x, y: this.digY ?? 0, z: wp.z }, face: 1, sequence: 2 })
            this.bot.world.setBlock({ location: { x: wp.x, y: this.digY ?? 0, z: wp.z }, type: 0 })
          } catch {}
        }, 4200)
      }
      if (process.env.MC_WIRE_DEBUG && nowMs - ((this as any)._digAt ?? 0) > 2000) {
        (this as any)._digAt = nowMs
        console.log(`[move-dig ${this.bot.name}] 挖 (${wp.x},${this.digY},${wp.z}) 当前=${b?.name} 已等 ${((nowMs - this.digSentAt) / 1000).toFixed(1)}s wp.dig=${wp.dig}`)
      }
      // 6 秒还没清掉: 重试一次
      if (nowMs - this.digSentAt > 6000) { this.digSentAt = 0 }
      if (nowMs - this.digSentAt > 200 && (nowMs - ((this as any)._swAt ?? 0) > 500)) {
        (this as any)._swAt = nowMs
        this.bot.client.write('arm_animation', { hand: 'main_hand' })
      }
      return // 挖掘中不走
    }

    // ---- 到达判定 ----
    const finalWp = this.wpIdx >= this.path.length - 1
    if (finalWp && distWp < 2.0) {
      this.stopMoving()
      return this.finish(`到达 ${wp.x},${wp.y},${wp.z}`)
    }
    if (distWp < 1.6) {  // 中途航点宽松判定: 物理抖动/雪层会阻止精确到点, 1.6 格足够接力下一航点
      if (finalWp) { this.stopMoving(); return this.finish(`到达 ${wp.x},${wp.y},${wp.z}`) }
      this.wpIdx++
      this.lastWpProgressAt = nowMs
      return
    }
    // 航点跳跃: 下一航点已比当前近则跳过
    if (!finalWp) {
      const nxt = this.path[this.wpIdx + 1]
      const dNext = Math.hypot(nxt.x + 0.5 - this.bot.pos.x, nxt.z + 0.5 - this.bot.pos.z)
      if (dNext < distWp - 0.3) { this.wpIdx++; this.lastWpProgressAt = nowMs; return }
    }

    // ---- 总体进展 ----
    const distFinal = Math.hypot(this.target.x - this.bot.pos.x, this.target.z - this.bot.pos.z)
    if (distFinal < this.lastDist - 0.4) { this.lastDist = distFinal; this.lastProgressAt = nowMs }

    if (process.env.MC_WIRE_DEBUG && nowMs - ((this as any)._dbgAt ?? 0) > 2000) {
      (this as any)._dbgAt = nowMs
      console.log(`[move-dbg ${this.bot.name}] wp${this.wpIdx}/${this.path.length - 1} (${wp.x},${wp.y},${wp.z}) dig=${wp.dig ?? '-'} distWp=${distWp.toFixed(1)} pos=(${this.bot.pos.x.toFixed(1)},${this.bot.pos.y.toFixed(1)},${this.bot.pos.z.toFixed(1)}) onGround=${this.bot.onGround} yaw=${Math.round(this.bot.yaw)}`)
    }

    // ---- 朝向 ----
    const targetYaw = Math.atan2(-dx, dz) * 180 / Math.PI
    this.bot.yaw = lerpAngle(this.bot.yaw, targetYaw, 0.35)

    // ---- 控制量 ----
    const c = this.bot.physics.control
    c.forward = true
    c.back = false
    c.sprint = !finalWp && distWp > 6
    const wpAbove = wp.y > Math.floor(this.bot.pos.y)
    c.jump = wpAbove && this.bot.onGround
    if (!c.jump) c.jump = this.stuckAgainstWall() && this.bot.onGround && nowMs - this.lastJumpAt > 700
    if (c.jump) this.lastJumpAt = nowMs

    // ---- 卡住恢复: 侧移 ----
    if (nowMs - this.lastWpProgressAt > 2200 && nowMs - this.lastJumpAt > 900 && this.bot.onGround) {
      if (this.strafeUntil < nowMs) { this.strafeUntil = nowMs + 700; this.strafeDir *= -1 }
    }
    const strafing = nowMs < this.strafeUntil
    c.left = strafing && this.strafeDir > 0
    c.right = strafing && this.strafeDir < 0

    // ---- 重规划 ----
    if (nowMs - this.lastWpProgressAt > 5000) {
      if (++this.replans > 4) { this.stopMoving(); return this.fail(`重规划 4 次仍卡在 (${wp.x},${wp.y},${wp.z})`) }
      if (!this.plan()) return
      this.lastWpProgressAt = nowMs
      this.digY = null
    }
  }

  private digFace (wp: PathNode): number {
    const dx = wp.x + 0.5 - this.bot.pos.x
    const dz = wp.z + 0.5 - this.bot.pos.z
    return Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 5 : 4) : (dz > 0 ? 3 : 2)
  }

  private stuckAgainstWall (): boolean {
    const yawRad = this.bot.yaw * Math.PI / 180
    const fx = Math.floor(this.bot.pos.x - Math.sin(yawRad))
    const fz = Math.floor(this.bot.pos.z + Math.cos(yawRad))
    const fy = Math.floor(this.bot.pos.y)
    return this.bot.world.isSolid(fx, fy, fz) || this.bot.world.isSolid(fx, fy + 1, fz)
  }

  private stopMoving () {
    const c = this.bot.physics.control
    c.forward = c.back = c.left = c.right = c.jump = c.sprint = false
  }

  cancel () {
    super.cancel()
    this.stopMoving()
  }
}

function isSoft (name: string) {
  return ['snow', 'short_grass', 'tall_grass', 'fern', 'torch'].includes(name)
}

// ---------- 挖掘 ----------

export class DigAction extends Action {
  private startedAt = 0
  private digTimeMs = 0
  private lastSwing = 0
  private seq = 0
  private faceUsed = 1

  /** 选择一个暴露的面: 优先朝向 agent 的侧面, 否则顶面 */
  private pickFace (): number {
    const dx = this.x + 0.5 - this.bot.pos.x
    const dz = this.z + 0.5 - this.bot.pos.z
    const air = (x: number, y: number, z: number) => {
      const b = this.bot.world.getBlock(x, y, z)
      return !b || b.name === 'air' || b.name === 'snow' || b.name === 'short_grass'
    }
    // 侧面: face 4=-x 5=+x 2=-z 3=+z (法线朝 agent)
    if (Math.abs(dx) > Math.abs(dz)) {
      const f = dx > 0 ? 5 : 4
      const nx = this.x + (dx > 0 ? 1 : -1)
      if (air(nx, this.y, this.z)) { this.faceUsed = f; return f }
    } else {
      const f = dz > 0 ? 3 : 2
      const nz = this.z + (dz > 0 ? 1 : -1)
      if (air(this.x, this.y, nz)) { this.faceUsed = f; return f }
    }
    if (air(this.x + (dx > 0 ? 1 : -1), this.y, this.z)) { this.faceUsed = dx > 0 ? 5 : 4; return this.faceUsed }
    if (air(this.x, this.y, this.z + (dz > 0 ? 1 : -1))) { this.faceUsed = dz > 0 ? 3 : 2; return this.faceUsed }
    this.faceUsed = 1
    return 1 // 顶面兜底
  }

  constructor (private bot: BotAgent, private x: number, private y: number, private z: number) { super('dig') }

  private origName = ''

  start () {
    const b = this.bot.world.getBlock(this.x, this.y, this.z)
    if (!b || b.name === 'air') return this.fail(`(${this.x},${this.y},${this.z}) 没有可挖方块`)
    this.origName = b.name
    const dist = Math.hypot(this.x + 0.5 - this.bot.pos.x, this.y + 0.5 - (this.bot.pos.y + 1.6), this.z + 0.5 - this.bot.pos.z)
    if (dist > 4.6) return this.fail(`距离 ${dist.toFixed(1)} 超出触及范围 4.5`)
    // 面向方块
    const dx = this.x + 0.5 - this.bot.pos.x
    const dy = this.y + 0.5 - (this.bot.pos.y + 1.62)
    const dz = this.z + 0.5 - this.bot.pos.z
    this.bot.yaw = Math.atan2(-dx, dz) * 180 / Math.PI
    this.bot.pitch = Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI
    // 挖掘时间估算 (无工具简化公式, 稍微高估)
    const info = mcData.blocksByName[b.name]
    const hardness = info?.hardness ?? 1
    const timeSec = hardness <= 0 ? 0.05 : (hardness * 1.5 + 0.1)
    this.digTimeMs = Math.min(60_000, timeSec * 1000)
    this.startedAt = Date.now()
    const face = this.pickFace(); this.faceUsed = face
    this.bot.client.write('block_dig', { status: 0, location: { x: this.x, y: this.y, z: this.z }, face, sequence: ++this.seq }) // 0=start
  }

  step (nowMs: number) {
    if (nowMs - this.lastSwing > 400) {
      this.lastSwing = nowMs
      this.bot.client.write('arm_animation', { hand: 'main_hand' })
      // 注意: 不要重发 START —— 会重置服务器端进度; 服务器 tick 会在最后一次 START 后自动完成破坏
    }
    if (this.digTimeMs > 0 && nowMs - this.startedAt >= this.digTimeMs) {
      this.bot.client.write('block_dig', { status: 3, location: { x: this.x, y: this.y, z: this.z }, face: this.faceUsed, sequence: ++this.seq }) // 26.3: 3=STOP_DESTROY (2 是 ABORT)
      // 服务器确认后会有 block_change; 乐观等待一小段时间
      // 轮询确认方块变化 (multi_block_change 批量更新可能迟到数秒)
      const t0 = Date.now()
      const check = () => {
        const b = this.bot.world.getBlock(this.x, this.y, this.z)
        if (!b || b.name !== this.origName) {
          this.finish(`已挖掉 ${this.origName} (${this.x},${this.y},${this.z})${b ? ' 现为 ' + b.name : ''}`)
        } else if (Date.now() - t0 < 4500) {
          setTimeout(check, 150)
        } else {
          this.fail(`方块未变化 (可能工具不足或距离/面不可达)`)
        }
      }
      setTimeout(check, 400)
      this.digTimeMs = 0
    }
  }
}

// ---------- 放置 ----------

export class PlaceAction extends Action {
  constructor (private bot: BotAgent, private x: number, private y: number, private z: number, private face: number, private hotbarSlot = 0) { super('place') }
  private seq = 1
  private fired = false

  start () {
    const b = this.bot.world.getBlock(this.x, this.y, this.z)
    if (b && b.name !== 'air' && b.name !== 'snow' && b.name !== 'short_grass') return this.fail(`(${this.x},${this.y},${this.z}) 已有方块 ${b.name}`)
    const dist = Math.hypot(this.x + 0.5 - this.bot.pos.x, this.y + 0.5 - (this.bot.pos.y + 1.6), this.z + 0.5 - this.bot.pos.z)
    if (dist > 4.6) return this.fail(`距离 ${dist.toFixed(1)} 超出触及范围`)
    this.bot.client.write('held_item_slot', { slotId: this.hotbarSlot })
    this.bot.client.write('block_place', {
      hand: 'main_hand',
      location: { x: this.x, y: this.y, z: this.z },
      direction: this.face,
      cursorX: 0.5, cursorY: 0.5, cursorZ: 0.5,
      insideBlock: false,
      sequence: this.seq,
    })
    this.bot.client.write('arm_animation', { hand: 'main_hand' })
    this.fired = true
  }

  step () {
    if (this.fired) {
      setTimeout(() => {
        const b = this.bot.world.getBlock(this.x, this.y, this.z)
        if (b && b.name !== 'air') this.finish(`已在 (${this.x},${this.y},${this.z}) 放置 ${b.name}`)
        else this.fail('放置未生效 (手中可能没有方块)')
      }, 500)
      this.fired = false
    }
  }
}

// ---------- 攻击 ----------

export class AttackAction extends Action {
  constructor (private bot: BotAgent, private entityId: number, private maxHits = 3) { super('attack') }
  private hits = 0
  private nextHitAt = 0

  start () { this.nextHitAt = Date.now() + 150 }

  step (nowMs: number) {
    if (nowMs < this.nextHitAt) return
    const e = this.bot.world.entities.get(this.entityId)
    if (!e) return this.fail(`实体 ${this.entityId} 不存在`)
    const dx = e.x - this.bot.pos.x
    const dy = (e.y + 1) - (this.bot.pos.y + 1.62)
    const dz = e.z - this.bot.pos.z
    const dist = Math.hypot(dx, dy, dz)
    if (dist > 3.6) return this.fail(`距离 ${dist.toFixed(1)} 太远`)
    this.bot.yaw = Math.atan2(-dx, dz) * 180 / Math.PI
    this.bot.pitch = Math.max(-60, Math.min(60, Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI))
    // 26.3: 攻击是独立的 attack 包 (仅 entityId)
    this.bot.client.write('attack', { entityId: this.entityId })
    this.bot.client.write('arm_animation', { hand: 'main_hand' })
    this.hits++
    this.nextHitAt = nowMs + 650
    if (this.hits >= this.maxHits) this.finish(`攻击 ${this.maxHits} 次`)
  }
}


// ---------- 库存 / 容器 ----------

export class SelectSlotAction extends Action {
  constructor (private bot: BotAgent, private slot: number) { super('select_slot') }
  start () {
    if (this.slot < 0 || this.slot > 8) return this.fail('slot 须为 0-8 (快捷栏)')
    this.bot.selectSlot(this.slot + 36) // 协议槽位 36-44 对应快捷栏 0-8
    this.finish(`已选中快捷栏 ${this.slot}`)
  }
  step () {}
}

export class OpenContainerAction extends Action {
  private startMs = 0
  constructor (private bot: BotAgent, private x: number, private y: number, private z: number) { super('open_container') }
  start () {
    const dist = Math.hypot(this.x + 0.5 - this.bot.pos.x, this.y + 0.5 - (this.bot.pos.y + 1.6), this.z + 0.5 - this.bot.pos.z)
    if (dist > 4.6) return this.fail(`距离 ${dist.toFixed(1)} 超出触及范围`)
    // 选一个空快捷栏位防止把方块放上去
    const hotbar = this.bot.inventory.hotbar()
    let empty = -1
    hotbar.forEach((s, i) => { if (!s && empty < 0) empty = i })
    if (empty >= 0) this.bot.selectSlot(empty + 36)
    this.bot.interactBlock(this.x, this.y, this.z)
    this.startMs = Date.now()
  }
  step (nowMs: number) {
    if (this.bot.inventory.activeWindowId !== null) {
      const w = this.bot.inventory.windows.get(this.bot.inventory.activeWindowId)
      return this.finish(`容器已打开 (窗口${this.bot.inventory.activeWindowId}, ${w?.slots.length ?? 0} 槽)`)
    }
    if (nowMs - this.startMs > 3000) return this.fail('容器 3 秒内未打开 (可能不是容器或距离问题)')
  }
}

export class ChestOpAction extends Action {
  /** mode: take(从活动窗口拿) | put(放入活动窗口) | inv(点玩家背包槽) */
  private phase: string
  constructor (private bot: BotAgent, initial: 'take' | 'put' | 'inv' | 'deposit', private slot: number) {
    super(`chest_${initial}`)
    this.phase = initial
  }
  private clickedAt = 0
  start () {
    const wid = this.bot.inventory.activeWindowId
    if (this.phase !== 'inv' && wid === null) return this.fail('没有打开的容器')
  }
  step (nowMs: number) {
    if (this.clickedAt && nowMs - this.clickedAt < 600) return
    const wid = this.bot.inventory.activeWindowId
    // 箱子窗口布局: 0-26 箱子, 27-53 背包, 54-62 快捷栏
    if (this.phase === 'take') {
      if (this.slot < 0 || this.slot > 26) return this.fail(`take 槽位须为 0-26 (箱子区), 收到 ${this.slot}`)
      this.bot.clickSlot(wid!, this.slot)
      this.clickedAt = nowMs
      // 第二步: 点一个空背包槽收下
      this.phase = 'deposit'
      return
    }
    if (this.phase === 'deposit') {
      // 找空背包槽(27-53)
      const w = this.bot.inventory.windows.get(wid!)
      let empty = -1
      for (let i = 27; i < 54; i++) if (!w?.slots[i]) { empty = i; break }
      if (empty < 0) return this.fail('背包已满')
      this.bot.clickSlot(wid!, empty)
      this.phase = 'done'
      return
    }
    if (this.phase === 'put') {
      // slot = 玩家背包槽(9-44); 先拿起来
      if (this.slot < 9 || this.slot > 44) return this.fail('put 槽位须为 9-44 (玩家物品)')
      const chestSlot = this.bot.inventory.windows.get(wid!)?.slots ?? []
      // 拿起物品 (窗口坐标: 背包9-35→27-53, 快捷栏36-44→54-62)
      const wSlot = this.slot <= 35 ? this.slot + 18 : this.slot + 18
      this.bot.clickSlot(wid!, wSlot)
      this.clickedAt = nowMs
      this.phase = 'put2'
      return
    }
    if (this.phase === 'put2') {
      // 放进箱子第一个空槽(或已有同类堆)
      const w = this.bot.inventory.windows.get(wid!)
      let dst = -1
      for (let i = 0; i < 27; i++) { if (!w?.slots[i]) { dst = i; break } }
      if (dst < 0) return this.fail('箱子已满')
      this.bot.clickSlot(wid!, dst)
      this.phase = 'done'
      return
    }
    if (this.phase === 'done') return this.finish('操作完成')
  }
}

export class CraftPlanksAction extends Action {
  /** 2x2: 原木 -> 4 木板 */
  private phase = 0
  private lastAt = 0
  constructor (private bot: BotAgent) { super('craft_planks') }
  start () {
    const log = this.bot.inventory.findItem('oak_log') ?? this.bot.inventory.findItem('spruce_log') ?? this.bot.inventory.findItem('birch_log') ?? this.bot.inventory.findItem('dark_oak_log') ?? this.bot.inventory.findItem('jungle_log') ?? this.bot.inventory.findItem('acacia_log')
    if (!log) return this.fail('背包里没有原木')
    // 拿起原木
    const wSlot = log.slot <= 35 ? log.slot : log.slot // 窗口0 槽位即玩家槽位
    this.bot.clickSlot(0, wSlot)
    this.phase = 1
    this.lastAt = Date.now()
  }
  step (nowMs: number) {
    if (nowMs - this.lastAt < 400) return
    this.lastAt = nowMs
    if (this.phase === 1) { this.bot.clickSlot(0, 1); this.phase = 2; return }        // 放入合成格 slot1
    if (this.phase === 2) { this.bot.clickSlot(0, 0); this.phase = 3; return }        // 取产物
    if (this.phase === 3) {
      // 放回背包: 点背包一个空位
      let empty = -1
      for (let i = 9; i < 36; i++) if (!this.bot.inventory.slots[i]) { empty = i; break }
      if (empty < 0) return this.fail('背包满')
      this.bot.clickSlot(0, empty)
      this.phase = 4
      return
    }
    if (this.phase === 4) {
      const planks = this.bot.inventory.list().find(s => s.name.includes('planks'))
      if (planks) return this.finish(`合成完成: ${planks.count}x ${planks.name}`)
      return this.fail('合成后未检测到木板')
    }
  }
}

export class DropItemAction extends Action {
  constructor (private bot: BotAgent, private slot: number, private all: boolean) { super('drop_item') }
  start () {
    if (!this.bot.inventory.slots[this.slot]) return this.fail(`槽位 ${this.slot} 为空`)
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
    c.forward = c.back = c.left = c.right = c.jump = c.sprint = false
    this.bot.cancelActions()
    this.finish('已停止所有动作')
  }
  step () {}
}

function lerpAngle (a: number, b: number, t: number) {
  let d = ((b - a + 540) % 360) - 180
  return a + d * t
}
