/**
 * 单一服务: MCP(StreamableHTTP /mcp) + REST 调试路由 + /webui-api 手动运维接口。
 * token 即角色: admin token 管全部; agent token 自动绑定对应角色(掉线自动重连)。
 * 入口: npm run bot
 */
import http from 'node:http'
import crypto from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { MC_AGENT_HOME, ensureMcAgentHome } from '../paths.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { BotAgent } from '../conn/bot.js'
import { renderView, renderMap, pngBuffer, lookAtBlock } from '../vision/render.js'

const HOST = process.env.MC_HOST || '127.0.0.1'
const PORT = Number(process.env.MC_PORT || 25565)
const API_PORT = Number(process.env.API_PORT || 8767)
const TOKENS_FILE = join(MC_AGENT_HOME, 'tokens.json')
const AGENT_NAMES = ['Agent_A', 'Agent_B', 'agent_c']

// ---------- token 管理 ----------

interface Tokens { admin: string, agents: Record<string, string> }

function loadTokens (): Tokens {
  if (existsSync(TOKENS_FILE)) {
    return JSON.parse(readFileSync(TOKENS_FILE, 'utf8'))
  }
  ensureMcAgentHome()
  // 沿用旧单 token 作为 admin (若有)
  const legacy = join(process.env.HOME ?? '.', '.mc-agent', 'token')
  const admin = existsSync(legacy) ? readFileSync(legacy, 'utf8').trim() : crypto.randomBytes(16).toString('hex')
  const tokens: Tokens = { admin, agents: {} }
  for (const n of AGENT_NAMES) tokens.agents[n] = crypto.randomBytes(16).toString('hex')
  writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2) + '\n', { mode: 0o600 })
  return tokens
}
const TOKENS = loadTokens()

type Role = { kind: 'admin' } | { kind: 'agent', name: string }

function authRole (token: string | undefined): Role | null {
  if (!token) return null
  if (token === TOKENS.admin) return { kind: 'admin' }
  for (const [name, t] of Object.entries(TOKENS.agents)) {
    if (token === t) return { kind: 'agent', name }
  }
  return null
}

// ---------- agent 管理 ----------

class AgentManager {
  agents = new Map<string, BotAgent>()

  async ensure (name: string): Promise<BotAgent> {
    const existing = this.agents.get(name)
    if (existing && existing.phase !== 'ended') return existing
    if (!AGENT_NAMES.includes(name)) throw new Error(`未知角色 ${name} (可用: ${AGENT_NAMES.join(' / ')})`)
    const bot = new BotAgent({ host: HOST, port: PORT, username: name })
    this.agents.set(name, bot)
    try {
      await bot.connect()
      // 等服务器下发首个位置 (避免刚上线时读到 0,0,0)
      const t0 = Date.now()
      while ((bot.pos.x === 0 && bot.pos.y === 0) && Date.now() - t0 < 5000) {
        await new Promise(ok => setTimeout(ok, 200))
      }
    } catch (e: any) {
      this.agents.delete(name)
      throw e
    }
    return bot
  }

  kill (name: string) {
    const bot = this.agents.get(name)
    if (!bot) throw new Error(`角色 ${name} 不在线`)
    bot.disconnect()
    this.agents.delete(name)
  }

  get (name: string) {
    const bot = this.agents.get(name)
    if (!bot || bot.phase === 'ended') throw new Error(`角色 ${name} 不在线`)
    return bot
  }

  list () {
    return [...this.agents.values()].map(b => ({
      name: b.name, phase: b.phase,
      position: { x: +b.pos.x.toFixed(1), y: +b.pos.y.toFixed(1), z: +b.pos.z.toFixed(1) },
      health: +b.health.toFixed(1),
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
      return { id: e.id, type: e.type, x: +e.x.toFixed(1), y: +e.y.toFixed(1), z: +e.z.toFixed(1), distance: +d.toFixed(1), bearing: Math.round(bearing), elevation: planar > 0.1 ? Math.round(Math.atan2(e.y - bot.pos.y, planar) * 180 / Math.PI) : 0 }
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
  tool('list_agents', '[admin] 列出在线角色', {}),
  tool('spawn_agent', '[admin] 上线指定角色', { name: { type: 'string', description: 'Agent_A / Agent_B / agent_c' } }, ['name']),
  tool('kill_agent', '角色下线 (agent token = 自己下线; admin 可指定)', { name: { type: 'string' } }),
  tool('get_scene', '场景: 位置/朝向/血量/脚下方块/准星指向/附近实体(id/类型/方位/距离)', { name: { type: 'string', description: '[admin]角色名' } }),
  tool('get_view', '第一人称合成视觉 PNG (含实体叠加: 红=敌对 蓝=动物 黄=掉落物)', { name: { type: 'string', description: '[admin]角色名' }, width: { type: 'number' }, height: { type: 'number' }, fov: { type: 'number', description: '水平FOV度' } }),
  tool('get_map', '顶视地图 PNG (红点=自己, 实体色点)', { name: { type: 'string', description: '[admin]角色名' }, radius: { type: 'number' }, scale: { type: 'number' } }),
  tool('read_chat', '读聊天消息 (seq 递增可增量拉取)', { name: { type: 'string', description: '[admin]角色名' }, since: { type: 'number' } }),
  tool('say', '游戏内聊天发言', { name: { type: 'string', description: '[admin]角色名' }, text: { type: 'string' } }, ['text']),
  tool('look', '转向 (yaw: 0=南 90=西; pitch: -90=正下)', { name: { type: 'string', description: '[admin]角色名' }, yaw: { type: 'number' }, pitch: { type: 'number' } }),
  tool('act', '执行动作: move_to{x,z} | dig{x,y,z} | place{x,y,z,face,hotbar} | attack{entity_id,hits} | jump | stop | select_slot{slot 0-8} | open_container{x,y,z} | chest_take{slot} | chest_put{slot} | craft_planks | drop_item{slot,all} | close_window', {
    name: { type: 'string', description: '[admin]角色名' },
    type: { type: 'string', enum: ['move_to', 'dig', 'place', 'attack', 'jump', 'stop', 'select_slot', 'open_container', 'chest_take', 'chest_put', 'craft_planks', 'drop_item', 'close_window'] },
    x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, face: { type: 'number' },
    entity_id: { type: 'number' }, hits: { type: 'number' }, hotbar: { type: 'number' }, slot: { type: 'number' }, all: { type: 'boolean' },
  }, ['type']),
  tool('wait_action', '等待动作完成', { name: { type: 'string', description: '[admin]角色名' }, actionId: { type: 'number' }, timeoutMs: { type: 'number' } }),
  tool('get_block', '查询方块 (x,y,z) + 该列最高方块', { name: { type: 'string', description: '[admin]角色名' }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, ['x', 'y', 'z']),
  tool('find_block', '在已加载区块中查找方块 (如 oak_log/chest)', { name: { type: 'string', description: '[admin]角色名' }, block: { type: 'string' }, radius: { type: 'number' } }, ['block']),
  tool('list_inventory', '库存 (9-35背包 36-44快捷栏)', { name: { type: 'string', description: '[admin]角色名' } }),
  tool('get_container', '当前打开容器的槽位内容', { name: { type: 'string', description: '[admin]角色名' } }),
]

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
    manager.kill(name)
    return txt(JSON.stringify({ ok: true, offline: name }))
  }

  const bot = await resolveAgent(role, args)
  switch (toolName) {
    case 'get_scene': return txt(JSON.stringify(scene(bot), null, 2))
    case 'get_view': {
      const png = renderView(bot.world, { x: bot.pos.x, y: bot.pos.y + 1.62, z: bot.pos.z }, bot.yaw, bot.pitch, {
        width: Number(args.width ?? 160), height: Number(args.height ?? 90), fovDeg: Number(args.fov ?? 70),
        entities: bot.world.nearbyEntities(bot.pos.x, bot.pos.y, bot.pos.z, 40)
          .map(e => ({ x: e.x, y: e.y, z: e.z, type: e.type, hostile: /zombie|skeleton|creeper|spider|witch|enderman|slime|drowned|husk|stray|pillager/.test(e.type) })),
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
    case 'say': bot.say(String(args.text ?? '').slice(0, 256)); return txt(JSON.stringify({ ok: true }))
    case 'look': bot.look(Number(args.yaw ?? bot.yaw), Number(args.pitch ?? bot.pitch)); return txt(JSON.stringify({ ok: true }))
    case 'act': {
      const body: any = { type: args.type }
      for (const k of ['x', 'y', 'z', 'face', 'entity_id', 'hits', 'hotbar', 'slot', 'all']) if (args[k] !== undefined) body[k] = args[k]
      const a = bot.act(String(args.type), body)
      return txt(JSON.stringify({ actionId: a.id, type: a.type, status: a.status, detail: a.detail }))
    }
    case 'wait_action': {
      const timeoutMs = Math.min(180_000, Number(args.timeoutMs ?? 30_000))
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const a = args.actionId ? bot.getAction(Number(args.actionId)) : bot.activeAction
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
      const hits = bot.world.findBlock(String(args.block ?? ''), Math.floor(bot.pos.x), Math.floor(bot.pos.z), Number(args.radius ?? 48), 5)
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
  const role = authRole(token)

  try {
    // ---- MCP StreamableHTTP ----
    if (url.pathname === '/mcp') {
      if (!role) return json(res, 401, { error: 'invalid token' })
      return await handleMcpRequest(role, req, res)
    }

    // ---- webui-api (admin): 手动运维 ----
    if (url.pathname.startsWith('/webui-api/')) {
      if (!role || role.kind !== 'admin') return json(res, 401, { error: 'admin token required' })
      const parts = url.pathname.split('/').filter(Boolean) // ['webui-api', 'agents', name, 'offline']
      if (parts[1] === 'agents' && parts[3] === 'offline' && req.method === 'POST') {
        try {
          manager.kill(parts[2]!)
          return json(res, 200, { ok: true, offline: parts[2] })
        } catch (e: any) { return json(res, 400, { error: e.message }) }
      }
      return json(res, 404, { error: 'not found' })
    }

    // ---- REST 调试路由 (同 token 语义) ----
    if (url.pathname === '/tokens' && role?.kind === 'admin') {
      return json(res, 200, TOKENS)
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
      const bot = await manager.ensure(target)

      if (req.method === 'DELETE') { manager.kill(target); return json(res, 200, { ok: true }) }
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
      if (action === 'find_block') return json(res, 200, { hits: bot.world.findBlock(String(url.searchParams.get('name') ?? ''), Math.floor(bot.pos.x), Math.floor(bot.pos.z), Number(url.searchParams.get('r') ?? 48), 5) })
      if (action === 'action' && req.method === 'GET') {
        const id = Number(url.searchParams.get('id') ?? 0)
        const a = id ? bot.getAction(id) : bot.activeAction
        return json(res, 200, a ? { actionId: a.id, type: a.type, status: a.status, detail: a.detail } : { action: null })
      }
      if (req.method === 'POST') {
        const body = await readJson(req)
        if (action === 'say') { bot.say(String(body.text ?? '')); return json(res, 200, { ok: true }) }
        if (action === 'look') { bot.look(Number(body.yaw ?? bot.yaw), Number(body.pitch ?? bot.pitch)); return json(res, 200, { ok: true }) }
        if (action === 'act') {
          const a = bot.act(String(body.type), body)
          return json(res, 200, { actionId: a.id, type: a.type, status: a.status, detail: a.detail })
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
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
  mcpServer.setRequestHandler(CallToolRequestSchema, async (req2: any) => {
    const { name, arguments: args = {} } = req2.params
    try {
      return await handleTool(role, name, args)
    } catch (e: any) {
      return { content: [{ type: 'text', text: `错误: ${e.message}` }], isError: true }
    }
  })
  res.on('close', () => { transport.close(); mcpServer.close() })
  await mcpServer.connect(transport)
  await transport.handleRequest(req, res, body)
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

server.listen(API_PORT, '127.0.0.1', () => {
  console.log(`[mc-agent] 单一服务: http://127.0.0.1:${API_PORT} (配置目录: ${MC_AGENT_HOME})`)
  console.log(`  MCP  : POST /mcp (x-token 鉴权, token 即角色)`)
  console.log(`  运维 : POST /webui-api/agents/<名>/offline (admin token)`)
  console.log(`  admin token: ${TOKENS.admin}`)
  for (const [n, t] of Object.entries(TOKENS.agents)) console.log(`  ${n.padEnd(8)} token: ${t}`)
})
