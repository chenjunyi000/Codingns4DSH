import type { AggregateHostResult, AggregateWorkspaceSummary, PeerHostSessionRecord } from '../../../shared/contracts/peer-host.js'

export interface AggregateSessionSource {
  readonly sessionId: string
  readonly title: string
  readonly status: string
  readonly updatedAt: number
}

export interface AggregateWorkspaceSource {
  readonly workspaceId: string
  readonly displayName: string
  readonly sessions: readonly AggregateSessionSource[]
}

export interface AggregateHostSource {
  readonly hostId: string
  readonly targetHostId: string | null
  readonly hostLabel: string
  readonly load: () => Promise<readonly AggregateWorkspaceSource[]>
}

/** 并发加载多 Host 摘要；单个目标失败只生成该 Host 的错误节点。 */
export class PeerHostAggregateService {
  constructor(private readonly timeoutMs = 5_000) {}

  async load(sources: readonly AggregateHostSource[]): Promise<readonly AggregateHostResult[]> {
    return Promise.all(sources.map((source) => this.loadOne(source)))
  }

  private async loadOne(source: AggregateHostSource): Promise<AggregateHostResult> {
    try {
      const workspaces = await withTimeout(source.load(), this.timeoutMs)
      return {
        hostId: source.hostId,
        targetHostId: source.targetHostId,
        hostLabel: source.hostLabel,
        availability: 'ready',
        errorCode: null,
        workspaces: workspaces.map((workspace) => toWorkspace(source, workspace)),
      }
    } catch (error) {
      return {
        hostId: source.hostId,
        targetHostId: source.targetHostId,
        hostLabel: source.hostLabel,
        availability: 'unreachable',
        errorCode: 'PEER_HOST_UNREACHABLE',
        workspaces: [],
      }
    }
  }
}

function toWorkspace(source: AggregateHostSource, workspace: AggregateWorkspaceSource): AggregateWorkspaceSummary {
  return {
    key: `${source.hostId}:${workspace.workspaceId}`,
    hostId: source.hostId,
    targetHostId: source.targetHostId,
    workspaceId: workspace.workspaceId,
    displayName: workspace.displayName,
    hostLabel: source.hostLabel,
    availability: 'ready',
    sessions: workspace.sessions.map((session): PeerHostSessionRecord => ({
      scope: {
        hostId: source.hostId,
        targetHostId: source.targetHostId,
        workspaceId: workspace.workspaceId,
        sessionId: session.sessionId,
        scopeGeneration: 0,
      },
      title: session.title,
      status: session.status,
      updatedAt: session.updatedAt,
    })),
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('摘要超时时间必须为正数')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('PeerHost 摘要超时')), timeoutMs) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
