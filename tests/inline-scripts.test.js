/**
 * Syntax check for every inline <script> in the repo's HTML pages.
 *
 * Five plan documents in docs/superpowers claimed `npm test` already did this. It
 * did not: package.json runs `node --test tests/*.js` and no test opened an HTML
 * file, so no branch in this repo has ever had its inline scripts parsed by
 * anything but a browser. This file makes the claim true.
 *
 * The pages carry most of this codebase's logic inline, including deeply nested
 * template literals inside template literals, which is exactly the construct that
 * produces a syntax error a reviewer's eye slides over and that takes a whole page
 * down at load with a blank screen.
 *
 * The check is `new vm.Script(source)`, which runs V8's parser over the source in
 * script goal and throws SyntaxError on bad input, without executing a single
 * statement. That is what `node --check <file>` does, minus writing 70 temporary
 * files and spawning 70 processes.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

// Attribute-bearing open tag, lazy body, close tag. A page whose inline script
// contained a literal '</script>' inside a string would be cut short here and
// almost certainly fail to parse, which is correct: the browser's HTML parser cuts
// it at the same place, so such a page is broken in production too.
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

const attr = (attrs, name) => {
  const m = new RegExp(name + '\\s*=\\s*["\']([^"\']*)["\']', 'i').exec(attrs);
  return m ? m[1].trim().toLowerCase() : null;
};

// Anything the browser executes as a classic script. A bare <script> has no type.
const JS_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'module']);

function htmlPages() {
  return fs.readdirSync(ROOT)
    .filter((f) => f.endsWith('.html'))
    .sort();
}

// Returns { file, line, type, source } for every inline block worth checking.
// External scripts (src=) belong to their own files and are checked there or by
// their own suites. Non-JS payloads such as application/ld+json are data, not code.
function inlineScripts(file) {
  const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const out = [];
  let m;
  SCRIPT_RE.lastIndex = 0;
  while ((m = SCRIPT_RE.exec(html)) !== null) {
    const [whole, attrs, source] = m;
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = attr(attrs, 'type') || '';
    if (!JS_TYPES.has(type)) continue;
    // 1-indexed line of the page the block's body starts on, so a SyntaxError
    // reports a line number that can be opened in the HTML file directly.
    const bodyStart = m.index + whole.indexOf('>', 0) + 1;
    const line = html.slice(0, bodyStart).split('\n').length;
    out.push({ file, line, type, source });
  }
  return out;
}

const ALL = htmlPages().flatMap(inlineScripts);

test('the extractor actually finds the pages and their inline scripts', () => {
  // Without this, a regex that silently matched nothing would make every check
  // below vacuously pass, which is the exact failure mode this whole file exists
  // to end. The repo has 46 pages and 71 bare inline blocks; the floors are set
  // well under those so ordinary page churn does not trip them.
  assert.ok(htmlPages().length >= 40, 'found only ' + htmlPages().length + ' HTML pages');
  assert.ok(ALL.length >= 60, 'found only ' + ALL.length + ' inline scripts');
  // The pages this branch touched must each be in the set, by name.
  for (const f of ['community-gardens.html', 'gardens.html', 'garden-detail.html']) {
    assert.ok(ALL.some((s) => s.file === f), 'no inline script extracted from ' + f);
  }
});

test('the checker itself rejects a syntax error', () => {
  // Proves the mechanism throws. A checker that cannot fail is not a check, and a
  // silently-passing syntax check is worse than none: it is a claim in a plan.
  assert.throws(
    () => new vm.Script('const x = `${ unclosed', { filename: 'fixture.js' }),
    SyntaxError
  );
  assert.throws(() => new vm.Script('function ( {'), SyntaxError);
  // And that it accepts the nested-template-literal construct these pages use, so
  // it cannot pass by rejecting everything.
  new vm.Script('const a = [1]; const h = `<p>${a.map(x => `<i>${x}</i>`).join("")}</p>`;');
});

test('no ES module inline scripts, which this checker cannot parse', () => {
  // vm.Script parses in script goal, so a top-level import/export would be reported
  // as a syntax error that is not one. None exist today. If one is ever added, this
  // fails loudly rather than the checker quietly lying about the page.
  const modules = ALL.filter((s) => s.type === 'module');
  assert.deepStrictEqual(
    modules.map((s) => s.file + ':' + s.line), [],
    'inline type="module" script found; teach this checker vm.SourceTextModule'
  );
});

// One subtest per page, so a failure names the file rather than the suite.
for (const file of htmlPages()) {
  const blocks = ALL.filter((s) => s.file === file);
  if (!blocks.length) continue;
  test('inline scripts parse: ' + file, () => {
    for (const b of blocks) {
      try {
        // lineOffset makes a thrown SyntaxError report the line in the HTML page.
        new vm.Script(b.source, { filename: b.file, lineOffset: b.line - 1 });
      } catch (err) {
        // The first stack line carries V8's own file:line for the offending token,
        // already shifted into HTML line numbers by lineOffset, so the failure
        // names a line the maintainer can open rather than the block's start.
        const where = String(err.stack || '').split('\n')[0];
        assert.fail(
          'SyntaxError in inline script in ' + b.file + ' (block starts line ' + b.line +
          '): ' + err.message + '\n  at ' + where
        );
      }
    }
  });
}
