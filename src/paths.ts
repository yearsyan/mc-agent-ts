/**
 * 集中路径配置: MC_AGENT_HOME 环境变量可覆盖配置目录 (默认 ~/.mc-agent)。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const MC_AGENT_HOME: string = process.env.MC_AGENT_HOME
  ?? join(process.env.HOME ?? '.', '.mc-agent')

/** 确保目录存在 (幂等) */
export function ensureMcAgentHome (): string {
  mkdirSync(MC_AGENT_HOME, { recursive: true })
  return MC_AGENT_HOME
}
