import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SERVER_URL, loadApiSettings } from '.';
import { RETIRED_DEFAULT_SERVER_URLS } from './config';

describe('loadApiSettings', () => {
  beforeEach(() => localStorage.clear());

  it('replaces a server address left behind by an old build with the current default', async () => {
    localStorage.setItem('openkt.api', JSON.stringify({ adapter: 'http', baseUrl: `${RETIRED_DEFAULT_SERVER_URLS[0]}/`, email: 'ana@example.com' }));
    const s = await loadApiSettings();
    expect(s.baseUrl).toBe(DEFAULT_SERVER_URL);
    expect(s.email).toBe('ana@example.com');
  });

  it('keeps a server the person chose themselves', async () => {
    localStorage.setItem('openkt.api', JSON.stringify({ adapter: 'http', baseUrl: 'https://openkt.acme.example' }));
    expect((await loadApiSettings()).baseUrl).toBe('https://openkt.acme.example');
  });
});
