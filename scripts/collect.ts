import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { sources } from './sources';
import { fetchRss } from './lib/fetch-rss';
import { fetchNewsroom } from './lib/fetch-newsroom';
import { hashUrl } from './lib/hash';
import { isRelevant } from './lib/relevance';
import { collectExistingIds } from './lib/dedup';
import { RawFileSchema, type Article } from '../src/lib/schema';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const RAW_DIR = resolve(REPO_ROOT, 'raw');
const POLITE_DELAY_MS = 2000;

async function main() {
  if (!existsSync(RAW_DIR)) mkdirSync(RAW_DIR);

  const existingIds = collectExistingIds(RAW_DIR);
  console.log(`Existing article IDs: ${existingIds.size}`);

  const newArticles: Article[] = [];

  // Group sources by hostname: different domains run in parallel, but a single
  // domain stays polite — its requests go sequentially with the delay between
  // them. Items are deduped against the shared `existingIds` set (each item's
  // check-and-add is synchronous, so concurrent sources can't double-add an id),
  // and results are reassembled in the original source order below.
  const byDomain = new Map<string, { source: (typeof sources)[number]; idx: number }[]>();
  sources.forEach((source, idx) => {
    let host: string;
    try { host = new URL(source.url).hostname; } catch { host = source.url; }
    const group = byDomain.get(host) ?? [];
    group.push({ source, idx });
    byDomain.set(host, group);
  });

  const perSource = new Map<number, Article[]>();
  await Promise.all(
    Array.from(byDomain.values()).map(async (group) => {
      for (let i = 0; i < group.length; i++) {
        const { source, idx } = group[i];
        const collected: Article[] = [];
        try {
          console.log(`Fetching ${source.name}...`);
          const items = source.type === 'rss'
            ? await fetchRss(source.url)
            : await fetchNewsroom(source.url);

          for (const item of items) {
            const id = hashUrl(item.url);
            if (existingIds.has(id)) continue;
            if (!isRelevant({ title: item.title, body_text: item.body_text })) continue;
            existingIds.add(id);
            collected.push({
              id,
              url: item.url,
              title: item.title,
              published_at: item.published_at,
              source: source.name,
              body_text: item.body_text
            });
          }
        } catch (err) {
          console.error(`✗ ${source.name} failed:`, (err as Error).message);
        }
        perSource.set(idx, collected);
        // Politeness: delay only between consecutive requests to the SAME domain.
        if (i < group.length - 1) await sleep(POLITE_DELAY_MS);
      }
    }),
  );

  // Reassemble in original source order so output ordering stays stable.
  for (let i = 0; i < sources.length; i++) {
    const arr = perSource.get(i);
    if (arr) newArticles.push(...arr);
  }

  if (newArticles.length === 0) {
    console.log('No new articles. Nothing to write.');
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const outFile = resolve(RAW_DIR, `${today}.json`);

  let payload;
  if (existsSync(outFile)) {
    const existing = RawFileSchema.parse(JSON.parse(readFileSync(outFile, 'utf-8')));
    payload = {
      fetched_at: new Date().toISOString(),
      articles: [...existing.articles, ...newArticles]
    };
  } else {
    payload = { fetched_at: new Date().toISOString(), articles: newArticles };
  }

  RawFileSchema.parse(payload);  // self-check
  writeFileSync(outFile, JSON.stringify(payload, null, 2) + '\n');
  console.log(`✓ Wrote ${newArticles.length} new articles to ${outFile}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
