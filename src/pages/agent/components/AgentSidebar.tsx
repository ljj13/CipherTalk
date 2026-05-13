import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, PanelLeftClose, PanelLeftOpen, Pencil, Search, SquarePen, Trash2, X } from 'lucide-react'
import type { ConversationGroup } from '../types'

interface Props {
  collapsed: boolean
  conversations: ConversationGroup[]
  activeId: string
  query: string
  onQueryChange: (query: string) => void
  onToggle: () => void
  onNew: () => void
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
}

export function AgentSidebar({
  collapsed,
  conversations,
  activeId,
  query,
  onQueryChange,
  onToggle,
  onNew,
  onSelect,
  onDelete,
  onRename,
}: Props) {
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingId) {
      editInputRef.current?.focus()
      editInputRef.current?.select()
    }
  }, [editingId])

  const startEdit = (id: string, currentTitle: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setPendingDeleteId(null)
    setEditingId(id)
    setEditValue(currentTitle)
  }

  const commitEdit = (id: string) => {
    const trimmed = editValue.trim()
    if (trimmed) onRename(id, trimmed)
    setEditingId(null)
  }

  const normalizedQuery = query.trim().toLowerCase()
  const filtered = normalizedQuery
    ? conversations
        .map(group => ({
          ...group,
          items: group.items.filter(item =>
            `${item.title} ${item.preview}`.toLowerCase().includes(normalizedQuery),
          ),
        }))
        .filter(group => group.items.length > 0)
    : conversations

  if (collapsed) {
    return (
      <aside className="agent-sidebar agent-sidebar--collapsed" aria-label="Agent 历史对话">
        <button className="agent-icon-button" type="button" onClick={onToggle} title="展开历史记录">
          <PanelLeftOpen size={16} />
        </button>
      </aside>
    )
  }

  return (
    <aside className="agent-sidebar" aria-label="Agent 历史对话">
      <div className="agent-sidebar__toolbar">
        <button className="agent-icon-button" type="button" onClick={onToggle} title="收回历史记录">
          <PanelLeftClose size={16} />
        </button>
        <button
          className={`agent-icon-button${activeId === 'new' ? ' agent-icon-button--accent' : ''}`}
          type="button"
          onClick={onNew}
          title="新对话"
        >
          <SquarePen size={15} />
        </button>
      </div>

      <label className="agent-sidebar__search">
        <Search size={14} />
        <input
          type="text"
          value={query}
          onChange={event => onQueryChange(event.target.value)}
          placeholder="搜索历史..."
        />
        {query ? (
          <button type="button" onClick={() => onQueryChange('')} title="清空搜索">
            <X size={13} />
          </button>
        ) : null}
      </label>

      <div className="agent-sidebar__scroll">
        {filtered.length === 0 ? (
          <div className="agent-sidebar__empty">{query.trim() ? '没有匹配的对话' : '暂无历史对话'}</div>
        ) : (
          filtered.map(group => (
            <section className="agent-sidebar__group" key={group.group}>
              <div className="agent-sidebar__group-title">{group.group}</div>
              {group.items.map(item => {
                const isPendingDelete = pendingDeleteId === item.id
                const isEditing = editingId === item.id

                return (
                  <div
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    className={`agent-sidebar__row${item.id === activeId ? ' is-active' : ''}${isPendingDelete ? ' is-pending-delete' : ''}`}
                    onClick={() => {
                      if (isPendingDelete || isEditing) return
                      setPendingDeleteId(null)
                      onSelect(item.id)
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !isPendingDelete && !isEditing) {
                        setPendingDeleteId(null)
                        onSelect(item.id)
                      }
                    }}
                  >
                    {isPendingDelete ? (
                      <div className="agent-sidebar__row-confirm">
                        <AlertTriangle size={13} />
                        <span>确认删除？</span>
                        <button
                          type="button"
                          className="agent-sidebar__confirm-btn agent-sidebar__confirm-btn--danger"
                          onClick={e => { e.stopPropagation(); onDelete(item.id); setPendingDeleteId(null) }}
                        >
                          删除
                        </button>
                        <button
                          type="button"
                          className="agent-sidebar__confirm-btn"
                          onClick={e => { e.stopPropagation(); setPendingDeleteId(null) }}
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      <>
                        {isEditing ? (
                          <input
                            ref={editInputRef}
                            className="agent-sidebar__title-input"
                            value={editValue}
                            onChange={e => setEditValue(e.target.value)}
                            onBlur={() => commitEdit(item.id)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') { e.preventDefault(); commitEdit(item.id) }
                              if (e.key === 'Escape') { e.preventDefault(); setEditingId(null) }
                            }}
                            onClick={e => e.stopPropagation()}
                          />
                        ) : (
                          <span className="agent-sidebar__row-title">{item.title}</span>
                        )}
                        <span className="agent-sidebar__row-preview">{item.preview}</span>
                        <span className="agent-sidebar__row-time">{item.time}</span>
                        <div className="agent-sidebar__row-actions">
                          <span
                            className="agent-sidebar__row-action-btn"
                            role="button"
                            title="重命名"
                            onClick={e => startEdit(item.id, item.title, e)}
                          >
                            <Pencil size={13} />
                          </span>
                          <span
                            className="agent-sidebar__row-action-btn agent-sidebar__row-action-btn--danger"
                            role="button"
                            title="删除对话"
                            onClick={e => { e.stopPropagation(); setPendingDeleteId(item.id) }}
                          >
                            <Trash2 size={13} />
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                )
              })}
            </section>
          ))
        )}
      </div>
    </aside>
  )
}
