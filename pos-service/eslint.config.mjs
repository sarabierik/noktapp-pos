/**
 * ESLint, scoped to what actually catches bugs here.
 *
 * This codebase is 38,000 lines that were written without a linter, so a
 * default "recommended" config reports several thousand stylistic opinions and
 * nobody reads any of them. That is the failure mode to avoid: a linter whose
 * output is ignored is worse than none, because CI goes red for reasons no one
 * trusts.
 *
 * So: errors are only the rules that find REAL defects - a variable that does
 * not exist, a promise nobody awaited, a duplicate object key, an unreachable
 * branch. Formatting is not linted at all; the code is already consistent and
 * a reformat would bury the history that does not yet exist in git.
 *
 * Widen it later, one rule at a time, when the bench is green and you have
 * time to fix what it finds.
 */
export default [
  {
    files: ['**/*.js'],
    ignores: ['node_modules/**', 'coverage/**', 'public/vendor/**'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly', module: 'writable', exports: 'writable',
        process: 'readonly', __dirname: 'readonly', __filename: 'readonly',
        Buffer: 'readonly', console: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', setImmediate: 'readonly', fetch: 'readonly',
        TextEncoder: 'readonly', TextDecoder: 'readonly', AbortController: 'readonly',
        structuredClone: 'readonly', crypto: 'readonly', AbortSignal: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', {
        args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none',
      }],
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-cond-assign': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-self-assign': 'error',
      'no-self-compare': 'error',
      'no-unsafe-negation': 'error',
      'no-unsafe-optional-chaining': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'require-atomic-updates': 'off',
      'no-async-promise-executor': 'error',
      'no-await-in-loop': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    /* The front end is browser code loaded by <script> tags, not modules. */
    files: ['public/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        window: 'readonly', document: 'readonly', location: 'readonly',
        localStorage: 'readonly', sessionStorage: 'readonly', navigator: 'readonly',
        fetch: 'readonly', console: 'readonly', alert: 'readonly', confirm: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', requestAnimationFrame: 'readonly', URL: 'readonly',
        URLSearchParams: 'readonly', Blob: 'readonly', FileReader: 'readonly',
        FormData: 'readonly', Image: 'readonly', Intl: 'readonly', CustomEvent: 'readonly',
        history: 'readonly', screen: 'readonly', getComputedStyle: 'readonly',
        crypto: 'readonly', WebSocket: 'readonly', EventSource: 'readonly',
      },
    },
    rules: {
      'no-undef': 'off',
      /*
       * Every screen file is loaded by its own <script> tag and they share one
       * global scope: app.js defines `registerPage`, `closeModal`, `esc` and a
       * dozen more that only the OTHER files use. To one-file-at-a-time
       * analysis every one of those looks dead. Warn rather than error, so a
       * genuinely unused local is still visible without CI failing on the
       * architecture.
       */
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
    },
  },

  {
    /*
     * The suites drive a real browser through Playwright, so half of a test
     * file is Node and the other half is closures that run inside the page -
     * `page.evaluate(() => go('masalar'))`. ESLint sees one file and cannot
     * tell which half a name belongs to, so the page's own globals are
     * declared here rather than sprinkling eslint-disable through the suites.
     */
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        document: 'readonly', window: 'readonly', location: 'readonly',
        navigator: 'readonly', getComputedStyle: 'readonly', localStorage: 'readonly',
        /*
         * DOM constructors, for the same reason. A screenshot script that has
         * to make a <select> react does `s.dispatchEvent(new Event('change'))`
         * inside the page - `new Event` is the page's constructor, not Node's,
         * and without this line CI fails the whole lint job on one word.
         */
        Event: 'readonly', CustomEvent: 'readonly',
        MouseEvent: 'readonly', KeyboardEvent: 'readonly',
        /* the till's own front-end globals, as seen from inside page.evaluate */
        App: 'readonly', Screens: 'readonly', PAGES: 'readonly', HELP: 'readonly',
        SEARCH: 'readonly', go: 'readonly', api: 'readonly', closeModal: 'readonly',
        closeSearch: 'readonly', enterApp: 'readonly', drawNav: 'readonly',
        refreshFeatures: 'readonly', helpAll: 'readonly', helpSearch: 'readonly',
        helpEntry: 'readonly', helpKey: 'readonly', helpIsOpen: 'readonly',
        searchHits: 'readonly', pageOffered: 'readonly', groupMembers: 'readonly',
      },
    },
  },
];
