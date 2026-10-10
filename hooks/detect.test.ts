import { describe, expect, test } from 'claude-code/testing'

import { fitCells, imageBlocksIn, imagePathsIn, pngSize, resolvePath } from './detect'

describe('detect', () => {
  test('finds image paths in commands and output', async () => {
    const text = 'convert in.jpg -resize 50% "out dir/x.png" && echo saved ./shots/a.webp\nnot-an-image.txt /tmp/b.PNG'
    expect(imagePathsIn(text)).toEqual(['in.jpg', 'dir/x.png', './shots/a.webp', '/tmp/b.PNG'])
  })

  test('resolves relative, home and dot paths', async () => {
    expect(resolvePath('./a/../b.png', '/p/q', '/home/u')).toBe('/p/q/b.png')
    expect(resolvePath('~/x.png', '/p', '/home/u')).toBe('/home/u/x.png')
    expect(resolvePath('/abs/y.jpg', '/p', '/home/u')).toBe('/abs/y.jpg')
  })

  test('finds image blocks in MCP-style and API-style results', async () => {
    const mcp = { content: [{ type: 'text', text: 'hi' }, { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }] }
    const api = [{ type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } }] }]
    expect(imageBlocksIn(mcp)).toEqual([{ data: 'AAAA', mediaType: 'image/jpeg' }])
    expect(imageBlocksIn(api)).toEqual([{ data: 'BBBB', mediaType: 'image/png' }])
    expect(imageBlocksIn({ stdout: 'x.png' })).toEqual([])
  })

  test('reads PNG size and fits it to cells', async () => {
    const head = new Uint8Array(24)
    head.set([0x89, 0x50, 0x4e, 0x47])
    new DataView(head.buffer).setUint32(16, 400)
    new DataView(head.buffer).setUint32(20, 250)
    expect(pngSize(head)).toEqual({ width: 400, height: 250 })
    expect(fitCells(400, 250, 80, 40)).toEqual({ columns: 80, rows: 25 })
    expect(fitCells(400, 800, 80, 20)).toEqual({ columns: 20, rows: 20 })
  })
})
