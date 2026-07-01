import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createLiquidGlassMap, type GlassFilterMap } from '../../utils/liquidGlass'

const FILTER_ID = 'home-moment-glass'
// 更大的折射范围：缩小实心中心 + 加大 feather，覆盖面更广
const BUBBLE_GLASS = { halfX: 0.22, halfY: 0.14, radius: 0.7, edge: 0.2, feather: 1.2, strength: 1.6 }

/** 回忆一刻文字气泡的液态玻璃外壳：按自身尺寸生成位移贴图，用 backdrop-filter 折射。
 *  气泡文字长度会变（换一条/多行），故用 ResizeObserver 跟随尺寸重建贴图。 */
export function LiquidGlassBubble({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLQuoteElement>(null)
  const [map, setMap] = useState<GlassFilterMap | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const rect = el.getBoundingClientRect()
      const next = createLiquidGlassMap(Math.round(rect.width), Math.round(rect.height), BUBBLE_GLASS)
      if (next) setMap(next)
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const backdrop = map ? `url(#${FILTER_ID}) saturate(180%) brightness(1.05)` : undefined

  return (
    <blockquote
      ref={ref}
      className="random-message-body random-message-body--glass"
      style={map ? { backdropFilter: backdrop, WebkitBackdropFilter: backdrop } : undefined}
    >
      {map && (
        <svg aria-hidden="true" focusable="false" style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }}>
          <filter
            id={FILTER_ID}
            colorInterpolationFilters="sRGB"
            filterUnits="userSpaceOnUse"
            x="0"
            y="0"
            width={map.width}
            height={map.height}
          >
            <feImage href={map.href} xlinkHref={map.href} width={map.width} height={map.height} result="displacementMap" />
            <feDisplacementMap in="SourceGraphic" in2="displacementMap" scale={map.scale} xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </svg>
      )}
      {children}
    </blockquote>
  )
}
