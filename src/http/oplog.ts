/**
 * agent 操作日志: 内存环形缓冲 (webui 增量拉取) + 按角色追加 JSONL 落盘 (~/.mc-agent/logs/<名>.jsonl)。
 * 重启后从文件尾部恢复最近记录; 单文件超过 5MB 轮转 (.1 → .2 → .3, 共保留 3 份旧文件)。
 */
import { appendFile, mkdirSync, readFileSync, existsSync, statSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { MC_AGENT_HOME } from '../paths.js'

export type LogKind = 'tool' | 'query' | 'action' | 'conn' | 'admin' | 'reflex'
export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  seq: number
  at: number
  agent: string
  kind: LogKind
  level: LogLevel
  text: string
  data?: Record<string, unknown>
}

const MAX_MEM = 5000
const RESTORE_PER_AGENT = 500
const ROTATE_BYTES = 5 * 1024 * 1024
const ROTATE_KEEP = 3
/** 当前文件 + 各代旧文件, 新到旧 */
const generations = (f: string) => [f, ...Array.from({ length: ROTATE_KEEP }, (_, i) => `${f}.${i + 1}`)]

export class OpLog {
  private entries: LogEntry[] = []
  private seq = 0
  private dir = join(MC_AGENT_HOME, 'logs')

  constructor () {
    mkdirSync(this.dir, { recursive: true })
  }

  /** 从各角色日志文件尾部恢复 (seq 重新编号, 保持时间序) */
  restore (names: string[]) {
    const restored: LogEntry[] = []
    for (const name of names) {
      const f = this.fileOf(name)
      // 刚轮转过时当前文件很短, 从旧文件补足最近记录
      let lines: string[] = []
      for (const file of generations(f)) {
        if (lines.length >= RESTORE_PER_AGENT || !existsSync(file)) continue
        const more = readFileSync(file, 'utf8').trimEnd().split('\n').filter(Boolean)
        lines = [...more.slice(-(RESTORE_PER_AGENT - lines.length)), ...lines]
      }
      for (const l of lines) { try { restored.push(JSON.parse(l)) } catch {} }
    }
    restored.sort((a, b) => a.at - b.at)
    for (const e of restored) this.entries.push({ ...e, seq: ++this.seq })
    this.trim()
  }

  add (agent: string, kind: LogKind, text: string, data?: Record<string, unknown>, level: LogLevel = 'info'): LogEntry {
    const e: LogEntry = { seq: ++this.seq, at: Date.now(), agent, kind, level, text, ...(data ? { data } : {}) }
    this.entries.push(e)
    this.trim()
    this.persist(e)
    return e
  }

  /** since 之后的记录; agent 为空 = 全部角色; 只返回最新 limit 条 */
  query (opts: { agent?: string, since?: number, limit?: number, kinds?: Set<string> }): { entries: LogEntry[], lastSeq: number } {
    const since = opts.since ?? 0
    const out = this.entries.filter(e => e.seq > since && (!opts.agent || e.agent === opts.agent) && (!opts.kinds || opts.kinds.has(e.kind)))
    return { entries: out.slice(-(opts.limit ?? 300)), lastSeq: this.seq }
  }

  lastAt (agent: string): number | null {
    for (let i = this.entries.length - 1; i >= 0; i--) if (this.entries[i].agent === agent) return this.entries[i].at
    return null
  }

  /** 角色删除时归档其日志文件, 以免日后同名新角色继承旧历史 */
  archive (agent: string) {
    const f = this.fileOf(agent), stamp = new Date().toISOString().replace(/[:.]/g, '-')
    for (const file of generations(f)) {
      try { if (existsSync(file)) renameSync(file, file.replace(/\.jsonl/, `.deleted-${stamp}.jsonl`)) } catch {}
    }
    this.entries = this.entries.filter(e => e.agent !== agent)
  }

  private trim () {
    if (this.entries.length > MAX_MEM) this.entries.splice(0, this.entries.length - MAX_MEM)
  }

  private fileOf (agent: string) { return join(this.dir, `${agent.replace(/[^A-Za-z0-9_]/g, '_')}.jsonl`) }

  private persist (e: LogEntry) {
    const f = this.fileOf(e.agent)
    try {
      if (statSync(f).size > ROTATE_BYTES) {
        const gens = generations(f)
        for (let i = gens.length - 1; i > 0; i--) if (existsSync(gens[i - 1])) renameSync(gens[i - 1], gens[i]) // 最老的被覆盖
      }
    } catch {}
    const { seq: _seq, ...rest } = e
    appendFile(f, JSON.stringify(rest) + '\n', () => {})
  }
}
