/**
 * 可重现的 node_modules overlay 安装器：pnpm install 之后运行。
 * 1. 从 third_party/ 复制 26.2/26.3 数据目录进 minecraft-data
 * 2. 注册 dataPaths.json / data.js（26.2、26.3）
 * 3. 给 minecraft-protocol 打 entityDelta 补丁（若未打）
 * 4. 给 prismarine-chunk 注册 26.2/26.3 实现
 * 用法: pnpm exec tsx scripts/setup-overlay.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const MCD = path.join(root, 'node_modules/minecraft-data')
const NMP = path.join(root, 'node_modules/minecraft-protocol')
const PC = path.join(root, 'node_modules/prismarine-chunk')
const TP = path.join(root, 'third_party/minecraft-data-26.3')

function copyDir(src: string, dst: string) {
  fs.mkdirSync(dst, { recursive: true })
  for (const f of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, f), path.join(dst, f))
  }
}

// 1) 数据目录
copyDir(path.join(TP, 'pc-26.2'), path.join(MCD, 'minecraft-data/data/pc/26.2'))
copyDir(path.join(TP, 'pc-26.3'), path.join(MCD, 'minecraft-data/data/pc/26.3'))
console.log('[overlay] 数据目录已复制 (26.2, 26.3)')

// 2) dataPaths.json
const dpPath = path.join(MCD, 'minecraft-data/data/dataPaths.json')
const paths = JSON.parse(fs.readFileSync(dpPath, 'utf8'))
paths.pc['26.2'] = {
  attributes: 'pc/26.2', blockCollisionShapes: 'pc/26.2', blocks: 'pc/26.2', blockLoot: 'pc/26.2',
  biomes: 'pc/26.2', commands: 'pc/26.2', entities: 'pc/26.2', entityLoot: 'pc/26.2', foods: 'pc/26.2',
  items: 'pc/26.2', language: 'pc/26.2', loginPacket: 'pc/26.2', materials: 'pc/26.2', particles: 'pc/26.2',
  protocol: 'pc/26.2', recipes: 'pc/26.2', sounds: 'pc/26.2', tints: 'pc/26.2', version: 'pc/26.2',
  windows: 'pc/1.16.1', mapIcons: 'pc/1.20.2', proto: 'pc/26.2',
}
paths.pc['26.3'] = {
  attributes: 'pc/26.2', blockCollisionShapes: 'pc/26.3', blocks: 'pc/26.3', blockLoot: 'pc/26.2',
  biomes: 'pc/26.2', commands: 'pc/26.2', entities: 'pc/26.3', entityLoot: 'pc/26.2', foods: 'pc/26.3',
  items: 'pc/26.3', language: 'pc/26.2', loginPacket: 'pc/26.2', materials: 'pc/26.2', particles: 'pc/26.2',
  protocol: 'pc/26.3', recipes: 'pc/26.3', sounds: 'pc/26.2', tints: 'pc/26.2', version: 'pc/26.3',
  effects: 'pc/26.3', enchantments: 'pc/26.3', instruments: 'pc/26.3',
  windows: 'pc/1.16.1', mapIcons: 'pc/1.20.2', proto: 'pc/26.3',
}
fs.writeFileSync(dpPath, JSON.stringify(paths, null, 2))

// 3) data.js：注入 26.2/26.3 懒加载块（若缺）
const dataJs = path.join(MCD, 'data.js')
let src = fs.readFileSync(dataJs, 'utf8')
if (!src.includes("'26.3': {")) {
  function blockFor(ver: string, m: Record<string, string>) {
    const lines = [`    '${ver}': {`]
    for (const k of Object.keys(m)) {
      if (k === 'windows' || k === 'mapIcons' || k === 'proto') continue
      lines.push(`      get ${k} () { return require("./minecraft-data/data/${m[k]}/${k}.json") },`)
    }
    lines.push(`      proto: __dirname + '/minecraft-data/data/${m.proto}/proto.yml'`)
    lines.push('    }')
    return lines.join('\n')
  }
  const key = "'26.1': {"
  const start = src.indexOf(key)
  if (start < 0) throw new Error('26.1 块未找到，minecraft-data 结构可能变了')
  let i = src.indexOf('{', start), depth = 0, end = -1
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break } }
  }
  src = src.slice(0, end + 1) + ',\n' + blockFor('26.2', paths.pc['26.2']) + ',\n' + blockFor('26.3', paths.pc['26.3']) + src.slice(end + 1)
  fs.writeFileSync(dataJs, src)
  console.log('[overlay] data.js 已注入 26.2/26.3')
} else {
  console.log('[overlay] data.js 已包含 26.3，跳过')
}

// 4) minecraft-protocol entityDelta 补丁（检测 + 调 python? 不，直接检测后提示用 scripts/apply_nmp_patch.py）
const mcJs = path.join(NMP, 'src/datatypes/minecraft.js')
if (!fs.readFileSync(mcJs, 'utf8').includes('entityDelta')) {
  console.log('[overlay] 警告: minecraft-protocol 缺 entityDelta，请运行: python3 scripts/apply_nmp_patch.py third_party/patches/nmp-entityDelta.diff node_modules/minecraft-protocol')
} else {
  console.log('[overlay] minecraft-protocol entityDelta 已就位')
}

// 5) prismarine-chunk 版本注册
const pcIdx = path.join(PC, 'src/index.js')
let pcSrc = fs.readFileSync(pcIdx, 'utf8')
if (!pcSrc.includes('26.3')) {
  const anchor = "    26.1: require('./pc/1.18/chunk')"
  if (pcSrc.includes(anchor)) {
    pcSrc = pcSrc.replace(anchor, anchor + ",\n    26.2: require('./pc/1.18/chunk'),\n    26.3: require('./pc/1.18/chunk')")
    fs.writeFileSync(pcIdx, pcSrc)
    console.log('[overlay] prismarine-chunk 已注册 26.2/26.3')
  } else {
    console.log('[overlay] 警告: prismarine-chunk 锚点未找到')
  }
} else {
  console.log('[overlay] prismarine-chunk 已注册，跳过')
}

// 6) prismarine-physics features.json 补 26.2/26.3
const ppFeat = path.join(root, 'node_modules/prismarine-physics/lib/features.json')
if (fs.existsSync(ppFeat)) {
  let f = fs.readFileSync(ppFeat, 'utf8')
  if (!f.includes('26.3')) {
    f = f.replaceAll('"26.1"]', '"26.1", "26.2", "26.3"]').replaceAll('"26.1",', '"26.1", "26.2", "26.3",')
    fs.writeFileSync(ppFeat, f)
    console.log('[overlay] prismarine-physics features 已补 26.2/26.3')
  } else {
    console.log('[overlay] prismarine-physics features 已包含 26.3，跳过')
  }
}

// 验证
const { createRequire } = await import('node:module')
const mcData = createRequire(import.meta.url)(path.join(MCD, 'index.js'))('26.3')
if (!mcData || mcData.version.version !== 777) throw new Error('验证失败: minecraft-data("26.3") 不可用')
console.log(`[overlay] 验证通过: 26.3 = proto ${mcData.version.version}, blocks=${Object.keys(mcData.blocksByName).length}`)
