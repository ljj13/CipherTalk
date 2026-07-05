import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Avatar, Button, Chip, Drawer, Label, Popover, ScrollShadow, SearchField, Slider, Spinner, Switch, Tabs } from '@heroui/react'
import { ArrowsRotateLeft, ChartBar, Magnifier, NodesRight, Person, Sliders } from '@gravity-ui/icons'
import type {
  RelationshipGraphBuildProgress,
  RelationshipGraphData,
  RelationshipGraphLink,
  RelationshipGraphNode,
  RelationshipGraphOptions,
  RelationshipGraphRelationType,
  RelationshipGraphResult,
  RelationshipGraphScope,
  RelationshipGraphTimeRangePreset,
} from '../types/models'
import RelationshipGraphCanvas, { type RelationshipGraphCanvasHandle } from '../components/RelationshipGraphCanvas'
import { createLiquidGlassMap, type GlassFilterMap, type GlassShapeOptions } from '../utils/liquidGlass'
import './RelationshipGraphPage.css'

const RELATION_LABELS: Record<RelationshipGraphRelationType, string> = {
  direct_chat: '私聊',
  same_group: '同群',
  group_interaction: '群内互动',
}

const TIME_PRESETS: Array<{ id: RelationshipGraphTimeRangePreset; label: string }> = [
  { id: '1y', label: '1 年' },
  { id: '2y', label: '2 年' },
  { id: '3y', label: '3 年' },
  { id: '5y', label: '5 年' },
  { id: 'all', label: '全部' },
]

const GRAPH_SCOPES: Array<{ id: RelationshipGraphScope; label: string }> = [
  { id: 'panorama', label: '全景' },
  { id: 'close', label: '近邻' },
  { id: 'friends', label: '好友' },
]

const TOOLBAR_GLASS_SHAPE: GlassShapeOptions = {
  halfX: 0.5,
  halfY: 0.5,
  radius: 0.2,
  edge: 0.08,
  feather: 0.62,
  strength: 1.18,
  edgeStrength: 0.9,
}

const toSliderNumber = (value: number | number[]): number => Array.isArray(value) ? value[0] ?? 0 : value

function formatCount(value?: number): string {
  const n = Number(value || 0)
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function formatTime(seconds?: number): string {
  if (!seconds) return '未知'
  return new Date(seconds * 1000).toLocaleDateString()
}

function graphFromResult(result: RelationshipGraphResult | null): RelationshipGraphData {
  if (result?.graph) return result.graph
  return {
    nodes: result?.nodes || [],
    links: result?.links || [],
    communities: result?.communities || [],
    rankings: result?.rankings || { central: [], isolated: [], active: [] },
    similar: result?.similar || {},
    stats: result?.stats,
  }
}

function linkTitle(link: RelationshipGraphLink, nodeMap: Map<string, RelationshipGraphNode>): string {
  const source = nodeMap.get(String(link.source))?.label || String(link.source)
  const target = nodeMap.get(String(link.target))?.label || String(link.target)
  return `${source} ↔ ${target}`
}

function RelationshipGraphPage() {
  const canvasRef = useRef<RelationshipGraphCanvasHandle | null>(null)
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const [toolbarGlassId] = useState(() => `relationship-toolbar-glass-${Math.random().toString(36).slice(2, 9)}`)
  const [toolbarGlassMap, setToolbarGlassMap] = useState<GlassFilterMap | null>(null)
  const [result, setResult] = useState<RelationshipGraphResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState<RelationshipGraphBuildProgress | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [timeRangePreset, setTimeRangePreset] = useState<RelationshipGraphTimeRangePreset>('1y')
  const [graphScope, setGraphScope] = useState<RelationshipGraphScope>('panorama')
  const [minWeight, setMinWeight] = useState(0)
  const [includeIsolated, setIncludeIsolated] = useState(false)
  const [relationTypes, setRelationTypes] = useState<RelationshipGraphRelationType[]>(['direct_chat', 'same_group', 'group_interaction'])
  const [selectedNode, setSelectedNode] = useState<RelationshipGraphNode | null>(null)
  const [selectedLink, setSelectedLink] = useState<RelationshipGraphLink | null>(null)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [analysisOpen, setAnalysisOpen] = useState(false)

  const options = useMemo<RelationshipGraphOptions>(() => ({
    acceptStale: true,
    timeRangePreset,
    graphScope,
    query: query.trim() || undefined,
    minWeight,
    includeIsolated,
    relationTypes,
  }), [graphScope, includeIsolated, minWeight, query, relationTypes, timeRangePreset])

  const loadGraph = useCallback(async (forceRecompute = false) => {
    setLoading(true)
    setError('')
    try {
      const next = forceRecompute
        ? await window.electronAPI.relationshipGraph.rebuild(options)
        : await window.electronAPI.relationshipGraph.getGraph(options)
      setResult(next)
      if (!next.success) setError(next.error || '关系网络加载失败')
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [options])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadGraph(false)
    }, 220)
    return () => window.clearTimeout(timer)
  }, [loadGraph])

  useEffect(() => {
    const off = window.electronAPI.relationshipGraph.onProgress((next) => {
      setProgress(next)
      if (next.stage === 'done') {
        window.setTimeout(() => void loadGraph(false), 260)
      }
      if (next.stage === 'error') setError(next.message)
    })
    return off
  }, [loadGraph])

  const taskRunning = result?.task?.status === 'running' || progress?.status === 'running'
  useEffect(() => {
    if (!taskRunning) return
    const timer = window.setInterval(() => {
      void window.electronAPI.relationshipGraph.getGraph(options)
        .then((next) => {
          setResult(next)
          if (!next.success) setError(next.error || '关系网络加载失败')
        })
        .catch((error) => setError(error instanceof Error ? error.message : String(error)))
    }, 1400)
    return () => window.clearInterval(timer)
  }, [options, taskRunning])

  const graph = graphFromResult(result)
  const nodeMap = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes])
  const selectedSimilar = selectedNode ? graph.similar?.[selectedNode.id] || [] : []
  const inspectorOpen = Boolean(selectedNode || selectedLink || analysisOpen)
  const graphBusy = loading || taskRunning
  const graphBusyMessage = progress?.message || result?.task?.message || (result?.cache?.stale ? '正在后台更新关系网络' : '正在加载关系网络')
  const renderNote = result?.cache?.stale && graph.nodes.length > 0
    ? '旧图可见，后台更新中'
    : result?.cache?.hit && result.cache.builtAt
      ? `快照 ${formatTime(Math.floor(result.cache.builtAt / 1000))}`
      : ''

  const handleToggleRelation = (type: RelationshipGraphRelationType) => {
    setRelationTypes((current) => {
      if (current.includes(type)) {
        const next = current.filter((item) => item !== type)
        return next.length > 0 ? next : current
      }
      return [...current, type]
    })
  }

  useLayoutEffect(() => {
    const element = toolbarRef.current
    if (!element) return
    const updateGlass = () => {
      const rect = element.getBoundingClientRect()
      const map = createLiquidGlassMap(Math.round(rect.width), Math.round(rect.height), TOOLBAR_GLASS_SHAPE)
      if (map) setToolbarGlassMap(map)
    }
    updateGlass()
    const observer = new ResizeObserver(updateGlass)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const toolbarGlassStyle = toolbarGlassMap
    ? {
        backdropFilter: `url(#${toolbarGlassId}) blur(3px) brightness(1.08) saturate(1.08)`,
        WebkitBackdropFilter: `url(#${toolbarGlassId}) blur(3px) brightness(1.08) saturate(1.08)`,
      }
    : undefined

  return (
    <div className="relationship-page">
      <div className="relationship-toolbar" ref={toolbarRef} style={toolbarGlassStyle}>
        {toolbarGlassMap && (
          <svg className="relationship-toolbar-glass-defs" aria-hidden="true" focusable="false">
            <filter id={toolbarGlassId} colorInterpolationFilters="sRGB" filterUnits="userSpaceOnUse" x="0" y="0" width={toolbarGlassMap.width} height={toolbarGlassMap.height}>
              <feImage href={toolbarGlassMap.href} xlinkHref={toolbarGlassMap.href} width={toolbarGlassMap.width} height={toolbarGlassMap.height} result="displacementMap" />
              <feDisplacementMap in="SourceGraphic" in2="displacementMap" scale={toolbarGlassMap.scale} xChannelSelector="R" yChannelSelector="G" />
            </filter>
          </svg>
        )}
        <div className="relationship-title">
          <NodesRight width={24} height={24} />
          <div>
            <h1>关系网络</h1>
            <p>{graph.stats ? `${formatCount(graph.stats.nodeCount)} 人 · ${formatCount(graph.stats.linkCount)} 条关系` : '2D 预布局关系图谱'}</p>
          </div>
        </div>
        <div className="relationship-toolbar-controls">
          <SearchField aria-label="搜索联系人" className="relationship-search" name="relationship-search" value={query} variant="secondary" onChange={setQuery}>
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input placeholder="搜索联系人" />
              <SearchField.ClearButton />
            </SearchField.Group>
          </SearchField>
          <Tabs selectedKey={timeRangePreset} onSelectionChange={(key) => setTimeRangePreset(String(key) as RelationshipGraphTimeRangePreset)}>
            <Tabs.ListContainer>
              <Tabs.List aria-label="时间范围">
                {TIME_PRESETS.map((preset) => (
                  <Tabs.Tab key={preset.id} id={preset.id}>{preset.label}<Tabs.Indicator /></Tabs.Tab>
                ))}
              </Tabs.List>
            </Tabs.ListContainer>
          </Tabs>
          <Tabs selectedKey={graphScope} onSelectionChange={(key) => setGraphScope(String(key) as RelationshipGraphScope)}>
            <Tabs.ListContainer>
              <Tabs.List aria-label="图范围">
                {GRAPH_SCOPES.map((scope) => (
                  <Tabs.Tab key={scope.id} id={scope.id}>{scope.label}<Tabs.Indicator /></Tabs.Tab>
                ))}
              </Tabs.List>
            </Tabs.ListContainer>
          </Tabs>
          <div className="relationship-actions">
            <Popover isOpen={filtersOpen} onOpenChange={setFiltersOpen}>
              <Button size="sm" variant={filtersOpen ? 'primary' : 'secondary'}>
                <Sliders width={16} height={16} />
                筛选
              </Button>
              <Popover.Content placement="bottom end" offset={8}>
                <Popover.Dialog className="relationship-filter-advanced">
                  <Slider aria-label="最小权重" className="relationship-field" value={minWeight} minValue={0} maxValue={20} step={1} onChange={(value) => setMinWeight(toSliderNumber(value))}>
                    <Label>最小权重</Label>
                    <Slider.Output>{minWeight}</Slider.Output>
                    <Slider.Track>
                      <Slider.Fill />
                      <Slider.Thumb />
                    </Slider.Track>
                  </Slider>
                  <div className="relationship-filter-row">
                    {(Object.keys(RELATION_LABELS) as RelationshipGraphRelationType[]).map((type) => (
                      <Button key={type} size="sm" variant={relationTypes.includes(type) ? 'primary' : 'outline'} onPress={() => handleToggleRelation(type)}>
                        {RELATION_LABELS[type]}
                      </Button>
                    ))}
                  </div>
                  <div className="relationship-switch">
                    <span>显示孤岛</span>
                    <Switch aria-label="显示孤岛" isSelected={includeIsolated} onChange={setIncludeIsolated}>
                      <Switch.Control><Switch.Thumb /></Switch.Control>
                    </Switch>
                  </div>
                </Popover.Dialog>
              </Popover.Content>
            </Popover>
            <Button variant={analysisOpen ? 'primary' : 'secondary'} size="sm" onPress={() => {
              setSelectedNode(null)
              setSelectedLink(null)
              setAnalysisOpen(true)
            }}>
              <ChartBar width={16} height={16} />
              分析
            </Button>
            <Button variant="secondary" size="sm" onPress={() => canvasRef.current?.fitView()}>适配视图</Button>
            <Button variant="primary" size="sm" onPress={() => void loadGraph(true)} isDisabled={graphBusy}>
              <ArrowsRotateLeft width={16} height={16} />
              重建
            </Button>
          </div>
        </div>
      </div>

      <main className="relationship-graph">
        {error ? (
          <div className="relationship-empty">
            <NodesRight width={42} height={42} />
            <h2>关系网络不可用</h2>
            <p>{error}</p>
          </div>
        ) : graph.nodes.length === 0 && !graphBusy ? (
          <div className="relationship-empty">
            <Magnifier width={42} height={42} />
            <h2>没有可显示的关系</h2>
          </div>
        ) : (
          <RelationshipGraphCanvas
            ref={canvasRef}
            nodes={graph.nodes}
            links={graph.links}
            selectedNodeId={selectedNode?.id}
            selectedLinkId={selectedLink?.id}
            onNodeClick={(node) => {
              setSelectedNode(node)
              setSelectedLink(null)
              setAnalysisOpen(false)
            }}
            onLinkClick={(link) => {
              setSelectedLink(link)
              setSelectedNode(null)
              setAnalysisOpen(false)
            }}
            onCanvasClick={() => {
              setSelectedNode(null)
              setSelectedLink(null)
            }}
          />
        )}

        {graphBusy && (
          <div className="relationship-loading">
            <Spinner size="sm" />
            <span>{graphBusyMessage}</span>
          </div>
        )}
        {renderNote && <div className="relationship-render-note">{renderNote}</div>}
      </main>

      <Drawer.Backdrop
        className="relationship-inspector-backdrop"
        isOpen={inspectorOpen}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedNode(null)
            setSelectedLink(null)
            setAnalysisOpen(false)
          }
        }}
        variant="transparent"
      >
        <Drawer.Content className="relationship-inspector-content" placement="right">
          <Drawer.Dialog className="relationship-inspector" aria-label="关系网络详情">
            <Drawer.CloseTrigger />
            <Drawer.Body>
              <ScrollShadow className="relationship-inspector-scroll">
                {selectedNode ? (
                  <section>
                    <div className="relationship-person-head">
                      <Avatar size="lg">
                        {selectedNode.avatarUrl ? <Avatar.Image src={selectedNode.avatarUrl} alt={selectedNode.label} /> : null}
                        <Avatar.Fallback><Person width={22} height={22} /></Avatar.Fallback>
                      </Avatar>
                      <div>
                        <h2>{selectedNode.label}</h2>
                        <p>{selectedNode.id}</p>
                      </div>
                    </div>
                    <div className="relationship-metric-grid">
                      <div><strong>{selectedNode.degree}</strong><span>关系数</span></div>
                      <div><strong>{selectedNode.score.toFixed(1)}</strong><span>分数</span></div>
                      <div><strong>{selectedNode.rank || '-'}</strong><span>排名</span></div>
                      <div><strong>{formatTime(selectedNode.lastActiveTime)}</strong><span>最近活跃</span></div>
                      <div><strong>{formatCount(selectedNode.privateMessageCount)}</strong><span>私聊信号</span></div>
                      <div><strong>{formatCount(selectedNode.groupMessageCount)}</strong><span>群聊信号</span></div>
                    </div>
                    {selectedSimilar.length > 0 && (
                      <div className="relationship-section">
                        <h3>相似联系人</h3>
                        {selectedSimilar.map((node) => (
                          <Button key={node.id} className="relationship-list-item" variant="ghost" onPress={() => setSelectedNode(node)}>
                            <span>{node.label}</span>
                            <small>{node.score.toFixed(1)}</small>
                          </Button>
                        ))}
                      </div>
                    )}
                  </section>
                ) : selectedLink ? (
                  <section>
                    <h2>关系详情</h2>
                    <div className="relationship-link-title">
                      <Chip size="sm" variant="secondary">{RELATION_LABELS[selectedLink.type]}</Chip>
                      <strong>{selectedLink.weight.toFixed(1)}</strong>
                    </div>
                    <p>{linkTitle(selectedLink, nodeMap)}</p>
                    <div className="relationship-metric-grid">
                      <div><strong>{formatCount(selectedLink.coOccurrenceCount)}</strong><span>共现</span></div>
                      <div><strong>{selectedLink.coOccurrenceRawScore.toFixed(1)}</strong><span>共现分</span></div>
                      <div><strong>{formatCount(selectedLink.replyInteractionCount)}</strong><span>回复互动</span></div>
                      <div><strong>{formatCount(selectedLink.sourceGroupCount)}</strong><span>来源群</span></div>
                      <div><strong>{formatTime(selectedLink.lastInteractionTs || selectedLink.lastActiveTime)}</strong><span>最近证据</span></div>
                    </div>
                    <div className="relationship-section">
                      <h3>证据会话</h3>
                      {(selectedLink.sourceSessionIds || selectedLink.evidenceSessionIds || []).slice(0, 12).map((id) => <Chip key={id} size="sm" variant="soft">{id}</Chip>)}
                    </div>
                  </section>
                ) : (
                  <section>
                    <h2>图谱分析</h2>
                    <div className="relationship-metric-grid">
                      <div><strong>{formatCount(graph.stats?.communityCount)}</strong><span>社群</span></div>
                      <div><strong>{formatCount(graph.stats?.isolatedCount)}</strong><span>孤岛</span></div>
                      <div><strong>{formatCount(graph.stats?.directChatCount)}</strong><span>私聊边</span></div>
                      <div><strong>{formatCount(graph.stats?.groupInteractionCount)}</strong><span>互动边</span></div>
                    </div>
                    <div className="relationship-section">
                      <h3>中心人物</h3>
                      {(graph.rankings?.central || []).slice(0, 10).map((node) => (
                        <Button key={node.id} className="relationship-list-item" variant="ghost" onPress={() => setSelectedNode(node)}>
                          <span>{node.label}</span>
                          <small>{node.score.toFixed(1)}</small>
                        </Button>
                      ))}
                    </div>
                    <div className="relationship-section">
                      <h3>社群</h3>
                      {(graph.communities || []).slice(0, 10).map((item) => (
                        <div key={item.id} className="relationship-list-item relationship-list-item--static">
                          <span>{item.label}</span>
                          <small>{item.size} 人</small>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
              </ScrollShadow>
            </Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </div>
  )
}

export default RelationshipGraphPage
