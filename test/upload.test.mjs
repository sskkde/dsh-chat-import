import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'
import { createUploadHandler, jsonlSafeName } from '../lib/upload.mjs'

function makeReq(body) {
  const data = Buffer.from(JSON.stringify(body))
  return {
    method: 'POST',
    [Symbol.asyncIterator]() {
      let done = false
      return {
        next: () => {
          if (done) return Promise.resolve({ done: true })
          done = true
          return Promise.resolve({ done: false, value: data })
        },
      }
    },
  }
}

function makeRes() {
  const res = { status: 0, payload: '' }
  res.writeHead = (status) => { res.status = status }
  res.end = (text) => { res.payload = text }
  return res
}

test('jsonlSafeName 拒绝路径与危险文件名', () => {
  assert.equal(jsonlSafeName('../a.jsonl'), null)
  assert.equal(jsonlSafeName('a/b.jsonl'), null)
  assert.equal(jsonlSafeName('ok.jsonl'), 'ok.jsonl')
  assert.equal(jsonlSafeName('a.json'), null)
})

test('upload route 分块写入并 finish 到 .dsh-import-uploads 回退目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-upload-test-'))
  const fallback = join(root, 'uploads')
  const ctx = { get: () => undefined }
  const handler = createUploadHandler(ctx, fallback)
  const bytes = Buffer.from('{"type":"session"}\n{"type":"turn/start","seq":0,"data":{"turn":1}}\n')
  const first = bytes.subarray(0, 20)
  const second = bytes.subarray(20)
  const transferId = 'test-transfer-0001'
  const name = 'session.jsonl'
  try {
    let res = makeRes()
    await handler(makeReq({ mode: 'chunk', transferId, name, offset: 0, total: bytes.length, data: first.toString('base64') }), res)
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.payload).received, first.length)

    res = makeRes()
    await handler(makeReq({ mode: 'chunk', transferId, name, offset: first.length, total: bytes.length, data: second.toString('base64') }), res)
    assert.equal(JSON.parse(res.payload).received, bytes.length)

    res = makeRes()
    await handler(makeReq({ mode: 'finish', transferId, name, total: bytes.length }), res)
    assert.equal(res.status, 200)
    const out = JSON.parse(res.payload)
    assert.equal(out.status, 'written')
    assert.equal(out.bytes, bytes.length)
    assert.equal(await readFile(out.path, 'utf8'), bytes.toString('utf8'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('upload route 拒绝非 jsonl 文件名与乱序分块', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-upload-test-'))
  const handler = createUploadHandler({ get: () => undefined }, join(root, 'uploads'))
  try {
    let res = makeRes()
    await handler(makeReq({ mode: 'chunk', transferId: 'bad-name-0001', name: 'evil.txt', offset: 0, data: 'YQ==' }), res)
    assert.equal(res.status, 400)

    res = makeRes()
    await handler(makeReq({ mode: 'chunk', transferId: 'out-of-order-1', name: 'ok.jsonl', offset: 10, data: 'YQ==' }), res)
    assert.equal(res.status, 409)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
