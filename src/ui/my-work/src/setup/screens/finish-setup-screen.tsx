import { ArrowRightIcon, CheckIcon, CopyIcon, ExternalLinkIcon } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { SaveButton } from '@/components/save-button'
import { Collapsible, CollapsibleContent, CollapsibleFoldTrigger } from '@/components/ui/collapsible'
import { interpolate, useI18n } from '@/lib/i18n'
import { CMEM_MCP_URL, type SetupTool } from '../setup-data'
import { PageHeading, SetupActions, SetupButton, ToolMark, type SetupBack } from './shared'

function CopyUrl({ toolName }: { toolName: string }) {
  const { t } = useI18n()
  const [status, setStatus] = useState<'' | 'URL copied.' | 'Select and copy the URL above.'>('')
  // Resolves false when the copy failed, so the button shows no check; the status line says what to do. The button says
  // what happens, a copy: Copying…, Copied, Not copied; nothing on this screen says Saving or Saved (nothing is saved).
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(CMEM_MCP_URL)
      setStatus('URL copied.')
      return true
    } catch {
      setStatus('Select and copy the URL above.')
      return false
    }
  }
  return (
    <>
      <div className="connection-copy">
        <code>{CMEM_MCP_URL}</code>
        <SaveButton type="button" className="secondary" onClick={copy} aria-label={interpolate(t('Copy CMEM URL for {toolName}'), { toolName })}
          icon={<CopyIcon aria-hidden="true" />} savingLabel={t('Copying…')} savedLabel={t('Copied')} notSavedLabel={t('Not copied')}>{t('Copy URL')}</SaveButton>
      </div>
      <p className="connection-status" role="status" aria-live="polite">{t(status)}</p>
    </>
  )
}

/** How each picked tool reads this computer's memory (PROTO renderConnectionDetails, CONNECTOR-EVIDENCE.md). */
function Connection({ tool, open }: { tool: SetupTool; open: boolean }) {
  const { t } = useI18n()
  return (
    <Collapsible className="connection" defaultOpen={open}>
      <CollapsibleFoldTrigger className="connection-trigger"><span className="connection-title"><ToolMark id={tool.id} name={tool.name} />{interpolate(t('{toolName} setup'), { toolName: tool.name })}</span></CollapsibleFoldTrigger>
      <CollapsibleContent className="connection-body">
        {tool.steps && <ol>{tool.steps.map((step) => <li key={step}>{t(step)}</li>)}</ol>}
        {tool.commands && <ol className="connection-commands">{tool.commands.map((command) => <li key={command}><code>{command}</code></li>)}</ol>}
        <CopyUrl toolName={tool.name} />
        {tool.guide && <a className="connection-guide" href={tool.guide.href} target="_blank" rel="noopener noreferrer">{t(tool.guide.label)}<ExternalLinkIcon aria-hidden="true" /></a>}
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * Step 6 (PROTO #route-finish-setup). Tools the install step connected are listed as connected; the others can be
 * added with a tick (E8). Detected tools come pre-ticked.
 */
export function FinishSetupScreen({ tools, selected, onSelect, back, onContinue }: {
  tools: SetupTool[]
  selected: string[]
  onSelect: (selected: string[]) => void
  /** Absent once the installer has applied the choice and there is no earlier screen left to change. */
  back?: SetupBack | null
  onContinue: () => void
}) {
  const { t } = useI18n()
  const [showError, setShowError] = useState(false)
  const toggle = (id: string, on: boolean) => {
    const next = on ? [...selected, id] : selected.filter((entry) => entry !== id)
    onSelect(tools.map((tool) => tool.id).filter((toolId) => next.includes(toolId)))
    if (next.length) setShowError(false)
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (selected.length === 0) {
      setShowError(true)
      document.querySelector<HTMLInputElement>('input[name="finish-tools"]')?.focus()
      return
    }
    onContinue()
  }
  const connected = tools.filter((tool) => tool.installed)
  const addable = tools.filter((tool) => !tool.installed)
  const picked = addable.filter((tool) => selected.includes(tool.id))
  return (
    <section aria-labelledby="finish-setup-title">
      <PageHeading id="finish-setup-title" title={t('Connect your tools')} />
      <form onSubmit={submit} noValidate>
        <div className="finish-grid">
          <div className="panel finish-tools">
            <fieldset>
              <legend>{t('Use your memory in these tools')}</legend>
              {connected.length > 0 && <>
                <h3 className="finish-group">{t('Connected on this computer')}</h3>
                <ul className="tool-connected">
                  {connected.map((tool) => (
                    <li key={tool.id}><ToolMark id={tool.id} name={tool.name} /><span>{tool.name}<small className="tool-installed"><CheckIcon aria-hidden="true" />{t('Connected')}</small></span></li>
                  ))}
                </ul>
              </>}
              {addable.length > 0 && <>
                {connected.length > 0 && <h3 className="finish-group">{t('Add more')}</h3>}
                <div className="tool-options">
                  {addable.map((tool) => (
                    <label key={tool.id} className="tool-option">
                      <input type="checkbox" name="finish-tools" value={tool.id} checked={selected.includes(tool.id)} onChange={(event) => toggle(tool.id, event.target.checked)} />
                      <span className="tick" aria-hidden="true"><CheckIcon strokeWidth={3} /></span>
                      <ToolMark id={tool.id} name={tool.name} />
                      <span>{tool.name}</span>
                    </label>
                  ))}
                </div>
              </>}
            </fieldset>
            {showError && <p className="tool-error" role="alert">{t('Select at least one tool to continue.')}</p>}
            {picked.length > 0 && (
              <div className="connections" aria-label={t('Selected tool connections')}>
                {picked.map((tool, index, list) => <Connection key={tool.id} tool={tool} open={index === list.length - 1} />)}
              </div>
            )}
          </div>
        </div>
        <SetupActions back={back}>
          <SetupButton type="submit">{t('Finish setup')} <ArrowRightIcon aria-hidden="true" /></SetupButton>
        </SetupActions>
      </form>
    </section>
  )
}
