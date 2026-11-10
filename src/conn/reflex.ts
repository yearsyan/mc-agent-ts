/**
 * 反射层: 不等 LLM、每 tick 自主执行的保命行为 (LLM 一次决策要数秒, 僵尸几秒就能打死人)。
 * LLM 通过 set_policy 设定策略, 这里只负责执行; 每次介入都记一条 reflex 事件 (操作日志/scene 可见)。
 * 优先级: 危险地形逃生 > 战斗/逃跑 > 进食 > 夜间回家睡觉。
 */
import type { BotAgent } from './bot.js'
import { isHotbar, hotbarIndex } from './inventory.js'
import type { Action } from '../actions/base.js'
import { AsyncAction } from '../actions/base.js'
import { MoveToAction } from '../actions/actions.js'
import { eatOnce, bestFood, SleepAction } from '../actions/tasks.js'
import { standableCell } from '../actions/astar.js'
import { isHostile, isRanged, weaponScore, isNight, isWatery, isProjectile, entitySize, attackCooldownMs } from '../game/knowledge.js'
import { projectileEta } from '../game/ballistics.js'
import { EquipAction } from '../actions/tasks.js'
import { ShootAction, AttackAction, canShoot, solveShot } from '../actions/combat.js'
import { FLYING } from '../game/knowledge.js'

/** 会拉弓/上弩的远程怪 (living_entity_flags bit0 = 正在使用物品) */
const BOW_MOBS = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'piglin', 'illusioner'])

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
  /** 家 (dimension 缺省 = 主世界, 兼容旧存档) */
  home: { x: number, y: number, z: number, dimension?: string } | null
  /** 死亡后自动复活 (关掉则停在死亡界面, 由 act{type:"respawn"} 手动复活) */
  autoRespawn: boolean
  /** 自动举盾 (副手有盾时): 箭飞来/骷髅拉弓/苦力怕点燃/近身怪 → 面向威胁格挡 */
  shield: boolean
  /** 远程: auto = 战斗时按情况用弓 (需弓+箭); never = 只近战 */
  ranged: 'auto' | 'never'
}

/** home 所在维度 (旧存档没记维度的按主世界) */
export const homeDimension = (h: { dimension?: string }) => h.dimension ?? 'minecraft:overworld'

export const DEFAULT_POLICY: Policy = { autoEat: true, eatAt: 14, combat: 'defend', fleeHealth: 8, avoidHazards: true, nightShelter: false, home: null, autoRespawn: true, shield: true, ranged: 'auto' }

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
  state: 'idle' | 'eating' | 'fighting' | 'shooting' | 'fleeing' | 'escaping' | 'going_home' | 'sleeping' = 'idle'
  private task: Action | null = null
  private lastAttackAt = 0
  private lastEatTryAt = 0
  private lastFleeAt = 0
  private lastCheckAt = 0
  private shelteredNight = -1
  private eatFailCount = 0
  /** 正在逃离危险地形: 直接接管控制量跑向安全点 (岩浆里等不起寻路) */
  private escape: { x: number, y: number, z: number, until: number } | null = null
  // ---- 盾牌 ----
  shieldUp = false
  private shieldWantUntil = 0
  private shieldFace: { x: number, y: number, z: number } | null = null
  /** 举盾期间要砍一刀: 本 tick 放盾, 下 tick 攻击, 再下 tick 重新举盾 */
  private pendingStrike: number | null = null
  private shieldWhy = ''
  private shieldLogAt = 0
  private blocksSeen = 0
  private lastEquipShieldAt = 0
  private shootLogAt = new Map<number, number>()
  /** 远程怪最近一次"拉弓"信号的时间: 信号随拉弓周期开关, 记 3 秒才能整段举盾 */
  private drawSeenAt = new Map<number, number>()

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

  private treading = false

  /** 每 tick 调用 (动作 step 之后、物理之前, 可覆盖控制量) */
  tick (now: number) {
    const bot = this.bot
    if (bot.sleeping || bot.vehicleId !== null || bot.health <= 0) return
    const p = this.policy
    const head = bot.world.getBlock(Math.floor(bot.pos.x), Math.floor(bot.pos.y + bot.eyeHeight), Math.floor(bot.pos.z))?.name
    const feet = bot.world.getBlock(Math.floor(bot.pos.x), Math.floor(bot.pos.y), Math.floor(bot.pos.z))?.name

    // 溺水: 头在水里且氧气见底 → 按住跳往上游 (每 tick 覆盖控制量)
    if (p.avoidHazards && isWatery(head) && bot.air < 150) bot.physics.control.jump = true
    // 空闲泡在水里: 踩水浮在水面 (否则会沉到水底)
    const prim = bot.activeAction
    if (isWatery(feet) && (!prim || prim.status !== 'running')) { bot.physics.control.jump = true; this.treading = true }
    else if (this.treading) {
      // 离开水面 (上岸/被传送) 后松开跳跃, 否则空闲时会原地一直跳
      this.treading = false
      if (!prim || prim.status !== 'running') bot.physics.control.jump = false
    }

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

    // 盾牌: 每 tick 判断 (箭从拉弓到命中只有十几 tick)
    if (this.shieldTick(now)) return

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
      // 苦力怕: 已点燃且很近时有盾就原地举盾硬吃 (正面格挡挡掉爆炸), 否则跑
      const creeper = threats.find(t => t.e.type === 'creeper' && t.d < 6 && !(this.shieldReady() && t.d < 4 && this.creeperLit(t.e)))
      const lowHp = bot.health <= p.fleeHealth
      if (threats.length && (p.combat === 'flee' || creeper || (lowHp && threats.some(t => t.d < 8)))) {
        if (!(this.busy && this.state === 'fleeing') && now - this.lastFleeAt > 3000) {
          const from = creeper ?? threats[0]
          const spot = this.fleeSpot(from.e.x, from.e.z)
          if (spot) {
            this.lastFleeAt = now
            this.state = 'fleeing'
            this.log(`逃离 ${from.e.type}#${from.e.id} (距离 ${from.d.toFixed(1)}, 血 ${bot.health.toFixed(0)}) → (${spot.x},${spot.z})`)
            this.takeOver(new MoveToAction(bot, spot, { tolerance: 2, timeoutMs: 15_000, propose: false }), `逃离 ${from.e.type}`)
          }
        }
        return
      }
      if (p.combat === 'defend') {
        // 远程: 有弓有箭时, 远程怪/苦力怕/飞行怪用弓; LLM 空闲时也射逼近的近战怪 (每次 1 箭, 射完重新评估)
        if (this.busy && this.state === 'shooting') return
        if (p.ranged === 'auto' && canShoot(bot)) {
          const prim = bot.activeAction
          const llmBusy = !!prim && prim.status === 'running' && !prim.byReflex
          const cand = threats.find(t => this.worthShooting(t.e, t.d, llmBusy))
          if (cand) {
            const a = new ShootAction(bot, cand.e.id, 1, { melee: true, pickup: false })
            a.onSettle = (x) => { if (x.status === 'failed') this.log(`射击 ${cand.e.type} 失败: ${x.detail}`) }
            if (now - (this.shootLogAt.get(cand.e.id) ?? 0) > 10_000) { this.shootLogAt.set(cand.e.id, now); this.log(`弓箭迎敌 ${cand.e.type}#${cand.e.id} (距离 ${cand.d.toFixed(1)})`) }
            this.state = 'shooting'
            this.takeOver(a, `射击 ${cand.e.type}`)
            return
          }
        }
        // 点燃的苦力怕不去砍 (砍要放下盾, 爆炸瞬间没盾就是重伤)
        const target = threats.find(t => t.d <= 3.3 && !(t.e.type === 'creeper' && this.creeperLit(t.e) && this.shieldReady()))
        if (target) {
          // 在吃东西/挖掘时手被占用: 挖掘让路 (打断), 吃东西就等吃完
          if (this.state !== 'eating') {
            const prim = bot.activeAction
            // LLM 自己正在近战/射击: 不打断也不抢着砍 (它会追着打)
            if (prim && prim.status === 'running' && !prim.byReflex && (prim instanceof AttackAction || prim instanceof ShootAction)) return
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
    // 不在家所在维度 / 本维度睡床会爆炸 (下界/末地) 时不回家
    if (p.nightShelter && p.home && !this.busy && isNight(bot.dayTime) && homeDimension(p.home) === bot.dimension && bot.dimInfo.bedWorks) {
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
            if (far) { const mv = await this.sub(new MoveToAction(this.bot, h, { tolerance: 2, propose: false })); if (mv.status !== 'done') throw new Error(`回家失败: ${mv.detail}`) }
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
      .filter(t => t.d < 16 && (t.d < 10 || isRanged(t.e.type) || t.e.type === 'creeper' || t.e.id === recentAttacker))
      .sort((a, b) => a.d - b.d)
  }

  private fight (entityId: number, now: number) {
    const bot = this.bot
    if (now - this.lastAttackAt < attackCooldownMs(bot.inventory.held()?.name) - 30) return // 武器冷却 (剑 0.63s / 斧 1~1.25s)
    const e = bot.world.entities.get(entityId)
    if (!e) return
    if (this.state !== 'fighting') this.log(`迎战 ${e.type}#${e.id} (血 ${bot.health.toFixed(0)})`)
    this.state = 'fighting'
    // 手里换上最好的武器 (仅在快捷栏里的, 不做背包交换以免拖慢)
    const w = bot.inventory.find(s => weaponScore(s.name) > 0).filter(h => isHotbar(h.slot)).sort((a, b) => weaponScore(b.item.name) - weaponScore(a.item.name))[0]
    if (w && bot.handFree() && bot.inventory.heldSlot !== hotbarIndex(w.slot)) { bot.selectSlot(hotbarIndex(w.slot)); return }
    if (this.shieldUp) { this.lowerShield(); this.pendingStrike = entityId; this.lastAttackAt = now; return } // 举盾时不能攻击: 先放下, 下 tick 砍
    this.strike(entityId, now)
  }

  private strike (entityId: number, now: number) {
    const bot = this.bot
    const e = bot.world.entities.get(entityId)
    if (!e) return
    const dx = e.x - bot.pos.x, dz = e.z - bot.pos.z
    bot.yaw = Math.atan2(-dx, dz) * 180 / Math.PI
    bot.pitch = 10
    bot.attackEntity(entityId)
    this.lastAttackAt = now
  }

  /** 值得用弓打的威胁: 远程怪 4-24 格 / 苦力怕 6-16 格 / 飞行怪 ≤24 格 / (LLM 空闲时) 逼近的近战怪 5-14 格; 且弹道畅通 */
  private worthShooting (e: { id: number, type: string }, d: number, llmBusy: boolean) {
    let ok: boolean
    if (e.type === 'creeper') ok = d >= 6 && d <= 16
    else if (isRanged(e.type)) ok = d > 4 && d <= 24
    else if (FLYING.has(e.type)) ok = d <= 24
    else ok = !llmBusy && d >= 5 && d <= 14
    if (!ok) return false
    return solveShot(this.bot, e.id).ok
  }

  // ---------- 盾牌 ----------

  shieldReady () {
    const bot = this.bot
    return this.policy.shield && bot.inventory.offhand()?.name === 'shield' && !bot.onCooldown('shield')
  }

  private creeperLit (e: { meta: Record<string, any> }) { return (e.meta.swell_dir ?? -1) > 0 || !!e.meta.is_ignited }

  /** 放下盾 (攻击/挖掘前调用) */
  lowerShield () {
    if (!this.shieldUp) return
    if (this.bot.usingHand === 'off_hand') this.bot.releaseUseItem()
    this.shieldUp = false
  }

  /** 每 tick: 判断威胁、举/放盾、面向威胁。返回 true 表示本 tick 已用掉 (如刚砍了一刀) */
  private shieldTick (now: number): boolean {
    const bot = this.bot
    if (this.shieldUp && bot.usingHand !== 'off_hand') this.shieldUp = false // 被别的使用 (拉弓/进食) 顶掉, 或盾被击破
    if (bot.shieldBlocks > this.blocksSeen) {
      this.blocksSeen = bot.shieldBlocks
      if (now - this.shieldLogAt > 1500) { this.shieldLogAt = now; this.log(`盾牌格挡 (${this.shieldWhy || '?'}, 累计 ${bot.shieldBlocks} 次)`) }
    }
    if (this.pendingStrike !== null) { const id = this.pendingStrike; this.pendingStrike = null; this.strike(id, now); return true }
    // 自动把盾放到副手 (副手空着才放, 不顶掉图腾)
    if (this.policy.shield && !bot.inventory.offhand() && now - this.lastEquipShieldAt > 15_000 && bot.inventory.find(s => s.name === 'shield').length && bot.inventory.activeWindowId === null) {
      this.lastEquipShieldAt = now
      const a = new EquipAction(bot, 'shield'); a.byReflex = true
      a.onSettle = (x) => { if (x.status === 'done') this.log('盾牌放到副手') }
      bot.runChild(a)
    }
    if (!this.shieldReady()) { this.lowerShield(); return false }
    const threat = this.shieldThreat(now)
    if (threat) {
      this.shieldWantUntil = now + 350
      this.shieldFace = threat.at
      if (threat.why !== this.shieldWhy && now - this.shieldLogAt > 3000) { this.shieldLogAt = now; this.log(`举盾: ${threat.why}`) }
      this.shieldWhy = threat.why
    }
    if (now >= this.shieldWantUntil || !this.shieldFace) { this.lowerShield(); return false }
    // 赶路中 (非逃跑) 只在威胁大致在前方时举盾, 不扭头 (否则会朝着威胁走过去); 逃跑时背对威胁, 不举
    const prim = bot.activeAction
    const moving = prim instanceof MoveToAction && prim.status === 'running'
    if (moving && (this.state === 'fleeing' || prim.byReflex)) { this.lowerShield(); return false }
    // 手被占用 (拉弓/进食/挖掘) 时不举盾也不扭头, 免得破坏瞄准
    if (!this.shieldUp && (bot.usingHand !== null || !bot.handFree())) return false
    const f = this.shieldFace
    const want = Math.atan2(-(f.x - bot.pos.x), f.z - bot.pos.z) * 180 / Math.PI
    if (moving) {
      const diff = Math.abs(((want - bot.yaw) % 360 + 540) % 360 - 180)
      if (diff > 60) { this.lowerShield(); return false }
    } else {
      bot.yaw = want
      bot.pitch = -Math.atan2(f.y - (bot.pos.y + 1.62), Math.hypot(f.x - bot.pos.x, f.z - bot.pos.z)) * 180 / Math.PI
    }
    if (!this.shieldUp && bot.usingHand === null) {
      bot.usingHand = 'off_hand'
      bot.useItem('off_hand')
      this.shieldUp = true
    }
    return false
  }

  /** 需要举盾的威胁 (按紧迫度): 飞来的弹射物 > 拉弓的远程怪 > 点燃的苦力怕 > 近身怪 */
  private shieldThreat (now: number): { at: { x: number, y: number, z: number }, why: string } | null {
    const bot = this.bot
    const eye = { x: bot.pos.x, y: bot.pos.y + 1.62, z: bot.pos.z }
    let best: { at: { x: number, y: number, z: number }, why: string, rank: number } | null = null
    const consider = (rank: number, at: { x: number, y: number, z: number }, why: string) => { if (!best || rank < best.rank) best = { at, why, rank } }
    for (const e of bot.world.entities.values()) {
      const d = Math.hypot(e.x - bot.pos.x, e.y - bot.pos.y, e.z - bot.pos.z)
      if (d > 32) continue
      if (isProjectile(e.type)) {
        if (e.ownerId === bot.entityId || e.meta.in_ground) continue
        const eta = projectileEta(e, bot.pos, now)
        if (eta !== null && eta <= 25) consider(0, { x: e.x, y: e.y, z: e.z }, `${e.type} 飞来`)
        continue
      }
      if (!isHostile(e.type) && e.id !== bot.lastDamage?.attackerId) continue
      const h = entitySize(e.type).h
      const center = { x: e.x, y: e.y + h * 0.8, z: e.z }
      // 骷髅拉弓时服务器不置 living_entity_flags, 而是 mob_flags bit2 (aggressive, 客户端据此画举弓动作), 随拉弓周期开关
      const drawing = ((e.meta.living_entity_flags ?? 0) & 1) || ((e.meta.mob_flags ?? 0) & 4) || e.meta.is_charging_crossbow
      if (BOW_MOBS.has(e.type) && drawing) this.drawSeenAt.set(e.id, now)
      if (BOW_MOBS.has(e.type) && d <= 24 && now - (this.drawSeenAt.get(e.id) ?? 0) < 3000 && this.losTo(eye, center)) consider(1, center, `${e.type} 拉弓`)
      else if (e.type === 'creeper' && d <= 5 && this.creeperLit(e)) consider(2, center, '苦力怕点燃')
      else if (!isRanged(e.type) && e.type !== 'creeper' && d <= 3.5) consider(3, center, `${e.type} 近身`)
    }
    if (this.drawSeenAt.size > 50) for (const [id, t] of this.drawSeenAt) if (now - t > 5000) this.drawSeenAt.delete(id)
    return best
  }

  /** 两点间无实心方块 */
  private losTo (a: { x: number, y: number, z: number }, b: { x: number, y: number, z: number }) {
    const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / 0.3)
    for (let i = 1; i < n; i++) {
      const t = i / n
      if (this.bot.world.isSolid(Math.floor(a.x + (b.x - a.x) * t), Math.floor(a.y + (b.y - a.y) * t), Math.floor(a.z + (b.z - a.z) * t))) return false
    }
    return true
  }

  /** 背离威胁方向 12-20 格的可站点 */
  private fleeSpot (fx: number, fz: number) {
    const bot = this.bot
    const ang = Math.atan2(bot.pos.z - fz, bot.pos.x - fx)
    for (const dist of [16, 12, 20, 8]) {
      for (const da of [0, 0.5, -0.5, 1, -1]) {
        const x = Math.floor(bot.pos.x + Math.cos(ang + da) * dist), z = Math.floor(bot.pos.z + Math.sin(ang + da) * dist)
        if (!bot.world.getChunk(x >> 4, z >> 4)) continue
        const y = bot.world.groundY(x, z, bot.pos.y) + 1 // 下界: 自己高度附近的地面, 不是顶棚上面
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
    this.shieldUp = false
    this.pendingStrike = null
    this.task = null
    this.escape = null
    this.state = 'idle'
    this.eatFailCount = 0
    this.log(`死亡: ${cause}`)
  }

  status () {
    return { state: this.state, ...(this.shieldUp ? { shield_up: true } : {}), home: this.policy.home ?? null, recent: this.events.slice(-5).map(e => ({ ago_s: Math.round((Date.now() - e.at) / 1000), text: e.text })) }
  }
}
