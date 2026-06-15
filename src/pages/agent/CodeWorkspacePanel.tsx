import { useEffect, useMemo, useState } from 'react'
import { AlertDialog, Button as HeroButton, ButtonGroup, Label, Separator, Switch, Tabs } from '@heroui/react'
import { Code2, ExternalLink, FolderOpen, Monitor, ShieldAlert, Square, Terminal as TerminalIcon, X } from 'lucide-react'
import { Terminal as TerminalView } from '@/components/ai-elements/terminal'
import type { CodeWorkspaceApprovalRequest, CodeWorkspaceState } from '@/types/electron'

type CodeWorkspacePanelProps = {
  approval: CodeWorkspaceApprovalRequest | null
  enabled: boolean
  logs: string[]
  onApprove: (requestId: string) => void
  onClear: () => void
  onReject: (requestId: string) => void
  onSelect: () => void
  onStopDevServer: () => void
  onToggleEnabled: (enabled: boolean) => void
  state: CodeWorkspaceState | null
}

function basename(value: string): string {
  const parts = value.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] || value
}

function riskText(risk: CodeWorkspaceApprovalRequest['risk']): string {
  if (risk === 'high') return '高风险'
  if (risk === 'medium') return '中风险'
  return '低风险'
}

function kindText(kind: CodeWorkspaceApprovalRequest['kind']): string {
  switch (kind) {
    case 'write':
      return '写入'
    case 'delete':
      return '删除'
    case 'command':
      return '命令'
    case 'dev-server':
      return '开发服务器'
    case 'sensitive-read':
      return '敏感读取'
    default:
      return kind
  }
}

export function CodeWorkspacePanel({
  approval,
  enabled,
  logs,
  onApprove,
  onClear,
  onReject,
  onSelect,
  onStopDevServer,
  onToggleEnabled,
  state,
}: CodeWorkspacePanelProps) {
  const [expanded, setExpanded] = useState(false)
  const [activeTab, setActiveTab] = useState<'preview' | 'logs'>('logs')
  const workspace = state?.workspace ?? null
  const devServer = state?.devServer
  const previewUrl = devServer?.previewUrl || ''
  const terminalOutput = useMemo(() => logs.join('\n'), [logs])
  useEffect(() => {
    if (previewUrl) setActiveTab('preview')
  }, [previewUrl])
  useEffect(() => {
    if (approval) setExpanded(true)
  }, [approval])

  return (
    <>
      <div className="shrink-0 border-b border-border/60 bg-surface/70 px-4 py-2">
        <div className="mx-auto flex w-full min-w-80 max-w-[82%] flex-wrap items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Code2 className="size-4 shrink-0 text-muted-foreground" />
            <span className={`size-2 shrink-0 rounded-full ${workspace && enabled ? 'bg-emerald-500' : 'bg-muted-foreground/35'}`} />
            <div className="min-w-0">
              <div className="truncate font-medium text-sm">
                {workspace ? basename(workspace.root) : '代码工作区'}
              </div>
              {workspace && (
                <div className="truncate text-muted-foreground text-xs">
                  {workspace.root}
                </div>
              )}
            </div>
          </div>

          <ButtonGroup size="sm" variant="tertiary">
            <HeroButton onPress={onSelect} size="sm" variant="tertiary">
              <FolderOpen className="size-3.5" />
              选择
            </HeroButton>
            {workspace && (
              <HeroButton onPress={() => setExpanded((value) => !value)} size="sm" variant="tertiary">
                <Monitor className="size-3.5" />
                面板
              </HeroButton>
            )}
          </ButtonGroup>

          {workspace && (
            <>
              <Separator className="hidden h-5 sm:block" orientation="vertical" variant="tertiary" />
              <label className="inline-flex items-center gap-2 text-sm">
                <Switch aria-label="启用代码工作区" isSelected={enabled} onChange={(selected) => onToggleEnabled(Boolean(selected))}>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                </Switch>
                启用
              </label>
              {devServer?.running && (
                <HeroButton onPress={onStopDevServer} size="sm" variant="secondary">
                  <Square className="size-3.5" />
                  停止
                </HeroButton>
              )}
              <HeroButton aria-label="清除代码工作区" isIconOnly onPress={onClear} size="sm" variant="ghost">
                <X className="size-4" />
              </HeroButton>
            </>
          )}
        </div>

        {workspace && expanded && (
          <div className="mx-auto mt-2 grid w-full min-w-80 max-w-[82%] gap-3 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
            <TerminalView
              className="min-h-64"
              isStreaming={Boolean(devServer?.running)}
              output={terminalOutput || '$ 等待 Agent 运行命令'}
            />
            <div className="min-h-64 overflow-hidden rounded-(--agent-radius,12px) border border-border bg-card">
              <Tabs selectedKey={activeTab} onSelectionChange={(key) => setActiveTab(key as 'preview' | 'logs')}>
                <Tabs.ListContainer>
                  <Tabs.List aria-label="代码工作区面板">
                    <Tabs.Tab id="preview">
                      预览
                      <Tabs.Indicator />
                    </Tabs.Tab>
                    <Tabs.Tab id="logs">
                      日志
                      <Tabs.Indicator />
                    </Tabs.Tab>
                  </Tabs.List>
                </Tabs.ListContainer>
                <Tabs.Panel className="h-56 p-0" id="preview">
                  {previewUrl ? (
                    <iframe
                      className="h-full w-full bg-white"
                      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation"
                      src={previewUrl}
                      title="代码工作区预览"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
                      等待 localhost 预览地址
                    </div>
                  )}
                </Tabs.Panel>
                <Tabs.Panel className="h-56 overflow-auto p-3" id="logs">
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs">
                    {terminalOutput || '$ 无日志'}
                  </pre>
                </Tabs.Panel>
              </Tabs>
              {previewUrl && (
                <div className="flex items-center justify-between border-t border-border px-3 py-2 text-xs">
                  <span className="truncate text-muted-foreground">{previewUrl}</span>
                  <HeroButton onPress={() => { void window.electronAPI.shell.openExternal(previewUrl) }} size="sm" variant="ghost">
                    <ExternalLink className="size-3.5" />
                    打开
                  </HeroButton>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <AlertDialog.Backdrop isOpen={approval !== null}>
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-3xl">
            <AlertDialog.Header>
              <div className="flex items-center gap-2">
                <ShieldAlert className="size-4 text-amber-500" />
                代码工作区确认
              </div>
            </AlertDialog.Header>
            <AlertDialog.Body>
              {approval && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="rounded-(--agent-radius,12px) border border-border px-2 py-1">{kindText(approval.kind)}</span>
                    <span className="rounded-(--agent-radius,12px) border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-amber-700 dark:text-amber-300">
                      {riskText(approval.risk)}
                    </span>
                    <Label>{approval.summary}</Label>
                  </div>
                  {approval.targetPath && (
                    <div className="rounded-(--agent-radius,12px) bg-muted/50 px-3 py-2 font-mono text-xs">
                      {approval.targetPath}
                    </div>
                  )}
                  {approval.command && (
                    <div className="rounded-(--agent-radius,12px) bg-zinc-950 px-3 py-2 font-mono text-zinc-100 text-xs">
                      $ {approval.command}
                    </div>
                  )}
                  {approval.diffPreview && (
                    <pre className="max-h-[50vh] overflow-auto rounded-(--agent-radius,12px) border border-border bg-muted/35 p-3 font-mono text-xs">
                      {approval.diffPreview}
                    </pre>
                  )}
                </div>
              )}
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <HeroButton
                onPress={() => approval && onReject(approval.requestId)}
                variant="secondary"
              >
                拒绝
              </HeroButton>
              <HeroButton
                onPress={() => approval && onApprove(approval.requestId)}
                variant="primary"
              >
                批准
              </HeroButton>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </>
  )
}
