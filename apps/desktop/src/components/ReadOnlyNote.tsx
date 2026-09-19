import { useQuery } from '../api/hooks';
import type { Space } from '../api/types';
import { Icon } from './Icon';

/** A reader sees what they can do, and who to ask for more. Renders nothing for editors and owners. */
export function ReadOnlyNote({ space }: { space: Pick<Space, 'myRole' | 'ownerId' | 'name'> | undefined }) {
  const workspace = useQuery((c) => c.getWorkspace(), []);
  if (space?.myRole !== 'reader') return null;
  const owner = workspace.data?.people.find((p) => p.id === space.ownerId)?.name;
  return (
    <p className="readonly" role="note">
      <Icon name="lock" size={13} />
      <span>
        You can read {space.name}. {owner ? `Ask ${owner} for edit access.` : 'Ask its owner for edit access.'}
      </span>
    </p>
  );
}
