/** 登录保护会话只放在当前浏览器标签页，关闭标签页即失效。 */
export const LOGIN_PROTECTION_SESSION_KEY = 'codingns4dsh.login-protection.relay-token'
export const LOGIN_PROTECTION_SESSION_EVENT = 'codingns4dsh-login-protection-session'
let memoryToken: string | undefined

export function readLoginProtectionSession(): string | undefined {
  try {
    const value = globalThis.sessionStorage.getItem(LOGIN_PROTECTION_SESSION_KEY)?.trim()
    return value === undefined || value === '' ? memoryToken : value
  } catch { return memoryToken }
}

/** 读取当前中继票据的过期时间；票据格式无效时返回 null。 */
export function readLoginProtectionSessionExpiresAt(): number | null {
  const token = readLoginProtectionSession()
  if (token === undefined) return null
  try {
    const encoded = token.split('.', 1)[0]
    if (encoded === undefined) return null
    const padded = encoded.replace(/-/gu, '+').replace(/_/gu, '/')
    const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)))) as { expiresAt?: unknown }
    return typeof payload.expiresAt === 'number' && Number.isFinite(payload.expiresAt) ? payload.expiresAt : null
  } catch {
    return null
  }
}

export function writeLoginProtectionSession(token: string | undefined): void {
  memoryToken = token === undefined || token === '' ? undefined : token
  try {
    if (memoryToken === undefined) globalThis.sessionStorage.removeItem(LOGIN_PROTECTION_SESSION_KEY)
    else globalThis.sessionStorage.setItem(LOGIN_PROTECTION_SESSION_KEY, memoryToken)
  } catch { /* 浏览器隐私模式禁用存储时，使用当前页面内存中的票据。 */ }
  globalThis.dispatchEvent(new Event(LOGIN_PROTECTION_SESSION_EVENT))
}
