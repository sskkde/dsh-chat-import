// lib/upload.mjs — 导入面板的上传路由（POST /api-import/upload）。
// 浏览器把本地会话记录 .jsonl 分块上传到当前会话工作区的 .dsh-import-uploads/，
// 完成后调用 /api-import/import 以 source=local-jsonl 导入。分块默认 640 KiB，
// 适配反向代理常见的 1 MiB body 上限；host 只接受 .jsonl 且按文件名消毒。
import { open, rename, rm, mkdir, stat } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { Buffer } from 'node:buffer'

const ROUTE = '/api-import/upload'
const UPLOAD_SUBDIR = '.dsh-import-uploads'
const MAX_BODY_BYTES = 32 * 1024 * 1024
const MAX_CHUNK_DECODED = 8 * 1024 * 1024
const MAX_TRANSFERS = 16
const TRANSFER_TTL_MS = 30 * 60 * 1000
const TRANSFER_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/
const JSONL_NAME_PATTERN = /^[^\\/:*?"<>|]+\.jsonl$/i

const transfers = new Map()

export function jsonlSafeName(name) {
  if (typeof name !== 'string') return null
  const raw = String(name).replace(/[\u0000-\u001f\u007f]/g, '')
  if (/[\\/]/.test(raw)) return null
  const base = basename(raw)
  if (base === '.' || base === '..' || !JSONL_NAME_PATTERN.test(base)) return null
  return base
}

function validTransferId(value) {
  return typeof value === 'string' && TRANSFER_ID_PATTERN.test(value)
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) {
      const err = new Error('request body too large')
      err.status = 413
      throw err
    }
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function resolveUploadDir(ctx, sessionId, fallbackDir) {
  const registry = ctx.get('workspaceRegistry')
  if (registry !== undefined) {
    try {
      const entities = registry.list()
      if (sessionId !== undefined) {
        for (const entity of entities) {
          if (Array.isArray(entity.sessionIds) && entity.sessionIds.includes(sessionId)) return join(entity.path, UPLOAD_SUBDIR)
        }
      }
      for (const entity of entities) {
        if (entity.path === process.cwd()) return join(entity.path, UPLOAD_SUBDIR)
      }
      if (entities.length > 0) return join(entities[0].path, UPLOAD_SUBDIR)
    } catch {
      // registry 不可用/未初始化 → 回退 registryDir/uploads
    }
  }
  return fallbackDir
}

function dropTransfer(id) {
  const transfer = transfers.get(id)
  if (transfer === undefined) return Promise.resolve()
  transfers.delete(id)
  return (async () => {
    try {
      await transfer.fd?.close()
    } catch {
      // 文件句柄可能已关闭，忽略
    }
    try {
      await rm(transfer.tempPath, { force: true })
    } catch {
      // 清理失败不影响后续请求
    }
  })()
}

function sweepTransfers(now) {
  for (const [id, transfer] of transfers) {
    if (now - transfer.updatedAt > TRANSFER_TTL_MS) dropTransfer(id)
  }
}

async function handleChunk(uploadDir, body) {
  if (!validTransferId(body?.transferId)) return { error: 400, message: 'invalid transferId' }
  const name = jsonlSafeName(body?.name)
  if (name === null) return { error: 400, message: 'invalid file name (only .jsonl allowed)' }
  if (typeof body?.data !== 'string') return { error: 400, message: 'missing chunk data' }
  const offset = Number.isSafeInteger(body?.offset) && body.offset >= 0 ? body.offset : -1
  const total = Number.isSafeInteger(body?.total) && body.total >= 0 ? body.total : undefined
  const buffer = Buffer.from(body.data, 'base64')
  if (buffer.length > MAX_CHUNK_DECODED) return { error: 413, message: 'chunk exceeds the 8 MiB decoded cap' }
  if (buffer.length === 0 && body.data.length > 0) return { error: 400, message: 'invalid base64 data' }
  let transfer = transfers.get(body.transferId)
  if (transfer === undefined) {
    if (transfers.size >= MAX_TRANSFERS) return { error: 429, message: 'too many concurrent uploads' }
    if (offset !== 0) return { error: 409, message: 'first chunk must start at offset 0' }
    await mkdir(uploadDir, { recursive: true })
    const tempPath = join(uploadDir, `.dsh-import-${body.transferId}`)
    const fd = await open(tempPath, 'a')
    transfer = { tempPath, finalName: name, fd, offset: 0, total, updatedAt: Date.now() }
    transfers.set(body.transferId, transfer)
  }
  transfer.updatedAt = Date.now()
  if (transfer.finalName !== name) return { error: 409, message: 'transfer name mismatch' }
  if (offset < transfer.offset) return { result: { received: transfer.offset } }
  if (offset !== transfer.offset) return { error: 409, message: `out-of-order chunk: expected offset ${transfer.offset}` }
  if (transfer.total !== undefined && offset + buffer.length > transfer.total) return { error: 400, message: 'chunk exceeds declared total' }
  if (buffer.length > 0) await transfer.fd.write(buffer)
  transfer.offset += buffer.length
  return { result: { received: transfer.offset } }
}

async function handleFinish(uploadDir, body) {
  if (!validTransferId(body?.transferId)) return { error: 400, message: 'invalid transferId' }
  const name = jsonlSafeName(body?.name)
  if (name === null) return { error: 400, message: 'invalid file name (only .jsonl allowed)' }
  const total = Number.isSafeInteger(body?.total) && body.total >= 0 ? body.total : undefined
  const transfer = transfers.get(body.transferId)
  if (transfer === undefined) return { error: 404, message: 'unknown transfer' }
  if (transfer.finalName !== name) return { error: 409, message: 'transfer name mismatch' }
  try {
    await transfer.fd.close()
  } catch {
    // 已关闭的句柄忽略关闭错误
  }
  transfers.delete(body.transferId)
  if (total !== undefined && transfer.offset < total) {
    await rm(transfer.tempPath, { force: true })
    return { error: 400, message: `incomplete upload: ${transfer.offset}/${total} bytes` }
  }
  await mkdir(uploadDir, { recursive: true })
  const finalPath = join(uploadDir, name)
  const exists = await stat(finalPath).then(() => true, () => false)
  if (exists) {
    await rm(transfer.tempPath, { force: true })
    return { result: { status: 'skipped', path: finalPath, bytes: transfer.offset } }
  }
  await rename(transfer.tempPath, finalPath)
  return { result: { status: 'written', path: finalPath, bytes: transfer.offset } }
}

export function createUploadHandler(ctx, fallbackDir) {
  return async (req, res) => {
    try {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      let payload
      try {
        payload = await readBody(req)
      } catch (err) {
        const status = err && err.status === 413 ? 413 : 400
        return json(res, status, { error: String((err && err.message) || err) })
      }
      sweepTransfers(Date.now())
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : undefined
      const uploadDir = await resolveUploadDir(ctx, sessionId, fallbackDir)
      let outcome
      try {
        if (payload?.mode === 'chunk') outcome = await handleChunk(uploadDir, payload)
        else if (payload?.mode === 'finish') outcome = await handleFinish(uploadDir, payload)
        else if (payload?.mode === 'abort') {
          if (validTransferId(payload.transferId)) await dropTransfer(payload.transferId)
          outcome = { result: { aborted: true } }
        } else {
          outcome = { error: 400, message: 'unsupported upload mode' }
        }
      } catch (err) {
        outcome = { error: 500, message: String((err && err.message) || err) }
      }
      if (outcome.result !== undefined) return json(res, 200, outcome.result)
      return json(res, outcome.error, { error: outcome.message })
    } catch (err) {
      return json(res, 500, { error: String((err && err.message) || err) })
    }
  }
}

export function registerUploadRoute(ctx, ws, fallbackDir) {
  ws.register({
    kind: 'exact',
    path: ROUTE,
    handler: createUploadHandler(ctx, fallbackDir),
  })
}
