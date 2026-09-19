import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '../api/hooks';
import { defaultSpaceId, rememberSpace, writableSpaces } from '../api/spaces';
import type { Id, Space } from '../api/types';
import type { SelectOption } from './Select';

/** Picker label: "Personal — only you", or the space's name with who else is in it when that is known. */
export function spaceOptionLabel(s: Space): string {
  if (s.personal) return 'Personal — only you';
  if (s.myRole && s.myRole !== 'owner') return `${s.name} · shared with you`;
  if (s.memberCount > 1) return `${s.name} · ${s.memberCount} people`;
  return s.name;
}

/**
 * The space a save goes into, for every save surface (new note, voice note,
 * screenshot). Starts on the space saved into last — remembered across
 * windows — else Personal; `preferred` (a space page's "New note here") wins.
 * Call `remember()` after a save succeeds.
 */
export function useSaveSpace(preferred?: Id) {
  const spaces = useQuery((c) => c.listSpaces(), []);
  const [spaceId, setSpaceId] = useState('');
  // Personal first, then the rest as listed.
  const usable = writableSpaces(spaces.data ?? []).sort((a, b) => Number(Boolean(b.personal)) - Number(Boolean(a.personal)));

  useEffect(() => {
    if (spaceId || !spaces.data?.length) return;
    const wanted = preferred && writableSpaces(spaces.data).some((s) => s.id === preferred) ? preferred : defaultSpaceId(spaces.data);
    setSpaceId(wanted);
  }, [spaceId, spaces.data, preferred]);

  const remember = useCallback(() => rememberSpace(spaceId), [spaceId]);
  const options: SelectOption<string>[] = usable.map((s) => ({ value: s.id, label: spaceOptionLabel(s) }));
  const space = spaces.data?.find((s) => s.id === spaceId);

  return { spaces, spaceId, setSpaceId, space, options, remember };
}
