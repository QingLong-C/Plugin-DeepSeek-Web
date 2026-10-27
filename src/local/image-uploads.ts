import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { record, TokenFreeError } from '../core/errors.js'
import { fileId, imageRef } from '../core/images.js'
import type { ImageRef, WebFile, WebTransport } from '../core/types.js'
import { readJson, writeJson } from './files.js'
import type { RequestLease } from './request-gate.js'
import { digest } from './store.js'

interface UploadState { version: 1; accountKey: string; imageHash: string; thinking: boolean; stage: 'submitting' | 'processing' | 'ready'; fileId?: string }
function valid(state: unknown, accountKey: string, ref: ImageRef, thinking: boolean): state is UploadState {
  return record(state) && state.version === 1 && state.accountKey === accountKey && state.imageHash === ref.attachmentId && state.thinking === thinking
    && (state.stage === 'submitting' ? state.fileId === undefined : ['processing', 'ready'].includes(String(state.stage)) && fileId(state.fileId))
}
function matchesType(data: Uint8Array, type: ImageRef['mediaType']) {
  const b = Buffer.from(data)
  return type === 'image/png' ? b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : type === 'image/jpeg' ? b[0] === 255 && b[1] === 216 && b[2] === 255
      : type === 'image/gif' ? ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('ascii'))
        : b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP'
}

/** Called only while the account lease is held. Journals contain ids, never image bytes. */
export async function prepareImages(home: string, accountKey: string, refs: readonly ImageRef[], thinking: boolean, client: WebTransport,
  readImage: ((ref: ImageRef, signal: AbortSignal) => Promise<Uint8Array>) | undefined, lease: RequestLease, signal: AbortSignal): Promise<Map<string, string>> {
  const output = new Map<string, string>()
  if (!refs.length) return output
  if (!/^[a-f0-9]{64}$/.test(accountKey) || !readImage || !client.uploadImage || !client.files) throw new TokenFreeError('当前宿主未提供完整图片附件通道；未发送图片。', 'IMAGE_UNAVAILABLE')
  // Validate the complete batch locally before the first upload, avoiding partial invalid batches.
  const images: { ref: ImageRef; data: Uint8Array; path: string; state?: UploadState }[] = []
  for (const item of refs) {
    signal.throwIfAborted()
    const ref = imageRef(item)
    const data = await readImage(ref, signal)
    if (!(data instanceof Uint8Array) || data.byteLength !== ref.bytes || createHash('sha256').update(data).digest('hex') !== ref.attachmentId || !matchesType(data, ref.mediaType)) throw new TokenFreeError('图片字节与宿主附件身份不一致；未上传。', 'IMAGE_INPUT')
    const path = join(home, 'image-uploads', accountKey, digest([ref.attachmentId, ref.mediaType, thinking]) + '.json')
    const state = await readJson<unknown>(path)
    if (state !== undefined && !valid(state, accountKey, ref, thinking)) throw new TokenFreeError('图片上传记录损坏，已保留原记录。', 'STATE_STORAGE')
    if (state?.stage === 'submitting') throw new TokenFreeError(`上次图片上传结果不确定，未重复上传。核对官网后可移走此记录再手动重试：${path}`, 'IMAGE_UPLOAD_UNCERTAIN')
    images.push({ ref, data, path, state })
  }
  const cached = images.filter(image => image.state?.fileId)
  const readyIds = new Set<string>()
  if (cached.length) {
    const found = new Map((await client.files(cached.map(image => image.state!.fileId!), signal)).map(file => [file.id, file]))
    for (const image of cached) {
      const file = found.get(image.state!.fileId!)
      if (!file) throw new TokenFreeError(`官网暂未找到已上传图片，未自动重传。核对官网后可移走此记录再手动重试：${image.path}`, 'IMAGE_NOT_READY')
      if (file.status === 'FAILED') throw new TokenFreeError('官网未接受或无法处理该图片；未自动重传。', 'IMAGE_REJECTED')
      if (file.status === 'SUCCESS') readyIds.add(file.id)
    }
  }
  for (const image of images) {
    if (image.state) continue
    await lease.submission(signal)
    const pending: UploadState = { version: 1, accountKey, imageHash: image.ref.attachmentId, thinking, stage: 'submitting' }
    await writeJson(image.path, pending)
    let file: WebFile
    try { file = await client.uploadImage(image, thinking, signal) }
    catch (error) {
      // Only explicit evidence of non-acceptance permits a later manual retry.
      if (error instanceof TokenFreeError && error.details?.accepted === false) await rm(image.path)
      throw error
    }
    image.state = { ...pending, stage: 'processing', fileId: file.id }
    await writeJson(image.path, image.state)
    if (file.status === 'FAILED') throw new TokenFreeError('官网图片处理失败；未自动重传。', 'IMAGE_REJECTED')
  }
  for (let observation = 0; observation < 31; observation++) {
    signal.throwIfAborted()
    const pending = images.filter(image => !readyIds.has(image.state!.fileId!))
    const files = new Map((pending.length ? await client.files(pending.map(image => image.state!.fileId!), signal) : []).map(file => [file.id, file]))
    for (const image of pending) {
      const file = files.get(image.state!.fileId!)
      if (!file) throw new TokenFreeError('官网未返回已上传的图片；保留记录，未重传。', 'IMAGE_NOT_READY')
      if (file.status === 'FAILED') throw new TokenFreeError('官网图片处理失败；未自动重传。', 'IMAGE_REJECTED')
      if (file.status === 'SUCCESS') readyIds.add(file.id)
    }
    if (readyIds.size === images.length) {
      for (const image of images) {
        if (image.state!.stage !== 'ready') await writeJson(image.path, { ...image.state!, stage: 'ready' })
        output.set(image.ref.attachmentId, image.state!.fileId!)
      }
      return output
    }
    if (observation < 30) await delay(2000, undefined, { signal })
  }
  throw new TokenFreeError('官网图片仍在处理中；记录已保存，下次继续查询，不重新上传。', 'IMAGE_NOT_READY')
}
