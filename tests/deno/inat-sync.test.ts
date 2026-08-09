/**
 * Ecotopia Portal - the inat-sync photo pass, driven under Deno.
 *
 * tests/inat.test.js covers the pure logic in _shared/inat-logic.js under Node.
 * This file covers the part that cannot live there: the write path itself, with
 * fetch and the Supabase client stubbed so no request and no write ever leaves
 * the machine. The raced-UPDATE branch in particular is unreachable any other
 * way, because reproducing it for real means a staff upload landing inside a
 * window a few milliseconds wide.
 *
 *   npm run test:deno
 *   (which is: deno test -A --config tests/deno/deno.json tests/deno/)
 *
 * It is not part of `npm test`, which runs `node --test tests/*.js` and neither
 * sees nor understands this file, so it has a script of its own.
 */
import { assertEquals, assertMatch, assertRejects } from 'jsr:@std/assert@1';

// Importing index.ts runs it, and its last statement starts a server. Stub
// Deno.serve first so the import is inert, then put the real one back.
const realServe = Deno.serve;
// deno-lint-ignore no-explicit-any
(Deno as any).serve = () => ({ finished: Promise.resolve(), shutdown: () => {} });
const mod = await import('../../supabase/functions/inat-sync/index.ts');
// deno-lint-ignore no-explicit-any
(Deno as any).serve = realServe;

const { fillPhotos, imageKind } = mod;

// The photo fill ships switched OFF: fillPhotos does nothing at all unless
// INAT_PHOTO_FILL is exactly 'on'. Every test below except the two that own the
// switch is about what the fill does when it is allowed to run, so it is turned
// on here rather than repeated in each one.
Deno.env.set('INAT_PHOTO_FILL', 'on');

const PHOTO = {
  id: 7,
  license_code: 'cc-by',
  attribution: '(c) A Photographer, some rights reserved (CC BY)',
  medium_url: 'https://static.inaturalist.org/photos/7/medium.jpg',
};

const IMAGE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

type StubCfg = {
  rows: Record<string, unknown>[];
  // deno-lint-ignore no-explicit-any
  taxon?: any;
  taxonStatus?: number;
  imageStatus?: number;
  imageContentType?: string;
  imageUrl?: string;
  updateRows?: { id: string }[];
  uploadError?: { message: string };
};

type Log = {
  selects: { table: string; filters: string[] }[];
  updates: { table: string; patch: Record<string, unknown>; filters: string[] }[];
  uploads: { bucket: string; path: string; contentType: string; size: number }[];
};

function makeSb(cfg: StubCfg) {
  const log: Log = { selects: [], updates: [], uploads: [] };

  const from = (table: string) => {
    const ops: { m: string; args: unknown[] }[] = [];
    // deno-lint-ignore no-explicit-any
    const b: any = {};
    const rec = (m: string) => (...args: unknown[]) => { ops.push({ m, args }); return b; };
    for (const m of ['select', 'not', 'is', 'eq', 'update']) b[m] = rec(m);

    const filters = () => ops
      .filter((o) => o.m === 'is' || o.m === 'eq' || o.m === 'not')
      .map((o) => o.m + '(' + o.args.map((a) => JSON.stringify(a)).join(',') + ')');

    // deno-lint-ignore no-explicit-any
    b.then = (res: any, rej: any) => {
      const upd = ops.find((o) => o.m === 'update');
      let out;
      if (upd) {
        const patch = upd.args[0] as Record<string, unknown>;
        log.updates.push({ table, patch, filters: filters() });
        // PostgREST fidelity, and the reason this stub is worth having: an
        // UPDATE returns data only when the rows were asked for, and it returns
        // error: null either way. Drop the .select() from index.ts and the
        // happy-path test below fails, which is exactly the defect being fixed.
        const wantsRows = ops.some((o) => o.m === 'select');
        out = { data: wantsRows ? (cfg.updateRows ?? [{ id: 'row-1' }]) : null, error: null };
      } else {
        log.selects.push({ table, filters: filters() });
        out = { data: cfg.rows, error: null };
      }
      return Promise.resolve(out).then(res, rej);
    };
    return b;
  };

  const storage = {
    from: (bucket: string) => ({
      upload: (path: string, bytes: ArrayBuffer, o: { contentType: string }) => {
        log.uploads.push({ bucket, path, contentType: o.contentType, size: bytes.byteLength });
        return Promise.resolve(
          cfg.uploadError ? { data: null, error: cfg.uploadError } : { data: { path }, error: null },
        );
      },
    }),
  };

  // deno-lint-ignore no-explicit-any
  return { sb: { from, storage } as any, log };
}

function stubFetch(cfg: StubCfg) {
  const seen: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    if (url.startsWith('https://api.inaturalist.org/')) {
      if (cfg.taxonStatus && cfg.taxonStatus !== 200) {
        return Promise.resolve(new Response('', { status: cfg.taxonStatus }));
      }
      const body = cfg.taxon ?? { results: [{ id: 1, default_photo: PHOTO }] };
      return Promise.resolve(
        new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
      );
    }
    if (cfg.imageStatus && cfg.imageStatus !== 200) {
      return Promise.resolve(new Response('', { status: cfg.imageStatus }));
    }
    return Promise.resolve(new Response(IMAGE_BYTES, {
      headers: { 'content-type': cfg.imageContentType ?? 'image/jpeg' },
    }));
  }) as typeof fetch;
  return { seen, restore: () => { globalThis.fetch = real; } };
}

async function run(cfg: StubCfg) {
  const { sb, log } = makeSb(cfg);
  const f = stubFetch(cfg);
  try {
    // deno-lint-ignore no-explicit-any
    const counts = await (fillPhotos as any)(sb);
    return { counts, log, fetched: f.seen };
  } finally {
    f.restore();
  }
}

const eligible = (over: Record<string, unknown> = {}) => ({
  id: 'row-1', common: 'Test Species', inat_taxon_id: 1234,
  photo_path: null, inat_photo_id: null, inat_photo_status: null, ...over,
});

Deno.test('a licence-clean photo with attribution is stored and the row is filled', async () => {
  const { counts, log } = await run({ rows: [eligible()] });

  assertEquals(counts.considered, 1);
  assertEquals(counts.filled, 1);
  assertEquals(counts.skippedRaced, 0);
  assertEquals(counts.failed, 0);

  assertEquals(log.uploads.length, 1);
  assertEquals(log.uploads[0].bucket, 'gallery');
  assertMatch(log.uploads[0].path, /^plants\/[0-9a-f-]{36}\.jpg$/);
  assertEquals(log.uploads[0].contentType, 'image/jpeg');
  assertEquals(log.uploads[0].size, IMAGE_BYTES.length);

  assertEquals(log.updates.length, 1);
  const patch = log.updates[0].patch;
  assertEquals(patch.photo_path, log.uploads[0].path);
  assertEquals(patch.inat_photo_id, 7);
  assertEquals(patch.inat_photo_license, 'cc-by');
  assertEquals(patch.inat_photo_attribution, PHOTO.attribution);
  assertEquals(patch.inat_photo_source_url, 'https://www.inaturalist.org/photos/7');
  assertEquals(patch.inat_photo_status, 'auto');
});

Deno.test('the SELECT and the UPDATE both refuse a row the shared guard would refuse', async () => {
  // The two layers must line up: photo_path catches a staff upload and
  // inat_photo_id catches a staff rejection. Either can land in the window
  // between reading the row and writing it.
  const { log } = await run({ rows: [eligible()] });

  assertEquals(log.selects[0].filters, ['not("inat_taxon_id","is",null)', 'is("photo_path",null)']);
  assertEquals(log.updates[0].filters, [
    'eq("id","row-1")', 'is("photo_path",null)', 'is("inat_photo_id",null)',
  ]);
});

Deno.test('an UPDATE the database guard refused is not counted as a fill', async () => {
  // THE finding this harness exists for. PostgREST answers error: null when the
  // IS NULL predicate matches no rows, so without asking for the rows back a
  // refused write is indistinguishable from one that happened.
  const { counts, log } = await run({ rows: [eligible()], updateRows: [] });

  assertEquals(counts.filled, 0, 'a refused write must never be reported as a fill');
  assertEquals(counts.skippedRaced, 1);
  assertEquals(counts.failed, 0, 'the row guard firing is not a failure');
  assertEquals(counts.considered, 1);
  assertEquals(log.uploads.length, 1, 'the object was already uploaded and is left orphaned');
});

Deno.test('a PNG is stored as a PNG, not under a .jpg name', async () => {
  const { counts, log } = await run({
    rows: [eligible()],
    taxon: { results: [{ id: 1, default_photo: { ...PHOTO, medium_url: 'https://x/7.png' } }] },
    imageContentType: 'image/png',
  });

  assertEquals(counts.filled, 1);
  assertMatch(log.uploads[0].path, /\.png$/);
  assertEquals(log.uploads[0].contentType, 'image/png');
  assertMatch(String(log.updates[0].patch.photo_path), /\.png$/);
});

Deno.test('a photo with a usable licence but no attribution is refused', async () => {
  const { counts, log } = await run({
    rows: [eligible()],
    taxon: { results: [{ id: 1, default_photo: { ...PHOTO, attribution: '   ' } }] },
  });

  assertEquals(counts.noAttribution, 1);
  assertEquals(counts.filled, 0);
  assertEquals(log.uploads.length, 0, 'an uncreditable photo must not even be downloaded');
  assertEquals(log.updates.length, 0);
});

Deno.test('a NonCommercial-only taxon is counted and left alone', async () => {
  const { counts, log } = await run({
    rows: [eligible()],
    taxon: { results: [{ id: 1, default_photo: { ...PHOTO, license_code: 'cc-by-nc' } }] },
  });

  assertEquals(counts.noUsableLicence, 1);
  assertEquals(counts.filled, 0);
  assertEquals(log.uploads.length, 0);
  assertEquals(log.updates.length, 0);
});

Deno.test('the client\'s own photograph is never touched, even if the SELECT returns it', async () => {
  // The query filter normally means these rows never reach the loop at all.
  // This is the belt to that braces: if the filter is ever loosened, canAutoFill
  // still refuses them here.
  const { counts, log } = await run({
    rows: [
      eligible({ id: 'own', photo_path: 'static:wild-columbine.jpg' }),
      eligible({ id: 'rejected', inat_photo_id: 99, inat_photo_status: 'rejected' }),
      eligible({ id: 'bare-id', inat_photo_id: 99, inat_photo_status: null }),
    ],
  });

  assertEquals(counts.skippedOwn, 1);
  assertEquals(counts.skippedDecided, 2);
  assertEquals(counts.considered, 0);
  assertEquals(counts.filled, 0);
  assertEquals(log.uploads.length, 0);
  assertEquals(log.updates.length, 0, 'not one write may be attempted');
});

Deno.test('a rate limit stops the whole run rather than skipping one row', async () => {
  const { sb } = makeSb({ rows: [eligible(), eligible({ id: 'row-2' })] });
  const f = stubFetch({ rows: [], taxonStatus: 429 });
  try {
    const e = await assertRejects(
      // deno-lint-ignore no-explicit-any
      () => (fillPhotos as any)(sb),
      Error,
      'rate_limited',
    );
    // deno-lint-ignore no-explicit-any
    assertEquals(typeof (e as any).counts.considered, 'number', 'partial counts must survive');
  } finally {
    f.restore();
  }
});

Deno.test('a failed download is counted, logged and does not write', async () => {
  const { counts, log } = await run({ rows: [eligible()], imageStatus: 404 });

  assertEquals(counts.failed, 1);
  assertEquals(counts.filled, 0);
  assertEquals(log.uploads.length, 0);
  assertEquals(log.updates.length, 0);
});

Deno.test('a failed upload never writes the row', async () => {
  const { counts, log } = await run({
    rows: [eligible()],
    uploadError: { message: 'storage exploded' },
  });

  assertEquals(counts.failed, 1);
  assertEquals(counts.filled, 0);
  assertEquals(log.updates.length, 0, 'a row must never point at an object that was not stored');
});

Deno.test('the fill does nothing at all unless INAT_PHOTO_FILL is exactly "on"', async () => {
  // The ordering rule (the credit line live before any photo is written) used to
  // be a sentence in a runbook, which an unattended cron cannot read. It is now
  // a switch that defaults to off, and "off" has to mean no API call, no storage
  // write and no database write, not merely no fill.
  const before = Deno.env.get('INAT_PHOTO_FILL');
  try {
    for (const value of [null, '', 'true', '1', 'yes', 'ON', 'off']) {
      if (value === null) Deno.env.delete('INAT_PHOTO_FILL');
      else Deno.env.set('INAT_PHOTO_FILL', value);
      const label = value === null ? 'unset' : JSON.stringify(value);

      const { counts, log, fetched } = await run({ rows: [eligible()] });

      assertEquals(counts.disabled, true, label + ' must leave the fill switched off');
      assertEquals(counts.considered, 0, label);
      assertEquals(counts.filled, 0, label);
      assertEquals(fetched.length, 0, label + ': a disabled fill must not call iNaturalist');
      assertEquals(log.selects.length, 0, label + ': a disabled fill must not even read the table');
      assertEquals(log.updates.length, 0, label + ': a disabled fill must never write a row');
      assertEquals(log.uploads.length, 0, label + ': a disabled fill must not touch storage');
    }
  } finally {
    if (before === undefined) Deno.env.delete('INAT_PHOTO_FILL');
    else Deno.env.set('INAT_PHOTO_FILL', before);
  }
});

Deno.test('"on" re-enables the fill, and disabled is distinguishable from nothing to do', async () => {
  Deno.env.set('INAT_PHOTO_FILL', 'on');

  const enabled = await run({ rows: [eligible()] });
  assertEquals(enabled.counts.disabled, false, 'a run that did work is not disabled');
  assertEquals(enabled.counts.filled, 1);
  assertEquals(enabled.log.updates.length, 1);

  // Zeroed counts on their own say nothing. An eligible-but-empty run reports the
  // same zeros as a switched-off one, so disabled is the only thing that tells a
  // caller which of the two happened.
  const empty = await run({ rows: [] });
  assertEquals(empty.counts.disabled, false, 'an empty run is not a disabled run');
  assertEquals(empty.counts.considered, 0);
  assertEquals(empty.log.selects.length, 1, 'an enabled run reads the table even when empty');
});

Deno.test('imageKind trusts the served content type, then the URL, then jpeg', () => {
  assertEquals(imageKind('https://x/a.jpg', 'image/jpeg'), { ext: 'jpg', mime: 'image/jpeg' });
  assertEquals(imageKind('https://x/a.jpg', 'image/png'), { ext: 'png', mime: 'image/png' });
  assertEquals(imageKind('https://x/a.png', 'image/png; charset=binary'),
    { ext: 'png', mime: 'image/png' });
  // A server that will not say: fall back to the URL.
  assertEquals(imageKind('https://x/a.png', 'application/octet-stream'),
    { ext: 'png', mime: 'image/png' });
  assertEquals(imageKind('https://x/a.PNG?size=medium', null), { ext: 'png', mime: 'image/png' });
  assertEquals(imageKind('https://x/a.jpeg', null), { ext: 'jpg', mime: 'image/jpeg' });
  assertEquals(imageKind('https://x/a.webp', null), { ext: 'webp', mime: 'image/webp' });
  // Neither says anything usable: jpeg, which is what iNaturalist serves.
  assertEquals(imageKind('https://x/medium', null), { ext: 'jpg', mime: 'image/jpeg' });
  assertEquals(imageKind('', null), { ext: 'jpg', mime: 'image/jpeg' });
});
