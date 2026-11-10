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
import { SLOT, isHotbar, hotbarIndex, containerSize, describeItem, itemExtras } from '../conn/inventory.js'
import { ScriptAction } from '../actions/script.js'
import type { Action } from '../actions/base.js'
import { ACTION_TYPES, actSchemaProps, actionCatalog, PROPOSAL_HINT } from '../actions/registry.js'
import { renderView, renderMap, pngBuffer, lookAtBlock, type EntityKind, type ViewEntity } from '../vision/render.js'
import { DEFAULT_POLICY, type Policy } from '../conn/reflex.js'
import { isHostile, isNight, entitySize, blockProps } from '../game/knowledge.js'
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
  const eye = { x: bot.pos.x, y: bot.pos.y + bot.eyeHeight, z: bot.pos.z }
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
  // 当前主动作: 丢了上下文的 agent 靠它知道自己正在干什么 (没有在跑的就给最近结束的那个)
  const cur = bot.activeAction?.status === 'running' ? bot.activeAction : (bot.latestAction ?? bot.activeAction)
  const clip = (t: string) => t.length > 200 ? t.slice(0, 200) + '…' : t
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
    action: cur ? { id: cur.id, type: cur.type, status: cur.status, ...(cur.byReflex ? { by_reflex: true } : {}), ...(cur.status === 'running' ? { running_s: Math.round((Date.now() - cur.createdAt) / 1000) } : {}), ...(cur.detail ? { detail: clip(cur.detail) } : {}) } : null,
    held: bot.inventory.held() ? describeItem(bot.inventory.held()) : null,
    xp: { level: bot.xp.level, progress: +bot.xp.progress.toFixed(2) },
    ...(bot.gameMode !== 'survival' ? { game_mode: bot.gameMode } : {}),
    dimension: { name: bot.dimension.replace(/^minecraft:/, ''), min_y: bot.world.min_y, max_y: bot.world.min_y + bot.world.world_height - 1, ...(bot.world.hasCeiling ? { ceiling: true } : {}), ...(bot.dimInfo.bedWorks ? {} : { bed_explodes: true }) },
    time: { day_time: bot.dayTime, night: isNight(bot.dayTime) },
    ...(bot.sleeping ? { sleeping: true } : {}),
    ...(bot.vehicleId !== null ? { riding: bot.vehicleId } : {}),
    ...(bot.swimming ? { swimming: true } : {}),
    ...(bot.air < 300 ? { air: bot.air } : {}),
    ...(bot.onFire ? { on_fire: true } : {}),
    inventory: bot.inventory.summary(),
    combat: { hits_taken: bot.hurts, shield_blocks: bot.shieldBlocks, ...(bot.reflex.shieldUp ? { shield_up: true } : {}), ...(bot.onCooldown('shield') ? { shield_disabled_s: Math.ceil(((bot.cooldowns.get('shield') ?? 0) - Date.now()) / 1000) } : {}) },
    reflex: bot.reflex.status(),
    standing_on: below?.name ?? '未知(chunk未加载)',
    looking_at: looking ? { block: looking.name, x: looking.x, y: looking.y, z: looking.z, distance: +looking.dist.toFixed(1) } : null,
    nearby_entities: nearby,
    world: { chunks_loaded: bot.world.chunkCount },
  }
}

// 朝向/方位: 原版 yaw 0=南, 90=西, 180=北, -90=东
const DIRS8 = ['南', '西南', '西', '西北', '北', '东北', '东', '东南']
const dir8 = (yawDeg: number) => DIRS8[((Math.round(yawDeg / 45) % 8) + 8) % 8]
const ANIMAL = /(cow|pig|sheep|chicken|horse|donkey|mule|llama|wolf|cat|ocelot|parrot|villager|rabbit|fox|bee|goat|frog|camel|sniffer|allay|turtle|axolotl|panda|polar_bear|armadillo|squid|dolphin|cod|salmon|strider|mooshroom|trader)/

function entityKind (type: string): EntityKind {
  if (type === 'player') return 'player'
  if (type === 'item') return 'item'
  if (isHostile(type)) return 'hostile'
  if (ANIMAL.test(type)) return 'animal'
  return 'other'
}

function viewEntities (bot: BotAgent, radius: number): ViewEntity[] {
  return bot.world.nearbyEntities(bot.pos.x, bot.pos.y, bot.pos.z, radius)
    .filter(e => e.id !== bot.entityId && !/arrow|experience_orb|marker|interaction|display/.test(e.type))
    .map(e => {
      const { w, h } = entitySize(e.type)
      return { id: e.id, x: e.x, y: e.y, z: e.z, type: e.type, label: e.type === 'item' ? (e.item ?? 'item') : e.type, kind: entityKind(e.type), w, h }
    })
}

const KIND_ZH: Record<EntityKind, string> = { hostile: '敌对', animal: '动物', item: '掉落物', player: '玩家', other: '其他' }

/** get_view: PNG + 文字说明 (朝向/准星/画面内实体编号), 图负责空间关系, 文字给精确数字 */
async function viewTool (bot: BotAgent, width?: number, height?: number, fov?: number) {
  const eye = { x: bot.pos.x, y: bot.pos.y + bot.eyeHeight, z: bot.pos.z }
  const W = Math.max(16, Math.min(640, width ?? 480))
  const r = await renderView(bot.world, eye, bot.yaw, bot.pitch, { width: W, height: height ?? Math.round(W * 9 / 16), fovDeg: fov ?? 70, entities: viewEntities(bot, 64) })
  const { width: PW, height: PH } = r.png
  const look = lookAtBlock(bot.world, eye, bot.yaw, bot.pitch)
  const where = (sx: number, sy: number) => `${sx < PW / 3 ? '左' : sx > PW * 2 / 3 ? '右' : '中'}${sy < PH / 3 ? '上' : sy > PH * 2 / 3 ? '下' : ''}`
  const pitchWord = bot.pitch > 15 ? '俯视' : bot.pitch < -15 ? '仰视' : '平视'
  const lines = [
    `第一人称 ${PW}×${PH}, 水平 FOV ${Math.round(fov ?? 70)}° · 朝${dir8(bot.yaw)} (yaw ${bot.yaw.toFixed(0)}, pitch ${bot.pitch.toFixed(0)} ${pitchWord}) · 眼睛 (${eye.x.toFixed(1)}, ${eye.y.toFixed(1)}, ${eye.z.toFixed(1)})`,
    `准星(画面中心十字) → ${look ? `${look.name} (${look.x}, ${look.y}, ${look.z}) 距 ${look.dist} 格` : '天空/超出 80 格'}`,
  ]
  const shown = r.entities.filter(e => e.visible > 0)
  const hidden = r.entities.filter(e => e.visible === 0)
  if (shown.length) {
    lines.push('画面中的实体 (图中 #编号 = act 用的 entity_id):')
    for (const e of shown.slice(0, 20)) lines.push(`  #${e.id} ${e.label} [${KIND_ZH[e.kind]}] 距 ${e.dist} 格, 画面${where(e.sx, e.sy)}${e.visible < 0.6 ? ', 部分被挡' : ''}${e.labeled ? '' : ' (标签放不下)'}`)
  } else lines.push('画面中没有实体')
  if (hidden.length) lines.push(`视野方向上但被方块挡住 (图中不画): ${hidden.slice(0, 10).map(e => `#${e.id} ${e.label} 距${e.dist}`).join(', ')}`)
  lines.push('图例: 框色 红=敌对 蓝=动物 黄=掉落物 白=玩家 橙=其他; 顶部字母为罗盘方位 (N 北 -Z / S 南 +Z / E 东 +X / W 西 -X); 方块边缘描暗线, 一格一格可数; 草花火把画成细块, 玻璃/水半透明')
  return { buf: await pngBuffer(r.png), text: lines.join('\n') }
}

/** get_map: 顶视 PNG + 文字说明 */
async function mapTool (bot: BotAgent, radius?: number, scale?: number, mode?: string) {
  const ents = viewEntities(bot, 96)
  const r = renderMap(bot.world, { x: bot.pos.x, y: bot.pos.y, z: bot.pos.z }, {
    radius, scale, mode: mode as any, entities: ents, self: { x: bot.pos.x, y: bot.pos.y, z: bot.pos.z, yaw: bot.yaw },
  })
  const i = r.info
  const lines = [
    `顶视地图 ${r.png.width}×${r.png.height}: 上=北(-Z) 下=南(+Z) 右=东(+X) 左=西(-X) · 覆盖 x ${i.x0}..${i.x1}, z ${i.z0}..${i.z1} · 每格 ${i.scale} 像素`,
    `网格线每 ${i.grid} 格${i.grid === 16 ? ' (= 区块边界)' : ''}; 上边缘数字 = 竖线的 x 坐标, 左边缘数字 = 横线的 z 坐标`,
    i.mode === 'surface'
      ? '模式 surface (地表): 每列最高方块的颜色; 明暗 = 起伏 (比北邻高偏亮, 低偏暗), 水越深越暗, 深灰 = 未加载区块'
      : `模式 slice (按你脚下 y=${i.sliceY} 横切, 地下/室内自动启用): 亮 = 可站立的地面, 暗 = 墙 (身体高度有实心方块), 越黑 = 坑越深, 深灰 = 未加载`,
    `你: 红色箭头 @ (${bot.pos.x.toFixed(1)}, ${bot.pos.y.toFixed(1)}, ${bot.pos.z.toFixed(1)}), 箭头指向 = 朝${dir8(bot.yaw)}`,
  ]
  const inMap = ents.filter(e => e.x >= i.x0 && e.x <= i.x1 + 1 && e.z >= i.z0 && e.z <= i.z1 + 1)
    .map(e => ({ e, d: Math.hypot(e.x - bot.pos.x, e.z - bot.pos.z) })).sort((a, b) => a.d - b.d)
  if (inMap.length) {
    lines.push('实体 (点色同 get_view; 图中 #编号 = entity_id, 掉落物不标号):')
    for (const { e, d } of inMap.slice(0, 20)) {
      const bearing = Math.atan2(-(e.x - bot.pos.x), e.z - bot.pos.z) * 180 / Math.PI
      lines.push(`  #${e.id} ${e.label} [${KIND_ZH[e.kind]}] (${e.x.toFixed(0)}, ${e.y.toFixed(0)}, ${e.z.toFixed(0)}) 水平距 ${d.toFixed(0)} 格, 在你${dir8(bearing)}方${e.y - bot.pos.y > 2 ? ', 高处' : e.y - bot.pos.y < -2 ? ', 低处' : ''}`)
    }
    if (inMap.length > 20) lines.push(`  …另有 ${inMap.length - 20} 个`)
  }
  if (r.info.mode === 'slice') lines.push('需要看地表时传 mode:"surface"')
  return { buf: await pngBuffer(r.png), text: lines.join('\n') }
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
  tool('get_scene', '场景: 维度 (名字/高度范围/有无顶棚/床会不会爆炸)/经验等级 xp/位置/朝向/血量/action 当前主动作 (没有在跑的就是最近结束的那个: id/类型/状态/说明)/背包汇总/脚下方块/准星指向/附近实体(id/类型/方位/距离)/reflex 反射状态 (state/home/最近事件; 完整策略用不带参数的 set_policy 看)', { name: { type: 'string', description: '[admin]角色名' } }),
  tool('get_view', '第一人称合成视觉 PNG + 文字说明。实体按真实大小画框并标 #entity_id (被墙挡住的不画), 中心十字=准星, 顶部罗盘; 文字给朝向/准星方块坐标/画面内实体列表', { name: { type: 'string', description: '[admin]角色名' }, width: { type: 'number', description: '默认 480, 最大 640' }, height: { type: 'number', description: '默认 宽×9/16, 最大 360' }, fov: { type: 'number', description: '水平FOV度, 默认 70' } }),
  tool('get_map', '顶视地图 PNG + 文字说明: 上=北, 网格线每 16 格并在边缘标坐标, 红箭头=自己及朝向, 实体色点标 #entity_id。地下/室内自动切换为脚下高度的横切图', { name: { type: 'string', description: '[admin]角色名' }, radius: { type: 'number', description: '半径格数, 默认 32, 最大 96' }, scale: { type: 'number', description: '每格像素, 默认 6' }, mode: { type: 'string', enum: ['auto', 'surface', 'slice'], description: '默认 auto' } }),
  tool('read_chat', '读聊天消息: 默认只给上次读过之后的新消息 (读过即标为已读), 最多 limit 条 (留最新的)。要重看旧消息传 since (只给 seq 大于它的; since:0 = 从缓冲最早的开始)。其他工具的返回末尾出现 {inbox} 表示有人给你发了消息还没看', { name: { type: 'string', description: '[admin]角色名' }, since: { type: 'number', description: '只给 seq 大于它的消息; 默认 = 上次读到的位置' }, limit: { type: 'number', description: '最多几条, 默认 50, 最大 200' } }),
  tool('say', '游戏内聊天发言 (不执行命令)', { name: { type: 'string', description: '[admin]角色名' }, text: { type: 'string' } }, ['text']),
  tool('run_command', '以本角色身份执行服务器命令 (如 /seed /list /msg; 可加可不加 "/")。权限由服务器决定 (bot 不是 OP 时管理命令会被拒, 结果里附可用命令列表)。返回服务器回给你的消息', {
    name: { type: 'string', description: '[admin]角色名' }, command: { type: 'string' }, waitMs: { type: 'number', description: '等回复的最长毫秒数, 默认 2000' },
  }, ['command']),
  tool('look', '转向 (yaw: 0=南 90=西 180=北 -90=东; pitch: 90=正下 -90=正上)', { name: { type: 'string', description: '[admin]角色名' }, yaw: { type: 'number' }, pitch: { type: 'number' } }),
  // 动作清单 / type 枚举 / 参数 schema 都由动作规格表 (actions/registry.ts) 生成, 加动作只改那里
  tool('act', `执行动作 (异步, 返回 actionId; 新的主动作会取消正在进行的主动作)。
建议带 wait_ms (如 30000): 在时限内等动作结束并直接返回结果, 不用再调 wait_action; 到时限还没结束返回 timeout:true + actionId, 再用 wait_action 接着等。不带 wait_ms 立即返回。
参数不对时报错会给出该动作的用法; 带 ? 的是可选参数:
${actionCatalog()}
走近: dig/place/open_container/use_block 等够不着或看不见目标时会自动走到附近能看见它的位置再操作, 结果里注明站位 (触及范围 = 眼睛到方块表面 4.4 格)。
改地形: 寻路默认只走现成的路, 不挖不搭 (collect/craft/smelt/use_block/sleep 走过去的路上也一样)。走不通时动作失败并给 proposals (挖/搭方案, 带 id 和 [推荐]/[不推荐]); 要采纳就在原动作参数里加 confirm:"<方案id>" 重新下达, 细则见失败结果里的 hint。背包有 water_bucket 时会自动用落地水从高处跳下, 不算改地形。
死亡: 所有动作以"死亡: 死因"取消, get_scene.last_death 给出死因/地点/掉落物剩余时间。`, {
    name: { type: 'string', description: '[admin]角色名' },
    type: { type: 'string', enum: ACTION_TYPES },
    ...actSchemaProps(),
    wait_ms: { type: 'number', description: '等动作结束的最长毫秒数 (最大 180000): 结束就直接返回结果; 缺省 0 = 立即返回 actionId' },
    interrupt: { type: 'boolean', description: '带 wait_ms 时: 有人发消息/死亡是否中断等待 (动作继续跑), 默认 true' },
  }, ['type']),
  tool('set_policy', `设置反射策略 (bot 自主执行, 不等你决策; 只传要改的字段, 什么都不传 = 只查看当前策略):
autoEat(bool) 自动进食 | eatAt(饱食度阈值, 默认 14) | combat: defend(还击, 默认)/flee(见怪就跑)/ignore | fleeHealth(血量低于此值逃跑, 默认 8)
avoidHazards(bool) 逃离岩浆/火/溺水 | nightShelter(bool) 天黑空闲时回家睡觉 (只在家所在维度、且能睡床的主世界触发) | home: "here" 或 {x,y,z,dimension?} 或 null (记下维度, 默认当前维度)
autoRespawn(bool) 死亡后自动复活 (默认 true; false 则停在死亡界面等 act respawn)
shield(bool) 自动举盾 (默认 true; 副手空着会自动放上盾): 箭飞来/骷髅拉弓/苦力怕点燃/怪近身时面向威胁格挡, 砍怪时放下
ranged: auto(默认, 有弓有箭时远程怪/苦力怕/飞行怪用弓, 空闲时也射逼近的怪)/never`, {
    name: { type: 'string', description: '[admin]角色名' },
    autoEat: { type: 'boolean' }, eatAt: { type: 'number' }, combat: { type: 'string', enum: ['defend', 'flee', 'ignore'] }, fleeHealth: { type: 'number' },
    avoidHazards: { type: 'boolean' }, nightShelter: { type: 'boolean' }, autoRespawn: { type: 'boolean' }, shield: { type: 'boolean' }, ranged: { type: 'string', enum: ['auto', 'never'] }, home: { description: '"here" | {x,y,z,dimension?} | null' },
  }),
  tool('wait_action', '等待动作完成。有人给你发消息 (私聊/聊天) 或你死亡时会立即中断等待并返回消息 (interrupted:true, 动作继续执行); interrupt:false 关闭中断', { name: { type: 'string', description: '[admin]角色名' }, actionId: { type: 'number' }, timeoutMs: { type: 'number' }, interrupt: { type: 'boolean', description: '默认 true' } }),
  tool('run_script', `运行 JS 脚本 (异步, 返回 scriptId; 是一个主动作, 会顶掉当前主动作)。适合重复/有循环的流程 (挖矿道、按规律采集、建造), 一次下发、跑完看结果再决定下一步。
脚本体是 async 函数体: 可直接 await / return (返回值进 result)。抛错或子动作失败 = 脚本失败 (报行号)。
动作 (await, 失败抛错, 可 try/catch): moveTo(pos,{tolerance,allowDig,allowPlace,confirm,maxDist}) (脚本里默认不限路程) dig(pos)→挖掉的方块名(空气返回 null) place(pos,item?,face?) collect(block,count,radius) pickup(r) equip(item) drop(item,n=1) craft(item,n) smelt(item,n,fuel?) enchant(item,option?) anvil(item,{with,rename,slot,withSlot,preview}) eat(item?) attack(id,hits) shoot(id,shots) useBlock(pos,item?) useItem(item?,holdMs) selectSlot(i) sleep(ms) | act(type,params) 通用 (同 act 工具) | tryAct(type,params)→{ok,status,detail,extra} 不抛错 (move_to 走不通时 extra.proposals 是挖/搭方案; 抛出的错误同样带 e.extra)
查询 (同步): pos() here()=脚下方块坐标 block(pos)→名字|null(未加载) isAir(pos) isSolid(pos) reach(pos)=眼睛到方块距离 (挖/放要 ≤4.5) scan(match,r≤24,limit)→[{name,pos,dist}] 近→远 (match: 名字/"*_ore"/数组/正则) findBlock(name,r) inv()→{物品:数量} count(item) freeSlots() held() hp() food() state() entities(r,type?)→[{id,type,pos,dist,hostile}] elapsed()
坐标: vec(x,y,z) 或 {x,y,z}; Vec 方法 add/sub/offset/mul/up/down/north/south/east/west/right/left/floored/dist/equals; fwd()=当前朝向的水平单位向量 (东南西北之一), dir("north"|...)
输出: log(...) (进日志) progress(obj) (最新进度快照) say(text); 参数 args 在脚本里是全局变量 args
追踪: wait_action{actionId:scriptId} 结束时返回完整报告; script_status 看运行中进度。报告含 logs / progress / result / error{line,code} / stats{dug 挖掉的方块 (含寻路途中), placed 寻路放置的方块, items 物品增减, moved 位移, hp, food, actions 各子动作成败数}
约束: 循环里必须 await 动作或 sleep (同步执行 >1.5s 会被判死循环); 默认 300s 超时 (timeoutSec 最大 1800); 反射层照常工作 (被怪打/逃跑接管时脚本会被打断, 看 error)。挖掘本身会拒绝挖开旁边有岩浆的方块
示例: const f = fwd(); let p = here(); for (let i = 0; i < 20; i++) { p = p.add(f); await dig(p); await dig(p.up()); await moveTo(p); for (const o of scan('*_ore', 4)) log('矿', o.name, o.pos); if (hp() < 10) return {stop: '血少', i} } return {dug: i}`, {
    name: { type: 'string', description: '[admin]角色名' }, code: { type: 'string', description: '脚本源码 (async 函数体)' },
    args: { description: '传给脚本的参数 (脚本里的全局 args)' }, timeoutSec: { type: 'number', description: '默认 300, 最大 1800' },
  }, ['code']),
  tool('script_status', '查看脚本进度 (不等待): 状态/当前子动作/progress/新日志/统计。since=上次返回的 log_seq 只拿新日志; 不传 id 看最近的脚本', { name: { type: 'string', description: '[admin]角色名' }, id: { type: 'number' }, since: { type: 'number' } }),
  tool('stop_script', '中止脚本 (正在执行的子动作一并取消), 返回最终报告; 不传 id 中止最近的脚本', { name: { type: 'string', description: '[admin]角色名' }, id: { type: 'number' }, reason: { type: 'string' } }),
  tool('wait_event', '空闲时用: 挂起直到有人给你发消息 (私聊/公屏/动作) 或你死亡, 返回这些消息 (已有未读则立即返回); 超时返回 {timeout:true}。比反复 read_chat 省调用', { name: { type: 'string', description: '[admin]角色名' }, timeoutMs: { type: 'number', description: '默认 60000, 最大 180000' } }),
  tool('get_block', '查询方块 (x,y,z): 名字 + props 状态属性 (作物 age 是否成熟 / 门 open / 熔炉 lit / 朝向 facing …) + 该列最高方块', { name: { type: 'string', description: '[admin]角色名' }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, ['x', 'y', 'z']),
  tool('find_block', '在已加载区块中查找方块 (如 oak_log/chest), 返回最近的 5 个', { name: { type: 'string', description: '[admin]角色名' }, block: { type: 'string' }, radius: { type: 'number' } }, ['block']),
  tool('list_inventory', '库存: held 手持物 / summary 各物品总数 / items 每格带 where 标注 (快捷栏N/背包/盔甲/副手), 有附魔/耐久/自定义名/铁砧惩罚的会列出 (enchantments / stored_enchantments / durability 剩余/最大 / custom_name / repair_cost) / empty_slots', { name: { type: 'string', description: '[admin]角色名' } }),
  tool('get_container', '当前打开的容器: 是哪个方块/坐标, container 容器格 (slot 是容器格号) + container_totals 汇总, free 空格数, inventory 背包汇总', { name: { type: 'string', description: '[admin]角色名' } }),
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
function img (buf: Buffer, text?: string) {
  return { content: [{ type: 'image' as const, data: buf.toString('base64'), mimeType: 'image/png' }, ...(text ? [{ type: 'text' as const, text }] : [])] }
}

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
    case 'get_scene': return txt(JSON.stringify(scene(bot)))
    case 'get_view': {
      const v = await viewTool(bot, args.width === undefined ? undefined : Number(args.width), args.height === undefined ? undefined : Number(args.height), args.fov === undefined ? undefined : Number(args.fov))
      return img(v.buf, v.text)
    }
    case 'get_map': {
      const m = await mapTool(bot, args.radius === undefined ? undefined : Number(args.radius), args.scale === undefined ? undefined : Number(args.scale), args.mode === undefined ? undefined : String(args.mode))
      return img(m.buf, m.text)
    }
    case 'read_chat': {
      // 默认只给上次读过之后的新消息 (since 缺省 = 已读游标), 最多 limit 条 (留最新的), 免得一次倒出整个 500 条缓冲
      const since = args.since != null && Number.isFinite(Number(args.since)) ? Number(args.since) : bot.chatReadSeq
      const limit = Math.max(1, Math.min(200, Math.floor(Number(args.limit ?? 50)) || 50))
      const all = bot.readChat(since)
      const msgs = all.slice(-limit)
      if (all.length) bot.markRead(all[all.length - 1].seq)
      const r = txt(JSON.stringify(msgs))
      if (all.length > limit) r.content.push({ type: 'text' as const, text: JSON.stringify({ skipped: all.length - limit, hint: `只给了最新 ${limit} 条; 更早的用 since=${since} 加大 limit (最大 200) 再读` }) })
      return r
    }
    case 'wait_event': {
      // 长轮询: 有未读重要消息立即返回, 否则挂起直到来消息或超时
      const timeoutMs = Math.max(500, Math.min(180_000, Number(args.timeoutMs ?? 60_000)))
      const got = await bot.waitImportant(timeoutMs)
      if (!got) return txt(JSON.stringify({ timeout: true, waited_ms: timeoutMs }))
      await new Promise(r => setTimeout(r, 150)) // 同一批消息 (如私聊+系统提示) 往往紧挨着到, 稍等收齐
      return txt(JSON.stringify({ events: takeUnread(bot) }))
    }
    case 'say': {
      const t = String(args.text ?? '')
      if (t.startsWith('/')) return txt(JSON.stringify({ ok: false, error: 'say 只发聊天, 执行命令请用 run_command' }))
      bot.say(t.slice(0, 256)); return txt(JSON.stringify({ ok: true }))
    }
    case 'run_command': return txt(JSON.stringify(await bot.runCommand(String(args.command ?? ''), Math.max(300, Math.min(10_000, Number(args.waitMs ?? 2000)))), null, 1))
    case 'set_policy': {
      const p: any = { ...bot.reflex.policy }
      for (const k of ['autoEat', 'avoidHazards', 'nightShelter', 'autoRespawn', 'shield']) if (typeof args[k] === 'boolean') p[k] = args[k]
      for (const k of ['eatAt', 'fleeHealth']) if (args[k] !== undefined && Number.isFinite(Number(args[k]))) p[k] = Math.max(0, Math.min(20, Number(args[k])))
      if (['defend', 'flee', 'ignore'].includes(args.combat)) p.combat = args.combat
      if (['auto', 'never'].includes(args.ranged)) p.ranged = args.ranged
      // home 记下维度 (不给就是当前维度): 不同维度坐标不通用, go_home/夜间回家会据此拒绝
      if (args.home === 'here') p.home = { x: Math.floor(bot.pos.x), y: Math.floor(bot.pos.y), z: Math.floor(bot.pos.z), dimension: bot.dimension }
      else if (args.home === null) p.home = null
      else if (args.home && typeof args.home === 'object') {
        const d = typeof args.home.dimension === 'string' && args.home.dimension ? String(args.home.dimension) : bot.dimension
        p.home = { x: Math.floor(Number(args.home.x)), y: Math.floor(Number(args.home.y)), z: Math.floor(Number(args.home.z)), dimension: d.includes(':') ? d : `minecraft:${d}` }
      }
      bot.reflex.policy = p
      savePolicy(bot.name, p)
      return txt(JSON.stringify({ ok: true, policy: p }))
    }
    case 'look': bot.look(Number(args.yaw ?? bot.yaw), Number(args.pitch ?? bot.pitch)); return txt(JSON.stringify({ ok: true }))
    case 'act': {
      const { name: _n, wait_ms: _w, interrupt: _i, ...body } = args
      const a = bot.act(String(args.type), body)
      // wait_ms: 在时限内等它结束, 省掉紧跟着的那次 wait_action; 没等到就照常给 actionId
      const waitMs = Math.max(0, Math.min(180_000, Number(args.wait_ms ?? 0) || 0))
      if (waitMs > 0 && a.status === 'running') return txt(JSON.stringify(await waitAction(bot, () => a, waitMs, args.interrupt !== false)))
      return txt(JSON.stringify(actionResult(a)))
    }
    case 'run_script': {
      const a = bot.act('script', { code: String(args.code ?? ''), args: args.args, timeoutMs: args.timeoutSec != null ? Number(args.timeoutSec) * 1000 : undefined })
      return txt(JSON.stringify({ scriptId: a.id, status: a.status, ...(a.detail ? { detail: a.detail } : {}), hint: 'wait_action{actionId} 等结束拿报告, script_status 看进度, stop_script 中止' }))
    }
    case 'script_status': case 'stop_script': {
      const s = findScript(bot, args.id)
      if (!s) return txt(JSON.stringify({ error: args.id ? `没有脚本 #${args.id}` : '还没运行过脚本' }))
      if (toolName === 'stop_script') {
        if (s.status === 'running') s.cancel(`被中止${args.reason ? ': ' + String(args.reason).slice(0, 100) : ''}`)
        await new Promise(r => setTimeout(r, 120)) // 等子动作收尾
        return txt(JSON.stringify(s.report(0, 20)))
      }
      return txt(JSON.stringify(s.report(Number(args.since ?? 0))))
    }
    case 'wait_action': {
      const timeoutMs = Math.min(180_000, Number(args.timeoutMs ?? 30_000))
      return txt(JSON.stringify(await waitAction(bot, () => args.actionId ? bot.getAction(Number(args.actionId)) : bot.latestAction, timeoutMs, args.interrupt !== false)))
    }
    case 'get_block': {
      const x = Math.floor(Number(args.x)), y = Math.floor(Number(args.y)), z = Math.floor(Number(args.z))
      const b = bot.world.getBlock(x, y, z)
      // props: 方块状态属性 (作物 age 熟没熟 / 门 open / 熔炉 lit / 朝向 facing …)
      const props = b ? blockProps(b.stateId) : {}
      return txt(JSON.stringify({ x, y, z, block: b?.name ?? null, ...(Object.keys(props).length ? { props } : {}), stateId: b?.stateId ?? null, highest: bot.world.highestBlockY(x, z) }))
    }
    case 'find_block': {
      const hits = bot.world.findBlock(String(args.block ?? ''), Math.floor(bot.pos.x), Math.floor(bot.pos.z), Math.min(128, Number(args.radius ?? 48)), 5, Math.floor(bot.pos.y))
      return txt(JSON.stringify({ block: args.block, hits: hits.map(h => ({ ...h, distance: +Math.hypot(h.x - bot.pos.x, h.y - bot.pos.y, h.z - bot.pos.z).toFixed(1) })) }))
    }
    case 'list_inventory': {
      // 每格标注所在区域, 免得 LLM 自己记槽位编号
      const inv = bot.inventory
      const where = (s: number) => s === SLOT.craftResult ? '合成产物' : s < SLOT.armor ? '合成格' : s < SLOT.main ? ['头盔', '胸甲', '护腿', '靴子'][s - SLOT.armor] : s < SLOT.hotbar ? '背包' : isHotbar(s) ? `快捷栏${hotbarIndex(s)}${hotbarIndex(s) === inv.heldSlot ? ' (手持)' : ''}` : '副手'
      return txt(JSON.stringify({
        held: inv.held() ? { name: inv.held()!.name, count: inv.held()!.count, hotbar: inv.heldSlot } : null,
        summary: inv.summary(),
        items: inv.list().map(i => ({ ...i, where: where(i.slot) })),
        ...(inv.cursor ? { cursor: inv.cursor } : {}),
        empty_slots: inv.emptySlots(),
        hint: 'slot = 玩家窗口槽位, 只在同名多件时用来指定哪一格 (anvil / enchant / drop_item 的 slot); 丢东西用 drop_item{item,count}, 箱子存取用 chest_take/chest_put{item,count}',
      }))
    }
    case 'get_container': {
      const wid = bot.inventory.activeWindowId
      if (wid === null) return txt(JSON.stringify({ open: false }))
      const w = bot.inventory.windows.get(wid)
      const all = w?.slots ?? []
      const size = containerSize(all.length) // 末尾是玩家背包+快捷栏
      const o = bot.openedContainer?.windowId === wid ? bot.openedContainer : null
      const cont = all.slice(0, size).map((s: any, i: number) => s ? { slot: i, name: s.name, count: s.count, ...itemExtras(s) } : null).filter(Boolean)
      const totals: Record<string, number> = {}
      for (const s of all.slice(0, size)) if (s) totals[s.name] = (totals[s.name] ?? 0) + s.count
      return txt(JSON.stringify({
        open: true, windowId: wid, ...(o ? { block: o.block, at: { x: o.x, y: o.y, z: o.z } } : {}),
        size, free: all.slice(0, size).filter((s: any) => !s).length,
        container: cont, container_totals: totals,
        inventory: bot.inventory.summary(),
        hint: '存取用 chest_take/chest_put{item, count?} (count 缺省=全部); container 里的 slot 是容器格号',
      }))
    }
    default: return txt(`未知工具: ${toolName}`)
  }
}

// ---------- 等动作 ----------

/** 等动作结束 (wait_action 与 act{wait_ms} 共用): 结束 → 结果; 来了重要消息 → interrupted (动作继续跑); 到时限 → timeout + 当前状态 */
async function waitAction (bot: BotAgent, pick: () => Action | null | undefined, timeoutMs: number, interrupt: boolean) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const a = pick()
    if (!a || a.status !== 'running') return a ? actionResult(a) : { action: null }
    // 有人发消息 → 立即中断等待 (动作本身继续执行), 把消息交给 agent 决策
    if (interrupt && bot.unread().length) {
      await new Promise(r => setTimeout(r, 150))
      return { actionId: a.id, type: a.type, status: 'running', interrupted: true, events: takeUnread(bot),
        hint: '等待因新消息中断, 动作仍在执行; 处理完可再次 wait_action 继续等 (或 act stop 停下)' }
    }
    if (interrupt) await bot.waitImportant(Math.min(400, deadline - Date.now()))
    else await new Promise(ok => setTimeout(ok, Math.min(400, Math.max(1, deadline - Date.now()))))
  }
  const a = pick()
  if (!a) return { timeout: true }
  if (a.status !== 'running') return actionResult(a)
  return { timeout: true, actionId: a.id, type: a.type, status: a.status, hint: '动作还在执行: wait_action{actionId} 继续等, 或 act stop 停下' }
}

// ---------- 脚本 ----------

function findScript (bot: BotAgent, id?: any): ScriptAction | null {
  if (id != null) { const a = bot.getAction(Number(id)); return a instanceof ScriptAction ? a : null }
  const l = bot.latestAction
  if (l instanceof ScriptAction) return l
  let best: ScriptAction | null = null
  for (const a of bot.actions.values()) if (a instanceof ScriptAction && (!best || a.id > best.id)) best = a
  return best
}

/** 动作结束时的返回: 脚本附完整报告 */
function actionResult (a: Action) {
  if (a instanceof ScriptAction) return { actionId: a.id, type: a.type, detail: a.detail, ...a.report(0, 40) }
  const props = a.extra?.proposals
  return { actionId: a.id, type: a.type, status: a.status, detail: a.detail, ...a.extra, ...(Array.isArray(props) && props.length ? { hint: PROPOSAL_HINT } : {}), ...(a.warning ? { warning: a.warning } : {}) }
}

// ---------- 收件箱 ----------

/** 取出全部未读重要消息并标为已读 */
function takeUnread (bot: BotAgent) {
  const u = bot.unread()
  if (u.length) bot.markRead(u[u.length - 1].seq)
  return u.map(m => ({ seq: m.seq, kind: m.kind, text: m.text, ...(m.key ? { key: m.key } : {}), ago_s: Math.round((Date.now() - m.at) / 1000) }))
}

/** 不直接返回消息的工具: 结果末尾附加未读提醒 (不标已读, 直到 read_chat/wait_event 看过) */
const NO_INBOX = new Set(['read_chat', 'wait_event', 'list_agents', 'spawn_agent', 'kill_agent'])
function withInbox (role: Role, tool: string, args: any, r: any) {
  if (NO_INBOX.has(tool) || !r?.content) return r
  const name = role.kind === 'agent' ? role.name : String(args?.name ?? '')
  const bot = name ? manager.agents.get(name) : undefined
  if (!bot || bot.phase !== 'play') return r
  const u = bot.unread()
  if (!u.length) return r
  const inbox = { unread: u.length, latest: u.slice(-3).map(m => m.text), hint: 'read_chat 查看并标为已读' }
  return { ...r, content: [...r.content, { type: 'text', text: JSON.stringify({ inbox }) }] }
}

// ---------- 操作日志 ----------

/** 只读查询类工具: 日志里标为 query, WebUI 默认折叠 */
const QUERY_TOOLS = new Set(['list_agents', 'get_scene', 'get_view', 'get_map', 'read_chat', 'wait_action', 'script_status', 'wait_event', 'get_block', 'find_block', 'list_inventory', 'get_container'])

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
      if (action === 'view' || action === 'map') {
        const n = (k: string) => url.searchParams.has(k) ? Number(url.searchParams.get(k)) : undefined
        const r = action === 'view' ? await viewTool(bot, n('w'), n('h'), n('fov')) : await mapTool(bot, n('r'), n('s'), url.searchParams.get('mode') ?? undefined)
        if (url.searchParams.has('text')) return json(res, 200, { text: r.text })
        return pngRes(res, r.buf)
      }
      if (action === 'chat' && req.method === 'GET') return json(res, 200, bot.readChat(Number(url.searchParams.get('since') ?? 0)))
      if (action === 'block') return json(res, 200, { block: bot.world.getBlock(Number(url.searchParams.get('x')), Number(url.searchParams.get('y')), Number(url.searchParams.get('z')))?.name ?? null })
      if (action === 'inventory') return json(res, 200, { items: bot.inventory.list() })
      if (action === 'find_block') return json(res, 200, { hits: bot.world.findBlock(String(url.searchParams.get('name') ?? ''), Math.floor(bot.pos.x), Math.floor(bot.pos.z), Math.min(128, Number(url.searchParams.get('r') ?? 48)), 5, Math.floor(bot.pos.y)) })
      if (action === 'action' && req.method === 'GET') {
        const id = Number(url.searchParams.get('id') ?? 0)
        const a = id ? bot.getAction(id) : bot.activeAction
        return json(res, 200, a ? (a instanceof ScriptAction ? { actionId: a.id, type: a.type, detail: a.detail, ...a.report(Number(url.searchParams.get('since') ?? 0)) } : actionResult(a)) : { action: null })
      }
      if (req.method === 'POST') {
        const body = await readJson(req)
        const logArgs = { ...body, name: target }
        if (action === 'say') { bot.say(String(body.text ?? '')); logCall(role, 'rest', 'say', logArgs, 0, txt('{"ok":true}')); return json(res, 200, { ok: true }) }
        if (action === 'look') { bot.look(Number(body.yaw ?? bot.yaw), Number(body.pitch ?? bot.pitch)); logCall(role, 'rest', 'look', logArgs, 0, txt('{"ok":true}')); return json(res, 200, { ok: true }) }
        if (action === 'act') {
          const a = bot.act(String(body.type), body)
          const out = actionResult(a)
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
      const r = withInbox(role, name, args, await handleTool(role, name, args))
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
