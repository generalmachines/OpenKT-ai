import { useNavigate } from 'react-router-dom';
import { useConnection } from '../state/connection';

/**
 * One quiet line across the top of the sample workspace. Only the sample
 * adapter renders it; with an account there is nothing to say.
 */
export function DemoBanner() {
  const { signOut } = useConnection();
  const navigate = useNavigate();
  const signUp = async () => {
    // Welcome first (it sits outside the signed-in routes), then leave the sample.
    navigate('/welcome?mode=signup', { replace: true });
    await signOut();
  };
  return (
    <div className="demobar" role="note" aria-label="Sample workspace">
      <span className="demobar__dot" aria-hidden="true" />
      <span className="demobar__text">Sample workspace — sign up to use your own</span>
      <button type="button" className="btn btn--pill-sm demobar__btn" onClick={() => void signUp()}>
        Sign up
      </button>
    </div>
  );
}
