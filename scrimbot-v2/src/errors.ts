/** Discord JSON error code (for example 50013 Missing Permissions), if the error has one. */
export function apiErrorCode(e: unknown): number | undefined {
  if (e && typeof e === 'object' && 'code' in e) {
    const code = (e as { code: unknown }).code;
    if (typeof code === 'number') return code;
  }
  return undefined;
}

/** HTTP status of a Discord API error, if the error has one. */
export function apiErrorStatus(e: unknown): number | undefined {
  if (e && typeof e === 'object' && 'status' in e) {
    const status = (e as { status: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
