/** One line of ~/.cache/claude-images/log.jsonl: a pointer to an image, never its bytes. */
export type ImageEntry = {
  /** Unique id of this log line. */
  id: string
  /** When it was logged, ms since epoch. */
  time: number
  /** `file`: an image on disk at `path`. `inline`: an image a tool returned, found in the session transcript by `toolUseId`. */
  kind: 'file' | 'inline'
  path?: string
  /** Size and mtime when logged, to tell later whether the file changed. */
  size?: number
  mtimeMs?: number
  mediaType?: string
  /** Index of the image among the tool result's image blocks (inline only). */
  blockIndex?: number
  /** The tool that made or returned it (`You` for an image you sent), and how. */
  tool: string
  via: 'write' | 'bash' | 'read' | 'returned' | 'sent'
  toolUseId: string
  sessionId: string
  /** The session's project root. */
  project: string
  /** The subagent's loop id; absent for the main conversation. */
  agentId?: string
}

declare module 'claude-code' {
  interface PluginState {
    'image-log': {
      /** Bumped after each new log line, so the pane redraws. */
      rev: number
      /** The entry shown large; null follows the newest. */
      selected: string | null
      showMissing: boolean
    }
  }
}
