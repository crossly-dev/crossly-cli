/**
 * Exit codes.
 *
 * A CLI's exit code is its API for everything that is not a human. A script or
 * an agent that gets `1` for "your token expired" and `1` for "that listing
 * does not exist" has to parse English to decide whether retrying is even
 * sensible — so the two cases that change what a caller should DO get their own
 * codes.
 *
 * Deliberately small. Every code here answers a different "what now?":
 *
 *   0  it worked
 *   1  the request failed — the API said no, or something broke
 *   2  you typed it wrong — no request was made
 *   4  not authenticated — run `crossly login`
 *   5  authenticated, but this token lacks the scope — re-authorize
 *
 * 4 and 5 are split because the remedy is different: 4 needs a login, 5 needs
 * a DIFFERENT login with more scopes, and an agent that conflates them loops
 * forever re-running a login that was never the problem.
 */
export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  unauthenticated: 4,
  forbiddenScope: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * Thrown by commands to exit with a specific code and message.
 *
 * Carries the code so the top-level handler stays a single place that decides
 * how anything is printed — a command that called `process.exit` itself would
 * bypass `--json`, and an agent parsing stdout would get prose where it
 * expected an object.
 */
export class CliError extends Error {
  constructor(
    message: string,
    public readonly code: ExitCode = EXIT.failure,
    /** Machine-readable, mirrors the API's error envelope where there is one. */
    public readonly errorCode?: string,
    /** The API's correlation id — the thread back to Grafana. */
    public readonly correlationId?: string,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

/** A usage problem: nothing was sent, and the fix is the command line itself. */
export function usageError(message: string): CliError {
  return new CliError(message, EXIT.usage, 'usage');
}
