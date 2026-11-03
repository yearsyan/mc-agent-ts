/**
 * 方块 → RGB 颜色表（渲染合成视图用）。
 * 基于方块名的语义调色板 + 常见方块精确色, 参考原版 MapColor 的观感。
 */
export interface RGB { r: number, g: number, b: number }

const EXACT: Record<string, string> = {
  grass_block: '6da43e', short_grass: '5d9c3f', tall_grass: '5d9c3f', fern: '5d9c3f',
  dirt: '8b6d4b', coarse_dirt: '7a5f3f', podzol: '5c3f19', farmland: '6f512f',
  stone: '7d7d7d', cobblestone: '7a7a7a', deepslate: '4d4d51', cobbled_deepslate: '4a4a4e',
  granite: '9a6a5a', diorite: 'bcbcbc', andesite: '8a8a8d', tuff: '6d6d64',
  calcite: 'dfdfda', dripstone_block: '866b5c', smooth_basalt: '48474c',
  oak_leaves: '4c7a26', birch_leaves: '6b8f3f', spruce_leaves: '3e5e2c', jungle_leaves: '47862d',
  acacia_leaves: '5c8f28', dark_oak_leaves: '3d5e22', mangrove_leaves: '4c7a2e', cherry_leaves: 'eebbbb',
  oak_log: '9c7f4e', birch_log: 'd5cb8d', spruce_log: '6b4f2e', jungle_log: '8b6c3f',
  acacia_log: 'ba6337', dark_oak_log: '5c4427', mangrove_log: '75392b', cherry_log: 'd5b8b5',
  oak_planks: 'a8824f', birch_planks: 'c9b77e', spruce_planks: '735531', jungle_planks: 'b0804e',
  acacia_planks: 'ba6337', dark_oak_planks: '4f3a1e', mangrove_planks: '773931', cherry_planks: 'e0b5ad',
  sand: 'dbd3a0', red_sand: 'bf6c33', sandstone: 'd9d0a2', gravel: '837e7c', clay: 'a4a8b8',
  water: '3f76e4', lava: 'e6591b', ice: '7dadff', snow_block: 'f0faf9', snow: 'f0faf9',
  coal_ore: '4a4a4a', iron_ore: '8f8f8c', copper_ore: '8f7a62', gold_ore: 'a08040',
  redstone_ore: '8a5a5a', lapis_ore: '4a6a9a', diamond_ore: '6fd0cc', emerald_ore: '5aa050',
  coal_block: '191919', iron_block: 'd8d8d8', gold_block: 'f9ec4e', diamond_block: '65dbd4',
  emerald_block: '2fbd63', redstone_block: 'ab1b09', lapis_block: '1d47a5', copper_block: 'c16d4d',
  netherrack: '6f2c2c', soul_sand: '51413a', soul_soil: '4d3c34', nether_bricks: '2d161b',
  basalt: '4c4a4f', blackstone: '2b2530', glowstone: 'f9d49c', nether_quartz_ore: '7a5f5a',
  end_stone: 'dbdf9c', purpur_block: 'a97ba9', obsidian: '16121f',
  glass: 'c3e5e8', glass_pane: 'c3e5e8', glow_lichen: '728367', moss_block: '5a7226',
  mossy_cobblestone: '658251', mycelium: '6f6265', bone_block: 'e1ddc9',
  bricks: '96574a', stone_bricks: '7b7b7b', mud_bricks: '8b6d54', mud: '3c2f2b',
  terracotta: '976243', white_terracotta: 'd1b1a1', orange_terracotta: 'a75427',
  hay_block: 'a6890b', pumpkin: 'c07615', melon: '7bb31f', cake: 'f9e3c8',
  bookshelf: 'a8824f', crafting_table: '7b5a34', furnace: '767676', chest: 'a06e39',
  barrel: '7b5a34', spawner: '27383f', beacon: '75e4dc', enchanting_table: '813883',
  respawn_anchor: '3a1d28', ancient_debris: '5c4238', amethyst_block: '8560c8',
  budding_amethyst: '8f6acd', oxidized_copper: '52a486',
  honeycomb_block: 'e5921f', slime_block: '7ac37a', honey_block: 'fd9f28',
  note_block: '684838', tnt: 'b3402b', torch: 'f9c64f', lantern: 'd8a25e',
  campfire: 'a05f30', soul_torch: '54d7d7', soul_lantern: '54d7d7', sea_lantern: 'a6d3d3',
  shroomlight: 'f2a95d', ochre_froglight: 'df9c46', verdant_froglight: 'd0e5b2',
  pearl_froglight: 'eddcf3', sculk: '0f2f3c', sculk_catalyst: '14323f', sculk_sensor: '11404f',
  reinforced_deepslate: '4c5049', cactus: '0f8b1e', sugar_cane: '8fc47c',
  oak_slab: 'a8824f', stone_slab: '7d7d7d', cobblestone_slab: '7a7a7a',
  smooth_stone: '9e9e9e', smooth_sandstone: 'cfcebe', smooth_red_sandstone: 'bd7351',
  deepslate_bricks: '48474c', polished_deepslate: '48484a', cracked_deepslate_bricks: '403f44',
  polished_blackstone: '403a44', polished_blackstone_bricks: '36313c',
  poppy: 'd8262a', dandelion: 'f5d932', blue_orchid: '2aa7e0', allium: 'b366e0', azure_bluet: 'e5ebf0',
  oxeye_daisy: 'eef0e0', cornflower: '4769d6', lily_of_the_valley: 'f4f4f4', wither_rose: '2a2a22',
  sunflower: 'f5c91e', lilac: 'd39ed8', rose_bush: 'c52a2a', peony: 'e6b5e8', torchflower: 'e8792c',
  red_tulip: 'd8382a', orange_tulip: 'e8812c', white_tulip: 'f0f0f0', pink_tulip: 'eaa2c4',
  wheat: 'c9b54a', carrots: '58a83a', potatoes: '5aa33a', beetroots: '5c9a3a', sweet_berry_bush: '3f6e33',
  dead_bush: '8a6a3a', brown_mushroom: '9a7458', red_mushroom: 'c4302a', wall_torch: 'f9c64f',
  redstone_wire: '9a1a10', rail: '8a7a66', powered_rail: 'b09040', detector_rail: '8a6a6a', activator_rail: '8a5a5a',
  ladder: '9c7f4e', lily_pad: '2f7a2a', fire: 'f08a1a', cobweb: 'e8e8e8',
  waystone: '7d8a99',  // modded
  shogi_board: 'c9a06b', // modded (将棋盘)
}

// 语义兜底: 名字关键词 → 色
const KEYWORDS: [string, string][] = [
  ['deepslate', '4d4d51'], ['dirt', '8b6d4b'], ['grass', '6da43e'], ['leaves', '4c7a26'],
  ['log', '6b4f2e'], ['planks', 'a8824f'], ['sand', 'dbd3a0'], ['stone', '7d7d7d'],
  ['ore', '8f8f8c'], ['water', '3f76e4'], ['lava', 'e6591b'], ['wood', '9c7f4e'],
  ['glass', 'c3e5e8'], ['brick', '96574a'], ['copper', 'c16d4d'], ['iron', 'd8d8d8'],
  ['gold', 'f9ec4e'], ['diamond', '65dbd4'], ['emerald', '2fbd63'], ['nether', '6f2c2c'],
  ['end', 'dbdf9c'], ['wool', 'e8e8e8'], ['carpet', 'e8e8e8'], ['concrete', 'c8c8c8'],
  ['terracotta', '976243'], ['prismarine', '639f8f'], ['purpur', 'a97ba9'], ['quartz', 'eae5dd'],
  ['snow', 'f0faf9'], ['ice', '7dadff'], ['mushroom', 'c8a2a2'], ['froglight', 'd8e0b0'],
  ['sculk', '0f2f3c'], ['amethyst', '8560c8'], ['candle', 'f2e6b8'], ['banner', 'a8824f'],
  ['sapling', '4f8a2a'], ['tulip', 'd8382a'], ['torch', 'f9c64f'], ['fern', '5d9c3f'], ['bed', 'b02e26'],
]

const cache = new Map<string, RGB>()

export function blockColor (name: string): RGB {
  let c = cache.get(name)
  if (c) return c
  let hex = EXACT[name]
  if (!hex) {
    const base = name.replace(/_(stairs|slab|wall|fence|fence_gate|button|pressure_plate|trapdoor|door|sign|hanging_sign)$/, '')
    hex = EXACT[base]
    if (!hex) {
      for (const [kw, h] of KEYWORDS) {
        if (name.includes(kw)) { hex = h; break }
      }
    }
    if (!hex) hex = '9a9a9a' // 未知: 中灰
  }
  c = { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) }
  cache.set(name, c)
  return c
}

export const SKY = { r: 130, g: 170, b: 235 }
export const VOID_COLOR = { r: 20, g: 20, b: 26 }
