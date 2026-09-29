import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('0.2 能力矩阵不再保留已退休的旧路由', async () => {
  const matrix = await readFile(new URL('../src/dsh-capabilities/matrix.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(matrix, /'no-peer-context'/u)
  assert.match(matrix, /'connection-peer-admission-020'/u)
  assert.match(matrix, /'session-format-v4'/u)
  assert.match(matrix, /'agent-team-native-020'/u)
})

test('能力报告和退休脚本不应写入秘密配置字段', async () => {
  const report = await readFile(new URL('../docs/生成报告/20260925-能力路由报告.md', import.meta.url), 'utf8')
  assert.doesNotMatch(report, /token|password|secret|credential/iu)
})
