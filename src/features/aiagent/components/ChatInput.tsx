import { AgentComposer, type AgentComposerProps } from './AgentComposer'

export type ChatInputProps = AgentComposerProps

export function ChatInput(props: ChatInputProps) {
  return <AgentComposer {...props} />
}
