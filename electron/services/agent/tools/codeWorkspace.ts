import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { proxyCodeWorkspaceCall } from '../codeWorkspaceProxyClient'
import type { CodeWorkspaceRef } from '../codeWorkspaceTypes'

type CodeWorkspaceToolOptions = {
  readOnly?: boolean
}

function callCodeWorkspace(workspace: CodeWorkspaceRef, method: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return proxyCodeWorkspaceCall(method, args, workspace).catch((error) => ({
    success: false,
    error: error instanceof Error ? error.message : String(error),
  }))
}

export function createCodeWorkspaceTools(
  workspace: CodeWorkspaceRef | null | undefined,
  options: CodeWorkspaceToolOptions = {},
): ToolSet {
  if (!workspace?.root) return {}

  const readTools: ToolSet = {
    code_workspace_status: tool({
      description:
        '查看当前代码工作区状态、根目录、dev server 状态和常见项目文件线索。只读。',
      inputSchema: z.object({}),
      execute: async () => callCodeWorkspace(workspace, 'status'),
    }),

    code_list_files: tool({
      description:
        '列出代码工作区内的文件和目录。路径必须相对 workspace root；默认跳过 .git/node_modules/dist/.next/coverage 等目录。',
      inputSchema: z.object({
        path: z.string().default('.').describe('相对 workspace root 的目录路径，默认当前工作区根目录'),
        maxDepth: z.number().int().min(0).max(8).default(3).describe('递归深度，默认 3'),
        limit: z.number().int().min(1).max(600).default(200).describe('最多返回多少项，默认 200'),
      }),
      execute: async ({ path, maxDepth, limit }) => callCodeWorkspace(workspace, 'list_files', { path, maxDepth, limit }),
    }),

    code_read_file: tool({
      description:
        '读取工作区内的文本文件。会拦截二进制、大文件、越界路径；.env、密钥、证书、token 等敏感文件需要用户高风险确认。',
      inputSchema: z.object({
        path: z.string().min(1).describe('相对 workspace root 的文件路径'),
        maxLines: z.number().int().min(1).max(1400).default(1400).describe('最多返回行数，默认 1400'),
      }),
      execute: async ({ path, maxLines }) => callCodeWorkspace(workspace, 'read_file', { path, maxLines }),
    }),

    code_get_dev_server_logs: tool({
      description: '查看当前代码工作区 dev server/命令日志。只读。',
      inputSchema: z.object({}),
      execute: async () => callCodeWorkspace(workspace, 'get_dev_server_logs'),
    }),
  }

  if (options.readOnly) return readTools

  return {
    ...readTools,

    code_replace_in_file: tool({
      description:
        '在工作区内文本文件中替换一段已有文本。修改前会展示 diff 并等待用户确认；优先用它做小范围改动。',
      inputSchema: z.object({
        path: z.string().min(1).describe('相对 workspace root 的文件路径'),
        search: z.string().min(1).describe('要替换的原文，必须和文件内容完全匹配'),
        replace: z.string().describe('替换后的文本'),
        replaceAll: z.boolean().default(false).describe('是否替换所有匹配项，默认只替换第一处'),
      }),
      execute: async ({ path, search, replace, replaceAll }) => callCodeWorkspace(workspace, 'replace_in_file', {
        path,
        search,
        replace,
        replaceAll,
      }),
    }),

    code_write_file: tool({
      description:
        '创建或覆盖工作区内文本文件。写入前会展示 diff 并等待用户确认；不要写入敏感文件，除非用户明确要求。',
      inputSchema: z.object({
        path: z.string().min(1).describe('相对 workspace root 的文件路径'),
        content: z.string().describe('完整文件内容'),
      }),
      execute: async ({ path, content }) => callCodeWorkspace(workspace, 'write_file', { path, content }),
    }),

    code_delete_file: tool({
      description:
        '删除工作区内单个文件。删除前会展示 diff/删除预览并等待用户确认；不能删除目录。',
      inputSchema: z.object({
        path: z.string().min(1).describe('相对 workspace root 的文件路径'),
      }),
      execute: async ({ path }) => callCodeWorkspace(workspace, 'delete_file', { path }),
    }),

    code_run_command: tool({
      description:
        '在工作区内运行短命令并收集 stdout/stderr。必须用 command + args 数组；主进程用 spawn(command,args) 且不走 shell。安装依赖、测试、脚本执行都会先请求用户确认。',
      inputSchema: z.object({
        command: z.string().min(1).describe('可执行命令，例如 npm、npx、pnpm、node'),
        args: z.array(z.string()).default([]).describe('命令参数数组，例如 ["install"] 或 ["tsc","--noEmit"]'),
        cwd: z.string().optional().describe('相对 workspace root 的工作目录；默认 workspace root'),
        timeoutMs: z.number().int().min(1000).max(300000).optional().describe('超时时间，默认 5 分钟，上限 5 分钟'),
      }),
      execute: async ({ command, args, cwd, timeoutMs }) => callCodeWorkspace(workspace, 'run_command', {
        command,
        args,
        cwd,
        timeoutMs,
      }),
    }),

    code_start_dev_server: tool({
      description:
        '启动前端 dev server 并检测本机预览地址。默认命令是 npm run dev；长进程由主进程托管，启动前会请求用户确认，只接受 localhost/127.0.0.1 预览。',
      inputSchema: z.object({
        command: z.string().optional().describe('可执行命令，省略则使用 npm'),
        args: z.array(z.string()).optional().describe('命令参数，省略则使用 ["run","dev"]'),
        cwd: z.string().optional().describe('相对 workspace root 的工作目录；默认 workspace root'),
      }),
      execute: async ({ command, args, cwd }) => callCodeWorkspace(workspace, 'start_dev_server', {
        command,
        args,
        cwd,
      }),
    }),

    code_stop_dev_server: tool({
      description: '停止当前工作区 dev server 长进程。',
      inputSchema: z.object({}),
      execute: async () => callCodeWorkspace(workspace, 'stop_dev_server'),
    }),
  }
}
