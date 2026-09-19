import { Link } from 'react-router-dom';
import { useClient, useQuery } from '../api/hooks';
import type { Contributor, Id } from '../api/types';
import { Avatar } from './bits';

/**
 * The Space page's people panel: who has said what here, and which pages their
 * context feeds. Hidden when the server cannot say (the method is optional).
 */
export function ContributorsPanel({ spaceId }: { spaceId: Id }) {
  const client = useClient();
  const people = useQuery((c) => (c.listContributors ? c.listContributors(spaceId) : Promise.resolve<Contributor[]>([])), [spaceId]);
  if (!client.listContributors || !people.data?.length) return null;
  return (
    <section className="contribs" aria-label="Who contributes what">
      <h2 className="h-label">Who contributes what</h2>
      <ul className="plain">
        {people.data.map((p) => (
          <li key={p.personId} className="contrib">
            <Avatar initials={p.initials} size={28} fontSize={10} />
            <span className="contrib__text">
              <span className="contrib__name">
                {p.name}
                {p.title && <span className="contrib__title"> · {p.title}</span>}
              </span>
              <span className="contrib__meta mono">
                {p.facts} {p.facts === 1 ? 'fact' : 'facts'} · {p.sessions} {p.sessions === 1 ? 'session' : 'sessions'}
              </span>
              {p.topics.length > 0 && (
                <span className="contrib__topics">
                  {p.topics.slice(0, 2).map((t) => (
                    <Link key={t.pageId} to={`/pages/${t.pageId}`} className="contrib__topic">
                      {t.title}
                    </Link>
                  ))}
                  {p.topics.length > 2 && <span className="contrib__more mono">+{p.topics.length - 2}</span>}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
