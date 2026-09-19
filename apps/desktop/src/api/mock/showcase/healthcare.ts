/**
 * Healthcare — clinical care team.
 * Every statement, page summary, fork, change and relation below is copied from the
 * OpenKT knowledge-synthesis report (https://dwlabs.org/work/openkt-kb). Session titles,
 * sources and times are sample glue. Keep the statements verbatim when editing.
 */
import type { ShowcaseTeam } from './types';

export const healthcare: ShowcaseTeam = {
  space: { id: 'sp-healthcare', name: 'healthcare', label: 'Healthcare', description: 'Clinical care team.', myRole: 'reader', owner: 'ekwueme', team: ['t-healthcare', 'Healthcare'] },
  stats: { memories: 37, people: 6, pages: 12 },
  people: [
    { key: 'ekwueme', name: 'Dr. Ekwueme', title: 'Attending Hospitalist' },
    { key: 'sam', name: 'Sam Okoro', title: 'Clinical Pharmacist' },
    { key: 'rosa-rn', name: 'Rosa', title: 'Charge Nurse' },
    { key: 'liang', name: 'Dr. Liang', title: 'Resident' },
    { key: 'patel', name: 'Dr. Patel', title: 'Infectious Disease' },
    { key: 'thandi', name: 'Thandi', title: 'Case Manager / Discharge Planner' },
  ],
  sessions: [
    { id: 's-healthcare-huddle', source: 'meeting', title: 'Morning huddle: the sepsis bundle', by: 'rosa-rn', day: 1, time: '07:30', durationSec: 1080, facts: ['f-healthcare-0', 'f-healthcare-1', 'f-healthcare-2', 'f-healthcare-3', 'f-healthcare-36'] },
    { id: 's-healthcare-glucose', source: 'meeting', title: 'Glucose targets on the floor', by: 'ekwueme', day: 2, time: '12:10', durationSec: 1320, facts: ['f-healthcare-13', 'f-healthcare-14', 'f-healthcare-15', 'f-healthcare-16', 'f-healthcare-22'], question: 'Optimal inpatient glucose target' },
    { id: 's-healthcare-antibiogram', source: 'screenshot', title: '2026 antibiogram: Pseudomonas', by: 'patel', day: 5, time: '16:02', shot: { caption: 'The 2026 antibiogram, Pseudomonas row.', text: 'Pseudomonas aeruginosa · piperacillin-tazobactam: resistance rising · cefepime' }, facts: ['f-healthcare-5', 'f-healthcare-33'] },
    { id: 's-healthcare-hap', source: 'note', title: 'HAP empiric coverage', by: 'patel', day: 30, time: '09:15', facts: ['f-healthcare-4'] },
    { id: 's-healthcare-deescalation', source: 'claude', title: 'De-escalation at 48 hours', by: 'sam', day: 6, time: '13:40', facts: ['f-healthcare-6', 'f-healthcare-34'] },
    { id: 's-healthcare-pharmacy', source: 'note', title: 'Pharmacy rules', by: 'sam', day: 9, time: '17:05', facts: ['f-healthcare-8', 'f-healthcare-11', 'f-healthcare-18', 'f-healthcare-25'] },
    { id: 's-healthcare-id-consult', source: 'note', title: 'ID consult notes', by: 'patel', day: 7, time: '11:30', facts: ['f-healthcare-7', 'f-healthcare-31'] },
    { id: 's-healthcare-anticoag', source: 'meeting', title: 'Anticoagulation and pain rounds', by: 'ekwueme', day: 11, time: '08:05', durationSec: 840, facts: ['f-healthcare-10', 'f-healthcare-12', 'f-healthcare-17', 'f-healthcare-19'] },
    { id: 's-healthcare-falls', source: 'voice', title: 'Falls and skin checks', by: 'rosa-rn', day: 3, time: '19:20', durationSec: 46, facts: ['f-healthcare-20', 'f-healthcare-21', 'f-healthcare-32'] },
    { id: 's-healthcare-admission', source: 'note', title: 'Admission checklist', by: 'liang', day: 12, time: '22:10', facts: ['f-healthcare-9', 'f-healthcare-29'] },
    { id: 's-healthcare-discharge', source: 'meeting', title: 'Discharge planning huddle', by: 'thandi', day: 4, time: '14:00', durationSec: 1500, facts: ['f-healthcare-23', 'f-healthcare-24', 'f-healthcare-26', 'f-healthcare-27', 'f-healthcare-28', 'f-healthcare-30'] },
    { id: 's-healthcare-charting', source: 'voice', title: 'Charting tip', by: 'liang', day: 8, time: '06:55', durationSec: 19, facts: ['f-healthcare-35'] },
  ],
  facts: [
    { id: 'f-healthcare-0', by: 'ekwueme', kind: 'decision', page: 'p-healthcare-sepsis-recognition-initial', text: 'We run the 1-hour sepsis bundle: lactate, blood cultures before antibiotics, broad-spectrum abx, 30 mL/kg crystalloid for hypotension or lactate >=4.' },
    { id: 'f-healthcare-1', by: 'rosa-rn', kind: 'how-to', page: 'p-healthcare-sepsis-recognition-initial', text: 'Triage uses a qSOFA quick-screen at the door; any 2 of (RR>=22, altered mentation, SBP<=100) pages the rapid-response team immediately.' },
    { id: 'f-healthcare-2', by: 'liang', kind: 'fact', page: 'p-healthcare-sepsis-recognition-initial', text: 'Repeat lactate at 2-4 hours if the initial is elevated — trend guides fluid resuscitation more than a single value.' },
    { id: 'f-healthcare-3', by: 'sam', kind: 'fact', page: 'p-healthcare-sepsis-recognition-initial', text: 'Cultures must be drawn before the first antibiotic dose; door-to-antibiotic target is under 60 minutes for suspected septic shock.' },
    { id: 'f-healthcare-4', by: 'patel', kind: 'decision', page: 'p-healthcare-antibiotic-stewardship-de', supersededBy: 'f-healthcare-5', text: 'Empiric coverage for hospital-acquired pneumonia is piperacillin-tazobactam plus vancomycin.' },
    { id: 'f-healthcare-5', by: 'patel', kind: 'decision', page: 'p-healthcare-antibiotic-stewardship-de', text: 'Decision: switching first-line empiric from pip-tazo to cefepime for HAP — the 2026 antibiogram shows rising pip-tazo resistance in our Pseudomonas isolates. Keep vanc for MRSA coverage.' },
    { id: 'f-healthcare-6', by: 'sam', kind: 'how-to', page: 'p-healthcare-antibiotic-stewardship-de', text: 'De-escalate antibiotics at 48-72h once cultures and sensitivities return; narrow to the organism, don\'t ride broad-spectrum.' },
    { id: 'f-healthcare-7', by: 'patel', kind: 'decision', page: 'p-healthcare-vancomycin-dosing-monitoring', text: 'Vancomycin is now dosed by AUC-guided monitoring, not trough-only — pharmacy runs the Bayesian calculator on every patient.' },
    { id: 'f-healthcare-8', by: 'sam', kind: 'how-to', page: 'p-healthcare-vancomycin-dosing-monitoring', text: 'Stop ordering daily vanc troughs reflexively — under AUC dosing it\'s the wrong target and just sticks the patient more.' },
    { id: 'f-healthcare-9', by: 'liang', kind: 'decision', page: 'p-healthcare-vte-prophylaxis', text: 'VTE prophylaxis on every admit unless contraindicated: enoxaparin 40mg SC daily, or heparin 5000u q8h if renal.' },
    { id: 'f-healthcare-10', by: 'ekwueme', kind: 'decision', page: 'p-healthcare-atrial-fibrillation-anticoagulation', text: 'For new non-valvular AFib we default to a DOAC (apixaban) now — we stopped routine warfarin bridging except mechanical valves and severe renal disease.' },
    { id: 'f-healthcare-11', by: 'sam', kind: 'fact', page: 'p-healthcare-atrial-fibrillation-anticoagulation', text: 'Apixaban needs dose reduction to 2.5mg BID if two of: age>=80, weight<=60kg, creatinine>=1.5 — pharmacy verifies every order.' },
    { id: 'f-healthcare-12', by: 'rosa-rn', kind: 'fact', page: 'p-healthcare-atrial-fibrillation-anticoagulation', text: 'Hold enoxaparin 12h before any procedure and document the last dose time on the board; anesthesia checks it.' },
    { id: 'f-healthcare-13', by: 'liang', kind: 'decision', page: 'p-healthcare-inpatient-glucose-management', text: 'My practice: tight inpatient glucose control, target 110-140, basal-bolus insulin, because hyperglycemia worsens infection outcomes.' },
    { id: 'f-healthcare-14', by: 'ekwueme', kind: 'decision', page: 'p-healthcare-inpatient-glucose-management', text: 'My practice: permissive target 140-180 on the floor — the tighter 110-140 range causes too many hypoglycemic events and NICE-SUGAR showed harm.' },
    { id: 'f-healthcare-15', by: 'sam', kind: 'how-to', page: 'p-healthcare-inpatient-glucose-management', text: 'No sliding-scale-only insulin regimens for type 1 or steroid-induced hyperglycemia — it chases highs instead of preventing them.' },
    { id: 'f-healthcare-16', by: 'rosa-rn', kind: 'how-to', page: 'p-healthcare-inpatient-glucose-management', text: 'Point-of-care glucose checks before meals and at bedtime; any reading under 70 triggers the hypoglycemia protocol immediately.' },
    { id: 'f-healthcare-17', by: 'ekwueme', kind: 'decision', page: 'p-healthcare-postoperative-pain-management', text: 'Post-op pain is now multimodal-first: scheduled acetaminophen + NSAID, opioids only for breakthrough — we moved away from opioid-first orders.' },
    { id: 'f-healthcare-18', by: 'sam', kind: 'fact', page: 'p-healthcare-postoperative-pain-management', text: 'Every discharge with opioids gets a naloxone co-prescription and a 5-day max supply for acute pain.' },
    { id: 'f-healthcare-19', by: 'rosa-rn', kind: 'how-to', page: 'p-healthcare-postoperative-pain-management', text: 'Reassess pain within 60 minutes of any opioid dose and document the response; un-reassessed doses are a chart-audit flag.' },
    { id: 'f-healthcare-20', by: 'rosa-rn', kind: 'decision', page: 'p-healthcare-fall-risk-assessment', text: 'Morse Fall Scale on admit and every shift; score >=45 gets a yellow band, bed alarm, and hourly rounding.' },
    { id: 'f-healthcare-21', by: 'rosa-rn', kind: 'how-to', page: 'p-healthcare-fall-risk-assessment', text: 'Reposition immobile patients q2h and Braden-assess daily; heels floated for anyone Braden <=14.' },
    { id: 'f-healthcare-22', by: 'liang', kind: 'issue', page: 'p-healthcare-inpatient-glucose-management', text: 'A patient on the tight glucose protocol fell after a 3am hypoglycemic episode — reinforced that nocturnal lows and fall risk are linked.' },
    { id: 'f-healthcare-23', by: 'thandi', kind: 'decision', page: 'p-healthcare-discharge-planning-readmission', text: 'No discharge without medication reconciliation completed by pharmacy and a teach-back done with the patient.' },
    { id: 'f-healthcare-24', by: 'thandi', kind: 'how-to', page: 'p-healthcare-discharge-planning-readmission', text: 'High-readmission-risk patients (LACE>=10) get a follow-up call within 48h and an appointment booked before they leave.' },
    { id: 'f-healthcare-25', by: 'sam', kind: 'fact', page: 'p-healthcare-discharge-planning-readmission', text: 'Med rec at discharge is where the DOAC vs warfarin and the AUC-vanc decisions actually reach the patient — pharmacy owns the final list.' },
    { id: 'f-healthcare-26', by: 'thandi', kind: 'issue', page: 'p-healthcare-discharge-planning-readmission', text: 'A CHF patient bounced back in 6 days because no scale or diuretic plan went home — now heart-failure discharges require a documented weight-and-diuretic plan.' },
    { id: 'f-healthcare-27', by: 'thandi', kind: 'fact', page: 'p-healthcare-discharge-planning-readmission', text: 'Skilled-nursing-facility placement averages 2.3 days to arrange; start the referral on admission for likely SNF patients, not at discharge.' },
    { id: 'f-healthcare-28', by: 'ekwueme', kind: 'decision', page: 'p-healthcare-code-status-end', text: 'Code status is addressed and documented within 24h of admission for every patient over 75 or with advanced illness.' },
    { id: 'f-healthcare-29', by: 'liang', kind: 'fact', page: 'p-healthcare-code-status-end', text: 'A documented DNR is not DNT — do-not-resuscitate never means do-not-treat; we still escalate care short of CPR.' },
    { id: 'f-healthcare-30', by: 'thandi', kind: 'how-to', page: 'p-healthcare-code-status-end', text: 'Palliative consult is offered early for metastatic cancer and end-stage organ failure, not reserved for the last 48 hours of life.' },
    { id: 'f-healthcare-31', by: 'patel', kind: 'decision', page: 'p-healthcare-infection-control-contact', text: 'Contact precautions for MRSA and C. diff; C. diff requires soap-and-water hand hygiene because alcohol gel doesn\'t kill spores.' },
    { id: 'f-healthcare-32', by: 'rosa-rn', kind: 'how-to', page: 'p-healthcare-infection-control-contact', text: 'Central-line dressing changed q7d or when soiled; daily CHG bath for line patients to cut CLABSI.' },
    { id: 'f-healthcare-33', by: 'patel', kind: 'fact', page: 'p-healthcare-antibiogram-resistance-surveillance', text: 'Antibiotic stewardship and the antibiogram are the same loop — resistance data feeds the empiric choices we just changed for HAP.' },
    { id: 'f-healthcare-34', by: 'sam', kind: 'fact', page: 'p-healthcare-antibiotic-stewardship-de', text: 'Every broad-spectrum start gets an automatic 48h stewardship review prompt in the EHR to force de-escalation.' },
    { id: 'f-healthcare-35', by: 'liang', kind: 'how-to', page: 'p-healthcare-antibiotic-stewardship-de', text: 'Charting tip: document the indication and planned stop date for every antibiotic at the time of ordering.' },
    { id: 'f-healthcare-36', by: 'ekwueme', kind: 'fact', page: 'p-healthcare-antibiotic-stewardship-de', text: 'Sepsis bundle and antibiotic stewardship pull in opposite directions at the bedside — start broad fast, then narrow fast; both matter.' },
  ],
  pages: [
    {
      id: 'p-healthcare-antibiotic-stewardship-de',
      title: 'Antibiotic Stewardship & De-escalation',
      by: ['patel', 'sam', 'liang', 'ekwueme'],
      stands: [
        ['The team balances rapid empiric coverage with systematic de-escalation.', ['f-healthcare-4']],
        ['Empiric HAP coverage recently shifted from piperacillin-tazobactam to cefepime plus vancomycin based on 2026 antibiogram showing rising pip-tazo resistance in Pseudomonas; vancomycin retained for MRSA.', ['f-healthcare-5']],
        ['All broad-spectrum starts trigger automatic 48h EHR stewardship review prompts mandating de-escalation.', ['f-healthcare-34']],
        ['At 48-72h post-culture, narrow to organism-specific therapy and discontinue broad-spectrum.', ['f-healthcare-6']],
        ['Every antibiotic order documents indication and planned stop date at time of ordering to prevent unnecessary prolongation.', ['f-healthcare-35']],
        ['The team recognizes operational tension between rapid sepsis bundle initiation and stewardship discipline—both are non-negotiable.', ['f-healthcare-36']],
      ],
      changes: [
        { topic: 'HAP empiric antibiotic first-line', now: 'Cefepime + vancomycin (based on 2026 antibiogram resistance data)', was: 'Piperacillin-tazobactam + vancomycin', nowFact: 'f-healthcare-5', wasFact: 'f-healthcare-4' },
      ],
      related: [
        ['p-healthcare-sepsis-recognition-initial', 'Rapid empiric coverage (sepsis bundle) must be followed by systematic de-escalation at 48-72h; both are non-negotiable and create operational tension'],
        ['p-healthcare-vancomycin-dosing-monitoring', 'Vancomycin is part of empiric HAP coverage and requires AUC-guided dosing per stewardship protocol'],
      ],
    },
    {
      id: 'p-healthcare-discharge-planning-readmission',
      title: 'Discharge Planning & Readmission Prevention',
      by: ['thandi', 'sam'],
      stands: [
        ['No discharge occurs without (1) pharmacy medication reconciliation completed and (2) patient teach-back documented.', ['f-healthcare-23']],
        ['High-readmission-risk patients (LACE≥10) receive follow-up call within 48h and appointment booked before discharge.', ['f-healthcare-24']],
        ['For CHF specifically, documented weight-monitoring plan and diuretic regimen are required before discharge (protocol implemented after 6-day readmission due to missing scale/plan).', ['f-healthcare-26']],
        ['SNF placement averages 2.3 days to arrange; referral initiation begins on admission for likely SNF patients, not at discharge.', ['f-healthcare-27']],
        ['Pharmacy owns final medication list at discharge, including DOAC vs warfarin and AUC-vanc decisions.', ['f-healthcare-25']],
      ],
      changes: [
        { topic: 'CHF discharge requirements', now: 'Documented weight-monitoring plan and diuretic regimen required', was: 'No systematic weight/diuretic plan requirement', nowFact: 'f-healthcare-26' },
      ],
      related: [
        ['p-healthcare-postoperative-pain-management', 'Opioid discharge protocol (naloxone co-prescription, 5-day max) is part of systematic discharge medication reconciliation'],
        ['p-healthcare-atrial-fibrillation-anticoagulation', 'Pharmacy medication reconciliation at discharge is final arbiter of DOAC vs warfarin decisions for AFib patients'],
        ['p-healthcare-vte-prophylaxis', 'VTE prophylaxis orders are reconciled at discharge; enoxaparin perioperative hold (12h) is documented for discharge planning'],
        ['p-healthcare-code-status-end', 'Early palliative consult and code status documentation inform discharge planning and readmission risk stratification'],
      ],
    },
    {
      id: 'p-healthcare-inpatient-glucose-management',
      title: 'Inpatient Glucose Management',
      by: ['ekwueme', 'liang', 'sam', 'rosa-rn'],
      stands: [
        ['The team implements permissive glycemic control targeting 140–180 mg/dL on the medical floor, avoiding tighter targets due to hypoglycemia risk.', ['f-healthcare-14']],
        ['Evidence base: NICE-SUGAR trial demonstrated harm from tight control.', ['f-healthcare-13']],
        ['Point-of-care glucose checks occur before meals and at bedtime; any reading <70 mg/dL triggers hypoglycemia protocol immediately.', ['f-healthcare-16']],
        ['Basal-bolus insulin is standard; sliding-scale-only regimens are rejected for type 1 diabetes and steroid-induced hyperglycemia as they chase highs reactively rather than prevent them.', ['f-healthcare-15']],
        ['Nocturnal hypoglycemia is recognized as an independent fall risk factor.', ['f-healthcare-22']],
      ],
      forks: [
        { topic: 'Optimal inpatient glucose target', sides: [['liang', 'Tight control 110–140 mg/dL to improve infection outcomes', 'f-healthcare-13'], ['ekwueme', 'Permissive 140–180 mg/dL to minimize hypoglycemia risk (NICE-SUGAR evidence)', 'f-healthcare-14']] },
      ],
      changes: [
        { topic: 'Inpatient glucose target range', now: 'Permissive 140–180 mg/dL (medical floor)', was: 'Tight control 110–140 mg/dL', nowFact: 'f-healthcare-14' },
      ],
      related: [
        ['p-healthcare-fall-risk-assessment', 'Nocturnal hypoglycemia is an independent fall risk factor; glucose management directly impacts fall prevention'],
      ],
    },
    {
      id: 'p-healthcare-sepsis-recognition-initial',
      title: 'Sepsis Recognition & Initial Management',
      by: ['rosa-rn', 'ekwueme', 'sam', 'liang'],
      stands: [
        ['The team implements a rapid-response sepsis protocol with two entry points: (1) ED triage uses qSOFA quick-screen (RR≥22, altered mentation, SBP≤100); any 2 criteria trigger immediate rapid-response activation.', ['f-healthcare-1']],
        ['(2) Once sepsis suspected, the 1-hour bundle executes: lactate draw, blood cultures before antibiotics, broad-spectrum antibiotics, 30 mL/kg crystalloid for hypotension or lactate ≥4.', ['f-healthcare-0']],
        ['Door-to-antibiotic target is <60 minutes for septic shock.', ['f-healthcare-3']],
        ['Serial lactate trends (repeat at 2-4h if elevated) guide ongoing resuscitation more than single values.', ['f-healthcare-2']],
      ],
      related: [
        ['p-healthcare-antibiotic-stewardship-de', 'Rapid empiric coverage (sepsis bundle) must be followed by systematic de-escalation at 48-72h; both are non-negotiable and create operational tension'],
      ],
    },
    {
      id: 'p-healthcare-code-status-end',
      title: 'Code Status & End-of-Life Care',
      by: ['ekwueme', 'liang', 'thandi'],
      stands: [
        ['Code status is addressed and documented within 24h of admission for every patient over 75 or with advanced illness.', ['f-healthcare-28']],
        ['The team clearly distinguishes DNR (do-not-resuscitate) from DNT (do-not-treat): DNR means no CPR but does not preclude escalation of care short of CPR.', ['f-healthcare-29']],
        ['Palliative consult is offered early for metastatic cancer and end-stage organ failure, not reserved for final 48 hours of life.', ['f-healthcare-30']],
      ],
      related: [
        ['p-healthcare-discharge-planning-readmission', 'Early palliative consult and code status documentation inform discharge planning and readmission risk stratification'],
      ],
    },
    {
      id: 'p-healthcare-postoperative-pain-management',
      title: 'Postoperative Pain Management & Opioid Stewardship',
      by: ['ekwueme', 'sam', 'rosa-rn'],
      stands: [
        ['Post-operative pain management is multimodal-first: scheduled acetaminophen + NSAID with opioids reserved for breakthrough pain only.', ['f-healthcare-17']],
        ['The team has moved away from opioid-first ordering.', ['f-healthcare-17']],
        ['Pain must be reassessed within 60 minutes of any opioid dose and documented; un-reassessed doses trigger chart-audit flags.', ['f-healthcare-19']],
        ['At discharge, every opioid prescription includes naloxone co-prescription and is limited to 5-day supply for acute pain.', ['f-healthcare-18']],
        ['This systematic approach prioritizes minimizing opioid exposure while maintaining effective analgesia.', []],
      ],
      related: [
        ['p-healthcare-discharge-planning-readmission', 'Opioid discharge protocol (naloxone co-prescription, 5-day max) is part of systematic discharge medication reconciliation'],
      ],
    },
    {
      id: 'p-healthcare-atrial-fibrillation-anticoagulation',
      title: 'Atrial Fibrillation & Anticoagulation',
      by: ['ekwueme', 'sam', 'rosa-rn'],
      stands: [
        ['For new non-valvular AFib, the team defaults to DOAC (apixaban) and has discontinued routine warfarin bridging except for mechanical valves and severe renal disease.', ['f-healthcare-10']],
        ['Apixaban requires dose reduction to 2.5mg BID if two of: age≥80, weight≤60kg, creatinine≥1.5; pharmacy verifies every order.', ['f-healthcare-11']],
        ['Perioperative enoxaparin management: hold 12h before procedures and document last-dose time on board for anesthesia verification.', ['f-healthcare-12']],
        ['Pharmacy performs final medication reconciliation at discharge, serving as arbiter of DOAC vs warfarin decisions.', ['f-healthcare-10']],
      ],
      related: [
        ['p-healthcare-discharge-planning-readmission', 'Pharmacy medication reconciliation at discharge is final arbiter of DOAC vs warfarin decisions for AFib patients'],
      ],
    },
    {
      id: 'p-healthcare-infection-control-contact',
      title: 'Infection Control & Contact Precautions',
      by: ['patel', 'rosa-rn'],
      stands: [
        ['Contact precautions are implemented for MRSA and C. difficile patients.', ['f-healthcare-31']],
        ['For C. difficile specifically, soap-and-water hand hygiene is mandatory because alcohol-based gel does not kill spores.', ['f-healthcare-31']],
        ['Central-line dressing is changed q7d or when soiled; daily chlorhexidine (CHG) bathing is performed for all line patients to reduce CLABSI risk.', ['f-healthcare-32']],
      ],
      related: [
        ['p-healthcare-antibiogram-resistance-surveillance', 'C. difficile and MRSA contact precautions are part of infection control; resistance patterns inform empiric antibiotic choices'],
      ],
    },
    {
      id: 'p-healthcare-fall-risk-assessment',
      title: 'Fall Risk Assessment & Prevention',
      by: ['rosa-rn', 'liang'],
      stands: [
        ['The team implements structured fall risk screening using Morse Fall Scale on admission and every shift.', ['f-healthcare-20']],
        ['Scores ≥45 trigger yellow band, bed alarm, and hourly rounding.', ['f-healthcare-20']],
        ['Pressure injury prevention uses Braden Scale daily for high-risk patients (score ≤14); immobile patients are repositioned q2h and heels are floated for Braden ≤14.', ['f-healthcare-21']],
        ['Nocturnal hypoglycemia is recognized as an independent fall risk factor; a documented case of a patient falling after 3am hypoglycemic episode reinforced the link between glucose management and fall prevention.', ['f-healthcare-22']],
      ],
      related: [
        ['p-healthcare-inpatient-glucose-management', 'Nocturnal hypoglycemia is an independent fall risk factor; glucose management directly impacts fall prevention'],
      ],
    },
    {
      id: 'p-healthcare-vancomycin-dosing-monitoring',
      title: 'Vancomycin Dosing & Monitoring',
      by: ['patel', 'sam'],
      stands: [
        ['Vancomycin is now dosed by AUC-guided monitoring using Bayesian pharmacokinetic calculations run by pharmacy on every patient, replacing trough-only monitoring.', ['f-healthcare-7']],
        ['Pharmacy owns the calculator and dosing decisions.', ['f-healthcare-7']],
        ['Clinicians no longer order reflexive daily vancomycin troughs; this practice caused unnecessary venipunctures and targeted the wrong parameter under AUC-based dosing.', ['f-healthcare-8']],
      ],
      changes: [
        { topic: 'Vancomycin monitoring strategy', now: 'AUC-guided dosing with Bayesian calculator (pharmacy-run)', was: 'Trough-based monitoring with reflexive daily levels', nowFact: 'f-healthcare-7' },
      ],
      related: [
        ['p-healthcare-antibiotic-stewardship-de', 'Vancomycin is part of empiric HAP coverage and requires AUC-guided dosing per stewardship protocol'],
      ],
    },
    {
      id: 'p-healthcare-antibiogram-resistance-surveillance',
      title: 'Antibiogram & Resistance Surveillance',
      by: ['patel', 'sam'],
      stands: [
        ['Institutional resistance surveillance data (antibiogram) directly feeds empiric antibiotic protocol updates.', ['f-healthcare-33']],
        ['The team views antibiotic stewardship and antibiogram as a closed feedback loop: resistance patterns inform empiric choices, which are then de-escalated based on culture sensitivities.', ['f-healthcare-33']],
        ['The 2026 HAP protocol shift from pip-tazo to cefepime exemplifies this data-driven approach.', ['f-healthcare-5']],
      ],
      related: [
        ['p-healthcare-infection-control-contact', 'C. difficile and MRSA contact precautions are part of infection control; resistance patterns inform empiric antibiotic choices'],
      ],
    },
    {
      id: 'p-healthcare-vte-prophylaxis',
      title: 'VTE Prophylaxis',
      by: ['liang', 'ekwueme'],
      stands: [
        ['VTE prophylaxis is prescribed on every hospital admission unless contraindicated.', ['f-healthcare-9']],
        ['Default is enoxaparin 40mg SC daily; for renal impairment, switch to heparin 5000u q8h.', ['f-healthcare-9']],
        ['Systematic protocol ensures no admission is missed.', []],
      ],
      related: [
        ['p-healthcare-discharge-planning-readmission', 'VTE prophylaxis orders are reconciled at discharge; enoxaparin perioperative hold (12h) is documented for discharge planning'],
      ],
    },
  ],
};
