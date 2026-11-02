/**
 * M1 spike: 以 protocol 777 (26.3) offline 身份连接本机服务器，
 * 验证: 登录/配置态/play 态、teleport_confirm、position+tick_end 门控、聊天接收。
 */
import mc from 'minecraft-protocol'

const HOST = process.env.MC_HOST || '127.0.0.1'
const PORT = Number(process.env.MC_PORT || 25565)
const NAME = process.env.MC_NAME || 'Agent_A'
const DURATION = Number(process.env.DURATION || 60_000)

const client = mc.createClient({
  host: HOST,
  port: PORT,
  username: NAME,
  version: '26.3',
  auth: 'offline',
})

let pos = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }
let spawned = false
let confirmed = false
const stats: Record<string, number> = {}
const t0 = Date.now()

// 伪装 Fabric 客户端: 进入配置态立即注册 fabric:registry/sync 频道 + brand，
// 否则 Fabric 服务器判定"未装 Fabric"并断开
client.on('state', (newState: string) => {
  if (newState === mc.states.CONFIGURATION) {
    console.log('[state] -> configuration, registering fabric channels')
    client.write('custom_payload', {
      channel: 'minecraft:register',
      data: Buffer.from('fabric:registry/sync\0'),
    })
    client.write('custom_payload', {
      channel: 'minecraft:brand',
      data: Buffer.concat([Buffer.from([6]), Buffer.from('fabric')]), // varint 长度前缀 + utf8
    })
  }
})

// Fabric 注册表同步: 收到 fabric:registry/sync 必须回 fabric:registry/sync/complete
client.on('custom_payload', (p: any) => {
  if (p.channel === 'fabric:registry/sync') {
    console.log('[fabric] registry/sync received -> replying sync/complete')
    client.write('custom_payload', { channel: 'fabric:registry/sync/complete', data: Buffer.alloc(0) })
  }
})

client.on('login', (packet: any) => {
  console.log(`[login] eid=${packet.entityId} gamemode=${packet.gameMode} world=${packet.worldNames?.[0] ?? '?'} dim=${packet.dimension?.toString().slice(0, 80)}`)
})

client.on('position', (packet: any) => {
  // 服务端强制传送: flags 位掩码标记哪些字段是相对量
  const f = packet.flags ?? 0
  const rel = (bit: number) => (f & (1 << bit)) !== 0
  pos = {
    x: packet.x + (rel(0) ? pos.x : 0),
    y: packet.y + (rel(1) ? pos.y : 0),
    z: packet.z + (rel(2) ? pos.z : 0),
    yaw: packet.yaw ?? 0,
    pitch: packet.pitch ?? 0,
  }
  console.log(`[position] teleportId=${packet.teleportId} -> x=${pos.x.toFixed(1)} y=${pos.y.toFixed(1)} z=${pos.z.toFixed(1)} flags=${JSON.stringify(packet.flags)}`)
  // 26.3: teleport_confirm 必须回显解析后的坐标和朝向
  client.write('teleport_confirm', { teleportId: packet.teleportId, x: pos.x, y: pos.y, z: pos.z, yRot: pos.yaw, xRot: pos.pitch })
  if (!spawned) {
    spawned = true
    startLoop()
  }
})

client.on('system_chat', (packet: any) => {
  try {
    const nbt = packet.content
    const text = extractText(nbt)
    if (text) console.log(`[system_chat] ${text}`)
  } catch (e) { console.log('[system_chat] <parse fail>', JSON.stringify(packet.content).slice(0, 120)) }
})

client.on('player_chat', (packet: any) => {
  console.log(`[player_chat] ${packet.senderName ? JSON.stringify(packet.senderName).slice(0, 60) + ': ' : ''}${packet.plainMessage ?? ''}`)
})

// 配置阶段/play 态的 ping 必须立即回 pong，否则服务器会卡住不发注册表
client.on('ping', (packet: any) => {
  console.log(`[ping] id=${packet.id} state=${client.state} -> pong`)
  client.write('pong', { id: packet.id })
})

client.on('kick', (reason: any) => {
  console.log(`[KICKED] after ${((Date.now() - t0) / 1000).toFixed(1)}s:`, JSON.stringify(reason).slice(0, 500))
  process.exit(1)
})
client.on('end', (reason: any) => {
  console.log(`[END] after ${((Date.now() - t0) / 1000).toFixed(1)}s:`, String(reason).slice(0, 300))
  process.exit(spawned && Date.now() - t0 > DURATION * 0.9 ? 0 : 1)
})
client.on('error', (err: any) => {
  console.log(`[ERROR]`, err?.message ?? err)
  process.exit(1)
})

client.on('packet', (data: any, meta: any) => {
  stats[meta.name] = (stats[meta.name] ?? 0) + 1
  if (meta.name === 'map_chunk' && stats.map_chunk === 1) console.log('[map_chunk] first chunk column arrived')
})

function startLoop() {
  const iv = setInterval(() => {
    if (!confirmed) confirmed = true
    client.write('position', { x: pos.x, y: pos.y, z: pos.z, flags: { onGround: true, hasHorizontalCollision: false } })
    client.write('tick_end', {})
  }, 50)
  setTimeout(() => {
    // 存活到时: 试着说话再退出
    try {
      client.write('chat_message', {
        message: 'spike ok, bye',
        timestamp: BigInt(Date.now()),
        salt: BigInt(0),
        signature: undefined,
        offset: 0,
        acknowledged: Buffer.alloc(3),
        checksum: 0,
      })
    } catch (e) { console.log('[chat send fail]', (e as Error).message) }
    setTimeout(() => {
      clearInterval(iv)
      console.log('\n=== SURVIVED', ((Date.now() - t0) / 1000).toFixed(1), 's ===')
      console.log('top packets:', Object.entries(stats).sort((a, b) => b[1] - a[1]).slice(0, 12))
      client.end()
      process.exit(0)
    }, 1000)
  }, DURATION)
}

// 从聊天 NBT (anonymousNbt) 提取纯文本
function extractText(nbt: any): string {
  if (nbt == null) return ''
  if (typeof nbt === 'string') return nbt
  const out: string[] = []
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return
    if (typeof node.text === 'string') out.push(node.text)
    const extra = node.extra ?? (node.value?.extra?.value)
    if (Array.isArray(extra)) extra.forEach(walk)
    else if (extra?.value) walk(extra.value)
  }
  // protodef anonymousNbt: { name, type, value: { text: {value,type}, extra: {...} } }
  const root = nbt.value ?? nbt
  walk(root)
  if (out.length === 0 && nbt.type === 'string') return String(nbt.value)
  return out.join('')
}

console.log(`connecting to ${HOST}:${PORT} as ${NAME} (26.3 / proto 777)...`)
