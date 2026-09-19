import { ConnectTools } from './onboarding/ConnectTools';
import { OnboardingFlow } from './onboarding/OnboardingFlow';

/**
 * Onboarding.dc.html. The frame, the rail and the other steps live in ./onboarding/ (OnboardingFlow);
 * step 3 "Connect your tools" is this file's slot — ./onboarding/ConnectTools (real tools, packages/connect).
 */
export function Onboarding() {
  return <OnboardingFlow connectTools={(onDone) => <ConnectTools onDone={onDone} />} />;
}
