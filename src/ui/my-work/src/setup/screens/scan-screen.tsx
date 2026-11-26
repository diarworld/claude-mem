import { ArrowRightIcon, CheckIcon } from 'lucide-react'
import { DottedGlowBackground } from '@/components/aceternity/dotted-glow-background'
import { interpolate, useI18n } from '@/lib/i18n'
import { type SetupFailure, type SetupScanOrganizing, type SetupScanPhase, type SetupScanView } from '../setup-data'
import { scanAgentStatus } from '../setup-scan-status'
import { PageHeading, SetupActions, SetupButton, SetupError, ToolMark, type SetupBack } from './shared'

/** PROTO savings.js status phrases, one per scan phase. A stopped scan says what happened in its own alert instead. */
const STATUS: Record<SetupScanPhase, string | null> = {
  idle: 'Finding your recent work.',
  reading: 'Finding your recent work.',
  checking: 'Finding the context behind your work.',
  saving: 'Preparing your overview.',
  // The worker holds the scan here only to hear the upload answer, and the page answers it for
  // everyone (setup-page.tsx): the phase is momentary, so the scan keeps its running appearance.
  'awaiting-consent': null,
  uploading: 'Discovering your work, rules and focus…',
  done: 'Your scan is done. Continue to see what it found.',
  failed: null,
}

/** The refresh step's words on the live organizing line; a step a newer worker names shows as its id. */
const ORGANIZING_STEP_WORDS: Record<string, string> = {
  goals: 'your goals',
  grouping: 'grouping your requests',
  review: 'reviewing your requests',
  titles: 'naming your requests',
  focus: 'sorting into focus areas',
  story: 'writing your build story',
}

/**
 * Step 1: each detected agent ticks in and its prompt count climbs while the worker reads the last 30 days. When the
 * scan finishes the page moves on to the Reveal by itself, as it always has; Back waits while the scan runs. The done
 * state, with its Continue, shows only when the person comes Back from the Reveal to look at the scan again. The scan
 * is local-only: the upload offer is gone, and the page declines the worker's upload hold for everyone — this screen
 * shows a retry only if that decline could not be sent.
 */
export function ScanScreen({ scan, back, onImproveProductChange, onConfirmUpload, consentError, consentSending, preferenceError, onRetry, retrying, retryError, onSkip, onContinue }: {
  scan: SetupScanView
  back?: SetupBack | null
  onImproveProductChange: (improveProduct: boolean) => void
  /** Sends the local-only decline again, after a failed one. */
  onConfirmUpload: () => void
  consentError?: SetupFailure | null
  consentSending?: boolean
  preferenceError: SetupFailure | null
  onRetry: () => void
  retrying: boolean
  retryError: SetupFailure | null
  /** "Skip the scan" after it stopped: setup goes on without it, and nothing is sent. */
  onSkip?: () => void
  onContinue?: () => void
}) {
  const { t } = useI18n()
  const detected = scan.agents.filter((agent) => agent.detected)
  const stopped = scan.phase === 'failed'
  const count = (prompts: number) => interpolate(t('{count} messages'), { count: prompts.toLocaleString('en-US') })
  const status = STATUS[scan.phase]
  /** The live organizing line: the step it is on, with its (done/total) when the step's batch total is known. */
  const organizingLine = (organizing: SetupScanOrganizing) => {
    const step = organizing.step ? t(ORGANIZING_STEP_WORDS[organizing.step] ?? organizing.step) : null
    if (!step) return t('Organizing your recent work.')
    if (organizing.batchTotal === null) return interpolate(t('Organizing your recent work: {step}'), { step })
    return interpolate(t('Organizing your recent work: {step} ({done}/{total})'), { step, done: organizing.batchDone ?? 0, total: organizing.batchTotal })
  }
  // While the scan runs the row has nothing to press forward (the page moves on by itself), so its only line is
  // Back's reason, which the bottom row words (BACK_WAIT_WORDS).
  return (
    <section aria-labelledby="scan-title">
      <PageHeading id="scan-title" title={t('Finding your recent work.')} lead={detected.map((agent) => agent.label).join(' · ') || undefined} />
      <div className="panel is-memory scan-panel">
        {/* Texture only (C1): still and faint, drawn once (speedScale 0), hidden from screen readers. */}
        <DottedGlowBackground className="scan-dots" gap={16} radius={1.2} color="rgba(75, 70, 200, 0.5)" glowColor="rgba(91, 87, 230, 0.9)" opacity={0.28} speedScale={0} />
        {detected.length > 0 && (
          <ul className="scan-agents" aria-label={t('Agents found on this computer')}>
            {detected.map((agent) => {
              const agentStatus = scanAgentStatus(agent)
              return (
                <li key={agent.id} className={agentStatus.note ? 'cannot-run' : undefined}>
                  <span className="check" aria-hidden="true"><CheckIcon strokeWidth={3} /></span>
                  <ToolMark id={agent.id} name={agent.label} />
                  <span className="scan-agent-name">{agent.label} <span className="detected">({t(agentStatus.label)})</span></span>
                  <span className="count tabular">{count(agent.prompts)}</span>
                  {agentStatus.note && <span className="scan-agent-note">{t(agentStatus.note)}</span>}
                </li>
              )
            })}
          </ul>
        )}
        <div className="scan-meter">
          <progress max={100} value={scan.percent} aria-label={t('Scan progress')}>{scan.percent}%</progress>
          <span className="scan-percent tabular" aria-hidden="true">{scan.percent}%</span>
        </div>
        {status && <p className="scan-status" role="status" aria-live="polite">{t(status)}</p>}
        {/* Organizing runs in the background after the scan is done; the wizard never waits for it. A stopped
            organizing is a muted note, not an alert: setup is complete and My Work retries on its own schedule. */}
        {scan.phase === 'done' && scan.organizing?.state === 'running'
          && <p className="scan-status" role="status" aria-live="polite">{organizingLine(scan.organizing)}</p>}
        {scan.phase === 'done' && scan.organizing?.state === 'failed'
          && <p className="scan-status" role="status">{t('Organizing stopped. My Work will retry it.')}</p>}
        {stopped && (retryError
          ? <SetupError title={t('Couldn’t start the scan again.')} failure={retryError} />
          : <SetupError title={scan.errorKind || scan.percent === 0 ? t('The scan couldn’t start.') : t('The scan stopped.')}
            // A page that could not reach the worker says so; any other stop says the conversations are safe.
            check={scan.errorKind === 'unreachable' ? undefined : t('Your conversations are on this computer. Setup can continue with new work.')}
            failure={scan.error ? { kind: scan.errorKind ?? 'refused', detail: scan.error } : null} />)}
        {consentError && <SetupError title={t('Couldn’t send your choice.')}
          check={t('Nothing was uploaded: setup can continue with new work.')} failure={consentError} />}
        {preferenceError && <SetupError title={t('Couldn’t save this choice.')} failure={preferenceError} />}
        {/* The choice can change while the scan can still use it, as before Phase 8. A finished scan shows only on the way
            Back from the Reveal, and there the choice is read-only: a change would send POST /api/setup/scan/preferences
            after the scan finished, which this page never did. */}
        <label className="scan-improve-product">
          <input type="checkbox" checked={scan.improveProduct} disabled={scan.phase === 'uploading' || scan.phase === 'done'} onChange={(event) => onImproveProductChange(event.target.checked)} />
          <span>
            <strong>{t('Share anonymous usage statistics to help improve your Claude-mem experience')}</strong>
            {scan.phase === 'done' && <small>{t('The scan is done, and this choice was saved with it.')}</small>}
          </span>
        </label>
      </div>
      <SetupActions back={back}>
        {stopped && <>
          {/* Dimmed while "Try again" is starting the scan: skipping then would leave a new scan running behind a
              Reveal that says it was skipped, with an upload question nobody can answer. */}
          {onSkip && <SetupButton look="outline" aria-disabled={retrying || undefined} onClick={onSkip}>{t('Continue with new work')}</SetupButton>}
          <SetupButton busy={retrying} busyLabel={t('Starting again…')} onClick={onRetry}>{t('Try again')}</SetupButton>
        </>}
        {consentError && <SetupButton busy={consentSending} busyLabel={t('Sending your choice…')} onClick={onConfirmUpload}>{t('Continue with new work')} <ArrowRightIcon aria-hidden="true" /></SetupButton>}
        {scan.phase === 'done' && onContinue && <SetupButton onClick={onContinue}>{t('Continue')} <ArrowRightIcon aria-hidden="true" /></SetupButton>}
      </SetupActions>
    </section>
  )
}
