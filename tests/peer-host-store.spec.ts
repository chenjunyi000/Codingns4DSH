import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  EncryptedFilePeerHostCredentialStore,
  FilePeerHostRecordStore,
  InMemoryPeerHostCredentialStore,
  InMemoryPeerHostRecordStore,
  PeerHostStore,
  PeerHostStoreError,
} from '../data/build/dist/host/modules/peer-host/peer-host-store.js'

test('PeerHostStore 规范化局域网地址并拒绝重复目标', async () => {
  const credentials = new InMemoryPeerHostCredentialStore()
  const store = new PeerHostStore('user-1', new InMemoryPeerHostRecordStore(), credentials, () => 100, () => 'peer-1')
  const created = await store.create({ displayName: '开发机', route: { kind: 'lan', baseUrl: 'HTTP://192.168.1.20:13080/' , normalizedOrigin: '' } })
  assert.equal(created.route.kind, 'lan')
  assert.equal(created.route.normalizedOrigin, 'http://192.168.1.20:13080')
  await assert.rejects(
    store.create({ displayName: '重复', route: { kind: 'lan', baseUrl: 'http://192.168.1.20:13080', normalizedOrigin: '' } }),
    (error) => error instanceof PeerHostStoreError && error.code === 'PEER_HOST_DUPLICATE',
  )
})

test('PeerHost 路由变化和删除会清理 Host 侧目标凭据', async () => {
  const credentials = new InMemoryPeerHostCredentialStore()
  const store = new PeerHostStore('user-1', new InMemoryPeerHostRecordStore(), credentials, () => 100, () => 'peer-1')
  await store.create({ displayName: '开发机', route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: '' } })
  await credentials.write('peer-1', { accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: 200 })
  await store.update('peer-1', { route: { kind: 'lan', baseUrl: 'https://127.0.0.1:13080', normalizedOrigin: '' } })
  assert.equal(await credentials.read('peer-1'), null)
  await credentials.write('peer-1', { accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: 200 })
  await store.remove('peer-1')
  assert.equal(await credentials.read('peer-1'), null)
  assert.deepEqual(await store.list(), [])
})

test('文件记录不包含 token，敏感文件使用 AES-256-GCM', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-peer-host-'))
  const recordPath = join(root, 'records.json')
  const credentialPath = join(root, 'credentials.enc')
  const recordStore = new FilePeerHostRecordStore(recordPath)
  const credentials = new EncryptedFilePeerHostCredentialStore(credentialPath, new Uint8Array(32).fill(7))
  const store = new PeerHostStore('user-1', recordStore, credentials, () => 100, () => 'peer-1')
  await store.create({ displayName: '开发机', route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: '' } })
  await credentials.write('peer-1', { accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: 200 })
  assert.doesNotMatch(await readFile(recordPath, 'utf8'), /access-secret|refresh-secret/u)
  assert.doesNotMatch(await readFile(credentialPath, 'utf8'), /access-secret|refresh-secret/u)
  assert.deepEqual(await credentials.read('peer-1'), { accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: 200 })
})
