import { PanelLeftClose, PanelLeftOpen, Search, X } from 'lucide-react'
import type { ConversationGroup } from '../types'

interface Props {
  collapsed: boolean
  conversations: ConversationGroup[]
  activeId: string
  query: string
  onQueryChange: (query: string) => void
  onToggle: () => void
  onSelect: (id: string) => void
}

export function AgentSidebar({
  collapsed,
  conversations,
  activeId,
  query,
  onQueryChange,
  onToggle,
  onSelect,
}: Props) {
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
              {group.items.map(item => (
                <button
                  key={item.id}
                  type="button"
                  className={`agent-sidebar__row${item.id === activeId ? ' is-active' : ''}`}
                  onClick={() => onSelect(item.id)}
                >
                  <span className="agent-sidebar__row-title">{item.title}</span>
                  <span className="agent-sidebar__row-preview">{item.preview}</span>
                  <span className="agent-sidebar__row-time">{item.time}</span>
                </button>
              ))}
            </section>
          ))
        )}
      </div>
    </aside>
  )
}
