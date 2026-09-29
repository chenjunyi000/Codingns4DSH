import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RTCPeerConnection } from 'werift'
import {
  FileHostDtlsIdentityStore,
  createWeriftPeerConnectionFactory,
  formatHostDtlsFingerprint,
  type HostDtlsIdentityMaterial,
} from '../data/build/dist/host/index.js'
import {
  DATA_CHANNEL_FRAGMENT_HEADER_BYTES,
  DATA_CHANNEL_FRAGMENT_PAYLOAD_BYTES,
  DATA_CHANNEL_MAX_MESSAGE_BYTES,
} from '../data/build/dist/transport/index.js'

const identity: HostDtlsIdentityMaterial = {
  privateKeyPem: 'private-key',
  certPem: 'certificate',
  signatureHash: { signature: 3, hash: 4 },
  fingerprint: 'sha-256 AA:BB:CC',
  createdAt: '2026-09-23T00:00:00.000Z',
  updatedAt: '2026-09-23T00:00:00.000Z',
}

test('Host DTLS identity 文件存储可写入并恢复完整材料', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codingns4dsh-'))
  const path = join(directory, 'identity.json')
  const store = new FileHostDtlsIdentityStore(path)
  assert.equal(await store.read(), null)
  await store.write(identity)
  assert.deepEqual(await store.read(), identity)
  const raw = await readFile(path, 'utf8')
  assert.match(raw, /private-key/u)
})

test('Host DTLS fingerprint 统一为 sha-256 大写冒号格式', () => {
  assert.equal(formatHostDtlsFingerprint({
    getFingerprints: () => [{ algorithm: 'SHA-256', value: 'aa:1:b' }],
  }), 'sha-256 AA:01:0B')
})

test('Host answerer 宣告的 SCTP 单消息上限容得下 Carrier 整分片', async () => {
  // 浏览器按对端 SDP 里的 max-message-size 限制 RTCDataChannel.send()。werift 默认
  // 只宣告 64 KiB，会让中继页面发送超过 64 KiB 的消息（设置写入、附件）直接抛错。
  const client = new RTCPeerConnection({ iceServers: [] })
  client.createDataChannel('codingns-tunnel')
  await client.setLocalDescription(await client.createOffer())
  const host = createWeriftPeerConnectionFactory()({
    iceServers: [],
    iceTransportPolicy: 'all',
  })
  try {
    await host.setRemoteDescription({
      type: 'offer',
      sdp: client.localDescription?.sdp ?? '',
    })
    const answer = await host.createAnswer()
    const advertised = (answer.sdp ?? '').match(/a=max-message-size:(\d+)/u)?.[1]
    assert.equal(Number(advertised), DATA_CHANNEL_MAX_MESSAGE_BYTES)
    assert.ok(Number(advertised) >= DATA_CHANNEL_FRAGMENT_PAYLOAD_BYTES + DATA_CHANNEL_FRAGMENT_HEADER_BYTES)
  } finally {
    await client.close()
    host.close()
  }
})
