import { createElement, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { UseSessions } from '@deepseek-ai/dsh-client-ui-session/client'
import type { CodingNsSubagentConversation, CodingNsSubagentSummary, CodingNsSubagentTurn } from '../shared/contracts/cli-adapter.js'
import { callCliRpc } from './cli-catalog.js'
import type { CodingNsRpcClient } from './features/types.js'
import { dshThemeColor } from './theme.js'

export const SUBAGENT_PROVIDER_ID = 'codingns4dsh/subagent-conversations'
export const SUBAGENT_KIND = 'codingns-subagents'

interface SidebarPort {
  readonly tabsIn?: (sessionId: string) => readonly { readonly kind: string }[]
  readonly openTabIn?: (sessionId: string, kind: string) => void
}

interface PanelProps {
  readonly sessionId: string
  readonly rpc: CodingNsRpcClient
}

interface AutoOpenProps {
  readonly useSessions: UseSessions
  readonly rpc: CodingNsRpcClient
  readonly sidebar: SidebarPort
}

/** 与 Agent Teams 一样按父会话定位子任务；外部进程的对话由插件面板展示。 */
export function registerSubagentConversationUi(ctx: Context, rpc: CodingNsRpcClient): () => void {
  const disposers: Array<() => void> = []
  try {
    disposers.push(ctx.sidebarRightTabs.register({
      id: SUBAGENT_PROVIDER_ID,
      kind: SUBAGENT_KIND,
      multiple: false,
      priority: 'extension',
      title: () => '子代理对话',
      guide: [{ id: 'subagents', order: 35, title: () => '子代理对话', description: () => '查看外部子代理的运行、消息与工具记录', icon: SubagentIcon }],
    }))
    disposers.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab', key: SUBAGENT_PROVIDER_ID,
      inject: () => ({ rpc }),
    }, SubagentPanel)))
    disposers.push(ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay', id: 'codingns4dsh-subagent-auto-open', order: 995,
      inject: () => ({ rpc, sidebar: ctx.sidebarRight as unknown as SidebarPort }),
    }, SubagentAutoOpen)))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

function SubagentAutoOpen({ useSessions, rpc, sidebar }: AutoOpenProps): null {
  const snapshot = useSessions((value: unknown) => value)
  const sessionIds = readSessionIds(snapshot)
  const known = useRef(new Set<string>())
  const initialized = useRef(false)
  useEffect(() => {
    if (typeof sidebar.openTabIn !== 'function') return
    let disposed = false
    let polling = false
    const poll = async (): Promise<void> => {
      if (polling) return
      polling = true
      try {
        const rows = await callCliRpc<readonly CodingNsSubagentSummary[]>(rpc, 'subagents/list', {})
        if (disposed) return
        if (!initialized.current) {
          for (const row of rows) if (row.status !== 'running') known.current.add(row.id)
          initialized.current = true
        }
        for (const row of rows) {
          if (known.current.has(row.id) || !row.parentSessionId || !sessionIds.includes(row.parentSessionId)) continue
          try {
            if (!sidebar.tabsIn?.(row.parentSessionId).some((tab) => tab.kind === SUBAGENT_KIND)) {
              sidebar.openTabIn?.(row.parentSessionId, SUBAGENT_KIND)
            }
            known.current.add(row.id)
          } catch { /* Session 尚未装配时留到下一轮重试。 */ }
        }
      } catch { /* Host 切换或功能停用时保留手动打开入口。 */ }
      finally { polling = false }
    }
    void poll()
    const timer = setInterval(() => { void poll() }, 1500)
    return () => { disposed = true; clearInterval(timer) }
  }, [rpc, sidebar, sessionIds.join('|')])
  return null
}

function SubagentPanel({ sessionId, rpc }: PanelProps): ReactElement {
  const [summaries, setSummaries] = useState<readonly CodingNsSubagentSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [conversation, setConversation] = useState<CodingNsSubagentConversation | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selectedId

  useEffect(() => {
    let disposed = false
    let polling = false
    setSummaries([])
    setSelectedId(null)
    setConversation(null)
    setLoadError('')
    setActionError('')
    const poll = async (): Promise<void> => {
      if (polling) return
      polling = true
      try {
        const rows = await callCliRpc<readonly CodingNsSubagentSummary[]>(rpc, 'subagents/list', { parentSessionId: String(sessionId) })
        if (disposed) return
        setSummaries(rows)
        const currentId = selectedRef.current && rows.some((row) => row.id === selectedRef.current) ? selectedRef.current : rows[0]?.id ?? null
        if (currentId !== selectedRef.current) { selectedRef.current = currentId; setSelectedId(currentId) }
        if (currentId === null) setConversation(null)
        else {
          const detail = await callCliRpc<CodingNsSubagentConversation | undefined>(rpc, 'subagents/get', { childSessionId: currentId })
          if (!disposed && selectedRef.current === currentId) setConversation(detail ?? null)
        }
        if (!disposed) setLoadError('')
      } catch (cause) {
        if (!disposed) setLoadError(cause instanceof Error ? cause.message : String(cause))
      } finally { polling = false }
    }
    void poll()
    const timer = setInterval(() => { void poll() }, 1000)
    return () => { disposed = true; clearInterval(timer) }
  }, [rpc, sessionId])

  const followUp = async (): Promise<void> => {
    if (selectedId === null || draft.trim() === '') return
    setBusy(true)
    try {
      await callCliRpc(rpc, 'subagents/follow-up', { childSessionId: selectedId, prompt: draft.trim() })
      setDraft('')
      setActionError('')
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const interrupt = async (): Promise<void> => {
    if (selectedId === null) return
    try { await callCliRpc(rpc, 'subagents/interrupt', { childSessionId: selectedId }) }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)) }
  }

  return createElement('section', { style: rootStyle },
    createElement('header', { style: headerStyle },
      createElement('h2', { style: { margin: 0, fontSize: 16 } }, '子代理对话'),
      createElement('span', { style: mutedStyle }, `${summaries.length} 个`),
    ),
    (loadError || actionError) && createElement('div', { role: 'alert', style: errorStyle }, actionError || loadError),
    summaries.length === 0 && createElement('p', { style: mutedStyle }, '当前会话还没有外部子代理对话。主 Agent 调用 agent_subagent 后，对话会自动出现在这里。'),
    summaries.length > 0 && createElement('nav', { 'aria-label': '子代理对话列表', style: listStyle },
      ...summaries.map((row) => createElement('button', {
        key: row.id, type: 'button', onClick: () => { selectedRef.current = row.id; setSelectedId(row.id); setConversation(null); setActionError('') },
        style: { ...itemStyle, ...(selectedId === row.id ? selectedItemStyle : {}) },
      },
        createElement('strong', { style: truncateStyle }, row.title),
        createElement('span', { style: mutedStyle }, `${row.adapterId} · ${statusLabel(row.status)} · ${row.turnCount} 轮`),
      )),
    ),
    conversation && createElement('div', { style: transcriptStyle, 'aria-live': 'polite' },
      createElement('div', { style: metadataStyle },
        createElement('span', null, `${conversation.adapterId}${conversation.modelId ? ` / ${conversation.modelId}` : ''}`),
        createElement('span', null, statusLabel(conversation.status)),
      ),
      conversation.cwd && createElement('div', { title: conversation.cwd, style: { ...mutedStyle, ...truncateStyle } }, conversation.cwd),
      ...conversation.turns.map((turn) => createTurn(turn)),
      conversation.error && createElement('div', { role: 'alert', style: errorStyle }, conversation.error),
    ),
    conversation && createElement('div', { style: composerStyle },
      createElement('textarea', {
        value: draft, onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
        placeholder: conversation.providerSessionId ? '继续给子代理发消息…' : '该代理尚未提供可恢复的会话',
        disabled: busy || conversation.status === 'running' || !conversation.providerSessionId,
        'aria-label': '给子代理发送消息', style: inputStyle,
      }),
      createElement('div', { style: actionsStyle },
        conversation.status === 'running'
          ? createElement('button', { type: 'button', onClick: () => void interrupt(), style: secondaryButtonStyle }, '中断')
          : createElement('button', { type: 'button', disabled: busy || draft.trim() === '' || !conversation.providerSessionId, onClick: () => void followUp(), style: primaryButtonStyle }, '发送'),
      ),
    ),
  )
}

function createTurn(turn: CodingNsSubagentTurn): ReactElement {
  return createElement('div', { key: turn.id, style: turnStyle },
    createElement('div', { style: userBubbleStyle }, createElement('strong', null, '任务 / 消息'), createElement('div', { style: textStyle }, turn.prompt)),
    createElement('div', { style: assistantBubbleStyle },
      createElement('strong', null, '子代理'),
      turn.reasoning && createElement('details', { style: detailsStyle }, createElement('summary', null, '思考过程'), createElement('div', { style: textStyle }, turn.reasoning)),
      ...turn.tools.map((tool) => createElement('details', { key: tool.id, style: detailsStyle },
        createElement('summary', null, `${tool.name} · ${tool.status}`),
        tool.input && createElement('pre', { style: textStyle }, tool.input),
        tool.output && createElement('pre', { style: textStyle }, tool.output),
        tool.error && createElement('pre', { style: errorStyle }, tool.error),
      )),
      createElement('div', { style: textStyle }, turn.text || (turn.endedAt ? '（没有文本输出）' : '正在运行…')),
      turn.usageSummary && createElement('small', { style: mutedStyle }, turn.usageSummary),
    ),
  )
}

function readSessionIds(value: unknown): readonly string[] {
  if (typeof value !== 'object' || value === null) return []
  const record = value as Record<string, unknown>
  const ids = new Set<string>()
  if (typeof record.byId === 'object' && record.byId !== null) for (const id of Object.keys(record.byId)) ids.add(id)
  for (const key of ['sessionId', 'currentSessionId', 'selectedSessionId']) if (typeof record[key] === 'string') ids.add(record[key] as string)
  for (const key of ['items', 'sessions']) {
    const rows = record[key]
    if (!Array.isArray(rows)) continue
    for (const row of rows) {
      const id = row?.sessionId ?? row?.id
      if (typeof id === 'string') ids.add(id)
    }
  }
  return [...ids].filter(Boolean)
}

function statusLabel(status: CodingNsSubagentConversation['status']): string {
  switch (status) {
    case 'running': return '运行中'
    case 'idle': return '已完成'
    case 'error': return '失败'
    case 'cancelled': return '已中断'
  }
}

function SubagentIcon({ size = 16 }: { readonly size?: number | undefined }): ReactElement {
  return createElement('span', { 'aria-hidden': true, style: { width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: size } }, '◇')
}

const rootStyle: CSSProperties = { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, padding: 12, gap: 10, boxSizing: 'border-box', background: dshThemeColor.pageBackground }
const headerStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }
const mutedStyle: CSSProperties = { color: dshThemeColor.labelSecondary, fontSize: 12 }
const listStyle: CSSProperties = { display: 'flex', gap: 6, overflowX: 'auto', flexShrink: 0, paddingBottom: 4 }
const itemStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 3, textAlign: 'left', minWidth: 142, maxWidth: 190, padding: '8px 10px', border: `1px solid ${dshThemeColor.border}`, borderRadius: 8, background: 'transparent', color: 'inherit', cursor: 'pointer' }
const selectedItemStyle: CSSProperties = { borderColor: '#647dff', background: 'rgba(100,125,255,.12)' }
const truncateStyle: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const transcriptStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12, flex: '1 1 auto', minHeight: 0, overflowY: 'auto', paddingRight: 4 }
const metadataStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', color: dshThemeColor.labelSecondary, fontSize: 12 }
const turnStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, borderBottom: `1px solid ${dshThemeColor.border}`, paddingBottom: 12 }
const userBubbleStyle: CSSProperties = { alignSelf: 'flex-end', maxWidth: '94%', padding: 10, borderRadius: 10, background: 'rgba(100,125,255,.14)', fontSize: 13 }
const assistantBubbleStyle: CSSProperties = { alignSelf: 'stretch', padding: 10, borderRadius: 10, border: `1px solid ${dshThemeColor.border}`, fontSize: 13 }
const textStyle: CSSProperties = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '6px 0 0', fontFamily: 'inherit', fontSize: 13 }
const detailsStyle: CSSProperties = { marginTop: 6, color: dshThemeColor.labelSecondary }
const composerStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }
const inputStyle: CSSProperties = { width: '100%', minHeight: 64, resize: 'vertical', boxSizing: 'border-box', border: `1px solid ${dshThemeColor.border}`, borderRadius: 8, padding: 8, background: 'transparent', color: 'inherit', fontFamily: 'inherit' }
const actionsStyle: CSSProperties = { display: 'flex', justifyContent: 'flex-end' }
const primaryButtonStyle: CSSProperties = { padding: '6px 12px', border: 0, borderRadius: 7, background: '#647dff', color: 'white', cursor: 'pointer' }
const secondaryButtonStyle: CSSProperties = { padding: '6px 12px', border: `1px solid ${dshThemeColor.border}`, borderRadius: 7, background: 'transparent', color: 'inherit', cursor: 'pointer' }
const errorStyle: CSSProperties = { color: dshThemeColor.error, fontSize: 12, whiteSpace: 'pre-wrap' }
