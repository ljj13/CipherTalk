import { useState } from 'react'
import type { Message } from '../types'

export function useAgentChat() {
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(false)

  const send = (text: string) => {
    if (!text.trim() || loading) return

    const userMsg: Message = { id: `u-${Date.now()}`, role: 'user', content: text }
    setMessages(prev => [...prev, userMsg])
    setLoading(true)

    // TODO: 接入真实 AI 接口
    setTimeout(() => {
      const reply: Message = {
        id: `a-${Date.now()}`,
        role: 'assistant',
        blocks: [
          {
            type: 'text',
            text: `收到：${text}\n\nAgent 功能尚未接入真实运行时。`,
          },
        ],
      }
      setMessages(prev => [...prev, reply])
      setLoading(false)
    }, 800)
  }

  const reset = () => {
    setMessages([])
    setLoading(false)
  }

  return { messages, loading, send, reset }
}
