import { Bot, User } from 'lucide-react'
import type { Message } from '../types'
import { AssistantBlocks } from './AssistantBlocks'

interface Props {
  message: Message
}

export function MessageBubble({ message }: Props) {
  const isUser = message.role === 'user'
  const blocks = message.blocks || (message.content ? [{ type: 'text' as const, text: message.content }] : [])

  return (
    <article className={`agent-message agent-message--${isUser ? 'user' : 'assistant'}`}>
      {!isUser ? (
        <div className="agent-message__avatar" aria-hidden="true">
          <Bot size={16} />
        </div>
      ) : null}

      {isUser ? (
        <div className="agent-message__user-bubble">
          <User size={14} />
          <span>{message.content}</span>
        </div>
      ) : (
        <div className="agent-message__assistant-body">
          <AssistantBlocks blocks={blocks} streaming={message.streaming} />
        </div>
      )}
    </article>
  )
}
