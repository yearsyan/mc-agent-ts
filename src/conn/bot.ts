/**
 * BotAgent: 一个连接到 26.3 服务器的协议 bot。
 * 封装 M1 spike 验证过的全部握手细节:
 *  - Fabric 伪装: minecraft:register (fabric:registry/sync) + brand + sync→complete 应答
 *  - 配置态 ping→pong; select_known_packs / finish_configuration 由 nmp 自动处理
 *  - 26.3 teleport_confirm 坐标回显; 每 tick 恰好一对 position+tick_end
 */
import mc from 'minecraft-protocol'
import { MC_VERSION, mcData } from '../version.js'
import { World, metaKeyName } from '../world/world.js'
import { parseDimType, vanillaDim, type DimType } from '../world/dimension.js'
import { PhysicsRunner } from '../physics/runner.js'
import { Inventory, SLOT } from './inventory.js'
import { approvalOf, type RouteProposal, type Approval } from '../actions/route.js'
import { MAX_MOVE_DIST, Action, MoveToAction, DigAction, PlaceAction, JumpAction, StopAction, SelectSlotAction, OpenContainerAction, ChestOpAction, DropItemAction, CloseWindowAction } from '../actions/actions.js'
import { Task, ReachThen, ChestTransferAction, containerBlocked, CraftAction, SmeltAction, CollectAction, PickupItemsAction, EquipAction, EatAction, UseItemAction, UseBlockAction, SleepAction, WakeAction, InteractEntityAction, DismountAction, TradeAction } from '../actions/tasks.js'
import { Reflex, homeDimension } from './reflex.js'
import { ShootAction, AttackAction } from '../actions/combat.js'
import { itemName } from '../game/knowledge.js'
import type { ChatMessage } from './types.js'
import { AsyncAction } from '../actions/base.js'
import { ScriptAction } from '../actions/script.js'

/** 一次死亡的记录 (scene.last_death / 操作日志 / 聊天提示) */
export interface DeathRecord {
  n: number
  at: number
  pos: { x: number, y: number, z: number }
  dimension: string
  /** 中文死因句, 如 "被 zombie 杀死了" */
  cause: string
  /** 原始翻译键, 如 death.attack.mob; 服务器关了死亡消息时可能为 damage_type 名 */
  causeKey: string
  killer: string | null
  /** 死亡时身上的物品 (含盔甲/副手) */
  items: Record<string, number>
  itemCount: number
  /** 复活后背包仍有物品 = keepInventory; null = 还没复活 */
  keptInventory: boolean | null
  respawnedAt: number | null
}

/** 掉落物实体的存活时间 (原版 6000 tick) */
export const DROP_DESPAWN_MS = 300_000

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

/**
 * block_dig 包的 status 取值 (协议相关, 换版本要核对)。
 * 26.3: 0 = START_DESTROY, 3 = STOP_DESTROY (挖完), 6 = RELEASE_USE_ITEM
 */
const DIG_STATUS = { start: 0, finish: 3, releaseUse: 6 } as const
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
  private sprintSent = false
  /** 眼高: 游泳姿态 0.4, 站立 1.62 */
  get eyeHeight () { return this.physics.eyeHeight }
  get swimming () { return this.physics.swimming }
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
  lastDamage: { at: number, attackerId: number | null, sourceType: number, sourceName: string | null } | null = null
  /** 累计捡起的物品数 (collect 包) */
  pickedUp = 0
  /** 各实体最近一次受伤时间 (damage_event; 射箭判定命中用) */
  entityDamagedAt = new Map<number, number>()
  /** 物品冷却 (set_cooldown: 组名 → 结束时间), 如盾被斧头打掉后 minecraft:shield 冷却 5s */
  cooldowns = new Map<string, number>()
  /** 盾牌成功格挡次数 (自身 entity_status 29) / 最近一次格挡时间 */
  shieldBlocks = 0
  lastShieldBlockAt = 0
  /** 本次上线累计受伤次数 (自身 damage_event) */
  hurts = 0
  /** 正在使用的物品手 (拉弓/举盾/进食), 由发起方维护 */
  usingHand: 'main_hand' | 'off_hand' | null = null
  private afterTickFns: Array<() => void> = []
  /** 实体最近的状态事件 (如动物繁殖爱心 = 18) */
  entityStatus = new Map<number, { status: number, at: number }>()
  /** 当前打开的村民交易列表 (trade_list) */
  trades: any[] | null = null
  /** 当前维度 (login / respawn 的 worldState.name) */
  dimension = 'minecraft:overworld'
  /** 当前维度的类型: 高度/顶棚/能否睡床 */
  dimInfo: DimType = vanillaDim('overworld')
  /** dimension_type 注册表 (配置阶段 registry_data), worldState.dimension 是其下标 */
  private dimTypes: DimType[] = []
  /** 已收到 login (之后的 respawn 才可能是换维度) */
  private dimEntered = false
  /** 最近一次由我们打开的容器 (get_container 标注是哪个方块; windowId 不再是当前窗口时作废) */
  openedContainer: { windowId: number, block: string, x: number, y: number, z: number } | null = null
  /** 寻路给出的挖/搭方案 (按 id 存 10 分钟, act 参数 confirm 引用) */
  private proposalStore = new Map<string, { p: RouteProposal, at: number }>()
  /** 死亡中 (已死、尚未复活) */
  dead = false
  /** 本次上线以来的死亡次数 / 最近一次死亡 */
  deaths = 0
  lastDeath: DeathRecord | null = null
  /** damage_type 注册表 (配置阶段 registry_data), 用于 damage_event 的 sourceTypeId → 名字 */
  damageTypes: string[] = []
  /** chat_type 注册表 (player_chat 的 type 是其下标): chat / emote_command / msg_command_incoming … */
  chatTypes: string[] = []
  private respawnSentAt = 0
  /** 服务器下发的命令树里本角色可用的顶层命令 (declare_commands, 已按权限过滤); null = 还没收到 */
  commands: Set<string> | null = null
  /** login 包里服务器记录的上次死亡地点 (死着重新登录时用来还原死亡点) */
  private loginDeath: { dimensionName: string, location: { x: number, y: number, z: number } } | null = null

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
        version: MC_VERSION,
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
      client.on('registry_data', (p: any) => {
        const names = () => (p.entries ?? []).map((e: any) => String(e.key).replace(/^minecraft:/, ''))
        if (String(p.id).endsWith('damage_type')) this.damageTypes = names()
        else if (String(p.id).endsWith('chat_type')) this.chatTypes = names()
        else if (String(p.id).endsWith('dimension_type')) this.dimTypes = (p.entries ?? []).map(parseDimType)
      })
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
        this.enterDimension(packet.worldState)
        this.loginDeath = packet.worldState?.death ?? null
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
      client.on('respawn', (p: any) => {
        this.firstTeleportAt = 0; this.loadedAt = 0; this.sprintSent = false; this.physics.swimming = false; this.sleeping = false; this.vehicleId = null
        this.enterDimension(p.worldState)
        if (this.dead) this.onRespawned()
      })
      // 死亡: 服务器专门发给死者的包 (关了 showDeathMessages 时 message 为空); update_health≤0 作兜底
      client.on('death_combat_event', (p: any) => { if (p.playerId === this.entityId) this.onDeath(p.message) })
      client.on('update_time', (p: any) => {
        this.worldAge = Number(p.age ?? 0)
        const clock = p.clockUpdates?.[0]
        if (clock) this.dayTime = Number(clock.totalTicks) % 24000
      })
      client.on('damage_event', (p: any) => {
        this.entityDamagedAt.set(p.entityId, Date.now())
        if (this.entityDamagedAt.size > 500) this.entityDamagedAt.clear()
        if (p.entityId !== this.entityId) return
        this.hurts++
        // sourceCauseId/sourceDirectId 是 "实体 id + 1", 0 表示无
        this.lastDamage = { at: Date.now(), attackerId: p.sourceCauseId > 0 ? p.sourceCauseId - 1 : (p.sourceDirectId > 0 ? p.sourceDirectId - 1 : null), sourceType: p.sourceTypeId, sourceName: this.damageTypes[p.sourceTypeId] ?? null }
      })
      client.on('entity_metadata', (p: any) => {
        for (const m of p.metadata ?? []) {
          if (p.entityId === this.entityId) {
            const k = metaKeyName('player', m.key)
            if (k === 'shared_flags') this.onFire = (Number(m.value) & 1) !== 0
            else if (k === 'air_supply') this.air = Number(m.value)
            else if (k === 'pose') this.sleeping = m.value === 'sleeping' || m.value === 2
          } else if (this.world.metaKeyName(p.entityId, m.key) === 'item' && m.value && typeof m.value === 'object' && m.value.itemId !== undefined) {
            this.world.setEntityItem(p.entityId, itemName(m.value.itemId), m.value.itemCount ?? 1) // 掉落物实体的物品
          } else if (typeof m.value !== 'object' || m.value === null) {
            this.world.setEntityMeta(p.entityId, m.key, m.value) // 拉弓 (living_entity_flags) / 苦力怕膨胀 (swell_dir) / 箭插地 (in_ground) 等
          }
        }
      })
      client.on('set_passengers', (p: any) => {
        const ids: number[] = p.passengers ?? []
        if (ids.includes(this.entityId)) this.vehicleId = p.entityId
        else if (this.vehicleId === p.entityId) { this.vehicleId = null; this.physics.syncFromBot() }
      })
      ;(client as any).on('entity_status', (p: any) => {
        this.entityStatus.set(p.entityId, { status: p.entityStatus, at: Date.now() })
        if (p.entityId === this.entityId && p.entityStatus === 29) { this.shieldBlocks++; this.lastShieldBlockAt = Date.now() } // 盾牌格挡
        if (p.entityId === this.entityId && p.entityStatus === 30) { this.usingHand = this.usingHand === 'off_hand' ? null : this.usingHand } // 盾被击破
      })
      client.on('entity_velocity', (p: any) => { if (p.velocity) this.world.setEntityVelocity(p.entityId, p.velocity) })
      // 26.3 盾牌格挡不再发 entity_status 29; 改用"举盾时别人的箭被弹开"计数
      this.world.onDeflect = (e) => { if (this.usingHand === 'off_hand' && e.ownerId !== this.entityId) { this.shieldBlocks++; this.lastShieldBlockAt = Date.now() } }
      client.on('set_cooldown', (p: any) => {
        const g = String(p.cooldownGroup).replace(/^minecraft:/, '')
        if (p.cooldownTicks > 0) this.cooldowns.set(g, Date.now() + p.cooldownTicks * 50); else this.cooldowns.delete(g)
      })
      client.on('collect', (p: any) => { if (p.collectorEntityId === this.entityId) this.pickedUp += p.pickupItemCount ?? 1 })
      client.on('trade_list', (p: any) => { this.trades = p.trades ?? [] })
      client.on('update_health', (p: any) => {
        this.health = p.health
        this.food = p.food
        if (p.health <= 0) this.onDeath(null)
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
        if (p.isActionBar) return
        const text = extractText(p.content)
        if (text) this.pushChat('system', text, topKey(p.content))
      })
      // 命令树: 服务器按玩家权限过滤后下发, 根节点的字面量子节点就是能用的命令
      client.on('declare_commands', (p: any) => {
        try {
          const root = p.nodes?.[p.rootIndex]
          const names = (root?.children ?? []).map((i: number) => p.nodes[i]).filter((n: any) => n?.flags?.command_node_type === 1).map((n: any) => String(n.extraNodeData?.name))
          this.commands = new Set(names)
        } catch (e: any) { console.warn(`[${this.name}] declare_commands 解析失败: ${e.message}`) }
      })
      // 玩家聊天: 签名消息走 player_chat; 无签名的 (offline 服 / chat_command 发出的 /me /msg、控制台 /say) 走 profileless_chat。
      // 聊天类型 (chat_type 注册表下标) 决定显示格式。
      const typedChat = (typeHolder: any, sender: string, target: string, msg: string, self: boolean) => {
        const type = typeHolder?.chatType !== undefined ? (this.chatTypes[typeHolder.chatType] ?? 'chat') : 'chat'
        const fmt: Record<string, string> = {
          chat: `${sender}: ${msg}`,
          emote_command: `* ${sender} ${msg}`,
          say_command: `[${sender}] ${msg}`,
          msg_command_incoming: `${sender} 悄悄对你说: ${msg}`,
          msg_command_outgoing: `你悄悄对 ${target} 说: ${msg}`,
          team_msg_command_incoming: `[队伍 ${target}] ${sender}: ${msg}`,
          team_msg_command_outgoing: `[队伍 ${target}] 你: ${msg}`,
        }
        this.pushChat('player', fmt[type] ?? `${sender}: ${msg}`, type !== 'chat' ? type : undefined, self)
      }
      client.on('player_chat', (p: any) => {
        const sender = p.networkName ? plain(p.networkName) : (p.senderName ? plain(p.senderName) : '?')
        const msg = p.unsignedChatContent ? extractText(p.unsignedChatContent) : String(p.plainMessage ?? p.content ?? '')
        const self = (typeof p.senderUuid === 'string' && p.senderUuid === client.uuid) || sender === this.name
        typedChat(p.type, sender, p.networkTargetName ? plain(p.networkTargetName) : '', msg, self)
      })
      client.on('profileless_chat', (p: any) => {
        const sender = plain(p.name)
        typedChat(p.type, sender, p.target ? plain(p.target) : '', extractText(p.message), sender === this.name)
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

    // 死亡界面: 不跑物理也不上报移动 (原版客户端此时不发移动包)
    if (this.dead) {
      this.physics.control = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
      // 自动复活: 死后 0.8s 发一次, 没生效每 2s 重试; 死亡期间才打开 autoRespawn 也会立即生效。
      // 死着重新登录时, 紧跟 player_loaded 发的复活请求会被服务器忽略, 故还要求加载完成 0.5s 以上
      if (this.reflex.policy.autoRespawn && now - (this.lastDeath?.at ?? 0) > 800 && now - this.loadedAt > 500 && now - this.respawnSentAt > 2000) this.requestRespawn()
      this.client.write('tick_end', {})
      return
    }

    // 骑乘/睡觉: 位置由服务器决定, 不跑物理也不上报移动
    if (this.vehicleId !== null || this.sleeping) {
      const v = this.vehicleId !== null ? this.world.entities.get(this.vehicleId) : null
      if (v) this.pos = { x: v.x, y: v.y + 0.5, z: v.z }
      this.client.write('tick_end', {})
      return
    }

    // 物理模拟 (动作设置的 control 生效); 饱食度 ≤ 6 不能疾跑 (原版规则)
    this.physics.canSprint = this.food > 6
    this.physics.tick()
    // 疾跑状态变化告诉服务器 (原版在移动包之前发): 服务器据此判定游泳姿态、计算饥饿
    if (this.physics.sprinting !== this.sprintSent) {
      this.sprintSent = this.physics.sprinting
      this.client.write('entity_action', { entityId: this.entityId, actionId: this.sprintSent ? 'start_sprinting' : 'stop_sprinting', jumpBoost: 0 })
    }

    // 朝向变了才带上 yaw/pitch (服务器用朝向决定放置方块的方向等)
    const flags = { onGround: this.onGround, hasHorizontalCollision: false }
    if (this.yaw !== this.lastSentLook.yaw || this.pitch !== this.lastSentLook.pitch) {
      this.lastSentLook = { yaw: this.yaw, pitch: this.pitch }
      this.client.write('position_look', { x: this.pos.x, y: this.pos.y, z: this.pos.z, yaw: this.yaw, pitch: this.pitch, flags })
    } else {
      this.client.write('position', { x: this.pos.x, y: this.pos.y, z: this.pos.z, flags })
    }
    // 紧跟本 tick 的移动包执行 (如松弓: 服务器按此刻的朝向生成箭, 朝向包必须先到)
    if (this.afterTickFns.length) { const fs = this.afterTickFns; this.afterTickFns = []; for (const f of fs) { try { f() } catch (e: any) { console.warn(`[${this.name}] afterTick: ${e.message}`) } } }
    this.client.write('tick_end', {})
  }

  /**
   * login / respawn: 按 worldState 切换维度。维度变了 (或高度不同) 就清空世界模型 (区块/实体) 换新高度,
   * 并取消进行中的动作 (路径/目标坐标都属于旧维度)。同维度复活不清 (服务器不会重发区块之外的东西)。
   */
  private enterDimension (ws: any) {
    const name = String(ws?.name ?? this.dimension)
    const t = this.dimTypes[ws?.dimension] ?? vanillaDim(name)
    const changed = !this.dimEntered || name !== this.dimension || t.minY !== this.world.min_y || t.height !== this.world.world_height
    const travel = this.dimEntered && name !== this.dimension
    const from = this.dimension
    this.dimension = name
    this.dimInfo = t
    this.dimEntered = true
    if (!changed) return
    this.world.resetDimension(t.minY, t.height, t.hasCeiling)
    if (travel) {
      this.cancelActions(`换维度: ${from.replace(/^minecraft:/, '')} → ${name.replace(/^minecraft:/, '')}`)
      const nether = [from, name].includes('minecraft:the_nether') ? ' (下界 1 格 = 主世界 8 格)' : ''
      this.pushChat('system', `[换维度] 进入 ${name.replace(/^minecraft:/, '')} (高度 ${t.minY}..${t.minY + t.height}${t.hasCeiling ? ', 有顶棚' : ''}${t.bedWorks ? '' : ', 床会爆炸'}); 坐标与原维度不通用${nether}`, undefined, false, true)
    }
    this.onEvent?.({ kind: 'conn', level: 'info', text: `维度 ${name} (${t.key}: y ${t.minY}..${t.minY + t.height}${t.hasCeiling ? ', 顶棚' : ''}${t.bedWorks ? '' : ', 床会爆炸'}; ${t.fromRegistry ? '注册表' : '按原版兜底'})` })
  }

  /** 下一个 tick 发完移动包 (含最新朝向) 后立刻执行 fn */
  afterNextTick (fn: () => void): Promise<void> {
    return new Promise(resolve => this.afterTickFns.push(() => { fn(); resolve() }))
  }

  // ---------- 动作系统 ----------

  /** 按类型构造动作 (不启动); 脚本里的子动作也走这里 */
  /** 记下寻路方案 (只留最近 60 个) */
  rememberProposals (ps: RouteProposal[]) {
    const now = Date.now()
    for (const p of ps) if (p.id) this.proposalStore.set(p.id, { p, at: now })
    while (this.proposalStore.size > 60) this.proposalStore.delete(this.proposalStore.keys().next().value!)
  }

  /** confirm 参数 → 批准的改动; 方案不存在/过期则抛错 */
  private approvalFor (confirm: unknown): Approval | undefined {
    if (confirm == null || confirm === '') return undefined
    const ids = (Array.isArray(confirm) ? confirm : String(confirm).split(',')).map(x => String(x).trim()).filter(Boolean)
    const ps = ids.map(id => {
      const e = this.proposalStore.get(id)
      if (!e || Date.now() - e.at > 10 * 60_000) throw new Error(`方案 ${id} 不存在或已过期 (保留 10 分钟): 重新下达动作拿新方案`)
      return e.p
    })
    return ps.length ? approvalOf(ps) : undefined
  }

  /** ctx.script: 脚本里的子动作 (moveTo 默认不限路程, 脚本自己有超时与报告) */
  makeAction (type: string, params: any, ctx: { script?: boolean } = {}): Action {
    const int = (v: any, d?: number) => { const n = Math.floor(Number(v ?? d)); if (!Number.isFinite(n)) throw new Error(`参数缺失或不是数字 (动作 ${type})`); return n }
    const xyz = () => [int(params.x), int(params.y), int(params.z)] as const
    const str = (v: any, what: string) => { if (typeof v !== 'string' || !v) throw new Error(`${type} 需要参数 ${what}`); return v }
    // 寻路改地形的权限: 默认只走现成的路, 走不通时动作失败并给出挖/搭方案, LLM 确认后带上开关重新下达
    const flag = (v: any) => v === true || v === 'true' || v === 1
    // confirm: "<方案id>" = 只批准该方案列出的改动 (比 allow_* 窄)
    const moveOpts = { allowDig: flag(params.allow_dig), allowPlace: flag(params.allow_place), approved: this.approvalFor(params.confirm) }
    // 单次寻路路程上限: LLM 下达的 move_to/go_home 默认 128 格, 可用 max_dist 调 (8~512); 脚本默认不限
    const maxDistance = params.max_dist != null ? Math.max(8, Math.min(512, int(params.max_dist))) : ctx.script ? undefined : MAX_MOVE_DIST
    let a: Action
    switch (type) {
      case 'move_to': a = new MoveToAction(this, { x: +params.x, y: params.y != null ? +params.y : undefined, z: +params.z }, { tolerance: params.tolerance != null ? Math.max(0, int(params.tolerance)) : undefined, ...moveOpts, maxDistance }); break
      // dig / place / open_container: 先走到够得着且看得见的位置再操作 (ReachThen)
      case 'dig': { const [x, y, z] = xyz(); a = new ReachThen(this, 'dig', { x, y, z }, () => new DigAction(this, x, y, z), this.world.getBlock(x, y, z)?.name ?? '方块'); break }
      case 'place': { const [x, y, z] = xyz(); const o = { hotbar: params.hotbar != null ? int(params.hotbar) : undefined, item: params.item }; a = new ReachThen(this, 'place', { x, y, z }, () => new PlaceAction(this, x, y, z, int(params.face, 1), o), '放置点'); break }
      case 'attack': a = new AttackAction(this, int(params.entity_id ?? params.entityId), int(params.hits, 3)); break
      case 'shoot': a = new ShootAction(this, int(params.entity_id ?? params.entityId), Math.max(1, Math.min(64, int(params.shots, 5))), { pickup: params.pickup !== false }); break
      case 'jump': a = new JumpAction(this); break
      case 'stop': a = new StopAction(this); break
      case 'select_slot': a = new SelectSlotAction(this, int(params.slot, 0)); break
      case 'open_container': { const [x, y, z] = xyz(); const blk = containerBlocked(this, x, y, z); if (blk) throw new Error(blk); a = new ReachThen(this, 'open_container', { x, y, z }, () => new OpenContainerAction(this, x, y, z), this.world.getBlock(x, y, z)?.name ?? '容器'); break }
      // 按物品名存取 (item 必填, count 缺省=全部, 可带 x,y,z 一步完成); 只给 slot 时走旧的按槽位 shift 点击
      case 'chest_take': case 'chest_put': {
        const dir = type === 'chest_take' ? 'take' : 'put'
        if (params.item) {
          const at = params.x != null && params.y != null && params.z != null ? { x: int(params.x), y: int(params.y), z: int(params.z) } : undefined
          a = new ChestTransferAction(this, dir, String(params.item), params.count != null ? Math.max(1, int(params.count)) : undefined, at)
        } else if (params.slot != null) a = new ChestOpAction(this, dir, int(params.slot))
        else throw new Error(`${type} 需要 item (物品名), 或旧用法 slot`)
        break
      }
      case 'drop_item': a = new DropItemAction(this, int(params.slot, SLOT.hotbar), !!params.all); break
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
      case 'respawn': a = new RespawnAction(this); break
      case 'go_home': {
        const h = this.reflex.policy.home
        if (!h) throw new Error('还没设置 home (set_policy {home: "here"} 或 {home: {x,y,z}})')
        const hd = homeDimension(h)
        if (hd !== this.dimension) throw new Error(`home 在 ${hd.replace(/^minecraft:/, '')} (${h.x},${h.y},${h.z}), 你现在在 ${this.dimension.replace(/^minecraft:/, '')}: 坐标不通用, 先找传送门回去`)
        a = new MoveToAction(this, h, { tolerance: 1, ...moveOpts, maxDistance }); break
      }
      case 'script': a = new ScriptAction(this, String(params.code ?? ''), { timeoutMs: params.timeoutMs, args: params.args }); break
      default: throw new Error(`未知动作类型: ${type}`)
    }
    if (a instanceof Task) a.moveOpts = moveOpts
    return a
  }

  act (type: string, params: any): Action {
    const a = this.makeAction(type, params)
    if (this.dead && type !== 'respawn') { this.track(a); this.lastAction = a; a.fail(`已死亡 (${this.lastDeath?.cause ?? '?'}), 先 act{type:"respawn"} 复活`); return a }
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

  // ---------- 死亡 / 复活 ----------

  /** 进入死亡状态。death_combat_event 与 update_health≤0 都会调, 先到的建记录, 后到的只补死因。 */
  private onDeath (message: any) {
    const parsed = message != null ? parseDeathMessage(message, this.name) : null
    if (this.dead) {
      // 已记录过 (update_health 先到): 用死亡消息补全死因
      const d = this.lastDeath
      if (d && parsed?.key && Date.now() - d.at < 5000) { d.cause = parsed.text; d.causeKey = parsed.key; d.killer = parsed.killer ?? d.killer }
      return
    }
    this.dead = true
    this.deaths++
    const now = Date.now()
    // 死亡消息为空 (服务器关了 showDeathMessages / update_health 先到): 用最近一次受伤推断
    const dmg = this.lastDamage && now - this.lastDamage.at < 5000 ? this.lastDamage : null
    const attacker = dmg?.attackerId != null ? this.world.entities.get(dmg.attackerId) : null
    const items = this.inventory.summary()
    for (let i = 5; i <= 8; i++) { const s = this.inventory.slots[i]; if (s) items[s.name] = (items[s.name] ?? 0) + s.count } // 盔甲也会掉
    // 还没完成加载就是死的 = 死着重新登录: 位置是出生传送点, 真正的死亡点在 login 包里
    const relog = !this.loadedAt && !parsed?.key && this.loginDeath
    const d: DeathRecord = {
      n: this.deaths, at: now,
      pos: relog ? { x: this.loginDeath!.location.x, y: this.loginDeath!.location.y, z: this.loginDeath!.location.z } : { x: +this.pos.x.toFixed(1), y: +this.pos.y.toFixed(1), z: +this.pos.z.toFixed(1) },
      dimension: (relog ? this.loginDeath!.dimensionName : this.dimension).replace(/^minecraft:/, ''),
      cause: parsed?.key ? parsed.text : (dmg?.sourceName ? `死于 ${dmg.sourceName}${attacker ? ` (来自 ${attacker.type})` : ''}` : relog ? '上线时已处于死亡状态 (死因未知)' : '死因未知'),
      causeKey: parsed?.key ?? dmg?.sourceName ?? '',
      killer: parsed?.killer ?? attacker?.type ?? null,
      items, itemCount: Object.values(items).reduce((a, b) => a + b, 0),
      keptInventory: null, respawnedAt: null,
    }
    this.lastDeath = d
    this.cancelActions(`死亡: ${d.cause}`)
    this.reflex.onDeath(d.cause)
    const at = `${d.pos.x.toFixed(0)},${d.pos.y.toFixed(0)},${d.pos.z.toFixed(0)} (${d.dimension})`
    const auto = this.reflex.policy.autoRespawn
    this.pushChat('system', `[你死了] ${d.cause} @ ${at}` + (auto ? '; 即将自动复活' : '; 用 act{type:"respawn"} 复活'), undefined, false, true)
    // 掉落发生在死亡那一 tick, 背包清空的 set_slot 随后到: 稍等看背包是否被清空 (= 没开 keepInventory)
    setTimeout(() => this.settleDrops(d), 500)
  }

  /** 判定死亡时物品是否掉落 (只判定一次) 并告知 */
  private settleDrops (d: DeathRecord) {
    if (d.keptInventory !== null || this.lastDeath !== d) return
    const left = Object.values(this.inventory.summary()).reduce((a, b) => a + b, 0)
    d.keptInventory = d.itemCount > 0 && left > 0
    const at = `${d.pos.x.toFixed(0)},${d.pos.y.toFixed(0)},${d.pos.z.toFixed(0)}`
    if (d.itemCount && !d.keptInventory) this.pushChat('system', `[掉落] 身上 ${d.itemCount} 个物品掉在死亡点 ${at} (${d.dimension}), 约 5 分钟后消失`)
    else if (d.keptInventory) this.pushChat('system', '[掉落] 物品已保留 (keepInventory)')
    this.onEvent?.({ kind: 'conn', level: 'warn', text: `死亡 #${d.n}: ${d.cause} @ ${at} (${d.dimension})` + (d.itemCount ? (d.keptInventory ? ', 物品保留' : `, 掉落 ${d.itemCount} 个物品`) : '') })
  }

  /** 发送复活请求 (死亡界面点"重生") */
  requestRespawn () {
    if (!this.dead || this.phase !== 'play') return
    this.respawnSentAt = Date.now()
    console.log(`[${this.name}] respawning`)
    this.client.write('client_command', { actionId: 'perform_respawn' })
  }

  private onRespawned () {
    this.dead = false
    this.health = 20
    this.lastDamage = null
    const d = this.lastDeath
    if (!d) return
    d.respawnedAt = Date.now()
    // 等出生点传送到位再报告位置
    setTimeout(() => {
      if (this.lastDeath !== d) return
      this.settleDrops(d)
      const where = `${this.pos.x.toFixed(0)},${this.pos.y.toFixed(0)},${this.pos.z.toFixed(0)}`
      this.pushChat('system', `[已复活] @ ${where}` + (d.itemCount && !d.keptInventory ? `; 物品在死亡点 ${d.pos.x.toFixed(0)},${d.pos.y.toFixed(0)},${d.pos.z.toFixed(0)}` : ''))
      this.onEvent?.({ kind: 'conn', level: 'info', text: `已复活 @ ${where}` })
    }, 1000)
  }

  /** scene 用的死亡信息: 最近 10 分钟内的死亡 */
  deathInfo () {
    const d = this.lastDeath
    if (!d || Date.now() - d.at > 600_000) return null
    const ago = Date.now() - d.at
    const dropsLost = d.itemCount > 0 && d.keptInventory !== true
    return {
      n: d.n, ago_s: Math.round(ago / 1000), at: d.pos, dimension: d.dimension,
      cause: d.cause, ...(d.causeKey ? { cause_key: d.causeKey } : {}), killer: d.killer,
      ...(d.itemCount ? { items_at_death: d.items } : {}),
      ...(dropsLost ? { drops_despawn_in_s: Math.max(0, Math.round((DROP_DESPAWN_MS - ago) / 1000)) } : {}),
      ...(d.keptInventory ? { kept_inventory: true } : {}),
    }
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

  /** important: 需要提醒 agent 的消息 (默认 = 别人发的玩家聊天/私聊; 另有自己死亡) */
  private pushChat (kind: 'system' | 'player', text: string, key?: string, self = false, important = kind === 'player' && !self) {
    const m: ChatMessage = { seq: ++this.chatSeq, kind, text, at: Date.now(), ...(key ? { key } : {}), ...(self ? { self: true } : {}), ...(important ? { important: true } : {}) }
    this.chat.push(m)
    if (this.chat.length > 500) this.chat.splice(0, this.chat.length - 500)
    if (important) { const ws = this.importantWaiters; this.importantWaiters = []; ws.forEach(w => w()) }
  }

  // ---------- 收件箱: 重要消息的已读游标 ----------

  /** agent 已看过的最大 seq (read_chat / wait_event / 被打断的 wait_action 返回过的消息即视为已读) */
  chatReadSeq = 0
  private importantWaiters: Array<() => void> = []

  /** 未读的重要消息 */
  unread (): ChatMessage[] { return this.chat.filter(m => m.important && m.seq > this.chatReadSeq) }

  markRead (seq: number) { if (seq > this.chatReadSeq) this.chatReadSeq = Math.min(seq, this.chatSeq) }

  /** 等到有新的重要消息 (返回 true) 或超时 (false); 已有未读时立即返回 true */
  waitImportant (ms: number): Promise<boolean> {
    if (this.unread().length) return Promise.resolve(true)
    return new Promise(resolve => {
      const w = () => { clearTimeout(t); resolve(true) }
      const t = setTimeout(() => { this.importantWaiters = this.importantWaiters.filter(x => x !== w); resolve(false) }, ms)
      this.importantWaiters.push(w)
    })
  }

  // ---------- 容器 / 库存 ----------

  /** 选快捷栏 0-8 */
  selectSlot (slot: number) {
    this.client.write('held_item_slot', { slotId: slot })
    this.inventory.heldSlot = slot
  }

  /** 右键使用手持物品 (吃/喝/投掷/拉弓; off_hand = 副手, 如举盾) */
  useItem (hand: 'main_hand' | 'off_hand' = 'main_hand') {
    this.client.write('use_item', { hand, sequence: this.nextSequence(), rotation: { x: this.yaw, y: this.pitch } })
  }

  /** 松开使用中的物品 (松弓射箭 / 放下盾) */
  releaseUseItem () {
    this.client.write('block_dig', { status: DIG_STATUS.releaseUse, location: { x: 0, y: 0, z: 0 }, face: 0, sequence: 0 })
    this.usingHand = null
  }

  /** 开始挖方块 (face: 0 下 1 上 2 北 3 南 4 西 5 东) */
  digStart (x: number, y: number, z: number, face: number) {
    this.client.write('block_dig', { status: DIG_STATUS.start, location: { x, y, z }, face, sequence: this.nextSequence() })
  }

  /** 挖够时间后告诉服务器"挖完了" (不要重发 start, 会重置服务器端进度) */
  digFinish (x: number, y: number, z: number, face: number) {
    this.client.write('block_dig', { status: DIG_STATUS.finish, location: { x, y, z }, face, sequence: this.nextSequence() })
  }

  /** 挥主手 (动画; 挖掘/攻击时原版客户端也会发) */
  swing () {
    this.client.write('arm_animation', { hand: 'main_hand' })
  }

  /** 近战攻击实体 (含挥手) */
  attackEntity (entityId: number) {
    this.client.write('attack', { entityId })
    this.swing()
  }

  /** 潜行键 (骑乘时按下 = 下坐骑) */
  setSneakInput (down: boolean) {
    this.client.write('player_input', { inputs: down ? { shift: true } : {} })
  }

  /** 下床 */
  stopSleeping () {
    this.client.write('entity_action', { entityId: this.entityId, actionId: 'stop_sleeping', jumpBoost: 0 })
  }

  /** 交易窗口选第 index 项 (服务器自动把付款物品从背包填进付款格) */
  selectTrade (index: number) {
    this.client.write('select_trade', { slot: index })
  }

  /** 物品组是否在冷却 (如 shield) */
  onCooldown (group: string) { return (this.cooldowns.get(group) ?? 0) > Date.now() }

  /** 右键实体 (交易/喂食/骑乘/剪毛…) */
  interactEntity (entityId: number) {
    this.client.write('use_entity', { target: entityId, hand: 'main_hand', location: { x: 0, y: 0.9, z: 0 }, sneaking: false })
    this.swing()
  }

  /** 左键点击窗口槽位 (拿起/放下整组) */
  clickSlot (windowId: number, slot: number, button = 0, mode = 0) {
    this.client.write('window_click', {
      windowId, stateId: this.inventory.stateId, slot, mouseButton: button, mode,
      changedSlots: [], cursorItem: undefined,
    })
  }

  /** 右键交互方块 (开箱等; 手上需为空或非方块) */
  interactBlock (x: number, y: number, z: number) { this.useOnBlock(x, y, z, 1) }

  /** 手持物对方块某面右键 (手持方块时 = 放置; face 同 digStart) */
  useOnBlock (x: number, y: number, z: number, face: number) {
    this.client.write('block_place', {
      hand: 'main_hand',
      location: { x, y, z },
      direction: face,
      cursorX: 0.5, cursorY: 0.5, cursorZ: 0.5,
      insideBlock: false,
      worldBorderHit: false,
      sequence: this.nextSequence(),
    })
  }

  /** 关窗口 (0 = 玩家背包: 2×2 合成格残留物品退回背包) */
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

  /**
   * 以玩家身份执行命令 (chat_command, 无签名), 收集服务器回给自己的系统消息作为结果。
   * 权限完全由服务器判定 (bot 非 OP 时 /seed 等会被拒)。
   * 等待: 收到第一条回复后再静默 300ms 即返回; 一直没回复则 waitMs 后返回 (很多命令成功时不回消息)。
   */
  async runCommand (command: string, waitMs = 2000) {
    const cmd = command.trim().replace(/^\/+/, '')
    if (!cmd) throw new Error('命令为空')
    if (cmd.length > 256) throw new Error('命令过长 (>256)')
    if (this.phase !== 'play') throw new Error('未在线')
    const before = this.chatSeq
    this.client.write('chat_command', { command: cmd })
    const t0 = Date.now()
    let n = 0, changedAt = t0
    // 回复 = 服务器发给自己的系统消息 + 自己发出的聊天回显 (/me 广播、/msg 的"你悄悄对 X 说")
    const replies = () => this.chat.filter(m => m.seq > before && (m.kind === 'system' ? !/^\[(你死了|掉落|已复活|bot 断开)\]/.test(m.text) : m.self))
    while (Date.now() - t0 < waitMs) {
      await new Promise(r => setTimeout(r, 100))
      const k = replies().length
      if (k !== n) { n = k; changedAt = Date.now() }
      if (n > 0 && Date.now() - changedAt >= 300) break
    }
    const out = replies()
    const root = cmd.split(/\s+/)[0].toLowerCase()
    // 命令树是服务器按权限过滤后下发的: 根命令不在树里 = 不存在或无权限; 在树里却报 unknown = 参数不完整/写错
    const notInTree = this.commands !== null && !this.commands.has(root)
    const parseErr = out.some(m => m.key === 'command.unknown.command' || m.key === 'command.unknown.argument')
    return {
      command: '/' + cmd,
      output: out.map(m => m.text),
      ...(out.length === 0 ? { note: '服务器没有回复 (有的命令成功时不回消息)' } : {}),
      ...(notInTree || (parseErr && this.commands === null)
        ? { error: `/${root} 不存在或没有权限 (权限由服务器决定)`, available_commands: this.commands ? [...this.commands].sort() : '未知 (还没收到命令树)' }
        : parseErr ? { error: `/${root} 参数不完整或有误, 见 output 里 <--[此处] 标出的位置` } : {}),
    }
  }

  readChat (since = 0): ChatMessage[] {
    return this.chat.filter(m => m.seq > since)
  }
}

/** 手动复活 (autoRespawn 关闭时) */
class RespawnAction extends AsyncAction {
  constructor (bot: BotAgent) { super(bot, 'respawn') }
  protected async run () {
    if (!this.bot.dead) return '没有死亡, 无需复活'
    this.bot.requestRespawn()
    await this.until(() => !this.bot.dead, 10_000, '复活')
    return `已复活 @ ${this.bot.pos.x.toFixed(0)},${this.bot.pos.y.toFixed(0)},${this.bot.pos.z.toFixed(0)}`
  }
}

// ---------- 聊天 NBT 文本提取 ----------

const EN_LANG: Record<string, string> = (() => {
  return mcData.language ?? {}
})()

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
  'chat.square_brackets': '[%s]',
  'command.unknown.command': '未知或不完整的命令 (不存在或无权限)',
  'command.unknown.argument': '错误的命令参数',
  'command.context.here': '<--[此处]',
  'command.context.parse_error': '%s 位置 %s: %s',
  'command.expected.separator': '参数后应有空格',
  'command.failed': '执行命令时发生意外错误',
  'permissions.requires.player': '需要玩家执行',
  'commands.seed.success': '种子: %s',
  'commands.list.players': '当前在线 %s/%s 名玩家: %s',
  'commands.time.query': '时间: %s',
  'commands.message.display.outgoing': '你悄悄对 %s 说: %s',
  'commands.message.display.incoming': '%s 悄悄对你说: %s',
}

/** prismarine-nbt 带类型的 NBT → 普通 JS (等价 nbt.simplify; 普通 JSON 原样返回) */
function simplifyNbt (n: any): any {
  if (n == null || typeof n !== 'object' || Array.isArray(n)) return n
  if (typeof n.type === 'string' && 'value' in n) {
    if (n.type === 'compound') return Object.fromEntries(Object.entries(n.value ?? {}).map(([k, v]) => [k, simplifyNbt(v)]))
    if (n.type === 'list') return (n.value?.value ?? []).map((x: any) => simplifyNbt({ type: n.value.type, value: x }))
    return n.value
  }
  return n
}

/** 文本组件 → 纯文本; 翻译键按 TRANSLATE_ZH/DEATH_ZH 模板代入 with 参数, 实体/物品键取 id */
function renderComponent (c: any): string {
  if (c == null) return ''
  if (typeof c === 'string' || typeof c === 'number') return String(c)
  if (Array.isArray(c)) return c.map(renderComponent).join('')
  if (typeof c !== 'object') return ''
  let out = ''
  if (c.text != null) out = String(c.text)
  else if (typeof c.translate === 'string') out = translate(c.translate, (Array.isArray(c.with) ? c.with : []).map(renderComponent), c.fallback)
  else if (c[''] != null) out = String(c['']) // 列表里的纯字符串元素会被包成 {"": ...}
  if (Array.isArray(c.extra)) out += c.extra.map(renderComponent).join('')
  return out
}

function translate (key: string, args: string[], fallback?: string): string {
  const tpl = TRANSLATE_ZH[key] ?? DEATH_ZH[key]
  if (tpl) {
    let i = 0
    return tpl.replace(/%(?:(\d+)\$)?s/g, (_m, n) => args[n ? Number(n) - 1 : i++] ?? '')
  }
  const m = key.match(/^(?:entity|item|block)\.minecraft\.(.+)$/)
  if (m) return m[1]
  const en = EN_LANG[key] // 没有中文模板的键用原版英文模板 (minecraft-data 自带 en_us)
  if (typeof en === 'string') {
    let i = 0
    return en.replace(/%%/g, '\0').replace(/%(?:(\d+)\$)?s/g, (_m: string, n: string) => args[n ? Number(n) - 1 : i++] ?? '').replace(/\0/g, '%')
  }
  if (key.startsWith('death.')) return `${args[0] ?? ''} ${key}${args.length > 1 ? ` (${args.slice(1).join(', ')})` : ''}`
  if (fallback) return fallback
  return args.length ? `${key}(${args.join(', ')})` : key
}

/** 文本组件顶层的翻译键 (无则 undefined) */
function topKey (nbt: any): string | undefined {
  try {
    const c = simplifyNbt(typeof nbt === 'string' && nbt.startsWith('{') ? JSON.parse(nbt) : nbt)
    if (!c || typeof c !== 'object') return undefined
    if (typeof c.translate === 'string') return c.translate
    // 常见包法: {text:"", color, extra:[{translate}]}
    if (!c.text && Array.isArray(c.extra) && typeof c.extra[0]?.translate === 'string') return c.extra[0].translate
    return undefined
  } catch { return undefined }
}

export function extractText (nbt: any): string {
  if (nbt == null) return ''
  if (typeof nbt === 'string') {
    // 登录态的断开原因是 JSON 文本组件字符串 (play 态才是 NBT)
    if (!nbt.startsWith('{') && !nbt.startsWith('[')) return nbt
    try { nbt = JSON.parse(nbt) } catch { return nbt }
  }
  return renderComponent(simplifyNbt(nbt))
}

/** 死亡消息 → { key, 中文句子 (去掉开头的自己名字), 凶手 } */
export function parseDeathMessage (msg: any, selfName: string): { key: string | null, text: string, killer: string | null } {
  const c = simplifyNbt(typeof msg === 'string' && msg.startsWith('{') ? JSON.parse(msg) : msg)
  if (!c || typeof c !== 'object' || typeof c.translate !== 'string') {
    const t = extractText(msg).trim()
    return { key: null, text: t, killer: null }
  }
  const args = Array.isArray(c.with) ? c.with.map(renderComponent) : []
  let text = renderComponent(c).trim()
  if (text.startsWith(selfName)) text = text.slice(selfName.length).trim()
  return { key: c.translate, text, killer: args[1] && args[1] !== selfName ? args[1] : null }
}

/** 原版死亡消息 (%1$s 死者, %2$s 凶手, %3$s 武器) */
const DEATH_ZH: Record<string, string> = {
  'death.attack.generic': '%1$s 死了',
  'death.attack.generic.player': '%1$s 在与 %2$s 战斗时死亡',
  'death.attack.genericKill': '%1$s 被杀死了 (/kill)',
  'death.attack.genericKill.player': '%1$s 在与 %2$s 战斗时被杀死了',
  'death.attack.mob': '%1$s 被 %2$s 杀死了',
  'death.attack.mob.item': '%1$s 被 %2$s 用 %3$s 杀死了',
  'death.attack.player': '%1$s 被 %2$s 杀死了',
  'death.attack.player.item': '%1$s 被 %2$s 用 %3$s 杀死了',
  'death.attack.arrow': '%1$s 被 %2$s 射杀',
  'death.attack.arrow.item': '%1$s 被 %2$s 用 %3$s 射杀',
  'death.attack.trident': '%1$s 被 %2$s 刺穿了',
  'death.attack.thrown': '%1$s 被 %2$s 砸死了',
  'death.attack.fireball': '%1$s 被 %2$s 用火球烧死了',
  'death.attack.sting': '%1$s 被 %2$s 蛰死了',
  'death.attack.explosion': '%1$s 爆炸了',
  'death.attack.explosion.player': '%1$s 被 %2$s 炸死了',
  'death.attack.inFire': '%1$s 在火焰中升天',
  'death.attack.inFire.player': '%1$s 在与 %2$s 战斗时走进了火里',
  'death.attack.onFire': '%1$s 被烧死了',
  'death.attack.onFire.player': '%1$s 在与 %2$s 战斗时被烤得酥脆',
  'death.attack.lava': '%1$s 试图在岩浆里游泳',
  'death.attack.lava.player': '%1$s 为了逃离 %2$s 跳进了岩浆',
  'death.attack.hotFloor': '%1$s 发现了地板是岩浆做的 (岩浆块)',
  'death.attack.drown': '%1$s 淹死了',
  'death.attack.drown.player': '%1$s 在逃离 %2$s 时淹死了',
  'death.attack.fall': '%1$s 落地过猛',
  'death.attack.fall.player': '%1$s 在逃离 %2$s 时落地过猛',
  'death.fell.accident.generic': '%1$s 从高处摔了下来',
  'death.fell.accident.ladder': '%1$s 从梯子上摔了下来',
  'death.fell.accident.vines': '%1$s 从藤蔓上摔了下来',
  'death.fell.accident.scaffolding': '%1$s 从脚手架上摔了下来',
  'death.fell.accident.water': '%1$s 从水里摔了出来',
  'death.fell.killer': '%1$s 注定要摔死',
  'death.fell.assist': '%1$s 被 %2$s 推下摔死',
  'death.attack.outOfWorld': '%1$s 掉出了这个世界',
  'death.attack.starve': '%1$s 饿死了',
  'death.attack.cactus': '%1$s 被仙人掌戳死了',
  'death.attack.sweetBerryBush': '%1$s 被甜浆果丛戳死了',
  'death.attack.inWall': '%1$s 在墙里窒息而亡',
  'death.attack.cramming': '%1$s 被挤扁了',
  'death.attack.magic': '%1$s 被魔法杀死了',
  'death.attack.indirectMagic': '%1$s 被 %2$s 用魔法杀死了',
  'death.attack.wither': '%1$s 凋零了',
  'death.attack.freeze': '%1$s 被冻死了',
  'death.attack.lightningBolt': '%1$s 被闪电击中',
  'death.attack.anvil': '%1$s 被铁砧压扁了',
  'death.attack.fallingBlock': '%1$s 被下落的方块压扁了',
  'death.attack.fallingStalactite': '%1$s 被坠落的钟乳石刺穿了',
  'death.attack.stalagmite': '%1$s 被石笋刺穿了',
  'death.attack.dryout': '%1$s 因脱水而死',
  'death.attack.flyIntoWall': '%1$s 感受到了动能',
  'death.attack.dragonBreath': '%1$s 被龙息烤熟了',
  'death.attack.sonic_boom': '%1$s 被音爆抹除了',
}

function plain (n: any): string {
  const t = extractText(n)
  return t || String(n ?? '?')
}
