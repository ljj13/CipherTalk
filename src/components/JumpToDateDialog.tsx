import { useEffect, useState } from 'react'
import { Calendar as CalendarIcon, X } from 'lucide-react'
import AppDatePicker, { formatDateValue, parseDateValue } from './AppDatePicker'
import './JumpToDateDialog.scss'

interface JumpToDateDialogProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (date: Date) => void
  currentDate?: Date | null
}

function JumpToDateDialog({ isOpen, onClose, onSelect, currentDate }: JumpToDateDialogProps) {
  const [selectedDate, setSelectedDate] = useState('')

  useEffect(() => {
    if (isOpen) {
      setSelectedDate(currentDate ? formatDateValue(currentDate) : '')
    }
  }, [isOpen, currentDate])

  if (!isOpen) return null

  const handleCommit = (dateValue: string) => {
    const date = parseDateValue(dateValue)
    if (!date) return
    onSelect(date)
    onClose()
  }

  return (
    <div className="jump-date-overlay" onClick={onClose}>
      <div className="jump-date-modal" onClick={event => event.stopPropagation()}>
        <div className="jump-date-header">
          <div className="jump-date-title-row">
            <CalendarIcon size={18} />
            <h3>选择日期</h3>
          </div>
          <button className="jump-date-close-btn" onClick={onClose} aria-label="关闭日期选择">
            <X size={18} />
          </button>
        </div>

        <AppDatePicker
          mode="single"
          inline
          className="jump-date-inline-picker"
          value={selectedDate}
          onChange={setSelectedDate}
          onCommit={handleCommit}
          placeholder="选择日期"
          confirmLabel="跳转"
          showClear={false}
        />
      </div>
    </div>
  )
}

export default JumpToDateDialog
