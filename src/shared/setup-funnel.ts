/** Closed, content-free contract for the local installer's actual screens. */
export const SETUP_STEPS = ['install', 'scan', 'reveal', 'choice', 'checkout', 'savings', 'finish-setup', 'import', 'launch', 'workspace'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

// The funnel's states as they cross between the installer, the worker and the setup page. Each has its one
// definition here, in the only module all three can load: the worker's files and request checks and the page's
// types use these, so a state added on one side cannot be missing on another.

/** Where memory lives: on this computer. The hosted `go` branch is gone from the local-only funnel; a saved state
 * with `branch: 'go'` is still read (setup-state.ts) and tolerated as keep-existing, never written again. */
export const SETUP_BRANCHES = ['home'] as const;
export type SetupBranch = (typeof SETUP_BRANCHES)[number];

/**
 * Who generates memories: the person's own provider. The hosted `go` funnel wrote `hosted`, and it stays in the
 * contract on purpose: states saved by older builds carry it, the lenient read (setup-state.ts) passes them through
 * untouched, and the choice route still accepts the value on the wire so an old page's replayed write is not 400'd
 * mid-setup. Nothing new writes it — this build's page and installer only ever send `existing` — and nothing reads
 * the billing beyond the choice lock's equality check, so the leniency costs nothing and keeps old clients working
 * through the upgrade. Narrowing the write check would be a worker-route behavior change (setup-state-routes.test
 * cements the acceptance), which this UI-only task does not make.
 */
export const SETUP_MEMORY_BILLINGS = ['hosted', 'existing'] as const;
export type SetupMemoryBilling = (typeof SETUP_MEMORY_BILLINGS)[number];

/**
 * What the installer has done with the browser's choice. The local-only funnel has no checkout, so every applied
 * choice ends at `home-ready`, or at `home-kept-existing` when the machine's existing configuration was kept.
 */
export const SETUP_INSTALLER_STAGES = ['waiting-for-choice', 'home-ready', 'home-kept-existing', 'failed'] as const;
export type SetupInstallerStage = (typeof SETUP_INSTALLER_STAGES)[number];

/** The funnel shows until `complete`, for new installs and upgrades alike. */
export type SetupStatus = 'pending' | 'complete';

/**
 * The prompt scan (services/prompt-import/setup-scan.ts, the only writer):
 *
 *   idle → reading → checking → saving ─┬→ awaiting-consent ─┬→ uploading → done
 *                                       │                    └→ done        (the person keeps the prompts local)
 *                                       ├→ uploading → done                 (no prompts, so nothing to ask about)
 *                                       └→ done                             (no extractor is set)
 *   saving → done (organizing, the work-view refresh, runs in the background afterwards: SetupScanState.organizing,
 *   a field on the state, not a phase — the wizard never waits for it)
 *   reading, checking, saving, awaiting-consent, uploading → failed
 *   done, failed → reading                                                  (the next start)
 *
 * `checking` is entered only when the transcript scan reports it.
 */
export type SetupScanPhase = 'idle' | 'reading' | 'checking' | 'saving' | 'awaiting-consent' | 'uploading' | 'done' | 'failed';

/**
 * The history upload (services/setup/history-import.ts, the only writer):
 *
 *   idle → running ─┬→ done
 *                   ├→ failed    (a batch could not be sent, or cmem.ai refused or did not acknowledge it)
 *                   └→ stopped   (the person pressed Stop: no request starts after it)
 *   done, failed, stopped → running   (only the person's next start; nothing restarts it by itself)
 *
 * A start that cannot read the database goes to `failed` without running.
 */
export const HISTORY_IMPORT_RUN_STATES = ['idle', 'running', 'stopped', 'done', 'failed'] as const;
export type HistoryImportRunState = (typeof HISTORY_IMPORT_RUN_STATES)[number];

/**
 * The rule callers ask: whether the upload is running, so it can still send to cmem.ai. The upload's own sender gates
 * each request on it (history-import.ts), and the worker's background-work report counts a running upload so the
 * installer holds its worker restart for it.
 */
export function historyImportRunning(state: HistoryImportRunState): boolean {
  return state === 'running';
}

/**
 * Observations in one request of the history upload, the most a request carries: small enough for one cmem.ai
 * serverless request each (the reason history-import.ts has given since the funnel shipped). One definition for that
 * upload's paging and its tests; the setup page has no import UI of its own any more.
 */
export const HISTORY_IMPORT_BATCH = 100;
/** Owner-approved cap on setup's one hosted upload: the largest measured export was 262 KB, and all exports fit one
 * 1M-context call. Cloud enforces this against both compressed and uncompressed bytes, plus its offline 400k-token
 * budget. One definition for the worker's refusal (hosted-intent.ts); the setup page no longer uploads. */
export const INTENT_MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const SETUP_ACTIONS = ['choose_memory', 'choice_committed', 'start_import', 'skip_import', 'retry_scan', 'upload_skipped'] as const;
export type SetupAction = (typeof SETUP_ACTIONS)[number];
export const SETUP_ERRORS = ['scan_failed', 'scan_retry_failed', 'upload_consent_failed', 'usage_preference_failed', 'choice_failed', 'installer_failed', 'import_failed', 'complete_failed'] as const;
export type SetupError = (typeof SETUP_ERRORS)[number];
export type SetupEventName = 'setup_step_viewed' | 'setup_step_transitioned' | 'setup_step_action' | 'setup_step_error' | 'setup_page_hidden' | 'setup_completed';
/**
 * Still 2: the local-only funnel reuses the v2 event schema field-for-field, so its analytics stay comparable with
 * the checkout-era funnels already recorded under this version, and v1 events keep validating. The version number
 * is a wire/telemetry contract, not a description of the current screens.
 */
export const SETUP_FUNNEL_VERSION = 2 as const;
export interface SetupEvent {
  event: SetupEventName;
  event_id: string;
  setup_flow_id: string;
  setup_funnel_version: 1 | typeof SETUP_FUNNEL_VERSION;
  visit_id: string;
  step: SetupStep;
  branch: SetupBranch;
  already_pro: boolean;
  branch_confirmed: boolean;
  occurred_at: number;
  to_step?: SetupStep | 'complete';
  direction?: 'forward' | 'back';
  action?: SetupAction;
  error_code?: SetupError;
}
export interface SetupTelemetryContext { setup_flow_id: string; already_pro: boolean }
export const isSetupId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const member = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === 'string' && values.includes(value as T);

/** Reject unknown keys rather than allowing prompts, URLs or errors to ride along. */
export function parseSetupEvent(value: unknown): SetupEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const base = ['event', 'event_id', 'setup_flow_id', 'setup_funnel_version', 'visit_id', 'step', 'branch', 'already_pro', 'branch_confirmed', 'occurred_at'];
  const extra = v.event === 'setup_step_transitioned' ? ['to_step', 'direction'] : v.event === 'setup_step_action' ? ['action'] : v.event === 'setup_step_error' ? ['error_code'] : [];
  if (!member(['setup_step_viewed', 'setup_step_transitioned', 'setup_step_action', 'setup_step_error', 'setup_page_hidden', 'setup_completed'], v.event)
    || Object.keys(v).some(key => !base.includes(key) && !extra.includes(key))
    || !isSetupId(v.event_id) || !isSetupId(v.setup_flow_id) || !isSetupId(v.visit_id)
    || (v.setup_funnel_version !== 1 && v.setup_funnel_version !== SETUP_FUNNEL_VERSION) || !member(SETUP_STEPS, v.step)
    || !member(SETUP_BRANCHES, v.branch) || typeof v.already_pro !== 'boolean' || typeof v.branch_confirmed !== 'boolean'
    || typeof v.occurred_at !== 'number' || !Number.isSafeInteger(v.occurred_at) || v.occurred_at <= 0) return null;
  if (v.event === 'setup_step_transitioned' && ((!member(SETUP_STEPS, v.to_step) && v.to_step !== 'complete') || !member(['forward', 'back'], v.direction) || v.to_step === v.step)) return null;
  if (v.event === 'setup_step_action' && !member(SETUP_ACTIONS, v.action)) return null;
  // A `cloud_sync_offer` key is no longer in the closed schema, so an event carrying one fails the unknown-key check above.
  if (v.event === 'setup_step_error' && !member(SETUP_ERRORS, v.error_code)) return null;
  if ((v.event === 'setup_completed' || v.to_step === 'complete') && (v.step !== 'workspace' || (v.to_step === 'complete' && v.direction !== 'forward'))) return null;
  return v as unknown as SetupEvent;
}
