import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { FtpFileStore, guardPath, LocalFileStore, sha256Hex, SftpFileStore } from '../src/index.js';

describe('deployment path restrictions', () => {
  it('only allows HTML files inside the web root', () => {
    expect(guardPath('index.html')).toBe('index.html');
    expect(guardPath('services/web-design.html')).toBe('services/web-design.html');
    for (const bad of ['../etc/passwd.html', '/public_html/index.html', 'a/../../x.html', 'C:\\x.html', 'x.php', '.htaccess', 'wp-admin/index.html', 'cgi-bin/x.html', '.git/config.html', 'a/.env.html', 'index.html\0.png', '']) {
      expect(() => guardPath(bad), bad).toThrow();
    }
    expect(guardPath('app.php', ['.php'])).toBe('app.php');
  });
});

describe('LocalFileStore', () => {
  it('reads, replaces atomically and refuses paths outside the root', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'site-'));
    writeFileSync(path.join(dir, 'index.html'), '<title>A</title>');
    const s = new LocalFileStore(dir);
    await s.connect();
    expect(await s.exists('index.html')).toBe(true);
    expect(await s.exists('missing.html')).toBe(false);
    await s.write('index.html', '<title>B</title>');
    expect(await s.read('index.html')).toBe('<title>B</title>');
    expect(readdirSync(dir)).toEqual(['index.html']); // no temp files left behind
    await expect(s.read('../outside.html')).rejects.toThrow(/traversal/);
    await expect(s.write('x.js', 'alert(1)')).rejects.toThrow(/not allowed/);
    await expect(s.write('big.html', 'x'.repeat(6 * 1024 * 1024))).rejects.toThrow(/5 MB/);
  });
});

describe('secure-by-default remote configuration', () => {
  it('refuses plain FTP unless explicitly allowed, and SFTP without a host fingerprint', () => {
    expect(() => new FtpFileStore({ host: 'h', user: 'u', password: 'p', root: '/public_html', secure: false })).toThrow(/unencrypted/);
    expect(() => new FtpFileStore({ host: 'h', user: 'u', password: 'p', root: '/public_html', secure: false, allowInsecure: true })).not.toThrow();
    expect(() => new SftpFileStore({ host: 'h', user: 'u', password: 'p', root: '/public_html' })).toThrow(/FINGERPRINT/);
    expect(() => new SftpFileStore({ host: 'h', user: 'u', root: '/public_html', hostFingerprint: 'SHA256:x' })).toThrow(/password or a private key/);
  });
  it('never includes the password in its description', () => {
    const s = new FtpFileStore({ host: 'ftp.example.com', user: 'deploy', password: 'hunter2-secret', root: '/public_html', secure: true });
    expect(s.describe()).toBe('ftps://deploy@ftp.example.com:21/public_html');
    expect(JSON.stringify(s.describe())).not.toContain('hunter2');
  });
});

describe('FtpFileStore against a real FTP server', () => {
  let server: any;
  let port: number;
  let root: string;
  beforeAll(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'ftp-'));
    mkdirSync(path.join(root, 'public_html'));
    writeFileSync(path.join(root, 'public_html', 'index.html'), '<html><title>Home</title></html>');
    port = await new Promise<number>((res) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => res(p));
      });
    });
    const { FtpSrv } = await import('ftp-srv');
    server = new FtpSrv({ url: `ftp://127.0.0.1:${port}`, anonymous: false, pasv_url: '127.0.0.1', pasv_min: 30000, pasv_max: 30100, log: { info() {}, debug() {}, trace() {}, warn() {}, error() {}, child() { return this; } } as any });
    server.on('login', ({ username, password }: any, resolve: any, reject: any) => (username === 'deploy' && password === 'right-password' ? resolve({ root }) : reject(new Error('Bad login'))));
    await server.listen();
  });
  afterAll(async () => {
    await server?.close();
  });

  it('uploads through a temp file, renames over the original and reads back the same checksum', async () => {
    const s = new FtpFileStore({ host: '127.0.0.1', port, user: 'deploy', password: 'right-password', root: '/public_html', secure: false, allowInsecure: true });
    await s.connect();
    expect(await s.exists('index.html')).toBe(true);
    expect(await s.exists('nope.html')).toBe(false);
    const original = await s.read('index.html');
    expect(original).toContain('<title>Home</title>');
    const next = original.replace('Home', 'Home | Phoenixx IT');
    await s.write('index.html', next);
    expect(sha256Hex(await s.read('index.html'))).toBe(sha256Hex(next));
    expect(readFileSync(path.join(root, 'public_html', 'index.html'), 'utf8')).toBe(next);
    expect(readdirSync(path.join(root, 'public_html')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    await s.close();
  });

  it('fails cleanly with wrong credentials or an unreachable server', async () => {
    const bad = new FtpFileStore({ host: '127.0.0.1', port, user: 'deploy', password: 'wrong', root: '/public_html', secure: false, allowInsecure: true, timeoutMs: 5000 });
    await expect(bad.connect()).rejects.toThrow();
    await bad.close();
    const down = new FtpFileStore({ host: '127.0.0.1', port: 1, user: 'deploy', password: 'x', root: '/public_html', secure: false, allowInsecure: true, timeoutMs: 3000 });
    await expect(down.connect()).rejects.toThrow();
    await down.close();
  });
});

describe('SftpFileStore against a real SSH/SFTP server', () => {
  let server: any;
  let port: number;
  let root: string;
  let fingerprint: string;
  beforeAll(async () => {
    const ssh2: any = await import('ssh2');
    const { Server, utils } = ssh2.default ?? ssh2;
    const { OPEN_MODE, STATUS_CODE } = utils.sftp;
    const hostKey = utils.generateKeyPairSync('ed25519');
    const { sshFingerprint } = await import('../src/index.js');
    fingerprint = sshFingerprint(utils.parseKey(hostKey.public).getPublicSSH());
    root = mkdtempSync(path.join(os.tmpdir(), 'sftp-'));
    mkdirSync(path.join(root, 'public_html'));
    writeFileSync(path.join(root, 'public_html', 'about.html'), '<html><title>About</title></html>');
    const fsP = await import('node:fs');
    const local = (p: string) => path.join(root, p.replace(/^\/+/, ''));
    server = new Server({ hostKeys: [hostKey.private] }, (client: any) => {
      client.on('error', () => undefined); // expected when the client rejects our host key
      client.on('authentication', (ctx: any) => (ctx.method === 'password' && ctx.username === 'deploy' && ctx.password === 'right-password' ? ctx.accept() : ctx.reject(['password'])));
      client.on('ready', () => {
        client.on('session', (accept: any) => {
          const session = accept();
          session.on('sftp', (acc: any) => {
            const sftp = acc();
            const handles = new Map<number, { file: string; data: Buffer; write: boolean; read: boolean }>();
            let next = 0;
            const attrs = (st: any) => ({ mode: st.mode, uid: 0, gid: 0, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) });
            sftp.on('REALPATH', (id: number, p: string) => sftp.name(id, [{ filename: p === '.' ? '/' : p, longname: p, attrs: {} }]));
            const statH = (id: number, p: string) => {
              try {
                sftp.attrs(id, attrs(fsP.statSync(local(p))));
              } catch {
                sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
              }
            };
            sftp.on('LSTAT', statH);
            sftp.on('STAT', statH);
            sftp.on('OPEN', (id: number, p: string, flags: number) => {
              const write = !!(flags & OPEN_MODE.WRITE);
              if (!write && !fsP.existsSync(local(p))) return sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
              const h = next++;
              handles.set(h, { file: local(p), data: write ? Buffer.alloc(0) : fsP.readFileSync(local(p)), write, read: false });
              const b = Buffer.alloc(4);
              b.writeUInt32BE(h);
              sftp.handle(id, b);
            });
            sftp.on('READ', (id: number, hb: Buffer, offset: number, len: number) => {
              const h = handles.get(hb.readUInt32BE(0));
              if (!h || offset >= h.data.length) return sftp.status(id, STATUS_CODE.EOF);
              sftp.data(id, h.data.subarray(offset, offset + len));
            });
            sftp.on('WRITE', (id: number, hb: Buffer, offset: number, data: Buffer) => {
              const h = handles.get(hb.readUInt32BE(0))!;
              const buf = Buffer.alloc(Math.max(h.data.length, offset + data.length));
              h.data.copy(buf);
              data.copy(buf, offset);
              h.data = buf;
              sftp.status(id, STATUS_CODE.OK);
            });
            sftp.on('FSTAT', (id: number, hb: Buffer) => {
              const h = handles.get(hb.readUInt32BE(0))!;
              sftp.attrs(id, { mode: 0o100644, uid: 0, gid: 0, size: h.data.length, atime: 0, mtime: 0 });
            });
            sftp.on('CLOSE', (id: number, hb: Buffer) => {
              const h = handles.get(hb.readUInt32BE(0));
              if (h?.write) fsP.writeFileSync(h.file, h.data);
              handles.delete(hb.readUInt32BE(0));
              sftp.status(id, STATUS_CODE.OK);
            });
            sftp.on('RENAME', (id: number, from: string, to: string) => {
              if (fsP.existsSync(local(to))) return sftp.status(id, STATUS_CODE.FAILURE); // SFTPv3: no overwrite
              fsP.renameSync(local(from), local(to));
              sftp.status(id, STATUS_CODE.OK);
            });
            sftp.on('REMOVE', (id: number, p: string) => {
              fsP.rmSync(local(p), { force: true });
              sftp.status(id, STATUS_CODE.OK);
            });
          });
        });
      });
    });
    port = await new Promise<number>((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
  });
  afterAll(() => server?.close());

  it('refuses a server whose host key does not match the pinned fingerprint', async () => {
    const s = new SftpFileStore({ host: '127.0.0.1', port, user: 'deploy', password: 'right-password', root: '/public_html', hostFingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', timeoutMs: 5000 });
    await expect(s.connect()).rejects.toThrow();
    expect(s.seenFingerprint).toBe(fingerprint);
    await s.close();
  });

  it('reads and replaces a file with a pinned host key (no leftover temp files)', async () => {
    const s = new SftpFileStore({ host: '127.0.0.1', port, user: 'deploy', password: 'right-password', root: '/public_html', hostFingerprint: fingerprint, timeoutMs: 5000 });
    await s.connect();
    expect(await s.exists('about.html')).toBe(true);
    expect(await s.exists('missing.html')).toBe(false);
    const next = (await s.read('about.html')).replace('About', 'About Phoenixx IT');
    await s.write('about.html', next);
    expect(sha256Hex(await s.read('about.html'))).toBe(sha256Hex(next));
    expect(readdirSync(path.join(root, 'public_html')).sort()).toEqual(['about.html']);
    await s.close();
  });

  it('rejects wrong credentials', async () => {
    const s = new SftpFileStore({ host: '127.0.0.1', port, user: 'deploy', password: 'wrong', root: '/public_html', hostFingerprint: fingerprint, timeoutMs: 5000 });
    await expect(s.connect()).rejects.toThrow();
    await s.close();
  });
});
