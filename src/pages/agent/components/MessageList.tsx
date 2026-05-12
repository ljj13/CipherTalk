import { useEffect, useRef } from 'react'
import { MessageBubble } from './MessageBubble'
import { TypingIndicator } from './TypingIndicator'
import type { Message } from '../types'

interface Props {
  messages: Message[]
  loading: boolean
}

export function MessageList({ messages, loading }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, loading])

  return (
    <div className="agent-message-list" ref={scrollRef}>
      <div className="agent-message-list__inner">
        <div className="agent-message-list__items">
          {messages.length === 0 && !loading ? (
            <div className="agent-empty-state">暂无对话内容</div>
          ) : null}
          {messages.map(msg => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
          {loading && <TypingIndicator />}
        </div>
        <div className="agent-message-list__end" ref={bottomRef} />
      </div>
    </div>
  )
}
