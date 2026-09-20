/**
 * Adding context always works: with no on-device AI (not downloaded, or no runtime in this build)
 * the note is saved at once, and its words are its context — never a session nobody can recall.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ApiProvider } from '../api/hooks';
import { MockClient } from '../api/mock';
import { asWritten } from '../capture/save';
import { NewNote } from './NewNote';
import { SessionView } from './SessionView';

describe('New note without on-device AI', () => {
  it('saves the note as its own context and says it was saved as written', async () => {
    const user = userEvent.setup();
    const client = new MockClient();
    render(
      <ApiProvider client={client}>
        <MemoryRouter initialEntries={['/new']}>
          <Routes>
            <Route path="/new" element={<NewNote />} />
            <Route path="/sessions/:id/:tab?" element={<SessionView />} />
          </Routes>
        </MemoryRouter>
      </ApiProvider>,
    );
    expect(screen.getByLabelText('Note')).toHaveAttribute('placeholder', expect.stringMatching(/saved as written/));
    await user.type(screen.getByLabelText('Title'), 'Walrus pricing');
    await user.type(screen.getByLabelText('Note'), 'We quote Walrus Grocers per store, not per seat.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Walrus pricing' })).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: 'Context · 1' })).toBeInTheDocument();
    expect(screen.getByText('saved as written')).toBeInTheDocument();
    const session = (await client.listSessions({ mine: true })).find((x) => x.title === 'Walrus pricing');
    expect((await client.listContext(session!.id)).map((c) => c.statement)).toEqual(['Walrus pricing\n\nWe quote Walrus Grocers per store, not per seat.']);
  });

  it('asWritten keeps the words, adds the title once, and stays under the server limit', () => {
    expect(asWritten('s', 'p', 'Plan', 'Plan for Q4').statement).toBe('Plan for Q4');
    expect(asWritten('s', 'p', '', 'just words').statement).toBe('just words');
    expect(asWritten('s', 'p', 'T', 'x'.repeat(30_000)).statement.length).toBe(20_000);
  });
});
