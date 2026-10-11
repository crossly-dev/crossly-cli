/**
 * Exit codes.
 *
 * Distinct codes for distinct remedies — that is the whole point. A script
 * wrapping this needs to tell "your token expired, re-auth" from "you asked for
 * a scope you were never granted, send the user back through consent" from "the
 * listing does not exist". Collapsing all of those into 1 makes the wrapper
 * guess, and it will guess wrong on the scope case.
 *
 * Matches @crossly/cli so a script can treat both the same way.
 */
export const EXIT = {
  ok: 0,
  /** The request was well-formed and the API said no, or the network failed. */
  failure: 1,
  /** The user typed something wrong. Nothing was sent. */
  usage: 2,
  /** No token, or the token is rejected. Remedy: authenticate. */
  unauthenticated: 4,
  /** Authenticated, but the token lacks the scope. Remedy: re-consent. */
  forbiddenScope: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  readonly code: ExitCode;
  /** The API's correlation id, when there was one — the thread back to logs. */
  readonly correlationId?: string;

  constructor(message: string, code: ExitCode = EXIT.failure, correlationId?: string) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.correlationId = correlationId;
  }
}

/**
 * Map a thrown error onto an exit code.
 *
 * The scope case is why this is a function rather than a constant: a 403 whose
 * body mentions a scope is a DIFFERENT problem from a 403 that does not, and
 * only the message distinguishes them.
 */
export function exitCodeFor(err: unknown): ExitCode {
  if (err instanceof CliError) return err.code;

  const status = (err as { status?: number })?.status;
  if (status === 401) return EXIT.unauthenticated;
  if (status === 403) {
    const text = `${(err as { code?: string })?.code ?? ''} ${(err as Error)?.message ?? ''}`;
    return /scope/i.test(text) ? EXIT.forbiddenScope : EXIT.failure;
  }
  return EXIT.failure;
}
