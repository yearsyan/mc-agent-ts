#!/usr/bin/env node
/** 一键冒烟: Agent_A token 自动上线 → 场景 → 挖掘 → 说话 (REST 路由, agent token 语义) */
const home = process.env.MC_AGENT_HOME ?? `${process.env.HOME}/.mc-agent`
const port = process.env.API_PORT ?? '8767'
const { agents } = JSON.parse((await import('node:fs')).readFileSync(`${home}/tokens.json`, 'utf8'))
const T = agents['Agent_A']
const H = { 'x-token': T, 'content-type': 'application/json' }
const api = async (method, path, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  try { return JSON.parse(text) } catch { return text }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const scene = await api('GET', '/agents/scene')
console.log('scene(自动上线): pos:', scene.position, '| standing:', scene.standing_on, '| chunks:', scene.world?.chunks_loaded)

const x = Math.floor(scene.position.x) + 1
const y = Math.floor(scene.position.y) - 1
const z = Math.floor(scene.position.z)
console.log('dig:', await api('POST', '/agents/act', { type: 'dig', x, y, z }))
await sleep(5000)
console.log('结果:', await api('GET', '/agents/action'))
console.log('say:', await api('POST', '/agents/say', { text: '冒烟测试: 单一服务 + token 即角色 + MCP/HTTP 一切正常' }))
