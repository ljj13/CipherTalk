import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  Chip,
  Container,
  Snackbar,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material'
import { Check, Copy, Download, RefreshCw, Save, Sparkles } from 'lucide-react'
import * as configService from '../services/config'
import type { SkillInstallTarget } from '../types/electron'

type ToastState = {
  text: string
  success: boolean
}

type McpLaunchConfig = {
  command: string
  args: string[]
  cwd: string
  mode: 'dev' | 'packaged'
}

function formatCommandPart(value: string) {
  if (!value) return value
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
}

function getPackagedLauncherLabel(command: string) {
  return command.endsWith('ciphertalk-mcp') ? '`ciphertalk-mcp`' : '`ciphertalk-mcp.cmd`'
}

const textFieldSx = {
  '& .MuiInputLabel-root': {
    color: 'var(--text-secondary)',
  },
  '& .MuiInputLabel-root.Mui-focused': {
    color: 'var(--primary)',
  },
  '& .MuiOutlinedInput-root': {
    borderRadius: '14px',
    color: 'var(--text-primary)',
    backgroundColor: 'var(--bg-secondary)',
    '& fieldset': {
      borderColor: 'var(--border-color)',
    },
    '&:hover fieldset': {
      borderColor: 'var(--primary)',
    },
    '&.Mui-focused fieldset': {
      borderColor: 'var(--primary)',
    },
  },
  '& .MuiInputBase-input': {
    color: 'var(--text-primary)',
  },
}

const switchSx = {
  '& .MuiSwitch-switchBase.Mui-checked': {
    color: 'var(--primary)',
  },
  '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': {
    backgroundColor: 'var(--primary)',
  },
  '& .MuiSwitch-track': {
    backgroundColor: 'var(--text-tertiary)',
  },
}

const secondaryButtonSx = {
  borderRadius: '999px',
  minWidth: 120,
  textTransform: 'none',
  fontWeight: 600,
  color: 'var(--text-primary)',
  borderColor: 'var(--border-color)',
  backgroundColor: 'var(--bg-secondary)',
  '&:hover': {
    borderColor: 'var(--primary)',
    backgroundColor: 'var(--primary-light)',
  },
}

function McpPage() {
  const managedSkillName = 'ct-mcp-copilot'
  const [mcpEnabled, setMcpEnabled] = useState(false)
  const [mcpExposeMediaPaths, setMcpExposeMediaPaths] = useState(true)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [skillTargets, setSkillTargets] = useState<SkillInstallTarget[]>([])
  const [detectingSkills, setDetectingSkills] = useState(false)
  const [installingSkill, setInstallingSkill] = useState(false)
  const [exportingSkillZip, setExportingSkillZip] = useState(false)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [launchConfig, setLaunchConfig] = useState<McpLaunchConfig>({
    command: 'npm',
    args: ['run', 'mcp'],
    cwd: 'D:/CipherTalk',
    mode: 'dev',
  })

  useEffect(() => {
    const load = async () => {
      try {
        const [enabled, exposeMediaPaths] = await Promise.all([
          configService.getMcpEnabled(),
          configService.getMcpExposeMediaPaths(),
        ])
        setMcpEnabled(enabled)
        setMcpExposeMediaPaths(exposeMediaPaths)

        try {
          const mcpLaunchConfig = await window.electronAPI.app.getMcpLaunchConfig()
          if (mcpLaunchConfig?.command && Array.isArray(mcpLaunchConfig.args) && mcpLaunchConfig.cwd) {
            setLaunchConfig(mcpLaunchConfig)
          }
        } catch (innerError) {
          const message = String(innerError || '')
          if (!message.includes("No handler registered for 'app:getMcpLaunchConfig'")) {
            console.error('获取 MCP 启动配置失败:', innerError)
          }
        }

        try {
          const targets = await window.electronAPI.skillInstaller.detectTargets(managedSkillName)
          setSkillTargets(targets)
        } catch (innerError) {
          console.error('检测 Skills 安装目标失败:', innerError)
        }
      } catch (e) {
        console.error('加载 MCP 配置失败:', e)
        setToast({ text: '加载 MCP 配置失败', success: false })
      } finally {
        setLoading(false)
      }
    }
    void load()
  }, [])

  const mcpRunCommand = useMemo(() => {
    const parts = [launchConfig.command, ...launchConfig.args].map(formatCommandPart)
    return parts.join(' ')
  }, [launchConfig])

  const mcpServerJsonTemplate = useMemo(() => JSON.stringify({
    mcpServers: {
      ciphertalk: {
        command: launchConfig.command,
        args: launchConfig.args,
        cwd: launchConfig.cwd
      }
    }
  }, null, 2), [launchConfig])

  const handleSave = async () => {
    setSaving(true)
    try {
      await Promise.all([
        configService.setMcpEnabled(mcpEnabled),
        configService.setMcpExposeMediaPaths(mcpExposeMediaPaths),
      ])
      setToast({ text: 'MCP 配置已保存', success: true })
    } catch (e) {
      console.error('保存 MCP 配置失败:', e)
      setToast({ text: '保存 MCP 配置失败', success: false })
    } finally {
      setSaving(false)
    }
  }

  const copyText = async (text: string, successText: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setToast({ text: successText, success: true })
    } catch (e) {
      console.error('复制失败:', e)
      setToast({ text: '复制失败，请手动复制', success: false })
    }
  }

  const detectSkillTargets = async () => {
    setDetectingSkills(true)
    try {
      const targets = await window.electronAPI.skillInstaller.detectTargets(managedSkillName)
      setSkillTargets(targets)
      setToast({ text: '已刷新 Skills 安装目标', success: true })
    } catch (e) {
      console.error('检测 Skills 安装目标失败:', e)
      setToast({ text: '检测 Skills 安装目标失败', success: false })
    } finally {
      setDetectingSkills(false)
    }
  }

  const installManagedSkill = async () => {
    setInstallingSkill(true)
    try {
      const result = await window.electronAPI.skillInstaller.installSkill(managedSkillName)
      setSkillTargets(result.results)
      if (result.success) {
        setToast({ text: `${managedSkillName} 已安装到支持的 Agent`, success: true })
      } else {
        setToast({ text: result.error || 'Skill 安装失败', success: false })
      }
    } catch (e) {
      console.error('安装 Skill 失败:', e)
      setToast({ text: '安装 Skill 失败', success: false })
    } finally {
      setInstallingSkill(false)
    }
  }

  const exportManagedSkillZip = async () => {
    setExportingSkillZip(true)
    try {
      const result = await window.electronAPI.skillInstaller.exportSkillZip(managedSkillName)
      if (result.success) {
        setToast({ text: `Skill 压缩包已导出到 ${result.outputPath}`, success: true })
      } else {
        setToast({ text: result.error || '导出 Skill 压缩包失败', success: false })
      }
    } catch (e) {
      console.error('导出 Skill 压缩包失败:', e)
      setToast({ text: '导出 Skill 压缩包失败', success: false })
    } finally {
      setExportingSkillZip(false)
    }
  }

  const bundledSkillVersion = skillTargets[0]?.bundledVersion || '1.0.0'

  return (
    <Box sx={{ height: '100%', mx: -3, mt: -3, overflowY: 'auto', pb: 3 }}>
      <Container maxWidth="lg" sx={{ px: { xs: 2, md: 4 }, py: { xs: 3, md: 4 } }}>
        <Stack spacing={2.2}>
        <Box sx={{ px: { xs: 0.5, md: 1 }, pt: 0.5 }}>
          <Typography variant="h4" sx={{ fontSize: 30, fontWeight: 700, color: 'var(--text-primary)' }}>
            MCP Server
          </Typography>
          <Typography sx={{ mt: 1, color: 'var(--text-secondary)' }}>
            使用标准 MCP `stdio` 工具接口为 Claude Desktop、Codex、Cherry Studio 等宿主提供本地聊天数据读取能力。
          </Typography>
        </Box>

        <Card
          sx={{
            borderRadius: '26px',
            border: '1px solid var(--border-color)',
            bgcolor: 'var(--bg-secondary)',
            boxShadow: 'none',
          }}
        >
          <CardHeader
            title="服务配置"
            titleTypographyProps={{ fontWeight: 700, fontSize: 18, color: 'var(--text-primary)' }}
            sx={{ px: { xs: 2, md: 3 }, pb: 0.8 }}
          />
          <CardContent sx={{ px: { xs: 2, md: 3 }, pt: 0.6 }}>
            <Stack spacing={2.4}>
              <Alert
                severity="info"
                variant="outlined"
                sx={{
                  borderRadius: '18px',
                  bgcolor: 'var(--bg-primary)',
                  borderColor: 'var(--border-color)',
                  color: 'var(--text-primary)',
                  '& .MuiAlert-message': {
                    color: 'var(--text-primary)',
                  },
                }}
              >
                `mcpEnabled` 现在只作为状态标记和 warning 来源，不阻止宿主拉起 MCP。
                {launchConfig.mode === 'packaged'
                  ? ` 当前展示的是打包版伴随启动器 ${getPackagedLauncherLabel(launchConfig.command)}。`
                  : ' 当前展示的是开发态入口 `npm run mcp`。'}
              </Alert>

              <Box
                sx={{
                  p: 2,
                  borderRadius: '18px',
                  border: '1px solid var(--border-color)',
                  bgcolor: 'var(--bg-primary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 2,
                }}
              >
                <Box>
                  <Typography sx={{ fontWeight: 600, color: 'var(--text-primary)' }}>MCP 状态标记</Typography>
                  <Typography sx={{ mt: 0.5, fontSize: 13, color: 'var(--text-secondary)' }}>
                    仅用于在 `health_check` / `get_status` 中暴露当前配置状态，不会阻止宿主调用工具。
                  </Typography>
                </Box>
                <Switch
                  checked={mcpEnabled}
                  onChange={(e) => setMcpEnabled(e.target.checked)}
                  disabled={loading || saving}
                  sx={switchSx}
                />
              </Box>

              <Box
                sx={{
                  p: 2,
                  borderRadius: '18px',
                  border: '1px solid var(--border-color)',
                  bgcolor: 'var(--bg-primary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 2,
                }}
              >
                <Box>
                  <Typography sx={{ fontWeight: 600, color: 'var(--text-primary)' }}>默认解析媒体本地路径</Typography>
                  <Typography sx={{ mt: 0.5, fontSize: 13, color: 'var(--text-secondary)' }}>
                    控制 `get_messages`、`search_messages`、`get_session_context` 默认是否解析并返回图片、视频、语音、文件等本地路径。
                  </Typography>
                </Box>
                <Switch
                  checked={mcpExposeMediaPaths}
                  onChange={(e) => setMcpExposeMediaPaths(e.target.checked)}
                  disabled={loading || saving}
                  sx={switchSx}
                />
              </Box>

              <Box>
                <Typography sx={{ mb: 1, fontWeight: 600, color: 'var(--text-primary)' }}>启动命令</Typography>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.2}>
                  <TextField
                    fullWidth
                    value={mcpRunCommand}
                    InputProps={{ readOnly: true }}
                    sx={textFieldSx}
                  />
                  <Button
                    variant="outlined"
                    startIcon={<Copy size={16} />}
                    onClick={() => copyText(mcpRunCommand, 'MCP 启动命令已复制')}
                    sx={secondaryButtonSx}
                  >
                    复制
                  </Button>
                </Stack>
              </Box>

              <Box>
                <Typography sx={{ mb: 1, fontWeight: 600, color: 'var(--text-primary)' }}>
                  标准 mcpServers 配置（可直接粘贴）
                </Typography>
                <TextField
                  fullWidth
                  multiline
                  minRows={9}
                  value={mcpServerJsonTemplate}
                  InputProps={{ readOnly: true }}
                  sx={{
                    ...textFieldSx,
                    '& .MuiOutlinedInput-root': {
                      borderRadius: '14px',
                      color: 'var(--text-primary)',
                      backgroundColor: 'var(--bg-secondary)',
                      fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)',
                    },
                  }}
                />
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.2} sx={{ mt: 1.2 }}>
                  <Button
                    variant="outlined"
                    startIcon={<Copy size={16} />}
                    onClick={() => copyText(mcpServerJsonTemplate, 'mcpServers 配置已复制')}
                    sx={secondaryButtonSx}
                  >
                    复制配置
                  </Button>
                  <Typography sx={{ alignSelf: 'center', fontSize: 13, color: 'var(--text-secondary)' }}>
                    {launchConfig.mode === 'packaged'
                      ? '打包态请直接把 `command` 指向启动器本身；macOS 不要把 `CipherTalk.app` 本体当作 command。'
                      : '`cwd` 已自动使用当前仓库目录，通常无需修改。'}
                  </Typography>
                </Stack>
              </Box>

              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.2} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }}>
                <Typography sx={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  v2 工具：`health_check`、`get_status`、`list_sessions`、`get_messages`、`list_contacts`、`search_messages`、`get_session_context`、`get_global_statistics`、`get_contact_rankings`、`get_activity_distribution`
                </Typography>
                <Button
                  variant="contained"
                  onClick={handleSave}
                  disabled={loading || saving}
                  sx={{
                    minWidth: 42,
                    width: 42,
                    height: 42,
                    borderRadius: '999px',
                    p: 0,
                    textTransform: 'none',
                    fontWeight: 700,
                    background: 'var(--primary-gradient)',
                    '&:hover': {
                      background: 'var(--primary-gradient)',
                      filter: 'brightness(0.98)',
                    },
                  }}
                  title={saving ? '保存中...' : '保存配置'}
                  aria-label={saving ? '保存中' : '保存配置'}
                >
                  <Save size={16} />
                </Button>
              </Stack>

            </Stack>
          </CardContent>
        </Card>

        <Card
          sx={{
            borderRadius: '26px',
            border: '1px solid var(--border-color)',
            bgcolor: 'var(--bg-secondary)',
            boxShadow: 'none',
          }}
        >
          <CardHeader
            title="AI Copilot Skill"
            titleTypographyProps={{ fontWeight: 700, fontSize: 18, color: 'var(--text-primary)' }}
            sx={{ px: { xs: 2, md: 3 }, pb: 0.8 }}
          />
          <CardContent sx={{ px: { xs: 2, md: 3 }, pt: 0.6 }}>
            <Stack spacing={2.2}>
              <Alert
                severity="info"
                variant="outlined"
                sx={{
                  borderRadius: '18px',
                  bgcolor: 'var(--bg-primary)',
                  borderColor: 'var(--border-color)',
                  color: 'var(--text-primary)',
                }}
              >
                内置 Skill `ct-mcp-copilot` 可帮助支持 Skills 的 Agent 更聪明地使用 CipherTalk MCP 做模糊联系人查找、会话定位和导出补问。
              </Alert>

              <Box
                sx={{
                  p: 2,
                  borderRadius: '18px',
                  border: '1px solid var(--border-color)',
                  bgcolor: 'var(--bg-primary)',
                }}
              >
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.2} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }}>
                  <Box>
                    <Typography sx={{ fontWeight: 600, color: 'var(--text-primary)' }}>内置 Skill 版本</Typography>
                    <Typography sx={{ mt: 0.5, fontSize: 13, color: 'var(--text-secondary)' }}>
                      当前内置版本：`{bundledSkillVersion}`。如果本机已安装版本更低，页面会提示可更新。
                    </Typography>
                  </Box>
                  <Button
                    variant="outlined"
                    startIcon={<Download size={16} />}
                    onClick={exportManagedSkillZip}
                    disabled={exportingSkillZip}
                    sx={secondaryButtonSx}
                  >
                    {exportingSkillZip ? '导出中...' : '导出 zip'}
                  </Button>
                </Stack>
              </Box>

              <Box
                sx={{
                  p: 2,
                  borderRadius: '18px',
                  border: '1px solid var(--border-color)',
                  bgcolor: 'var(--bg-primary)',
                }}
              >
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.2} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }}>
                  <Box>
                    <Typography sx={{ fontWeight: 600, color: 'var(--text-primary)' }}>一键安装到本机 Agent</Typography>
                    <Typography sx={{ mt: 0.5, fontSize: 13, color: 'var(--text-secondary)' }}>
                      自动探测 Codex、`.agents` 以及主目录下更多可能的 skills 目录，并把 `ct-mcp-copilot` 复制安装进去。
                    </Typography>
                  </Box>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.2}>
                    <Button
                      variant="outlined"
                      startIcon={<RefreshCw size={16} />}
                      onClick={detectSkillTargets}
                      disabled={detectingSkills || installingSkill}
                      sx={secondaryButtonSx}
                    >
                      {detectingSkills ? '检测中...' : '检测目标'}
                    </Button>
                    <Button
                      variant="contained"
                      startIcon={<Sparkles size={16} />}
                      onClick={installManagedSkill}
                      disabled={installingSkill}
                      sx={{
                        minWidth: 140,
                        borderRadius: '999px',
                        textTransform: 'none',
                        fontWeight: 700,
                        background: 'var(--primary-gradient)',
                        '&:hover': {
                          background: 'var(--primary-gradient)',
                          filter: 'brightness(0.98)',
                        },
                      }}
                    >
                      {installingSkill ? '安装中...' : '一键安装'}
                    </Button>
                  </Stack>
                </Stack>
              </Box>

              <Stack spacing={1.2}>
                {skillTargets.map((target) => (
                  <Box
                    key={`${target.agentKind}-${target.skillsDir}`}
                    sx={{
                      p: 2,
                      borderRadius: '18px',
                      border: '1px solid var(--border-color)',
                      bgcolor: 'var(--bg-primary)',
                    }}
                  >
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between" alignItems={{ xs: 'flex-start', sm: 'center' }}>
                      <Box sx={{ minWidth: 0 }}>
                        <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
                          <Typography sx={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                            {target.agentLabel}
                          </Typography>
                          <Chip
                            label={target.installed ? '已安装' : target.supported ? '可安装' : '不支持'}
                            size="small"
                            color={target.installed ? 'success' : target.supported ? 'primary' : 'default'}
                            variant="outlined"
                          />
                          {target.updateAvailable && (
                            <Chip
                              label="可更新"
                              size="small"
                              color="warning"
                              variant="outlined"
                            />
                          )}
                          <Chip
                            label={target.source === 'known' ? '内置规则' : '扫描发现'}
                            size="small"
                            variant="outlined"
                          />
                        </Stack>
                        <Typography sx={{ mt: 0.75, fontSize: 13, color: 'var(--text-secondary)', wordBreak: 'break-all' }}>
                          {target.installPath || target.skillsDir}
                        </Typography>
                        <Typography sx={{ mt: 0.5, fontSize: 12, color: 'var(--text-secondary)' }}>
                          已安装版本：{target.installedVersion || '未安装'} / 内置版本：{target.bundledVersion}
                        </Typography>
                        {target.error && (
                          <Typography sx={{ mt: 0.75, fontSize: 12, color: 'var(--danger)' }}>
                            {target.error}
                          </Typography>
                        )}
                      </Box>
                    </Stack>
                  </Box>
                ))}
                {skillTargets.length === 0 && (
                  <Typography sx={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                    还没有检测到本机 Skill 目标，点击“检测目标”后可查看支持情况。
                  </Typography>
                )}
              </Stack>

              <Typography sx={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                安装完成后，可在支持 Skills 的 Agent 中直接提到 `ct-mcp-copilot` 使用；也可以导出 `zip` 后手动导入。Cherry Studio 等 MCP 宿主仍然继续使用 `mcpServers` 配置，不属于 skills 目录安装模型。
              </Typography>
            </Stack>
          </CardContent>
        </Card>
        </Stack>
      </Container>

      <Snackbar
        open={!!toast}
        autoHideDuration={2400}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          icon={toast?.success ? <Check size={16} /> : undefined}
          severity={toast?.success ? 'success' : 'error'}
          variant="filled"
          onClose={() => setToast(null)}
          sx={{
            borderRadius: '12px',
            color: '#fff',
            bgcolor: toast?.success ? 'var(--primary)' : 'var(--danger)',
          }}
        >
          {toast?.text}
        </Alert>
      </Snackbar>
    </Box>
  )
}

export default McpPage
