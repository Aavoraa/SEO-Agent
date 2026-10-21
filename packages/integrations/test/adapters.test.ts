import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { applyHtmlChange, candidateFilesForPath, GitAdapter, ManualExportAdapter, removeDuplicateMeta, setH1 } from '../src/index.js';

const html = `<!DOCTYPE html><html><head><title>Old</title>
<meta name="description" content="old desc">
<script type="application/ld+json">{"@type":"Organization"} broken</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[]}</script>
</head><body><h2 class="big">Workflow <em>Automation</em></h2><p>x</p></body></html>`;

describe('surgical HTML edits', () => {
  it('replaces title and meta description only', () => {
    const t = applyHtmlChange(html, 'title', 'New & Improved')!;
    expect(t).toContain('<title>New &amp; Improved</title>');
    expect(t.replace(/<title>.*<\/title>/, '')).toBe(html.replace(/<title>.*<\/title>/, ''));
    expect(applyHtmlChange(html, 'meta_description', 'Say "hi"')).toContain('content="Say &quot;hi&quot;"');
  });
  it('promotes the first H2 to H1 keeping attributes', () => {
    expect(setH1(html, 'Workflow Automation Services')).toContain('<h1 class="big">Workflow Automation Services</h1>');
  });
  it('replaces invalid JSON-LD and keeps unrelated valid blocks', () => {
    const out = applyHtmlChange(html, 'schema', '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"P"}</script>')!;
    expect(out).not.toContain('broken');
    expect(out).toContain('FAQPage');
    expect(out).toContain('"name":"P"');
  });
  it('removes duplicate meta tags', () => {
    const d = '<head><meta name="google-site-verification" content="a" />\n<meta name="google-site-verification" content="a" /></head>';
    expect(removeDuplicateMeta(d, 'google-site-verification').match(/google-site-verification/g)).toHaveLength(1);
  });
  it('maps clean URLs to static files', () => {
    expect(candidateFilesForPath('/')).toEqual(['index.html']);
    expect(candidateFilesForPath('/automation')).toEqual(['automation.html', 'automation/index.html']);
  });
});

describe('ManualExportAdapter', () => {
  it('writes JSON/CSV/Markdown instructions and never touches the site', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'seo-export-'));
    const a = new ManualExportAdapter(dir);
    const r = await a.apply({ changeId: 'c1', pageUrl: 'https://www.phoenixxit.com/automation', changeType: 'canonical', oldValue: 'a', newValue: 'b' });
    expect(r.applied).toBe(false);
    expect(readFileSync(path.join(dir, 'c1', 'apply.md'), 'utf8')).toMatch(/HIGH-RISK/);
    expect(existsSync(path.join(dir, 'c1', 'apply.csv'))).toBe(true);
  });
});

describe('GitAdapter', () => {
  let hasGit = true;
  try {
    execFileSync('git', ['--version']);
  } catch {
    hasGit = false;
  }
  it.runIf(hasGit)('commits the change on a branch, leaves the main branch untouched, and can roll back', async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'site-repo-'));
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    writeFileSync(path.join(repo, 'automation.html'), html);
    git('add', '.');
    git('commit', '-qm', 'init');
    const adapter = new GitAdapter(repo, { branchPrefix: 'seo-agent/' });
    const change = { changeId: 'abcdef12-3456', pageUrl: 'https://www.phoenixxit.com/automation', changeType: 'title', oldValue: 'Old', newValue: 'Business Automation Services in Coimbatore | Phoenixx IT' };
    const res = await adapter.apply(change);
    expect(res.ok).toBe(true);
    expect(readFileSync(path.join(repo, 'automation.html'), 'utf8')).toContain('<title>Old</title>'); // main untouched
    const branch = String(res.details.branch);
    expect(git('show', `${branch}:automation.html`)).toContain('Business Automation Services');
    expect(git('log', branch, '-1', '--format=%B')).toContain('Change-Id: abcdef12-3456');
    const rb = await adapter.rollback(change);
    expect(rb.ok).toBe(true);
  });
});
