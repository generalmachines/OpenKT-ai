/** Shared fixtures for the updater tests: a Range-capable HTTP server, fake macOS tools, fake app bundles. */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, dirname, join } from 'node:path';
import type { Tools } from '../../../src/main/update/bundle';

export interface FixtureServer {
  base: string;
  files: Map<string, Buffer>;
  /** Per-request log: path + Range header. */
  seen: { path: string; range: string | undefined }[];
  behaviour: { cutAfter: number; redirect: Record<string, string>; status: Record<string, number> };
  close(): void;
}

export async function startServer(): Promise<FixtureServer> {
  const files = new Map<string, Buffer>();
  const seen: FixtureServer['seen'] = [];
  const behaviour: FixtureServer['behaviour'] = { cutAfter: 0, redirect: {}, status: {} };
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    const range = req.headers.range;
    seen.push({ path, range });
    if (behaviour.status[path]) return void res.writeHead(behaviour.status[path]!).end();
    if (behaviour.redirect[path]) return void res.writeHead(302, { location: behaviour.redirect[path] }).end();
    const body = files.get(path);
    if (!body) return void res.writeHead(404).end();
    let start = 0;
    const m = /^bytes=(\d+)-$/.exec(range ?? '');
    if (m) start = Number(m[1]);
    if (start >= body.length) return void res.writeHead(416).end();
    const slice = body.subarray(start);
    res.writeHead(start > 0 ? 206 : 200, {
      'content-length': slice.length,
      'accept-ranges': 'bytes',
      ...(start > 0 ? { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` } : {}),
    });
    if (behaviour.cutAfter > 0 && slice.length > behaviour.cutAfter) {
      const n = behaviour.cutAfter;
      behaviour.cutAfter = 0;
      res.write(slice.subarray(0, n), () => res.destroy());
      return;
    }
    res.end(slice);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    files,
    seen,
    behaviour,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

function script(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

/**
 * Fake /usr/bin tools. Info.plist in the fake bundles is `KEY=value` lines; a bundle "verifies" when it
 * contains Contents/_CodeSignature/CodeResources with the text `sealed`.
 */
export function fakeTools(dir: string): Tools & { calls: string } {
  mkdirSync(dir, { recursive: true });
  const calls = join(dir, 'calls.log');
  writeFileSync(calls, '');
  const log = `'${calls.replace(/'/g, `'\\''`)}'`;
  return {
    calls,
    // plutil -extract KEY raw -o - FILE
    plutil: script(dir, 'plutil', `echo "plutil $*" >> ${log}\nv=$(sed -n "s/^$2=//p" "$6")\n[ -n "$v" ] || { echo "no $2" >&2; exit 1; }\necho "$v"`),
    // codesign --verify --deep --strict APP  |  codesign -dv --verbose=2 APP
    codesign: script(
      dir,
      'codesign',
      `echo "codesign $*" >> ${log}\nif [ "$1" = "--verify" ]; then grep -q sealed "$4/Contents/_CodeSignature/CodeResources" 2>/dev/null && exit 0; echo "$4: invalid signature (code or signature have been modified)" >&2; exit 1; fi\necho "Identifier=ai.openkt.desktop" >&2\necho "TeamIdentifier=not set" >&2`,
    ),
    // ditto -x -k ZIP DIR
    ditto: script(dir, 'ditto', `echo "ditto $*" >> ${log}\nexec unzip -q "$3" -d "$4"`),
    xattr: script(dir, 'xattr', `echo "xattr $*" >> ${log}`),
    // open -n [args…] APP: record, do not launch anything
    open: script(dir, 'open', `echo "open $*" >> ${log}`),
    sh: '/bin/sh',
  };
}

export function fakeApp(path: string, opts: { id?: string; version: string; sealed?: boolean }): string {
  mkdirSync(join(path, 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(join(path, 'Contents', '_CodeSignature'), { recursive: true });
  writeFileSync(join(path, 'Contents', 'Info.plist'), `CFBundleIdentifier=${opts.id ?? 'ai.openkt.desktop'}\nCFBundleShortVersionString=${opts.version}\n`);
  writeFileSync(join(path, 'Contents', 'MacOS', 'OpenKT'), `#!/bin/sh\necho ${opts.version}\n`);
  writeFileSync(join(path, 'Contents', '_CodeSignature', 'CodeResources'), opts.sealed === false ? 'broken' : 'sealed');
  return path;
}

/** Zips `<parent>/<name>.app` so it expands to `<name>.app` at the archive root, like electron-builder's mac zip. */
export function zipApp(appPath: string, zipPath: string): Buffer {
  execFileSync('zip', ['-qry', zipPath, basename(appPath)], { cwd: dirname(appPath) });
  return readFileSync(zipPath);
}
