// The install funnel page (`?setup=1`), outside My Work's nav. Screens get their data through props from one source:
// the local worker, or the review fixtures with `?source=sample` (loaded by a dynamic import, so they are never in
// reach without the flag). The step machine is setup-flow.ts.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CmemMark } from '@/components/brand'
import { LOCALES, LOCALE_NAMES, useI18n, type Locale } from '@/lib/i18n'
import { EMPTY_SETUP_DATA, connectionFailureAbove, localSetupSource, setupToolsForInstall, toSetupFailure, type SetupChoice, type SetupData, type SetupFailure, type SetupSource } from './setup-data'
import { backWaitsFor, choiceLocked, guardStep, hydrateSetupChoice, initialFlowState, previousStep, scanMovesOn, type SetupFlowState, type SetupStep } from './setup-flow'
import type { SampleFailure, SampleScanStop } from './setup-sample'
import { ChoiceScreen } from './screens/choice-screen'
import { FinishSetupScreen } from './screens/finish-setup-screen'
import { InstallScreen } from './screens/install-screen'
import { LaunchScreen } from './screens/launch-screen'
import { RevealScreen } from './screens/reveal-screen'
import { ScanScreen } from './screens/scan-screen'
import { PageHeading, SetupButton, SetupError, type SetupBack } from './screens/shared'
import { SetupStepBar } from './screens/step-bar'
import { prefersReducedMotion } from './format'
import { WorkspaceScreen } from './screens/workspace-screen'
import { connectSetupTelemetry, createSetupTracker, sendSetupEvent } from './setup-telemetry'
import type { SetupError as SetupErrorCode } from '../../../../shared/setup-funnel.ts'
import './setup.css'

const PARAMS = new URLSearchParams(window.location.search)
const SAMPLE_REQUESTED = PARAMS.get('source') === 'sample'

function useSetupSource(): SetupSource | null {
  const [source, setSource] = useState<SetupSource | null>(SAMPLE_REQUESTED ? null : localSetupSource)
  useEffect(() => {
    if (!SAMPLE_REQUESTED) return
    let current = true
    // `&scan=<percent>` holds the scan there; `&scan=failed` stops it at a failure.
    // `&fail=` and `&installer=on`: setup-sample.ts's header says what each plays.
    const scan = PARAMS.get('scan')
    const scanStop = (['failed'] as const).find((stop): stop is SampleScanStop => stop === scan)
    const fail = (['install', 'installer', 'choice'] as const).find((kind): kind is SampleFailure => kind === PARAMS.get('fail'))
    const installer = PARAMS.get('installer') === 'on'
    import('./setup-sample').then(({ createSampleSetupSource }) => { if (current) setSource(createSampleSetupSource(PARAMS.get('sample') === 'new', scan !== null && !scanStop ? Number(scan) : null, PARAMS.get('agent') === 'none', { scanStop, fail, installer })) })
    return () => { current = false }
  }, [])
  return source
}

/**
 * A failed hand-off as the page shows it: the screen it belongs to (it shows there only), what failed (English,
 * translated when drawn), why, and the press that sends it again, which runs only when the person presses "Try again".
 */
interface HandOffFailure { step: SetupStep; title: string; failure: SetupFailure; retry?: () => Promise<void> }

export default function SetupPage({ onComplete }: { onComplete: () => void }) {
  const { t, locale, setLocale } = useI18n()
  const source = useSetupSource()
  const telemetry = useMemo(() => createSetupTracker(sendSetupEvent), [])
  const [branchConfirmed, setBranchConfirmed] = useState(false)
  useEffect(() => {
    if (source?.kind !== 'local') return
    const disconnect = connectSetupTelemetry(context => telemetry.start(context))
    const visibility = () => telemetry.visibility(document.visibilityState !== 'hidden')
    const leaving = () => telemetry.visibility(false)
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('pagehide', leaving)
    return () => { disconnect(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', leaving) }
  }, [source, telemetry])
  const [data, setData] = useState<SetupData>(EMPTY_SETUP_DATA)
  useEffect(() => source?.subscribe(setData), [source])

  const [flow, setFlow] = useState<SetupFlowState>(() => initialFlowState(false))
  const choiceEdited = useRef(false)
  const choicePending = useRef(false)
  const [savingChoice, setSavingChoice] = useState(false)
  const [requested, setRequested] = useState<SetupStep>('install')
  const update = (changes: Partial<SetupFlowState>, next?: SetupStep) => { setFlow((current) => ({ ...current, ...changes })); if (next) setRequested(next) }

  const [improveProduct, setImproveProduct] = useState<boolean | null>(null)
  const [preferenceError, setPreferenceError] = useState<SetupFailure | null>(null)
  const preferenceRevision = useRef(0)
  const changeImproveProduct = async (checked: boolean) => {
    if (!source) return
    const revision = ++preferenceRevision.current
    const failed = telemetry.failure('usage_preference_failed')
    // Keep the user's choice visible even if an earlier scan response arrives after their click.
    setImproveProduct(checked)
    setPreferenceError(null)
    try { await source.setImproveProduct(checked) } catch (error) {
      failed()
      if (revision !== preferenceRevision.current) return
      setImproveProduct(null)
      setPreferenceError(toSetupFailure(error))
    }
  }

  const [consentError, setConsentError] = useState<SetupFailure | null>(null)
  const consentPending = useRef(false)
  const [consentSending, setConsentSending] = useState(false)
  const confirmUpload = async (upload: boolean, agents?: string[]) => {
    if (!source || consentPending.current) return
    consentPending.current = true
    setConsentError(null)
    setConsentSending(true)
    const failed = telemetry.failure('upload_consent_failed')
    // The only answer this page sends is the decline (the scan stays local).
    telemetry.action('upload_skipped')
    try {
      // The sharing choice travels with the consent, so a queued preference request cannot lose a race with the upload.
      // Either answer ends with the worker reporting the scan done, which moves the page on (scanMovesOn).
      await source.confirmUpload(upload, agents, improveProduct ?? data.scan.improveProduct)
    } catch (error) {
      failed()
      setConsentError(toSetupFailure(error))
    } finally { consentPending.current = false; setConsentSending(false) }
  }
  // The scan's upload question is answered for everyone (2026-11-26 ruling: the scan stays local): when the worker
  // holds the scan for an upload choice, the page declines — nothing leaves this computer — and the scan finishes
  // locally. The screen no longer offers the choice; a decline that could not be sent shows its retry there.
  const scanAsksForUpload = data.scan.phase === 'awaiting-consent'
  useEffect(() => { if (scanAsksForUpload) void confirmUpload(false) }, [scanAsksForUpload])

  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<SetupFailure | null>(null)
  const retryPending = useRef(false)
  const retryScan = async () => {
    if (!source || retryPending.current) return
    retryPending.current = true
    setRetrying(true)
    setRetryError(null)
    // A new run is a first pass again: it moves on to the Reveal by itself when it finishes.
    update({ scanSkipped: false, scanReview: false })
    telemetry.action('retry_scan')
    const failed = telemetry.failure('scan_retry_failed')
    try { await source.retryScan() } catch (error) {
      failed()
      setRetryError(toSetupFailure(error))
    } finally {
      retryPending.current = false
      setRetrying(false)
    }
  }

  // Facts from the data, not decisions: they move the machine on as they arrive.
  const scanComplete = data.scan.done && data.scan.phase === 'done'
  // The worker's word on the installation: finished, or no install screen in this run. Only this ticks Tools.
  const installConfirmed = data.install !== undefined && (!data.install || data.install.status === 'ready')
  // A first load that never reached the worker knows nothing about the installation. It shows the stopped scan, with
  // its Try again, rather than an install screen with nothing to load.
  const installationComplete = installConfirmed || (data.install === undefined && data.connectionError !== null)
  // This machine already has a working configuration the funnel keeps: the page answers the waiting installer
  // itself and Finish Setup says so — the choice screen never asks what is already answered.
  const alreadyPro = data.alreadyPro
  if (flow.scanComplete !== scanComplete || flow.alreadyPro !== alreadyPro) {
    setFlow((current) => ({ ...current, scanComplete, alreadyPro }))
  }
  const hydratedFlow = hydrateSetupChoice(flow, data.choice, choiceEdited.current, data.installer?.stage)
  if (hydratedFlow !== flow) setFlow(hydratedFlow)
  const choiceApplied = choiceLocked(data.installer?.stage)
  if (data.choice && !branchConfirmed && (!choiceEdited.current || choiceApplied)) setBranchConfirmed(true)
  const availableTools = useMemo(() => setupToolsForInstall(data.install), [data.install])
  // Local tools only: cloud readers are a later, optional step in this build.
  const initialTools = () => availableTools
    .filter(tool => tool.kind === 'local' && (tool.installed || data.detectedTools.includes(tool.id)))
    .map(tool => tool.id)
  // Reload restores the worker's saved choice without resubmitting it.
  if (data.choice && installationComplete && !flow.choiceContinued && !choiceEdited.current
    && (choiceApplied || requested === 'choice')) {
    update({ revealContinued: true, choiceContinued: true, finishTools: initialTools() }, 'finish-setup')
  } else if (scanMovesOn(requested, { ...flow, installationComplete, scanComplete })) setRequested('reveal')

  const flowNow: SetupFlowState = { ...flow, installationComplete, installConfirmed }
  const step = guardStep(requested, flowNow)
  useEffect(() => { if (data.scan.phase === 'failed') telemetry.error('scan_failed') }, [data.scan.phase, telemetry])
  useEffect(() => { if (data.installer?.stage === 'failed') telemetry.error('installer_failed') }, [data.installer?.stage, telemetry])
  useEffect(() => {
    if (source?.kind === 'local') telemetry.view(step, { branch: flow.branch, branch_confirmed: branchConfirmed })
  }, [source, step, flow.branch, branchConfirmed, telemetry])
  const tools = useMemo(() => availableTools.filter((tool) => tool.kind === 'local'), [availableTools])
  const pickedTools = useMemo(() => tools.filter((tool) => flow.finishTools.includes(tool.id)), [tools, flow.finishTools])

  // Back on every screen but the first: the screen before this one on the person's path, through guardStep like any
  // request; dimmed with the reason while a scan runs (plan Phase 8).
  const backTarget = previousStep(step, flowNow, { hasInstallStep: !!data.install, choiceLocked: choiceApplied })
  const back: SetupBack | null = backTarget && {
    waitsFor: backWaitsFor(step, data.scan.phase),
    // Back to the installation or the scan is a look at a finished step: it stays up until the person's Continue.
    onBack: () => update(backTarget === 'install' ? { installReview: true } : backTarget === 'scan' ? { scanReview: true } : {}, backTarget),
  }

  // The terminal waits on these hand-offs; a refusal stays on the screen it was sent from and says what failed and why.
  const [handOffError, setHandOffError] = useState<HandOffFailure | null>(null)
  const [handOffRetrying, setHandOffRetrying] = useState(false)
  // `code` null: a hand-off the funnel's closed error list has no code for, so its failure sends no event.
  const handOff = async (send: () => Promise<void>, code: SetupErrorCode | null, title: string, retry?: () => Promise<void>): Promise<boolean> => {
    const failed = code ? telemetry.failure(code) : () => {}
    const sentFrom = step
    try { await send() } catch (error) { failed(); setHandOffError({ step: sentFrom, title, failure: toSetupFailure(error), retry }); return false }
    setHandOffError(null)
    return true
  }
  // "Try again" sends the same hand-off once more, only when pressed (no automatic retry).
  const retryHandOff = async () => {
    if (!handOffError?.retry || handOffRetrying) return
    setHandOffRetrying(true)
    try { await handOffError.retry() } finally { setHandOffRetrying(false) }
  }

  // Each new step starts at the top, with focus on its title (PROTO renderRoute). Leaving a screen also dismisses its
  // failed hand-off: the alert belongs to the screen it was sent from and never follows Back or Continue elsewhere.
  const main = useRef<HTMLElement>(null)
  const shownStep = useRef<SetupStep | null>(null)
  useEffect(() => {
    if (shownStep.current === step) return
    const first = shownStep.current === null
    shownStep.current = step
    setHandOffError((current) => current?.step === step ? current : null)
    if (first) return
    window.scrollTo(0, 0)
    if (step !== 'workspace') main.current?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true })
  }, [step])

  const submitChoice = async (branch: SetupChoice['branch']): Promise<void> => {
    if (!source || choicePending.current) return
    choicePending.current = true
    choiceEdited.current = true
    setSavingChoice(true)
    telemetry.action('choose_memory', { branch, branch_confirmed: false })
    try {
      const success = await handOff(() => source.choose({ branch, memoryBilling: 'existing' }), 'choice_failed', 'Couldn’t save your storage choice.', () => submitChoice(branch))
      if (!success) return
      const committed = { branch, branch_confirmed: true }
      setBranchConfirmed(true)
      telemetry.action('choice_committed', committed)
      update({ branch, memoryBilling: 'existing', revealContinued: true, choiceContinued: true, finishTools: initialTools(), setupComplete: false }, 'finish-setup')
    } finally {
      choicePending.current = false
      setSavingChoice(false)
    }
  }
  const finishSetup = async () => {
    update({ setupComplete: true })
    if (prefersReducedMotion()) { setRequested('workspace'); return }
    await main.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240 }).finished.catch(() => {})
    setRequested('launch')
  }

  // Already-configured machines never answer the choice question: this machine's working configuration is kept,
  // so when the choice step opens, the page sends it once itself. The worker takes the same choice again after a
  // reload without a fight (an applied identical choice is served, not refused), and a choice it already applied
  // never reaches this step — the restore above sends the page straight to Finish Setup. The interstitial below
  // stands in for the choice screen while the answer is on its way.
  const keptExistingChoice = flow.alreadyPro && installationComplete && !choiceEdited.current
    && (!data.choice || (data.choice.branch === 'home' && data.choice.memoryBilling === 'existing'))
  const keptExistingSent = useRef(false)
  useEffect(() => {
    if (step !== 'choice' || !keptExistingChoice || choiceApplied || choicePending.current || keptExistingSent.current) return
    keptExistingSent.current = true
    void submitChoice('home')
  })

  // The interstitial has no forward control of its own, and the once-guard above must not re-POST: when the
  // installer's applied report lands while it stands in for the choice screen — a Back press inside the report
  // window, or an answer the worker took but this page never heard back — the page moves on to Finish Setup the
  // same way the restore path sends a reload of an applied machine. A `failed` stage never exits (Retry setup owns
  // that screen), and without an applied report nothing moves: the sent answer's own success already did.
  useEffect(() => {
    if (step !== 'choice' || !flow.alreadyPro || !choiceApplied) return
    update({ revealContinued: true, choiceContinued: true, finishTools: initialTools() }, 'finish-setup')
  })

  // A failed handoff can restart its installer and retry the current choice from this page.
  const installerFailed = data.installer?.stage === 'failed'
  const [retryingSetup, setRetryingSetup] = useState(false)
  const retrySetup = async () => {
    if (!source || retryingSetup) return
    setRetryingSetup(true)
    // No "Try again" of its own: the "Retry setup" button right above it sends the same requests.
    await handOff(async () => {
      await source.resume()
      await source.choose({ branch: flow.branch, memoryBilling: flow.memoryBilling })
    }, 'choice_failed', 'Couldn’t restart setup.')
    setRetryingSetup(false)
  }
  const finishAll = async (): Promise<void> => {
    // Completion rides the successful state write before the installer can restart the worker.
    await Promise.race([telemetry.flush(), new Promise(resolve => setTimeout(resolve, 300))])
    if (await handOff(() => source!.complete(flow.finishTools, telemetry.completionEvents()), 'complete_failed', 'Couldn’t finish setup.', finishAll)) {
      telemetry.complete()
      onComplete()
    }
  }

  const screens: Record<SetupStep, () => ReactNode> = {
    install: () => <InstallScreen install={data.install} onInstall={async selection => {
      const failed = telemetry.failure('installer_failed')
      try { await source!.configureInstall(selection) } catch (error) { failed(); throw error }
    }} onContinue={() => update({ installReview: false }, 'scan')} />,
    scan: () => <ScanScreen scan={{ ...data.scan, improveProduct: improveProduct ?? data.scan.improveProduct }} back={back}
      onImproveProductChange={(checked) => void changeImproveProduct(checked)} onConfirmUpload={() => void confirmUpload(false)}
      consentError={consentError} consentSending={consentSending} preferenceError={preferenceError}
      onRetry={() => void retryScan()} retrying={retrying} retryError={retryError}
      // Never while "Try again" is starting the scan (the button is dimmed then too): a skip would leave that new scan
      // running behind a Reveal that says it was skipped.
      onSkip={() => { if (!retryPending.current) update({ scanSkipped: true }, 'reveal') }}
      onContinue={() => update({ scanReview: false }, 'reveal')} />,
    reveal: () => <RevealScreen agents={data.scan.agents} reveal={data.reveal} extraction={data.extraction} uploadedAgents={data.scan.uploadedAgents} recentPrompts={data.recentPrompts} hostedNotice={data.scan.hostedNotice}
      scanComplete={scanComplete} installedAgentCount={data.install?.status === 'ready' ? data.install.selection?.agents.length : undefined}
      skipped={flow.scanSkipped && !scanComplete} back={savingChoice ? null : back}
      onContinue={() => update({ revealContinued: true }, 'choice')} />,
    // An already-configured machine sees no choice here: the page has answered it (keptExistingChoice above), and
    // this says so while the installer takes it.
    choice: () => flow.alreadyPro ? (
      <section aria-labelledby="keep-existing-title">
        <PageHeading id="keep-existing-title" title={t('Keeping your existing configuration.')}
          lead={t('Memory stays on this computer, written by your internal model gateway.')} />
      </section>
    ) : <ChoiceScreen branch={flow.branch} saving={savingChoice} back={back} onChoose={(branch) => void submitChoice(branch)} />,
    'finish-setup': () => (
      <FinishSetupScreen tools={tools} selected={flow.finishTools} onSelect={(finishTools) => update({ finishTools })}
        back={back}
        onContinue={() => void finishSetup()} />
    ),
    // Legacy wire steps with no screens left: guardStep lands any request for them on Finish Setup.
    savings: () => screens['finish-setup'](),
    checkout: () => screens['finish-setup'](),
    import: () => screens['finish-setup'](),
    launch: () => <LaunchScreen tools={pickedTools} back={back} onDone={() => setRequested('workspace')} />,
    workspace: () => <WorkspaceScreen suggestions={data.suggestions} back={back} search={(query) => source!.search(query)} keepNote={(record, text) => source!.keepNote(record, text)} forgetNote={(id) => source!.forgetNote(id)} onContinue={() => void finishAll()} />,
  }

  const connectionFailure = connectionFailureAbove(data, step)

  return (
    <div className="cmem-setup" data-step={step}>
      <a className="skip" href="#setup-main">{t('Skip to content')}</a>
      <header className="setup-header">
        <span className="brand" role="img" aria-label="CMEM"><CmemMark /></span>
        <SetupStepBar step={step} flow={flowNow} />
        <div className="setup-header-actions">
          <select
            aria-label={t('Language')}
            value={locale}
            onChange={(e) => setLocale(e.target.value as Locale)}
            className="setup-lang-select"
          >
            {LOCALES.map((code) => <option key={code} value={code}>{LOCALE_NAMES[code]}</option>)}
          </select>
        </div>
      </header>
      <main id="setup-main" ref={main} tabIndex={-1} className={`setup-main step-${step}${['scan', 'reveal', 'choice', 'workspace'].includes(step) ? ' is-centered' : ''}`}>
        {/* Only on the screen the hand-off was sent from; "Try again" sends it again only when pressed. */}
        {handOffError?.step === step && (
          <SetupError title={t(handOffError.title)} failure={handOffError.failure}
            action={handOffError.retry && <SetupButton look="outline" busy={handOffRetrying} onClick={() => void retryHandOff()}>{t('Try again')}</SetupButton>} />
        )}
        {connectionFailure && <SetupError title={t('Couldn’t connect to the setup program.')} failure={connectionFailure} />}
        {installerFailed && (
          <SetupError title={t('Setup stopped.')} check={t('The setup program on this computer stopped before it finished. Retry setup to start it again.')}
            detail={data.installer?.error}
            action={<SetupButton look="outline" busy={retryingSetup} busyLabel={t('Retrying setup…')} onClick={() => void retrySetup()}>{t('Retry setup')}</SetupButton>} />
        )}
        {screens[step]()}
      </main>
    </div>
  )
}
