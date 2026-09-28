import assert from 'node:assert/strict'
import test from 'node:test'
import { createPeerHostButton } from '../data/build/dist/client/peer-host-connection-button.js'

test('PeerHost 连接管理按钮提供独立可访问名称并可被模块移除', () => {
  const created: any[] = []
  const documentLike = {
    createElement(tag: string) {
      const element = {
        tagName: tag.toUpperCase(),
        style: {} as Record<string, string>,
        setAttribute(name: string, value: string) { (this as any)[name] = value },
        set title(value: string) { this._title = value },
        get title() { return this._title },
        _title: '',
        type: '',
        textContent: '',
      }
      created.push(element)
      return element
    },
  }
  const button = createPeerHostButton(documentLike as never) as any
  assert.equal(button['aria-label'], '管理其他 DSH Host')
  assert.equal(button['data-codingns-peer-host-button'], '')
  assert.equal(button.textContent, 'Host')
})
