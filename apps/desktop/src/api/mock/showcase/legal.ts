/**
 * Legal — corporate legal team.
 * Every statement, page summary, fork, change and relation below is copied from the
 * OpenKT knowledge-synthesis report (https://dwlabs.org/work/openkt-kb). Session titles,
 * sources and times are sample glue. Keep the statements verbatim when editing.
 */
import type { ShowcaseTeam } from './types';

export const legal: ShowcaseTeam = {
  space: { id: 'sp-legal', name: 'legal', label: 'Legal', description: 'Corporate legal team.', myRole: 'editor', owner: 'helena', team: ['t-legal', 'Legal'] },
  stats: { memories: 36, people: 6, pages: 17 },
  people: [
    { key: 'helena', name: 'Helena', title: 'General Counsel' },
    { key: 'derek', name: 'Derek', title: 'Commercial Counsel' },
    { key: 'aisha', name: 'Aisha', title: 'Privacy Counsel' },
    { key: 'carla', name: 'Carla', title: 'Employment Counsel' },
    { key: 'raffi', name: 'Raffi', title: 'Contracts Manager / Paralegal' },
    { key: 'ben', name: 'Ben', title: 'Corporate / M&A Counsel' },
  ],
  sessions: [
    { id: 's-legal-playbook', source: 'connector', via: 'Notion', title: 'Contract playbook', by: 'me', day: 1, time: '11:20', facts: ['f-legal-2', 'f-legal-3', 'f-legal-4', 'f-legal-7', 'f-legal-6', 'f-legal-24', 'f-legal-26', 'f-legal-33', 'f-legal-34'] },
    { id: 's-legal-msa-terms', source: 'note', title: 'MSA standard terms', by: 'derek', day: 40, time: '15:00', facts: ['f-legal-0'] },
    { id: 's-legal-liability-cap', source: 'meeting', title: 'Liability cap decision', by: 'helena', day: 8, time: '10:00', durationSec: 1800, facts: ['f-legal-1', 'f-legal-12', 'f-legal-5', 'f-legal-23'] },
    { id: 's-legal-option-pool', source: 'meeting', title: 'Option pool before the Series B', by: 'helena', day: 2, time: '16:30', durationSec: 1560, facts: ['f-legal-13', 'f-legal-14', 'f-legal-15', 'f-legal-16', 'f-legal-17'], question: 'Option pool refresh timing before Series B' },
    { id: 's-legal-privacy', source: 'claude', title: 'DPA and transfer checklist', by: 'aisha', day: 5, time: '11:45', facts: ['f-legal-8', 'f-legal-9', 'f-legal-10', 'f-legal-11', 'f-legal-35', 'f-legal-31'] },
    { id: 's-legal-non-competes', source: 'chatgpt', title: 'Non-competes after the FTC rule', by: 'carla', day: 10, time: '14:25', facts: ['f-legal-19', 'f-legal-20', 'f-legal-21'] },
    { id: 's-legal-piia', source: 'note', title: 'PIIA and the trade-secret case', by: 'carla', day: 14, time: '09:50', facts: ['f-legal-18', 'f-legal-22', 'f-legal-29'] },
    { id: 's-legal-trademarks', source: 'voice', title: 'Trademarks and provisionals', by: 'ben', day: 6, time: '18:35', durationSec: 38, facts: ['f-legal-27', 'f-legal-28'] },
    { id: 's-legal-board', source: 'note', title: 'Board approvals and delegation', by: 'helena', day: 12, time: '08:40', facts: ['f-legal-30', 'f-legal-32', 'f-legal-25'] },
  ],
  facts: [
    { id: 'f-legal-0', by: 'derek', kind: 'decision', page: 'p-legal-liability-cap-strategy', supersededBy: 'f-legal-1', text: 'Standard liability cap in our MSA is a flat $1,000,000 aggregate; data-breach carve-out sits above the cap.' },
    { id: 'f-legal-1', by: 'helena', kind: 'decision', page: 'p-legal-liability-cap-strategy', text: 'Decision: our new standard liability cap is 12 months of fees paid, not a flat $1M — the flat figure was a giveaway on small deals and a hard ceiling on large ones.' },
    { id: 'f-legal-2', by: 'raffi', kind: 'fact', page: 'p-legal-contract-lifecycle-management', text: 'The playbook and CLM templates are updated to the 12-months-fees cap; legacy contracts keep the $1M cap until they renew.' },
    { id: 'f-legal-3', by: 'derek', kind: 'how-to', page: 'p-legal-liability-cap-strategy', text: 'Mutual limitation of liability is the fallback if a customer pushes; we trade symmetry for keeping the cap number where we want it.' },
    { id: 'f-legal-4', by: 'derek', kind: 'how-to', page: 'p-legal-liability-cap-strategy', text: 'Never agree to uncapped indirect/consequential damages — that\'s a walk-away term, escalate to Helena instead of conceding.' },
    { id: 'f-legal-5', by: 'helena', kind: 'decision', page: 'p-legal-ip-indemnification-third', text: 'We used to give a one-way IP indemnity to the customer with no reciprocal; that\'s now mutual indemnification for third-party claims arising from each party\'s materials.' },
    { id: 'f-legal-6', by: 'derek', kind: 'how-to', page: 'p-legal-ip-indemnification-third', text: 'IP indemnity is conditioned on prompt notice, sole control of defense, and the customer not settling without our consent.' },
    { id: 'f-legal-7', by: 'raffi', kind: 'fact', page: 'p-legal-liability-cap-strategy', text: 'Indemnity cap is carved out from the general liability cap and runs to the same 12-months-fees number unless negotiated higher.' },
    { id: 'f-legal-8', by: 'aisha', kind: 'decision', page: 'p-legal-eu-data-transfer', text: 'Cross-border EU transfers rely on the 2021 EU Standard Contractual Clauses with a transfer impact assessment; we retired the old Privacy-Shield-era language.' },
    { id: 'f-legal-9', by: 'aisha', kind: 'decision', page: 'p-legal-vendor-procurement-security', text: 'Every vendor touching personal data signs our DPA before go-live; no DPA, no data — Raffi gates this in procurement.' },
    { id: 'f-legal-10', by: 'aisha', kind: 'fact', page: 'p-legal-eu-data-transfer', text: 'GDPR breach notification to the supervisory authority is within 72 hours of awareness; we maintain a pre-drafted notice template.' },
    { id: 'f-legal-11', by: 'aisha', kind: 'fact', page: 'p-legal-us-privacy-law', text: 'CCPA/CPRA \'sale/share\' opt-out is handled at the product layer; legal owns the privacy policy disclosure, not the toggle.' },
    { id: 'f-legal-12', by: 'derek', kind: 'fact', page: 'p-legal-eu-data-transfer', text: 'The DPA\'s liability is tied back to the MSA cap — so the 12-months-fees change flows straight into data-protection exposure too.' },
    { id: 'f-legal-13', by: 'ben', kind: 'decision', page: 'p-legal-option-pool-equity', text: 'Standard new-hire option vesting is 4-year with a 1-year cliff; early-exercise allowed for the first 90 days.' },
    { id: 'f-legal-14', by: 'ben', kind: 'decision', page: 'p-legal-option-pool-equity', text: 'My position: refresh the option pool to 15% BEFORE the Series B term sheet so dilution lands on existing investors, not just founders.' },
    { id: 'f-legal-15', by: 'helena', kind: 'decision', page: 'p-legal-option-pool-equity', text: 'My position: do NOT pre-emptively top up the pool — size it in the round so we don\'t dilute founders ahead of a valuation we haven\'t locked.' },
    { id: 'f-legal-16', by: 'ben', kind: 'action', page: 'p-legal-equity-grant-cap', text: '83(b) election must be filed within 30 days of grant for early-exercised shares — there is no IRS extension, ever; we send a reminder at signing.' },
    { id: 'f-legal-17', by: 'raffi', kind: 'fact', page: 'p-legal-equity-grant-cap', text: 'Cap table lives in Carta; every grant, exercise, and SAFE conversion is reconciled there before board meetings.' },
    { id: 'f-legal-18', by: 'carla', kind: 'decision', page: 'p-legal-ip-assignment-employment', text: 'All employees and contractors sign a PIIA assigning IP and including confidentiality; no exceptions, signed before day one.' },
    { id: 'f-legal-19', by: 'carla', kind: 'decision', page: 'p-legal-employment-law-compliance', text: 'We dropped non-competes from offer letters entirely after the FTC rule and state bans — we rely on trade-secret and non-solicit protection instead.' },
    { id: 'f-legal-20', by: 'carla', kind: 'how-to', page: 'p-legal-employment-law-compliance', text: 'For any RIF or termination over a protected class threshold, we run an adverse-impact analysis and offer severance for a release under OWBPA.' },
    { id: 'f-legal-21', by: 'carla', kind: 'fact', page: 'p-legal-employment-law-compliance', text: 'Contractor misclassification is the live risk: apply the ABC test in CA, and a 1099 who fails control/independence gets reclassified to W-2.' },
    { id: 'f-legal-22', by: 'carla', kind: 'issue', page: 'p-legal-trade-secret-enforcement', text: 'A departing engineer took source to a competitor; the PIIA plus a well-papered exit interview is what made the trade-secret claim viable.' },
    { id: 'f-legal-23', by: 'helena', kind: 'decision', page: 'p-legal-dispute-resolution-governing', text: 'Dispute resolution moved to binding AAA arbitration with a class-action waiver, seated in Delaware, replacing the old courts-of-NY clause.' },
    { id: 'f-legal-24', by: 'derek', kind: 'how-to', page: 'p-legal-dispute-resolution-governing', text: 'Governing law stays Delaware for commercial deals; we resist customer attempts to flip to their home state unless the deal is strategic.' },
    { id: 'f-legal-25', by: 'helena', kind: 'fact', page: 'p-legal-litigation-hold-e', text: 'Litigation hold goes out the moment litigation is reasonably anticipated; IT preserves before anyone touches a mailbox.' },
    { id: 'f-legal-26', by: 'raffi', kind: 'how-to', page: 'p-legal-contract-lifecycle-management', text: 'Track every signed contract\'s governing law and venue in the CLM so we know our forum exposure at a glance.' },
    { id: 'f-legal-27', by: 'ben', kind: 'decision', page: 'p-legal-trademark-filing-pre', text: 'File trademarks in the US, EU, and UK at minimum on any new product name before public launch — first-to-file jurisdictions bite us otherwise.' },
    { id: 'f-legal-28', by: 'ben', kind: 'how-to', page: 'p-legal-patent-strategy-provisional', text: 'Provisional patent first to lock the priority date, then decide on full filing within the 12-month window.' },
    { id: 'f-legal-29', by: 'carla', kind: 'fact', page: 'p-legal-ip-assignment-employment', text: 'The PIIA assignment is what gives the company clean title to file those patents — broken assignment chains kill patent value in diligence.' },
    { id: 'f-legal-30', by: 'helena', kind: 'decision', page: 'p-legal-board-approval-delegation', text: 'Board approval is required for any contract over $500k TCV, any debt, and any equity issuance; Raffi flags these to the queue.' },
    { id: 'f-legal-31', by: 'aisha', kind: 'decision', page: 'p-legal-compliance-training-soc', text: 'Annual security and privacy training is mandatory and tracked; completion is an audit and SOC 2 control we attest to.' },
    { id: 'f-legal-32', by: 'helena', kind: 'fact', page: 'p-legal-board-approval-delegation', text: 'We maintain a delegation-of-authority matrix so commercial counsel can sign up to defined thresholds without GC review.' },
    { id: 'f-legal-33', by: 'raffi', kind: 'fact', page: 'p-legal-contract-lifecycle-management', text: 'Every executed agreement is filed in the CLM with metadata: counterparty, value, renewal date, auto-renewal flag, and assigned attorney.' },
    { id: 'f-legal-34', by: 'derek', kind: 'how-to', page: 'p-legal-contract-lifecycle-management', text: 'Auto-renewal clauses without a notice reminder are how we get stuck in bad vendor deals — Raffi sets a 90-day pre-renewal alert on every one.' },
    { id: 'f-legal-35', by: 'aisha', kind: 'fact', page: 'p-legal-vendor-procurement-security', text: 'Vendor security review and the DPA are one gate — privacy and security sign off together before a data processor goes live.' },
  ],
  pages: [
    {
      id: 'p-legal-liability-cap-strategy',
      title: 'Liability Cap Strategy & Structure',
      by: ['derek', 'helena', 'raffi'],
      stands: [
        ['The company has transitioned from a flat $1M aggregate liability cap to a proportional 12-months-fees model, effective for all new deals.', ['f-legal-1', 'f-legal-0']],
        ['This change addresses asymmetric outcomes on small vs. large deals.', ['f-legal-1']],
        ['Legacy contracts retain the $1M cap until renewal.', ['f-legal-2']],
        ['The indemnity cap is carved separately from general liability and defaults to 12-months-fees unless negotiated higher.', ['f-legal-7']],
        ['Uncapped indirect/consequential damages are a non-negotiable walk-away term requiring escalation to Helena.', ['f-legal-4']],
        ['When customers resist, Derek uses mutual limitation of liability as a fallback, accepting symmetry to maintain favorable cap levels.', ['f-legal-3']],
      ],
      changes: [
        { topic: 'Standard liability cap amount', now: '12 months of fees paid (Helena\'s decision)', was: 'Flat $1,000,000 aggregate (Derek\'s prior standard)', nowFact: 'f-legal-1', wasFact: 'f-legal-0' },
      ],
      related: [
        ['p-legal-eu-data-transfer', 'DPA liability provisions are tied to MSA caps; the 12-months-fees liability change flows directly into data-protection exposure'],
        ['p-legal-ip-indemnification-third', 'Indemnity cap is carved out from general liability cap and defaults to 12-months-fees unless negotiated higher'],
      ],
    },
    {
      id: 'p-legal-contract-lifecycle-management',
      title: 'Contract Lifecycle Management & Metadata',
      by: ['raffi', 'derek'],
      stands: [
        ['Every executed agreement is filed in the CLM with metadata: counterparty, value, renewal date, auto-renewal flag, and assigned attorney.', ['f-legal-33']],
        ['Auto-renewal clauses are monitored with 90-day pre-renewal alerts to prevent unintended vendor lock-in.', ['f-legal-34']],
        ['Governing law and venue are tracked for quick forum exposure assessment.', ['f-legal-26']],
      ],
      related: [
        ['p-legal-board-approval-delegation', 'Raffi flags board-level contracts (over $500k TCV) to approval queue; CLM tracks all contract metadata for governance'],
        ['p-legal-dispute-resolution-governing', 'Governing law and venue for all signed contracts are tracked in CLM to quickly assess forum exposure'],
      ],
    },
    {
      id: 'p-legal-employment-law-compliance',
      title: 'Employment Law Compliance & Terminations',
      by: ['carla'],
      stands: [
        ['The company tracks FTC non-compete rule changes and state bans, adapting employment agreements to use trade-secret and non-solicit protections.', ['f-legal-19']],
        ['For any RIF or termination involving protected class thresholds, an adverse-impact analysis is conducted and severance is offered in exchange for a release under OWBPA.', ['f-legal-20']],
        ['Contractor misclassification is a live risk; the ABC test is applied in California to assess 1099 vs. W-2 reclassification exposure, focusing on control and independence prongs.', ['f-legal-21']],
      ],
    },
    {
      id: 'p-legal-eu-data-transfer',
      title: 'EU Data Transfer Compliance & GDPR',
      by: ['aisha', 'derek', 'raffi'],
      stands: [
        ['Cross-border EU data transfers rely on the 2021 EU Standard Contractual Clauses with Transfer Impact Assessments; Privacy Shield language has been retired.', ['f-legal-8']],
        ['Every vendor handling personal data must sign a DPA before go-live—Raffi enforces this gate in procurement with no exceptions.', ['f-legal-9']],
        ['GDPR breach notification to supervisory authorities must occur within 72 hours of awareness; the team maintains a pre-drafted notice template for rapid compliance.', ['f-legal-10']],
        ['DPA liability provisions are tied to MSA caps, so the 12-months-fees liability change directly affects data-protection exposure.', ['f-legal-12']],
        ['Vendor security review and DPA signing are combined into a single gate with joint sign-off from privacy and security teams.', ['f-legal-35']],
      ],
      related: [
        ['p-legal-liability-cap-strategy', 'DPA liability provisions are tied to MSA caps; the 12-months-fees liability change flows directly into data-protection exposure'],
        ['p-legal-vendor-procurement-security', 'DPA signing is gated with security review; privacy and security teams sign off together before data processor goes live'],
      ],
    },
    {
      id: 'p-legal-option-pool-equity',
      title: 'Option Pool & Equity Dilution Strategy',
      by: ['ben', 'helena'],
      stands: [
        ['Standard new-hire option vesting is 4-year with a 1-year cliff; early exercise is allowed for the first 90 days.', ['f-legal-13']],
        ['The team disagrees on option pool refresh timing before Series B.', ['f-legal-14']],
      ],
      forks: [
        { topic: 'Option pool refresh timing before Series B', sides: [['ben', 'Refresh the pool to 15% BEFORE the Series B term sheet so dilution lands on existing investors rather than founders alone', 'f-legal-14'], ['helena', 'Do NOT pre-emptively top up the pool; size it in the round to avoid diluting founders ahead of a valuation we haven\'t locked', 'f-legal-15']] },
      ],
    },
    {
      id: 'p-legal-ip-indemnification-third',
      title: 'IP Indemnification & Third-Party Claims',
      by: ['helena', 'derek', 'raffi'],
      stands: [
        ['The company has evolved from unilateral (customer-only) IP indemnification to mutual indemnification for third-party IP claims arising from each party\'s materials.', ['f-legal-5']],
        ['Indemnity is scoped to third-party claims specifically, not all claims.', ['f-legal-5']],
        ['Conditions include prompt notice, sole defense control by the indemnifying party, and prohibition on customer settlement without consent.', ['f-legal-6']],
        ['The indemnity cap is carved out from general liability and defaults to 12-months-fees unless negotiated higher.', ['f-legal-7']],
      ],
      related: [
        ['p-legal-liability-cap-strategy', 'Indemnity cap is carved out from general liability cap and defaults to 12-months-fees unless negotiated higher'],
        ['p-legal-patent-strategy-provisional', 'Clean PIIA assignment chains are essential for patent value preservation in M&amp;A and funding diligence'],
        ['p-legal-trade-secret-enforcement', 'PIIA combined with thorough exit interview documentation is critical for trade secret claim viability'],
      ],
    },
    {
      id: 'p-legal-equity-grant-cap',
      title: 'Equity Grant & Cap Table Management',
      by: ['ben', 'raffi'],
      stands: [
        ['83(b) elections must be filed within 30 days of grant for early-exercised shares with no IRS extensions available; Ben sends reminders at signing.', ['f-legal-16']],
        ['Cap table is maintained in Carta with all grants, exercises, and SAFE conversions reconciled before board meetings.', ['f-legal-17']],
      ],
    },
    {
      id: 'p-legal-ip-assignment-employment',
      title: 'IP Assignment & Employment Agreements',
      by: ['carla', 'ben'],
      stands: [
        ['All employees and contractors sign a PIIA (Proprietary Information & Invention Assignment) with IP assignment and confidentiality provisions before day one—no exceptions.', ['f-legal-18']],
        ['The PIIA assignment chain must be clean for patent value preservation; broken chains compromise patent enforceability in M&A and funding diligence.', ['f-legal-29']],
        ['Non-competes have been dropped entirely from offer letters following the FTC rule and state bans; the company now relies on trade-secret and non-solicit protections instead.', ['f-legal-19']],
      ],
    },
    {
      id: 'p-legal-vendor-procurement-security',
      title: 'Vendor Procurement & Security Gate',
      by: ['aisha', 'raffi'],
      stands: [
        ['Vendor security review and DPA signing are combined into a single gate; privacy and security teams sign off together before a data processor goes live.', ['f-legal-35']],
        ['Raffi enforces DPA compliance during vendor procurement onboarding with no exceptions.', ['f-legal-9']],
      ],
      related: [
        ['p-legal-eu-data-transfer', 'DPA signing is gated with security review; privacy and security teams sign off together before data processor goes live'],
      ],
    },
    {
      id: 'p-legal-dispute-resolution-governing',
      title: 'Dispute Resolution & Governing Law',
      by: ['helena', 'derek', 'raffi'],
      stands: [
        ['Dispute resolution has been updated from courts-of-NY to binding AAA arbitration with a class-action waiver, seated in Delaware.', ['f-legal-23']],
        ['Delaware is the preferred governing law for commercial deals; the company resists customer attempts to flip to their home state unless the deal is strategic.', ['f-legal-24']],
        ['Every signed contract\'s governing law and venue are tracked in the CLM for quick forum exposure assessment.', ['f-legal-26']],
      ],
      related: [
        ['p-legal-contract-lifecycle-management', 'Governing law and venue for all signed contracts are tracked in CLM to quickly assess forum exposure'],
        ['p-legal-litigation-hold-e', 'Litigation hold procedures ensure e-discovery readiness; forum exposure tracked in CLM informs litigation strategy'],
      ],
    },
    {
      id: 'p-legal-board-approval-delegation',
      title: 'Board Approval & Delegation of Authority',
      by: ['helena', 'raffi', 'derek'],
      stands: [
        ['Board approval is required for contracts over $500k TCV, any debt, and any equity issuance.', ['f-legal-30']],
        ['Raffi flags board-level items to the approval queue.', ['f-legal-30']],
        ['The company maintains a tiered delegation-of-authority matrix allowing commercial counsel to sign contracts up to defined thresholds without General Counsel escalation, balancing operational efficiency with governance.', ['f-legal-32']],
      ],
      related: [
        ['p-legal-contract-lifecycle-management', 'Raffi flags board-level contracts (over $500k TCV) to approval queue; CLM tracks all contract metadata for governance'],
      ],
    },
    {
      id: 'p-legal-trade-secret-enforcement',
      title: 'Trade Secret Enforcement & Exit Procedures',
      by: ['carla'],
      stands: [
        ['The company has practical experience enforcing trade secret claims against departing employees who misappropriate source code.', ['f-legal-22']],
        ['Thorough exit interview documentation is critical for claim viability.', ['f-legal-22']],
        ['A well-papered PIIA combined with detailed exit interviews has proven effective in trade secret litigation.', ['f-legal-22']],
      ],
      related: [
        ['p-legal-ip-indemnification-third', 'PIIA combined with thorough exit interview documentation is critical for trade secret claim viability'],
      ],
    },
    {
      id: 'p-legal-trademark-filing-pre',
      title: 'Trademark Filing & Pre-Launch IP Clearance',
      by: ['ben'],
      stands: [
        ['Trademarks must be filed in the US, EU, and UK at minimum on any new product name before public launch, as first-to-file jurisdictions require early filing.', ['f-legal-27']],
        ['Trademark filing and clearance in key jurisdictions are mandatory before any new product name goes public.', ['f-legal-27']],
      ],
    },
    {
      id: 'p-legal-litigation-hold-e',
      title: 'Litigation Hold & E-Discovery Readiness',
      by: ['helena', 'raffi'],
      stands: [
        ['Litigation holds are issued the moment litigation is reasonably anticipated.', ['f-legal-25']],
        ['IT preserves mailboxes and systems before anyone accesses them, ensuring e-discovery readiness.', ['f-legal-25']],
        ['The team understands the reasonable anticipation trigger and implements preservation proactively.', []],
      ],
      related: [
        ['p-legal-dispute-resolution-governing', 'Litigation hold procedures ensure e-discovery readiness; forum exposure tracked in CLM informs litigation strategy'],
      ],
    },
    {
      id: 'p-legal-patent-strategy-provisional',
      title: 'Patent Strategy & Provisional Applications',
      by: ['ben', 'carla'],
      stands: [
        ['Provisional patent applications are used to secure priority dates; the full filing decision is made within the 12-month statutory window.', ['f-legal-28']],
        ['Clean PIIA assignment chains are essential for patent value preservation in M&A and funding diligence.', ['f-legal-29']],
      ],
      related: [
        ['p-legal-ip-indemnification-third', 'Clean PIIA assignment chains are essential for patent value preservation in M&amp;A and funding diligence'],
      ],
    },
    {
      id: 'p-legal-us-privacy-law',
      title: 'US Privacy Law & Product Compliance',
      by: ['aisha'],
      stands: [
        ['CCPA/CPRA \'sale/share\' opt-out requirements are handled at the product layer (product team owns the toggle); legal owns the privacy policy disclosure.', ['f-legal-11']],
        ['This split responsibility ensures technical implementation and legal transparency are coordinated.', []],
      ],
    },
    {
      id: 'p-legal-compliance-training-soc',
      title: 'Compliance Training & SOC 2 Controls',
      by: ['aisha'],
      stands: [
        ['Annual security and privacy training is mandatory and tracked as an audited SOC 2 Type II control.', ['f-legal-31']],
        ['Completion is attested to in compliance reports.', []],
      ],
    },
  ],
};
