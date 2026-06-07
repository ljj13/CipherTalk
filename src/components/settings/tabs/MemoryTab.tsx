import { useEffect, useState } from 'react'
import { Brain, Trash2, Sparkles, RefreshCw } from 'lucide-react'
import type { AgentMemoryItem } from '../../../types/electron'

interface MemoryTabProps {
  showMessage: (text: string, success: boolean) => void
}

function kindLabel(kind: string) {
  if (kind === 'profile') return '画像'
  if (kind === 'fact') return '事实'
  return kind
}

export default function MemoryTab({ showMessage }: MemoryTabProps) {
  const [items, setItems] = useState<AgentMemoryItem[]>([])
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const res = await window.electronAPI.memory.list({ limit: 300 })
      if (res.success) {
        setItems(res.items ?? [])
        setCount(res.stats?.itemCount ?? res.items?.length ?? 0)
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

  const handleDelete = async (id: number) => {
    const res = await window.electronAPI.memory.delete(id)
    if (res.success) {
      setItems((prev) => prev.filter((m) => m.id !== id))
      setCount((c) => Math.max(0, c - 1))
    } else {
      showMessage(res.error || '删除失败', false)
    }
  }

  const handleConsolidate = async () => {
    const res = await window.electronAPI.memory.consolidate()
    if (res.success) {
      showMessage(`整理完成，清理 ${res.result?.removed ?? 0} 条`, true)
      void load()
    } else {
      showMessage(res.error || '整理失败', false)
    }
  }

  return (
    <div className="tab-content">
      <div className="mx-auto w-full max-w-290 space-y-5 px-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Brain size={18} /> AI 长期记忆
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              AI 跨对话记住的关于你的画像 / 偏好 / 事实，共 {count} 条。由 AI 在对话中自动记录，可在此查看或删除。
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <button className="btn btn-secondary" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={14} /> 刷新
            </button>
            <button className="btn btn-secondary" onClick={() => void handleConsolidate()}>
              <Sparkles size={14} /> 整理去冗余
            </button>
          </div>
        </div>

        {items.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-8 text-center text-sm text-muted-foreground">
            {loading ? '加载中…' : '还没有任何长期记忆。和 AI 聊聊你的偏好 / 身份，它会自动记下来。'}
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((m) => (
              <div
                key={m.id}
                className="flex items-start justify-between gap-3 rounded-lg border border-border bg-surface p-3"
              >
                <div className="min-w-0 space-y-1">
                  <div className="break-words text-sm">{m.content}</div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="rounded bg-muted/60 px-1.5 py-0.5">{kindLabel(m.sourceType)}</span>
                    <span>重要度 {Math.round(m.importance * 100) / 100}</span>
                    {m.tags?.includes('auto') && <span className="rounded bg-muted/60 px-1.5 py-0.5">自动</span>}
                    {m.sessionId && <span className="max-w-50 truncate">关于 {m.sessionId}</span>}
                  </div>
                </div>
                <button
                  className="btn btn-danger shrink-0"
                  onClick={() => void handleDelete(m.id)}
                  title="删除这条记忆"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
