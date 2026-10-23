/** P1d：目录导入（webkitdirectory 模拟） */
import { describe, expect, it } from 'vitest'
import { filesFromDirectoryPicker } from '../src/core/import/importDir'

function fakeBrowserFile(path: string, size: number): File {
  const f = new File([new Uint8Array(size)], path.split('/').pop()!)
  Object.defineProperty(f, 'webkitRelativePath', { value: path })
  return f
}

describe('目录导入', () => {
  it('相对路径规范化 + 类型分拣', () => {
    const { files, otherFiles } = filesFromDirectoryPicker([
      fakeBrowserFile('数学课程/第1章/函数.md', 10),
      fakeBrowserFile('数学课程\\第1章\\集合.md', 20), // 反斜杠（某些来源）
      fakeBrowserFile('数学课程/assets/图.png', 5),
      fakeBrowserFile('数学课程/notes.txt', 7),
    ])
    // 默认 sort()（UTF-16 码元序）：拉丁字母目录在 CJK 之前
    expect(files.map((f) => f.normPath).sort()).toEqual([
      '数学课程/assets/图.png',
      '数学课程/第1章/函数.md',
      '数学课程/第1章/集合.md',
    ])
    expect(otherFiles).toEqual([{ path: '数学课程/notes.txt', size: 7 }])
    expect(files[0]!.source.type).toBe('browser-file')
  })

  it('无 webkitRelativePath 时退回文件名', () => {
    const f = new File([new Uint8Array(3)], '单独.md')
    const { files } = filesFromDirectoryPicker([f])
    expect(files[0]!.normPath).toBe('单独.md')
  })

  it('规范化后路径冲突 → 诊断 + 去重跳过', () => {
    const { files, diagnostics } = filesFromDirectoryPicker([
      fakeBrowserFile('课程/a.md', 1),
      fakeBrowserFile('课程\\a.md', 2),
    ])
    expect(files).toHaveLength(1)
    expect(diagnostics.some((d) => d.code === 'DIR_NAME_COLLISION')).toBe(true)
  })
})
