/**
 * 远程战斗: shoot = 自动瞄准射箭 (弹道解算 + 移动预判 + 视线/误伤检查 + 松弓时朝向精确同步)。
 */
import type { BotAgent } from '../conn/bot.js'
import { Task } from './tasks.js'
import { AttackAction } from './actions.js'
import { holdSlot } from './hands.js'
import { aimAt, traceArrow, type Aim } from '../game/ballistics.js'
import { entityVelocity } from '../world/world.js'
import { standableCell } from './astar.js'
import { ARROW_ITEMS, FLYING, entitySize } from '../game/knowledge.js'

/** 满弓需要 20 tick; 多留 2 tick 余量 (服务器按它自己的 tick 计时) */
const FULL_DRAW_MS = 1150

export function arrowCount (bot: BotAgent) {
  return ARROW_ITEMS.reduce((n, a) => n + bot.inventory.count(a), 0)
}

export function bowSlot (bot: BotAgent) {
  return bot.inventory.find(s => s.name === 'bow')[0]?.slot ?? null
}

export function canShoot (bot: BotAgent) {
  return bowSlot(bot) !== null && arrowCount(bot) > 0
}

/** 射箭起点 = 眼睛下方 0.1 格 */
export function launchPoint (bot: BotAgent) {
  return { x: bot.pos.x, y: bot.pos.y + 1.62 - 0.1, z: bot.pos.z }
}

/** 对实体求瞄准解并检查弹道; ok=false 时给出原因 */
export function solveShot (bot: BotAgent, entityId: number): ({ ok: true } & Aim) | { ok: false, reason: string } {
  const e = bot.world.entities.get(entityId)
  if (!e) return { ok: false, reason: '目标不存在' }
  const { h } = entitySize(e.type)
  const from = launchPoint(bot)
  const aim = aimAt(from, { x: e.x, y: e.y + h * 0.5, z: e.z }, entityVelocity(e), FLYING.has(e.type))
  if (!aim) return { ok: false, reason: '超出射程' }
  const tr = traceArrow(bot.world, from, aim, bot.world.entities.values(), entityId)
  if (!tr.clear) return { ok: false, reason: tr.reason }
  return { ok: true, ...aim }
}

export interface ShootOptions {
  /** 目标贴近 (<3.2 格) 时改用近战 (默认 true) */
  melee?: boolean
  /** 打完捡回插在地上的箭 (默认 true) */
  pickup?: boolean
}

export class ShootAction extends Task {
  private owner: string
  private drawing = false
  shots = 0
  hits = 0

  constructor (bot: BotAgent, private entityId: number, private maxShots = 5, private opts: ShootOptions = {}) {
    super(bot, 'shoot')
    this.owner = `shoot#${this.id}`
  }

  protected cleanup () {
    if (this.drawing) { this.abortDraw(); this.drawing = false }
    this.bot.releaseHand(this.owner)
  }

  /** 不放箭地取消拉弓: 切一下快捷栏 (服务器在换手持时停止使用物品) */
  private abortDraw () {
    const bot = this.bot
    const cur = bot.inventory.heldSlot
    bot.selectSlot((cur + 1) % 9)
    bot.selectSlot(cur)
    bot.usingHand = null
  }

  protected async run () {
    const bot = this.bot
    if (bowSlot(bot) === null) throw new Error('背包里没有弓')
    if (!arrowCount(bot)) throw new Error('没有箭')
    if (!bot.world.entities.has(this.entityId)) throw new Error(`实体 ${this.entityId} 不存在`)
    const type = bot.world.entities.get(this.entityId)!.type
    await this.until(() => bot.tryLockHand(this.owner), 5000, '手空闲')

    let melee = 0, dead = false, stopReason = ''
    while (this.shots < this.maxShots) {
      const e = bot.world.entities.get(this.entityId)
      if (!e) { dead = true; break }
      const d = Math.hypot(e.x - bot.pos.x, e.y - bot.pos.y, e.z - bot.pos.z)
      if (d < 3.2 && this.opts.melee !== false) {
        // 贴脸了: 拉弓来不及, 换近战砍一下再说
        bot.releaseHand(this.owner)
        const a = await this.sub(new AttackAction(bot, this.entityId, 1))
        if (a.status === 'done') melee++
        await this.until(() => bot.tryLockHand(this.owner), 5000, '手空闲')
        continue
      }
      if (!arrowCount(bot)) { stopReason = '箭用完了'; break }
      const bow = bowSlot(bot)
      if (bow === null) { stopReason = '弓没了 (耐久耗尽?)'; break }
      if (bot.inventory.slots[36 + bot.inventory.heldSlot]?.name !== 'bow') await holdSlot(this, bot, bow)

      // 等出现射击窗口 (视线畅通、射程内)
      let shot = solveShot(bot, this.entityId)
      const t0 = Date.now()
      while (!shot.ok && Date.now() - t0 < 4000 && bot.world.entities.has(this.entityId)) { await this.sleep(150); shot = solveShot(bot, this.entityId) }
      if (!shot.ok) {
        if (!bot.world.entities.has(this.entityId)) { dead = true; break }
        if (!this.shots && !melee) throw new Error(`无法射击 ${type}: ${shot.reason}`)
        stopReason = shot.reason; break
      }

      // 拉弓: 期间持续跟踪瞄准
      bot.look(shot.yaw, shot.pitch)
      bot.reflex.lowerShield()
      bot.usingHand = 'main_hand'
      this.drawing = true
      bot.useItem()
      const drawAt = Date.now()
      while (Date.now() - drawAt < FULL_DRAW_MS) {
        await this.sleep(50)
        const s = solveShot(bot, this.entityId)
        if (s.ok) bot.look(s.yaw, s.pitch)
      }
      // 满弓后等一个可射的瞬间 (最多 2s), 等不到就收弓不放箭
      let fin = solveShot(bot, this.entityId)
      const t1 = Date.now()
      while (!fin.ok && Date.now() - t1 < 2000 && bot.world.entities.has(this.entityId)) { await this.sleep(50); fin = solveShot(bot, this.entityId) }
      if (!fin.ok) {
        this.abortDraw(); this.drawing = false
        if (!bot.world.entities.has(this.entityId)) { dead = true; break }
        stopReason = fin.reason; continue
      }
      // 松弓: 必须在发出最新朝向的同一 tick (服务器按松手时的朝向生成箭)
      bot.look(fin.yaw, fin.pitch)
      const relAt = Date.now()
      await bot.afterNextTick(() => bot.releaseUseItem())
      this.drawing = false
      this.shots++
      // 命中判定: 飞行时间 + 余量内目标受伤 (damage_event) 或消失
      const deadline = relAt + fin.ticks * 50 + 600
      while (Date.now() < deadline && !((bot.entityDamagedAt.get(this.entityId) ?? 0) > relAt) && bot.world.entities.has(this.entityId)) await this.sleep(50)
      if ((bot.entityDamagedAt.get(this.entityId) ?? 0) > relAt) this.hits++
      await this.sleep(100)
    }
    if (!dead && !bot.world.entities.has(this.entityId)) dead = true
    bot.releaseHand(this.owner)

    let picked = 0
    if (this.opts.pickup !== false && this.shots > 0) picked = await this.pickupArrows()
    return `射出 ${this.shots} 箭, 命中 ${this.hits}` + (melee ? `, 近战 ${melee} 次` : '') + (dead ? `, ${type} 已死亡/消失` : '') +
      (stopReason ? ` (停止: ${stopReason})` : '') + (picked ? `, 捡回 ${picked} 支箭` : '') + `, 剩余箭 ${arrowCount(bot)}`
  }

  /** 捡回自己射出、插在地上 (in_ground) 的箭, 20 格内, 最多 20 秒 */
  private async pickupArrows () {
    const bot = this.bot
    await this.sleep(1200) // 等箭落地
    const before = arrowCount(bot)
    const t0 = Date.now()
    const tried = new Set<number>()
    while (Date.now() - t0 < 20_000) {
      const a = [...bot.world.entities.values()]
        .filter(e => /^(arrow|spectral_arrow)$/.test(e.type) && e.ownerId === bot.entityId && e.meta.in_ground && !tried.has(e.id) && Math.hypot(e.x - bot.pos.x, e.z - bot.pos.z) < 20)
        .sort((x, y) => Math.hypot(x.x - bot.pos.x, x.z - bot.pos.z) - Math.hypot(y.x - bot.pos.x, y.z - bot.pos.z))[0]
      if (!a) break
      tried.add(a.id)
      // 拾取范围约 1.3 格, 必须走到箭所在格; 插在墙上/高处 (站不上去) 的不去捡, 免得垫方块
      const cell = { x: Math.floor(a.x), y: Math.floor(a.y + 0.1), z: Math.floor(a.z) }
      if (!standableCell(bot.world, cell.x, cell.y, cell.z)) continue
      const mv = await this.subMove({ x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }, { tolerance: 0, timeoutMs: 10_000 })
      if (mv.status !== 'done') continue
      const t1 = Date.now()
      while (bot.world.entities.has(a.id) && Date.now() - t1 < 1000) await this.sleep(100)
    }
    return Math.max(0, arrowCount(bot) - before)
  }
}
