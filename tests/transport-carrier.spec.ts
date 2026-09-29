import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createDataChannelCarrier,
  DATA_CHANNEL_FRAGMENT_HEADER_BYTES,
  DATA_CHANNEL_FRAGMENT_PAYLOAD_BYTES,
  DATA_CHANNEL_MAX_MESSAGE_BYTES,
} from '../data/build/dist/transport/index.js'

class FakeChannel {
  readonly label = 'codingns-tunnel'
  readonly readyState = 'open'
  readonly sent: Uint8Array[] = []
  bufferedAmount = 0
  failAboveBytes: number | undefined
  closed = false
  private readonly listeners = new Map<string, Set<(event: Event) => void>>()

  send(data: ArrayBuffer | ArrayBufferView): void {
    const view = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    if (this.failAboveBytes !== undefined && view.byteLength > this.failAboveBytes) {
      throw new Error("Failed to execute 'send' on 'RTCDataChannel': Trying to send message larger than max-message-size")
    }
    this.sent.push(new Uint8Array(view))
  }

  close(): void { this.closed = true }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: Event) => void>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  receive(data: Uint8Array): void {
    for (const listener of this.listeners.get('message') ?? []) listener({ data } as unknown as MessageEvent<Uint8Array>)
  }
}

/** 按指定正文长度手工分片，模拟另一版本（或线上已部署运行时）的发送端。 */
function fragmentsWithPayload(payload: Uint8Array, payloadBytes: number): Uint8Array[] {
  const chunkCount = Math.ceil(payload.byteLength / payloadBytes)
  const result: Uint8Array[] = []
  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * payloadBytes
    const body = payload.subarray(start, Math.min(payload.byteLength, start + payloadBytes))
    const frame = new Uint8Array(DATA_CHANNEL_FRAGMENT_HEADER_BYTES + body.byteLength)
    frame.set([0x44, 0x53, 0x46, 0x01])
    const view = new DataView(frame.buffer)
    view.setUint32(4, 7)
    view.setUint32(8, index)
    view.setUint32(12, chunkCount)
    view.setUint32(16, payload.byteLength)
    frame.set(body, DATA_CHANNEL_FRAGMENT_HEADER_BYTES)
    result.push(frame)
  }
  return result
}

test('DataChannel Carrier 对大消息透明分片并在乱序后重组', async () => {
  const senderChannel = new FakeChannel()
  const receiverChannel = new FakeChannel()
  const sender = createDataChannelCarrier(senderChannel)
  const receiver = createDataChannelCarrier(receiverChannel)
  const received: Uint8Array[] = []
  receiver.subscribe((data) => received.push(data))

  const payload = new Uint8Array(616090)
  for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251
  await sender.send(payload)

  assert.equal(senderChannel.sent.length, Math.ceil(payload.byteLength / DATA_CHANNEL_FRAGMENT_PAYLOAD_BYTES))
  assert.ok(senderChannel.sent.every((chunk) => chunk.byteLength <= DATA_CHANNEL_FRAGMENT_PAYLOAD_BYTES + DATA_CHANNEL_FRAGMENT_HEADER_BYTES))
  assert.ok(senderChannel.sent.every((chunk) => chunk[0] === 0x44 && chunk[1] === 0x53 && chunk[2] === 0x46 && chunk[3] === 0x01))

  for (const chunk of [...senderChannel.sent].reverse()) receiverChannel.receive(chunk)
  assert.equal(received.length, 1)
  assert.deepEqual(received[0], payload)
  await sender.close()
  await receiver.close()
})

test('DataChannel Carrier 对 Relay hello 等小消息保持原始单帧', async () => {
  const channel = new FakeChannel()
  const carrier = createDataChannelCarrier(channel)
  const hello = new Uint8Array([0x52, 0x54, 0x57, 0x01])
  await carrier.send(hello)
  assert.deepEqual(channel.sent, [hello])
  await carrier.close()
})

test('Host 宣告的 SCTP 单消息上限必须容得下整分片', () => {
  // 浏览器按对端 SDP 宣告值限制 RTCDataChannel.send()；若上限等于 64 KiB，
  // 「64 KiB 正文 + 分片头」的整分片就会被浏览器拒绝。
  assert.ok(DATA_CHANNEL_MAX_MESSAGE_BYTES >= DATA_CHANNEL_FRAGMENT_PAYLOAD_BYTES + DATA_CHANNEL_FRAGMENT_HEADER_BYTES)
})

test('DataChannel Carrier 兼容不同分片长度的发送端', async () => {
  // 线上已部署的 H5 运行时按 64 KiB 正文分片，仓库后续版本可能更小；
  // 接收端必须按发送端的统一长度重组，而不是写死自己的常量。
  for (const payloadBytes of [DATA_CHANNEL_FRAGMENT_PAYLOAD_BYTES, DATA_CHANNEL_FRAGMENT_PAYLOAD_BYTES - 20]) {
    const channel = new FakeChannel()
    const receiver = createDataChannelCarrier(channel)
    const received: Uint8Array[] = []
    receiver.subscribe((data) => received.push(data))
    const payload = new Uint8Array(300_000)
    for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 7) % 251
    for (const frame of fragmentsWithPayload(payload, payloadBytes).reverse()) channel.receive(frame)
    assert.equal(received.length, 1, `payload=${String(payloadBytes)}`)
    assert.deepEqual(received[0], payload, `payload=${String(payloadBytes)}`)
    await receiver.close()
  }
})

test('分片重组超时会让 Carrier 失败，而不是静默丢包', async () => {
  const channel = new FakeChannel()
  const carrier = createDataChannelCarrier(channel, { reassemblyTimeoutMs: 5 })
  const closed: (string | undefined)[] = []
  carrier.onClosed((reason) => closed.push(reason))
  const received: Uint8Array[] = []
  carrier.subscribe((data) => received.push(data))

  const payload = new Uint8Array(200_000)
  const frames = fragmentsWithPayload(payload, DATA_CHANNEL_FRAGMENT_PAYLOAD_BYTES)
  channel.receive(frames[0] as Uint8Array)
  await new Promise((resolve) => setTimeout(resolve, 30))

  assert.equal(carrier.state, 'closed')
  assert.equal(received.length, 0)
  assert.match(closed[0] ?? '', /分片重组超时/u)
  assert.equal(channel.closed, true)
})

test('单次发送失败不会让后续发送永久失败', async () => {
  const channel = new FakeChannel()
  const carrier = createDataChannelCarrier(channel)
  const large = new Uint8Array(200_000)
  const small = new Uint8Array([1, 2, 3])

  channel.failAboveBytes = 64 * 1024
  await assert.rejects(carrier.send(large), /larger than max-message-size/u)

  channel.failAboveBytes = undefined
  await carrier.send(small)
  assert.deepEqual(channel.sent.at(-1), small)
  await carrier.close()
})
