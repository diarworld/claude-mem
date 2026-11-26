import { ArrowRightIcon, CheckIcon } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { interpolate, useI18n } from '@/lib/i18n'
import type { MemoryBranch } from '../setup-flow'
import type { SetupIntegrationsSave, SetupIntegrationsView } from '../setup-data'
import atHome from '../assets/at-home-modern-computer.webp'
import { PageHeading, SetupActions, SetupButton, type SetupBack } from './shared'

/**
 * Step 3: where the memory lives (PROTO #route-choice). The local-only funnel has one card to confirm; the On The Go
 * card, its offers and its orbit of agents went with the hosted funnel. The one radio stays real (E13) so the
 * confirmed choice reads the same as it did, and the copy says the one answer instead of pricing a plan.
 *
 * Below the card sit the machine's two integrations blocks (the internal model gateway's key and the S3 Sync
 * enable). They ride the same submit: the page saves them before it hands the choice to the installer, so one
 * Continue both stores them and moves on. Nothing here pre-fills a secret — the key and the bucket credentials
 * start empty even when one is stored, and a stored key only says that it is stored.
 */
export function ChoiceScreen({ branch, integrations = null, saving = false, back, onChoose }: {
  branch: MemoryBranch
  /** The worker's prefill; null before the first state response or from an older worker (empty fields, no hint). */
  integrations?: SetupIntegrationsView | null
  saving?: boolean
  back?: SetupBack | null
  onChoose: (branch: MemoryBranch, integrations: SetupIntegrationsSave | null) => void
}) {
  const { t } = useI18n()
  // The choice step only opens after a state response, so the prefill is present at mount. Field state starts
  // once and then belongs to the person: a later state broadcast never rewrites what they typed.
  const [gatewayKey, setGatewayKey] = useState('')
  const [gatewayEndpoint, setGatewayEndpoint] = useState(() => integrations?.openRouterBaseUrl ?? '')
  const [s3On, setS3On] = useState(() => integrations?.s3.enabled ?? false)
  const [s3Endpoint, setS3Endpoint] = useState(() => integrations?.s3.endpoint ?? '')
  const [s3Bucket, setS3Bucket] = useState(() => integrations?.s3.bucket ?? '')
  const [s3Region, setS3Region] = useState(() => integrations?.s3.region ?? '')
  const [s3AccessKey, setS3AccessKey] = useState('')
  const [s3Secret, setS3Secret] = useState('')

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const request: SetupIntegrationsSave = {}
    // The key is sent only when typed; the endpoint only when it differs from what is stored — a blank one lets
    // the worker fill its installed default, so the URL is never hardcoded here.
    if (gatewayKey.trim()) request.gpuStackApiKey = gatewayKey.trim()
    if (gatewayEndpoint.trim() && gatewayEndpoint.trim() !== (integrations?.openRouterBaseUrl ?? '')) request.gpuStackEndpoint = gatewayEndpoint.trim()
    // The S3 block rides along when it was touched (the toggle, a field, or a credential); its endpoint, bucket
    // and region always travel together so the worker validates what the person actually sees in the form.
    if (s3On || s3Endpoint.trim() !== (integrations?.s3.endpoint ?? '') || s3Bucket.trim() !== (integrations?.s3.bucket ?? '')
      || s3Region.trim() !== (integrations?.s3.region ?? '') || s3AccessKey.trim() || s3Secret.trim()) {
      request.s3Sync = {
        enabled: s3On,
        endpoint: s3Endpoint.trim(),
        bucket: s3Bucket.trim(),
        region: s3Region.trim(),
        ...(s3AccessKey.trim() ? { accessKeyId: s3AccessKey.trim() } : {}),
        ...(s3Secret.trim() ? { secretAccessKey: s3Secret.trim() } : {}),
      }
    }
    onChoose('home', Object.keys(request).length > 0 ? request : null)
  }

  const savedKeyMask = integrations?.openRouterKeyMasked ?? ''
  return (
    <section aria-labelledby="choice-title">
      <PageHeading id="choice-title" title={t('Where your memory lives')} />
      <form onSubmit={submit}>
        <fieldset className="memory-cards" disabled={saving}>
          <legend className="sr-only">{t('Confirm where your memory is kept')}</legend>
          <label className="memory-card">
            <input className="memory-radio sr-only" type="radio" name="memory-option" value="home" aria-label={t('This computer')} checked={branch === 'home'} readOnly />
            <span className="memory-card-marks" aria-hidden="true"><span className="radio-mark"><CheckIcon strokeWidth={3} /></span><span className="selected-badge">{t('Selected')}</span></span>
            <span className="memory-art memory-art-home"><img className="memory-artwork" src={atHome} alt={t('A modern silver desktop computer displaying the CMEM brain mark')} width={840} height={840} loading="eager" decoding="async" /></span>
            <span className="card-copy">
              <span className="card-title">{t('This computer')}</span>
              <span className="card-gets">
                <span><CheckIcon aria-hidden="true" />{t('Memory stays on this computer')}</span>
                <span><CheckIcon aria-hidden="true" />{t('Your internal model gateway writes the memories')}</span>
                <span><CheckIcon aria-hidden="true" />{t('No claude-mem account needed')}</span>
              </span>
            </span>
          </label>
        </fieldset>
        <div className="setup-integrations">
          <h2 className="setup-integrations-title">{t('Integrations')}</h2>
          <div className="setup-integration">
            <span className="setup-integration-head">{t('Internal model gateway')}</span>
            <div className="setup-integration-fields">
              <label className="setup-field">
                {t('API key')}
                <input type="password" name="gpustack-api-key" autoComplete="off" value={gatewayKey}
                  onChange={event => setGatewayKey(event.target.value)} placeholder={t('Paste your GPUStack API key')} />
              </label>
              {savedKeyMask && <span className="setup-key-saved">{interpolate(t('A key is already saved ({mask})'), { mask: savedKeyMask })}</span>}
              <label className="setup-field">
                {t('Endpoint')}
                <input type="url" name="gpustack-endpoint" value={gatewayEndpoint}
                  onChange={event => setGatewayEndpoint(event.target.value)} placeholder="https://gpustack.example.com/v1" />
              </label>
            </div>
          </div>
          <div className="setup-integration">
            <label className="setup-s3-toggle">
              <input type="checkbox" name="s3-sync-enabled" checked={s3On} onChange={event => setS3On(event.target.checked)} />
              <span>
                <span className="setup-integration-head">{t('Sync memory across devices (S3)')}</span>
                <span className="setup-integration-note">{t('Pushes this computer’s memory to your own S3 bucket and pulls your other devices’ snapshots back.')}</span>
              </span>
            </label>
            {s3On && (
              <div className="setup-integration-fields">
                <label className="setup-field">
                  {t('S3 endpoint')}
                  <input type="url" name="s3-endpoint" value={s3Endpoint} onChange={event => setS3Endpoint(event.target.value)} />
                </label>
                <label className="setup-field">
                  {t('Bucket')}
                  <input type="text" name="s3-bucket" value={s3Bucket} onChange={event => setS3Bucket(event.target.value)} />
                </label>
                <label className="setup-field">
                  {t('Region')}
                  <input type="text" name="s3-region" value={s3Region} onChange={event => setS3Region(event.target.value)} />
                </label>
                <label className="setup-field">
                  {t('Access key ID')}
                  <input type="text" name="s3-access-key" autoComplete="off" value={s3AccessKey} onChange={event => setS3AccessKey(event.target.value)} />
                </label>
                <label className="setup-field">
                  {t('Secret access key')}
                  <input type="password" name="s3-secret-key" autoComplete="new-password" value={s3Secret} onChange={event => setS3Secret(event.target.value)} />
                </label>
                <span className="setup-integration-note">{t('The access key and secret key are stored in ~/.claude-mem/.env on this computer.')}</span>
              </div>
            )}
          </div>
        </div>
        <SetupActions back={saving ? null : back}>
          <SetupButton type="submit" busy={saving}>{t('Use this computer')} <ArrowRightIcon aria-hidden="true" /></SetupButton>
        </SetupActions>
      </form>
    </section>
  )
}
