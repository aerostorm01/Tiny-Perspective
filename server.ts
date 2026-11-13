import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const portArgIdx = process.argv.indexOf('--port');
const cliPort = portArgIdx !== -1 ? Number(process.argv[portArgIdx + 1]) : NaN;
const PORT = !Number.isNaN(cliPort)
  ? cliPort
  : process.env.NODE_ENV === 'production'
    ? (Number(process.env.PORT) || 3000)
    : 3000;

app.use(express.json({ limit: '10mb' }));

// Health check endpoint (BYOK; zero server-side API key)
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    byok: true,
  });
});

// Pure BYOK Gemini REST relay: strictly uses the visitor's own x-goog-api-key header,
// never stores or falls back to any developer key, and avoids browser preview fetch interception.
const DEFAULT_BYOK_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
];

function sanitizeRestSchema(node: any): any {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(sanitizeRestSchema);
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'type') {
      if (Array.isArray(v)) {
        const nonNull = v.find((t) => typeof t === 'string' && t.toLowerCase() !== 'null') || 'string';
        out.type = String(nonNull).toUpperCase();
        if (v.some((t) => typeof t === 'string' && t.toLowerCase() === 'null')) {
          out.nullable = true;
        }
      } else if (typeof v === 'string') {
        out.type = v.toUpperCase();
      } else {
        out.type = v;
      }
    } else if (k === 'additionalProperties') {
      continue;
    } else {
      out[k] = sanitizeRestSchema(v);
    }
  }
  return out;
}

app.post('/api/byok/generate', async (req: Request, res: Response) => {
  const userKey = String(req.header('x-goog-api-key') || '').trim();
  if (!userKey) {
    return res.status(401).json({
      error: {
        code: 401,
        status: 'UNAUTHENTICATED',
        message: 'Please enter your free Gemini API key in the settings to play this AI toy.',
      },
    });
  }

  const body = req.body || {};
  const rawPayload = body.payload;
  if (!rawPayload || typeof rawPayload !== 'object') {
    return res.status(400).json({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Missing Gemini request payload.' } });
  }
  const payload = rawPayload?.generationConfig?.responseSchema
    ? {
        ...rawPayload,
        generationConfig: {
          ...rawPayload.generationConfig,
          responseSchema: sanitizeRestSchema(rawPayload.generationConfig.responseSchema),
        },
      }
    : rawPayload;

  const rawModels = Array.isArray(body.models) ? body.models : DEFAULT_BYOK_MODELS;
  const candidates = rawModels
    .map((m: unknown) => String(m || '').trim())
    .filter((m: string) => /^gemini-[a-z0-9.-]+$/i.test(m));
  if (candidates.length === 0) candidates.push(...DEFAULT_BYOK_MODELS);

  const ac = new AbortController();
  const onResClose = () => {
    if (!res.writableEnded) ac.abort();
  };
  res.on('close', onResClose);

  try {
    let lastStatus = 502;
    let lastErrBody: any = { error: { code: 502, message: 'Gemini API request failed.' } };

    for (let i = 0; i < candidates.length; i++) {
      const modelId = candidates[i];
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent`;
      const upstream = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': userKey,
        },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });

      const data = await upstream.json().catch(() => null);
      if (upstream.ok && data) {
        return res.json({ data, usedModel: modelId });
      }

      lastStatus = upstream.status || 502;
      lastErrBody = data || { error: { code: lastStatus, message: upstream.statusText || 'Gemini API error' } };

      const apiMsg = String(data?.error?.message || upstream.statusText || '');
      const apiStatus = String(data?.error?.status || '');
      const combinedErr = `${apiMsg} ${apiStatus}`;

      if (
        upstream.status === 401 ||
        upstream.status === 403 ||
        /API_KEY_INVALID|PERMISSION_DENIED|API key not valid|API key expired/i.test(combinedErr)
      ) {
        return res.status(upstream.status).json(lastErrBody);
      }

      const isModelNotFound =
        upstream.status === 404 ||
        /NOT_FOUND|not found|not supported|not available|unknown model|invalid model/i.test(combinedErr);
      if (isModelNotFound && i + 1 < candidates.length) {
        continue;
      }

      if (i + 1 < candidates.length && (upstream.status === 429 || upstream.status >= 500)) {
        continue;
      }

      return res.status(lastStatus).json(lastErrBody);
    }

    return res.status(lastStatus).json(lastErrBody);
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      if (!res.writableEnded) return res.status(499).end();
      return;
    }
    return res.status(502).json({
      error: {
        code: 502,
        status: 'UPSTREAM_ERROR',
        message: err?.message || 'Could not reach Gemini API.',
      },
    });
  } finally {
    res.off('close', onResClose);
  }
});

type WikiToken =
  | { type: 'text'; text: string }
  | { type: 'link'; text: string; title: string; href: string };

type WikiPagePayload = {
  title: string;
  wikiUrl: string;
  paragraphs: WikiToken[][];
  links: string[];
};

const WIKI_PAGE_CACHE = new Map<string, { data: WikiPagePayload; expiresAt: number }>();
const WIKI_UA = 'TinyPerspectives-WikiLeap/1.0 (https://tinyperspectives.app)';

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) && code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) && code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : '';
    });
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function isValidWikiSlug(slug: string): boolean {
  if (!slug || slug.includes(':')) return false;
  if (slug.startsWith('Main_Page')) return false;
  return true;
}

function parseWikiHtmlToParagraphs(rawHtml: string): { paragraphs: WikiToken[][]; inlineLinks: string[] } {
  const cleaned = rawHtml
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<table[\s\S]*?<\/table>/gi, '')
    .replace(/<sup[^>]*class="[^"]*reference[^"]*"[^>]*>[\s\S]*?<\/sup>/gi, '')
    .replace(/<sup[^>]*>\[[^\]]+\]<\/sup>/gi, '')
    .replace(/<span[^>]*class="[^"]*mw-editsection[^"]*"[^>]*>[\s\S]*?<\/span>/gi, '');

  const paragraphs: WikiToken[][] = [];
  const inlineLinkSet = new Set<string>();
  const pMatches = cleaned.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi);

  for (const pm of pMatches) {
    const pHtml = pm[1];
    const plainCheck = stripTags(pHtml);
    if (plainCheck.length < 40) continue;

    const tokens: WikiToken[] = [];
    const linkRe = /<a\b[^>]*href="\/wiki\/([^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let lastIdx = 0;
    let lm: RegExpExecArray | null;

    while ((lm = linkRe.exec(pHtml)) !== null) {
      if (lm.index > lastIdx) {
        const txt = decodeHtmlEntities(pHtml.slice(lastIdx, lm.index).replace(/<[^>]+>/g, ''));
        if (txt) tokens.push({ type: 'text', text: txt });
      }
      const rawSlug = lm[1];
      let decodedSlug = rawSlug;
      try { decodedSlug = decodeURIComponent(rawSlug); } catch {}
      const linkText = stripTags(lm[2]);
      const titleMatch = lm[0].match(/title="([^"]+)"/i);
      const canonicalTitle = (titleMatch ? decodeHtmlEntities(titleMatch[1]) : decodedSlug.replace(/_/g, ' ')).trim();

      if (linkText && isValidWikiSlug(decodedSlug) && canonicalTitle) {
        inlineLinkSet.add(canonicalTitle);
        tokens.push({
          type: 'link',
          text: linkText,
          title: canonicalTitle,
          href: `https://en.wikipedia.org/wiki/${encodeURIComponent(canonicalTitle.replace(/ /g, '_'))}`,
        });
      } else if (linkText) {
        tokens.push({ type: 'text', text: linkText });
      }
      lastIdx = lm.index + lm[0].length;
    }

    if (lastIdx < pHtml.length) {
      const tail = decodeHtmlEntities(pHtml.slice(lastIdx).replace(/<[^>]+>/g, ''));
      if (tail) tokens.push({ type: 'text', text: tail });
    }

    if (tokens.some(t => t.text.trim().length > 0)) {
      paragraphs.push(tokens);
    }
    if (paragraphs.length >= 14) break;
  }

  return { paragraphs, inlineLinks: Array.from(inlineLinkSet) };
}

async function fetchWikipediaPage(title: string): Promise<WikiPagePayload> {
  const key = title.trim().toLowerCase().replace(/_/g, ' ');
  const hit = WIKI_PAGE_CACHE.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.data;

  const url =
    `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(title.trim())}` +
    `&prop=text|displaytitle|links&redirects=1&format=json&disableeditsection=1&disabletoc=1`;

  const resp = await fetch(url, { headers: { 'User-Agent': WIKI_UA } });
  if (!resp.ok) {
    throw new Error(`Wikipedia returned status ${resp.status}`);
  }
  const json: any = await resp.json();
  if (json?.error || !json?.parse?.title) {
    throw new Error(json?.error?.info || `Wikipedia article "${title}" not found.`);
  }

  const canonicalTitle = String(json.parse.title);
  const rawHtml = String(json.parse.text?.['*'] || '');
  const { paragraphs, inlineLinks } = parseWikiHtmlToParagraphs(rawHtml);

  const linkSet = new Set<string>(inlineLinks);
  const apiLinks = Array.isArray(json.parse.links) ? json.parse.links : [];
  for (const l of apiLinks) {
    if (l?.ns === 0 && typeof l['*'] === 'string' && l.exists !== undefined) {
      const t = l['*'].trim();
      if (t && !t.startsWith('List of ') && !t.includes('(disambiguation)')) {
        linkSet.add(t);
      }
      if (linkSet.size >= 300) break;
    }
  }

  const payload: WikiPagePayload = {
    title: canonicalTitle,
    wikiUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(canonicalTitle.replace(/ /g, '_'))}`,
    paragraphs,
    links: Array.from(linkSet),
  };

  if (WIKI_PAGE_CACHE.size >= 150) {
    const oldest = WIKI_PAGE_CACHE.keys().next().value;
    if (oldest !== undefined) WIKI_PAGE_CACHE.delete(oldest);
  }
  const expiresAt = Date.now() + 5 * 60 * 1000;
  WIKI_PAGE_CACHE.set(key, { data: payload, expiresAt });
  WIKI_PAGE_CACHE.set(canonicalTitle.toLowerCase(), { data: payload, expiresAt });
  return payload;
}

app.get('/api/wiki/page', async (req: Request, res: Response) => {
  try {
    const title = String(req.query.title || '').trim();
    if (!title) {
      return res.status(400).json({ error: 'Missing ?title= parameter' });
    }
    const page = await fetchWikipediaPage(title);
    return res.json(page);
  } catch (err: any) {
    return res.status(404).json({ error: err?.message || 'Could not load Wikipedia page.' });
  }
});

app.get('/api/wiki/random-pair', async (_req: Request, res: Response) => {
  try {
    const randUrl = 'https://en.wikipedia.org/w/api.php?action=query&list=random&rnnamespace=0&rnlimit=6&format=json';
    const resp = await fetch(randUrl, { headers: { 'User-Agent': WIKI_UA } });
    if (!resp.ok) throw new Error('Wikipedia random failed');
    const json: any = await resp.json();
    const candidates: string[] = (json?.query?.random || [])
      .map((r: any) => String(r?.title || '').trim())
      .filter((t: string) => t && !t.includes('(disambiguation)') && !t.startsWith('List of '));

    const verified: string[] = [];
    for (const title of candidates) {
      try {
        const page = await fetchWikipediaPage(title);
        if (page.paragraphs.length >= 1 && page.links.length >= 12) {
          verified.push(page.title);
          if (verified.length >= 2) break;
        }
      } catch {}
    }

    if (verified.length >= 2 && verified[0].toLowerCase() !== verified[1].toLowerCase()) {
      return res.json({ start: verified[0], target: verified[1] });
    }
    return res.json({ start: 'Banana', target: 'Apollo 11' });
  } catch {
    return res.json({ start: 'Origami', target: 'Black hole' });
  }
});

app.get('/api/wiki/search', async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ results: [] });
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(q)}&limit=6&namespace=0&format=json`;
    const resp = await fetch(searchUrl, { headers: { 'User-Agent': WIKI_UA } });
    if (!resp.ok) return res.json({ results: [] });
    const json: any = await resp.json();
    const titles = Array.isArray(json?.[1]) ? json[1].map((t: any) => String(t)) : [];
    return res.json({ results: titles });
  } catch {
    return res.json({ results: [] });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
