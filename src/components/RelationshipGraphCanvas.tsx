import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Application, Container, Graphics, Text } from 'pixi.js'
import { Viewport } from 'pixi-viewport'
import type { RelationshipGraphLink, RelationshipGraphNode } from '../types/models'

export interface RelationshipGraphCanvasHandle {
  fitView: () => void
}

export interface RelationshipGraphCanvasProps {
  nodes: RelationshipGraphNode[]
  links: RelationshipGraphLink[]
  selectedNodeId?: string | null
  selectedLinkId?: string | null
  onNodeClick?: (node: RelationshipGraphNode) => void
  onLinkClick?: (link: RelationshipGraphLink) => void
  onCanvasClick?: () => void
}

const LINK_COLORS: Record<string, string> = {
  direct_chat: '#73b7ff',
  same_group: '#4fd7c5',
  group_interaction: '#ffcf75',
}

function cropEdge(source: RelationshipGraphNode, target: RelationshipGraphNode): { sx: number; sy: number; tx: number; ty: number } {
  const dx = target.x - source.x
  const dy = target.y - source.y
  const distance = Math.max(0.001, Math.hypot(dx, dy))
  const ux = dx / distance
  const uy = dy / distance
  const sourceRadius = Math.max(3, source.size * 0.54)
  const targetRadius = Math.max(3, target.size * 0.54)
  return {
    sx: source.x + ux * sourceRadius,
    sy: source.y + uy * sourceRadius,
    tx: target.x - ux * targetRadius,
    ty: target.y - uy * targetRadius,
  }
}

function linkAlpha(link: RelationshipGraphLink, highlighted: boolean): number {
  if (highlighted) return 0.9
  if (link.visibility === 'primary') return 0.36
  return 0.16
}

function linkWidth(link: RelationshipGraphLink, highlighted: boolean): number {
  if (highlighted) return Math.max(2.4, Math.min(5, 1.8 + Math.sqrt(Number(link.weight || 1)) * 0.42))
  if (link.visibility === 'primary') return Math.max(0.8, Math.min(2.4, 0.5 + Math.sqrt(Number(link.weight || 1)) * 0.18))
  return Math.max(0.35, Math.min(1.2, 0.28 + Math.sqrt(Number(link.weight || 1)) * 0.08))
}

function textForNode(node: RelationshipGraphNode, selected: boolean): Text | null {
  if (!selected && node.labelVisibility !== 'always') return null
  const text = new Text({
    text: node.label,
    style: {
      fill: selected ? '#ffffff' : '#d8dee9',
      fontFamily: 'Inter, system-ui, sans-serif',
      fontSize: selected ? 13 : 11,
      fontWeight: selected ? '700' : '500',
      stroke: { color: '#111827', width: 3 },
    },
  })
  text.anchor.set(0.5, 0)
  text.x = node.x
  text.y = node.y + node.size * 0.7 + 4
  return text
}

function renderGraph(
  viewport: Viewport,
  graphLayer: Container,
  nodes: RelationshipGraphNode[],
  links: RelationshipGraphLink[],
  selectedNodeId: string | null | undefined,
  selectedLinkId: string | null | undefined,
  onNodeClick?: (node: RelationshipGraphNode) => void,
  onLinkClick?: (link: RelationshipGraphLink) => void,
): void {
  graphLayer.removeChildren().forEach((child) => child.destroy({ children: true }))
  const nodeMap = new Map(nodes.map((node) => [node.id, node]))
  const selectedNeighborIds = new Set<string>()
  const selectedLinkIds = new Set<string>()

  if (selectedNodeId) {
    selectedNeighborIds.add(selectedNodeId)
    for (const link of links) {
      const source = String(link.source)
      const target = String(link.target)
      if (source !== selectedNodeId && target !== selectedNodeId) continue
      selectedNeighborIds.add(source)
      selectedNeighborIds.add(target)
      selectedLinkIds.add(link.id)
    }
  }

  const renderLinks = selectedNodeId
    ? links.filter((link) => selectedLinkIds.has(link.id))
    : links.filter((link) => link.visibility !== 'hidden')
  const renderNodeIds = selectedNodeId
    ? selectedNeighborIds
    : new Set(nodes.map((node) => node.id))

  const linkLayer = new Container()
  const nodeLayer = new Container()
  const labelLayer = new Container()
  graphLayer.addChild(linkLayer, nodeLayer, labelLayer)

  for (const link of renderLinks) {
    const source = nodeMap.get(String(link.source))
    const target = nodeMap.get(String(link.target))
    if (!source || !target) continue
    const highlighted = selectedLinkId === link.id || selectedLinkIds.has(link.id)
    const edge = cropEdge(source, target)
    const color = highlighted ? '#ffffff' : LINK_COLORS[link.type] || '#94a3b8'

    const line = new Graphics()
    line.moveTo(edge.sx, edge.sy)
    line.lineTo(edge.tx, edge.ty)
    line.stroke({ color, width: linkWidth(link, highlighted), alpha: linkAlpha(link, highlighted) })
    linkLayer.addChild(line)

    const hit = new Graphics()
    hit.moveTo(edge.sx, edge.sy)
    hit.lineTo(edge.tx, edge.ty)
    hit.stroke({ color: '#ffffff', width: 12, alpha: 0.001 })
    hit.eventMode = 'static'
    hit.cursor = 'pointer'
    hit.on('pointertap', (event) => {
      event.stopPropagation()
      onLinkClick?.(link)
    })
    linkLayer.addChild(hit)
  }

  for (const node of nodes) {
    if (!renderNodeIds.has(node.id)) continue
    const selected = selectedNodeId === node.id
    const related = !selectedNodeId || selectedNeighborIds.has(node.id)
    const radius = Math.max(3.5, node.size * (selected ? 0.72 : 0.58))
    const alpha = related ? 0.94 : 0.28

    const dot = new Graphics()
    dot.circle(node.x, node.y, radius + (selected ? 5 : 2))
    dot.fill({ color: selected ? '#ffffff' : node.color, alpha: selected ? 0.18 : 0.08 })
    dot.circle(node.x, node.y, radius)
    dot.fill({ color: selected ? '#ffffff' : node.color, alpha })
    dot.circle(node.x, node.y, Math.max(1.4, radius * 0.28))
    dot.fill({ color: '#ffffff', alpha: selected ? 0.9 : 0.5 })
    dot.eventMode = 'static'
    dot.cursor = 'pointer'
    dot.on('pointertap', (event) => {
      event.stopPropagation()
      onNodeClick?.(node)
    })
    nodeLayer.addChild(dot)

    const label = textForNode(node, selected || Boolean(selectedNodeId))
    if (label) labelLayer.addChild(label)
  }

  viewport.addChild(graphLayer)
}

function fitViewport(viewport: Viewport, nodes: RelationshipGraphNode[]): void {
  if (nodes.length === 0) return
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of nodes) {
    minX = Math.min(minX, node.x - node.size)
    minY = Math.min(minY, node.y - node.size)
    maxX = Math.max(maxX, node.x + node.size)
    maxY = Math.max(maxY, node.y + node.size)
  }
  const width = Math.max(1, maxX - minX)
  const height = Math.max(1, maxY - minY)
  const screenWidth = Math.max(1, viewport.screenWidth)
  const screenHeight = Math.max(1, viewport.screenHeight)
  const scale = Math.min(2.2, Math.max(0.08, Math.min(screenWidth / (width + 160), screenHeight / (height + 160))))
  viewport.scale.set(scale)
  viewport.position.set(
    screenWidth / 2 - (minX + width / 2) * scale,
    screenHeight / 2 - (minY + height / 2) * scale,
  )
}

const RelationshipGraphCanvas = forwardRef<RelationshipGraphCanvasHandle, RelationshipGraphCanvasProps>(function RelationshipGraphCanvas(props, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const appRef = useRef<Application | null>(null)
  const viewportRef = useRef<Viewport | null>(null)
  const graphLayerRef = useRef<Container | null>(null)
  const fitRequestedRef = useRef(false)
  const [readyTick, setReadyTick] = useState(0)
  const graphKey = useMemo(() => `${props.nodes.length}:${props.links.length}`, [props.links.length, props.nodes.length])

  useImperativeHandle(ref, () => ({
    fitView: () => {
      const viewport = viewportRef.current
      if (viewport) fitViewport(viewport, props.nodes)
      else fitRequestedRef.current = true
    },
  }), [props.nodes])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    const app = new Application()

    void app.init({
      resizeTo: host,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
    }).then(() => {
      if (disposed) {
        app.destroy(true)
        return
      }
      appRef.current = app
      host.appendChild(app.canvas)
      const viewport = new Viewport({
        screenWidth: host.clientWidth || 1,
        screenHeight: host.clientHeight || 1,
        worldWidth: 2400,
        worldHeight: 2400,
        events: app.renderer.events,
      })
      viewport.drag().pinch().wheel().decelerate()
      viewport.eventMode = 'static'
      viewport.on('pointertap', () => props.onCanvasClick?.())
      app.stage.addChild(viewport)
      viewportRef.current = viewport
      graphLayerRef.current = new Container()
      renderGraph(viewport, graphLayerRef.current, props.nodes, props.links, props.selectedNodeId, props.selectedLinkId, props.onNodeClick, props.onLinkClick)
      fitViewport(viewport, props.nodes)
      fitRequestedRef.current = false
      setReadyTick((value) => value + 1)
    })

    return () => {
      disposed = true
      viewportRef.current = null
      graphLayerRef.current = null
      appRef.current = null
      app.destroy(true, { children: true })
    }
  }, [])

  useEffect(() => {
    const viewport = viewportRef.current
    const graphLayer = graphLayerRef.current
    if (!viewport || !graphLayer) return
    renderGraph(viewport, graphLayer, props.nodes, props.links, props.selectedNodeId, props.selectedLinkId, props.onNodeClick, props.onLinkClick)
    if (fitRequestedRef.current || !props.selectedNodeId) {
      fitViewport(viewport, props.nodes)
      fitRequestedRef.current = false
    }
  }, [graphKey, props.links, props.nodes, props.onLinkClick, props.onNodeClick, props.selectedLinkId, props.selectedNodeId, readyTick])

  return <div className="relationship-pixi-host" ref={hostRef} />
})

export default RelationshipGraphCanvas
