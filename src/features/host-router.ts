import { ResourceScopeStaleError, type ResourceScopeDisposer } from '../shared/contracts/peer-host.js'
import type { HostScope } from '../shared/contracts/peer-host.js'

export type HostRouterInput = Omit<HostScope, 'scopeGeneration'>

/** 统一管理当前 Host/PeerHost 的完整作用域和 generation。 */
export class HostRouter {
  private current: HostScope | null = null
  private generation = 0
  private disposers: Array<{ readonly dispose: ResourceScopeDisposer; active: boolean }> = []
  private transition: Promise<void> = Promise.resolve()

  getCurrent(): HostScope | null { return this.current }

  async switchTo(input: HostRouterInput, disposer?: ResourceScopeDisposer): Promise<HostScope> {
    return this.transitionTo(input, disposer, false)
  }

  /**
   * 重连成功后强制创建新的 generation，即使逻辑 HostScope 没有变化。
   * 旧作用域的所有 disposer 会先执行，调用方必须用返回值重建订阅。
   */
  async rebuild(input: HostRouterInput, disposer?: ResourceScopeDisposer): Promise<HostScope> {
    return this.transitionTo(input, disposer, true)
  }

  private async transitionTo(input: HostRouterInput, disposer: ResourceScopeDisposer | undefined, force: boolean): Promise<HostScope> {
    validateInput(input)
    let result: HostScope | undefined
    const operation = this.transition.then(async () => {
      if (!force && this.current !== null && sameInput(this.current, input)) {
        if (disposer) this.addDisposer(disposer)
        result = this.current
        return
      }
      const previous = this.current
      this.current = null
      const errors = await disposeAll(this.disposers)
      this.disposers = []
      const next: HostScope = Object.freeze({ ...input, scopeGeneration: ++this.generation })
      this.current = next
      if (disposer) this.addDisposer(disposer)
      result = next
      if (errors.length > 0) throw new AggregateError(errors, 'HostScope 清理失败')
      void previous
    })
    this.transition = operation.then(() => undefined, () => undefined)
    return operation.then(() => result!)
  }

  addDisposer(disposer: ResourceScopeDisposer): () => void {
    if (this.current === null) throw new ResourceScopeStaleError('No active HostScope')
    const entry = { dispose: disposer, active: true }
    this.disposers.push(entry)
    return () => { entry.active = false }
  }

  registerAbortController(scope: HostScope, controller: AbortController): () => void {
    this.assertCurrent(scope)
    return this.addDisposer(() => { if (!controller.signal.aborted) controller.abort(new ResourceScopeStaleError()) })
  }

  isCurrent(scope: HostScope | null | undefined): boolean {
    return scope !== null && scope !== undefined && this.current !== null && sameScope(this.current, scope)
  }

  assertCurrent(scope: HostScope): void {
    if (!this.isCurrent(scope)) throw new ResourceScopeStaleError('HostScope 已失效')
  }

  commitIfCurrent<T>(scope: HostScope, write: () => T): T {
    this.assertCurrent(scope)
    return write()
  }

  key(scope: HostScope, resource: string, resourceId = ''): string {
    this.assertCurrent(scope)
    return [scope.hostId, scope.targetHostId ?? 'current', scope.workspaceId, scope.sessionId ?? 'none', resource, resourceId].map(encodeURIComponent).join(':')
  }

  async clear(): Promise<void> {
    const operation = this.transition.then(async () => {
      this.current = null
      const errors = await disposeAll(this.disposers)
      this.disposers = []
      if (errors.length > 0) throw new AggregateError(errors, 'HostScope 清理失败')
    })
    this.transition = operation.then(() => undefined, () => undefined)
    await operation
  }
}

function validateInput(input: HostRouterInput): void {
  if (!input || !text(input.hostId) || !text(input.workspaceId) || (input.targetHostId !== null && !text(input.targetHostId)) || (input.sessionId !== null && !text(input.sessionId))) throw new TypeError('HostScope 输入无效')
}

function text(value: unknown): boolean { return typeof value === 'string' && value.trim() !== '' }

function sameInput(scope: HostScope, input: HostRouterInput): boolean {
  return scope.hostId === input.hostId && scope.targetHostId === input.targetHostId && scope.workspaceId === input.workspaceId && scope.sessionId === input.sessionId
}

function sameScope(left: HostScope, right: HostScope): boolean {
  return sameInput(left, right) && left.scopeGeneration === right.scopeGeneration
}

async function disposeAll(entries: Array<{ readonly dispose: ResourceScopeDisposer; active: boolean }>): Promise<unknown[]> {
  const errors: unknown[] = []
  for (const entry of [...entries].reverse()) {
    if (!entry.active) continue
    entry.active = false
    try { await entry.dispose() } catch (error) { errors.push(error) }
  }
  return errors
}
