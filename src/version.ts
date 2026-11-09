/**
 * 游戏版本单一来源: 版本号与按版本加载的数据/实现单例。
 * 升级版本时先改这里, 再按 docs/DESIGN.md 的"升级版本检查清单"逐项过。
 * 其他模块一律从这里取 mcData / Block / Chunk, 不要自己 require('minecraft-data')(版本)。
 */
import { createRequire } from 'node:module'

const require2 = createRequire(import.meta.url)

/** minecraft-data / minecraft-protocol 认的版本名 */
export const MC_VERSION = '26.3'
/** 对应协议号 (启动时与 minecraft-data 核对) */
export const PROTOCOL_VERSION = 777

/** minecraft-data (含 third_party overlay) */
export const mcData: any = require2('minecraft-data')(MC_VERSION)
if (!mcData) throw new Error(`minecraft-data 没有 ${MC_VERSION} 的数据, 先运行 pnpm setup (scripts/setup-overlay.ts)`)
if (mcData.version?.version !== PROTOCOL_VERSION) {
  console.warn(`[version] minecraft-data ${MC_VERSION} 的协议号是 ${mcData.version?.version}, 预期 ${PROTOCOL_VERSION}`)
}

/** prismarine-block 类 (按 stateId 构造方块对象: 碰撞形状/属性) */
export const Block: any = require2('prismarine-block')(mcData)
/** prismarine-chunk 列类 */
export const Chunk: any = require2('prismarine-chunk')(MC_VERSION)
