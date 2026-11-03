/**
 * 单一服务: MCP(StreamableHTTP /mcp) + REST 调试路由 + WebUI(/webui) + /webui-api 运维接口。
 * token 即角色: admin token 管全部; agent token 自动绑定对应角色(掉线自动重连, 被禁用时除外)。
 * WebUI 与 /webui-api 暂不做鉴权 (服务只绑 127.0.0.1)。
 * 入口: npm run bot
 */
import http from 'node:http'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { MC_AGENT_HOME } from '../paths.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { BotAgent } from '../conn/bot.js'
import { renderView, renderMap, pngBuffer, lookAtBlock } from '../vision/render.js'
import { DEFAULT_POLICY, type Policy } from '../conn/reflex.js'
import { isHostile, isNight } from '../game/knowledge.js'
import { TokenStore, maskToken, type Role } from './tokens.js'
import { OpLog } from './oplog.js'

const HOST = process.env.MC_HOST || '127.0.0.1'
const PORT = Number(process.env.MC_PORT || 25565)
const API_PORT = Number(process.env.API_PORT || 8767)
/** API/WebUI 监听地址: 默认仅本机; 0.0.0.0 = 对外 (webui-api 无鉴权, 慎暴露公网) */
const API_HOST = process.env.API_HOST || '127.0.0.1'

const tokens = new TokenStore()

// ---------- 反射策略 (按角色持久化, 重连后沿用) ----------

const POLICY_FILE = join(MC_AGENT_HOME, 'policies.json')
const policies: Record<string, Policy> = existsSync(POLICY_FILE) ? JSON.parse(readFileSync(POLICY_FILE, 'utf8')) : {}
const policyOf = (name: string): Policy => ({ ...DEFAULT_POLICY, ...(policies[name] ?? {}) })
function savePolicy (name: string, p: Policy) {
  policies[name] = p
  writeFileSync(POLICY_FILE, JSON.stringify(policies, null, 2) + '\n')
}
const oplog = new OpLog()
oplog.restore(tokens.names())

// ---------- agent 管理 ----------

class AgentManager {
  agents = new Map<string, BotAgent>()
  /** 正在连接中的角色: 并发 ensure 共用同一个 Promise, 避免拿到未登录完成的 bot */
  private pending = new Map<string, Promise<BotAgent>>()

  ensure (name: string): Promise<BotAgent> {
    const existing = this.agents.get(name)
    if (existing && existing.phase === 'play') return Promise.resolve(existing)
    const p = this.pending.get(name)
    if (p) return p
    if (!tokens.has(name)) return Promise.reject(new Error(`未知角色 ${name} (可用: ${tokens.names().join(' / ')})`))
    if (tokens.isDisabled(name)) return Promise.reject(new Error(`角色 ${name} 已被管理员禁止上线`))
    const connecting = this.connect(name).finally(() => this.pending.delete(name))
    this.pending.set(name, connecting)
    return connecting
  }

  private async connect (name: string): Promise<BotAgent> {
    const bot = new BotAgent({ host: HOST, port: PORT, username: name })
    bot.reflex.policy = policyOf(name)
    bot.onEvent = (e) => {
      if (e.kind === 'conn') {
        oplog.add(name, 'conn', e.text, undefined, e.level)
        return
      }
      if (e.kind === 'reflex') {
        oplog.add(name, 'reflex', e.text, undefined, /失败|逃|迎战|危险|岩浆|着火/.test(e.text) ? 'warn' : 'info')
        return
      }
      const a = e.action
      const level = a.status === 'failed' ? 'warn' : 'info'
      const label = { done: '完成', failed: '失败', cancelled: '取消', running: '进行中' }[a.status]
      oplog.add(name, 'action', `动作 #${a.id} ${a.type} ${label}${a.detail ? ': ' + a.detail : ''}`,
        { actionId: a.id, type: a.type, status: a.status, ms: Date.now() - a.createdAt }, level)
    }
    try {
      await bot.connect()
      // 等服务器下发首个位置 (避免刚上线时读到 0,0,0)
      const t0 = Date.now()
      while ((bot.pos.x === 0 && bot.pos.y === 0) && Date.now() - t0 < 5000) {
        await new Promise(ok => setTimeout(ok, 200))
      }
    } catch (e: any) {
      oplog.add(name, 'conn', `上线失败: ${e.message}`, undefined, 'error')
      throw e
    }
    this.agents.set(name, bot)
    oplog.add(name, 'conn', `上线 @ ${bot.pos.x.toFixed(1)},${bot.pos.y.toFixed(1)},${bot.pos.z.toFixed(1)}`)
    return bot
  }

  /** 下线; 返回是否原本在线 */
  kill (name: string, by = '手动'): boolean {
    const bot = this.agents.get(name)
    this.agents.delete(name)
    if (!bot || bot.phase === 'ended') return false
    bot.disconnect()
    oplog.add(name, 'conn', `下线 (${by})`)
    return true
  }

  isOnline (name: string) { return this.agents.get(name)?.phase === 'play' }
  isConnecting (name: string) { return this.pending.has(name) }

  list () {
    return [...this.agents.values()].map(b => ({
      name: b.name, phase: b.phase,
      position: { x: +b.pos.x.toFixed(1), y: +b.pos.y.toFixed(1), z: +b.pos.z.toFixed(1) },
      health: +b.health.toFixed(1),
      ...(b.dead ? { dead: true } : {}),
      deaths: b.deaths,
    }))
  }
}

const manager = new AgentManager()

// ---------- 场景/渲染 ----------

function scene (bot: BotAgent) {
  const eye = { x: bot.pos.x, y: bot.pos.y + 1.62, z: bot.pos.z }
  const looking = lookAtBlock(bot.world, eye, bot.yaw, bot.pitch)
  const nearby = bot.world.nearbyEntities(bot.pos.x, bot.pos.y, bot.pos.z, 24)
    .map(e => {
      const d = Math.hypot(e.x - bot.pos.x, e.y - bot.pos.y, e.z - bot.pos.z)
      const planar = Math.hypot(e.x - bot.pos.x, e.z - bot.pos.z)
      const bearing = (Math.atan2(-(e.x - bot.pos.x), e.z - bot.pos.z) * 180 / Math.PI + 360) % 360
      return { id: e.id, type: e.type, ...(e.item ? { item: `${e.item}×${e.itemCount ?? 1}` } : {}), ...(isHostile(e.type) ? { hostile: true } : {}), x: +e.x.toFixed(1), y: +e.y.toFixed(1), z: +e.z.toFixed(1), distance: +d.toFixed(1), bearing: Math.round(bearing), elevation: planar > 0.1 ? Math.round(Math.atan2(e.y - bot.pos.y, planar) * 180 / Math.PI) : 0 }
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 20)
  const below = bot.world.getBlock(Math.floor(bot.pos.x), Math.floor(bot.pos.y) - 1, Math.floor(bot.pos.z))
  return {
    agent: bot.name,
    phase: bot.phase,
    position: { x: +bot.pos.x.toFixed(2), y: +bot.pos.y.toFixed(2), z: +bot.pos.z.toFixed(2) },
    facing: { yaw: Math.round(bot.yaw), pitch: Math.round(bot.pitch) },
    health: +bot.health.toFixed(1),
    food: bot.food,
    ...(bot.dead ? { dead: true } : {}),
    deaths: bot.deaths,
    ...(bot.deathInfo() ? { last_death: bot.deathInfo() } : {}),
    held: bot.inventory.held() ? `${bot.inventory.held()!.name}×${bot.inventory.held()!.count}` : null,
    time: { day_time: bot.dayTime, night: isNight(bot.dayTime) },
    ...(bot.sleeping ? { sleeping: true } : {}),
    ...(bot.vehicleId !== null ? { riding: bot.vehicleId } : {}),
    ...(bot.air < 300 ? { air: bot.air } : {}),
    ...(bot.onFire ? { on_fire: true } : {}),
    inventory: bot.inventory.summary(),
    reflex: bot.reflex.status(),
    standing_on: below?.name ?? '未知(chunk未加载)',
    looking_at: looking ? { block: looking.name, x: looking.x, y: looking.y, z: looking.z, distance: +looking.dist.toFixed(1) } : null,
    nearby_entities: nearby,
    world: { chunks_loaded: bot.world.chunkCount },
  }
}

// ---------- MCP 工具 ----------

const tool = (name: string, description: string, props: Record<string, any>, required: string[] = []): Tool => ({
  name, description,
  inputSchema: { type: 'object' as const, properties: props, required },
})

const TOOLS: Tool[] = [
  tool('list_agents', '列出全部角色及在线状态 (多 agent 协作感知)', {}),
  tool('spawn_agent', '[admin] 上线指定角色', { name: { type: 'string', description: '角色名 (见 WebUI / tokens.json)' } }, ['name']),
  tool('kill_agent', '角色下线 (agent token = 自己下线; admin 可指定)', { name: { type: 'string' } }),
  tool('get_scene', '场景: 位置/朝向/血量/脚下方块/准星指向/附近实体(id/类型/方位/距离)', { name: { type: 'string', description: '[admin]角色名' } }),
  tool('get_view', '第一人称合成视觉 PNG (含实体叠加: 红=敌对 蓝=动物 黄=掉落物)', { name: { type: 'string', description: '[admin]角色名' }, width: { type: 'number' }, height: { type: 'number' }, fov: { type: 'number', description: '水平FOV度' } }),
  tool('get_map', '顶视地图 PNG (红点=自己, 实体色点)', { name: { type: 'string', description: '[admin]角色名' }, radius: { type: 'number' }, scale: { type: 'number' } }),
  tool('read_chat', '读聊天消息 (seq 递增可增量拉取)', { name: { type: 'string', description: '[admin]角色名' }, since: { type: 'number' } }),
  tool('say', '游戏内聊天发言 (不执行命令)', { name: { type: 'string', description: '[admin]角色名' }, text: { type: 'string' } }, ['text']),
  tool('run_command', '以本角色身份执行服务器命令 (如 /seed /list /msg; 可加可不加 "/")。权限由服务器决定 (bot 不是 OP 时管理命令会被拒, 结果里附可用命令列表)。返回服务器回给你的消息', {
    name: { type: 'string', description: '[admin]角色名' }, command: { type: 'string' }, waitMs: { type: 'number', description: '等回复的最长毫秒数, 默认 2000' },
  }, ['command']),
  tool('look', '转向 (yaw: 0=南 90=西 180=北 -90=东; pitch: 90=正下 -90=正上)', { name: { type: 'string', description: '[admin]角色名' }, yaw: { type: 'number' }, pitch: { type: 'number' } }),
  tool('act', `执行动作 (异步, 返回 actionId, 用 wait_action 等结果; 新的主动作会取消正在进行的主动作):
移动: move_to{x,z,y?,tolerance?} (自动开门/爬梯/游泳/垫方块/搭桥/挖穿, 远距离分段) | go_home | jump | stop
采集: collect{block,count?,radius?} (找→走过去→用最佳工具挖→捡掉落物) | dig{x,y,z} | pickup_items{radius?}
建造: place{x,y,z,item?|hotbar?,face?}
合成: craft{item,count?} (任意配方; 3×3 自动找/放工作台) | smelt{item,count?,fuel?} (自动找/放熔炉)
物品: equip{item} (工具→手上, 盔甲→身上, 盾→副手) | eat{item?} | use_item{item?,hold_ms?} | select_slot{slot 0-8} | drop_item{slot,all}
交互: use_block{x,y,z,item?} (门/拉杆/按钮等) | sleep{x?,y?,z?} | wake | interact_entity{entity_id,item?} (喂食繁殖/剪毛/骑乘) | dismount | trade{entity_id,index?,times?} (不给 index 返回交易列表)
战斗: attack{entity_id,hits?} (自动换最好的武器)
容器: open_container{x,y,z} | chest_take{slot} | chest_put{slot} | close_window
死亡: 死亡时所有动作以"死亡: 死因"取消, scene.last_death 给出死因/地点/掉落物剩余时间, 聊天里也有提示; respawn (仅 autoRespawn=false 时需要)`, {
    name: { type: 'string', description: '[admin]角色名' },
    type: { type: 'string', enum: ['move_to', 'go_home', 'jump', 'stop', 'collect', 'dig', 'pickup_items', 'place', 'craft', 'smelt', 'equip', 'eat', 'use_item', 'select_slot', 'drop_item', 'use_block', 'sleep', 'wake', 'interact_entity', 'mount', 'dismount', 'trade', 'attack', 'open_container', 'chest_take', 'chest_put', 'close_window', 'respawn', 'craft_planks'] },
    x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, face: { type: 'number' }, tolerance: { type: 'number', description: 'move_to 到达容差, 0=精确' },
    item: { type: 'string', description: '物品名, 如 oak_planks / wooden_pickaxe / bread' }, block: { type: 'string', description: '方块名, 如 oak_log / stone / iron_ore' },
    count: { type: 'number' }, radius: { type: 'number' }, fuel: { type: 'string' },
    entity_id: { type: 'number' }, hits: { type: 'number' }, hotbar: { type: 'number' }, slot: { type: 'number' }, all: { type: 'boolean' },
    index: { type: 'number', description: 'trade 的交易序号' }, times: { type: 'number' }, hold_ms: { type: 'number' },
  }, ['type']),
  tool('set_policy', `设置反射策略 (bot 自主执行, 不等你决策; 只传要改的字段):
autoEat(bool) 自动进食 | eatAt(饱食度阈值, 默认 14) | combat: defend(还击, 默认)/flee(见怪就跑)/ignore | fleeHealth(血量低于此值逃跑, 默认 8)
avoidHazards(bool) 逃离岩浆/火/溺水 | nightShelter(bool) 天黑空闲时回家睡觉 | home: "here" 或 {x,y,z} 或 null
autoRespawn(bool) 死亡后自动复活 (默认 true; false 则停在死亡界面等 act respawn)`, {
    name: { type: 'string', description: '[admin]角色名' },
    autoEat: { type: 'boolean' }, eatAt: { type: 'number' }, combat: { type: 'string', enum: ['defend', 'flee', 'ignore'] }, fleeHealth: { type: 'number' },
    avoidHazards: { type: 'boolean' }, nightShelter: { type: 'boolean' }, autoRespawn: { type: 'boolean' }, home: { description: '"here" | {x,y,z} | null' },
  }),
  tool('wait_action', '等待动作完成', { name: { type: 'string', description: '[admin]角色名' }, actionId: { type: 'number' }, timeoutMs: { type: 'number' } }),
  tool('get_block', '查询方块 (x,y,z) + 该列最高方块', { name: { type: 'string', description: '[admin]角色名' }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, ['x', 'y', 'z']),
  tool('find_block', '在已加载区块中查找方块 (如 oak_log/chest), 返回最近的 5 个', { name: { type: 'string', description: '[admin]角色名' }, block: { type: 'string' }, radius: { type: 'number' } }, ['block']),
  tool('list_inventory', '库存 (9-35背包 36-44快捷栏)', { name: { type: 'string', description: '[admin]角色名' } }),
  tool('get_container', '当前打开容器的槽位内容', { name: { type: 'string', description: '[admin]角色名' } }),
]

/** 按角色过滤工具列表: agent token 隐藏 spawn_agent、去掉无意义的 name 参数 (token 已绑定自身);
 *  kill_agent 语义换成"主动下线歇一会儿"。 */
function toolsFor (role: Role): Tool[] {
  if (role.kind === 'admin') return TOOLS
  return TOOLS
    .filter(t => t.name !== 'spawn_agent')
    .map(t => {
      if (t.name === 'kill_agent') return { ...t, description: '主动下线歇一会儿 (角色与 token 都保留; 下次任何调用会自动重连上线)' }
      const props = { ...t.inputSchema.properties }
      delete props.name
      return { ...t, inputSchema: { ...t.inputSchema, properties: props } }
    })
}

function txt (t: string) { return { content: [{ type: 'text' as const, text: t }] } }
function img (buf: Buffer) { return { content: [{ type: 'image' as const, data: buf.toString('base64'), mimeType: 'image/png' }] } }

/** 解析工具的目标角色: agent token 固定自身; admin 必须显式传 name */
async function resolveAgent (role: Role, args: any): Promise<BotAgent> {
  if (role.kind === 'agent') return manager.ensure(role.name) // 掉线自动重连
  const name = String(args.name ?? '')
  if (!name) throw new Error('admin token 须传 name 指定角色')
  return manager.ensure(name)
}

async function handleTool (role: Role, toolName: string, args: any): Promise<any> {
  // 不需要在线角色的工具
  if (toolName === 'list_agents') return txt(JSON.stringify(manager.list()))
  if (toolName === 'spawn_agent') {
    if (role.kind !== 'admin') return txt('仅 admin 可指定角色上线')
    const b = await manager.ensure(String(args.name))
    return txt(JSON.stringify({ ok: true, name: b.name, phase: b.phase }))
  }
  if (toolName === 'kill_agent') {
    const name = role.kind === 'agent' ? role.name : String(args.name ?? '')
    if (!name) return txt('admin 须传 name')
    const was = manager.kill(name, role.kind === 'agent' ? '自行下线' : 'admin')
    return txt(JSON.stringify({ ok: true, offline: name, wasOnline: was }))
  }

  const bot = await resolveAgent(role, args)
  switch (toolName) {
    case 'get_scene': return txt(JSON.stringify(scene(bot), null, 2))
    case 'get_view': {
      const png = renderView(bot.world, { x: bot.pos.x, y: bot.pos.y + 1.62, z: bot.pos.z }, bot.yaw, bot.pitch, {
        width: Number(args.width ?? 160), height: Number(args.height ?? 90), fovDeg: Number(args.fov ?? 70),
        entities: bot.world.nearbyEntities(bot.pos.x, bot.pos.y, bot.pos.z, 40)
          .map(e => ({ x: e.x, y: e.y, z: e.z, type: e.type, hostile: isHostile(e.type) })),
      })
      return img(await pngBuffer(png))
    }
    case 'get_map': {
      const png = renderMap(bot.world, { x: bot.pos.x, z: bot.pos.z }, {
        radius: Number(args.radius ?? 32), scale: Number(args.scale ?? 4),
        entities: bot.world.nearbyEntities(bot.pos.x, bot.pos.y, bot.pos.z, 64).map(e => ({ x: e.x, z: e.z, color: entityColor(e.type) })),
        self: { x: bot.pos.x, z: bot.pos.z },
      })
      return img(await pngBuffer(png))
    }
    case 'read_chat': return txt(JSON.stringify(bot.readChat(Number(args.since ?? 0))))
    case 'say': {
      const t = String(args.text ?? '')
      if (t.startsWith('/')) return txt(JSON.stringify({ ok: false, error: 'say 只发聊天, 执行命令请用 run_command' }))
      bot.say(t.slice(0, 256)); return txt(JSON.stringify({ ok: true }))
    }
    case 'run_command': return txt(JSON.stringify(await bot.runCommand(String(args.command ?? ''), Math.max(300, Math.min(10_000, Number(args.waitMs ?? 2000)))), null, 1))
    case 'set_policy': {
      const p: any = { ...bot.reflex.policy }
      for (const k of ['autoEat', 'avoidHazards', 'nightShelter', 'autoRespawn']) if (typeof args[k] === 'boolean') p[k] = args[k]
      for (const k of ['eatAt', 'fleeHealth']) if (args[k] !== undefined && Number.isFinite(Number(args[k]))) p[k] = Math.max(0, Math.min(20, Number(args[k])))
      if (['defend', 'flee', 'ignore'].includes(args.combat)) p.combat = args.combat
      if (args.home === 'here') p.home = { x: Math.floor(bot.pos.x), y: Math.floor(bot.pos.y), z: Math.floor(bot.pos.z) }
      else if (args.home === null) p.home = null
      else if (args.home && typeof args.home === 'object') p.home = { x: Math.floor(Number(args.home.x)), y: Math.floor(Number(args.home.y)), z: Math.floor(Number(args.home.z)) }
      bot.reflex.policy = p
      savePolicy(bot.name, p)
      return txt(JSON.stringify({ ok: true, policy: p }))
    }
    case 'look': bot.look(Number(args.yaw ?? bot.yaw), Number(args.pitch ?? bot.pitch)); return txt(JSON.stringify({ ok: true }))
    case 'act': {
      const { name: _n, ...body } = args
      const a = bot.act(String(args.type), body)
      return txt(JSON.stringify({ actionId: a.id, type: a.type, status: a.status, detail: a.detail }))
    }
    case 'wait_action': {
      const timeoutMs = Math.min(180_000, Number(args.timeoutMs ?? 30_000))
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const a = args.actionId ? bot.getAction(Number(args.actionId)) : bot.latestAction
        if (!a || a.status !== 'running') return txt(JSON.stringify(a ? { actionId: a.id, type: a.type, status: a.status, detail: a.detail } : { action: null }))
        await new Promise(ok => setTimeout(ok, 400))
      }
      return txt(JSON.stringify({ timeout: true }))
    }
    case 'get_block': {
      const x = Math.floor(Number(args.x)), y = Math.floor(Number(args.y)), z = Math.floor(Number(args.z))
      const b = bot.world.getBlock(x, y, z)
      return txt(JSON.stringify({ x, y, z, block: b?.name ?? null, stateId: b?.stateId ?? null, highest: bot.world.highestBlockY(x, z) }))
    }
    case 'find_block': {
      const hits = bot.world.findBlock(String(args.block ?? ''), Math.floor(bot.pos.x), Math.floor(bot.pos.z), Math.min(128, Number(args.radius ?? 48)), 5, Math.floor(bot.pos.y))
      return txt(JSON.stringify({ block: args.block, hits: hits.map(h => ({ ...h, distance: +Math.hypot(h.x - bot.pos.x, h.y - bot.pos.y, h.z - bot.pos.z).toFixed(1) })) }))
    }
    case 'list_inventory': return txt(JSON.stringify({ stateId: bot.inventory.stateId, cursor: bot.inventory.cursor, items: bot.inventory.list() }))
    case 'get_container': {
      const wid = bot.inventory.activeWindowId
      if (wid === null) return txt(JSON.stringify({ open: false }))
      const w = bot.inventory.windows.get(wid)
      return txt(JSON.stringify({ open: true, windowId: wid, slots: (w?.slots ?? []).map((s: any, i: number) => s ? { slot: i, name: s.name, count: s.count } : null).filter(Boolean) }))
    }
    default: return txt(`未知工具: ${toolName}`)
  }
}

// ---------- 操作日志 ----------

/** 只读查询类工具: 日志里标为 query, WebUI 默认折叠 */
const QUERY_TOOLS = new Set(['list_agents', 'get_scene', 'get_view', 'get_map', 'read_chat', 'wait_action', 'get_block', 'find_block', 'list_inventory', 'get_container'])

function summarize (r: any): string {
  const c = r?.content?.[0]
  if (!c) return ''
  if (c.type === 'image') return `[PNG ${Math.round(c.data.length * 3 / 4 / 1024)}KB]`
  return String(c.text ?? '').replace(/\s+/g, ' ').slice(0, 300)
}

function argsText (args: any): string {
  const { name: _n, ...rest } = args ?? {}
  const t = Object.keys(rest).length ? JSON.stringify(rest) : ''
  return t.length > 200 ? t.slice(0, 200) + '…' : t
}

/** 记录一次工具调用 (MCP 或 REST); 无目标角色的调用 (如 admin list_agents) 不记 */
function logCall (role: Role, via: 'mcp' | 'rest', tool: string, args: any, ms: number, result?: any, error?: string) {
  const agent = role.kind === 'agent' ? role.name : String(args?.name ?? '')
  if (!agent || !tokens.has(agent)) return
  const failed = error !== undefined || result?.isError
  oplog.add(agent, QUERY_TOOLS.has(tool) ? 'query' : 'tool',
    `${tool}${argsText(args) ? ' ' + argsText(args) : ''} → ${error !== undefined ? '错误: ' + error : summarize(result)}`,
    { tool, via, by: role.kind, ms }, failed ? 'warn' : 'info')
}

function entityColor (type: string): string {
  if (/(zombie|skeleton|creeper|spider|witch|enderman|phantom|slime|drowned|husk|stray|pillager|vindicator)/.test(type)) return 'ff3b30'
  if (/(cow|pig|sheep|chicken|horse|wolf|cat|dog|villager|rabbit|fox|bee|goat|frog|camel|sniffer|allay)/.test(type)) return '30b0ff'
  return 'ffcc00'
}

// ---------- HTTP 服务 ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${API_PORT}`)
  const token = req.headers['x-token'] as string | undefined
    ?? (typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined)
  const role = tokens.auth(token)

  try {
    // ---- MCP StreamableHTTP ----
    if (url.pathname === '/mcp') {
      if (!role) return json(res, 401, { error: 'invalid token' })
      return await handleMcpRequest(role, req, res)
    }

    // ---- WebUI 页面 (静态) ----
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/webui' || url.pathname === '/webui/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(WEBUI_HTML)
    }

    // ---- webui-api: 运维接口 (暂无鉴权, 服务只绑 127.0.0.1) ----
    if (url.pathname.startsWith('/webui-api/')) {
      return await handleWebuiApi(req, res, url)
    }

    // ---- REST 调试路由 (同 token 语义) ----
    if (url.pathname === '/tokens' && role?.kind === 'admin') {
      return json(res, 200, tokens.raw())
    }
    const parts = url.pathname.split('/').filter(Boolean)

    if (req.method === 'GET' && url.pathname === '/agents') {
      if (!role) return json(res, 401, { error: 'bad token' })
      return json(res, 200, manager.list())
    }
    if (parts[0] === 'agents') {
      if (!role) return json(res, 401, { error: 'bad token' })
      const target = role.kind === 'agent' ? role.name : parts[1]
      if (!target) return json(res, 400, { error: 'admin 须指定角色名' })
      const action = role.kind === 'agent' ? parts[1] : parts[2]
      // 下线必须在 ensure 之前 (否则会先把离线角色拉上线再踢掉)
      if (req.method === 'DELETE') { const was = manager.kill(target, role.kind === 'agent' ? '自行下线' : 'admin'); return json(res, 200, { ok: true, wasOnline: was }) }
      const bot = await manager.ensure(target)
      if (action === 'scene') return json(res, 200, scene(bot))
      if (action === 'view') {
        const png = renderView(bot.world, { x: bot.pos.x, y: bot.pos.y + 1.62, z: bot.pos.z }, bot.yaw, bot.pitch, {
          width: Number(url.searchParams.get('w') ?? 160), height: Number(url.searchParams.get('h') ?? 90), fovDeg: Number(url.searchParams.get('fov') ?? 70),
          entities: bot.world.nearbyEntities(bot.pos.x, bot.pos.y, bot.pos.z, 40).map(e => ({ x: e.x, y: e.y, z: e.z, type: e.type })),
        })
        return pngRes(res, await pngBuffer(png))
      }
      if (action === 'map') {
        const png = renderMap(bot.world, { x: bot.pos.x, z: bot.pos.z }, {
          radius: Number(url.searchParams.get('r') ?? 32), scale: Number(url.searchParams.get('s') ?? 4),
          entities: bot.world.nearbyEntities(bot.pos.x, bot.pos.y, bot.pos.z, 64).map(e => ({ x: e.x, z: e.z, color: entityColor(e.type) })),
          self: { x: bot.pos.x, z: bot.pos.z },
        })
        return pngRes(res, await pngBuffer(png))
      }
      if (action === 'chat' && req.method === 'GET') return json(res, 200, bot.readChat(Number(url.searchParams.get('since') ?? 0)))
      if (action === 'block') return json(res, 200, { block: bot.world.getBlock(Number(url.searchParams.get('x')), Number(url.searchParams.get('y')), Number(url.searchParams.get('z')))?.name ?? null })
      if (action === 'inventory') return json(res, 200, { items: bot.inventory.list() })
      if (action === 'find_block') return json(res, 200, { hits: bot.world.findBlock(String(url.searchParams.get('name') ?? ''), Math.floor(bot.pos.x), Math.floor(bot.pos.z), Math.min(128, Number(url.searchParams.get('r') ?? 48)), 5, Math.floor(bot.pos.y)) })
      if (action === 'action' && req.method === 'GET') {
        const id = Number(url.searchParams.get('id') ?? 0)
        const a = id ? bot.getAction(id) : bot.activeAction
        return json(res, 200, a ? { actionId: a.id, type: a.type, status: a.status, detail: a.detail } : { action: null })
      }
      if (req.method === 'POST') {
        const body = await readJson(req)
        const logArgs = { ...body, name: target }
        if (action === 'say') { bot.say(String(body.text ?? '')); logCall(role, 'rest', 'say', logArgs, 0, txt('{"ok":true}')); return json(res, 200, { ok: true }) }
        if (action === 'look') { bot.look(Number(body.yaw ?? bot.yaw), Number(body.pitch ?? bot.pitch)); logCall(role, 'rest', 'look', logArgs, 0, txt('{"ok":true}')); return json(res, 200, { ok: true }) }
        if (action === 'act') {
          const a = bot.act(String(body.type), body)
          const out = { actionId: a.id, type: a.type, status: a.status, detail: a.detail }
          logCall(role, 'rest', 'act', logArgs, 0, txt(JSON.stringify(out)))
          return json(res, 200, out)
        }
      }
    }
    res.writeHead(404).end('not found')
  } catch (e: any) {
    json(res, 400, { error: e.message })
  }
})

// ---- MCP 请求处理 (无状态: 每请求新建 transport+server) ----

async function handleMcpRequest (role: Role, req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.method === 'GET' || req.method === 'DELETE') {
    // 无状态模式: 不支持 SSE 通道/会话删除
    res.writeHead(405, { 'allow': 'POST', 'content-type': 'application/json' }).end(JSON.stringify({ error: 'stateless: POST only' }))
    return
  }
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  let body: any
  try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}') } catch { return json(res, 400, { error: 'bad json' }) }

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  const mcpServer = new Server({ name: 'mc-agent', version: '0.2.0' }, { capabilities: { tools: {} } })
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolsFor(role) }))
  mcpServer.setRequestHandler(CallToolRequestSchema, async (req2: any) => {
    const { name, arguments: args = {} } = req2.params
    const t0 = Date.now()
    try {
      const r = await handleTool(role, name, args)
      logCall(role, 'mcp', name, args, Date.now() - t0, r)
      return r
    } catch (e: any) {
      logCall(role, 'mcp', name, args, Date.now() - t0, undefined, e.message)
      return { content: [{ type: 'text', text: `错误: ${e.message}` }], isError: true }
    }
  })
  res.on('close', () => { transport.close(); mcpServer.close() })
  await mcpServer.connect(transport)
  await transport.handleRequest(req, res, body)
}

// ---- webui-api 路由 ----

const WEBUI_HTML = readFileSync(new URL('./webui.html', import.meta.url), 'utf8')

async function handleWebuiApi (req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1) // 去掉 'webui-api'
  const m = req.method
  const name = parts[1] ? decodeURIComponent(parts[1]) : ''
  const known = () => { if (!tokens.has(name)) throw new Error(`未知角色 ${name}`) }

  try {
    // GET /webui-api/agents: 全部角色 (含离线) 的状态
    if (m === 'GET' && parts[0] === 'agents' && parts.length === 1) {
      const agents = tokens.names().map(n => {
        const bot = manager.agents.get(n)
        const online = manager.isOnline(n)
        const a = online ? bot!.latestAction : null
        return {
          name: n,
          status: online ? 'online' : manager.isConnecting(n) ? 'connecting' : 'offline',
          disabled: tokens.isDisabled(n),
          token: maskToken(tokens.tokenOf(n)!),
          position: online ? { x: +bot!.pos.x.toFixed(1), y: +bot!.pos.y.toFixed(1), z: +bot!.pos.z.toFixed(1) } : null,
          health: online ? +bot!.health.toFixed(1) : null,
          food: online ? bot!.food : null,
          dead: online ? bot!.dead : false,
          deaths: online ? bot!.deaths : 0,
          lastDeath: online && bot!.lastDeath ? bot!.lastDeath.cause : null,
          action: a ? { id: a.id, type: a.type, status: a.status, detail: a.detail } : null,
          lastLogAt: oplog.lastAt(n),
        }
      })
      return json(res, 200, { server: `${HOST}:${PORT}`, agents })
    }
    // GET /webui-api/logs?agent=&since=&limit=&kinds=tool,action
    if (m === 'GET' && parts[0] === 'logs') {
      const kinds = url.searchParams.get('kinds')
      return json(res, 200, oplog.query({
        agent: url.searchParams.get('agent') || undefined,
        since: Number(url.searchParams.get('since') ?? 0),
        limit: Math.min(1000, Number(url.searchParams.get('limit') ?? 300)),
        kinds: kinds ? new Set(kinds.split(',')) : undefined,
      }))
    }
    // POST /webui-api/agents {name}: 新建角色
    if (m === 'POST' && parts[0] === 'agents' && parts.length === 1) {
      const body = await readJson(req)
      const n = String(body.name ?? '').trim()
      const token = tokens.add(n)
      oplog.add(n, 'admin', '角色已创建 (记得把它加进服务器白名单)')
      return json(res, 200, { ok: true, name: n, token })
    }
    if (parts[0] === 'agents' && name) {
      known()
      // DELETE /webui-api/agents/:name: 删除角色 (先下线, token 作废)
      if (m === 'DELETE' && parts.length === 2) {
        manager.kill(name, '角色被删除')
        tokens.remove(name)
        oplog.add(name, 'admin', '角色已删除, token 作废')
        oplog.archive(name)
        return json(res, 200, { ok: true })
      }
      // POST /webui-api/agents/:name/offline: 退出世界 (agent token 的下一次调用会自动重连)
      if (m === 'POST' && parts[2] === 'offline') {
        const was = manager.kill(name, 'WebUI')
        return json(res, 200, { ok: true, offline: name, wasOnline: was })
      }
      // POST /webui-api/agents/:name/online: 上线
      if (m === 'POST' && parts[2] === 'online') {
        const b = await manager.ensure(name)
        return json(res, 200, { ok: true, name, phase: b.phase })
      }
      // POST /webui-api/agents/:name/disabled {disabled}: 禁止/允许上线; 禁止时立即下线
      if (m === 'POST' && parts[2] === 'disabled') {
        const disabled = !!(await readJson(req)).disabled
        tokens.setDisabled(name, disabled)
        if (disabled) manager.kill(name, '被禁止上线')
        oplog.add(name, 'admin', disabled ? '已禁止上线 (agent token 不再自动重连)' : '已允许上线')
        return json(res, 200, { ok: true, disabled })
      }
      // GET /webui-api/agents/:name/token: 查看完整 token
      if (m === 'GET' && parts[2] === 'token') return json(res, 200, { token: tokens.tokenOf(name) })
      // POST /webui-api/agents/:name/token/rotate: 轮换 token (旧 token 立即失效, 在线角色不受影响)
      if (m === 'POST' && parts[2] === 'token' && parts[3] === 'rotate') {
        const token = tokens.rotate(name)
        oplog.add(name, 'admin', 'token 已轮换, 旧 token 失效')
        return json(res, 200, { ok: true, token })
      }
    }
    return json(res, 404, { error: 'not found' })
  } catch (e: any) {
    return json(res, 400, { error: e.message })
  }
}

function json (res: http.ServerResponse, code: number, data: any) {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(data))
}

function pngRes (res: http.ServerResponse, buf: Buffer) {
  res.writeHead(200, { 'content-type': 'image/png' })
  res.end(buf)
}

async function readJson (req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {} } catch { return {} }
}

server.listen(API_PORT, API_HOST, () => {
  console.log(`[mc-agent] 单一服务: http://${API_HOST}:${API_PORT} (配置目录: ${MC_AGENT_HOME})`)
  console.log(`  MCP  : POST /mcp (x-token 鉴权, token 即角色)`)
  console.log(`  WebUI: http://${API_HOST}:${API_PORT}/webui (无鉴权${API_HOST === '127.0.0.1' ? ', 仅本机' : ', 已对外监听!'})`)
  console.log(`  admin token: ${tokens.admin}`)
  for (const n of tokens.names()) console.log(`  ${n.padEnd(8)} token: ${maskToken(tokens.tokenOf(n)!)}${tokens.isDisabled(n) ? ' (已禁用)' : ''}`)
})
