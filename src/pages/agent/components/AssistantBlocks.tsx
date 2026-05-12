import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Database,
  FileText,
  Globe2,
  Search,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react'
import type { AssistantBlock, TextBlock as AgentTextBlock, ToolBlock as AgentToolBlock, ToolResult } from '../types'

interface Props {
  blocks: AssistantBlock[]
  streaming?: boolean
}

const toolMeta: Record<string, { label: string; tone: string; Icon: LucideIcon }> = {
  session_context: { label: 'session_context', tone: 'purple', Icon: Database },
  agent_runtime: { label: 'agent_runtime', tone: 'green', Icon: Wrench },
  search_messages: { label: 'search_messages', tone: 'blue', Icon: Search },
  export_chat: { label: 'export_chat', tone: 'amber', Icon: FileText },
  web_fetch: { label: 'web_fetch', tone: 'blue', Icon: Globe2 },
}

export function AssistantBlocks({ blocks, streaming }: Props) {
  return (
    <>
      {blocks.map((block, index) => {
        if (block.type === 'thinking') return <ThinkingBlock block={block} key={`${block.type}-${index}`} />
        if (block.type === 'tool') return <ToolBlock block={block} key={`${block.type}-${index}`} />
        return <TextBlock block={block} key={`${block.type}-${index}`} streaming={streaming && index === blocks.length - 1} />
      })}
      {streaming ? <StreamingIndicator /> : null}
    </>
  )
}

function ThinkingBlock({ block }: { block: Extract<AssistantBlock, { type: 'thinking' }> }) {
  const [open, setOpen] = useState(Boolean(block.open))

  return (
    <div className={`agent-thinking${open ? ' is-open' : ''}`}>
      <button className="agent-thinking__header" type="button" onClick={() => setOpen(value => !value)}>
        <Brain size={14} />
        <span>思考过程</span>
        <em>{block.lines.length} 条线索 · {block.duration || '进行中'}</em>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open ? (
        <div className="agent-thinking__body">
          {block.lines.map((line, index) => (
            <div className="agent-thinking__line" key={`${line}-${index}`}>
              <span>·</span>
              {line}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function ToolBlock({ block }: { block: AgentToolBlock }) {
  const [open, setOpen] = useState(block.status !== 'running')
  const meta = toolMeta[block.name] || { label: block.name, tone: 'amber', Icon: Wrench }
  const Icon = meta.Icon
  const running = block.status === 'running'

  return (
    <div className={`agent-tool agent-tool--${meta.tone}${running ? ' is-running' : ''}`}>
      <button className="agent-tool__header" type="button" onClick={() => setOpen(value => !value)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className="agent-tool__icon">
          <Icon size={14} />
        </span>
        <span className="agent-tool__name">{meta.label}</span>
        <span className="agent-tool__args">{formatArgs(block.args)}</span>
        <span className="agent-tool__status">
          {running ? (
            <>
              <span className="agent-spinner" />
              运行中
            </>
          ) : block.status === 'ok' ? (
            <>
              <Check size={12} />
              {block.duration || '完成'}
            </>
          ) : (
            <>
              <X size={12} />
              失败
            </>
          )}
        </span>
      </button>
      {open && block.result ? (
        <div className="agent-tool__body">
          <ToolResultView result={block.result} />
        </div>
      ) : null}
    </div>
  )
}

function TextBlock({ block, streaming }: { block: AgentTextBlock; streaming?: boolean }) {
  return (
    <div className="agent-text-block">
      {block.text.split('\n\n').map((paragraph, index) => (
        <p key={`${paragraph}-${index}`}>{renderInline(paragraph)}</p>
      ))}
      {streaming ? <span className="agent-cursor" /> : null}
    </div>
  )
}

function ToolResultView({ result }: { result: ToolResult }) {
  if (result.kind === 'list') {
    return (
      <div className="agent-result-list">
        {(result.items || []).map(item => (
          <div className="agent-result-list__row" key={item}>{item}</div>
        ))}
      </div>
    )
  }

  if (result.kind === 'diff') {
    return (
      <pre className="agent-code agent-code--diff">
        <code>
          {(result.text || '').split('\n').map((line, index) => {
            const className = line.startsWith('+') ? 'is-add' : line.startsWith('-') ? 'is-del' : undefined
            return <span className={className} key={`${line}-${index}`}>{line || ' '}</span>
          })}
        </code>
      </pre>
    )
  }

  return (
    <pre className={`agent-code${result.kind === 'terminal' ? ' agent-code--terminal' : ''}`}>
      <code>{result.text}</code>
    </pre>
  )
}

function StreamingIndicator() {
  return (
    <div className="agent-streaming">
      <span className="agent-spinner" />
      <span>正在生成回复</span>
      <button type="button">
        <CircleStop size={12} />
        停止
      </button>
    </div>
  )
}

function formatArgs(args?: Record<string, unknown>) {
  if (!args) return ''
  const entries = Object.entries(args)
  if (!entries.length) return ''
  const [key, value] = entries[0]
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return `${key}: ${text}${entries.length > 1 ? ` +${entries.length - 1}` : ''}`
}

function renderInline(text: string) {
  const nodes: ReactNode[] = []
  let buffer = ''
  let index = 0

  const flush = () => {
    if (buffer) {
      nodes.push(buffer)
      buffer = ''
    }
  }

  while (index < text.length) {
    if (text[index] === '*' && text[index + 1] === '*') {
      const end = text.indexOf('**', index + 2)
      if (end > -1) {
        flush()
        nodes.push(<strong key={nodes.length}>{text.slice(index + 2, end)}</strong>)
        index = end + 2
        continue
      }
    }

    if (text[index] === '`') {
      const end = text.indexOf('`', index + 1)
      if (end > -1) {
        flush()
        nodes.push(<code className="agent-inline-code" key={nodes.length}>{text.slice(index + 1, end)}</code>)
        index = end + 1
        continue
      }
    }

    if (text[index] === '\n') {
      flush()
      nodes.push(<br key={nodes.length} />)
      index += 1
      continue
    }

    buffer += text[index]
    index += 1
  }

  flush()
  return nodes
}
