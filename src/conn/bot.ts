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
import { Action, MoveToAction, DigAction, PlaceAction, AttackAction, JumpAction, StopAction, SelectSlotAction, OpenContainerAction, ChestOpAction, CraftPlanksAction, DropItemAction, CloseWindowAction } from '../actions/actions.js'
import type { ChatMessage } from './types.js'

export interface BotOptions {
  host: string
  port: number
  username: string
}

export type BotPhase = 'connecting' | 'configuration' | 'play' | 'ended'

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

  world = new World()
  inventory = new Inventory()
  physics = new PhysicsRunner(this.world as any, this)
  chat: ChatMessage[] = []
  actions = new Map<number, Action>()
  private primaryAction: Action | null = null
  private chatSeq = 0
  private tickTimer: NodeJS.Timeout | null = null
  private lastPosSentAt = 0

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
      const fail = (e: any) => { if (this.phase !== 'play') reject(e) }
      client.on('error', fail)

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
        this.world.setLoginInfo(packet)
        // 26.x: 原版客户端加载完成后发 player_loaded, 服务器可能以此放行交互
        if (!process.env.MC_NO_PLAYER_LOADED) { try { client.write('player_loaded', {}) } catch (e: any) { console.warn(`[${this.name}] player_loaded 发送失败: ${e.message}`) } }
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
        resolve()
      })
      client.on('position', (packet: any) => this.handleTeleport(packet))
      client.on('update_health', (p: any) => {
        this.health = p.health
        this.food = p.food
        // 死亡自动复活 (否则卡死亡界面, 世界数据不再加载)
        if (p.health <= 0) {
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
        const d = p.delta ?? p.d
        if (!d) return
        let dx = 0, dy = 0, dz = 0
        for (const s of d.steps ?? []) { dx += s.dX; dy += s.dY; dz += s.dZ }
        this.world.trackMove(p.entityId, dx, dy, dz)
      }
      client.on('rel_entity_move', applyDelta)
      client.on('entity_move_look', applyDelta)
      client.on('sync_entity_position', (p: any) => this.world.trackTeleport(p.entityId, p.x, p.y, p.z))
      client.on('entity_teleport', (p: any) => this.world.trackTeleport(p.entityId, p.x, p.y, p.z))
      client.on('entity_destroy', (p: any) => this.world.trackDestroy(p.entityIds ?? p.destroyedEntityIds ?? []))

      // 库存/容器
      client.on('window_items', (p: any) => this.inventory.handleWindowItems(p))
      client.on('set_slot', (p: any) => this.inventory.handleSetSlot(p))
      client.on('open_window', (p: any) => this.inventory.handleOpenWindow(p))

      // 聊天
      client.on('system_chat', (p: any) => {
        const text = extractText(p.content)
        if (text) this.pushChat('system', text)
      })
      client.on('player_chat', (p: any) => {
        const sender = p.senderName ? plain(p.senderName) : (p.sender ?? '?')
        this.pushChat('player', `${sender}: ${p.plainMessage ?? p.content ?? ''}`)
      })

      client.on('end', (reason: any) => {
        this.phase = 'ended'
        this.stopTicker()
        this.pushChat('system', `[bot 断开] ${String(reason).slice(0, 200)}`)
      })
    })
  }

  disconnect () {
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
    this.lastPosSentAt = now

    // 驱动动作
    for (const a of this.actions.values()) {
      if (a.status === 'running') {
        try { a.step(now) } catch (e: any) { a.fail(`动作异常: ${e.message}`) }
      }
    }

    // 物理模拟 (动作设置的 control 生效)
    this.physics.tick()

    this.client.write('position', {
      x: this.pos.x, y: this.pos.y, z: this.pos.z,
      flags: { onGround: this.onGround, hasHorizontalCollision: false },
    })
    this.client.write('tick_end', {})
  }

  // ---------- 动作系统 ----------

  act (type: string, params: any): Action {
    let a: Action
    switch (type) {
      case 'move_to': a = new MoveToAction(this, { x: +params.x, y: params.y != null ? +params.y : undefined, z: +params.z }); break
      case 'dig': a = new DigAction(this, Math.floor(Number(params.x)), Math.floor(Number(params.y)), Math.floor(Number(params.z))); break
      case 'place': a = new PlaceAction(this, Math.floor(Number(params.x)), Math.floor(Number(params.y)), Math.floor(Number(params.z)), Math.floor(+(params.face ?? 1)), Math.floor(Number(params.hotbar ?? 0))); break
      case 'attack': a = new AttackAction(this, Math.floor(Number(params.entity_id ?? params.entityId)), Math.floor(Number(params.hits ?? 3))); break
      case 'jump': a = new JumpAction(this); break
      case 'stop': a = new StopAction(this); break
      case 'select_slot': a = new SelectSlotAction(this, Math.floor(Number(params.slot ?? 0))); break
      case 'open_container': a = new OpenContainerAction(this, Math.floor(Number(params.x)), Math.floor(Number(params.y)), Math.floor(Number(params.z))); break
      case 'chest_take': a = new ChestOpAction(this, 'take', Math.floor(Number(params.slot ?? 0))); break
      case 'chest_put': a = new ChestOpAction(this, 'put', Math.floor(Number(params.slot ?? 0))); break
      case 'craft_planks': a = new CraftPlanksAction(this); break
      case 'drop_item': a = new DropItemAction(this, Math.floor(Number(params.slot ?? 36)), !!params.all); break
      case 'close_window': a = new CloseWindowAction(this); break
      default: throw new Error(`未知动作类型: ${type} (可用: move_to/dig/place/attack/jump/stop)`)
    }
    // 主动作互斥: 新主动作取消旧主动作 (库存类动作不参与互斥)
    const isPrimary = a instanceof MoveToAction || a instanceof DigAction || a instanceof PlaceAction || a instanceof AttackAction || a instanceof JumpAction || a instanceof StopAction
    if (isPrimary) {
      if (this.primaryAction && this.primaryAction.status === 'running') this.primaryAction.cancel()
      this.primaryAction = a
    }
    this.actions.set(a.id, a)
    if (this.actions.size > 50) {
      for (const [id, x] of this.actions) { if (x.status !== 'running') this.actions.delete(id); if (this.actions.size <= 50) break }
    }
    a.start()
    return a
  }

  cancelActions () {
    for (const a of this.actions.values()) if (a.status === 'running') a.cancel()
    this.primaryAction = null
  }

  getAction (id: number) { return this.actions.get(id) }
  get activeAction () { return this.primaryAction }

  private pushChat (kind: 'system' | 'player', text: string) {
    this.chat.push({ seq: ++this.chatSeq, kind, text, at: Date.now() })
    if (this.chat.length > 500) this.chat.splice(0, this.chat.length - 500)
  }

  // ---------- 容器 / 库存 ----------

  private seqCounter = 100

  selectSlot (slot: number) {
    this.client.write('held_item_slot', { slotId: slot })
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
      sequence: ++this.seqCounter,
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

  look (yawDeg: number, pitchDeg: number) {
    this.yaw = yawDeg
    this.pitch = pitchDeg
    this.client.write('position_look', {
      x: this.pos.x, y: this.pos.y, z: this.pos.z,
      yaw: this.yaw, pitch: this.pitch,
      flags: { onGround: this.onGround, hasHorizontalCollision: false },
    })
    this.client.write('tick_end', {})
  }

  readChat (since = 0): ChatMessage[] {
    return this.chat.filter(m => m.seq > since)
  }
}

// ---------- 聊天 NBT 文本提取 ----------

export function extractText (nbt: any): string {
  if (nbt == null) return ''
  if (typeof nbt === 'string') return nbt
  const out: string[] = []
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return
    const v = node.value ?? node
    if (typeof v.text === 'string') out.push(v.text)
    else if (node.type === 'string' && typeof node.value === 'string') out.push(node.value)
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
