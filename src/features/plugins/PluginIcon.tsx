import {
  BarChart3, BookOpen, Calendar, Clock, Database, Download, FileText, Globe,
  Heart, Image, MessageSquare, Mic, Puzzle, Search, Smile, Sparkles, Star,
  Tag, Users, Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/**
 * 插件贡献点图标：manifest 里声明图标名，宿主用内置 lucide 集合渲染。
 * 未知名字回退 Puzzle——渲染贡献点不执行任何插件代码。
 */
const ICON_MAP: Record<string, LucideIcon> = {
  'bar-chart': BarChart3,
  'chart-bar': BarChart3,
  'book-open': BookOpen,
  calendar: Calendar,
  clock: Clock,
  database: Database,
  download: Download,
  'file-text': FileText,
  globe: Globe,
  heart: Heart,
  image: Image,
  'message-square': MessageSquare,
  mic: Mic,
  puzzle: Puzzle,
  search: Search,
  smile: Smile,
  sparkles: Sparkles,
  star: Star,
  tag: Tag,
  users: Users,
  zap: Zap,
}

export function PluginIcon({ name, size }: { name?: string; size?: number }) {
  const Icon = (name && ICON_MAP[name]) || Puzzle
  return <Icon size={size} />
}
