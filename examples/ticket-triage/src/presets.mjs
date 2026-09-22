/**
 * The canonical question set, shared by the server and the browser.
 *
 * The server registers it as a preset so the browser cannot ask its own
 * questions; the browser imports it for its *types* only, which is what
 * makes `useDecision<typeof triage>` give precisely typed readings.
 */
import { choice, score, noul } from '@laya-js/core';

export const URGENCY_LEVELS = ['not urgent', 'somewhat urgent', 'urgent', 'critical'];

export const triage = {
  department: choice('Which team should handle this ticket?', {
    billing: 'invoices, payments, refunds, double charges',
    technical: 'bugs, outages, errors, API problems',
    sales: 'pricing, plans, new contracts, upgrades',
    other: 'anything else'
  }),
  urgency: score('How urgent is this ticket?', URGENCY_LEVELS),
  churn: noul('Is this customer likely to cancel or dispute?', {
    true: 'they threaten to leave, dispute the charge, or sound ready to churn',
    false: 'they are asking for help and expect it to be resolved'
  })
};

export const presets = { triage };
