import { useClient } from '../api/hooks';
import type { PreviewArea } from '../api/types';

/**
 * Shown on screens the connected server cannot fill yet. Renders nothing on
 * the mock adapter, where the Workspace setting already says "Sample data".
 */
export function PreviewBadge({ area, children }: { area: PreviewArea; children?: string }) {
  const client = useClient();
  if (!client.preview.has(area)) return null;
  return (
    <span className="preview mono" role="note">
      <span className="preview__dot" aria-hidden="true" />
      {children ?? 'Preview — sample data'}
    </span>
  );
}
