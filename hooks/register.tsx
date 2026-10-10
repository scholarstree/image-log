import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { ImageEntry } from '../types'
import { IMAGE_EXT, fitCells, imageBlocksIn, imagePathsIn, pngSize, resolvePath } from './detect'

const PANE = 'image-log'
const rev = atom({ plugin: 'image-log', key: 'rev' } as const, 0)
const selected = atom({ plugin: 'image-log', key: 'selected' } as const, null)
const showMissing = atom({ plugin: 'image-log', key: 'showMissing' } as const, false)

const MAX_INLINE_PNG = 2 * 1024 * 1024
const SKIP_INLINE_SCAN = new Set(['Read', 'Bash', 'Write', 'Edit', 'Glob', 'Grep', 'Agent'])

// Shell snippets run through `$.process.run(['sh', '-c', SCRIPT, 'sh', ...args])`.
const APPEND = 'mkdir -p "$HOME/.cache/claude-images" && cat >> "$HOME/.cache/claude-images/log.jsonl"'
const TO_PNG = `src="$1"; out="$2"; [ -s "$out" ] && exit 0; mkdir -p "$(dirname "$out")"
if command -v magick >/dev/null 2>&1; then magick "$src[0]" -resize '1600x1600>' "$out"
elif command -v convert >/dev/null 2>&1; then convert "$src[0]" -resize '1600x1600>' "$out"
elif command -v ffmpeg >/dev/null 2>&1; then ffmpeg -loglevel error -y -i "$src" -frames:v 1 "$out"
else exit 3; fi`
const DECODE = 'mkdir -p "$(dirname "$1")" && base64 -d > "$1"'
// Housekeeping, once per session start: the preview and thumbnail caches each keep the 1000 newest files
// and nothing older than 30 days, pointer files go after 7 days, and the log is cut
// back to its newest 10,000 lines once it passes 20,000. Images themselves are never touched.
const PRUNE = `d="$HOME/.cache/claude-images"; [ -d "$d" ] || exit 0
for c in render thumbs; do
  [ -d "$d/$c" ] || continue
  find "$d/$c" -type f -mtime +30 -delete 2>/dev/null
  ls -1t "$d/$c" | tail -n +1001 | while IFS= read -r f; do rm -f "$d/$c/$f"; done
done
find "$d" -maxdepth 1 -name 'current-*' -mtime +7 -delete 2>/dev/null
log="$d/log.jsonl"
if [ -f "$log" ] && [ "$(wc -l < "$log")" -gt 20000 ]; then
  tail -n 10000 "$log" > "$log.tmp.$$" && mv "$log.tmp.$$" "$log"
fi
exit 0`
// The session's folder of pasted images: <tmp>/claude-<uid>/<project>/<session>/images
const SENT_DIR = 'for d in "${TMPDIR:-/tmp}"/claude-*/*/"$1"/images; do [ -d "$d" ] && printf %s "$d" && exit 0; done; exit 0'
const OPEN = 'p="$1"; if command -v xdg-open >/dev/null 2>&1; then xdg-open "$p"; else open "$p"; fi >/dev/null 2>&1 &'
const FIND_TRANSCRIPT =
  'for f in "$HOME"/.claude/projects/*/"$1".jsonl "$HOME"/.claude/projects/*/"$1"/subagents/*.jsonl; do [ -f "$f" ] && grep -lF "$2" "$f"; done; true'

type Shown = { source: { png: string } | { file: string; format: 'png' }; width: number; height: number } | { error: string }

// Module memory: rebuilt after a reload, which only costs a re-render.
let homeDir: Promise<string> | undefined
const shownCache = new Map<string, Shown>()
let openedThisSession = false
let hostKind: Promise<Host> | undefined
let lastPointer = ''

const sh = ($: EngineInterface, script: string, args: string[], stdin?: string) =>
  $.process.run(['sh', '-c', script, 'sh', ...args], stdin === undefined ? {} : { stdin })

// image-log needs a Unix shell and tools (sh, find, tail) and a terminal with kitty graphics:
// Linux, macOS, BSD, or WSL. On native Windows (no sh) or Git Bash/Cygwin it stays off.
let platformOk: Promise<boolean> | undefined
const supported = ($: EngineInterface) =>
  (platformOk ??= sh($, 'uname -s', [])
    .then(r => r.exitCode === 0 && /^(Linux|Darwin|FreeBSD|OpenBSD|NetBSD)/.test(r.stdout.trim()))
    .catch(() => false))
const UNSUPPORTED = 'image-log needs Linux, macOS or WSL, so it is switched off here. Nothing is logged.'

const home = ($: EngineInterface) =>
  (homeDir ??= sh($, 'printf %s "$HOME"', []).then(r => r.stdout))

const logPath = async ($: EngineInterface) => `${await home($)}/.cache/claude-images/log.jsonl`
const cachePath = async ($: EngineInterface, name: string) => `${await home($)}/.cache/claude-images/render/${name}`

// Where the gallery (bin/imgview) can open beside Claude, leaving Claude's own window alone:
// - herdr: a herdr pane. herdr also cannot pass the Unicode placeholders Claude Code's Image
//   element uses, so there the gallery is the only way to see pictures at all.
// - kitty: a kitty split, through remote control (allow_remote_control + listen_on in kitty.conf,
//   which sets KITTY_LISTEN_ON).
// - none: Claude Code's own Images pane is the fallback.
type Host = 'herdr' | 'kitty' | 'none'
const DETECT_HOST = `if [ "$HERDR_ENV" = 1 ]; then echo herdr
elif [ -n "$KITTY_WINDOW_ID" ] && [ -n "$KITTY_LISTEN_ON" ] && command -v kitty >/dev/null 2>&1; then echo kitty
else echo none; fi`
const galleryHost = ($: EngineInterface) =>
  (hostKind ??= sh($, DETECT_HOST, []).then(r => r.stdout.trim() as Host))

const pointerFile = async ($: EngineInterface, sessionId: string) =>
  `${await home($)}/.cache/claude-images/current-${sessionId}`

/** Point the gallery at `path`. */
async function writePointer($: EngineInterface, sessionId: string, path: string) {
  if (path === lastPointer) return
  lastPointer = path
  await sh($, 'mkdir -p "$(dirname "$1")" && printf %s "$2" > "$1"', [await pointerFile($, sessionId), path])
}

const HERDR_SPLIT = 'herdr pane split --current --direction right --no-focus'
// kitty honours --location=vsplit only in its "splits" layout; other layouts place new windows
// themselves (the default "fat" puts them below). The tab's layout and windows, as JSON:
const KITTY_TAB = 'kitty @ --to "$KITTY_LISTEN_ON" ls --match-tab "window_id:$KITTY_WINDOW_ID"; printf "\\n%s" "$KITTY_WINDOW_ID"'
const KITTY_SPLITS = 'kitty @ --to "$KITTY_LISTEN_ON" goto-layout --match "window_id:$KITTY_WINDOW_ID" splits'
const KITTY_ALIVE = 'kitty @ --to "$KITTY_LISTEN_ON" ls --match "id:$1" >/dev/null 2>&1'
const KITTY_LAUNCH =
  'exec kitty @ --to "$KITTY_LISTEN_ON" launch --location=vsplit --keep-focus --next-to "id:$KITTY_WINDOW_ID" --title image-log --cwd "$PWD" "$@"'
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * Put Claude's kitty tab in the "splits" layout so the gallery opens to the side, but only while
 * Claude's window is alone there: one window looks the same in any layout, whereas switching a
 * tab that holds others would rearrange them.
 */
async function useSplitsLayout($: EngineInterface) {
  const out = (await sh($, KITTY_TAB, [])).stdout
  const cut = out.lastIndexOf('\n')
  const myId = Number(out.slice(cut + 1))
  type Tab = { layout: string; windows: { id: number }[] }
  const tabs = (JSON.parse(out.slice(0, cut)) as { tabs: Tab[] }[]).flatMap(o => o.tabs)
  const tab = tabs.find(t => t.windows.some(win => win.id === myId))
  if (tab && tab.layout !== 'splits' && tab.windows.length === 1) await sh($, KITTY_SPLITS, [])
}

/** The gallery for this session beside Claude (a herdr pane or a kitty split), opened once and reused. */
async function ensureGallery($: EngineInterface, sessionId: string) {
  const host = await galleryHost($)
  if (host === 'none') return
  const key = `${host}Pane:${sessionId}`
  const known = (await $.store.get(key)) as string | undefined
  const argv = ['python3', `${$.plugin.root}/bin/imgview`, '--pointer', await pointerFile($, sessionId), '--session', sessionId]
  if (host === 'kitty') {
    if (known && (await sh($, KITTY_ALIVE, [known])).exitCode === 0) return
    await useSplitsLayout($)
    const launched = await sh($, KITTY_LAUNCH, argv)
    const windowId = launched.stdout.trim()
    if (launched.exitCode !== 0 || !windowId) throw new Error(`kitty split failed: ${launched.stderr.trim()}`)
    await $.store.set(key, windowId)
    return
  }
  if (known && (await sh($, 'herdr pane get "$1" >/dev/null 2>&1', [known])).exitCode === 0) return
  const split = await sh($, HERDR_SPLIT, [])
  const paneId = (JSON.parse(split.stdout) as { result?: { pane?: { pane_id?: string } } }).result?.pane?.pane_id
  if (!paneId) throw new Error(`herdr split failed: ${split.stderr.trim()}`)
  await $.store.set(key, paneId)
  // exec: quitting the gallery (q or its ✕) ends the pane's shell, so herdr closes the pane
  await sh($, 'herdr pane run "$1" "$2" >/dev/null', [paneId, `exec ${argv.map(quote).join(' ')}`])
}

async function readLog($: EngineInterface): Promise<ImageEntry[]> {
  let text = ''
  try {
    text = await $.fs.read(await logPath($))
  } catch {
    return []
  }
  const out: ImageEntry[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as ImageEntry)
    } catch {}
  }
  return out
}

async function appendLog($: EngineInterface, entries: ImageEntry[]) {
  if (entries.length === 0) return
  await sh($, APPEND, [], entries.map(x => JSON.stringify(x) + '\n').join(''))
  await update($, rev, n => (n ?? 0) + 1)
}

async function statFile($: EngineInterface, path: string) {
  try {
    const st = await $.fs.stat(path)
    return st.kind === 'file' ? st : undefined
  } catch {
    return undefined
  }
}

type OpenOn = 'any' | 'claude' | 'never'
const OPEN_ON: OpenOn[] = ['any', 'claude', 'never']

type Found = Omit<ImageEntry, 'id' | 'time' | 'tool' | 'toolUseId' | 'sessionId' | 'project' | 'agentId'>

/** The images one finished tool call produced, as log entries. */
async function findImages(
  $: EngineInterface,
  tool: string,
  input: Record<string, unknown>,
  result: unknown,
  started: number,
  includeReads: boolean,
): Promise<Omit<ImageEntry, 'id' | 'time' | 'tool' | 'toolUseId' | 'sessionId' | 'project' | 'agentId'>[]> {
  const found: Awaited<ReturnType<typeof findImages>> = []
  const fileEntry = async (path: string, via: ImageEntry['via'], freshOnly: boolean) => {
    const st = await statFile($, path)
    if (!st || (freshOnly && st.mtimeMs < started - 2000)) return
    if (found.some(f => f.path === path)) return
    found.push({ kind: 'file', path, size: st.size, mtimeMs: st.mtimeMs, via })
  }

  if (tool === 'Write' && typeof input.file_path === 'string' && IMAGE_EXT.test(input.file_path)) {
    await fileEntry(input.file_path, 'write', false)
  } else if (tool === 'Read' && includeReads && typeof input.file_path === 'string' && IMAGE_EXT.test(input.file_path)) {
    await fileEntry(input.file_path, 'read', false)
  } else if (tool === 'Bash' && typeof input.command === 'string') {
    const r = (result ?? {}) as { stdout?: string; stderr?: string; backgroundTaskId?: string }
    if (r.backgroundTaskId) return found
    const cwd = await $.session.cwd()
    const h = await home($)
    const text = `${input.command}\n${r.stdout ?? ''}\n${r.stderr ?? ''}`
    for (const p of imagePathsIn(text).slice(0, 50)) await fileEntry(resolvePath(p, cwd, h), 'bash', true)
  }

  if (!SKIP_INLINE_SCAN.has(tool)) {
    imageBlocksIn(result).forEach((b, i) =>
      found.push({ kind: 'inline', mediaType: b.mediaType, blockIndex: i, via: 'returned' }),
    )
  }
  return found
}

/** Base64 of the image block an inline entry points at, read back from its session transcript. */
async function inlineData($: EngineInterface, x: ImageEntry): Promise<{ data: string; mediaType: string } | undefined> {
  const files = (await sh($, FIND_TRANSCRIPT, [x.sessionId, x.toolUseId])).stdout.split('\n').filter(Boolean)
  for (const f of files) {
    const text = await $.fs.read(f)
    for (const line of text.split('\n')) {
      if (!line.includes(x.toolUseId) || !line.includes('tool_result')) continue
      try {
        const blocks = imageBlocksIn(JSON.parse(line))
        const b = blocks[x.blockIndex ?? 0] ?? blocks[0]
        if (b) return b
      } catch {}
    }
  }
  return undefined
}

/** A file path on disk for an entry: the file itself, or the inline image decoded into the render cache. */
async function diskPath($: EngineInterface, x: ImageEntry): Promise<string | undefined> {
  if (x.kind === 'file') return x.path
  const b = await inlineData($, x)
  if (!b) return undefined
  const ext = (b.mediaType.split('/')[1] ?? 'png').replace('jpeg', 'jpg')
  const out = await cachePath($, `${x.id}.${ext}`)
  if (!(await statFile($, out))) await sh($, DECODE, [out], b.data)
  return out
}

/** What the pane draws for an entry, made once per entry and file version. */
async function shown($: EngineInterface, x: ImageEntry, mtimeMs: number | undefined): Promise<Shown> {
  const key = `${x.id}:${mtimeMs ?? ''}`
  const hit = shownCache.get(key)
  if (hit) return hit
  const made = await makeShown($, x, key).catch(err => ({ error: String(err) }))
  shownCache.set(key, made)
  return made
}

async function makeShown($: EngineInterface, x: ImageEntry, key: string): Promise<Shown> {
  const fromPngBase64 = (b64: string): Shown => {
    const head = Uint8Array.from(atob(b64.slice(0, 44)), c => c.charCodeAt(0))
    const size = pngSize(head)
    return size ? { source: { png: b64 }, ...size } : { error: 'not a PNG' }
  }
  if (x.kind === 'inline') {
    const b = await inlineData($, x)
    if (!b) return { error: 'gone from the transcript' }
    if (b.mediaType === 'image/png' && b.data.length * 0.75 <= MAX_INLINE_PNG) return fromPngBase64(b.data)
  } else if (x.path && /\.png$/i.test(x.path) && (x.size ?? 0) <= MAX_INLINE_PNG) {
    const { base64 } = await $.fs.read(x.path, { as: 'bytes' })
    if (base64.length * 0.75 <= MAX_INLINE_PNG) return fromPngBase64(base64)
  }
  // Anything else: a downsized PNG in the render cache, made by ImageMagick or ffmpeg.
  const src = await diskPath($, x)
  if (!src) return { error: 'source unavailable' }
  const out = await cachePath($, `${key.replace(/[^\w.-]/g, '_')}.png`)
  const r = await sh($, TO_PNG, [src, out])
  if (r.exitCode === 3) return { error: 'install ImageMagick to preview this format' }
  if (r.exitCode !== 0) return { error: r.stderr.trim().split('\n')[0] || 'conversion failed' }
  const { base64 } = await $.fs.read(out, { as: 'bytes' })
  return base64.length * 0.75 <= MAX_INLINE_PNG ? fromPngBase64(base64) : { error: 'too large to preview' }
}

/** Log what was found and bring it into view: the herdr gallery, or Claude's Images pane. */
async function record(
  $: EngineInterface,
  found: Found[],
  meta: { tool: string; toolUseId: string; agentId?: string },
  opts: { galleryPane: boolean; openOn: OpenOn },
) {
  // Whether a closed gallery opens for these: any image, only Claude's, or only on /image-log.
  const opens = opts.openOn === 'any' || (opts.openOn === 'claude' && meta.tool !== 'You')
  const [sessionId, project] = await Promise.all([$.session.id(), $.session.root()])
  const now = Date.now()
  await appendLog(
    $,
    found.map((f, i) => ({
      ...f,
      id: `${now.toString(36)}-${i}-${Math.random().toString(36).slice(2, 7)}`,
      // An image you sent sits in the timeline where you pasted it, not where it was noticed.
      time: f.via === 'sent' && f.mtimeMs ? Math.round(f.mtimeMs) : now,
      tool: meta.tool,
      toolUseId: meta.toolUseId,
      sessionId,
      project,
      ...(meta.agentId ? { agentId: meta.agentId } : {}),
    })),
  )
  // A new image takes the view back to the newest, as a viewer following along would.
  await update($, selected, () => null)
  if (opts.galleryPane && (await galleryHost($)) !== 'none') {
    const newest = found[found.length - 1]
    const path = newest?.kind === 'file' ? newest.path : undefined
    if (path) await writePointer($, sessionId, path)
    if (opens) await ensureGallery($, sessionId)
  } else if (opens && !openedThisSession) {
    openedThisSession = true
    void $.ui.open({ id: PANE, title: 'Images' })
  }
}

const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`
}
const base = (p: string) => p.split('/').pop() ?? p
const label = (x: ImageEntry) => (x.kind === 'file' && x.path ? base(x.path) : `${x.tool.replace(/^mcp__/, '')} #${(x.blockIndex ?? 0) + 1}`)
const agentLabel = (x: ImageEntry) => (x.agentId ? `agent ${x.agentId.slice(0, 8)}` : 'main')

export const register: Register = (on, options) => {
  const openOn: OpenOn = OPEN_ON.includes(options.openOn as OpenOn) ? (options.openOn as OpenOn) : 'claude'
  const includeReads = options.includeReads !== false
  const galleryPane = options.galleryPane !== false
  const includeSent = options.includeSent !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'image-log', description: "Show this session's images in a gallery beside Claude" })
    if (!(await supported($))) {
      // Say so once per machine, not every session.
      if (!(await $.store.get('unsupportedNoticeShown'))) {
        await $.store.set('unsupportedNoticeShown', true)
        $.ui.log(UNSUPPORTED)
      }
      return next(e)
    }
    void sh($, PRUNE, []).catch(() => undefined)
    // Inside herdr the gallery is a herdr pane; Claude's own pane is left untouched.
    if (galleryPane && (await galleryHost($)) !== 'none') await $.ui.close({ id: PANE }).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'image-log' }, async $ => {
    if (!(await supported($))) return { text: UNSUPPORTED }
    if (galleryPane && (await galleryHost($)) !== 'none') {
      await ensureGallery($, await $.session.id())
      return { text: 'Gallery opened beside Claude.' }
    }
    await $.ui.open({ id: PANE, title: 'Images', focus: true })
    return { text: 'Images pane opened.' }
  })

  on('tool.call', async ($, e, next) => {
    const started = Date.now()
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true || !(await supported($))) return ran
    try {
      const input = e as unknown as Record<string, unknown>
      const found = await findImages($, e.tool, input, ran.result, started, includeReads)
      if (found.length > 0) {
        await record($, found, { tool: e.tool, toolUseId: e.tool_use_id ?? '', agentId: e.agentId }, { galleryPane, openOn })
      }
    } catch (err) {
      $.ui.log(`image-log: ${String(err)}`)
    }
    return ran
  }).catch(($, e, next) => next(e))

  // Images you paste or drop into the prompt: Claude Code saves each one in the session's
  // own images/ folder, so every file there is one you sent. Log the ones not logged yet.
  on('prompt.submit', async ($, e, next) => {
    const ran = await next(e)
    if (!includeSent || !e.attachments?.some(a => a.type === 'image') || !(await supported($))) return ran
    try {
      const sessionId = await $.session.id()
      const dir = (await sh($, SENT_DIR, [sessionId])).stdout.trim()
      if (!dir) return ran
      const logged = new Set((await readLog($)).filter(x => x.sessionId === sessionId && x.via === 'sent').map(x => x.path))
      const found: Found[] = (await $.fs.list(dir))
        .filter(f => f.kind === 'file' && IMAGE_EXT.test(f.name) && !logged.has(`${dir}/${f.name}`))
        .sort((a, b) => a.mtimeMs - b.mtimeMs)
        .map(f => ({ kind: 'file' as const, path: `${dir}/${f.name}`, size: f.size, mtimeMs: f.mtimeMs, via: 'sent' as const }))
      if (found.length > 0) await record($, found, { tool: 'You', toolUseId: '' }, { galleryPane, openOn })
    } catch (err) {
      $.ui.log(`image-log: ${String(err)}`)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Image = 'Image' in ui ? ui.Image : undefined
    await read($, rev)
    const [sel, missingShown, sessionId] = await Promise.all([
      read($, selected),
      read($, showMissing),
      $.session.id(),
    ])

    // Newest line per file wins; inline images are each their own.
    const seen = new Set<string>()
    const all = (await readLog($))
      .filter(x => x.sessionId === sessionId)
      .reverse()
      .filter(x => {
        const k = x.kind === 'file' ? `${x.sessionId}|${x.path}` : x.id
        return seen.has(k) ? false : (seen.add(k), true)
      })
      .slice(0, 300)
    const states = await Promise.all(
      all.map(async x => {
        if (x.kind !== 'file' || !x.path) return { x, missing: false, changed: false, mtimeMs: undefined }
        const st = await statFile($, x.path)
        return { x, missing: !st, changed: !!st && (st.mtimeMs !== x.mtimeMs || st.size !== x.size), mtimeMs: st?.mtimeMs }
      }),
    )
    const rows = states.filter(s => missingShown || !s.missing) // newest first
    const hidden = states.length - rows.length

    const cols = e.props.bodyColumns
    const bodyRows = e.props.scroll.bodyRows
    const scopeText = 'this session'
    let step = (_d: number): unknown => undefined
    let openCurrent = async (): Promise<unknown> => undefined

    const controls = (
      <Box flexDirection="row" gap={1}>
        <Button key="prev" label="older" hotkey="p" onPress={() => step(1)} />
        <Button key="next" label="newer" hotkey="n" onPress={() => step(-1)} />
        <Button key="latest" label="latest" hotkey="l" onPress={() => update($, selected, () => null)} />
        <Button key="open" label="open" hotkey="o" onPress={() => openCurrent()} />
        <Button key="missing" label={missingShown ? 'hide missing' : `missing (${hidden})`} hotkey="m"
          onPress={() => update($, showMissing, v => !v)} />
      </Box>
    )

    if (rows.length === 0) {
      return (
        <Box flexDirection="column">
          <Text bold>No images in {scopeText} yet.</Text>
          <Text dimColor>Images Claude writes, makes with commands, reads or gets back from tools show up here.</Text>
          {controls}
        </Box>
      )
    }

    let idx = sel === null ? 0 : rows.findIndex(s => s.x.id === sel)
    if (idx < 0) idx = 0
    const cur = rows[idx] ?? rows[0]!
    step = (d: number) => update($, selected, () => rows[Math.max(0, Math.min(rows.length - 1, idx + d))]?.x.id ?? null)
    openCurrent = async () => {
      const p = await diskPath($, cur.x)
      if (p) await sh($, OPEN, [p])
      else $.ui.toast('That image is no longer available.')
    }

    const listRows = Math.max(3, Math.min(rows.length + 4, Math.floor(bodyRows * 0.35)))
    const imageRows = Math.max(4, bodyRows - listRows - 4)
    const herdr = galleryPane && (await galleryHost($)) !== 'none'
    if (herdr && !cur.missing) {
      // Fire and forget: the pane follows whatever is selected here.
      void diskPath($, cur.x)
        .then(p => (p ? writePointer($, sessionId, p) : undefined))
        .catch(() => undefined)
    }
    let picture
    if (herdr) {
      picture = <Text dimColor>{cur.missing ? `File is gone: ${cur.x.path}` : 'Picture shows in the gallery beside Claude →'}</Text>
    } else if (cur.missing) {
      picture = <Text color="red">File is gone: {cur.x.path}</Text>
    } else {
      const s = await shown($, cur.x, cur.mtimeMs)
      if ('error' in s || !Image) {
        picture = <Text dimColor>[{'error' in s ? s.error : 'this surface cannot draw images'}]</Text>
      } else {
        const fit = fitCells(s.width, s.height, cols, imageRows)
        picture = <Image key="view" source={s.source} columns={fit.columns} rows={fit.rows} alt={label(cur.x)} />
      }
    }

    const meta = [
      `${rows.length - idx}/${rows.length}`,
      cur.x.via,
      cur.x.tool.replace(/^mcp__/, ''),
      agentLabel(cur.x),
      `${ago(cur.x.time)} ago`,
      cur.changed ? 'changed since' : '',
    ].filter(Boolean).join(' · ')

    // The list, newest first, with a header row whenever project, session or agent changes.
    const list: RenderChildren[] = []
    let lastGroup = ''
    for (const s of rows.slice(0, listRows * 2)) {
      const x = s.x
      const group = agentLabel(x)
      if (group !== lastGroup) {
        list.push(<Text key={`g-${x.id}`} bold dimColor wrap="truncate-end">{group}</Text>)
        lastGroup = group
      }
      const mark = s.x.id === cur.x.id ? '▸' : ' '
      list.push(
        <Button key={`item-${x.id}`} onPress={() => update($, selected, () => x.id)}>
          {mark} {label(x)} <Text dimColor>{ago(x.time)}{s.missing ? ' · missing' : s.changed ? ' · changed' : ''}</Text>
        </Button>,
      )
      if (list.length >= listRows) break
    }

    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate-middle">{cur.x.kind === 'file' ? cur.x.path : label(cur.x)}</Text>
        <Text dimColor wrap="truncate-end">{meta}</Text>
        {picture}
        {controls}
        <Text dimColor>{scopeText}{hidden && !missingShown ? ` · ${hidden} missing hidden` : ''}</Text>
        {list}
      </Box>
    )
  })
}
