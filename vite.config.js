import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * Build produces exactly one self-contained HTML file.
 *
 * The requirement is that a player can double-click the game and play it with
 * no server, no install and no network. That rules out ES modules in the
 * browser: `type="module"` scripts are fetched under CORS rules, and a
 * file:// origin is opaque, so Chrome refuses to load them from disk.
 *
 * The approach is therefore two-stage:
 *
 *   1. Let Vite do what it is good at - bundle the whole module graph,
 *      Three.js included, into one script with Rollup's default ESM output.
 *      Forcing `format: 'iife'` here was tried and produces an EMPTY bundle,
 *      because it conflicts with Vite 8's internal chunking.
 *   2. Rewrite the emitted `<script type="module">` tag to a plain `<script>`
 *      in a post hook. This is safe precisely because Rollup has already
 *      resolved every import: by the time the file is inlined there are no
 *      module-level imports left for the browser to fetch.
 *
 * Development is unaffected: `npm run dev` still serves the real module graph
 * with HMR, and only this production output is collapsed.
 */

/**
 * Convert the inlined module script into a classic script, and move it to the
 * end of `<body>`.
 *
 * Two problems are fixed here, and both only appear in the single-file output:
 *
 *   1. `type="module"` breaks `file://` loading (CORS on an opaque origin).
 *      Safe to drop, because Rollup has already resolved every import.
 *   2. Vite emits the script into `<head>`, where `defer` semantics of a module
 *      script used to save it. Once the tag becomes a plain script it runs
 *      immediately, before `<body>` exists, so any `getElementById` returns
 *      null. Moving it to the end of the body restores the original ordering.
 *
 * Matches the tag loosely: the `crossorigin` hint is present in some Vite
 * versions and absent in others.
 */
function classicScriptAtEndOfBody() {
  return {
    name: 'elite-classic-script',
    enforce: 'post',
    transformIndexHtml(html) {
      let extracted = null;
      const stripped = html.replace(
        /<script\b([^>]*?)\stype="module"([^>]*)>([\s\S]*?)<\/script>/g,
        (match, before, after, body) => {
          const attrs = (before + ' ' + after)
            .replace(/\bcrossorigin\b/g, '')
            .replace(/\s+/g, ' ')
            .trim();
          extracted = attrs ? `<script ${attrs}>${body}</script>` : `<script>${body}</script>`;
          return '<!--elite-script-->';
        }
      );
      if (!extracted) return html;
      return stripped.replace('<!--elite-script-->', '').replace(
        '</body>',
        extracted + '\n</body>'
      );
    },
  };
}

export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    outDir: 'dist',
    emptyOutDir: true,
    // One file means one script; disable chunking and asset splitting.
    cssCodeSplit: false,
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 8000,
  },
  plugins: [viteSingleFile({ removeViteModuleLoader: true }), classicScriptAtEndOfBody()],
});
