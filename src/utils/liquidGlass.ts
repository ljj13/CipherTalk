export type GlassFilterMap = {
  href: string
  width: number
  height: number
  scale: number
}

function smoothStep(a: number, b: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

function vectorLength(x: number, y: number): number {
  return Math.sqrt(x * x + y * y)
}

function roundedRectSdf(x: number, y: number, width: number, height: number, radius: number): number {
  const qx = Math.abs(x) - width + radius
  const qy = Math.abs(y) - height + radius
  return Math.min(Math.max(qx, qy), 0) + vectorLength(Math.max(qx, 0), Math.max(qy, 0)) - radius
}

export function createLiquidGlassMap(width: number, height: number): GlassFilterMap | null {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const context = canvas.getContext('2d')
  if (!context) return null

  const data = new Uint8ClampedArray(w * h * 4)
  const rawValues: number[] = []
  let maxScale = 0
  for (let i = 0; i < data.length; i += 4) {
    const x = (i / 4) % w
    const y = Math.floor(i / 4 / w)
    const uvX = x / w
    const uvY = y / h
    const ix = uvX - 0.5
    const iy = uvY - 0.5
    const distanceToEdge = roundedRectSdf(ix, iy, 0.3, 0.2, 0.6)
    const displacement = smoothStep(0.8, 0, distanceToEdge - 0.15)
    const scaled = smoothStep(0, 1, displacement)
    const targetX = (ix * scaled + 0.5) * w
    const targetY = (iy * scaled + 0.5) * h
    const dx = targetX - x
    const dy = targetY - y
    maxScale = Math.max(maxScale, Math.abs(dx), Math.abs(dy))
    rawValues.push(dx, dy)
  }

  maxScale = Math.max(1, maxScale * 0.5)
  let index = 0
  for (let i = 0; i < data.length; i += 4) {
    const r = rawValues[index++] / maxScale + 0.5
    const g = rawValues[index++] / maxScale + 0.5
    data[i] = Math.max(0, Math.min(255, r * 255))
    data[i + 1] = Math.max(0, Math.min(255, g * 255))
    data[i + 2] = 0
    data[i + 3] = 255
  }

  context.putImageData(new ImageData(data, w, h), 0, 0)
  return {
    href: canvas.toDataURL(),
    width: w,
    height: h,
    scale: maxScale,
  }
}
