import { Check, CircleAlert, Loader2 } from 'lucide-react'
import type { ProgressEvent } from '../types'

interface Props {
  events?: ProgressEvent[]
}

export function ProgressTimeline({ events }: Props) {
  if (!events || events.length === 0) return null

  return (
    <div className="agent-progress-timeline" aria-label="AI Agent 进度">
      {events.map(event => (
        <div className={`agent-progress-timeline__item is-${event.status}`} key={event.id}>
          <span className="agent-progress-timeline__icon" aria-hidden="true">
            {event.status === 'running'
              ? <Loader2 size={12} className="agent-progress-timeline__spin" />
              : event.status === 'failed'
                ? <CircleAlert size={12} />
                : <Check size={12} />
            }
          </span>
          <span className="agent-progress-timeline__text">
            <span className="agent-progress-timeline__title">{event.displayName || event.title}</span>
            {event.detail ? <span className="agent-progress-timeline__detail">{event.detail}</span> : null}
          </span>
          {typeof event.count === 'number' ? (
            <span className="agent-progress-timeline__count">{event.count}</span>
          ) : null}
        </div>
      ))}
    </div>
  )
}
