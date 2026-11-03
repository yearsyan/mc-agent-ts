/**
 * 5×7 点阵字体 (ASCII 子集, 小写按大写画): 给合成图画实体编号 / 坐标刻度 / 罗盘。
 */
import type { PNG } from 'pngjs'

const G: Record<string, string> = {
  '0': '.###.|#...#|#..##|#.#.#|##..#|#...#|.###.',
  '1': '..#..|.##..|..#..|..#..|..#..|..#..|.###.',
  '2': '.###.|#...#|....#|...#.|..#..|.#...|#####',
  '3': '####.|....#|....#|.###.|....#|....#|####.',
  '4': '...#.|..##.|.#.#.|#..#.|#####|...#.|...#.',
  '5': '#####|#....|####.|....#|....#|#...#|.###.',
  '6': '..##.|.#...|#....|####.|#...#|#...#|.###.',
  '7': '#####|....#|...#.|..#..|.#...|.#...|.#...',
  '8': '.###.|#...#|#...#|.###.|#...#|#...#|.###.',
  '9': '.###.|#...#|#...#|.####|....#|...#.|.##..',
  A: '.###.|#...#|#...#|#####|#...#|#...#|#...#',
  B: '####.|#...#|#...#|####.|#...#|#...#|####.',
  C: '.###.|#...#|#....|#....|#....|#...#|.###.',
  D: '####.|#...#|#...#|#...#|#...#|#...#|####.',
  E: '#####|#....|#....|####.|#....|#....|#####',
  F: '#####|#....|#....|####.|#....|#....|#....',
  G: '.###.|#...#|#....|#.###|#...#|#...#|.####',
  H: '#...#|#...#|#...#|#####|#...#|#...#|#...#',
  I: '.###.|..#..|..#..|..#..|..#..|..#..|.###.',
  J: '..###|...#.|...#.|...#.|...#.|#..#.|.##..',
  K: '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#',
  L: '#....|#....|#....|#....|#....|#....|#####',
  M: '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#',
  N: '#...#|#...#|##..#|#.#.#|#..##|#...#|#...#',
  O: '.###.|#...#|#...#|#...#|#...#|#...#|.###.',
  P: '####.|#...#|#...#|####.|#....|#....|#....',
  Q: '.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#',
  R: '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
  S: '.####|#....|#....|.###.|....#|....#|####.',
  T: '#####|..#..|..#..|..#..|..#..|..#..|..#..',
  U: '#...#|#...#|#...#|#...#|#...#|#...#|.###.',
  V: '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..',
  W: '#...#|#...#|#...#|#.#.#|#.#.#|#.#.#|.#.#.',
  X: '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
  Y: '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..',
  Z: '#####|....#|...#.|..#..|.#...|#....|#####',
  '#': '.#.#.|.#.#.|#####|.#.#.|#####|.#.#.|.#.#.',
  '-': '.....|.....|.....|#####|.....|.....|.....',
  _: '.....|.....|.....|.....|.....|.....|#####',
  '.': '.....|.....|.....|.....|.....|.##..|.##..',
  ':': '.....|.##..|.##..|.....|.##..|.##..|.....',
  '/': '....#|....#|...#.|..#..|.#...|#....|#....',
  ',': '.....|.....|.....|.....|.##..|..#..|.#...',
  '(': '...#.|..#..|.#...|.#...|.#...|..#..|...#.',
  ')': '.#...|..#..|...#.|...#.|...#.|..#..|.#...',
  '+': '.....|..#..|..#..|#####|..#..|..#..|.....',
  '=': '.....|.....|#####|.....|#####|.....|.....',
  '?': '.###.|#...#|....#|...#.|..#..|.....|..#..',
  ' ': '.....|.....|.....|.....|.....|.....|.....',
}
const GLYPHS = new Map<string, boolean[][]>()
for (const [ch, s] of Object.entries(G)) GLYPHS.set(ch, s.split('|').map(r => [...r].map(c => c === '#')))

export type RGBA = [number, number, number, number?]

/** 像素宽 (每字 5 列 + 1 列间距) */
export function textWidth (text: string, scale = 1) { return Math.max(0, text.length * 6 - 1) * scale }
export const textHeight = (scale = 1) => 7 * scale

/** 混合写一个像素 (alpha 0..1) */
export function blend (png: PNG, x: number, y: number, c: RGBA, alpha = 1) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return
  const i = (y * png.width + x) << 2
  const a = (c[3] ?? 1) * alpha
  png.data[i] = png.data[i] * (1 - a) + c[0] * a
  png.data[i + 1] = png.data[i + 1] * (1 - a) + c[1] * a
  png.data[i + 2] = png.data[i + 2] * (1 - a) + c[2] * a
}

export function fillRect (png: PNG, x0: number, y0: number, w: number, h: number, c: RGBA, alpha = 1) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) blend(png, x, y, c, alpha)
}

/** 画文字 (左上角 x,y); bg 给出时先画半透明底板 */
export function drawText (png: PNG, x: number, y: number, text: string, color: RGBA, scale = 1, bg: RGBA | null = [0, 0, 0, 0.6]) {
  const w = textWidth(text, scale), h = textHeight(scale)
  if (bg) fillRect(png, x - scale, y - scale, w + 2 * scale, h + 2 * scale, bg)
  let cx = x
  for (const ch of text) {
    const g = GLYPHS.get(ch.toUpperCase()) ?? GLYPHS.get('?')!
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 5; c++) {
        if (!g[r][c]) continue
        fillRect(png, cx + c * scale, y + r * scale, scale, scale, color)
      }
    }
    cx += 6 * scale
  }
  return { x: x - scale, y: y - scale, w: w + 2 * scale, h: h + 2 * scale }
}

/** 标签排版: 避开已放置的矩形, 依次尝试上移; 放不下返回 null */
export class LabelLayout {
  private rects: { x: number, y: number, w: number, h: number }[] = []
  constructor (private W: number, private H: number) {}
  reserve (r: { x: number, y: number, w: number, h: number }) { this.rects.push(r) }
  place (x: number, y: number, w: number, h: number, step: number, tries = 5): { x: number, y: number } | null {
    x = Math.max(1, Math.min(this.W - w - 1, x))
    for (let i = 0; i < tries; i++) {
      const yy = Math.max(1, Math.min(this.H - h - 1, y - i * step))
      const hit = this.rects.some(r => x < r.x + r.w && x + w > r.x && yy < r.y + r.h && yy + h > r.y)
      if (!hit) { this.rects.push({ x, y: yy, w, h }); return { x, y: yy } }
    }
    return null
  }
}
