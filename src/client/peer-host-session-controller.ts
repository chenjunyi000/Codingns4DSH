import type { HostScope } from '../shared/contracts/peer-host.js'
import { HostRouter, type HostRouterInput } from './host-router.js'
import type {
  PeerHostEventListener,
  PeerHostEventSocketFactory,
  PeerHostEventSubscription,
  PeerHostEventStreamOptions,
  PeerHostProxyResponse,
  PeerHostScopedClient,
} from './peer-host-scoped-client.js'

/**
 * 远端会话的唯一 Client 入口。
 *
 * 控制器不保存目标凭据，只保存当前 HostScope；所有异步结果在提交前再次
 * 校验 generation，避免切换工作区或会话后旧请求回写新页面。
 */
export class PeerHostSessionController {
  constructor(
    private readonly router: HostRouter,
    private readonly client: PeerHostScopedClient,
  ) {}

  async select(input: HostRouterInput): Promise<HostScope> {
    return this.router.switchTo(input)
  }

  current(): HostScope | null {
    return this.router.getCurrent()
  }

  /**
   * Host 侧重连成功后重建同一逻辑作用域。
   * `HostRouter.rebuild` 会先清理旧订阅，再递增 generation；摘要刷新回调只能使用新作用域。
   */
  async rebuildAfterReconnect(scope: HostScope, refreshSummary?: (nextScope: HostScope) => Promise<void> | void): Promise<HostScope> {
    this.assertCurrent(scope)
    const nextScope = await this.router.rebuild({
      hostId: scope.hostId,
      targetHostId: scope.targetHostId,
      workspaceId: scope.workspaceId,
      sessionId: scope.sessionId,
    })
    if (refreshSummary !== undefined) {
      this.assertCurrent(nextScope)
      await refreshSummary(nextScope)
      this.assertCurrent(nextScope)
    }
    return nextScope
  }

  async loadHistory(scope: HostScope, cursor?: string): Promise<PeerHostProxyResponse> {
    this.assertCurrent(scope)
    const response = await this.client.loadSessionHistory(scope, cursor)
    this.assertCurrent(scope)
    return response
  }

  async sendMessage(scope: HostScope, body: string): Promise<PeerHostProxyResponse> {
    return this.run(scope, () => this.client.sendMessage(scope, body))
  }

  async stop(scope: HostScope): Promise<PeerHostProxyResponse> {
    return this.run(scope, () => this.client.stopSession(scope))
  }

  async replyPermission(scope: HostScope, body: string): Promise<PeerHostProxyResponse> {
    return this.run(scope, () => this.client.replyPermission(scope, body))
  }

  async answerQuestion(scope: HostScope, body: string): Promise<PeerHostProxyResponse> {
    return this.run(scope, () => this.client.answerQuestion(scope, body))
  }

  async subscribe(
    scope: HostScope,
    socketFactory: PeerHostEventSocketFactory,
    listener: PeerHostEventListener,
    options?: PeerHostEventStreamOptions,
  ): Promise<PeerHostEventSubscription> {
    this.assertCurrent(scope)
    const subscription = await this.client.openEventStream(scope, socketFactory, listener, options)
    if (!this.router.isCurrent(scope)) {
      subscription.close()
      throw new Error('PeerHost 作用域已失效')
    }
    const remove = this.router.addDisposer(subscription.close)
    let disposed = false
    const close = (): void => {
      if (disposed) return
      disposed = true
      subscription.close()
      remove()
    }
    return {
      close,
      send: subscription.send,
      terminalInput: subscription.terminalInput,
      terminalResize: subscription.terminalResize,
      terminalClose: subscription.terminalClose,
      rightToolSubscribe: subscription.rightToolSubscribe,
      rightToolRefresh: subscription.rightToolRefresh,
      rightToolClose: subscription.rightToolClose,
    }
  }

  private async run(scope: HostScope, operation: () => Promise<PeerHostProxyResponse>): Promise<PeerHostProxyResponse> {
    this.assertCurrent(scope)
    const response = await operation()
    this.assertCurrent(scope)
    return response
  }

  private assertCurrent(scope: HostScope): void {
    this.router.assertCurrent(scope)
  }
}
