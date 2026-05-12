import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import {
  AtSign,
  Cpu,
  Database,
  FileText,
  Globe2,
  Hammer,
  Image,
  Mic,
  Plus,
  Send,
  Slash,
  SlidersHorizontal,
  Sparkles,
  UserRoundSearch,
  X,
} from 'lucide-react'
import { MCP } from '@lobehub/icons'
import type { McpServerStatus } from '../../../hooks/useMcpSkillsData'
import type { AgentSkill, AttachedResource, AttachMenuItem, McpServer, SlashCommand } from '../types'

interface Props {
  onSend: (text: string) => void
  disabled?: boolean
  suggestions: string[]
  slashCommands: SlashCommand[]
  attachMenu: AttachMenuItem[]
  mcpServers: McpServer[]
  busyServers: Set<string>
  onToggleServer: (name: string, status: McpServerStatus) => void
  skills: AgentSkill[]
}

const attachIcons = {
  file: FileText,
  image: Image,
  database: Database,
  globe: Globe2,
  cpu: Cpu,
}

type ContextLength = '2k' | '8k' | '32k'

export function ChatInput({
  onSend, disabled, suggestions, slashCommands, attachMenu,
  mcpServers, busyServers, onToggleServer, skills,
}: Props) {
  const [value, setValue] = useState('')
  const [showSlash, setShowSlash] = useState(false)
  const [showAttach, setShowAttach] = useState(false)
  const [showMention, setShowMention] = useState(false)
  const [showMcp, setShowMcp] = useState(false)
  const [showSkills, setShowSkills] = useState(false)
  const [showContext, setShowContext] = useState(false)
  const [attached, setAttached] = useState<AttachedResource[]>([])
  const [enabledSkills, setEnabledSkills] = useState<Set<string>>(new Set())
  const [temperature, setTemperature] = useState(0.7)
  const [contextLength, setContextLength] = useState<ContextLength>('8k')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const visibleSlashCommands = useMemo(() => {
    if (!value.startsWith('/')) return slashCommands
    const commandPrefix = value.split(' ')[0]
    return slashCommands.filter(item => item.command.startsWith(commandPrefix))
  }, [slashCommands, value])

  const closeAll = () => {
    setShowSlash(false)
    setShowAttach(false)
    setShowMention(false)
    setShowMcp(false)
    setShowSkills(false)
    setShowContext(false)
  }

  useEffect(() => {
    if (!showSlash && !showAttach && !showMention && !showMcp && !showSkills && !showContext) return
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest('.agent-popover-host')) return
      closeAll()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [showAttach, showMention, showSlash, showMcp, showSkills, showContext])

  const submit = () => {
    const text = value.trim()
    if (!text || disabled) return
    onSend(text)
    setValue('')
    closeAll()
    requestAnimationFrame(() => resizeTextarea())
  }

  const resizeTextarea = () => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
    if (e.key === '/' && !value) { setShowSlash(true); setShowAttach(false) }
    if (e.key === '@' && !value) { setShowMention(true); setShowAttach(false); setShowSlash(false) }
    if (e.key === 'Escape') closeAll()
  }

  const toggleSkill = (id: string) => {
    setEnabledSkills(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const connectedCount = mcpServers.filter(s => s.status === 'connected').length
  const skillEnabledCount = enabledSkills.size

  return (
    <footer className="agent-composer-wrap">
      {suggestions.length ? (
        <div className="agent-suggestions">
          {suggestions.map(suggestion => (
            <button key={suggestion} type="button" onClick={() => onSend(suggestion)} disabled={disabled}>
              <Sparkles size={12} />
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}

      <div className="agent-composer" onClick={() => textareaRef.current?.focus()}>
        {attached.length ? (
          <div className="agent-composer__attached">
            {attached.map(item => {
              const Icon = attachIcons[item.icon]
              return (
                <span className="agent-attached-chip" key={item.id}>
                  <Icon size={13} />
                  {item.label}
                  <button
                    type="button"
                    onClick={event => {
                      event.stopPropagation()
                      setAttached(current => current.filter(r => r.id !== item.id))
                    }}
                    title="移除附件"
                  >
                    <X size={11} />
                  </button>
                </span>
              )
            })}
          </div>
        ) : null}

        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          disabled={disabled}
          className="agent-composer__textarea"
          placeholder="给 Agent 安排一个任务... 按 @ 引用，按 / 输入命令"
          onChange={event => {
            setValue(event.target.value)
            setShowSlash(event.target.value.startsWith('/'))
            resizeTextarea()
          }}
          onKeyDown={handleKeyDown}
        />

        <div className="agent-composer__bar">
          <div className="agent-composer__left">
            {/* 附加资源 */}
            <div className="agent-popover-host">
              <button
                type="button"
                className={`agent-round-button${showAttach ? ' is-open' : ''}`}
                onClick={event => { event.stopPropagation(); closeAll(); setShowAttach(v => !v) }}
                title="附加资源"
              >
                <Plus size={15} />
              </button>
              {showAttach ? (
                <ComposerPopover title="附加资源" onClose={() => setShowAttach(false)}>
                  {attachMenu.map(item => {
                    const Icon = attachIcons[item.icon]
                    return (
                      <button
                        className="agent-popover-row"
                        key={item.id}
                        type="button"
                        onClick={() => {
                          setAttached(current => [
                            ...current,
                            { id: `${item.id}-${Date.now()}`, label: item.label, icon: item.icon },
                          ])
                          setShowAttach(false)
                        }}
                      >
                        <span className="agent-popover-row__icon"><Icon size={15} /></span>
                        <span>
                          <strong>{item.label}</strong>
                          <small>{item.description}</small>
                        </span>
                      </button>
                    )
                  })}
                </ComposerPopover>
              ) : null}
            </div>

            {/* 引用对象 */}
            <div className="agent-popover-host">
              <button
                type="button"
                className={`agent-mention-button${showMention ? ' is-open' : ''}`}
                onClick={event => { event.stopPropagation(); closeAll(); setShowMention(v => !v) }}
                title="引用对象"
              >
                <AtSign size={15} />
              </button>
              {showMention ? (
                <ComposerPopover title="引用对象" onClose={() => setShowMention(false)}>
                  <div className="agent-popover-empty">
                    <UserRoundSearch size={16} />
                    <span>暂无可引用对象</span>
                  </div>
                </ComposerPopover>
              ) : null}
            </div>

            {/* 斜杠命令 */}
            <div className="agent-popover-host">
              <button
                type="button"
                className={`agent-command-button${showSlash ? ' is-open' : ''}`}
                onClick={event => { event.stopPropagation(); closeAll(); setShowSlash(v => !v) }}
                title="命令"
              >
                <Slash size={15} />
              </button>
              {showSlash ? (
                <ComposerPopover title="命令" onClose={() => setShowSlash(false)}>
                  {visibleSlashCommands.map(item => (
                    <button
                      className="agent-popover-row agent-popover-row--command"
                      key={item.command}
                      type="button"
                      onClick={() => {
                        setValue(`${item.command} `)
                        setShowSlash(false)
                        textareaRef.current?.focus()
                      }}
                    >
                      <code>{item.command}</code>
                      <small>{item.description}</small>
                    </button>
                  ))}
                </ComposerPopover>
              ) : null}
            </div>

            <div className="agent-composer__divider" />

            {/* MCP 服务器 */}
            <div className="agent-popover-host">
              <button
                type="button"
                className={`agent-tool-button${showMcp ? ' is-open' : ''}`}
                onClick={event => { event.stopPropagation(); closeAll(); setShowMcp(v => !v) }}
                title="MCP 服务"
              >
                <MCP size={13} />
                <span>MCP</span>
                {connectedCount > 0 && (
                  <span className="agent-tool-badge">{connectedCount}</span>
                )}
              </button>
              {showMcp ? (
                <ComposerPopover title="MCP 服务" onClose={() => setShowMcp(false)}>
                  {mcpServers.length === 0 ? (
                    <p className="agent-popover-empty">暂无已配置的 MCP 服务器</p>
                  ) : mcpServers.map(server => {
                    const isBusy = busyServers.has(server.id)
                    const isOn = server.status === 'connected'
                    return (
                      <button
                        className="agent-popover-row agent-popover-row--toggle"
                        key={server.id}
                        type="button"
                        disabled={isBusy}
                        onClick={() => onToggleServer(server.name, server.status)}
                      >
                        <span className={`agent-server-status agent-server-status--${server.status}`} />
                        <span>
                          <strong>{server.name}</strong>
                          <small>
                            {server.status === 'error' && server.error
                              ? server.error
                              : `${server.toolCount} 个工具`}
                          </small>
                        </span>
                        <span className={`agent-toggle${isOn ? ' is-on' : ''}${isBusy ? ' is-busy' : ''}`} />
                      </button>
                    )
                  })}
                </ComposerPopover>
              ) : null}
            </div>

            {/* Skills */}
            <div className="agent-popover-host">
              <button
                type="button"
                className={`agent-tool-button${showSkills ? ' is-open' : ''}`}
                onClick={event => { event.stopPropagation(); closeAll(); setShowSkills(v => !v) }}
                title="技能"
              >
                <Hammer size={13} />
                <span>Skills</span>
                {skillEnabledCount > 0 && (
                  <span className="agent-tool-badge">{skillEnabledCount}</span>
                )}
              </button>
              {showSkills ? (
                <ComposerPopover title="技能" onClose={() => setShowSkills(false)}>
                  {skills.length === 0
                    ? <p className="agent-popover-empty">暂无已导入的技能</p>
                    : skills.map(skill => {
                        const isEnabled = enabledSkills.has(skill.id)
                        return (
                          <button
                            className="agent-popover-row agent-popover-row--toggle"
                            key={skill.id}
                            type="button"
                            onClick={() => toggleSkill(skill.id)}
                          >
                            <span className="agent-popover-row__icon"><Hammer size={14} /></span>
                            <span>
                              <strong>{skill.name}</strong>
                              <small>{skill.description}</small>
                            </span>
                            {skill.builtin && <span className="agent-skill-tag">内置</span>}
                            <span className={`agent-toggle${isEnabled ? ' is-on' : ''}`} />
                          </button>
                        )
                      })
                  }
                </ComposerPopover>
              ) : null}
            </div>

            {/* 上下文设置 */}
            <div className="agent-popover-host">
              <button
                type="button"
                className={`agent-tool-button${showContext ? ' is-open' : ''}`}
                onClick={event => { event.stopPropagation(); closeAll(); setShowContext(v => !v) }}
                title="上下文设置"
              >
                <SlidersHorizontal size={13} />
              </button>
              {showContext ? (
                <ComposerPopover title="上下文设置" onClose={() => setShowContext(false)}>
                  <div className="agent-ctx-row">
                    <label>
                      创意程度
                      <span className="agent-ctx-value">{temperature.toFixed(1)}</span>
                    </label>
                    <input
                      className="agent-ctx-slider"
                      type="range"
                      min={0}
                      max={1}
                      step={0.1}
                      value={temperature}
                      onChange={e => setTemperature(Number(e.target.value))}
                    />
                    <div className="agent-ctx-slider-labels">
                      <span>精确</span>
                      <span>创意</span>
                    </div>
                  </div>
                  <div className="agent-ctx-row">
                    <label>上下文长度</label>
                    <div className="agent-ctx-chips">
                      {(['2k', '8k', '32k'] as ContextLength[]).map(len => (
                        <button
                          key={len}
                          type="button"
                          className={`agent-ctx-chip${contextLength === len ? ' is-active' : ''}`}
                          onClick={() => setContextLength(len)}
                        >
                          {len.toUpperCase()}
                        </button>
                      ))}
                    </div>
                  </div>
                </ComposerPopover>
              ) : null}
            </div>
          </div>

          <div className="agent-composer__right">
            <button className="agent-round-button" type="button" title="语音输入" disabled={disabled}>
              <Mic size={14} />
            </button>
            <button
              className={`agent-send-button${value.trim() ? ' is-ready' : ''}`}
              type="button"
              onClick={submit}
              disabled={!value.trim() || disabled}
              title="发送"
            >
              <Send size={15} />
            </button>
          </div>
        </div>
      </div>

      <div className="agent-composer-hint">
        <span><kbd>Enter</kbd> 发送</span>
        <span><kbd>Shift</kbd> + <kbd>Enter</kbd> 换行</span>
        <span><kbd>@</kbd> 引用</span>
        <span><kbd>/</kbd> 命令</span>
        <span>重要结论请二次确认</span>
      </div>
    </footer>
  )
}

function ComposerPopover({
  title,
  children,
  onClose,
}: {
  title: string
  children: ReactNode
  onClose: () => void
}) {
  return (
    <div className="agent-popover" onClick={event => event.stopPropagation()}>
      <div className="agent-popover__title">
        <span>{title}</span>
        <button type="button" onClick={onClose} title="关闭">
          <X size={12} />
        </button>
      </div>
      <div className="agent-popover__list">{children}</div>
    </div>
  )
}
