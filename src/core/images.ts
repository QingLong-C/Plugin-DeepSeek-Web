import { record, TokenFreeError } from './errors.js'
import type { ImageRef, InputMessage } from './types.js'

export const imageLimits = Object.freeze({ maxImageBytes: 10 * 1024 * 1024, maxBytes: 20 * 1024 * 1024, maxImages: 10 })
export const fileId = (id: unknown): id is string => typeof id === 'string' && /^file-[A-Za-z0-9_-]{1,128}$/.test(id)
export const fileIds = (ids: unknown): ids is string[] => Array.isArray(ids) && ids.length <= 50 && ids.every(fileId) && new Set(ids).size === ids.length
export function imageRef(value: unknown): ImageRef {
  if (!record(value) || typeof value.attachmentId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.attachmentId)
    || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(value.mediaType))
    || !['bytes', 'width', 'height'].every(k => Number.isSafeInteger(value[k]) && Number(value[k]) > 0)
    || Number(value.bytes) > imageLimits.maxImageBytes || Number(value.width) > 32768 || Number(value.height) > 32768
    || Number(value.width) * Number(value.height) > 100_000_000
    || value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 255 || /[\x00-\x1f/\\]/.test(value.name))) {
    throw new TokenFreeError('图片引用无效或超出限制；单张最多 10 MiB。未发送官网请求。', 'IMAGE_INPUT')
  }
  return { attachmentId: value.attachmentId, mediaType: value.mediaType as ImageRef['mediaType'], bytes: Number(value.bytes), width: Number(value.width), height: Number(value.height),
    ...(typeof value.name === 'string' ? { name: value.name } : {}) }
}
export function imageReferences(messages: readonly InputMessage[]): ImageRef[] {
  const refs = new Map<string, ImageRef>()
  for (const message of messages) for (const block of message.content) {
    if (!record(block) || block.type !== 'image') continue
    const ref = imageRef(block.attachment)
    const previous = refs.get(ref.attachmentId)
    if (previous && (previous.bytes !== ref.bytes || previous.mediaType !== ref.mediaType || previous.width !== ref.width || previous.height !== ref.height)) throw new TokenFreeError('同一图片身份的元数据不一致。', 'IMAGE_INPUT')
    refs.set(ref.attachmentId, ref)
  }
  const images = [...refs.values()]
  if (images.length > imageLimits.maxImages || images.reduce((n, ref) => n + ref.bytes, 0) > imageLimits.maxBytes) throw new TokenFreeError('本次网页请求最多附 10 张图片，合计最多 20 MiB。', 'IMAGE_INPUT')
  return images
}
export function imageMessages(messages: readonly InputMessage[], files: ReadonlyMap<string, string>, referencesOnly = false): InputMessage[] {
  return messages.map(message => ({ ...message, content: message.content.map(block => {
    if (!record(block) || block.type !== 'image') return block
    const ref = imageRef(block.attachment), id = files.get(ref.attachmentId)
    if (referencesOnly) return { type: 'image-reference', attachment_id: ref.attachmentId, name: ref.name, note: 'Protocol-only correction: image bytes are not repeated here. Preserve visual facts in the accepted answer; do not invent image contents.' }
    if (!fileId(id)) throw new TokenFreeError('图片尚未上传完成；未发送生成请求。', 'IMAGE_NOT_READY')
    return { type: 'image', file_id: id, attachment_id: ref.attachmentId, name: ref.name, width: ref.width, height: ref.height }
  }) }))
}
