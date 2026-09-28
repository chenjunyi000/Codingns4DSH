import type { AggregateHostResult, AggregateWorkspaceSummary, PeerHostSessionRecord } from '../shared/contracts/peer-host.js'

export interface HostNavigationSessionItem {
  readonly key: string
  readonly sessionId: string
  readonly title: string
  readonly status: string
  readonly scope: PeerHostSessionRecord['scope']
}

export interface HostNavigationWorkspaceItem {
  readonly key: string
  readonly workspaceId: string
  readonly label: string
  readonly hostLabel: string
  readonly availability: AggregateWorkspaceSummary['availability']
  readonly sessions: readonly HostNavigationSessionItem[]
}

export interface HostNavigationHostItem {
  readonly key: string
  readonly hostId: string
  readonly targetHostId: string | null
  readonly label: string
  readonly availability: AggregateHostResult['availability']
  readonly errorCode: AggregateHostResult['errorCode']
  readonly workspaces: readonly HostNavigationWorkspaceItem[]
}

/** 将聚合 DTO 转成原生导航可消费的数据；标签不参与资源身份。 */
export function buildHostNavigation(results: readonly AggregateHostResult[]): readonly HostNavigationHostItem[] {
  return results.map((host) => ({
    key: hostKey(host.hostId, host.targetHostId),
    hostId: host.hostId,
    targetHostId: host.targetHostId,
    label: host.hostLabel,
    availability: host.availability,
    errorCode: host.errorCode,
    workspaces: host.workspaces.map((workspace) => ({
      key: workspace.key,
      workspaceId: workspace.workspaceId,
      label: `${workspace.displayName} (${workspace.hostLabel})`,
      hostLabel: workspace.hostLabel,
      availability: workspace.availability,
      sessions: workspace.sessions.map((session) => ({
        key: `${workspace.key}:${session.scope.sessionId ?? 'none'}`,
        sessionId: session.scope.sessionId ?? '',
        title: session.title,
        status: session.status,
        scope: session.scope,
      })),
    })),
  }))
}

export function hostKey(hostId: string, targetHostId: string | null): string {
  return `${hostId}:${targetHostId ?? 'current'}`
}
