import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  Chip,
  CircularProgress,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Snackbar,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material'
import { marked } from 'marked'
import JSZip from 'jszip'
import { Check, Copy, Download, Save, Plus, Trash2, Eye, Pencil, Plug, Unplug, Upload, FileCode, X } from 'lucide-react'
import * as configService from '../services/config'

type ToastState = { text: string; success: boolean }

type McpLaunchConfig = {
  command: string
  args: string[]
  cwd: string
  mode: 'dev' | 'packaged'
}

type SkillInfo = { name: string; version: string; description: string; builtin: boolean }

type McpClientConfig = {
  type: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  timeoutMs?: number
  autoConnect?: boolean
}

type McpServerStatus = {
  name: string
  config: McpClientConfig
  status: string
  toolCount: number
  error?: string
}

type McpToolInfo = {
  name: string
  description?: string
  inputSchema?: unknown
}

type TopTab = 'server' | 'integration'

type ServerFormState = {
  name: string
  type: string
  command: string
  args: string
  env: string
  cwd: string
  url: string
  headers: string
  timeoutMs: string
}

type SkillPanelState = {
  name: string
  mode: 'preview' | 'edit'
}

type SkillDialogState = SkillPanelState | null

function formatCommandPart(value: string) {
  if (!value) return value
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
}

function getPackagedLauncherLabel(command: string) {
  return command.endsWith('ciphertalk-mcp') ? '`ciphertalk-mcp`' : '`ciphertalk-mcp.cmd`'
}

function createEmptyServerForm(): ServerFormState {
  return {
    name: '',
    type: 'stdio',
    command: '',
    args: '',
    env: '',
    cwd: '',
    url: '',
    headers: '',
    timeoutMs: '30000',
  }
}

type ParsedServerResult = { name?: string; form: Partial<ServerFormState>; error?: string }

function configObjectToForm(cfg: Record<string, unknown>): Partial<ServerFormState> {
  const form: Partial<ServerFormState> = {}
  if (typeof cfg.url === 'string' && cfg.url) {
    form.type = cfg.url.endsWith('/sse') ? 'sse' : 'http'
    form.url = cfg.url
    if (cfg.headers && typeof cfg.headers === 'object' && !Array.isArray(cfg.headers)) {
      form.headers = Object.entries(cfg.headers as Record<string, string>).map(([k, v]) => `${k}=${v}`).join('\n')
    }
  } else if (typeof cfg.command === 'string' && cfg.command) {
    form.type = 'stdio'
    form.command = cfg.command
    if (Array.isArray(cfg.args)) {
      form.args = (cfg.args as unknown[]).map(a => {
        const s = String(a)
        return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
      }).join(' ')
    }
    if (typeof cfg.cwd === 'string') form.cwd = cfg.cwd
    if (cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env)) {
      form.env = Object.entries(cfg.env as Record<string, string>).map(([k, v]) => `${k}=${v}`).join('\n')
    }
  }
  if (typeof cfg.timeout === 'number') form.timeoutMs = String(cfg.timeout)
  return form
}

function parseServerJson(text: string): ParsedServerResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.trim())
  } catch {
    return { form: {}, error: 'JSON 格式错误，请检查括号和引号是否匹配' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { form: {}, error: '请粘贴对象格式的 JSON' }
  }
  const obj = parsed as Record<string, unknown>

  // Format 1: { "mcpServers": { "name": { ... } } }
  if (obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)) {
    const entries = Object.entries(obj.mcpServers as Record<string, unknown>)
    if (entries.length === 0) return { form: {}, error: 'mcpServers 中没有服务器' }
    const [name, cfg] = entries[0]
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { form: {}, error: '服务器配置格式不正确' }
    return { name, form: configObjectToForm(cfg as Record<string, unknown>) }
  }

  // Format 2: direct { "command": ..., "args": ... } or { "url": ... }
  if (obj.command || obj.url) {
    return { form: configObjectToForm(obj) }
  }

  // Format 3: { "name": { "command": ..., "args": ... } }
  const entries = Object.entries(obj)
  if (entries.length > 0) {
    const [name, cfg] = entries[0]
    if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
      const cfgObj = cfg as Record<string, unknown>
      if (cfgObj.command || cfgObj.url) {
        return { name, form: configObjectToForm(cfgObj) }
      }
    }
  }

  return { form: {}, error: '无法识别格式，支持：完整 mcpServers 包裹 / 单条服务器对象 / 直接 command/url 配置' }
}

function stringifyKeyValueLines(value?: Record<string, string>) {
  if (!value) return ''
  return Object.entries(value).map(([key, val]) => `${key}=${val}`).join('\n')
}

function parseKeyValueLines(value: string): Record<string, string> | undefined {
  const entries = value
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const separator = line.indexOf('=')
      if (separator < 0) return null
      const key = line.slice(0, separator).trim()
      const val = line.slice(separator + 1).trim()
      return key ? [key, val] as const : null
    })
    .filter((entry): entry is readonly [string, string] => Boolean(entry))
  return entries.length ? Object.fromEntries(entries) : undefined
}

function parseArgs(value: string): string[] | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const parts = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []
  return parts.map(part => part.replace(/^["']|["']$/g, '')).filter(Boolean)
}

function renderMarkdown(content: string) {
  return { __html: marked.parse(content || '') as string }
}

const cardSx = {
  borderRadius: '26px',
  border: '1px solid var(--border-color)',
  bgcolor: 'var(--bg-secondary)',
  boxShadow: 'none',
}

const textFieldSx = {
  '& .MuiInputLabel-root': { color: 'var(--text-secondary)' },
  '& .MuiInputLabel-root.Mui-focused': { color: 'var(--primary)' },
  '& .MuiOutlinedInput-root': {
    borderRadius: '14px',
    color: 'var(--text-primary)',
    backgroundColor: 'var(--bg-secondary)',
    '& fieldset': { borderColor: 'var(--border-color)' },
    '&:hover fieldset': { borderColor: 'var(--primary)' },
    '&.Mui-focused fieldset': { borderColor: 'var(--primary)' },
  },
  '& .MuiInputBase-input': { color: 'var(--text-primary)' },
}

const switchSx = {
  '& .MuiSwitch-switchBase.Mui-checked': { color: 'var(--primary)' },
  '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { backgroundColor: 'var(--primary)' },
  '& .MuiSwitch-track': { backgroundColor: 'var(--text-tertiary)' },
}

const secondaryBtnSx = {
  borderRadius: '999px',
  minWidth: 100,
  textTransform: 'none' as const,
  fontWeight: 600,
  color: 'var(--text-primary)',
  borderColor: 'var(--border-color)',
  backgroundColor: 'var(--bg-secondary)',
  '&:hover': { borderColor: 'var(--primary)', backgroundColor: 'var(--primary-light)' },
}

const activeTabSx = {
  borderRadius: '999px',
  textTransform: 'none' as const,
  fontWeight: 700,
  minWidth: 100,
  background: 'var(--primary-gradient)',
  '&:hover': { background: 'var(--primary-gradient)', filter: 'brightness(0.98)' },
}

const settingRowSx = {
  p: 2,
  borderRadius: '18px',
  border: '1px solid var(--border-color)',
  bgcolor: 'var(--bg-primary)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 2,
}

const sectionCardSx = {
  p: 2,
  borderRadius: '18px',
  border: '1px solid var(--border-color)',
  bgcolor: 'var(--bg-primary)',
}

const itemRowSx = {
  p: 2,
  borderRadius: '14px',
  border: '1px solid var(--border-color)',
  bgcolor: 'var(--bg-primary)',
  transition: 'border-color 0.15s ease',
  '&:hover': { borderColor: 'var(--primary)' },
}

const iconBtnSx = {
  color: 'var(--text-secondary)',
  '&:hover': { color: 'var(--text-primary)', bgcolor: 'var(--bg-primary)' },
  '&.Mui-disabled': { color: 'var(--text-tertiary)' },
}

const chipOutlinedSx = {
  color: 'var(--text-secondary)',
  borderColor: 'var(--border-color)',
}

const chipPrimarySx = {
  bgcolor: 'var(--primary)',
  color: '#fff',
  border: 'none',
  '& .MuiChip-label': { color: '#fff' },
}

const dialogPaperSx = {
  borderRadius: '20px',
  border: '1px solid var(--border-color)',
  bgcolor: 'var(--bg-secondary)',
  backgroundImage: 'none',
}

const selectMenuProps = {
  PaperProps: {
    sx: {
      borderRadius: '14px',
      border: '1px solid var(--border-color)',
      bgcolor: 'var(--bg-secondary)',
      backgroundImage: 'none',
      boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
      '& .MuiMenuItem-root': {
        color: 'var(--text-primary)',
        fontSize: 14,
        '&:hover': { bgcolor: 'var(--bg-primary)' },
        '&.Mui-selected': {
          bgcolor: 'var(--primary-light)',
          color: 'var(--primary)',
          '&:hover': { bgcolor: 'var(--primary-light)' },
        },
      },
    },
  },
}

function McpPage() {
  const [topTab, setTopTab] = useState<TopTab>('server')
  const [toast, setToast] = useState<ToastState | null>(null)

  // ── Server tab state ──
  const [mcpEnabled, setMcpEnabled] = useState(false)
  const [mcpExposeMediaPaths, setMcpExposeMediaPaths] = useState(true)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [exportingSkillZip, setExportingSkillZip] = useState<string | null>(null)
  const [launchConfig, setLaunchConfig] = useState<McpLaunchConfig>({
    command: 'npm', args: ['run', 'mcp'], cwd: 'D:/CipherTalk', mode: 'dev',
  })

  // ── Integration tab state ──
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([])

  // ── Inline editor state ──
  const [skillDialog, setSkillDialog] = useState<SkillDialogState>(null)
  const [skillContent, setSkillContent] = useState('')
  const [editingSkillContent, setEditingSkillContent] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<{ type: 'skill' | 'server'; name: string } | null>(null)
  const [serverPanelOpen, setServerPanelOpen] = useState(false)
  const [editingServer, setEditingServer] = useState<string | null>(null)
  const [serverForm, setServerForm] = useState<ServerFormState>(createEmptyServerForm)
  const [serverBusy, setServerBusy] = useState<Record<string, 'connect' | 'disconnect' | 'tools'>>({})
  const [toolDialogServer, setToolDialogServer] = useState<string | null>(null)
  const [serverTools, setServerTools] = useState<Record<string, McpToolInfo[]>>({})
  const [serverFormMode, setServerFormMode] = useState<'fields' | 'json'>('fields')
  const [jsonPasteText, setJsonPasteText] = useState('')
  const [jsonPasteError, setJsonPasteError] = useState<string | null>(null)

  const showToast = useCallback((text: string, success: boolean) => setToast({ text, success }), [])

  // ── Initial load ──
  useEffect(() => {
    const load = async () => {
      try {
        const [enabled, exposeMediaPaths, skillList] = await Promise.all([
          configService.getMcpEnabled(),
          configService.getMcpExposeMediaPaths(),
          window.electronAPI.skillManager.list(),
        ])
        setMcpEnabled(enabled)
        setMcpExposeMediaPaths(exposeMediaPaths)
        setSkills(skillList)
        try {
          const cfg = await window.electronAPI.app.getMcpLaunchConfig()
          if (cfg?.command && Array.isArray(cfg.args) && cfg.cwd) setLaunchConfig(cfg)
        } catch (inner) {
          if (!String(inner || '').includes("No handler registered for 'app:getMcpLaunchConfig'"))
            console.error('获取 MCP 启动配置失败:', inner)
        }
      } catch (e) {
        console.error('加载 MCP 配置失败:', e)
        showToast('加载 MCP 配置失败', false)
      } finally {
        setLoading(false)
      }
    }
    void load()
  }, [showToast])

  const loadIntegrationData = useCallback(async () => {
    try {
      const [skillList, serverList] = await Promise.all([
        window.electronAPI.skillManager.list(),
        window.electronAPI.mcpClient.listStatuses(),
      ])
      setSkills(skillList)
      setMcpServers(serverList)
    } catch (e) {
      console.error('加载集成数据失败:', e)
    }
  }, [])

  useEffect(() => {
    if (topTab === 'integration') void loadIntegrationData()
  }, [topTab, loadIntegrationData])

  // ── Computed ──
  const mcpRunCommand = useMemo(() => {
    return [launchConfig.command, ...launchConfig.args].map(formatCommandPart).join(' ')
  }, [launchConfig])

  const mcpServerJsonTemplate = useMemo(() => JSON.stringify({
    mcpServers: { ciphertalk: { command: launchConfig.command, args: launchConfig.args, cwd: launchConfig.cwd } },
  }, null, 2), [launchConfig])

  // ── Server handlers ──
  const handleSave = async () => {
    setSaving(true)
    try {
      await Promise.all([configService.setMcpEnabled(mcpEnabled), configService.setMcpExposeMediaPaths(mcpExposeMediaPaths)])
      showToast('MCP 配置已保存', true)
    } catch { showToast('保存 MCP 配置失败', false) }
    finally { setSaving(false) }
  }

  const copyText = async (text: string, label: string) => {
    try { await navigator.clipboard.writeText(text); showToast(`${label}已复制`, true) }
    catch { showToast('复制失败，请手动复制', false) }
  }

  const exportSkillZip = async (skillName: string) => {
    setExportingSkillZip(skillName)
    try {
      const result = await window.electronAPI.skillManager.exportZip(skillName)
      showToast(result.success ? `Skill 已导出到 ${result.outputPath}` : (result.error || '导出失败'), result.success)
    } catch { showToast('导出失败', false) }
    finally { setExportingSkillZip(null) }
  }

  // ── Skill handlers ──
  const openSkillPanel = async (name: string, mode: 'preview' | 'edit') => {
    const result = await window.electronAPI.skillManager.readContent(name)
    if (result.success) {
      const content = result.content || ''
      setSkillContent(content)
      setEditingSkillContent(content)
      setSkillDialog({ name, mode })
    }
    else showToast(result.error || '读取失败', false)
  }

  const saveEditSkill = async () => {
    if (!skillDialog?.name) return
    const result = await window.electronAPI.skillManager.updateContent(skillDialog.name, editingSkillContent)
    showToast(result.success ? 'Skill 已保存' : (result.error || '保存失败'), result.success)
    if (result.success) {
      setSkillContent(editingSkillContent)
      setSkillDialog({ name: skillDialog.name, mode: 'preview' })
      void loadIntegrationData()
    }
  }

  const deleteSkill = async (name: string) => {
    const result = await window.electronAPI.skillManager.delete(name)
    showToast(result.success ? `Skill "${name}" 已删除` : (result.error || '删除失败'), result.success)
    setDeleteTarget(null)
    if (result.success) void loadIntegrationData()
  }

  const importSkill = async () => {
    try {
      const { canceled, filePaths } = await window.electronAPI.dialog.openFile({
        title: '导入 Skill 压缩包',
        filters: [{ name: 'Zip', extensions: ['zip'] }],
        properties: ['openFile'],
      })
      if (canceled || !filePaths?.[0]) return
      const result = await window.electronAPI.skillManager.importZip(filePaths[0])
      showToast(result.success ? `Skill "${result.skillName}" 已导入` : (result.error || '导入失败'), result.success)
      if (result.success) void loadIntegrationData()
    } catch { showToast('导入失败', false) }
  }

  const downloadSkillTemplate = async () => {
    try {
      const zip = new JSZip()
      const root = zip.folder('ciphertalk-skill-template')
      root?.file('SKILL.md', `---\nname: ciphertalk-example\nversion: '1.0.0'\ndescription: Describe what this skill helps with.\n---\n\n# CipherTalk Example Skill\n\n## When to use\nUse this skill when...\n\n## Workflow\n1. Read the user request.\n2. Use the relevant CipherTalk context.\n3. Return a concise answer.\n`)
      root?.folder('references')?.file('README.md', '# References\n\nPut supporting docs here when the skill needs them.\n')
      const blob = await zip.generateAsync({ type: 'blob' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'ciphertalk-skill-template.zip'
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      showToast('Skill 导入模板已生成', true)
    } catch {
      showToast('模板生成失败', false)
    }
  }

  // ── MCP client handlers ──
  const connectServer = async (name: string) => {
    if (serverBusy[name]) return
    setServerBusy(prev => ({ ...prev, [name]: 'connect' }))
    try {
      const result = await window.electronAPI.mcpClient.connect(name)
      if (result.success && result.tools) setServerTools(prev => ({ ...prev, [name]: result.tools || [] }))
      showToast(result.success ? `已连接到 "${name}"，发现 ${result.tools?.length ?? 0} 个工具` : (result.error || '连接失败'), result.success)
      void loadIntegrationData()
    } finally {
      setServerBusy(prev => {
        const next = { ...prev }
        delete next[name]
        return next
      })
    }
  }

  const disconnectServer = async (name: string) => {
    if (serverBusy[name]) return
    setServerBusy(prev => ({ ...prev, [name]: 'disconnect' }))
    try {
      const result = await window.electronAPI.mcpClient.disconnect(name)
      if (result.success) setToolDialogServer(current => current === name ? null : current)
      showToast(result.success ? `已断开 "${name}"` : (result.error || '断开失败'), result.success)
      void loadIntegrationData()
    } finally {
      setServerBusy(prev => {
        const next = { ...prev }
        delete next[name]
        return next
      })
    }
  }

  const openToolsDialog = async (name: string) => {
    setToolDialogServer(name)
    if (serverTools[name] || serverBusy[name]) return
    setServerBusy(prev => ({ ...prev, [name]: 'tools' }))
    try {
      const result = await window.electronAPI.mcpClient.listTools(name)
      if (result.success) setServerTools(prev => ({ ...prev, [name]: result.tools || [] }))
      else showToast(result.error || '工具加载失败', false)
    } finally {
      setServerBusy(prev => {
        const next = { ...prev }
        delete next[name]
        return next
      })
    }
  }

  const resetJsonPasteState = () => {
    setServerFormMode('fields')
    setJsonPasteText('')
    setJsonPasteError(null)
  }

  const applyJsonPaste = () => {
    const result = parseServerJson(jsonPasteText)
    if (result.error) {
      setJsonPasteError(result.error)
      return
    }
    setJsonPasteError(null)
    setServerForm(prev => ({
      ...createEmptyServerForm(),
      ...prev,
      ...(result.name && !editingServer ? { name: result.name } : {}),
      ...result.form,
    }))
    setServerFormMode('fields')
  }

  const openAddServer = () => {
    if (serverPanelOpen && !editingServer) {
      setServerPanelOpen(false)
      resetJsonPasteState()
      return
    }
    setEditingServer(null)
    setServerForm(createEmptyServerForm())
    resetJsonPasteState()
    setServerPanelOpen(true)
  }

  const openEditServer = (srv: McpServerStatus) => {
    if (serverPanelOpen && editingServer === srv.name) {
      setServerPanelOpen(false)
      setEditingServer(null)
      setServerForm(createEmptyServerForm())
      resetJsonPasteState()
      return
    }
    setServerPanelOpen(true)
    setEditingServer(srv.name)
    setServerForm({
      name: srv.name,
      type: srv.config.type,
      command: srv.config.command || '',
      args: srv.config.args?.join(' ') || '',
      env: stringifyKeyValueLines(srv.config.env),
      cwd: srv.config.cwd || '',
      url: srv.config.url || '',
      headers: stringifyKeyValueLines(srv.config.headers),
      timeoutMs: String(srv.config.timeoutMs || 30000),
    })
  }

  const saveServer = async () => {
    const name = serverForm.name.trim()
    if (!name) { showToast('请输入服务器名称', false); return }
    if (!editingServer && mcpServers.some(srv => srv.name === name)) {
      showToast(`服务器 "${name}" 已存在，请换一个名称`, false)
      return
    }
    const timeoutMs = Number(serverForm.timeoutMs)
    if (serverForm.timeoutMs.trim() && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      showToast('超时时间必须是正整数毫秒', false)
      return
    }
    const config: McpClientConfig = { type: serverForm.type }
    if (serverForm.type === 'stdio') {
      if (!serverForm.command.trim()) { showToast('请输入启动命令', false); return }
      config.command = serverForm.command.trim()
      config.args = parseArgs(serverForm.args)
      config.env = parseKeyValueLines(serverForm.env)
      config.cwd = serverForm.cwd.trim() || undefined
    } else {
      if (!serverForm.url.trim()) { showToast('请输入服务器 URL', false); return }
      config.url = serverForm.url.trim()
      config.headers = parseKeyValueLines(serverForm.headers)
    }
    config.timeoutMs = serverForm.timeoutMs.trim() ? Math.round(timeoutMs) : undefined
    const result = await window.electronAPI.mcpClient.saveConfig(name, config, Boolean(editingServer))
    showToast(result.success ? `服务器 "${name}" 已保存` : (result.error || '保存失败'), result.success)
    if (result.success) {
      setEditingServer(null)
      setServerPanelOpen(false)
      setServerForm(createEmptyServerForm())
      void loadIntegrationData()
    }
  }

  const deleteServer = async (name: string) => {
    const result = await window.electronAPI.mcpClient.deleteConfig(name)
    showToast(result.success ? `服务器 "${name}" 已删除` : (result.error || '删除失败'), result.success)
    setDeleteTarget(null)
    if (result.success) void loadIntegrationData()
  }

  // ── Render helpers ──
  const renderStatusChip = (status: string) => {
    const map: Record<string, { label: string; color: string; borderColor: string }> = {
      connected:    { label: '已连接', color: 'var(--success, #4caf50)',  borderColor: 'var(--success, #4caf50)' },
      disconnected: { label: '未连接', color: 'var(--text-tertiary)',      borderColor: 'var(--border-color)' },
      error:        { label: '错误',   color: 'var(--danger)',             borderColor: 'var(--danger)' },
      connecting:   { label: '连接中', color: 'var(--text-secondary)',     borderColor: 'var(--border-color)' },
    }
    const info = map[status] || map.disconnected
    return <Chip label={info.label} size="small" variant="outlined"
      sx={{ height: 22, fontSize: 12, color: info.color, borderColor: info.borderColor }} />
  }

  const closeServerPanel = () => {
    setServerPanelOpen(false)
    setEditingServer(null)
    setServerForm(createEmptyServerForm())
    resetJsonPasteState()
  }

  const renderServerForm = () => (
    <Box sx={{ ...sectionCardSx, borderColor: 'var(--primary)', bgcolor: 'var(--bg-secondary)' }}>
      <Stack spacing={2}>
        {/* ── 标题行 ── */}
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
          <Box>
            <Typography sx={{ fontWeight: 700, color: 'var(--text-primary)' }}>
              {editingServer ? `编辑服务器：${editingServer}` : '添加 MCP 服务器'}
            </Typography>
            <Typography sx={{ mt: 0.3, fontSize: 12, color: 'var(--text-secondary)' }}>
              参数会保存到本机 MCP 客户端配置中。
            </Typography>
          </Box>
          <IconButton size="small" onClick={closeServerPanel} title="收起">
            <X size={16} />
          </IconButton>
        </Stack>

        {/* ── 模式切换（仅添加时显示） ── */}
        {!editingServer && (
          <Stack direction="row" spacing={1}>
            <Button size="small" variant={serverFormMode === 'fields' ? 'contained' : 'outlined'}
              onClick={() => setServerFormMode('fields')}
              sx={serverFormMode === 'fields' ? { ...activeTabSx, minWidth: 80, fontSize: 13 } : { ...secondaryBtnSx, minWidth: 80, fontSize: 13 }}>
              表单填写
            </Button>
            <Button size="small" variant={serverFormMode === 'json' ? 'contained' : 'outlined'}
              onClick={() => setServerFormMode('json')}
              sx={serverFormMode === 'json' ? { ...activeTabSx, minWidth: 80, fontSize: 13 } : { ...secondaryBtnSx, minWidth: 80, fontSize: 13 }}>
              粘贴 JSON
            </Button>
          </Stack>
        )}

        {/* ── JSON 粘贴模式 ── */}
        {serverFormMode === 'json' ? (
          <Stack spacing={1.5}>
            <Typography sx={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              粘贴来自 Claude Desktop、Cursor 等工具的{' '}
              <Box component="code" sx={{ px: 0.6, py: 0.2, borderRadius: '6px', bgcolor: 'var(--bg-tertiary)', color: 'var(--text-primary)', fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)', fontSize: 12 }}>mcpServers</Box>
              {' '}配置，系统会自动识别并填入表单。
            </Typography>
            <TextField
              fullWidth multiline minRows={8}
              value={jsonPasteText}
              onChange={e => { setJsonPasteText(e.target.value); setJsonPasteError(null) }}
              placeholder={'{\n  "mcpServers": {\n    "my-server": {\n      "command": "npx",\n      "args": ["-y", "some-mcp-server"]\n    }\n  }\n}'}
              error={!!jsonPasteError}
              helperText={jsonPasteError ?? '支持：完整 mcpServers 对象 / 单条服务器对象 / 直接 command 或 url 配置'}
              sx={{
                ...textFieldSx,
                '& .MuiOutlinedInput-root': {
                  ...textFieldSx['& .MuiOutlinedInput-root'],
                  fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)',
                  fontSize: 13,
                },
                '& .MuiFormHelperText-root': { color: jsonPasteError ? 'var(--danger)' : 'var(--text-tertiary)', ml: 0 },
              }}
            />
            <Stack direction="row" spacing={1} justifyContent="flex-end">
              <Button onClick={closeServerPanel} sx={secondaryBtnSx}>取消</Button>
              <Button variant="contained" onClick={applyJsonPaste} disabled={!jsonPasteText.trim()}
                sx={{ borderRadius: '999px', textTransform: 'none', fontWeight: 600, background: 'var(--primary-gradient)', '&:hover': { background: 'var(--primary-gradient)', filter: 'brightness(0.98)' } }}>
                解析并填入
              </Button>
            </Stack>
          </Stack>
        ) : (
          <>
            {/* ── 表单填写模式 ── */}
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
              <TextField label="服务器名称" fullWidth value={serverForm.name} onChange={e => setServerForm(f => ({ ...f, name: e.target.value }))}
                disabled={!!editingServer} sx={textFieldSx} />
              <FormControl fullWidth sx={{ '& .MuiInputLabel-root': { color: 'var(--text-secondary)' }, '& .MuiInputLabel-root.Mui-focused': { color: 'var(--primary)' } }}>
                <InputLabel>传输类型</InputLabel>
                <Select label="传输类型" value={serverForm.type} onChange={e => setServerForm(f => ({ ...f, type: e.target.value }))}
                  MenuProps={selectMenuProps}
                  sx={{ borderRadius: '14px', bgcolor: 'var(--bg-secondary)', color: 'var(--text-primary)', '& fieldset': { borderColor: 'var(--border-color)' }, '&:hover fieldset': { borderColor: 'var(--primary)' }, '&.Mui-focused fieldset': { borderColor: 'var(--primary)' }, '& .MuiSvgIcon-root': { color: 'var(--text-secondary)' } }}>
                  <MenuItem value="stdio">Stdio</MenuItem>
                  <MenuItem value="sse">SSE</MenuItem>
                  <MenuItem value="http">Streamable HTTP</MenuItem>
                </Select>
              </FormControl>
              <TextField label="超时时间 (ms)" fullWidth value={serverForm.timeoutMs} onChange={e => setServerForm(f => ({ ...f, timeoutMs: e.target.value }))}
                placeholder="30000" sx={textFieldSx} />
            </Stack>

            {serverForm.type === 'stdio' ? (
              <Stack spacing={1.5}>
                <TextField label="命令" fullWidth value={serverForm.command} onChange={e => setServerForm(f => ({ ...f, command: e.target.value }))}
                  placeholder="npx、node、python、uvx ..." sx={textFieldSx} />
                <TextField label="参数" fullWidth value={serverForm.args} onChange={e => setServerForm(f => ({ ...f, args: e.target.value }))}
                  placeholder="-y @modelcontextprotocol/server-filesystem D:/Workspace" sx={textFieldSx} />
                <TextField label="工作目录 (可选)" fullWidth value={serverForm.cwd} onChange={e => setServerForm(f => ({ ...f, cwd: e.target.value }))}
                  placeholder="D:/Workspace/project" sx={textFieldSx} />
                <TextField label="环境变量 (每行 KEY=VALUE)" fullWidth multiline minRows={3} value={serverForm.env} onChange={e => setServerForm(f => ({ ...f, env: e.target.value }))}
                  placeholder={'API_KEY=...\nNODE_ENV=production'}
                  sx={{ ...textFieldSx, '& .MuiOutlinedInput-root': { ...textFieldSx['& .MuiOutlinedInput-root'], fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)', fontSize: 13 } }} />
              </Stack>
            ) : (
              <Stack spacing={1.5}>
                <TextField label="URL" fullWidth value={serverForm.url} onChange={e => setServerForm(f => ({ ...f, url: e.target.value }))}
                  placeholder={serverForm.type === 'sse' ? 'http://localhost:3000/sse' : 'http://localhost:3000/mcp'} sx={textFieldSx} />
                <TextField label="请求头 (每行 KEY=VALUE)" fullWidth multiline minRows={3} value={serverForm.headers} onChange={e => setServerForm(f => ({ ...f, headers: e.target.value }))}
                  placeholder={'Authorization=Bearer ...\nX-Api-Key=...'}
                  sx={{ ...textFieldSx, '& .MuiOutlinedInput-root': { ...textFieldSx['& .MuiOutlinedInput-root'], fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)', fontSize: 13 } }} />
              </Stack>
            )}

            <Stack direction="row" spacing={1} justifyContent="flex-end">
              <Button onClick={closeServerPanel} sx={secondaryBtnSx}>取消</Button>
              <Button variant="contained" onClick={saveServer}
                sx={{ borderRadius: '999px', textTransform: 'none', fontWeight: 600, background: 'var(--primary-gradient)', '&:hover': { background: 'var(--primary-gradient)', filter: 'brightness(0.98)' } }}>
                保存
              </Button>
            </Stack>
          </>
        )}
      </Stack>
    </Box>
  )

  const renderToolsContent = (serverName: string) => {
    const tools = serverTools[serverName] || []
    const loadingTools = serverBusy[serverName] === 'tools'
    return (
      <Stack spacing={1.2} sx={{ mt: 1, maxHeight: '68vh', overflow: 'auto' }}>
        {loadingTools ? (
          <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 1 }}>
            <CircularProgress size={16} sx={{ color: 'var(--primary)' }} />
            <Typography sx={{ fontSize: 13, color: 'var(--text-secondary)' }}>正在读取工具列表...</Typography>
          </Stack>
        ) : tools.length === 0 ? (
          <Typography sx={{ fontSize: 13, color: 'var(--text-tertiary)' }}>暂无工具或服务器尚未返回工具列表。</Typography>
        ) : (
          tools.map(tool => (
            <Box key={tool.name} sx={{ p: 1.5, borderRadius: '12px', border: '1px solid var(--border-color)', bgcolor: 'var(--bg-primary)' }}>
              <Typography sx={{ fontWeight: 650, color: 'var(--text-primary)' }}>{tool.name}</Typography>
              {tool.description && (
                <Typography sx={{ mt: 0.5, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>{tool.description}</Typography>
              )}
              {tool.inputSchema !== undefined && tool.inputSchema !== null && (
                <Box component="pre" sx={{ mt: 1, mb: 0, p: 1.2, borderRadius: '10px', overflow: 'auto', bgcolor: 'var(--bg-tertiary)', color: 'var(--text-secondary)', fontSize: 12, fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)' }}>
                  {JSON.stringify(tool.inputSchema, null, 2)}
                </Box>
              )}
            </Box>
          ))
        )}
      </Stack>
    )
  }

  return (
    <Box sx={{ height: '100%', mx: -3, mt: -3, overflowY: 'auto', pb: 3 }}>
      <Container maxWidth="lg" sx={{ px: { xs: 2, md: 4 }, py: { xs: 3, md: 4 } }}>
        <Stack spacing={2.2}>
          {/* ── Top Tabs ── */}
          <Stack direction="row" spacing={1} sx={{ px: { xs: 0.5, md: 1 }, pt: 0.5 }}>
            <Button variant={topTab === 'server' ? 'contained' : 'outlined'}
              onClick={() => setTopTab('server')} sx={topTab === 'server' ? activeTabSx : secondaryBtnSx}>
              MCP 服务端
            </Button>
            <Button variant={topTab === 'integration' ? 'contained' : 'outlined'}
              onClick={() => setTopTab('integration')} sx={topTab === 'integration' ? activeTabSx : secondaryBtnSx}>
              集成中心
            </Button>
          </Stack>

          {/* ════════════════ TAB 1: MCP 服务端 ════════════════ */}
          {topTab === 'server' && (<>
            {/* ── 服务配置 ── */}
            <Card sx={cardSx}>
              <CardHeader title="服务配置"
                subheader="CipherTalk 作为 MCP 服务端对外暴露工具"
                titleTypographyProps={{ fontWeight: 700, fontSize: 18, color: 'var(--text-primary)' }}
                subheaderTypographyProps={{ fontSize: 13, color: 'var(--text-secondary)', mt: 0.3 }}
                sx={{ px: { xs: 2, md: 3 }, pb: 0.8 }} />
              <CardContent sx={{ px: { xs: 2, md: 3 }, pt: 0.6 }}>
                <Stack spacing={2.4}>
                  <Box sx={settingRowSx}>
                    <Box>
                      <Typography sx={{ fontWeight: 600, color: 'var(--text-primary)' }}>MCP 状态标记</Typography>
                      <Typography sx={{ mt: 0.5, fontSize: 13, color: 'var(--text-secondary)' }}>
                        在 health_check / get_status 中暴露配置状态，不阻止宿主调用工具。
                      </Typography>
                    </Box>
                    <Switch checked={mcpEnabled} onChange={e => setMcpEnabled(e.target.checked)} disabled={loading || saving} sx={switchSx} />
                  </Box>

                  <Box sx={settingRowSx}>
                    <Box>
                      <Typography sx={{ fontWeight: 600, color: 'var(--text-primary)' }}>默认解析媒体本地路径</Typography>
                      <Typography sx={{ mt: 0.5, fontSize: 13, color: 'var(--text-secondary)' }}>
                        控制 get_messages / search_messages 等工具是否返回图片、视频、语音、文件本地路径。
                      </Typography>
                    </Box>
                    <Switch checked={mcpExposeMediaPaths} onChange={e => setMcpExposeMediaPaths(e.target.checked)} disabled={loading || saving} sx={switchSx} />
                  </Box>

                  <Box>
                    <Typography sx={{ mb: 1, fontWeight: 600, color: 'var(--text-primary)' }}>启动命令</Typography>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.2}>
                      <TextField fullWidth value={mcpRunCommand} InputProps={{ readOnly: true }} sx={textFieldSx} />
                      <Button variant="outlined" startIcon={<Copy size={16} />} onClick={() => copyText(mcpRunCommand, '启动命令')} sx={secondaryBtnSx}>复制</Button>
                    </Stack>
                  </Box>

                  <Box>
                    <Typography sx={{ mb: 1, fontWeight: 600, color: 'var(--text-primary)' }}>mcpServers 配置</Typography>
                    <TextField fullWidth multiline minRows={8} value={mcpServerJsonTemplate} InputProps={{ readOnly: true }}
                      sx={{ ...textFieldSx, '& .MuiOutlinedInput-root': { ...textFieldSx['& .MuiOutlinedInput-root'], fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)' } }} />
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.2} sx={{ mt: 1.2 }} alignItems="center">
                      <Button variant="outlined" startIcon={<Copy size={16} />} onClick={() => copyText(mcpServerJsonTemplate, 'mcpServers 配置')} sx={secondaryBtnSx}>复制配置</Button>
                      <Typography sx={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                        {launchConfig.mode === 'packaged'
                          ? 'Windows 下已自动通过 cmd /c 调用启动器，Claude Desktop、Cursor 等工具可直接使用。'
                          : 'cwd 已自动使用当前仓库目录。'}
                      </Typography>
                    </Stack>
                  </Box>

                  <Stack direction="row" spacing={1.2} justifyContent="space-between" alignItems="center">
                    <Typography sx={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                      {launchConfig.mode === 'packaged'
                        ? `当前为打包版启动器 ${getPackagedLauncherLabel(launchConfig.args.find(a => a.includes('ciphertalk-mcp')) ?? launchConfig.command)}`
                        : '当前为开发态入口 npm run mcp'}
                    </Typography>
                    <Button variant="contained" onClick={handleSave} disabled={loading || saving}
                      sx={{ minWidth: 42, width: 42, height: 42, borderRadius: '999px', p: 0, textTransform: 'none', fontWeight: 700, background: 'var(--primary-gradient)', '&:hover': { background: 'var(--primary-gradient)', filter: 'brightness(0.98)' } }}
                      title={saving ? '保存中...' : '保存配置'}>
                      <Save size={16} />
                    </Button>
                  </Stack>
                </Stack>
              </CardContent>
            </Card>

            {/* ── 外部 Skills ── */}
            <Card sx={cardSx}>
              <CardHeader title="外部 Skills"
                subheader="导出给外部 Agent 使用（Codex、Claude、Cursor 等）"
                titleTypographyProps={{ fontWeight: 700, fontSize: 18, color: 'var(--text-primary)' }}
                subheaderTypographyProps={{ fontSize: 13, color: 'var(--text-secondary)', mt: 0.3 }}
                sx={{ px: { xs: 2, md: 3 }, pb: 0.8 }} />
              <CardContent sx={{ px: { xs: 2, md: 3 }, pt: 0.6 }}>
                <Stack spacing={1.5}>
                  {skills.filter(s => s.builtin).map(skill => (
                    <Box key={skill.name} sx={itemRowSx}>
                      <Stack direction="row" spacing={1.5} alignItems="center" justifyContent="space-between">
                        <Box sx={{ minWidth: 0, flex: 1 }}>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <FileCode size={18} style={{ color: 'var(--primary)', flexShrink: 0 }} />
                            <Typography sx={{ fontWeight: 600, color: 'var(--text-primary)' }} noWrap>{skill.name}</Typography>
                            <Chip label={`v${skill.version}`} size="small" variant="outlined" sx={{ height: 22, fontSize: 12, ...chipOutlinedSx }} />
                            <Chip label="内置" size="small" variant="filled" sx={{ height: 22, fontSize: 12, ...chipPrimarySx }} />
                          </Stack>
                          <Typography sx={{ mt: 0.5, fontSize: 13, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {skill.description}
                          </Typography>
                        </Box>
                        <Button variant="outlined" startIcon={<Download size={14} />} onClick={() => exportSkillZip(skill.name)}
                          disabled={exportingSkillZip === skill.name} sx={secondaryBtnSx}>
                          {exportingSkillZip === skill.name ? '导出中...' : '导出 zip'}
                        </Button>
                      </Stack>
                    </Box>
                  ))}
                  <Typography sx={{ fontSize: 13, color: 'var(--text-tertiary)' }}>
                    导出 zip 后解压到对应 Agent 的 skills 目录即可使用。
                  </Typography>
                </Stack>
              </CardContent>
            </Card>
          </>)}

          {/* ════════════════ TAB 2: 集成中心 ════════════════ */}
          {topTab === 'integration' && (<>
            {/* ── MCP 客户端 ── */}
            <Card sx={cardSx}>
              <CardHeader title="MCP 客户端"
                subheader="连接外部 MCP 服务器并调用其工具"
                titleTypographyProps={{ fontWeight: 700, fontSize: 18, color: 'var(--text-primary)' }}
                subheaderTypographyProps={{ fontSize: 13, color: 'var(--text-secondary)', mt: 0.3 }}
                action={
                  <Button variant="outlined" startIcon={<Plus size={16} />} onClick={openAddServer} sx={secondaryBtnSx}>
                    {serverPanelOpen && !editingServer ? '收起' : '添加服务器'}
                  </Button>
                }
                sx={{ px: { xs: 2, md: 3 }, pb: 0.8, '& .MuiCardHeader-action': { alignSelf: 'center', mt: 0 } }} />
              <CardContent sx={{ px: { xs: 2, md: 3 }, pt: 0.6 }}>
                <Stack spacing={1.5}>
                  {mcpServers.length === 0 && (
                    <Box sx={{ ...sectionCardSx, textAlign: 'center', py: 3 }}>
                      <Typography sx={{ color: 'var(--text-tertiary)', fontSize: 14 }}>暂无 MCP 服务器配置，点击上方按钮添加</Typography>
                    </Box>
                  )}
                  {serverPanelOpen && !editingServer && renderServerForm()}
                  {mcpServers.map(srv => (
                    <Stack key={srv.name} spacing={1}>
                      <Box sx={{ ...itemRowSx, opacity: (serverBusy[srv.name] && serverBusy[srv.name] !== 'tools') || srv.status === 'connecting' ? 0.62 : 1 }}>
                        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ width: '100%' }}>
                          <Box sx={{ minWidth: 0, flex: 1 }}>
                            <Stack direction="row" spacing={1} alignItems="center">
                              <Plug size={18} style={{ color: srv.status === 'connected' ? 'var(--primary)' : 'var(--text-tertiary)', flexShrink: 0 }} />
                              <Typography sx={{ fontWeight: 600, color: 'var(--text-primary)' }} noWrap>{srv.name}</Typography>
                              <Chip label={srv.config.type.toUpperCase()} size="small" variant="outlined" sx={{ height: 22, fontSize: 11, ...chipOutlinedSx }} />
                              {renderStatusChip(srv.status)}
                              {srv.config.timeoutMs && (
                                <Typography sx={{ fontSize: 12, color: 'var(--text-secondary)' }}>{srv.config.timeoutMs}ms</Typography>
                              )}
                            </Stack>
                            <Typography sx={{ mt: 0.3, fontSize: 12, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {srv.config.type === 'stdio' ? `${srv.config.command} ${(srv.config.args || []).join(' ')}` : srv.config.url}
                            </Typography>
                            {srv.error && <Typography sx={{ mt: 0.4, fontSize: 12, color: 'var(--danger)' }}>{srv.error}</Typography>}
                          </Box>
                          <Stack direction="row" spacing={0.5}>
                            {srv.status === 'connected' && (
                              <Button size="small" variant="outlined" onClick={() => openToolsDialog(srv.name)}
                                disabled={Boolean(serverBusy[srv.name] && serverBusy[srv.name] !== 'tools')}
                                sx={{ ...secondaryBtnSx, minWidth: 86, height: 32, fontSize: 12 }}>
                                {serverBusy[srv.name] === 'tools' ? <CircularProgress size={14} sx={{ color: 'var(--primary)' }} /> : `${srv.toolCount} 工具`}
                              </Button>
                            )}
                            {srv.status === 'connected' ? (
                              <IconButton size="small" onClick={() => disconnectServer(srv.name)} title="断开" disabled={Boolean(serverBusy[srv.name])} sx={iconBtnSx}>
                                {serverBusy[srv.name] === 'disconnect' ? <CircularProgress size={16} sx={{ color: 'var(--primary)' }} /> : <Unplug size={16} />}
                              </IconButton>
                            ) : (
                              <IconButton size="small" onClick={() => connectServer(srv.name)} title="连接" disabled={Boolean(serverBusy[srv.name] || srv.status === 'connecting')} sx={iconBtnSx}>
                                {serverBusy[srv.name] === 'connect' || srv.status === 'connecting' ? <CircularProgress size={16} sx={{ color: 'var(--primary)' }} /> : <Plug size={16} />}
                              </IconButton>
                            )}
                            <IconButton size="small" onClick={() => openEditServer(srv)} title="编辑" disabled={Boolean(serverBusy[srv.name] || srv.status === 'connecting')} sx={iconBtnSx}>
                              <Pencil size={16} />
                            </IconButton>
                            <IconButton size="small" onClick={() => setDeleteTarget({ type: 'server', name: srv.name })} title="删除" disabled={Boolean(serverBusy[srv.name] || srv.status === 'connecting')} sx={iconBtnSx}>
                              <Trash2 size={16} />
                            </IconButton>
                          </Stack>
                        </Stack>
                      </Box>
                      {serverPanelOpen && editingServer === srv.name && renderServerForm()}
                    </Stack>
                  ))}
                </Stack>
              </CardContent>
            </Card>

            {/* ── 内部 Skills ── */}
            <Card sx={cardSx}>
              <CardHeader title="内部 Skills"
                subheader="管理和配置内部使用的 Skills"
                titleTypographyProps={{ fontWeight: 700, fontSize: 18, color: 'var(--text-primary)' }}
                subheaderTypographyProps={{ fontSize: 13, color: 'var(--text-secondary)', mt: 0.3 }}
                action={
                  <Stack direction="row" spacing={1}>
                    <Button variant="outlined" startIcon={<Download size={16} />} onClick={downloadSkillTemplate} sx={secondaryBtnSx}>下载模板</Button>
                    <Button variant="outlined" startIcon={<Upload size={16} />} onClick={importSkill} sx={secondaryBtnSx}>导入</Button>
                  </Stack>
                }
                sx={{ px: { xs: 2, md: 3 }, pb: 0.8, '& .MuiCardHeader-action': { alignSelf: 'center', mt: 0 } }} />
              <CardContent sx={{ px: { xs: 2, md: 3 }, pt: 0.6 }}>
                <Stack spacing={1.5}>
                  {skills.length === 0 && (
                    <Box sx={{ ...sectionCardSx, textAlign: 'center', py: 3 }}>
                      <Typography sx={{ color: 'var(--text-tertiary)', fontSize: 14 }}>暂无 Skills，可先下载模板后导入 zip</Typography>
                    </Box>
                  )}
                  {skills.map(skill => (
                    <Stack key={skill.name} spacing={1}>
                      <Box sx={itemRowSx}>
                        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ width: '100%' }}>
                          <Box sx={{ minWidth: 0, flex: 1 }}>
                            <Stack direction="row" spacing={1} alignItems="center">
                              <FileCode size={18} style={{ color: 'var(--primary)', flexShrink: 0 }} />
                              <Typography sx={{ fontWeight: 600, color: 'var(--text-primary)' }} noWrap>{skill.name}</Typography>
                              <Chip label={`v${skill.version}`} size="small" variant="outlined" sx={{ height: 22, fontSize: 12, ...chipOutlinedSx }} />
                              {skill.builtin && <Chip label="内置" size="small" variant="filled" sx={{ height: 22, fontSize: 12, ...chipPrimarySx }} />}
                            </Stack>
                            <Typography sx={{ mt: 0.3, fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {skill.description}
                            </Typography>
                          </Box>
                          <Stack direction="row" spacing={0.5}>
                            <IconButton size="small" onClick={() => openSkillPanel(skill.name, 'preview')} title="预览" sx={iconBtnSx}><Eye size={16} /></IconButton>
                            {!skill.builtin && (
                              <>
                                <IconButton size="small" onClick={() => openSkillPanel(skill.name, 'edit')} title="编辑" sx={iconBtnSx}><Pencil size={16} /></IconButton>
                                <IconButton size="small" onClick={() => setDeleteTarget({ type: 'skill', name: skill.name })} title="删除" sx={iconBtnSx}><Trash2 size={16} /></IconButton>
                              </>
                            )}
                            <Button variant="outlined" size="small" startIcon={<Download size={14} />} onClick={() => exportSkillZip(skill.name)}
                              disabled={exportingSkillZip === skill.name} sx={{ ...secondaryBtnSx, minWidth: 80, fontSize: 13 }}>
                              {exportingSkillZip === skill.name ? '...' : '导出'}
                            </Button>
                          </Stack>
                        </Stack>
                      </Box>
                    </Stack>
                  ))}
                </Stack>
              </CardContent>
            </Card>
          </>)}
        </Stack>
      </Container>

      {/* ── Toast ── */}
      <Snackbar open={!!toast} autoHideDuration={2400} onClose={() => setToast(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <Alert icon={toast?.success ? <Check size={16} /> : undefined} severity={toast?.success ? 'success' : 'error'} variant="filled" onClose={() => setToast(null)}
          sx={{ borderRadius: '12px', color: '#fff', bgcolor: toast?.success ? 'var(--primary)' : 'var(--danger)' }}>
          {toast?.text}
        </Alert>
      </Snackbar>

      {/* ── MCP Tools Dialog ── */}
      <Dialog open={toolDialogServer !== null} onClose={() => setToolDialogServer(null)} maxWidth="md" fullWidth
        PaperProps={{ sx: dialogPaperSx }}>
        <DialogTitle sx={{ fontWeight: 700, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-color)' }}>工具预览: {toolDialogServer}</DialogTitle>
        <DialogContent sx={{ bgcolor: 'var(--bg-secondary)' }}>
          {toolDialogServer && renderToolsContent(toolDialogServer)}
        </DialogContent>
        <DialogActions sx={{ borderTop: '1px solid var(--border-color)', bgcolor: 'var(--bg-secondary)' }}>
          <Button onClick={() => setToolDialogServer(null)} sx={secondaryBtnSx}>关闭</Button>
        </DialogActions>
      </Dialog>

      {/* ── Skill Preview/Edit Dialog ── */}
      <Dialog open={skillDialog !== null} onClose={() => setSkillDialog(null)} maxWidth="lg" fullWidth
        PaperProps={{ sx: dialogPaperSx }}>
        <DialogTitle sx={{ fontWeight: 700, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-color)' }}>
          {skillDialog?.mode === 'edit' ? '编辑 Skill' : '预览 Skill'}: {skillDialog?.name}
        </DialogTitle>
        <DialogContent sx={{ bgcolor: 'var(--bg-secondary)' }}>
          {skillDialog?.mode === 'edit' ? (
            <TextField fullWidth multiline minRows={22} value={editingSkillContent} onChange={e => setEditingSkillContent(e.target.value)}
              sx={{ ...textFieldSx, mt: 1, '& .MuiOutlinedInput-root': { ...textFieldSx['& .MuiOutlinedInput-root'], fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)', fontSize: 13, alignItems: 'flex-start' }, '& textarea': { maxHeight: '68vh', overflow: 'auto !important' } }} />
          ) : (
            <Box
              className="markdown-body"
              dangerouslySetInnerHTML={renderMarkdown(skillContent)}
              sx={{
                mt: 1,
                maxHeight: '68vh',
                overflow: 'auto',
                p: 2.5,
                borderRadius: '14px',
                border: '1px solid var(--border-color)',
                bgcolor: 'var(--bg-primary)',
                color: 'var(--text-primary)',
                '& h1, & h2, & h3': { mt: 1.2, mb: 1, color: 'var(--text-primary)' },
                '& p, & li': { fontSize: 14, lineHeight: 1.75, color: 'var(--text-secondary)' },
                '& pre': { p: 1.5, borderRadius: '12px', overflow: 'auto', bgcolor: 'var(--bg-tertiary)' },
                '& code': { fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)' },
              }}
            />
          )}
        </DialogContent>
        <DialogActions sx={{ borderTop: '1px solid var(--border-color)', bgcolor: 'var(--bg-secondary)' }}>
          {skillDialog?.mode === 'preview' && skills.find(s => s.name === skillDialog.name && !s.builtin) && (
            <Button onClick={() => setSkillDialog({ name: skillDialog.name, mode: 'edit' })} startIcon={<Pencil size={14} />} sx={secondaryBtnSx}>编辑</Button>
          )}
          {skillDialog?.mode === 'edit' && (
            <Button onClick={() => setSkillDialog({ name: skillDialog.name, mode: 'preview' })} sx={secondaryBtnSx}>取消</Button>
          )}
          <Button onClick={() => setSkillDialog(null)} sx={secondaryBtnSx}>关闭</Button>
          {skillDialog?.mode === 'edit' && (
            <Button variant="contained" onClick={saveEditSkill}
              sx={{ borderRadius: '999px', textTransform: 'none', fontWeight: 600, background: 'var(--primary-gradient)', '&:hover': { background: 'var(--primary-gradient)', filter: 'brightness(0.98)' } }}>
              保存
            </Button>
          )}
        </DialogActions>
      </Dialog>

      {/* ── Delete Confirm Dialog ── */}
      <Dialog open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} maxWidth="xs"
        PaperProps={{ sx: dialogPaperSx }}>
        <DialogTitle sx={{ fontWeight: 700, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-color)' }}>确认删除</DialogTitle>
        <DialogContent sx={{ bgcolor: 'var(--bg-secondary)' }}>
          <DialogContentText sx={{ color: 'var(--text-secondary)', mt: 1 }}>
            确定要删除{deleteTarget?.type === 'skill' ? ' Skill' : ' MCP 服务器'} "{deleteTarget?.name}" 吗？此操作不可撤销。
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ borderTop: '1px solid var(--border-color)', bgcolor: 'var(--bg-secondary)' }}>
          <Button onClick={() => setDeleteTarget(null)} sx={secondaryBtnSx}>取消</Button>
          <Button variant="contained" color="error" onClick={() => {
            if (deleteTarget?.type === 'skill') void deleteSkill(deleteTarget.name)
            else if (deleteTarget?.type === 'server') void deleteServer(deleteTarget.name)
          }}
            sx={{ borderRadius: '999px', textTransform: 'none', fontWeight: 600 }}>
            删除
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}

export default McpPage
