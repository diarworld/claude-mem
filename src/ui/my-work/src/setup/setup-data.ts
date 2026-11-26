import { SETUP_TOOLS, type SetupTool } from './agent-connections'
// What the funnel screens show. Every screen reads it through props; nothing here is made up.
// The live source fills it from the worker (prompt scan, extraction, setup state); `?source=sample` loads
// setup-sample.ts instead, and only then.
import { choiceLocked } from './setup-flow'
import { revealFromSnapshot, type SnapshotWithSetup, type WorkerExtraction } from './setup-reveal'
import { noteFor, searchUrl, toMemoryResults, type MemoryResult, type WorkerSearchResult } from './setup-search'
import { applySseFrame } from '../live/parse-sse-frame'
import { type SetupBranch, type SetupEvent, type SetupMemoryBilling, type SetupScanPhase, type SetupStatus } from '../../../../shared/setup-funnel.ts'
import { hasPendingInstallSetup, type SetupInstallSelection, type SetupInstallState } from '../../../../shared/setup-install.ts'

/** Mirrors the worker's SetupScanState (src/services/prompt-import/setup-scan.ts), trimmed to what the screen shows. */
export interface SetupScanAgent {
  id: string; label: string; detected: boolean; prompts: number
  /** Whether the agent can run setup's extraction here (the worker's agent detection); `null` when unknown or not a runner. */
  canRunSetup: boolean | null
  /** Why it cannot, e.g. "Gemini is installed, but this Google account can't use it: ...". */
  cannotRunReason: string | null
  /** The JSON bytes this tool's prompts would add to the hosted upload; 0 from an older worker. The page never uploads. */
  uploadBytes: number
}

export type { SetupScanPhase }
/** The worker's background organizing after a finished scan (SetupScanState.organizing), trimmed to what the screen shows. */
export interface SetupScanOrganizing {
  state: 'running' | 'done' | 'failed'
  /** The refresh step now asking its agent ('goals', 'grouping', 'review', …); null between steps. */
  step: string | null
  /** Units of the current step already started; null when the step has no count. */
  batchDone: number | null
  /** Units the step will ask in total; null when unknown before it starts packing its batches. */
  batchTotal: number | null
  /** Why organizing stopped; null while it runs or finished. */
  error: string | null
}
export interface SetupScanView {
  agents: SetupScanAgent[]; percent: number; phase: SetupScanPhase; done: boolean; error: string | null; improveProduct: boolean
  /** Set only when this page's own request to read or start the scan failed; the worker's scan state never has it. */
  errorKind?: SetupFailureKind
  /** Why hosted extraction was skipped (budget/rate limit) while setup finished locally. */
  hostedNotice?: string | null
  /** Which tools' prompts ever left this machine: null before the scan's upload hold was answered, [] when nothing left. */
  uploadedAgents: string[] | null
  /** The background organizing that follows a finished scan, live while the scan screen is up. Absent or null from an older worker, or when this scan started none. */
  organizing?: SetupScanOrganizing | null
}
/** The owner's newest typed prompts, quoted as typed (SetupScanState.recentPrompts). */
export interface SetupRecentPrompt { agent: string; at: string; text: string }
/** What the installer did with the choice. A failed handoff can be retried from the setup page. */
export interface SetupInstallerView { stage: InstallerStage; error: string | null }
export type SetupExtraction = Pick<WorkerExtraction, 'state' | 'step'>

export type { RevealGoal, RevealRule, RevealSets, RevealWork } from './setup-reveal'
import type { RevealSets } from './setup-reveal'
import type { InstallerStage, SetupStep } from './setup-flow'

/**
 * Why something the page asked of the worker failed, as the page words it (plan G17): no answer arrived at all (the
 * worker is down or restarting), the worker answered and refused, or the page itself failed, before or after asking
 * (it is not connected, or it could not read the answer). The one definition; the screens' words are a Record over it.
 */
export type SetupFailureKind = 'unreachable' | 'refused' | 'page'

/** A failed request whose kind is known. `message` keeps the browser's or the worker's own words, for the Details fold. */
export class SetupRequestError extends Error {
  kind: SetupFailureKind
  constructor(kind: SetupFailureKind, message: string) {
    super(message)
    this.name = 'SetupRequestError'
    this.kind = kind
  }
}

/** A failure as a screen shows it: plain words chosen by `kind`, and the raw `detail` folded under Details. */
export interface SetupFailure { kind: SetupFailureKind; detail: string }

/**
 * Anything thrown while talking to the worker. Only a request that says so is "unreachable" or "refused"; any other
 * error came from the page itself, so its words never claim that claude-mem answered.
 */
export function toSetupFailure(error: unknown): SetupFailure {
  return { kind: error instanceof SetupRequestError ? error.kind : 'page', detail: error instanceof Error ? error.message : String(error) }
}

export type { MemoryResult } from './setup-search'

export interface SetupData {
  connectionError: string | null
  /** Whether the connection error got no answer at all or a refusal; null with no error. */
  connectionErrorKind: SetupFailureKind | null
  choice: SetupChoice | null
  /** Undefined until the first state response; null for older/already configured installers. */
  install: SetupInstallState | null | undefined
  scan: SetupScanView
  reveal: RevealSets
  /** `null` until the worker reports a run. Older workers may still report waiting-for-agent. */
  extraction: SetupExtraction | null
  recentPrompts: SetupRecentPrompt[]
  /** `null` until an installer reports. */
  installer: SetupInstallerView | null
  alreadyPro: boolean
  /** Finish Setup tool ids found on this machine; they come pre-ticked. */
  detectedTools: string[]
  /** "What's next?" chips, from the person's own goals and open asks. */
  suggestions: string[]
}

/** The storage plan explicitly selected in the installer. */
export interface SetupChoice { branch: SetupBranch; memoryBilling: SetupMemoryBilling }

export interface SetupSource {
  readonly kind: 'local' | 'sample'
  subscribe(onData: (data: SetupData) => void): () => void
  /** Explicitly retries a stopped installation; first-use resume never carries this intent. */
  resume(): Promise<void>
  configureInstall(selection: SetupInstallSelection): Promise<void>
  /** Starts another scan only after the user chooses to retry a failure. */
  retryScan(): Promise<void>
  /** Changes the hosted setup results preference without pausing the scan or upload. */
  setImproveProduct(improveProduct: boolean): Promise<void>
  /** Answers the worker's upload hold. This page always declines (the scan stays local); the sample keeps the
   * worker's full answer contract so design previews can still play both sides. */
  confirmUpload(upload: boolean, agents?: string[], improveProduct?: boolean): Promise<void>
  /** Hands the storage choice to the installer waiting in the terminal (POST /api/setup/choice). */
  choose(choice: SetupChoice): Promise<void>
  /** Finishes setup for this machine with the tools picked on Finish Setup; the terminal exits (POST /api/setup/complete). */
  complete(tools: string[], telemetry?: SetupEvent[]): Promise<void>
  search(query: string): Promise<MemoryResult[]>
  /** Keep as note: saves `text` as a new memory (POST /api/memory/save) and answers its observation id. */
  keepNote(record: MemoryResult, text: string): Promise<number>
  /** Removes a note this page saved, once its edited copy is saved (DELETE /api/observation/:id). */
  forgetNote(id: number): Promise<void>
}

export const EMPTY_SETUP_DATA: SetupData = {
  connectionError: null,
  connectionErrorKind: null,
  choice: null,
  install: undefined,
  scan: { agents: [], percent: 0, phase: 'idle', done: false, error: null, improveProduct: true, uploadedAgents: null },
  reveal: { goals: null, work: null, rules: null, focusAreas: null, requests: [], requestReadErrorCount: 0 },
  extraction: null,
  recentPrompts: [],
  installer: null,
  alreadyPro: false,
  detectedTools: [],
  suggestions: [],
}

/**
 * The connection failure the page shows above the screen, or null. The first load's failure is also the stopped
 * scan's own failure: while the scan screen shows that stop, the page says it there instead, once.
 */
export function connectionFailureAbove(data: Pick<SetupData, 'connectionError' | 'connectionErrorKind' | 'scan'>, step: SetupStep): SetupFailure | null {
  if (data.connectionError === null) return null
  if (step === 'scan' && data.scan.phase === 'failed' && data.scan.error === data.connectionError) return null
  // Every writer sets the kind with the error; without one the page's own state is off, which is the "page" words.
  return { kind: data.connectionErrorKind ?? 'page', detail: data.connectionError }
}

/** The worker's answers, trimmed to what this file reads. `errorKind` is the page's own: the worker never sends it. */
interface WorkerScanState extends Omit<SetupScanView, 'agents' | 'improveProduct' | 'uploadedAgents' | 'hostedNotice' | 'errorKind'> {
  hostedNotice?: string | null
  /** Older workers upload without asking and do not send this. */
  uploadedAgents?: string[] | null
  /** Older workers do not send the hosted setup preference. */
  improveProduct?: boolean
  /** An older worker sends no canRunSetup / cannotRunReason / uploadBytes. */
  agents: Array<Omit<SetupScanAgent, 'canRunSetup' | 'cannotRunReason' | 'uploadBytes'> & Partial<Pick<SetupScanAgent, 'canRunSetup' | 'cannotRunReason' | 'uploadBytes'>> & { fromMemory?: number; fromTranscripts?: number }>
  recentPrompts?: SetupRecentPrompt[]
}
interface WorkerSetupState {
  choice?: SetupData['choice']
  install?: SetupInstallState | null
  status: SetupStatus; alreadyPro: boolean
  installer?: SetupInstallerView | null
}

async function workerJson<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response
  // fetch rejects only when no answer arrived; the browser's own words ("Failed to fetch") go to the Details fold.
  try { response = await fetch(url, { cache: 'no-store', ...init }) } catch (error) {
    throw new SetupRequestError('unreachable', error instanceof Error ? error.message : String(error))
  }
  let answer: unknown = null
  try { answer = await response.json() } catch { /* A body that isn't JSON leaves only the status to report. */ }
  if (!response.ok) {
    const reason = (answer as { error?: unknown } | null)?.error
    throw new SetupRequestError('refused', typeof reason === 'string' ? reason : `The worker answered ${response.status} for ${url}.`)
  }
  return answer as T
}
const postJson = <T>(url: string, body: unknown) => workerJson<T>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

/** Whether this machine still has the funnel to go through. A worker without the endpoint (older) has nothing to show. */
export async function setupPending(): Promise<boolean> {
  const response = await fetch('/api/setup/state', { cache: 'no-store' })
  if (!response.ok) return false
  const state = await response.json() as WorkerSetupState
  return hasPendingInstallSetup(state)
}

const toScanView = (scan: WorkerScanState): SetupScanView => ({
  agents: scan.agents.map(({ id, label, detected, prompts, uploadBytes }) => ({
    // Agent login is irrelevant to hosted setup; the transcript scan only reports which tools were found.
    id, label, detected, prompts, canRunSetup: null, cannotRunReason: null, uploadBytes: uploadBytes ?? 0,
  })),
  percent: scan.percent, phase: scan.phase, done: scan.done, error: scan.error, improveProduct: scan.improveProduct ?? true,
  uploadedAgents: scan.uploadedAgents ?? null, hostedNotice: scan.hostedNotice ?? null, organizing: scan.organizing ?? null,
})

// Keep rapid checkbox changes in click order; scan and upload never wait on this queue.
let preferenceWrite: Promise<unknown> = Promise.resolve()
let desiredImproveProduct: boolean | undefined
let appliedImproveProduct: boolean | undefined
let preferenceReady: Promise<void> = Promise.resolve()
let retryLocalScan: (() => Promise<void>) | null = null
let acknowledgeInstallConnection: (() => void) | null = null

/**
 * The local worker: the prompt scan (started here when it has not run, then followed on the work view's event
 * stream), the setup state, and the Reveal's sets from the work view snapshot.
 */
export const localSetupSource: SetupSource = {
  kind: 'local',
  subscribe(onData) {
    let data = EMPTY_SETUP_DATA
    let closed = false
    let scanRevision = 0
    let stateRevision = 0
    let ready!: () => void
    preferenceReady = new Promise<void>((resolve) => { ready = resolve })
    const publish = (changes: Partial<SetupData>) => { if (closed) return; data = { ...data, ...changes }; onData(data) }
    const applyScan = (scan: WorkerScanState) => {
      scanRevision++
      appliedImproveProduct = scan.improveProduct ?? true
      publish({
        scan: toScanView(scan),
        recentPrompts: scan.recentPrompts ?? [],
        // Finish Setup pre-ticks the tools the scan found on this machine.
        detectedTools: scan.agents.filter((agent) => agent.detected).map((agent) => agent.id).filter((id) => SETUP_TOOLS.some((tool) => tool.id === id)),
      })
    }
    const applyState = (state: WorkerSetupState) => {
      stateRevision++
      publish({
      connectionError: null,
      connectionErrorKind: null,
      choice: state.choice ?? null,
      install: state.install ?? null,
      alreadyPro: state.alreadyPro,
      installer: state.installer ? { stage: state.installer.stage, error: state.installer.error } : null,
      })
      void ensureScanStarted()
    }
    // Goals, work and rules land in the work view snapshot as the extraction saves each one.
    const applySnapshot = (snapshot: SnapshotWithSetup) => {
      const extraction = snapshot.setup?.extraction ?? null
      const goals = snapshot.goals ? [...snapshot.goals.areas, ...snapshot.goals.asks].map((item) => item.title) : []
      publish({
        reveal: revealFromSnapshot(snapshot),
        extraction: extraction && { state: extraction.state, step: extraction.step },
        // "What's next?" chips: the person's own goals and open asks.
        suggestions: [...new Set(goals)].slice(0, 4),
      })
    }
    onData(data)
    const stream = new EventSource('/api/work-view/events')
    // A frame that is not a JSON object is skipped with a warning, not thrown:
    // these listeners run outside React's error boundaries (see parseSseFrame).
    const onFrame = <T>(event: Event, apply: (frame: T) => void, isShaped: (frame: Record<string, unknown>) => boolean = () => true): void => {
      applySseFrame(event.type, (event as MessageEvent<string>).data, apply, isShaped)
    }
    // applyScan reads scan.agents, so a scan frame without that list is skipped.
    stream.addEventListener('setup-scan', (event) => onFrame<WorkerScanState>(event, applyScan, (frame) => Array.isArray(frame.agents)))
    stream.addEventListener('setup-state', (event) => onFrame<WorkerSetupState>(event, applyState))
    stream.addEventListener('work-view', (event) => onFrame<SnapshotWithSetup>(event, applySnapshot, (frame) =>
      Array.isArray(frame.humanRequests) && Array.isArray(frame.agents)
      && typeof (frame.source as { connected?: unknown } | null)?.connected === 'boolean'))
    const startScan = async () => {
      const revision = scanRevision
      const started = await postJson<WorkerScanState>('/api/setup/scan', desiredImproveProduct === undefined ? {} : { improveProduct: desiredImproveProduct })
      if (!closed && scanRevision === revision) applyScan(started)
    }
    let initialScanLoaded = false
    let startingScan = false
    const ensureScanStarted = async () => {
      if (!initialScanLoaded || startingScan || closed || data.scan.phase !== 'idle'
        || (data.choice && choiceLocked(data.installer?.stage))
        || data.install === undefined || (data.install && data.install.status !== 'ready')) return
      startingScan = true
      try { await startScan() }
      catch (error) {
        const failure = toSetupFailure(error)
        if (!closed) publish({ scan: { ...data.scan, phase: 'failed', error: failure.detail, errorKind: failure.kind } })
      }
      finally { startingScan = false }
    }
    const acknowledgeConnection = () => {
      publish({ connectionError: null, connectionErrorKind: null })
      void ensureScanStarted()
    }
    acknowledgeInstallConnection = acknowledgeConnection
    // Retrying may repeat hosted extraction, so only the page's explicit action invokes this.
    retryLocalScan = startScan
    let requestedAtRevision = scanRevision
    const requestedStateRevision = stateRevision
    void (async () => {
      const [scan, state] = await Promise.all([workerJson<WorkerScanState>('/api/setup/scan'), workerJson<WorkerSetupState>('/api/setup/state')])
      if (closed) return
      if (stateRevision === requestedStateRevision) applyState(state)
      // The event stream can advance while GET or POST is in flight. Never restore an older phase or preference.
      if (scanRevision === requestedAtRevision) applyScan(scan)
      initialScanLoaded = true
      requestedAtRevision = scanRevision
      // A failed installer connection is not a failed scan. Keep the actual scan
      // state so an explicit retry can continue as soon as installation is ready.
      if (hasPendingInstallSetup(state)) {
        try { await postJson('/api/setup/resume', {}) }
        catch (error) {
          const failure = toSetupFailure(error)
          if (!closed) publish({ connectionError: failure.detail, connectionErrorKind: failure.kind })
        }
      }
      await ensureScanStarted()
    })().catch((error: unknown) => {
      // A late startup error must not replace progress or results already received from the stream.
      if (!closed && (scanRevision === requestedAtRevision || data.scan.phase === 'idle')) {
        const failure = toSetupFailure(error)
        // The page shows this once: in the stopped scan when the scan screen is up, otherwise above the heading.
        // `install` stays as the worker last said (undefined when it never answered): the page shows the stopped scan
        // without claiming the installation finished.
        publish({ connectionError: failure.detail, connectionErrorKind: failure.kind, scan: { ...data.scan, phase: 'failed', error: failure.detail, errorKind: failure.kind } })
      }
    }).finally(ready)
    return () => {
      closed = true
      if (retryLocalScan === startScan) retryLocalScan = null
      if (acknowledgeInstallConnection === acknowledgeConnection) acknowledgeInstallConnection = null
      stream.close()
      ready()
    }
  },
  async resume() { await postJson('/api/setup/resume', { retry: true }); acknowledgeInstallConnection?.() },
  async configureInstall(selection) { await postJson('/api/setup/install', selection); acknowledgeInstallConnection?.() },
  async retryScan() {
    // Nothing was sent: the page has no connection to start from, so its words are the page's own (reload).
    if (!retryLocalScan) throw new SetupRequestError('page', 'The setup page is not connected to the worker. Reload it to try again.')
    await retryLocalScan()
  },
  async setImproveProduct(improveProduct) {
    desiredImproveProduct = improveProduct
    const initialized = preferenceReady
    const write = preferenceWrite.then(async () => {
      // Buffer early clicks until GET/start establishes the scan. It starts with the latest choice
      // immediately; an older preference request must not arrive later and overwrite that choice.
      await initialized
      // Start may already have accepted this value; a redundant POST after upload would report a false failure.
      if (desiredImproveProduct === improveProduct && appliedImproveProduct !== improveProduct) {
        const scan = await postJson<WorkerScanState>('/api/setup/scan/preferences', { improveProduct })
        appliedImproveProduct = scan.improveProduct ?? improveProduct
      }
    })
    preferenceWrite = write.catch(() => {})
    await write
  },
  async confirmUpload(upload, agents, improveProduct) { await postJson('/api/setup/scan/consent', { upload, ...(agents ? { agents } : {}), ...(improveProduct === undefined ? {} : { improveProduct }) }) },
  async choose(choice) { await postJson('/api/setup/choice', choice) },
  async complete(tools, telemetry) { await postJson('/api/setup/complete', { tools, ...(telemetry?.length ? { telemetry } : {}) }) },
  async search(query) { return toMemoryResults(await workerJson<WorkerSearchResult>(searchUrl(query))) },
  async keepNote(record, text) {
    const saved = await postJson<{ success?: boolean; id?: unknown; reason?: unknown }>('/api/memory/save', noteFor(record, text))
    // The worker answered, but without a saved note: a refusal in the page's words.
    if (saved.success !== true || typeof saved.id !== 'number') throw new SetupRequestError('refused', `The note was not saved${typeof saved.reason === 'string' ? `: ${saved.reason}` : '.'}`)
    return saved.id
  },
  async forgetNote(id) { await workerJson(`/api/observation/${id}`, { method: 'DELETE' }) },
}

export { SETUP_TOOLS, type SetupTool } from './agent-connections'

/** The install selection is authoritative; cloud readers remain an optional next step. */
export function setupToolsForInstall(install: SetupInstallState | null | undefined): SetupTool[] {
  if (!install?.selection) return SETUP_TOOLS
  const local = install.catalog.agents.filter(agent => install.selection!.agents.includes(agent.id)).map((agent): SetupTool => ({
    id: agent.id, name: agent.label, kind: 'local', installed: true,
  }))
  return [...local, ...SETUP_TOOLS.filter(tool => tool.kind === 'cloud')]
}
