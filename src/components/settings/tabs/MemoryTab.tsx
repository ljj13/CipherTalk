import { useEffect, useMemo, useState } from 'react'
import {
  AlertDialog,
  Button,
  ButtonGroup,
  Card,
  Chip,
  Description,
  InputGroup,
  Label,
  ListBox,
  NumberField,
  ScrollShadow,
  Select,
  Skeleton,
  TextField,
  Typography,
  type Key,
} from '@heroui/react'
import { Check, Download, Eye, Pencil, Plus, RefreshCw, Search, Sparkles, Trash2, X } from 'lucide-react'
import type { AgentMemoryItem, AgentMemorySourceType } from '../../../types/electron'

interface MemoryTabProps {
  showMessage: (text: string, success: boolean) => void
}

const MEMORY_SOURCE_OPTIONS: Array<{ value: AgentMemorySourceType; label: string; hint: string }> = [
  { value: 'profile', label: '画像', hint: '用户本人长期偏好、身份、习惯' },
  { value: 'fact', label: '事实', hint: '跨对话稳定事实' },
  { value: 'relationship', label: '关系', hint: '联系人、称谓和长期关系' },
  { value: 'message', label: '消息', hint: '从原始消息派生的线索' },
  { value: 'conversation_block', label: '对话块', hint: '一段对话的结构化摘要' },
  { value: 'timeline_summary', label: '时间线', hint: '按时间整理的记忆摘要' },
  { value: 'media', label: '媒体', hint: '图片、语音等媒体线索' },
]

const STRUCTURED_SOURCE_TYPES: AgentMemorySourceType[] = ['profile', 'fact', 'relationship']
const LOAD_LIMIT = 2000

type MemoryTypeFilter = AgentMemorySourceType | 'all'
type MemoryStatusFilter = 'all' | 'auto' | 'pending' | 'high' | 'scoped'
type EditingId = number | 'new' | null

type MemoryDraft = {
  content: string
  sourceType: AgentMemorySourceType
  importance: number
  confidence: number
  tagsText: string
}

const DEFAULT_DRAFT: MemoryDraft = {
  content: '',
  sourceType: 'fact',
  importance: 0.5,
  confidence: 1,
  tagsText: '',
}

function sourceOption(value: string) {
  return MEMORY_SOURCE_OPTIONS.find((option) => option.value === value)
}

function sourceLabel(value: string) {
  return sourceOption(value)?.label || value || '未知'
}

function toSourceType(value: unknown): AgentMemorySourceType {
  const text = String(value || '').trim()
  return MEMORY_SOURCE_OPTIONS.some((option) => option.value === text)
    ? text as AgentMemorySourceType
    : 'fact'
}

function clamp01(value: number, fallback = 0) {
  if (!Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(1, value))
}

function formatScore(value: number) {
  return `${Math.round(clamp01(value) * 100)}%`
}

function formatTime(value: number | null | undefined): string {
  if (!value) return '-'
  const ms = value < 10_000_000_000 ? value * 1000 : value
  return new Date(ms).toLocaleString('zh-CN')
}

function memoryAbout(item: AgentMemoryItem): string {
  return item.sessionId || item.contactId || item.groupId || '全局'
}

function isPendingMemory(item: AgentMemoryItem): boolean {
  return item.tags?.includes('pending')
}

function isAutoMemory(item: AgentMemoryItem): boolean {
  return item.tags?.includes('auto')
}

function isHighMemory(item: AgentMemoryItem): boolean {
  return item.importance >= 0.75 && item.confidence >= 0.75
}

function isStructuredMemory(item: AgentMemoryItem): boolean {
  return STRUCTURED_SOURCE_TYPES.includes(toSourceType(item.sourceType))
}

function parseTags(tagsText: string): string[] {
  return Array.from(new Set(
    tagsText
      .split(/[,，\n]/)
      .map((tag) => tag.trim())
      .filter(Boolean),
  ))
}

function toDraft(item: AgentMemoryItem): MemoryDraft {
  return {
    content: item.content,
    sourceType: toSourceType(item.sourceType),
    importance: clamp01(item.importance, 0.5),
    confidence: clamp01(item.confidence, 1),
    tagsText: item.tags.join(', '),
  }
}

function searchableText(item: AgentMemoryItem) {
  return [
    item.title,
    item.content,
    item.sourceType,
    memoryAbout(item),
    item.tags?.join(' '),
    item.entities?.join(' '),
    item.memoryUid,
  ].filter(Boolean).join('\n').toLowerCase()
}

export default function MemoryTab({ showMessage }: MemoryTabProps) {
  const [items, setItems] = useState<AgentMemoryItem[]>([])
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [consolidating, setConsolidating] = useState(false)
  const [editingId, setEditingId] = useState<EditingId>(null)
  const [draft, setDraft] = useState<MemoryDraft | null>(null)
  const [typeFilter, setTypeFilter] = useState<MemoryTypeFilter>('all')
  const [statusFilter, setStatusFilter] = useState<MemoryStatusFilter>('all')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const stats = useMemo(() => {
    return {
      totalLoaded: items.length,
      pending: items.filter(isPendingMemory).length,
      auto: items.filter(isAutoMemory).length,
      high: items.filter(isHighMemory).length,
      structured: items.filter(isStructuredMemory).length,
    }
  }, [items])

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return items.filter((item) => {
      if (typeFilter !== 'all' && item.sourceType !== typeFilter) return false
      if (statusFilter === 'auto' && !isAutoMemory(item)) return false
      if (statusFilter === 'pending' && !isPendingMemory(item)) return false
      if (statusFilter === 'high' && !isHighMemory(item)) return false
      if (statusFilter === 'scoped' && memoryAbout(item) === '全局') return false
      if (normalizedQuery && !searchableText(item).includes(normalizedQuery)) return false
      return true
    })
  }, [items, query, statusFilter, typeFilter])

  const selectedItem = useMemo(
    () => items.find((item) => item.id === selectedId) || null,
    [items, selectedId],
  )

  useEffect(() => {
    if (editingId === 'new') return
    if (filteredItems.length === 0) {
      if (selectedId != null) setSelectedId(null)
      return
    }
    if (!selectedId || !filteredItems.some((item) => item.id === selectedId)) {
      setSelectedId(filteredItems[0].id)
    }
  }, [editingId, filteredItems, selectedId])

  const load = async () => {
    setLoading(true)
    try {
      const res = await window.electronAPI.memory.list({ limit: LOAD_LIMIT })
      if (res.success) {
        const merged = [...(res.items ?? [])]
          .sort((a, b) => (b.timeEnd || b.timeStart || b.updatedAt) - (a.timeEnd || a.timeStart || a.updatedAt) || b.id - a.id)
        setItems(merged)
        setCount(res.stats?.itemCount ?? merged.length)
        setSelectedId((current) => (current && merged.some((item) => item.id === current) ? current : merged[0]?.id ?? null))
      } else {
        showMessage(res.error || '加载记忆失败', false)
      }
    } catch {
      showMessage('加载记忆失败', false)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const cancelEdit = () => {
    setEditingId(null)
    setDraft(null)
  }

  const startCreate = () => {
    setEditingId('new')
    setSelectedId(null)
    setDraft(DEFAULT_DRAFT)
  }

  const startEdit = (item: AgentMemoryItem) => {
    setSelectedId(item.id)
    setEditingId(item.id)
    setDraft(toDraft(item))
  }

  const handleDelete = async (id: number) => {
    const res = await window.electronAPI.memory.delete(id)
    if (res.success) {
      setItems((prev) => prev.filter((memory) => memory.id !== id))
      setCount((current) => Math.max(0, current - 1))
      if (selectedId === id) setSelectedId(null)
      if (editingId === id) cancelEdit()
    } else {
      showMessage(res.error || '删除失败', false)
    }
  }

  const handleSave = async () => {
    if (!draft || !editingId) return
    const content = draft.content.trim()
    if (!content) {
      showMessage('记忆内容不能为空', false)
      return
    }
    const payload = {
      sourceType: draft.sourceType,
      content,
      importance: clamp01(draft.importance, 0.5),
      confidence: clamp01(draft.confidence, 1),
      tags: parseTags(draft.tagsText),
    }
    try {
      const res = editingId === 'new'
        ? await window.electronAPI.memory.create({ ...payload, title: content.slice(0, 40) })
        : await window.electronAPI.memory.update({ id: editingId, ...payload })
      if (res.success && res.item) {
        if (editingId === 'new') {
          setItems((prev) => [res.item!, ...prev])
          setCount((current) => current + 1)
        } else {
          setItems((prev) => prev.map((item) => (item.id === editingId ? res.item! : item)))
        }
        setSelectedId(res.item.id)
        cancelEdit()
        showMessage(editingId === 'new' ? '记忆已创建' : '记忆已更新', true)
      } else {
        showMessage(res.error || '保存失败', false)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      showMessage(message.includes('No handler registered')
        ? '记忆保存 IPC 尚未加载，请重启应用后再试'
        : `保存失败：${message}`, false)
    }
  }

  const handleConfirmMemory = async (item: AgentMemoryItem) => {
    const tags = (item.tags || []).filter((tag) => tag !== 'pending')
    const res = await window.electronAPI.memory.update({
      id: item.id,
      sourceType: toSourceType(item.sourceType),
      content: item.content,
      importance: Math.max(item.importance, 0.75),
      confidence: Math.max(item.confidence, 0.85),
      tags,
    })
    if (res.success && res.item) {
      setItems((prev) => prev.map((memory) => (memory.id === item.id ? res.item! : memory)))
      showMessage('已确认自动记忆', true)
    } else {
      showMessage(res.error || '确认失败', false)
    }
  }

  const handleConsolidate = async () => {
    setConsolidating(true)
    try {
      const res = await window.electronAPI.memory.consolidate()
      if (res.success) {
        const profileText = res.result?.profileBuilt ? '，已刷新用户画像' : ''
        showMessage(`整理完成，扫描 ${res.result?.scanned ?? 0} 条，清理 ${res.result?.removed ?? 0} 条${profileText}`, true)
        void load()
      } else {
        showMessage(res.error || '整理失败', false)
      }
    } finally {
      setConsolidating(false)
    }
  }

  const handleExportMarkdown = async () => {
    setExporting(true)
    try {
      const picked = await window.electronAPI.dialog.openFile({ title: '选择记忆导出目录', properties: ['openDirectory'] })
      if (picked.canceled || picked.filePaths.length === 0) return
      const res = await window.electronAPI.memory.exportMarkdown(picked.filePaths[0])
      if (res.success) {
        showMessage(`已导出 ${res.result?.itemCount ?? 0} 条记忆`, true)
      } else {
        showMessage(res.error || '导出失败', false)
      }
    } catch {
      showMessage('导出失败', false)
    } finally {
      setExporting(false)
    }
  }

  const updateDraft = (patch: Partial<MemoryDraft>) => {
    setDraft((current) => current ? { ...current, ...patch } : current)
  }

  const renderTypeSelect = (value: MemoryTypeFilter, onChange: (value: MemoryTypeFilter) => void) => (
    <Select
      fullWidth
      selectedKey={value}
      variant="secondary"
      onSelectionChange={(key: Key | null) => {
        if (key != null) onChange(String(key) as MemoryTypeFilter)
      }}
    >
      <Label>类型</Label>
      <Select.Trigger>
        <Select.Value>{() => value === 'all' ? '全部类型' : sourceLabel(value)}</Select.Value>
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          <ListBox.Item id="all" textValue="全部类型">
            全部类型
            <ListBox.ItemIndicator />
          </ListBox.Item>
          {MEMORY_SOURCE_OPTIONS.map((option) => (
            <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
              <div className="flex min-w-0 flex-col">
                <span>{option.label}</span>
                <span className="text-xs text-muted">{option.hint}</span>
              </div>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  )

  const renderEditor = () => {
    if (!draft) return null
    return (
      <div className="space-y-4">
        <div>
          <Typography.Heading level={3} className="text-base font-semibold text-foreground">
            {editingId === 'new' ? '新增记忆' : `编辑记忆 #${editingId}`}
          </Typography.Heading>
          <Description>保存后会写回 cachePath/memory-bank 的结构化 Markdown 条目。</Description>
        </div>

        <TextField fullWidth onChange={(value) => updateDraft({ content: value })} value={draft.content}>
          <Label>内容</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.TextArea placeholder="一句话写清长期事实、偏好或关系" rows={5} />
          </InputGroup>
        </TextField>

        <Select
          fullWidth
          selectedKey={draft.sourceType}
          variant="secondary"
          onSelectionChange={(key: Key | null) => {
            if (key != null) updateDraft({ sourceType: toSourceType(key) })
          }}
        >
          <Label>记忆类型</Label>
          <Select.Trigger>
            <Select.Value>{() => sourceLabel(draft.sourceType)}</Select.Value>
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {MEMORY_SOURCE_OPTIONS.map((option) => (
                <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
                  <div className="flex min-w-0 flex-col">
                    <span>{option.label}</span>
                    <span className="text-xs text-muted">{option.hint}</span>
                  </div>
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>

        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField
            aria-label="重要度"
            maxValue={1}
            minValue={0}
            step={0.05}
            value={draft.importance}
            variant="secondary"
            onChange={(value) => updateDraft({ importance: clamp01(value ?? 0, 0.5) })}
          >
            <Label>重要度</Label>
            <NumberField.Group>
              <NumberField.DecrementButton />
              <NumberField.Input />
              <NumberField.IncrementButton />
            </NumberField.Group>
            <Description>{formatScore(draft.importance)}</Description>
          </NumberField>

          <NumberField
            aria-label="置信度"
            maxValue={1}
            minValue={0}
            step={0.05}
            value={draft.confidence}
            variant="secondary"
            onChange={(value) => updateDraft({ confidence: clamp01(value ?? 0, 1) })}
          >
            <Label>置信度</Label>
            <NumberField.Group>
              <NumberField.DecrementButton />
              <NumberField.Input />
              <NumberField.IncrementButton />
            </NumberField.Group>
            <Description>{formatScore(draft.confidence)}</Description>
          </NumberField>
        </div>

        <TextField fullWidth onChange={(value) => updateDraft({ tagsText: value })} value={draft.tagsText}>
          <Label>标签</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.Input placeholder="auto, pending, work" />
          </InputGroup>
          <Description>多个标签用逗号或换行分隔。</Description>
        </TextField>

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="primary" onPress={() => void handleSave()}>
            <Check size={16} />
            保存
          </Button>
          <Button type="button" variant="tertiary" onPress={cancelEdit}>
            <X size={16} />
            取消
          </Button>
        </div>
      </div>
    )
  }

  const renderDetail = () => {
    if (editingId) return renderEditor()
    if (!selectedItem) {
      return (
        <div className="flex min-h-64 items-center justify-center p-6 text-center">
          <Typography.Paragraph color="muted" size="sm">
            {loading ? '正在加载记忆...' : '选择一条记忆查看详情。'}
          </Typography.Paragraph>
        </div>
      )
    }

    const refs = selectedItem.sourceRefs || []
    return (
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Chip size="sm" variant="soft">{sourceLabel(selectedItem.sourceType)}</Chip>
              {isAutoMemory(selectedItem) && <Chip size="sm" variant="soft">自动</Chip>}
              {isPendingMemory(selectedItem) && <Chip color="warning" size="sm" variant="soft">待确认</Chip>}
              {isHighMemory(selectedItem) && <Chip color="success" size="sm" variant="soft">高权重</Chip>}
            </div>
            <Typography.Heading level={3} className="break-words text-base font-semibold text-foreground">
              {selectedItem.title || `记忆 #${selectedItem.id}`}
            </Typography.Heading>
          </div>
          <Button isIconOnly aria-label="关闭详情" size="sm" variant="tertiary" onPress={() => setSelectedId(null)}>
            <X size={16} />
          </Button>
        </div>

        <Typography.Paragraph className="whitespace-pre-wrap break-words text-sm leading-6">
          {selectedItem.content}
        </Typography.Paragraph>

        <div className="grid gap-2 text-sm sm:grid-cols-2">
          <div className="rounded-md border border-border p-2">
            <span className="text-xs text-muted">关于</span>
            <div className="mt-1 break-all text-foreground">{memoryAbout(selectedItem)}</div>
          </div>
          <div className="rounded-md border border-border p-2">
            <span className="text-xs text-muted">记忆 UID</span>
            <div className="mt-1 break-all font-mono text-xs text-foreground">{selectedItem.memoryUid || '-'}</div>
          </div>
          <div className="rounded-md border border-border p-2">
            <span className="text-xs text-muted">重要度 / 置信度</span>
            <div className="mt-1 text-foreground">{formatScore(selectedItem.importance)} / {formatScore(selectedItem.confidence)}</div>
          </div>
          <div className="rounded-md border border-border p-2">
            <span className="text-xs text-muted">更新时间</span>
            <div className="mt-1 text-foreground">{formatTime(selectedItem.updatedAt)}</div>
          </div>
          <div className="rounded-md border border-border p-2">
            <span className="text-xs text-muted">记忆时间</span>
            <div className="mt-1 text-foreground">{formatTime(selectedItem.timeStart || selectedItem.timeEnd)}</div>
          </div>
          <div className="rounded-md border border-border p-2">
            <span className="text-xs text-muted">创建时间</span>
            <div className="mt-1 text-foreground">{formatTime(selectedItem.createdAt)}</div>
          </div>
        </div>

        {selectedItem.tags.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {selectedItem.tags.map((tag) => (
              <Chip key={tag} size="sm" variant="soft">{tag}</Chip>
            ))}
          </div>
        )}

        {refs.length > 0 && (
          <div className="space-y-2">
            <Typography.Paragraph color="muted" size="sm">证据引用</Typography.Paragraph>
            <ScrollShadow className="max-h-48 rounded-md border border-border">
              <div className="space-y-2 p-3">
                {refs.map((ref) => (
                  <div className="rounded-md bg-default p-2 text-xs" key={`${ref.sessionId}:${ref.localId}:${ref.sortSeq}`}>
                    <div className="break-all font-mono text-muted">{ref.sessionId} / {ref.localId}</div>
                    <div className="mt-1 text-muted">{formatTime(ref.createTime)}</div>
                    {ref.excerpt && <div className="mt-1 whitespace-pre-wrap break-words text-foreground">{ref.excerpt}</div>}
                  </div>
                ))}
              </div>
            </ScrollShadow>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {isPendingMemory(selectedItem) && (
            <Button type="button" variant="secondary" onPress={() => void handleConfirmMemory(selectedItem)}>
              <Check size={16} />
              确认
            </Button>
          )}
          <Button type="button" variant="secondary" onPress={() => startEdit(selectedItem)}>
            <Pencil size={16} />
            编辑
          </Button>
          <AlertDialog>
            <Button type="button" variant="danger">
              <Trash2 size={16} />
              删除
            </Button>
            <AlertDialog.Backdrop>
              <AlertDialog.Container>
                <AlertDialog.Dialog>
                  <AlertDialog.CloseTrigger />
                  <AlertDialog.Header>
                    <AlertDialog.Icon status="danger" />
                    <AlertDialog.Heading>删除这条记忆？</AlertDialog.Heading>
                  </AlertDialog.Header>
                  <AlertDialog.Body>
                    <Typography.Paragraph size="sm">
                      删除后，AI 不会再把这条内容作为长期记忆参考。此操作不可撤销。
                    </Typography.Paragraph>
                    <Typography.Paragraph size="sm" color="muted">
                      {selectedItem.content}
                    </Typography.Paragraph>
                  </AlertDialog.Body>
                  <AlertDialog.Footer>
                    <Button slot="close" variant="tertiary">取消</Button>
                    <Button slot="close" variant="danger" onPress={() => void handleDelete(selectedItem.id)}>
                      删除
                    </Button>
                  </AlertDialog.Footer>
                </AlertDialog.Dialog>
              </AlertDialog.Container>
            </AlertDialog.Backdrop>
          </AlertDialog>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <Card>
        <Card.Header className="flex-col items-start gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <Card.Title>长期记忆</Card.Title>
            <Card.Description>
              读取 cachePath/memory-bank 的结构化记忆条目，覆盖画像、事实、关系、消息片段、对话块、时间线和媒体线索。
            </Card.Description>
            <div className="mt-3 flex flex-wrap gap-2">
              <Chip color="accent" size="sm" variant="soft">{count} 条总计</Chip>
              <Chip size="sm" variant="soft">{stats.totalLoaded} 条已加载</Chip>
              <Chip size="sm" variant="soft">{stats.structured} 条长期结构化</Chip>
              {stats.auto > 0 && <Chip size="sm" variant="soft">{stats.auto} 条自动抽取</Chip>}
              {stats.high > 0 && <Chip color="success" size="sm" variant="soft">{stats.high} 条高权重</Chip>}
              {stats.pending > 0 && <Chip color="warning" size="sm" variant="soft">{stats.pending} 条待确认</Chip>}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button type="button" variant="secondary" onPress={startCreate}>
              <Plus size={16} />
              新增
            </Button>
            <Button isDisabled={loading} type="button" variant="secondary" onPress={() => void load()}>
              <RefreshCw className={loading ? 'animate-spin' : ''} size={16} />
              刷新
            </Button>
            <Button isDisabled={consolidating} type="button" variant="secondary" onPress={() => void handleConsolidate()}>
              <Sparkles size={16} />
              {consolidating ? '整理中...' : '整理'}
            </Button>
            <Button isDisabled={exporting} type="button" variant="secondary" onPress={() => void handleExportMarkdown()}>
              <Download size={16} />
              导出
            </Button>
          </div>
        </Card.Header>
      </Card>

      <Card>
        <Card.Content className="space-y-4">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_240px]">
            <TextField fullWidth onChange={setQuery} value={query}>
              <Label>搜索</Label>
              <InputGroup fullWidth variant="secondary">
                <InputGroup.Prefix>
                  <Search size={15} />
                </InputGroup.Prefix>
                <InputGroup.Input placeholder="内容、标签、对象或 UID" />
              </InputGroup>
            </TextField>
            {renderTypeSelect(typeFilter, setTypeFilter)}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <ButtonGroup variant="tertiary">
              <Button onPress={() => setStatusFilter('all')} variant={statusFilter === 'all' ? 'secondary' : 'tertiary'}>全部</Button>
              <Button onPress={() => setStatusFilter('auto')} variant={statusFilter === 'auto' ? 'secondary' : 'tertiary'}>自动</Button>
              <Button onPress={() => setStatusFilter('pending')} variant={statusFilter === 'pending' ? 'secondary' : 'tertiary'}>待确认</Button>
              <Button onPress={() => setStatusFilter('high')} variant={statusFilter === 'high' ? 'secondary' : 'tertiary'}>高权重</Button>
              <Button onPress={() => setStatusFilter('scoped')} variant={statusFilter === 'scoped' ? 'secondary' : 'tertiary'}>会话相关</Button>
            </ButtonGroup>
            <Description>当前显示 {filteredItems.length} / {stats.totalLoaded} 条。</Description>
          </div>
        </Card.Content>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(340px,0.72fr)]">
        <Card className="min-w-0">
          <Card.Header className="flex-row items-start justify-between gap-3">
            <div>
              <Card.Title>记忆列表</Card.Title>
              <Card.Description>
                {count > stats.totalLoaded ? `已加载最近 ${stats.totalLoaded} 条，导出可复制完整 memory-bank。` : '按最新更新时间排序。'}
              </Card.Description>
            </div>
          </Card.Header>
          <Card.Content className="p-0">
            {loading && items.length === 0 ? (
              <div className="space-y-3 p-4">
                <Skeleton className="h-20 rounded-lg" />
                <Skeleton className="h-20 rounded-lg" />
                <Skeleton className="h-20 rounded-lg" />
              </div>
            ) : filteredItems.length === 0 ? (
              <div className="p-6">
                <Typography.Paragraph color="muted" size="sm">
                  没有匹配的记忆。
                </Typography.Paragraph>
              </div>
            ) : (
              <ScrollShadow className="max-h-[62vh]">
                <div className="space-y-2 p-3">
                  {filteredItems.map((item) => {
                    const selected = selectedId === item.id
                    return (
                      <div
                        className={`rounded-lg border p-3 transition-colors ${
                          selected ? 'border-accent bg-accent-soft' : 'border-border bg-default hover:bg-surface-secondary'
                        }`}
                        key={item.id}
                      >
                        <button
                          className="block w-full text-left"
                          type="button"
                          onClick={() => {
                            if (editingId) cancelEdit()
                            setSelectedId(item.id)
                          }}
                        >
                          <div className="mb-2 flex flex-wrap items-center gap-2">
                            <Chip size="sm" variant="soft">{sourceLabel(item.sourceType)}</Chip>
                            {isAutoMemory(item) && <Chip size="sm" variant="soft">自动</Chip>}
                            {isPendingMemory(item) && <Chip color="warning" size="sm" variant="soft">待确认</Chip>}
                            <span className="ml-auto text-xs text-muted">{formatTime(item.timeEnd || item.timeStart || item.updatedAt)}</span>
                          </div>
                          <div className="line-clamp-2 break-words text-sm leading-6 text-foreground">{item.content}</div>
                          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                            <span>关于 {memoryAbout(item)}</span>
                            <span>重要度 {formatScore(item.importance)}</span>
                            <span>置信度 {formatScore(item.confidence)}</span>
                          </div>
                        </button>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <Button size="sm" type="button" variant="tertiary" onPress={() => setSelectedId(item.id)}>
                            <Eye size={14} />
                            详情
                          </Button>
                          {isPendingMemory(item) && (
                            <Button size="sm" type="button" variant="secondary" onPress={() => void handleConfirmMemory(item)}>
                              <Check size={14} />
                              确认
                            </Button>
                          )}
                          <Button size="sm" type="button" variant="tertiary" onPress={() => startEdit(item)}>
                            <Pencil size={14} />
                            编辑
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </ScrollShadow>
            )}
          </Card.Content>
        </Card>

        <Card className="min-w-0">
          <Card.Header>
            <Card.Title>{editingId ? '编辑' : '详情'}</Card.Title>
            <Card.Description>查看、确认、修改或删除选中的记忆条目。</Card.Description>
          </Card.Header>
          <Card.Content>
            {renderDetail()}
          </Card.Content>
        </Card>
      </div>
    </div>
  )
}
