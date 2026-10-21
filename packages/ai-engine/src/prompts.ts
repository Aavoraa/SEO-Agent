import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Centralised prompt templates live in packages/ai-engine/prompts/*.prompt.
 * Format:  optional front-matter (name, version, max_output_tokens, light),
 *          then [system] … [user] … sections. {{var}} is substituted, {{> principles}} includes _principles.prompt.
 */
export interface PromptTemplate {
  name: string;
  version: number;
  maxOutputTokens: number;
  light: boolean;
  system: string;
  user: string;
}

export function promptsDir(): string {
  const candidates = [
    process.env.PROMPTS_DIR,
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../prompts'),
    path.resolve(process.cwd(), 'packages/ai-engine/prompts'),
    path.resolve(process.cwd(), '../../packages/ai-engine/prompts'),
    path.resolve(process.cwd(), 'prompts'),
  ].filter(Boolean) as string[];
  const found = candidates.find((c) => existsSync(path.join(c, '_principles.prompt')));
  if (!found) throw new Error(`Prompt templates not found (tried ${candidates.join(', ')})`);
  return found;
}

const cache = new Map<string, PromptTemplate>();

export function loadPrompt(name: string, dir = promptsDir()): PromptTemplate {
  const key = `${dir}:${name}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const raw = readFileSync(path.join(dir, `${name}.prompt`), 'utf8').replace(/\r\n/g, '\n');
  const principles = readFileSync(path.join(dir, '_principles.prompt'), 'utf8').replace(/\r\n/g, '\n').trim();
  let body = raw;
  const meta: Record<string, string> = {};
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (fm) {
    for (const line of fm[1]!.split('\n')) {
      const [k, ...v] = line.split(':');
      if (k && v.length) meta[k.trim()] = v.join(':').trim();
    }
    body = raw.slice(fm[0].length);
  }
  const sys = body.match(/\[system\]\n([\s\S]*?)\n\[user\]\n/);
  if (!sys) throw new Error(`Prompt ${name} must contain [system] and [user] sections`);
  const user = body.slice(body.indexOf('[user]\n') + 7);
  const tpl: PromptTemplate = {
    name: meta.name ?? name,
    version: Number(meta.version ?? 1),
    maxOutputTokens: Number(meta.max_output_tokens ?? 4000),
    light: meta.light === 'true',
    system: sys[1]!.replace('{{> principles}}', principles).trim(),
    user: user.trim(),
  };
  cache.set(key, tpl);
  return tpl;
}

export function listPrompts(dir = promptsDir()): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.prompt') && !f.startsWith('_'))
    .map((f) => f.replace(/\.prompt$/, ''));
}

/** Render variables. Objects are JSON-encoded; long values are truncated to respect token limits. */
export function renderTemplate(tpl: string, vars: Record<string, unknown>, maxCharsPerVar = 20000): string {
  return tpl.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) => {
    const v = vars[key];
    if (v === undefined || v === null) return '(none)';
    const s = typeof v === 'string' ? v : JSON.stringify(v, null, 1);
    return s.length > maxCharsPerVar ? s.slice(0, maxCharsPerVar) + `\n…[truncated ${s.length - maxCharsPerVar} chars]` : s;
  });
}
