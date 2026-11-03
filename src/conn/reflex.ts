/**
 * 反射层: 不等 LLM、每 tick 自主执行的保命行为 (LLM 一次决策要数秒, 僵尸几秒就能打死人)。
 * LLM 通过 set_policy 设定策略, 这里只负责执行; 每次介入都记一条 reflex 事件 (操作日志/scene 可见)。
 * 优先级: 危险地形逃生 > 战斗/逃跑 > 进食 > 夜间回家睡觉。
 */
import type { BotAgent } from './bot.js'
import type { Action } from '../actions/base.js'
import { AsyncAction } from '../actions/base.js'
import { MoveToAction } from '../actions/actions.js'
import { eatOnce, bestFood, SleepAction } from '../actions/tasks.js'
import { standableCell } from '../actions/astar.js'
import { isHostile, isRanged, weaponScore, isNight, isWatery } from '../game/knowledge.js'

export interface Policy {
  /** 自动进食 */
  autoEat: boolean
  /** 饱食度 ≤ 此值时进食 (血量不满时 ≤ 17 也吃, 用于回血) */
  eatAt: number
  /** defend = 还击 (血低于 fleeHealth 时逃跑); flee = 见怪就跑; ignore = 不管 */
  combat: 'defend' | 'flee' | 'ignore'
  fleeHealth: number
  /** 自动逃离岩浆/火/溺水 */
  avoidHazards: boolean
  /** 天黑且空闲时回家 (需设 home), 家附近有床就睡 */
  nightShelter: boolean
  home: { x: number, y: number, z: number } | null
  /** 死亡后自动复活 (关掉则停在死亡界面, 由 act{type:"respawn"} 手动复活) */
  autoRespawn: boolean
}

export const DEFAULT_POLICY: Policy = { autoEat: true, eatAt: 14, combat: 'defend', fleeHealth: 8, avoidHazards: true, nightShelter: false, home: null, autoRespawn: true }

export interface ReflexEvent { at: number, text: string }

/** 反射层内部用的异步动作 (吃东西) */
class ReflexEat extends AsyncAction {
  constructor (bot: BotAgent) { super(bot, 'eat'); this.byReflex = true }
  protected async run () { return eatOnce(this, this.bot) }
}

export class Reflex {
  policy: Policy = { ...DEFAULT_POLICY }
  events: ReflexEvent[] = []
  /** 当前在做什么 (scene 展示) */
  state: 'idle' | 'eating' | 'fighting' | 'fleeing' | 'escaping' | 'going_home' | 'sleeping' = 'idle'
  private task: Action | null = null
  private lastAttackAt = 0
  private lastEatTryAt = 0
  private lastFleeAt = 0
  private lastCheckAt = 0
  private shelteredNight = -1
  private eatFailCount = 0
  /** 正在逃离危险地形: 直接接管控制量跑向安全点 (岩浆里等不起寻路) */
  private escape: { x: number, y: number, z: number, until: number } | null = null

  constructor (private bot: BotAgent) {}

  private log (text: string) {
    this.events.push({ at: Date.now(), text })
    if (this.events.length > 30) this.events.shift()
    this.bot.emitReflex(text)
  }

  /** 让反射任务成为主动作 (打断 LLM 的动作并写明原因) */
  private takeOver (a: Action, why: string) {
    this.bot.startReflexAction(a, `被反射打断: ${why}`)
    this.task = a
  }

  private get busy () { return !!this.task && this.task.status === 'running' }

  /** 每 tick 调用 (动作 step 之后、物理之前, 可覆盖控制量) */
  tick (now: number) {
    const bot = this.bot
    if (bot.sleeping || bot.vehicleId !== null || bot.health <= 0) return
    const p = this.policy
    const head = bot.world.getBlock(Math.floor(bot.pos.x), Math.floor(bot.pos.y + 1.62), Math.floor(bot.pos.z))?.name
    const feet = bot.world.getBlock(Math.floor(bot.pos.x), Math.floor(bot.pos.y), Math.floor(bot.pos.z))?.name

    // 溺水: 头在水里且氧气见底 → 按住跳往上游 (每 tick 覆盖控制量)
    if (p.avoidHazards && isWatery(head) && bot.air < 150) bot.physics.control.jump = true
    // 空闲泡在水里: 踩水浮在水面 (否则会沉到水底)
    const prim = bot.activeAction
    if (isWatery(feet) && (!prim || prim.status !== 'running')) bot.physics.control.jump = true

    // 逃离危险地形进行中: 每 tick 朝安全点冲 (前进+疾跑+跳; 岩浆里跳有上浮)
    if (this.escape) {
      const c = bot.physics.control, e = this.escape
      const out = feet !== 'lava' && feet !== 'fire' && feet !== 'soul_fire' && bot.onGround
      if (out || now > e.until) {
        c.forward = c.sprint = c.jump = false
        this.log(out ? `已脱离危险地形 (血 ${bot.health.toFixed(0)})` : '逃离危险地形超时')
        this.escape = null
        this.state = 'idle'
      } else {
        bot.yaw = Math.atan2(-(e.x + 0.5 - bot.pos.x), e.z + 0.5 - bot.pos.z) * 180 / Math.PI
        bot.pitch = 0
        c.forward = c.sprint = c.jump = true
        c.back = c.left = c.right = c.sneak = false
        return
      }
    }

    if (now - this.lastCheckAt < 200) return // 其余判断每 4 tick 一次
    this.lastCheckAt = now
    if (!this.busy && this.state !== 'idle' && this.state !== 'fighting') this.state = 'idle'

    // 1) 危险地形: 站在岩浆/火里或着火 → 跑到最近的安全格
    if (p.avoidHazards && !this.escape && (feet === 'lava' || feet === 'fire' || feet === 'soul_fire')) {
      const spot = this.findSafeSpot()
      if (spot) {
        this.state = 'escaping'
        this.log(`脚下 ${feet}, 冲向 (${spot.x},${spot.y},${spot.z})`)
        const prim = bot.activeAction
        if (prim && prim.status === 'running') prim.cancel('被反射打断: 逃离危险地形')
        this.escape = { ...spot, until: now + 6000 }
        return
      }
    }

    // 2) 战斗 / 逃跑
    if (p.combat !== 'ignore' && this.state !== 'escaping') {
      const threats = this.threats()
      const creeper = threats.find(t => t.e.type === 'creeper' && t.d < 6)
      const lowHp = bot.health <= p.fleeHealth
      if (threats.length && (p.combat === 'flee' || creeper || (lowHp && threats.some(t => t.d < 8)))) {
        if (!(this.busy && this.state === 'fleeing') && now - this.lastFleeAt > 3000) {
          const from = creeper ?? threats[0]
          const spot = this.fleeSpot(from.e.x, from.e.z)
          if (spot) {
            this.lastFleeAt = now
            this.state = 'fleeing'
            this.log(`逃离 ${from.e.type}#${from.e.id} (距离 ${from.d.toFixed(1)}, 血 ${bot.health.toFixed(0)}) → (${spot.x},${spot.z})`)
            this.takeOver(new MoveToAction(bot, spot, { tolerance: 2, timeoutMs: 15_000 }), `逃离 ${from.e.type}`)
          }
        }
        return
      }
      if (p.combat === 'defend') {
        const target = threats.find(t => t.d <= 3.3)
        if (target) {
          // 在吃东西/挖掘时手被占用: 挖掘让路 (打断), 吃东西就等吃完
          if (this.state !== 'eating') {
            const prim = bot.activeAction
            if (prim && prim.status === 'running' && !prim.byReflex && !(prim instanceof MoveToAction)) prim.cancel(`被反射打断: 迎战 ${target.e.type}`)
            this.fight(target.e.id, now)
            return
          }
        }
      }
    }
    if (this.state === 'fighting' && now - this.lastAttackAt > 2000) this.state = 'idle'

    // 3) 进食
    if (p.autoEat && !this.busy && now - this.lastEatTryAt > 4000 && bot.food < 20) {
      const hungry = bot.food <= p.eatAt || (bot.health < 18 && bot.food <= 17)
      if (hungry && bot.handFree() && bestFood(bot, bot.food <= 6)) {
        this.lastEatTryAt = now
        const a = new ReflexEat(bot)
        a.onSettle = (x) => {
          if (x.status === 'done') { this.eatFailCount = 0; this.log(`自动进食: ${x.detail}`) } else if (++this.eatFailCount <= 3) this.log(`自动进食失败: ${x.detail}`)
          if (this.state === 'eating') this.state = 'idle'
        }
        this.state = 'eating'
        this.task = a
        bot.runChild(a) // 不打断主动作 (边走边吃)
        return
      }
    }

    // 4) 夜间回家
    if (p.nightShelter && p.home && !this.busy && isNight(bot.dayTime)) {
      const night = Math.floor(bot.worldAge / 24000)
      const prim = bot.activeAction
      if (this.shelteredNight !== night && (!prim || prim.status !== 'running')) {
        this.shelteredNight = night
        const h = p.home
        const far = Math.hypot(h.x - bot.pos.x, h.z - bot.pos.z) > 3
        this.state = far ? 'going_home' : 'sleeping'
        this.log(far ? `天黑了, 回家 (${h.x},${h.y},${h.z})` : '天黑了, 在家附近找床睡觉')
        const go = new (class extends AsyncAction {
          constructor (b: BotAgent) { super(b, 'go_home'); this.byReflex = true }
          protected async run () {
            if (far) { const mv = await this.sub(new MoveToAction(this.bot, h, { tolerance: 2 })); if (mv.status !== 'done') throw new Error(`回家失败: ${mv.detail}`) }
            const s = await this.sub(new SleepAction(this.bot))
            return s.status === 'done' ? `到家并睡下: ${s.detail}` : `到家了, 没睡成: ${s.detail}`
          }
        })(bot)
        go.onSettle = (x) => this.log(`夜间回家: ${x.detail}`)
        this.takeOver(go, '天黑回家')
      }
    }
  }

  /** 附近的敌对生物 (16 格内, 按距离) */
  threats () {
    const bot = this.bot
    const recentAttacker = bot.lastDamage && Date.now() - bot.lastDamage.at < 5000 ? bot.lastDamage.attackerId : null
    return [...bot.world.entities.values()]
      .filter(e => isHostile(e.type) || e.id === recentAttacker)
      .map(e => ({ e, d: Math.hypot(e.x - bot.pos.x, e.y - bot.pos.y, e.z - bot.pos.z) }))
      .filter(t => t.d < 16 && (t.d < 10 || isRanged(t.e.type) || t.e.id === recentAttacker))
      .sort((a, b) => a.d - b.d)
  }

  private fight (entityId: number, now: number) {
    const bot = this.bot
    if (now - this.lastAttackAt < 620) return // 剑冷却
    const e = bot.world.entities.get(entityId)
    if (!e) return
    if (this.state !== 'fighting') this.log(`迎战 ${e.type}#${e.id} (血 ${bot.health.toFixed(0)})`)
    this.state = 'fighting'
    // 手里换上最好的武器 (仅在快捷栏里的, 不做背包交换以免拖慢)
    const w = bot.inventory.find(s => weaponScore(s.name) > 0).filter(h => h.slot >= 36).sort((a, b) => weaponScore(b.item.name) - weaponScore(a.item.name))[0]
    if (w && bot.handFree() && bot.inventory.heldSlot !== w.slot - 36) { bot.selectSlot(w.slot - 36); return }
    const dx = e.x - bot.pos.x, dz = e.z - bot.pos.z
    bot.yaw = Math.atan2(-dx, dz) * 180 / Math.PI
    bot.pitch = 10
    bot.client.write('attack', { entityId })
    bot.client.write('arm_animation', { hand: 'main_hand' })
    this.lastAttackAt = now
  }

  /** 背离威胁方向 12-20 格的可站点 */
  private fleeSpot (fx: number, fz: number) {
    const bot = this.bot
    const ang = Math.atan2(bot.pos.z - fz, bot.pos.x - fx)
    for (const dist of [16, 12, 20, 8]) {
      for (const da of [0, 0.5, -0.5, 1, -1]) {
        const x = Math.floor(bot.pos.x + Math.cos(ang + da) * dist), z = Math.floor(bot.pos.z + Math.sin(ang + da) * dist)
        if (!bot.world.getChunk(x >> 4, z >> 4)) continue
        const y = bot.world.highestBlockY(x, z) + 1
        if (standableCell(bot.world, x, y, z)) return { x, y, z }
      }
    }
    return null
  }

  /** 6 格内最近的安全可站点 (不在岩浆/火里); 优先能直线冲过去的 (逃生时直接接管控制, 不走寻路) */
  private findSafeSpot () {
    const bot = this.bot
    const bx = Math.floor(bot.pos.x), by = Math.floor(bot.pos.y), bz = Math.floor(bot.pos.z)
    let best: { x: number, y: number, z: number } | null = null, bestD = Infinity
    for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) for (let dy = -1; dy <= 2; dy++) {
      const x = bx + dx, y = by + dy, z = bz + dz
      if (!standableCell(bot.world, x, y, z)) continue
      const d = Math.hypot(dx, dz) + Math.max(0, dy) * 0.8 + (this.lineClear(x, y, z) ? 0 : 100) // 跳上一格比绕远划算; 直线被挡的垫底
      if (d < bestD) { bestD = d; best = { x, y, z } }
    }
    return best
  }

  /** 从当前位置到 (x,y,z) 的直线上, 脚/头两格都不是实心方块 */
  private lineClear (x: number, y: number, z: number) {
    const bot = this.bot, w = bot.world
    const tx = x + 0.5, tz = z + 0.5
    const n = Math.ceil(Math.hypot(tx - bot.pos.x, tz - bot.pos.z) / 0.25)
    for (let i = 1; i <= n; i++) {
      const px = bot.pos.x + (tx - bot.pos.x) * i / n, pz = bot.pos.z + (tz - bot.pos.z) * i / n
      const fy = Math.max(Math.floor(bot.pos.y), y)
      if (w.isSolid(Math.floor(px), fy, Math.floor(pz)) || w.isSolid(Math.floor(px), fy + 1, Math.floor(pz))) return false
    }
    return true
  }

  /** 死亡: 丢掉进行中的反射任务/逃生状态 (动作本身由 bot.cancelActions 取消) */
  onDeath (cause: string) {
    this.task = null
    this.escape = null
    this.state = 'idle'
    this.eatFailCount = 0
    this.log(`死亡: ${cause}`)
  }

  status () {
    return { state: this.state, policy: this.policy, recent: this.events.slice(-5).map(e => ({ ago_s: Math.round((Date.now() - e.at) / 1000), text: e.text })) }
  }
}
