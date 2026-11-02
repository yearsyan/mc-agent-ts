/**
 * token 存储: ~/.mc-agent/tokens.json (token 即角色)。
 * 格式 { admin, agents: {名: token}, disabled?: [名] } —— agents 仍是 名->字符串, 兼容 scripts/mcp_call.py 等旧读取方式。
 * 角色列表即 agents 的键; disabled 中的角色 token 仍能鉴权, 但禁止上线 (含自动重连)。
 */
import crypto from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { MC_AGENT_HOME, ensureMcAgentHome } from '../paths.js'

export type Role = { kind: 'admin' } | { kind: 'agent', name: string }

interface TokensFile { admin: string, agents: Record<string, string>, disabled?: string[] }

const DEFAULT_AGENTS = ['Agent_A', 'Agent_B', 'agent_c']
/** 原版用户名规则: 3-16 位字母数字下划线 */
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/

const newToken = () => crypto.randomBytes(16).toString('hex')

export class TokenStore {
  private data: TokensFile
  readonly file = join(MC_AGENT_HOME, 'tokens.json')

  constructor () {
    if (existsSync(this.file)) {
      this.data = JSON.parse(readFileSync(this.file, 'utf8'))
      this.data.agents ??= {}
    } else {
      ensureMcAgentHome()
      // 沿用旧单 token 作为 admin (若有)
      const legacy = join(MC_AGENT_HOME, 'token')
      const admin = existsSync(legacy) ? readFileSync(legacy, 'utf8').trim() : newToken()
      this.data = { admin, agents: {} }
      for (const n of DEFAULT_AGENTS) this.data.agents[n] = newToken()
      this.save()
    }
  }

  /** 原子写 (先写临时文件再 rename), 0600 */
  private save () {
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  get admin () { return this.data.admin }
  names (): string[] { return Object.keys(this.data.agents) }
  has (name: string) { return name in this.data.agents }
  tokenOf (name: string): string | undefined { return this.data.agents[name] }
  isDisabled (name: string) { return (this.data.disabled ?? []).includes(name) }
  /** 完整内容 (仅 admin 调试路由用) */
  raw (): TokensFile { return this.data }

  auth (token: string | undefined): Role | null {
    if (!token) return null
    if (safeEqual(token, this.data.admin)) return { kind: 'admin' }
    for (const [name, t] of Object.entries(this.data.agents)) {
      if (safeEqual(token, t)) return { kind: 'agent', name }
    }
    return null
  }

  add (name: string): string {
    if (!NAME_RE.test(name)) throw new Error('角色名须为 3-16 位字母/数字/下划线 (MC 用户名规则)')
    if (this.has(name)) throw new Error(`角色 ${name} 已存在`)
    const t = newToken()
    this.data.agents[name] = t
    this.save()
    return t
  }

  remove (name: string) {
    if (!this.has(name)) throw new Error(`未知角色 ${name}`)
    delete this.data.agents[name]
    this.data.disabled = (this.data.disabled ?? []).filter(n => n !== name)
    this.save()
  }

  /** 轮换: 旧 token 立即失效 */
  rotate (name: string): string {
    if (!this.has(name)) throw new Error(`未知角色 ${name}`)
    const t = newToken()
    this.data.agents[name] = t
    this.save()
    return t
  }

  setDisabled (name: string, disabled: boolean) {
    if (!this.has(name)) throw new Error(`未知角色 ${name}`)
    const set = new Set(this.data.disabled ?? [])
    if (disabled) set.add(name); else set.delete(name)
    this.data.disabled = [...set]
    this.save()
  }
}

function safeEqual (a: string, b: string) {
  const ba = Buffer.from(a), bb = Buffer.from(b)
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb)
}

export function maskToken (t: string) { return t.length > 8 ? `${t.slice(0, 4)}…${t.slice(-4)}` : '****' }
