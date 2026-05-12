import { Bot } from 'lucide-react'
import { AssistantBlocks } from './AssistantBlocks'

export function TypingIndicator() {
  return (
    <article className="agent-message agent-message--assistant">
      <div className="agent-message__avatar" aria-hidden="true">
        <Bot size={16} />
      </div>
      <div className="agent-message__assistant-body">
        <AssistantBlocks
          streaming
          blocks={[
            {
              type: 'thinking',
              open: true,
              lines: ['理解问题意图', '准备检索或调用工具', '组织可读答案'],
            },
            {
              type: 'tool',
              name: 'agent_runtime',
              status: 'running',
              args: { task: 'compose_answer' },
            },
          ]}
        />
      </div>
    </article>
  )
}
