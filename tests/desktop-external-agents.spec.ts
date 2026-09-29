import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonRpcProcess } from '../data/build/dist/host/cli-adapters/json-rpc-process.js'
import { MiniMaxCodeDriver } from '../data/build/dist/host/cli-adapters/mcode-driver.js'
import { ZcodeAppServerDriver } from '../data/build/dist/host/cli-adapters/zcode-driver.js'
import { CodingNsCliAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry.js'
import { setAdapterRegistry, setSubagentConversations } from '../data/build/dist/host/cli-adapters/registry-holder.js'
import { CodingNsSubagentConversations } from '../data/build/dist/host/cli-adapters/subagent-conversations.js'
import { createAgentSubagentTool } from '../data/build/dist/host/cli-adapters/subagent-tool.js'
import { registerNativeTeamSubagentProviders } from '../data/build/dist/host/cli-adapters/native-team-subagent.js'

test('mcode ACP 保留外部会话和流式正文', async () => {
  const requests: Record<string, unknown>[] = []
  const driver = new MiniMaxCodeDriver({
    binaries: ['fake-mcode'],
    spawnSync: (() => ({ status: 0, stdout: 'mcode 0.5.8', stderr: '' })) as never,
    spawn: ((_command: string, args: string[]) => {
      assert.deepEqual(args, ['acp'])
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      return {
        stdout, stderr,
        stdin: { write(data: string) {
          const request = JSON.parse(data) as Record<string, unknown>
          requests.push(request)
          if (request.method === 'initialized') return
          if (request.method === 'session/prompt') {
            setImmediate(() => {
              stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '完成' } } } })}\n`)
              stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } })}\n`)
            })
            return
          }
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: request.method === 'session/new' ? { sessionId: 'mvs-test' } : {} })}\n`)
        } },
        kill() { stdout.end(); stderr.end(); return true },
      }
    }) as never,
  })
  try {
    const events = []
    for await (const event of driver.executeTurn({ sessionId: 'dsh-test', messages: [], prompt: '测试' })) events.push(event)
    assert.deepEqual(events, [
      { type: 'session-binding', providerSessionId: 'mvs-test' },
      { type: 'text-delta', text: '完成' },
      { type: 'finish', reason: 'stop' },
    ])
    assert.deepEqual(requests.filter((item) => item.method !== 'initialized').map((item) => item.method), ['initialize', 'session/new', 'session/prompt'])
  } finally {
    driver.dispose()
  }
})

test('ZCode 使用无 jsonrpc 字段的双向协议并完成回合', async () => {
  const writes: Record<string, unknown>[] = []
  const driver = new ZcodeAppServerDriver({
    binaries: ['fake-zcode'],
    spawnSync: (() => ({ status: 0, stdout: 'zcode 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      return {
        stdout, stderr,
        stdin: { write(data: string) {
          const request = JSON.parse(data) as Record<string, unknown>
          writes.push(request)
          assert.equal('jsonrpc' in request, false)
          if (request.id === 99) return
          if (request.method === 'session/create') {
            stdout.write(`${JSON.stringify({ id: 99, method: 'session/requestRuntimePreferences', params: {} })}\n`)
            stdout.write(`${JSON.stringify({ id: request.id, result: { sessionId: 'sess-test' } })}\n`)
          } else if (request.method === 'session/send') {
            stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`)
            setImmediate(() => {
              stdout.write(`${JSON.stringify({ method: 'state.updated', params: { patch: { status: 'running' } } })}\n`)
              stdout.write(`${JSON.stringify({ method: 'conversation.message', params: { text: '已完成' } })}\n`)
              stdout.write(`${JSON.stringify({ method: 'state.updated', params: { patch: { status: 'idle' } } })}\n`)
            })
          }
        } },
        kill() { stdout.end(); stderr.end(); return true },
      }
    }) as never,
  })
  try {
    const events = []
    for await (const event of driver.executeTurn({ sessionId: 'dsh-test', messages: [], prompt: '测试' })) events.push(event)
    assert.deepEqual(events, [
      { type: 'session-binding', providerSessionId: 'sess-test' },
      { type: 'text-delta', text: '已完成' },
      { type: 'finish', reason: 'stop' },
    ])
    assert.deepEqual(writes.filter((item) => typeof item.method === 'string').map((item) => item.method), ['session/create', 'session/send'])
    assert.equal(writes.some((item) => item.id === 99 && typeof item.result === 'object'), true)
  } finally {
    driver.dispose()
  }
})

test('ZCode 取消请求仍使用无 jsonrpc 字段的信封', async () => {
  const writes: Record<string, unknown>[] = []
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const rpc = new JsonRpcProcess({
    command: 'fake-zcode',
    wireFormat: 'zcode',
    spawn: (() => ({
      stdout, stderr,
      stdin: { write(data: string) { writes.push(JSON.parse(data) as Record<string, unknown>) } },
      kill() { stdout.end(); stderr.end(); return true },
    })) as never,
  })
  const controller = new AbortController()
  try {
    const pending = rpc.request('session/list', {}, { signal: controller.signal, killOnAbort: false })
    controller.abort()
    await assert.rejects(pending, /请求已取消/)
    assert.deepEqual(writes.map((message) => message.method), ['session/list', '$/cancelRequest'])
    assert.equal(writes.every((message) => !('jsonrpc' in message)), true)
  } finally {
    rpc.dispose()
  }
})

test('agent_subagent 建立可见对话、按父会话归属并复用 Provider 会话续聊', async () => {
  const calls: Record<string, unknown>[] = []
  const driver = {
    descriptor: { id: 'mcode', name: 'MiniMax Code', protocol: 'acp', capabilities: ['stream'] },
    async detect() { return { installed: true, version: 'test', command: 'mcode' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn(input: Record<string, unknown>) {
      calls.push(input)
      yield { type: 'session-binding', providerSessionId: 'mvs-subagent' }
      yield { type: 'text-delta', text: calls.length === 1 ? '任务完成' : '续聊完成' }
      yield { type: 'tool-event', toolName: 'edit', callId: 'tool-1', status: 'completed', output: '文件已修改', outputMode: 'snapshot' }
      yield { type: 'usage', inputTokens: 10, outputTokens: 5, totalTokens: 15 }
      yield { type: 'finish', reason: 'stop' }
    },
  }
  const registry = new CodingNsCliAdapterRegistry([driver])
  const directory = await mkdtemp(join(tmpdir(), 'codingns-subagent-'))
  const path = join(directory, 'subagents.json')
  const conversations = new CodingNsSubagentConversations(registry, path)
  setSubagentConversations(conversations)
  try {
    const tool = createAgentSubagentTool() as { name: string; execute(args: Record<string, unknown>, exec: Record<string, unknown>): Promise<Record<string, unknown>> }
    assert.equal(tool.name, 'agent_subagent')
    const result = await tool.execute({ agent: 'mcode', prompt: '完成明确任务', model: 'model-1' }, { agent: { session: { header: { id: 'parent-1' } } } })
    assert.equal(result.ok, true)
    assert.equal(result.result, '任务完成')
    assert.equal(result.providerSessionId, 'mvs-subagent')
    assert.equal(result.usageSummary, '输入 10 / 输出 5 / 共 15')
    assert.equal(conversations.list('parent-1').length, 1)
    assert.equal(conversations.list('another-parent').length, 0)
    assert.equal(conversations.get(result.childSessionId as string)?.turns[0]?.tools[0]?.output, '文件已修改')
    assert.equal(calls[0]?.modelId, 'model-1')
    assert.equal(calls[0]?.prompt, '完成明确任务')
    conversations.followUp(result.childSessionId as string, '继续处理')
    for (let attempt = 0; attempt < 20 && conversations.get(result.childSessionId as string)?.status === 'running'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(calls[1]?.providerSessionId, 'mvs-subagent')
    assert.equal(conversations.get(result.childSessionId as string)?.turns[1]?.text, '续聊完成')
    await conversations.flush()
    const restored = new CodingNsSubagentConversations(registry, path)
    assert.equal(restored.get(result.childSessionId as string)?.turns.length, 2)
    await restored.dispose()
  } finally {
    setSubagentConversations(undefined)
    await conversations.dispose()
    await registry.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('agent_subagent 经 Agent Teams 创建原生子会话并返回首轮结果', async () => {
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'mcode', name: 'MiniMax Code', protocol: 'acp', capabilities: ['stream'] },
    async detect() { return { installed: true, version: 'test', command: 'mcode' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn() { yield { type: 'finish', reason: 'stop' } },
  }])
  setAdapterRegistry(registry)
  const providers = new Map<string, any>()
  registerNativeTeamSubagentProviders({ registerProvider(provider: any) { providers.set(provider.name, provider) } })
  const parent = { header: { id: 'parent-native', cwd: process.cwd() } }
  const child = { header: { id: 'child-native', parentSession: 'parent-native' } }
  let onEvent: ((session: unknown, event: unknown) => void) | undefined
  let disposed = false
  const sessions = {
    supportsEvents: true,
    store: { get: () => undefined },
    get(id: string) { return id === 'parent-native' ? parent : undefined },
    subscribe(handlers: { onEvent: (session: unknown, event: unknown) => void }) {
      onEvent = handlers.onEvent
      return () => { disposed = true }
    },
  }
  const team = {
    diagnostic: () => ({ supported: true }),
    async invoke(action: string, payload: any, signal: AbortSignal) {
      assert.equal(action, 'spawn')
      assert.equal(payload.provider, 'codingns-external-mcode')
      await providers.get(payload.provider).prepareContinuable({ sessionId: child.header.id, parent: { id: parent.header.id }, signal })
      onEvent?.(child, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '原生子代理完成' }] } } })
      const end = { type: 'turn/end', data: { reason: { kind: 'completed' } } }
      onEvent?.(child, end)
      return { member: { id: child.header.id } }
    },
  }
  try {
    const tool = createAgentSubagentTool({ nativeTeam: team, nativeSessions: sessions }) as {
      execute(args: Record<string, unknown>, exec: Record<string, unknown>): Promise<Record<string, unknown>>
    }
    const result = await tool.execute({ agent: 'mcode', prompt: '完成任务', model: 'model-test' }, { agent: { id: parent.header.id, session: parent } })
    assert.equal(result.childSessionId, child.header.id)
    assert.equal(result.ok, true)
    assert.equal(result.result, '原生子代理完成')
    assert.equal(registry.getSession(child.header.id).adapterId, 'mcode')
    assert.equal(registry.getSession(child.header.id).modelId, 'model-test')
    assert.equal(disposed, true)
  } finally {
    setAdapterRegistry(undefined)
    await registry.dispose()
  }
})
