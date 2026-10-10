// Pure helpers: finding image paths and image blocks. No `$`, so tests can run them.

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i

const PATH_IN_TEXT = /(?:^|[\s"'`=(:,])((?:~|\.{1,2})?\/?[\w@%+.,~\/-]*\.(?:png|jpe?g|gif|webp|bmp|tiff?))(?=$|[\s"'`),;:])/gim

/** Image-looking paths in a command line or its output, deduplicated, in order. */
export function imagePathsIn(text: string): string[] {
  const found: string[] = []
  for (const m of text.matchAll(PATH_IN_TEXT)) {
    const p = m[1]
    if (p && /[\w-]\.[a-z]+$/i.test(p) && !found.includes(p)) found.push(p)
  }
  return found
}

/** Absolute form of `p`, against `cwd` and `home`. */
export function resolvePath(p: string, cwd: string, home: string): string {
  const abs = p.startsWith('~/') ? home + p.slice(1) : p.startsWith('/') ? p : `${cwd}/${p}`
  const out: string[] = []
  for (const part of abs.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

export type ImageBlock = { data: string; mediaType: string }

/** Every image block in a tool result, whatever its nesting: `{type:'image', data|source.data, mimeType|media_type}`. */
export function imageBlocksIn(value: unknown, found: ImageBlock[] = [], depth = 0): ImageBlock[] {
  if (depth > 8 || value === null || typeof value !== 'object') return found
  if (Array.isArray(value)) {
    for (const v of value) imageBlocksIn(v, found, depth + 1)
    return found
  }
  const o = value as Record<string, unknown>
  if (o.type === 'image') {
    const src = (o.source ?? o) as Record<string, unknown>
    const data = src.data ?? o.data
    const mediaType = src.media_type ?? src.mimeType ?? o.mimeType ?? o.media_type ?? 'image/png'
    if (typeof data === 'string' && data.length > 0) {
      found.push({ data, mediaType: String(mediaType) })
      return found
    }
  }
  for (const v of Object.values(o)) imageBlocksIn(v, found, depth + 1)
  return found
}

/** Width and height from a PNG's header bytes, or null. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: v.getUint32(16), height: v.getUint32(20) }
}

/** Cells for a picture of `w`x`h` px fitted into `cols`x`rows`, cells about twice as tall as wide. */
export function fitCells(w: number, h: number, cols: number, rows: number): { columns: number; rows: number } {
  const clamp = (n: number) => Math.max(1, Math.min(255, Math.round(n)))
  let c = cols
  let r = (c * h) / w / 2
  if (r > rows) {
    r = rows
    c = (r * 2 * w) / h
  }
  return { columns: clamp(c), rows: clamp(r) }
}
