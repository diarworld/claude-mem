import { ArrowRightIcon, CheckIcon } from 'lucide-react'
import { type FormEvent } from 'react'
import { useI18n } from '@/lib/i18n'
import type { MemoryBranch } from '../setup-flow'
import atHome from '../assets/at-home-modern-computer.webp'
import { PageHeading, SetupActions, SetupButton, type SetupBack } from './shared'

/**
 * Step 3: the storage choice (PROTO #route-choice). The local-only funnel has one card to confirm; the On The Go
 * card, its offers and its orbit of agents went with the hosted funnel. The one radio stays real (E13) so the
 * confirmed choice reads the same as it did.
 */
export function ChoiceScreen({ branch, saving = false, back, onChoose }: { branch: MemoryBranch; saving?: boolean; back?: SetupBack | null; onChoose: (branch: MemoryBranch) => void }) {
  const { t } = useI18n()
  const submit = (event: FormEvent) => { event.preventDefault(); onChoose('home') }
  return (
    <section aria-labelledby="choice-title">
      <PageHeading id="choice-title" title={t('Choose your memory plan')} />
      <form onSubmit={submit}>
        <fieldset className="memory-cards" disabled={saving}>
          <legend className="sr-only">{t('Choose where to store and access your memory')}</legend>
          <label className="memory-card">
            <input className="memory-radio sr-only" type="radio" name="memory-option" value="home" aria-label={t('This computer, free')} checked={branch === 'home'} readOnly />
            <span className="memory-card-marks" aria-hidden="true"><span className="radio-mark"><CheckIcon strokeWidth={3} /></span><span className="selected-badge">{t('Selected')}</span></span>
            <span className="memory-art memory-art-home"><img className="memory-artwork" src={atHome} alt={t('A modern silver desktop computer displaying the CMEM brain mark')} width={840} height={840} loading="eager" decoding="async" /></span>
            <span className="card-copy">
              <span className="card-title">{t('This computer')}</span>
              <span className="card-price">{t('Free')}</span>
              <span className="card-gets">
                <span><CheckIcon aria-hidden="true" />{t('Memory stays on this computer')}</span>
                <span><CheckIcon aria-hidden="true" />{t('Your Claude account writes the memories')}</span>
                <span><CheckIcon aria-hidden="true" />{t('No claude-mem account needed')}</span>
              </span>
            </span>
          </label>
        </fieldset>
        <SetupActions back={saving ? null : back}>
          <SetupButton type="submit" busy={saving}>{t('Use this computer')} <ArrowRightIcon aria-hidden="true" /></SetupButton>
        </SetupActions>
      </form>
    </section>
  )
}
