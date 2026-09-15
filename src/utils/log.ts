// Build-time-gated debug logging.
//
// `process.env.DEBUG_LOGGING` is substituted by dotenv-webpack from `.env.<BUILD_ENV>`
// at build time: "true" in `.env.development`, "false" in `.env.production`. The
// minifier then dead-code-eliminates the guarded `console.log` calls from the
// production bundle entirely, so nothing verbose (survey payloads, URLs, Remote
// Config contents) is emitted to the console in a shipped build.
//
// `console.warn` / `console.error` are intentionally NOT routed through here -
// genuine error reporting stays on in production.

// `process` is not in the `chrome`-only lib types; dotenv-webpack replaces this
// expression with a literal at build time, so a minimal ambient type is enough.
declare const process: { env: Record<string, string | undefined> } | undefined;

// Deliberately NOT `process?.env?.DEBUG_LOGGING`: TS downlevels that optional chain into
// ternaries *before* dotenv-webpack's replacement pass runs, which splits `process.env` off
// from `.DEBUG_LOGGING` and leaves dotenv-webpack unable to pattern-match the member
// expression it substitutes - it was silently falling back to its "variable not found"
// placeholder, which is never `=== 'true'`, so this was hard-wired `false` in every build
// (dev and prod) no matter what the `.env` files said. Plain dot access keeps the
// `process.env.DEBUG_LOGGING` expression intact so the substitution actually applies.
const DEBUG_LOGGING: boolean =
  typeof process !== 'undefined' && process.env.DEBUG_LOGGING === 'true';

export function debug(...args: unknown[]): void {
  if (DEBUG_LOGGING) {
    // eslint-disable-next-line no-console
    console.log(...args);
  }
}
