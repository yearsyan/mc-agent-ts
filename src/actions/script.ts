/**
 * 脚本动作: agent 写一段 JS, 在 node:vm 里跑, 编排现有动作 (await dig/moveTo/...) + 同步查询世界。
 * - 每个子动作都走 bot.makeAction + sub(): 寻路/换工具/防岩浆等能力全部复用, 取消/死亡自动传播
 * - 沙箱只防误伤不防恶意: 禁用 eval/new Function, 循环体插守卫 (可中止、防同步死循环卡住 tick)
 * - 执行追踪: log()/progress() + 自动统计 (挖了什么、物品增减、位移、血量饥饿变化、子动作成败)
 */
import vm from 'node:vm'
import * as acorn from 'acorn'
import { AsyncAction, Cancelled } from './base.js'
import type { BotAgent } from '../conn/bot.js'
import { blockName } from '../world/world.js'
import { isHostile } from '../game/knowledge.js'

const AIRISH = new Set(['air', 'cave_air', 'void_air'])
/** 两次让出 (await 动作/sleep) 之间允许的同步执行时间 */
const SYNC_LIMIT_MS = 1500
const MAX_LOGS = 300
/** vm 里脚本的文件名 (错误栈里据此找行号, 不能和源码文件重名) */
const SCRIPT_FILE = 'agent-script'
const DEFAULT_TIMEOUT_MS = 300_000
const MAX_TIMEOUT_MS = 1_800_000
/** 脚本里不能再起的动作 */
const BANNED = new Set(['script', 'stop'])

// ---------- 向量 ----------

export class Vec {
  constructor (public x: number, public y: number, public z: number) {}
  add (o: any, y?: number, z?: number) { const v = toVec(o, y, z); return new Vec(this.x + v.x, this.y + v.y, this.z + v.z) }
  sub (o: any, y?: number, z?: number) { const v = toVec(o, y, z); return new Vec(this.x - v.x, this.y - v.y, this.z - v.z) }
  offset (dx: number, dy: number, dz: number) { return new Vec(this.x + dx, this.y + dy, this.z + dz) }
  mul (k: number) { return new Vec(this.x * k, this.y * k, this.z * k) }
  up (n = 1) { return this.offset(0, n, 0) }
  down (n = 1) { return this.offset(0, -n, 0) }
  north (n = 1) { return this.offset(0, 0, -n) }
  south (n = 1) { return this.offset(0, 0, n) }
  east (n = 1) { return this.offset(n, 0, 0) }
  west (n = 1) { return this.offset(-n, 0, 0) }
  /** 水平方向向量右转 90° (俯视顺时针: 南→西→北→东) */
  right () { return new Vec(-this.z, this.y, this.x) }
  left () { return new Vec(this.z, this.y, -this.x) }
  floored () { return new Vec(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)) }
  dist (o: any) { const v = toVec(o); return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z) }
  equals (o: any) { const v = toVec(o); return this.x === v.x && this.y === v.y && this.z === v.z }
  toString () { return `(${this.x},${this.y},${this.z})` }
  toJSON () { return { x: this.x, y: this.y, z: this.z } }
}

/** 接受 Vec / {x,y,z} / [x,y,z] / (x,y,z) */
function toVec (a: any, y?: number, z?: number): Vec {
  if (typeof a === 'number') return new Vec(a, Number(y), Number(z))
  if (Array.isArray(a)) return new Vec(+a[0], +a[1], +a[2])
  if (a && typeof a === 'object' && 'x' in a && 'z' in a) return new Vec(+a.x, +(a.y ?? 0), +a.z)
  throw new Error(`需要坐标 (Vec / {x,y,z} / x,y,z), 收到 ${JSON.stringify(a)}`)
}
const blockVec = (a: any, y?: number, z?: number) => toVec(a, y, z).floored()

const DIRS: Record<string, Vec> = { north: new Vec(0, 0, -1), south: new Vec(0, 0, 1), east: new Vec(1, 0, 0), west: new Vec(-1, 0, 0), up: new Vec(0, 1, 0), down: new Vec(0, -1, 0) }

// ---------- 插桩 ----------

const GUARD = '__guard$'

/** 解析脚本并在每个循环体开头插入守卫调用 (不改变行号); 语法错误抛出带行列号的 Error */
export function instrument (code: string): string {
  let ast: any
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true, locations: true })
  } catch (e: any) {
    throw new Error(`语法错误 第 ${e.loc?.line ?? '?'} 行: ${String(e.message).replace(/\s*\(\d+:\d+\)$/, '')}`)
  }
  const ins: { pos: number, text: string }[] = []
  const LOOPS = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement'])
  const walk = (n: any) => {
    if (!n || typeof n.type !== 'string') return
    if (LOOPS.has(n.type)) {
      const b = n.body
      if (b.type === 'BlockStatement') ins.push({ pos: b.start + 1, text: `${GUARD}();` })
      else { ins.push({ pos: b.start, text: `{${GUARD}();` }); ins.push({ pos: b.end, text: '}' }) }
    }
    for (const k in n) {
      if (k === 'loc') continue
      const v = n[k]
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v)
    }
  }
  walk(ast)
  ins.sort((a, b) => b.pos - a.pos)
  let out = code
  for (const i of ins) out = out.slice(0, i.pos) + i.text + out.slice(i.pos)
  return out
}

// ---------- 脚本动作 ----------

interface LogEntry { n: number, t: number, text: string }

export interface ScriptOptions { timeoutMs?: number, args?: any }

export class ScriptAction extends AsyncAction {
  readonly lines: string[]
  private logs: LogEntry[] = []
  private logSeq = 0
  private progressData: any = undefined
  result: any = undefined
  error: { message: string, line?: number, code?: string } | null = null
  private readonly timeoutMs: number
  private timer: NodeJS.Timeout | null = null
  private syncSince = Date.now()
  private guardCount = 0
  private startedAt = Date.now()
  // 统计
  private inv0: Record<string, number> = {}
  private hp0 = 0
  private food0 = 0
  private moved = 0
  private lastPos: { x: number, y: number, z: number } | null = null
  private dug: Record<string, number> = {}
  private placed: Record<string, number> = {}
  private subStats: Record<string, { ok: number, failed: number }> = {}
  private current: string | null = null

  constructor (bot: BotAgent, private code: string, private opts: ScriptOptions = {}) {
    super(bot, 'script')
    if (!code.trim()) throw new Error('script 需要参数 code')
    this.lines = code.split('\n')
    this.timeoutMs = Math.max(1000, Math.min(MAX_TIMEOUT_MS, Number(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS))
    instrument(code) // 语法错误在 act 时就同步报出
  }

  // ---- 执行追踪 ----

  private log (text: string) {
    this.logs.push({ n: ++this.logSeq, t: +((Date.now() - this.startedAt) / 1000).toFixed(1), text: text.slice(0, 400) })
    if (this.logs.length > MAX_LOGS) this.logs.shift()
  }

  step () {
    const p = this.bot.pos
    if (this.lastPos) {
      const d = Math.hypot(p.x - this.lastPos.x, p.y - this.lastPos.y, p.z - this.lastPos.z)
      if (d < 8) this.moved += d // 更大的跳变是传送/复活, 不计
    }
    this.lastPos = { x: p.x, y: p.y, z: p.z }
  }

  /** 进度报告: 状态/返回值/错误 + 日志 (since 之后的, 最多 limit 条) + 统计 */
  report (since = 0, limit = 40) {
    const inv = this.bot.inventory.summary()
    const items: Record<string, number> = {}
    for (const k of new Set([...Object.keys(inv), ...Object.keys(this.inv0)])) {
      const d = (inv[k] ?? 0) - (this.inv0[k] ?? 0)
      if (d) items[k] = d
    }
    const newLogs = this.logs.filter(l => l.n > since)
    return {
      scriptId: this.id,
      status: this.status,
      elapsed_s: +((Date.now() - this.startedAt) / 1000).toFixed(1),
      ...(this.status === 'running' && this.current ? { current: this.current } : {}),
      ...(this.result !== undefined ? { result: this.result } : {}),
      ...(this.error ? { error: this.error } : this.status !== 'running' && this.status !== 'done' && this.detail ? { error: { message: this.detail } } : {}),
      ...(this.progressData !== undefined ? { progress: this.progressData } : {}),
      logs: newLogs.slice(-limit).map(l => `[${l.n} ${l.t}s] ${l.text}`),
      ...(newLogs.length > limit ? { logs_skipped: newLogs.length - limit } : {}),
      log_seq: this.logSeq,
      stats: {
        dug: this.dug,
        placed: this.placed,
        items,
        moved: +this.moved.toFixed(1),
        hp: `${this.hp0}→${Math.round(this.bot.health)}`,
        food: `${this.food0}→${this.bot.food}`,
        actions: this.subStats,
      },
    }
  }

  // ---- 运行 ----

  protected async run (): Promise<string> {
    const bot = this.bot
    this.startedAt = Date.now()
    this.inv0 = bot.inventory.summary()
    this.hp0 = Math.round(bot.health)
    this.food0 = bot.food
    this.timer = setTimeout(() => {
      this.error = { message: `脚本超时 (${this.timeoutMs / 1000}s)` }
      this.fail(this.error.message)
    }, this.timeoutMs)

    const src = `"use strict";return (async () => {${instrument(this.code)}\n})()`
    const ctx = vm.createContext(this.api(), { codeGeneration: { strings: false, wasm: false }, name: `script#${this.id}` })
    try {
      const fn = new vm.Script(`(function(){${src}})`, { filename: SCRIPT_FILE }).runInContext(ctx, { timeout: SYNC_LIMIT_MS })
      this.syncSince = Date.now()
      const ret = await fn()
      this.check()
      this.result = jsonable(ret)
      const r = this.result === undefined ? '' : JSON.stringify(this.result)
      return `脚本完成${r ? ': ' + r.slice(0, 300) : ''}`
    } catch (e: any) {
      if (e instanceof Cancelled || this.status !== 'running') throw new Cancelled()
      const line = e?.scriptLine ?? errorLine(e)
      this.error = { message: String(e?.message ?? e), ...(line ? { line, code: this.lines[line - 1]?.trim().slice(0, 200) } : {}) }
      throw new Error(`${line ? `第 ${line} 行: ` : ''}${this.error.message}`)
    }
  }

  protected cleanup () {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.current = null
  }

  /** 每次进入 API: 已取消/超时则抛出, 让脚本 (含 catch 了的) 尽快停下 */
  private enter () {
    if (this.status !== 'running') throw new Cancelled()
  }

  private guard () {
    if (this.status !== 'running') throw new Cancelled()
    if ((++this.guardCount & 255) === 0 && Date.now() - this.syncSince > SYNC_LIMIT_MS) {
      throw new Error(`同步执行超过 ${SYNC_LIMIT_MS / 1000}s 没有让出 (循环里要 await 动作或 sleep, 否则会卡住 bot)`)
    }
  }

  /** 跑一个子动作; 失败时 throwOnFail 则抛错 */
  private async runSub (type: string, params: any, throwOnFail = true): Promise<{ ok: boolean, status: string, detail: string, extra?: Record<string, unknown> }> {
    this.enter()
    if (BANNED.has(type)) throw new Error(`脚本里不能用 ${type} (要停下就 return 或 throw)`)
    // 调用时的同步栈里有脚本帧: 记下行号 (await 之后再抛错就找不到了)
    const line = errorLine(new Error())
    const a = this.bot.makeAction(type, params ?? {}, { script: true })
    const digName = type === 'dig' ? this.bot.world.getBlock(Math.floor(params.x), Math.floor(params.y), Math.floor(params.z))?.name : undefined
    this.current = `${type} ${JSON.stringify(params ?? {})}`.slice(0, 160)
    try {
      await this.sub(a)
    } finally {
      this.syncSince = Date.now()
      this.current = null
    }
    const st = this.subStats[type] ??= { ok: 0, failed: 0 }
    if (a.status === 'done' && digName) this.dug[digName] = (this.dug[digName] ?? 0) + 1
    // 寻路途中改动的地形 (move_to / collect 等带 allow_dig / allow_place 时)
    const route = a.extra?.route as { dug: { block: string }[], placed: { block: string }[] } | undefined
    for (const e of route?.dug ?? []) this.dug[e.block] = (this.dug[e.block] ?? 0) + 1
    for (const e of route?.placed ?? []) this.placed[e.block] = (this.placed[e.block] ?? 0) + 1
    if (a.status === 'done') st.ok++
    else st.failed++
    if (a.status !== 'done' && throwOnFail) throw Object.assign(new Error(`${type} 失败: ${a.detail}`), { scriptLine: line, ...(a.extra ? { extra: a.extra } : {}) })
    return { ok: a.status === 'done', status: a.status, detail: a.detail, ...(a.extra ? { extra: a.extra } : {}) }
  }

  /** 注入脚本的全局 API */
  private api () {
    const bot = this.bot
    const world = bot.world
    const self = this
    const run = (type: string, params: any) => this.runSub(type, params).then(r => r.detail)
    const nameAt = (v: Vec) => world.getBlock(v.x, v.y, v.z)?.name ?? null

    const matcher = (m: any): ((name: string) => boolean) => {
      if (typeof m === 'string') {
        if (!m.includes('*')) return n => n === m
        const re = new RegExp('^' + m.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
        return n => re.test(n)
      }
      if (Array.isArray(m)) { const s = new Set(m.map(String)); return n => s.has(n) }
      if (m && typeof m.test === 'function') return n => { m.lastIndex = 0; return m.test(n) }
      if (typeof m === 'function') return n => !!m(n)
      throw new Error('scan 的 match 需要方块名 / 通配符如 "*_ore" / 名字数组 / 正则')
    }

    return {
      args: jsonable(this.opts.args),
      Vec, vec: (x: any, y?: number, z?: number) => toVec(x, y, z),
      [GUARD]: () => this.guard(),
      console: { log: (...a: any[]) => self.log(fmt(a)) },

      // ---- 输出 ----
      log: (...a: any[]) => { self.enter(); self.log(fmt(a)) },
      progress: (data: any) => { self.enter(); self.progressData = jsonable(data) },
      say: (text: string) => { self.enter(); bot.say(String(text).slice(0, 256)) },
      sleep: async (ms: number) => {
        self.enter()
        await self.sleep(Math.max(0, Math.min(60_000, Number(ms) || 0)))
        self.syncSince = Date.now()
      },
      elapsed: () => Date.now() - self.startedAt,

      // ---- 查询 (同步) ----
      pos: () => new Vec(+bot.pos.x.toFixed(2), +bot.pos.y.toFixed(2), +bot.pos.z.toFixed(2)),
      here: () => new Vec(Math.floor(bot.pos.x), Math.floor(bot.pos.y + 0.01), Math.floor(bot.pos.z)),
      block: (a: any, y?: number, z?: number) => nameAt(blockVec(a, y, z)),
      isAir: (a: any, y?: number, z?: number) => { const n = nameAt(blockVec(a, y, z)); return n !== null && AIRISH.has(n) },
      /** 眼睛到方块中心的距离 (挖/放的触及范围约 4.5) */
      reach: (a: any, y?: number, z?: number) => { const v = blockVec(a, y, z); return +Math.hypot(v.x + 0.5 - bot.pos.x, v.y + 0.5 - (bot.pos.y + bot.eyeHeight), v.z + 0.5 - bot.pos.z).toFixed(2) },
      isSolid: (a: any, y?: number, z?: number) => { const v = blockVec(a, y, z); return world.isSolid(v.x, v.y, v.z) },
      scan: (match: any, radius = 8, limit = 64) => {
        const ok = matcher(match)
        const r = Math.max(1, Math.min(24, Math.floor(radius)))
        const c = new Vec(Math.floor(bot.pos.x), Math.floor(bot.pos.y + 0.01), Math.floor(bot.pos.z))
        const cache = new Map<number, string | null>()
        const out: { name: string, pos: Vec, dist: number }[] = []
        for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (let dy = -r; dy <= r; dy++) {
          const s = world.stateAt(c.x + dx, c.y + dy, c.z + dz)
          if (s < 0) continue
          let n = cache.get(s)
          if (n === undefined) { const bn = blockName(s); n = ok(bn) ? bn : null; cache.set(s, n) }
          if (n) out.push({ name: n, pos: new Vec(c.x + dx, c.y + dy, c.z + dz), dist: +Math.hypot(dx, dy, dz).toFixed(1) })
        }
        out.sort((a, b) => a.dist - b.dist)
        self.syncSince = Math.max(self.syncSince, Date.now() - 200) // 大范围扫描本身耗时, 不算进同步超限
        return out.slice(0, Math.max(1, Math.min(500, limit)))
      },
      findBlock: (name: string, radius = 48, max = 5) =>
        world.findBlock(String(name), Math.floor(bot.pos.x), Math.floor(bot.pos.z), Math.min(128, radius), Math.min(50, max), Math.floor(bot.pos.y))
          .map(h => new Vec(h.x, h.y, h.z)),
      inv: () => bot.inventory.summary(),
      count: (item: string) => bot.inventory.count(String(item)),
      freeSlots: () => bot.inventory.emptySlots(),
      held: () => bot.inventory.held()?.name ?? null,
      hp: () => Math.round(bot.health),
      food: () => bot.food,
      state: () => ({
        pos: new Vec(+bot.pos.x.toFixed(2), +bot.pos.y.toFixed(2), +bot.pos.z.toFixed(2)),
        hp: Math.round(bot.health), food: bot.food, yaw: +bot.yaw.toFixed(1), pitch: +bot.pitch.toFixed(1),
        onGround: bot.onGround, inWater: bot.physics.inWater, swimming: bot.swimming, dimension: bot.dimension.replace(/^minecraft:/, ''),
      }),
      entities: (radius = 16, type?: string) => {
        const out: { id: number, type: string, pos: Vec, dist: number, hostile: boolean }[] = []
        for (const e of world.entities.values()) {
          if (type && e.type !== type) continue
          const d = Math.hypot(e.x - bot.pos.x, e.y - bot.pos.y, e.z - bot.pos.z)
          if (d <= radius) out.push({ id: e.id, type: e.type, pos: new Vec(+e.x.toFixed(1), +e.y.toFixed(1), +e.z.toFixed(1)), dist: +d.toFixed(1), hostile: isHostile(e.type) })
        }
        return out.sort((a, b) => a.dist - b.dist)
      },
      fwd: () => {
        // yaw: 0=南(+z) 90=西(-x) 180=北(-z) -90=东(+x)
        const k = ((Math.round(bot.yaw / 90) % 4) + 4) % 4
        return [DIRS.south, DIRS.west, DIRS.north, DIRS.east][k]
      },
      dir: (name: string) => { const d = DIRS[String(name)]; if (!d) throw new Error(`dir 只认 ${Object.keys(DIRS).join('/')}`); return d },
      look: (yaw: number, pitch = 0) => { self.enter(); bot.look(Number(yaw), Number(pitch)) },

      // ---- 动作 (async, 失败抛错) ----
      act: (type: string, params?: any) => run(String(type), params),
      tryAct: (type: string, params?: any) => self.runSub(String(type), params, false),
      moveTo: (a: any, b?: any, c?: number, d?: any) => {
        const isNum = typeof a === 'number'
        const v = isNum ? toVec(a, b, c) : toVec(a)
        const o = (isNum ? d : b) ?? {}
        return run('move_to', { x: v.x, y: v.y, z: v.z, ...(o.tolerance != null ? { tolerance: o.tolerance } : {}), ...(o.allowDig ? { allow_dig: true } : {}), ...(o.allowPlace ? { allow_place: true } : {}), ...(o.confirm ? { confirm: o.confirm } : {}), ...(o.maxDist ? { max_dist: o.maxDist } : {}) })
      },
      dig: async (a: any, y?: number, z?: number) => {
        const v = blockVec(a, y, z)
        const n = nameAt(v)
        self.enter()
        if (n === null || AIRISH.has(n)) return null // 空气/未加载: 不算失败
        await run('dig', { x: v.x, y: v.y, z: v.z })
        return n
      },
      place: (a: any, item?: string, face?: number) => { const v = blockVec(a); return run('place', { x: v.x, y: v.y, z: v.z, ...(item ? { item } : {}), ...(face != null ? { face } : {}) }) },
      collect: (block: string, count = 1, radius = 32) => run('collect', { block, count, radius }),
      pickup: (radius = 8) => run('pickup_items', { radius }),
      equip: (item: string) => run('equip', { item }),
      craft: (item: string, count = 1) => run('craft', { item, count }),
      smelt: (item: string, count = 1, fuel?: string) => run('smelt', { item, count, ...(fuel ? { fuel } : {}) }),
      eat: (item?: string) => run('eat', item ? { item } : {}),
      attack: (id: number, hits = 3) => run('attack', { entity_id: id, hits }),
      shoot: (id: number, shots = 5) => run('shoot', { entity_id: id, shots }),
      useBlock: (a: any, item?: string) => { const v = blockVec(a); return run('use_block', { x: v.x, y: v.y, z: v.z, ...(item ? { item } : {}) }) },
      useItem: (item?: string, holdMs = 0) => run('use_item', { ...(item ? { item } : {}), hold_ms: holdMs }),
      selectSlot: (slot: number) => run('select_slot', { slot }),
    }
  }
}

// ---------- 工具函数 ----------

function fmt (a: any[]): string {
  return a.map(x => typeof x === 'string' ? x : x instanceof Vec ? x.toString() : safeJson(x)).join(' ')
}

function safeJson (x: any): string {
  try {
    return JSON.stringify(x, (_k, v) => v instanceof Vec ? v.toString() : v) ?? String(x)
  } catch { return String(x) }
}

/** 转成可 JSON 序列化的值 (Vec → {x,y,z}), 太大的截断成字符串 */
function jsonable (v: any): any {
  if (v === undefined) return undefined
  try {
    const s = JSON.stringify(v)
    if (s === undefined) return String(v)
    if (s.length > 4000) return s.slice(0, 4000) + '…(截断)'
    return JSON.parse(s)
  } catch { return String(v) }
}

/** 从错误栈里找脚本内最深一帧的行号 */
function errorLine (e: any): number | undefined {
  const m = new RegExp(`${SCRIPT_FILE}:(\\d+)`).exec(String(e?.stack ?? ''))
  return m ? Number(m[1]) : undefined
}
