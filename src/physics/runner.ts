/**
 * 物理运行器: 包装 prismarine-physics 的 simulatePlayer。
 * 每个 tick: 动作系统设置 control → 模拟一步 → 写回 bot.pos。
 */
import { createRequire } from 'node:module'
import { Vec3 } from 'vec3'
import type { World } from '../world/world.js'

const require2 = createRequire(import.meta.url)
const mcData: any = require2('minecraft-data')('26.3')
const Block: any = require2('prismarine-block')(mcData) // byRegistry? prismarine-block(registry)
const { Physics, PlayerState } = require2('prismarine-physics')

export interface ControlState {
  forward: boolean
  back: boolean
  left: boolean
  right: boolean
  jump: boolean
  sprint: boolean
  sneak: boolean
}

/** physics 需要的 world 接口: getBlock(pos) -> 带 .type/.position 的方块对象 */
function makePhysicsWorld (world: World) {
  return {
    getBlock (pos: any) {
      const b = world.getBlock(pos.x, pos.y, pos.z)
      if (!b) return null
      try {
        const block = Block.fromStateId(b.stateId, 0)
        block.position = new Vec3(pos.x, pos.y, pos.z) // physics 会读 block.position
        return block
      } catch {
        return null
      }
    },
    getBlockCollisionShapes: null,
  }
}

export class PhysicsRunner {
  control: ControlState = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  velocity = new Vec3(0, 0, 0)
  private physics: any
  private botLike: any
  private pworld: any

  constructor (world: World, private bot: { pos: { x: number, y: number, z: number }, yaw: number, pitch: number, onGround: boolean }) {
    this.pworld = makePhysicsWorld(world)
    this.physics = Physics(mcData, this.pworld)
    this.botLike = {
      version: '26.3',
      entity: {
        position: new Vec3(bot.pos.x, bot.pos.y, bot.pos.z),
        velocity: this.velocity,
        onGround: true,
        isInWater: false, isInLava: false, isInWeb: false,
        isCollidedHorizontally: false, isCollidedVertically: false,
        elytraFlying: false,
        attributes: {},
        effects: [],
        yaw: 0, pitch: 0,
      },
      jumpTicks: 0,
      jumpQueued: false,
      fireworkRocketDuration: 0,
      usingHeldItem: false,
      inventory: { slots: [] },
    }
  }

  syncFromBot () {
    this.botLike.entity.position.set(this.bot.pos.x, this.bot.pos.y, this.bot.pos.z)
    this.velocity.set(0, 0, 0)
  }

  tick () {
    // 与 bot.pos 对账: 初始化/服务器传送/回弹时偏差会 > 2 格, 强制重同步
    const p = this.botLike.entity.position
    if (Math.abs(p.x - this.bot.pos.x) > 2 || Math.abs(p.y - this.bot.pos.y) > 2 || Math.abs(p.z - this.bot.pos.z) > 2) {
      this.syncFromBot()
    }
    this.botLike.entity.yaw = this.bot.yaw
    this.botLike.entity.pitch = this.bot.pitch
    try {
      const state = new PlayerState(this.botLike, this.control)
      this.physics.simulatePlayer(state, this.pworld)
      state.apply(this.botLike)
      // 写回 bot
      this.bot.pos.x = this.botLike.entity.position.x
      this.bot.pos.y = this.botLike.entity.position.y
      this.bot.pos.z = this.botLike.entity.position.z
      this.bot.onGround = this.botLike.entity.onGround
    } catch (e: any) {
      // 物理异常不致命: 保持原地
      console.warn(`[physics] tick 失败: ${e.message}`)
    }
  }
}
