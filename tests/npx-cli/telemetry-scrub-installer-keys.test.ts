import { describe, expect, it } from 'bun:test';
import { ALLOWED_PROPERTY_KEYS, scrubProperties } from '../../src/services/telemetry/scrub';

describe('installer telemetry keys survive the scrubber', () => {
  it('allowlists phase and provider_source and drops everything else', () => {
    expect(ALLOWED_PROPERTY_KEYS.has('phase')).toBe(true);
    expect(ALLOWED_PROPERTY_KEYS.has('provider_source')).toBe(true);
    expect(scrubProperties({
      phase: 'login',
      provider_source: 'default',
      secret: 'x',
      authorization_url: 'https://cmem.ai/login',
      user_code: 'ABCD-2345',
    })).toEqual({ phase: 'login', provider_source: 'default' });
  });

  it('no longer allowlists the deleted trial and deferred-offer keys', () => {
    // installer_oauth_deferred and trial_activated are gone from EVENT_NAMES;
    // the keys only they sent must not survive the scrubber either.
    for (const key of ['stage', 'trial_days', 'trial_variant', 'offer_surface', 'funnel_source']) {
      expect(ALLOWED_PROPERTY_KEYS.has(key)).toBe(false);
    }
    expect(scrubProperties({
      stage: 'awaiting_checkout',
      trial_days: 7,
      trial_variant: 'a',
      offer_surface: 'installer',
      funnel_source: 'npx',
      phase: 'enrollment',
    })).toEqual({ phase: 'enrollment' });
  });
});
