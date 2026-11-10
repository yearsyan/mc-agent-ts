/**
 * 核对 docs/DESIGN.md 的 act 动作表有没有漏掉动作规格表 (src/actions/registry.ts) 里的动作。
 * 用法: pnpm check:actions          (有遗漏时退出码 1)
 *       pnpm check:actions --print  (另外打印生成的 act 动作清单, 看描述长什么样)
 */
import { readFileSync } from 'node:fs'
import { ACTION_TYPES, actionCatalog, signature } from '../src/actions/registry.js'

const doc = readFileSync(new URL('../docs/DESIGN.md', import.meta.url), 'utf8')
const a = doc.indexOf('### act 动作')
const section = doc.slice(a, doc.indexOf('\n### ', a + 1))
if (a < 0) { console.error('docs/DESIGN.md 里找不到 "### act 动作" 一节'); process.exit(1) }

// 动作名要以 `name` 或 `name{...}` 的形式出现在该节
const missing = ACTION_TYPES.filter(t => !new RegExp('`' + t + '[`{]').test(section))
if (process.argv.includes('--print')) console.log(actionCatalog() + '\n')
if (missing.length) {
  console.error(`docs/DESIGN.md 的 act 动作表缺 ${missing.length} 个动作:\n` + missing.map(t => '  ' + signature(t)).join('\n'))
  process.exit(1)
}
console.log(`docs/DESIGN.md 动作表与规格表一致 (${ACTION_TYPES.length} 个动作)`)
