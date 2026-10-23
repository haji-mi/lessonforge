/** 导入向导：目录/ZIP 导入 → ZIP 名称确认制 → 结构确认（证据展示+人工调整） */
import type { ReactElement } from 'react'
import { useRef, useState } from 'react'
import type { NameDecisionSet, ZipScanResult } from '../core/import/zip/importZip'
import { importZipEntries, scanZip } from '../core/import/zip/importZip'
import { filesFromDirectoryPicker } from '../core/import/importDir'
import type { ImportedFile } from '../core/types'
import type { StructureCourse } from '../core/structure/infer'

export interface ImportWizardProps {
  onDone: (
    files: ImportedFile[],
    source: 'dir' | 'zip',
    otherFiles: { path: string; size: number }[],
  ) => void
  onCancel: () => void
}

export function ImportWizard({ onDone, onCancel }: ImportWizardProps) {
  const [zipScan, setZipScan] = useState<ZipScanResult | null>(null)
  const [zipBlob, setZipBlob] = useState<Blob | null>(null)
  const [forcedMode, setForcedMode] = useState<'utf-8' | 'gbk' | undefined>(undefined)
  const [choices, setChoices] = useState<Map<number, string>>(new Map())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirInput = useRef<HTMLInputElement>(null)
  const zipInput = useRef<HTMLInputElement>(null)

  async function onDirPicked(files: File[]) {
    const { files: imported, otherFiles, diagnostics } = filesFromDirectoryPicker(files)
    if (diagnostics.some((d) => d.severity === 'error'))
      setError(diagnostics.map((d) => d.message).join('；'))
    onDone(imported, 'dir', otherFiles)
  }

  async function onZipPicked(file: File) {
    setBusy(true)
    setError(null)
    try {
      const scan = await scanZip(file, forcedMode)
      setZipBlob(file)
      setZipScan(scan)
      setChoices(new Map())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function rescan(mode: 'utf-8' | 'gbk' | undefined) {
    if (!zipBlob) return
    setBusy(true)
    try {
      const scan = await scanZip(zipBlob, mode)
      setForcedMode(mode)
      setZipScan(scan)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  async function confirmZip() {
    if (!zipBlob || !zipScan) return
    setBusy(true)
    setError(null)
    try {
      const result = await importZipEntries(zipBlob, zipScan, { nameChoices: choices })
      if (result.files.length === 0) {
        setError('没有可导入的文件：' + result.diagnostics.map((d) => d.message).join('；'))
        return
      }
      onDone(result.files, 'zip', result.otherFiles)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="wizard">
      <h2>导入课程资料</h2>
      <p className="muted">目录导入为主路径（无编码歧义）；ZIP 导入支持 GBK/UTF-8 名称判定。</p>
      <div className="wizard-actions">
        <button onClick={() => dirInput.current?.click()}>选择课程目录</button>
        <button onClick={() => zipInput.current?.click()}>选择 ZIP 文件</button>
        <input
          ref={dirInput}
          type="file"
          multiple
          // @ts-expect-error webkitdirectory 非标准属性
          webkitdirectory=""
          directory=""
          hidden
          onChange={(e) => e.target.files && onDirPicked([...e.target.files])}
        />
        <input
          ref={zipInput}
          type="file"
          accept=".zip"
          hidden
          onChange={(e) => e.target.files?.[0] && onZipPicked(e.target.files[0])}
        />
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      {busy ? <div className="muted">处理中…</div> : null}

      {zipScan ? (
        <ZipConfirm
          scan={zipScan.names}
          forcedMode={forcedMode}
          choices={choices}
          setChoices={setChoices}
          onRescan={rescan}
          onConfirm={confirmZip}
          busy={busy}
        />
      ) : null}
      <button className="link" onClick={onCancel}>
        取消
      </button>
    </div>
  )
}

function ZipConfirm({
  scan,
  forcedMode,
  choices,
  setChoices,
  onRescan,
  onConfirm,
  busy,
}: {
  scan: NameDecisionSet
  forcedMode: 'utf-8' | 'gbk' | undefined
  choices: Map<number, string>
  setChoices: (m: Map<number, string>) => void
  onRescan: (mode: 'utf-8' | 'gbk' | undefined) => void
  onConfirm: () => void
  busy: boolean
}) {
  const needsChoice = scan.outcomes.filter((o) => o.needsChoice)
  const dualCandidates = scan.outcomes.filter((o) => !o.needsChoice && o.candidates.length > 1)
  return (
    <div className="zip-confirm">
      <h3>ZIP 名称解码报告（确认后才会解压导入）</h3>
      <div className="zip-summary">
        组判定：<b>{scan.groupMode === 'none' ? '（无非 ASCII 无标志条目）' : scan.groupMode}</b> ——{' '}
        {scan.groupBasis}
        {scan.nonAsciiNoFlagCount > 0 ? (
          <span>
            {' '}
            （无标志非 ASCII 条目 {scan.nonAsciiNoFlagCount} 个；
            <button
              className="link"
              onClick={() => onRescan(forcedMode === 'gbk' ? 'utf-8' : 'gbk')}
            >
              切换为按 {forcedMode === 'gbk' ? 'UTF-8' : 'GBK'} 重新判定
            </button>
            <button className="link" onClick={() => onRescan(undefined)}>
              恢复自动
            </button>
            ）
          </span>
        ) : null}
      </div>
      {scan.diagnostics.length > 0 ? (
        <ul className="diag-list">
          {scan.diagnostics.map((d, i) => (
            <li key={i} className={`diag-${d.severity}`}>
              [{d.code}] {d.message}
            </li>
          ))}
        </ul>
      ) : null}
      {needsChoice.length > 0 ? (
        <div className="choice-block">
          <h4>需要人工裁决的条目（{needsChoice.length}）</h4>
          {needsChoice.map((o) => (
            <div key={o.index} className="choice-row">
              <span className="muted">{o.basis}</span>
              {o.candidates.map((c) => (
                <label key={c.text}>
                  <input
                    type="radio"
                    name={`choice-${o.index}`}
                    checked={(choices.get(o.index) ?? o.display) === c.text}
                    onChange={() => {
                      const m = new Map(choices)
                      m.set(o.index, c.text)
                      setChoices(m)
                    }}
                  />
                  {c.text}（{c.basis}）
                </label>
              ))}
            </div>
          ))}
        </div>
      ) : null}
      {dualCandidates.length > 0 ? (
        <details>
          <summary className="link">
            双候选可见条目（{dualCandidates.length}，默认采用组模式结果）
          </summary>
          {dualCandidates.map((o) => (
            <div key={o.index} className="choice-row">
              <code>{o.display}</code>
              <span className="muted">候选：</span>
              {o.candidates.map((c) => (
                <span key={c.text} className="cand">
                  {c.text}（{c.basis}）
                </span>
              ))}
            </div>
          ))}
        </details>
      ) : null}
      <div>
        <button disabled={busy} onClick={onConfirm}>
          确认导入
        </button>
      </div>
    </div>
  )
}

/** 结构确认屏：证据展示 + 重命名 */
export function StructureConfirm({
  structure,
  onRename,
  onConfirm,
}: {
  structure: StructureCourse
  onRename: (path: string, title: string) => void
  onConfirm: () => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const renderChapter = (ch: StructureCourse['chapters'][number], depth = 0): ReactElement => (
    <div key={ch.path} style={{ marginLeft: depth * 16 }}>
      <div className="chapter-row">
        📁 {ch.name}
        {ch.evidence.length > 0 ? (
          <span className="muted"> —— {ch.evidence.join('；')}</span>
        ) : null}
      </div>
      {ch.lessons.map((l) => (
        <div key={l.path} className="lesson-row">
          📄{' '}
          {editing === l.path ? (
            <>
              <input value={draft} onChange={(e) => setDraft(e.target.value)} />
              <button
                onClick={() => {
                  onRename(l.path, draft)
                  setEditing(null)
                }}
              >
                保存
              </button>
            </>
          ) : (
            <>
              <span
                onDoubleClick={() => {
                  setEditing(l.path)
                  setDraft(l.title)
                }}
              >
                {l.title}
              </span>
              <span className="muted">（{l.titleBasis}）</span>
            </>
          )}
        </div>
      ))}
      {ch.subChapters.map((sub) => renderChapter(sub, depth + 1))}
    </div>
  )
  return (
    <div className="structure-confirm">
      <h3>识别到的课程结构（请确认，双击课时名可重命名）</h3>
      <div className="muted">
        课程：{structure.name} —— {structure.evidence.join('；')}
      </div>
      {structure.chapters.map((ch) => renderChapter(ch))}
      {structure.rootLessons.length > 0 ? (
        <div className="chapter-row">📄 根目录散落（未分章）</div>
      ) : null}
      {structure.rootLessons.map((l) => (
        <div key={l.path} className="lesson-row">
          📄 {l.title} <span className="muted">（{l.titleBasis}）</span>
        </div>
      ))}
      <button onClick={onConfirm}>确认结构，进入工作台</button>
    </div>
  )
}
