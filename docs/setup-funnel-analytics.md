# Local setup funnel

Start the funnel at the local `install` screen shown by `npx claude-mem install`
at `/?setup=1`. Count unique setup attempts that render each screen.

The installer creates a
fresh UUIDv4 `setup_flow_id` for each browser setup attempt and saves it with
the live setup session. All events use `setup:<UUID>` as their PostHog distinct
ID. This identity is separate from the worker's persistent anonymous ID.
Current telemetry consent is checked on every worker request and capture.
The flow ID never leaves the local setup session: the installer starts no
OAuth pairing any more, and the pairing client a `teambrain join` uses rejects
a claim URL that still names one. Sample previews never request a telemetry
context or emit events.

## Screens and branches

The local-only funnel walks the home branch only:
`install → scan → reveal → choice → finish-setup → launch → workspace`.
There is no checkout, no savings screen and no hosted-plans offer. Reduced
motion skips `launch` and moves directly to `workspace`.

- `already_pro` records whether the machine had a Cloud configuration at the
  start of the attempt. Use `action = choice_committed` to count explicit
  choices; a machine whose working configuration is kept answers the choice
  itself (`home-kept-existing`) and continues to Finish Setup. Flows without a
  confirmed choice remain undecided.
- Finish Setup lists the tools the install step connected. The import screen of
  older releases is gone from the page; the history upload remains a
  worker-side step, and `start_import` / `skip_import` stay valid action codes
  for events recorded by older releases.
- A return to a screen creates a fresh visit. A hidden tab does not.

Historical version notes. `setup_funnel_version = 2` starts with installer
16.1.1 and its event schema is unchanged, so events from the checkout-era
funnels keep validating and stay comparable:

- Version 2 as released walked
  `install → scan → reveal → checkout → savings → finish-setup → launch → workspace`.
  The trial button on Reveal opened checkout, `cloud_sync_offer` counted
  monthly or annual selections, and the savings screen recorded
  `action = view_hosted_plans` when someone opened the optional hosted
  generation plans. This build emits and renders none of those steps or
  actions, but the closed schema still accepts them.
- Version 1 placed `choice → savings → checkout` after Reveal and committed
  the choice on Savings. Compare releases using the version on local setup
  events. Attribute server checkout and Stripe trial outcomes by
  `setup_flow_id`, even when server events use their own version. Count a
  monthly trial when Stripe confirms the selected monthly subscription entered
  its trial. Keep annual purchases and unattributed outcomes separate.

## Events

Every event includes `setup_flow_id`, `setup_funnel_version`, `event_id`,
`visit_id`, `step`, `branch`, `already_pro`, and `branch_confirmed`. The worker
uses the captured event time for PostHog's timestamp. Identifiers are random;
no prompts, paths, URLs, tokens, selected tool lists, or exception text are sent.

- `setup_step_viewed`: a screen actually rendered, with a new `visit_id`.
- `setup_step_transitioned`: the originating visit plus `to_step` and
  `direction: forward | back`. Each visit has at most one exit.
- `setup_step_action`: a closed action code, including `choice_committed`,
  `choose_memory`, `start_import`, `skip_import`, `retry_scan`,
  `upload_allowed`, and `upload_skipped`.
- `setup_step_error`: a closed `error_code`; never the error message.
- `setup_page_hidden`: the browser left or hid the page. It does not prove
  abandonment or its cause.
- `setup_completed`: emitted with `workspace → complete` only after the worker
  successfully saves setup completion. Both retain the workspace visit ID.

Count distinct visits on `setup_step_viewed`, then join the first transition
by flow and originating visit ID. Group progression by the view's date, not
the transition date. Unknown means no next step was recorded; do not label it
a cancellation. Keep the shared pre-choice trunk and the kept-existing path
separate, and never count skipped optional screens as failures. Setup
completion proves the state was saved, nothing beyond it.

The worker accepts events only from its same-origin local UI and validates
every property. Structural events bypass daily aggregation so visit joins
remain possible. Completion travels with the successful completion request,
before the installer can remove its session or restart the worker.
Unacknowledged events (up to 200) accompany completion as one validated batch,
so a slow local telemetry request cannot leave a recorded completion without
its screen visits. Event IDs deduplicate that batch against concurrent sends.
Temporary context-read failures retry without delaying setup; an explicit
disabled/no-session response stops the retry loop.

Tests: `bun test tests/telemetry/setup-funnel.test.ts
tests/worker/http/routes/setup-telemetry-routes.test.ts
src/ui/my-work/src/setup/setup-telemetry.test.ts` plus the existing setup and
installer tests. After release, verify real events from a consenting installer.
