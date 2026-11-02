/**
 * BotAgent: 一个连接到 26.3 服务器的协议 bot。
 * 封装 M1 spike 验证过的全部握手细节:
 *  - Fabric 伪装: minecraft:register (fabric:registry/sync) + brand + sync→complete 应答
 *  - 配置态 ping→pong; select_known_packs / finish_configuration 由 nmp 自动处理
 *  - 26.3 teleport_confirm 坐标回显; 每 tick 恰好一对 position+tick_end
 */
import mc from 'minecraft-protocol'
import { World } from '../world/world.js'
import { PhysicsRunner } from '../physics/runner.js'
import { Inventory } from './inventory.js'
import { Action, MoveToAction, DigAction, PlaceAction, AttackAction, JumpAction, StopAction, SelectSlotAction, OpenContainerAction, ChestOpAction, DropItemAction, CloseWindowAction } from '../actions/actions.js'
import { CraftAction, SmeltAction, CollectAction, PickupItemsAction, EquipAction, EatAction, UseItemAction, UseBlockAction, SleepAction, WakeAction, InteractEntityAction, DismountAction, TradeAction } from '../actions/tasks.js'
import { Reflex } from './reflex.js'
import { itemName } from '../game/knowledge.js'
import type { ChatMessage } from './types.js'

export interface BotOptions {
  host: string
  port: number
  username: string
}

export type BotPhase = 'connecting' | 'configuration' | 'play' | 'ended'

/** 对外事件 (服务层写操作日志): 连接状态变化 / 动作结束 */
export type BotEvent =
  | { kind: 'conn', level: 'info' | 'warn', text: string }
  | { kind: 'action', action: Action }
  | { kind: 'reflex', text: string }

/** 不参与"主动作互斥"的动作: 纯库存/界面操作, 可与移动等并行 */
const SIDE_ACTIONS = new Set(['select_slot', 'chest_take', 'chest_put', 'drop_item', 'close_window', 'equip', 'wake', 'dismount'])

const FABRIC_CHANNELS = ['fabric:registry/sync', 'fabric:registry/sync/complete']
const TICK_MS = 50

export class BotAgent {
  readonly name: string
  phase: BotPhase = 'connecting'
  client: any

  pos = { x: 0, y: 0, z: 0 }
  yaw = 0
  pitch = 0
  health = 20
  food = 20
  onGround = true
  /** 自己的实体 id (login 下发) */
  entityId = -1
  /** 一天中的 tick (0-23999) / 世界总 tick */
  dayTime = 0
  worldAge = 0
  /** 氧气 (满 300) / 是否着火 / 是否在床上 (来自自身 entity_metadata) */
  air = 300
  onFire = false
  sleeping = false
  /** 骑乘中的载具实体 id */
  vehicleId: number | null = null
  /** 最近一次受伤 (damage_event): 来源实体 */
  lastDamage: { at: number, attackerId: number | null, sourceType: number } | null = null
  /** 累计捡起的物品数 (collect 包) */
  pickedUp = 0
  /** 实体最近的状态事件 (如动物繁殖爱心 = 18) */
  entityStatus = new Map<number, { status: number, at: number }>()
  /** 当前打开的村民交易列表 (trade_list) */
  trades: any[] | null = null

  world = new World()
  inventory = new Inventory()
  physics = new PhysicsRunner(this.world as any, this)
  chat: ChatMessage[] = []
  actions = new Map<number, Action>()
  private primaryAction: Action | null = null
  private lastAction: Action | null = null
  /** 手持占用: 挖掘/进食期间不能切换手持物品 */
  private handOwner: string | null = null
  private seqCounter = 100
  private lastSentLook = { yaw: NaN, pitch: NaN }
  reflex = new Reflex(this)
  private chatSeq = 0
  private tickTimer: NodeJS.Timeout | null = null
  private lastPosSentAt = 0
  /** 首次收到服务器传送的时间 / 完成"加载"(发出 player_loaded) 的时间; 0 = 尚未 */
  private firstTeleportAt = 0
  private loadedAt = 0
  /** 主动 disconnect() 时置位, 用于区分"被踢/掉线"与"手动下线" */
  private closing = false
  onEvent?: (e: BotEvent) => void

  constructor (private opts: BotOptions) {
    this.name = opts.username
  }

  connect (): Promise<void> {
    return new Promise((resolve, reject) => {
      const client = mc.createClient({
        host: this.opts.host,
        port: this.opts.port,
        username: this.opts.username,
        version: '26.3',
        auth: 'offline',
      })
      this.client = client
      const fail = (e: any) => { if (this.phase !== 'play') { clearTimeout(timer); reject(e) } }
      client.on('error', fail)
      // 登录前被踢 (白名单/封禁/版本不符) 时 nmp 只发 end 不发 error, 不处理会让调用方永远挂起
      let kickReason = ''
      client.on('disconnect', (p: any) => { kickReason = extractText(p.reason) || JSON.stringify(p.reason ?? '') })
      client.on('kick_disconnect', (p: any) => { kickReason = extractText(p.reason) || JSON.stringify(p.reason ?? '') })
      client.on('end', (reason: any) => fail(new Error(`登录前断开: ${kickReason || reason}`)))
      const timer = setTimeout(() => { fail(new Error('登录超时 (30s)')); try { client.end() } catch {} }, 30_000)

      // --- Fabric 伪装 ---
      client.on('state', (newState: string) => {
        if (newState === mc.states.CONFIGURATION) {
          this.phase = 'configuration'
          client.write('custom_payload', {
            channel: 'minecraft:register',
            data: Buffer.from(FABRIC_CHANNELS.join('\0') + '\0'),
          })
          client.write('custom_payload', {
            channel: 'minecraft:brand',
            data: Buffer.concat([Buffer.from([6]), Buffer.from('fabric')]), // varint 长度前缀
          })
        }
      })
      client.on('ping', (p: any) => client.write('pong', { id: p.id }))
      client.on('custom_payload', (p: any) => {
        if (p.channel === 'fabric:registry/sync') {
          this.world.applyFabricRegistrySync(p.data)
          client.write('custom_payload', { channel: 'fabric:registry/sync/complete', data: Buffer.alloc(0) })
        }
      })

      // --- play 态 ---
      client.on('login', (packet: any) => {
        this.phase = 'play'
        this.entityId = packet.entityId
        this.world.setLoginInfo(packet)
        // player_loaded 不在此处发: 要等出生点区块到达 (见 tick 里的加载门控), 与原版客户端一致
        if (process.env.MC_WIRE_DEBUG && this.client.serializer) {
          this.client.serializer.on('data', (d: Buffer) => {
            const hex = d.toString('hex')
            // 过滤掉每 tick 的 position/tick_end 噪音: position id=0x1e(1字节), tick_end id=0x0d
            if (!hex.startsWith('0d')) {
              console.log(`[wire> ${this.name}]`, hex)
            }
          })
        }
        this.startTicker()
        clearTimeout(timer)
        resolve()
      })
      client.on('position', (packet: any) => this.handleTeleport(packet))
      // 复活/换维度后原版客户端会重新走一遍加载流程并再发 player_loaded
      client.on('respawn', () => { this.firstTeleportAt = 0; this.loadedAt = 0; this.sleeping = false; this.vehicleId = null })
      client.on('update_time', (p: any) => {
        this.worldAge = Number(p.age ?? 0)
        const clock = p.clockUpdates?.[0]
        if (clock) this.dayTime = Number(clock.totalTicks) % 24000
      })
      client.on('damage_event', (p: any) => {
        if (p.entityId !== this.entityId) return
        // sourceCauseId/sourceDirectId 是 "实体 id + 1", 0 表示无
        this.lastDamage = { at: Date.now(), attackerId: p.sourceCauseId > 0 ? p.sourceCauseId - 1 : (p.sourceDirectId > 0 ? p.sourceDirectId - 1 : null), sourceType: p.sourceTypeId }
      })
      client.on('entity_metadata', (p: any) => {
        for (const m of p.metadata ?? []) {
          if (p.entityId === this.entityId) {
            if (m.key === 0) this.onFire = (Number(m.value) & 1) !== 0
            else if (m.key === 1) this.air = Number(m.value)
            else if (m.key === 6) this.sleeping = m.value === 'sleeping' || m.value === 2
          } else if (m.key === 8 && m.value && typeof m.value === 'object' && m.value.itemId !== undefined) {
            this.world.setEntityItem(p.entityId, itemName(m.value.itemId), m.value.itemCount ?? 1) // 掉落物实体的物品
          }
        }
      })
      client.on('set_passengers', (p: any) => {
        const ids: number[] = p.passengers ?? []
        if (ids.includes(this.entityId)) this.vehicleId = p.entityId
        else if (this.vehicleId === p.entityId) { this.vehicleId = null; this.physics.syncFromBot() }
      })
      ;(client as any).on('entity_status', (p: any) => this.entityStatus.set(p.entityId, { status: p.entityStatus, at: Date.now() }))
      client.on('collect', (p: any) => { if (p.collectorEntityId === this.entityId) this.pickedUp += p.pickupItemCount ?? 1 })
      client.on('trade_list', (p: any) => { this.trades = p.trades ?? [] })
      client.on('update_health', (p: any) => {
        this.health = p.health
        this.food = p.food
        // 死亡自动复活 (否则卡死亡界面, 世界数据不再加载)
        if (p.health <= 0) {
          this.onEvent?.({ kind: 'conn', level: 'warn', text: `死亡 @ ${this.pos.x.toFixed(0)},${this.pos.y.toFixed(0)},${this.pos.z.toFixed(0)}, 0.8s 后自动复活` })
          setTimeout(() => {
            if (this.phase === 'play') {
              console.log(`[${this.name}] health=0, respawning`)
              client.write('client_command', { actionId: 'perform_respawn' })
            }
          }, 800)
        }
      })

      // 世界数据
      client.on('map_chunk', (p: any) => this.world.loadChunk(p))
      client.on('unload_chunk', (p: any) => this.world.unloadChunk(p.x, p.z))
      // 区块按批发送, 每批必须回 chunk_batch_received 否则服务器停止发送
      client.on('chunk_batch_finished', () => {
        client.write('chunk_batch_received', { chunksPerTick: 25 })
      })
      client.on('block_change', (p: any) => {
        if (process.env.MC_WIRE_DEBUG) console.log(`[block_change] ${JSON.stringify(p).slice(0, 120)}`)
        this.world.setBlock(p)
      })
      client.on('multi_block_change', (p: any) => {
        if (process.env.MC_WIRE_DEBUG) console.log(`[multi_block_change] ${JSON.stringify(p).slice(0, 150)}`)
        this.world.setBlocksBulk(p)
      })
      client.on('explosion', (p: any) => this.world.applyExplosion(p))

      // 实体追踪（26.3 entityDelta: {onGround, steps:[{dX,dY,dZ,ticks}]}，steps 累加）
      client.on('spawn_entity', (p: any) => this.world.trackSpawn(p))
      const applyDelta = (p: any) => {
        const d = p.move ?? p.delta // 26.3 字段名是 move
        if (!d) return
        let dx = 0, dy = 0, dz = 0
        for (const s of d.steps ?? []) { dx += s.dX; dy += s.dY; dz += s.dZ }
        this.world.trackMove(p.entityId, dx, dy, dz)
      }
      client.on('rel_entity_move', applyDelta)
      client.on('entity_move_look', applyDelta)
      // 26.3: linear = 包上直接给 x/y/z; stepped = steps[] 里是一串绝对位置, 取最后一个
      client.on('sync_entity_position', (p: any) => {
        const last = p.steps?.length ? p.steps[p.steps.length - 1] : p
        if (Number.isFinite(last?.x)) this.world.trackTeleport(p.entityId, last.x, last.y, last.z)
      })
      client.on('entity_teleport', (p: any) => this.world.trackTeleport(p.entityId, p.x, p.y, p.z))
      client.on('entity_destroy', (p: any) => this.world.trackDestroy(p.entityIds ?? p.destroyedEntityIds ?? []))

      // 库存/容器
      client.on('window_items', (p: any) => this.inventory.handleWindowItems(p))
      client.on('set_slot', (p: any) => this.inventory.handleSetSlot(p))
      client.on('open_window', (p: any) => this.inventory.handleOpenWindow(p))
      client.on('close_window', (p: any) => this.inventory.close(p.windowId))
      client.on('held_item_slot', (p: any) => { this.inventory.heldSlot = p.slot ?? p.slotId ?? 0 })
      client.on('set_player_inventory', (p: any) => this.inventory.handleSetPlayerInventory(p))
      client.on('set_cursor_item', (p: any) => this.inventory.handleSetCursor(p))

      // 聊天
      client.on('system_chat', (p: any) => {
        const text = extractText(p.content)
        if (text) this.pushChat('system', text)
      })
      client.on('player_chat', (p: any) => {
        // 26.3: 发送者显示名在 networkName (NBT 文本组件)
        const sender = p.networkName ? plain(p.networkName) : (p.senderName ? plain(p.senderName) : '?')
        this.pushChat('player', `${sender}: ${p.plainMessage ?? p.content ?? ''}`)
      })
      // 控制台/RCON 的 /say、/me 等走 profileless_chat (无签名玩家)
      client.on('profileless_chat', (p: any) => {
        this.pushChat('player', `${plain(p.name)}: ${extractText(p.message)}`)
      })

      client.on('end', (reason: any) => {
        const wasPlaying = this.phase === 'play'
        this.phase = 'ended'
        this.stopTicker()
        this.pushChat('system', `[bot 断开] ${String(reason).slice(0, 200)}`)
        if (wasPlaying && !this.closing) this.onEvent?.({ kind: 'conn', level: 'warn', text: `掉线: ${kickReason || String(reason).slice(0, 200)}` })
      })
    })
  }

  disconnect () {
    this.closing = true
    this.stopTicker()
    try { this.client?.end() } catch {}
    this.phase = 'ended'
  }

  // ---------- 内部 ----------

  private handleTeleport (packet: any) {
    const f = packet.flags ?? {}
    const rel = (k: string, cur: number) => (f[k] ? (packet[k.toLowerCase()] ?? 0) + cur : (packet[k.toLowerCase()] ?? packet[k] ?? 0))
    // 26.3 position 包字段: teleportId x y z dx dy dz yaw pitch flags(bitflags 对象)
    this.pos = {
      x: f.x ? this.pos.x + packet.x : packet.x,
      y: f.y ? this.pos.y + packet.y : packet.y,
      z: f.z ? this.pos.z + packet.z : packet.z,
    }
    this.yaw = f.yaw ? this.yaw + packet.yaw : (packet.yaw ?? 0)
    this.pitch = f.pitch ? this.pitch + packet.pitch : (packet.pitch ?? 0)
    this.client.write('teleport_confirm', {
      teleportId: packet.teleportId,
      x: this.pos.x, y: this.pos.y, z: this.pos.z,
      yRot: this.yaw, xRot: this.pitch,
    })
    this.physics.syncFromBot() // 传送后物理引擎必须从新位置重启
    if (!this.firstTeleportAt) this.firstTeleportAt = Date.now()
    this.lastPosSentAt = 0 // 服务器位置已重置，下一 tick 立即上报
  }

  private startTicker () {
    this.tickTimer = setInterval(() => this.tick(), TICK_MS)
  }

  private stopTicker () {
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = null
  }

  /** 每 50ms: 动作 -> 物理模拟 -> 恰好发送一对 position + tick_end（26.3 服务器强制每 tick 至多一个移动包） */
  private tick () {
    if (this.phase !== 'play' || !this.client) return
    const now = Date.now()
    if (now - this.lastPosSentAt < TICK_MS - 5) return // 事件循环卡顿追赶时跳过，避免同 tick 双发

    // 加载门控 (仿原版): 收到出生传送且脚下区块已到 (或等满 5s) 才发 player_loaded, 下一 tick 起才模拟/上报移动。
    // 过早上报会赶在服务器首个连接 tick 重置 firstGood 之前, 冷启动时触发 "moved too quickly";
    // 区块未到时跑物理等于站在虚空里, 也会往下掉。
    if (!this.loadedAt) {
      if (!this.firstTeleportAt) return
      const chunkReady = !!this.world.getChunk(Math.floor(this.pos.x) >> 4, Math.floor(this.pos.z) >> 4)
      if (!chunkReady && now - this.firstTeleportAt < 5000) return
      this.loadedAt = now
      if (!process.env.MC_NO_PLAYER_LOADED) {
        try { this.client.write('player_loaded', {}) } catch (e: any) { console.warn(`[${this.name}] player_loaded 发送失败: ${e.message}`) }
      }
      return
    }
    this.lastPosSentAt = now

    // 驱动动作
    for (const a of this.actions.values()) {
      if (a.status === 'running') {
        try { a.step(now) } catch (e: any) { a.fail(`动作异常: ${e.message}`) }
      }
    }

    // 反射层 (可覆盖动作设置的控制量, 如溺水时按跳)
    try { this.reflex.tick(now) } catch (e: any) { console.warn(`[${this.name}] reflex 异常: ${e.message}`) }

    // 骑乘/睡觉: 位置由服务器决定, 不跑物理也不上报移动
    if (this.vehicleId !== null || this.sleeping) {
      const v = this.vehicleId !== null ? this.world.entities.get(this.vehicleId) : null
      if (v) this.pos = { x: v.x, y: v.y + 0.5, z: v.z }
      this.client.write('tick_end', {})
      return
    }

    // 物理模拟 (动作设置的 control 生效)
    this.physics.tick()

    // 朝向变了才带上 yaw/pitch (服务器用朝向决定放置方块的方向等)
    const flags = { onGround: this.onGround, hasHorizontalCollision: false }
    if (this.yaw !== this.lastSentLook.yaw || this.pitch !== this.lastSentLook.pitch) {
      this.lastSentLook = { yaw: this.yaw, pitch: this.pitch }
      this.client.write('position_look', { x: this.pos.x, y: this.pos.y, z: this.pos.z, yaw: this.yaw, pitch: this.pitch, flags })
    } else {
      this.client.write('position', { x: this.pos.x, y: this.pos.y, z: this.pos.z, flags })
    }
    this.client.write('tick_end', {})
  }

  // ---------- 动作系统 ----------

  act (type: string, params: any): Action {
    const int = (v: any, d?: number) => { const n = Math.floor(Number(v ?? d)); if (!Number.isFinite(n)) throw new Error(`参数缺失或不是数字 (动作 ${type})`); return n }
    const xyz = () => [int(params.x), int(params.y), int(params.z)] as const
    const str = (v: any, what: string) => { if (typeof v !== 'string' || !v) throw new Error(`${type} 需要参数 ${what}`); return v }
    let a: Action
    switch (type) {
      case 'move_to': a = new MoveToAction(this, { x: +params.x, y: params.y != null ? +params.y : undefined, z: +params.z }, { tolerance: params.tolerance != null ? Math.max(0, int(params.tolerance)) : undefined }); break
      case 'dig': a = new DigAction(this, ...xyz()); break
      case 'place': a = new PlaceAction(this, ...xyz(), int(params.face, 1), { hotbar: params.hotbar != null ? int(params.hotbar) : undefined, item: params.item }); break
      case 'attack': a = new AttackAction(this, int(params.entity_id ?? params.entityId), int(params.hits, 3)); break
      case 'jump': a = new JumpAction(this); break
      case 'stop': a = new StopAction(this); break
      case 'select_slot': a = new SelectSlotAction(this, int(params.slot, 0)); break
      case 'open_container': a = new OpenContainerAction(this, ...xyz()); break
      case 'chest_take': a = new ChestOpAction(this, 'take', int(params.slot, 0)); break
      case 'chest_put': a = new ChestOpAction(this, 'put', int(params.slot, 0)); break
      case 'drop_item': a = new DropItemAction(this, int(params.slot, 36), !!params.all); break
      case 'close_window': a = new CloseWindowAction(this); break
      case 'craft': a = new CraftAction(this, str(params.item, 'item'), int(params.count, 1)); break
      case 'craft_planks': { // 兼容旧动作: 用背包里第一种原木合成木板
        const log = this.inventory.find(s => s.name.endsWith('_log') || s.name.endsWith('_stem'))[0]
        a = new CraftAction(this, log ? log.item.name.replace(/_(log|stem)$/, '_planks') : 'oak_planks', 4); break
      }
      case 'smelt': a = new SmeltAction(this, str(params.item, 'item'), int(params.count, 1), params.fuel); break
      case 'collect': a = new CollectAction(this, str(params.block, 'block'), int(params.count, 1), int(params.radius, 32)); break
      case 'pickup_items': a = new PickupItemsAction(this, int(params.radius, 8)); break
      case 'equip': a = new EquipAction(this, str(params.item, 'item')); break
      case 'eat': a = new EatAction(this, params.item); break
      case 'use_item': a = new UseItemAction(this, params.item, int(params.hold_ms, 0)); break
      case 'use_block': a = new UseBlockAction(this, ...xyz(), params.item); break
      case 'sleep': a = new SleepAction(this, params.x != null ? { x: int(params.x), y: int(params.y), z: int(params.z) } : undefined); break
      case 'wake': a = new WakeAction(this); break
      case 'interact_entity': case 'mount': a = new InteractEntityAction(this, int(params.entity_id), params.item); break
      case 'dismount': a = new DismountAction(this); break
      case 'trade': a = new TradeAction(this, int(params.entity_id), params.index != null ? int(params.index) : undefined, int(params.times, 1)); break
      case 'go_home': {
        const h = this.reflex.policy.home
        if (!h) throw new Error('还没设置 home (set_policy {home: "here"} 或 {home: {x,y,z}})')
        a = new MoveToAction(this, h, { tolerance: 1 }); break
      }
      default: throw new Error(`未知动作类型: ${type}`)
    }
    // 主动作互斥: 新主动作取消旧主动作 (库存类动作不参与互斥)
    if (!SIDE_ACTIONS.has(type)) {
      if (this.primaryAction && this.primaryAction.status === 'running') this.primaryAction.cancel(`被新动作 ${type} 取代`)
      this.primaryAction = a
    }
    this.track(a)
    this.lastAction = a
    a.start()
    return a
  }

  /** 登记动作 (tick 驱动 + 结束时上报) */
  private track (a: Action, quiet = false) {
    // 推迟到本轮调用之后再上报: start() 里同步失败时, 日志里"动作失败"应排在"act 调用"之后
    if (!quiet) {
      const own = a.onSettle
      a.onSettle = (x) => { own?.(x); setImmediate(() => this.onEvent?.({ kind: 'action', action: x })) }
    }
    this.actions.set(a.id, a)
    if (this.actions.size > 80) {
      for (const [id, x] of this.actions) { if (x.status !== 'running') this.actions.delete(id); if (this.actions.size <= 80) break }
    }
  }

  /** 子动作 / 反射层的并行动作: 由 tick 驱动, 不进操作日志, 不参与主动作互斥 */
  runChild (a: Action) {
    this.track(a, true)
    a.start()
  }

  /** 反射层接管: 取消当前主动作 (写明原因) 并成为新的主动作 */
  startReflexAction (a: Action, reason: string) {
    a.byReflex = true
    if (this.primaryAction && this.primaryAction.status === 'running') this.primaryAction.cancel(reason)
    this.primaryAction = a
    this.track(a, true)
    a.start()
  }

  emitReflex (text: string) { this.onEvent?.({ kind: 'reflex', text }) }

  cancelActions (reason = '') {
    for (const a of this.actions.values()) if (a.status === 'running') a.cancel(reason)
    this.primaryAction = null
  }

  // ---------- 手持占用 ----------

  tryLockHand (owner: string): boolean {
    if (this.handOwner && this.handOwner !== owner) return false
    this.handOwner = owner
    return true
  }

  releaseHand (owner: string) { if (this.handOwner === owner) this.handOwner = null }
  handFree () { return this.handOwner === null }

  nextSequence () { return ++this.seqCounter }

  getAction (id: number) { return this.actions.get(id) }
  get activeAction () { return this.primaryAction }
  /** 最近一次 act() 的动作 (含库存类非主动作), wait_action 不带 id 时用 */
  get latestAction () { return this.lastAction }

  private pushChat (kind: 'system' | 'player', text: string) {
    this.chat.push({ seq: ++this.chatSeq, kind, text, at: Date.now() })
    if (this.chat.length > 500) this.chat.splice(0, this.chat.length - 500)
  }

  // ---------- 容器 / 库存 ----------

  /** 选快捷栏 0-8 */
  selectSlot (slot: number) {
    this.client.write('held_item_slot', { slotId: slot })
    this.inventory.heldSlot = slot
  }

  /** 右键使用手持物品 (吃/喝/投掷/举盾…) */
  useItem () {
    this.client.write('use_item', { hand: 'main_hand', sequence: this.nextSequence(), rotation: { x: this.yaw, y: this.pitch } })
  }

  /** 右键实体 (交易/喂食/骑乘/剪毛…) */
  interactEntity (entityId: number) {
    this.client.write('use_entity', { target: entityId, hand: 'main_hand', location: { x: 0, y: 0.9, z: 0 }, sneaking: false })
    this.client.write('arm_animation', { hand: 'main_hand' })
  }

  /** 左键点击窗口槽位 (拿起/放下整组) */
  clickSlot (windowId: number, slot: number, button = 0, mode = 0) {
    this.client.write('window_click', {
      windowId, stateId: this.inventory.stateId, slot, mouseButton: button, mode,
      changedSlots: [], cursorItem: undefined,
    })
  }

  /** 右键交互方块 (开箱等; 手上需为空或非方块) */
  interactBlock (x: number, y: number, z: number) {
    this.client.write('block_place', {
      hand: 'main_hand',
      location: { x, y, z },
      direction: 1,
      cursorX: 0.5, cursorY: 0.5, cursorZ: 0.5,
      insideBlock: false,
      worldBorderHit: false,
      sequence: this.nextSequence(),
    })
  }

  closeWindow (windowId: number) {
    this.client.write('close_window', { windowId })
    this.inventory.close(windowId)
  }

  // ---------- 对外能力 ----------

  say (text: string) {
    this.client.write('chat_message', {
      message: text,
      timestamp: BigInt(Date.now()),
      salt: BigInt(0),
      signature: undefined,
      offset: 0,
      acknowledged: Buffer.alloc(3),
      checksum: 0,
    })
  }

  /** 转向; 随下一 tick 的 position_look 发出 (每 tick 只能有一个移动包) */
  look (yawDeg: number, pitchDeg: number) {
    this.yaw = yawDeg
    this.pitch = Math.max(-90, Math.min(90, pitchDeg))
  }

  readChat (since = 0): ChatMessage[] {
    return this.chat.filter(m => m.seq > since)
  }
}

// ---------- 聊天 NBT 文本提取 ----------

const TRANSLATE_ZH: Record<string, string> = {
  'multiplayer.disconnect.not_whitelisted': '不在服务器白名单中',
  'multiplayer.disconnect.banned': '已被封禁',
  'multiplayer.disconnect.server_full': '服务器已满',
  'multiplayer.disconnect.duplicate_login': '同名角色在别处登录',
  'multiplayer.disconnect.kicked': '被管理员踢出',
  'multiplayer.disconnect.idling': '挂机太久被踢出',
  'multiplayer.disconnect.server_shutdown': '服务器已关闭',
  'multiplayer.disconnect.outdated_client': '客户端版本过旧',
  'multiplayer.disconnect.incompatible': '客户端版本不兼容',
  'block.minecraft.bed.no_sleep': '只能在夜晚或雷雨天睡觉',
  'block.minecraft.bed.not_safe': '附近有怪物, 现在不能休息',
  'block.minecraft.bed.too_far_away': '离床太远',
  'block.minecraft.bed.occupied': '床被占用了',
  'block.minecraft.bed.obstructed': '床被挡住了',
  'block.minecraft.set_spawn': '已设置重生点',
}

export function extractText (nbt: any): string {
  if (nbt == null) return ''
  if (typeof nbt === 'string') {
    // 登录态的断开原因是 JSON 文本组件字符串 (play 态才是 NBT)
    if (!nbt.startsWith('{')) return nbt
    try { nbt = JSON.parse(nbt) } catch { return nbt }
  }
  const out: string[] = []
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return
    const v = node.value ?? node
    if (typeof v.text === 'string') out.push(v.text)
    else if (v.text?.type === 'string' && typeof v.text.value === 'string') out.push(v.text.value) // anonymousNbt 复合: {text:{type,value}}
    else if (node.type === 'string' && typeof node.value === 'string') out.push(node.value)
    else {
      // 翻译键组件 (踢出原因等): 常见键给中文, 其余原样输出键名
      const key = typeof v.translate === 'string' ? v.translate : v.translate?.value
      if (typeof key === 'string') out.push(TRANSLATE_ZH[key] ?? key)
    }
    let extra = v.extra ?? node.extra
    if (extra?.value) extra = extra.value
    if (Array.isArray(extra)) extra.forEach(walk)
  }
  walk(nbt)
  return out.join('')
}

function plain (n: any): string {
  const t = extractText(n)
  return t || String(n ?? '?')
}
