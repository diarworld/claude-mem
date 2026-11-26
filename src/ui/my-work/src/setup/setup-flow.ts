// Storage choice: the local-only funnel has one branch, memory on this computer with the person's existing
// provider. The hosted/checkout branch and its screens are gone; the step machine below keeps the wire's step list.

import { SETUP_STEPS, type SetupBranch, type SetupInstallerStage, type SetupMemoryBilling, type SetupScanPhase, type SetupStep } from '../../../../shared/setup-funnel.ts'
export { SETUP_STEPS, type SetupStep }

export type MemoryBranch = SetupBranch
/** Who generates memories: the person's existing provider. */
export type MemoryBilling = SetupMemoryBilling

export interface SetupFlowState {
  /** Agent integrations must finish installing before the memory scan begins. */
  installationComplete: boolean
  /**
   * The worker said the installation is finished, or that this run has none. A first load that never reached the
   * worker lets the page show the stopped scan but leaves this false, so the step bar never ticks Tools on a guess.
   */
  installConfirmed: boolean
  /** The person went Back from the scan to look at the finished installation; Continue there returns to the scan. */
  installReview: boolean
  /**
   * The person went Back from the Reveal to look at the scan again. The scan screen then stays up (its Continue
   * returns to the Reveal) instead of moving on by itself, as it does the first time the scan finishes.
   */
  scanReview: boolean
  branch: MemoryBranch
  memoryBilling: MemoryBilling
  /** This machine already has a working configuration the funnel keeps (the page answers the choice for it). */
  alreadyPro: boolean
  /** The prompt scan finished without an error. */
  scanComplete: boolean
  /**
   * The person chose "Skip the scan" after it stopped. Only this page knows: nothing is sent, and the Reveal says the
   * step was skipped. (Skipping while the scan waits for the upload answer is the worker's own "keep it local" answer.)
   */
  scanSkipped: boolean
  revealContinued: boolean
  choiceContinued: boolean
  finishTools: string[]
  setupComplete: boolean
}

export function initialFlowState(alreadyPro: boolean): SetupFlowState {
  return {
    installationComplete: true, installConfirmed: true, installReview: false, scanReview: false, branch: 'home', memoryBilling: 'existing', alreadyPro, scanComplete: false, scanSkipped: false,
    revealContinued: false, choiceContinued: false, finishTools: [], setupComplete: false,
  }
}

/** The installer's report on the choice. */
export type InstallerStage = SetupInstallerStage

/** The installer has applied the choice: the worker refuses a different one for the rest of this installer run. */
export function choiceLocked(stage: InstallerStage | null | undefined): boolean {
  return !!stage && stage !== 'waiting-for-choice' && stage !== 'failed'
}

/** Restore the worker's committed storage choice without replacing a choice being edited in this visit. */
export function hydrateSetupChoice(state: SetupFlowState, saved: Pick<SetupFlowState, 'branch' | 'memoryBilling'> | null,
  locallyEdited: boolean, stage: InstallerStage | null | undefined): SetupFlowState {
  if (!saved || (locallyEdited && !choiceLocked(stage))
    || (state.branch === saved.branch && state.memoryBilling === saved.memoryBilling)) return state
  return { ...state, branch: saved.branch, memoryBilling: saved.memoryBilling }
}

const BEFORE_CHOICE: SetupStep[] = ['scan', 'reveal']

/** The scan is behind the person: it finished, or they chose to skip it after it stopped. */
export const scanPassed = (state: Pick<SetupFlowState, 'scanComplete' | 'scanSkipped'>) => state.scanComplete || state.scanSkipped

/**
 * Whether a finished scan moves the page on to the Reveal by itself: the same rule as before Phase 8, so the Reveal
 * opens (and its setup telemetry goes out) the moment the worker reports the scan done. Not when the person came Back
 * to look at the scan or at the installation: then the screen they asked for stays until they press Continue.
 */
export function scanMovesOn(requested: SetupStep, state: Pick<SetupFlowState, 'installationComplete' | 'scanComplete' | 'scanReview' | 'installReview'>): boolean {
  if (!state.installationComplete || !state.scanComplete) return false
  return (requested === 'scan' && !state.scanReview) || (requested === 'install' && !state.installReview)
}

/** The step to show for a requested step: an earlier one when a decision it depends on hasn't been made yet. */
export function guardStep(step: SetupStep, state: SetupFlowState): SetupStep {
  if (!state.installationComplete) return 'install'
  if (step === 'install') return state.installReview ? 'install' : scanPassed(state) ? 'reveal' : 'scan'
  if (!SETUP_STEPS.includes(step)) return 'scan'
  if (step !== 'scan' && !scanPassed(state) && !state.choiceContinued) return 'scan'
  if (!BEFORE_CHOICE.includes(step) && !state.revealContinued) return 'reveal'
  if (![...BEFORE_CHOICE, 'choice'].includes(step) && !state.choiceContinued) return 'choice'
  // 'checkout', 'savings' and 'import' remain wire steps (old telemetry still names them) with no screens left:
  // the choice goes on to Finish Setup, so a request for any of them lands there.
  if (step === 'checkout' || step === 'savings' || step === 'import') return 'finish-setup'
  if ((step === 'launch' || step === 'workspace') && (!state.setupComplete || state.finishTools.length === 0)) return 'finish-setup'
  return step
}

/**
 * The five steps the step bar shows on every screen, in order (plan Phase 8, replacing the old bar's "Memory",
 * "Token Savings", "Checkout", "Finish Setup"). The one definition: the bar, its words and the tests take it from here.
 */
export const SETUP_PROGRESS_STEPS = ['tools', 'memory', 'plan', 'connect', 'done'] as const
export type SetupProgressStep = (typeof SETUP_PROGRESS_STEPS)[number]

/** Each bar step's name, as the bar shows it (the English text is the catalog key; the bar translates it). */
export const PROGRESS_STEP_WORDS: Record<SetupProgressStep, string> = {
  tools: 'Tools', memory: 'Memory', plan: 'Plan', connect: 'Connect', done: 'Done',
}

/** Which bar step each screen belongs to. */
export const PROGRESS_STEP_OF_SCREEN: Record<SetupStep, SetupProgressStep> = {
  install: 'tools',
  scan: 'memory', reveal: 'memory',
  choice: 'plan', savings: 'plan', checkout: 'plan',
  'finish-setup': 'connect', import: 'connect',
  launch: 'done', workspace: 'done',
}

/**
 * How a bar step reads. The bar is drawn from the screen and the flow state, so it has no writer of its own:
 *   upcoming → current (its first screen shows) → done (the person finished it), and back to current on Back.
 * The one definition: the bar's words and the tests take the list from here.
 */
export const SETUP_PROGRESS_STATES = ['done', 'current', 'upcoming'] as const
export type SetupProgressState = (typeof SETUP_PROGRESS_STATES)[number]

/** When the person has finished each bar step. A step is ticked only after the person has done it. */
const PROGRESS_STEP_DONE: Record<SetupProgressStep, (state: SetupFlowState) => boolean> = {
  // Only the worker's word: a page that could not reach it does not know the tools were installed.
  tools: (state) => state.installConfirmed,
  memory: (state) => state.revealContinued,
  // The choice always moves on to Finish Setup now, so committing it finishes the Plan step.
  plan: (state) => state.choiceContinued,
  connect: (state) => state.setupComplete,
  // The page leaves setup when the last step is done, so the bar never shows it ticked.
  done: () => false,
}

export function progressStepState(item: SetupProgressStep, screen: SetupStep, state: SetupFlowState): SetupProgressState {
  if (PROGRESS_STEP_OF_SCREEN[screen] === item) return 'current'
  return PROGRESS_STEP_DONE[item](state) ? 'done' : 'upcoming'
}

/** What decides where Back goes, beyond the flow state. */
export interface SetupBackFacts {
  /** This run started at the install screen (the installer asked the browser to choose the tools). */
  hasInstallStep: boolean
  /** The choice was applied. */
  choiceLocked: boolean
}

/** Back's target from each screen: the screen before it on this person's path, or null where there is none. */
const PREVIOUS_STEP: Record<SetupStep, (state: SetupFlowState, facts: SetupBackFacts) => SetupStep | null> = {
  // The first screen: nothing comes before it.
  install: () => null,
  // The finished installation can be looked at again (read-only); without an install screen the scan comes first.
  scan: (_, facts) => facts.hasInstallStep ? 'install' : null,
  reveal: () => 'scan',
  choice: () => 'reveal',
  // Legacy wire steps with no screens left; Back from them (never shown) points where the choice was.
  savings: () => 'choice',
  checkout: (_, facts) => facts.choiceLocked ? null : 'choice',
  'finish-setup': (_, facts) => facts.choiceLocked ? null : 'choice',
  import: () => 'finish-setup',
  // Launch only plays on the way forward; Back from either end of it returns to Finish Setup.
  launch: () => 'finish-setup',
  workspace: () => 'finish-setup',
}

/** Where Back goes from `step` (passed through guardStep by the page like any request), or null to hide Back. */
export function previousStep(step: SetupStep, state: SetupFlowState, facts: SetupBackFacts): SetupStep | null {
  return PREVIOUS_STEP[step](state, facts)
}

/**
 * Which scan phases count as running, one entry per phase of the worker's scan (setup-funnel.ts), so a new phase fails
 * the typecheck here until someone decides whether Back and the page wait for it. Awaiting the upload answer, done
 * and failed all wait for the person.
 */
export const SCAN_PHASE_RUNNING: Record<SetupScanPhase, boolean> = {
  idle: true, reading: true, checking: true, saving: true, organizing: true, 'awaiting-consent': false, uploading: true, done: false, failed: false,
}

/** The rule callers ask: whether the scan is running in `phase`. */
export function scanRunning(phase: SetupScanPhase): boolean {
  return SCAN_PHASE_RUNNING[phase]
}

/**
 * What a dimmed Back waits for (plan Phase 8: "disabled with a reason while a scan runs"); null when Back
 * can be pressed. The screens word it. (The import screen went with the page-flow import UI; a Back that
 * cannot be shown never waits.)
 */
export type SetupBackWait = 'scan'

export function backWaitsFor(step: SetupStep, scanPhase: SetupScanPhase): SetupBackWait | null {
  if (step === 'scan' && scanRunning(scanPhase)) return 'scan'
  return null
}

/**
 * The launch's timings before Phase 8 (HEAD launch-screen.tsx, from the PROTO's `animateLaunch`): each picked tool flew
 * into the logo in 1,500 ms, each one 80 ms after the one before it, and the logo folded in 1,950 ms. They are kept so
 * the workspace step, and the setup telemetry its change sends, arrive when they did (plan Phase 8 guard: never change
 * when a setup request is sent).
 */
export const LAUNCH_LOGO_MS = 1950
export const LAUNCH_TOOL_MS = 1500
export const LAUNCH_TOOL_STAGGER_MS = 80

/**
 * How long the launch plays before the workspace opens: until the last of those animations ended, so
 * max(1,950, 1,500 + 80 × (tools − 1)) ms. The logo is last up to six tools; from seven on, the last tool is.
 */
export function launchLengthMs(toolCount: number): number {
  return Math.max(LAUNCH_LOGO_MS, LAUNCH_TOOL_MS + LAUNCH_TOOL_STAGGER_MS * Math.max(0, toolCount - 1))
}
