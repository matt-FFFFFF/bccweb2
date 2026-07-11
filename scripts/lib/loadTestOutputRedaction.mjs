// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0

const REDACTED = "[REDACTED]";
const PATTERNS = [
  [/("(?:accessToken|refreshToken|password|passwordHash)"\s*:\s*")[^"]*(")/giu, `$1${REDACTED}$2`],
  [/(Authorization\s*:\s*Bearer\s+)[^\s"']+/giu, `$1${REDACTED}`],
  [/(AccountKey=)[^;\s]+/giu, `$1${REDACTED}`],
  [/((?:ADMIN_PASSWORD|JWT_SECRET)\s*=\s*)[^\s]+/giu, `$1${REDACTED}`],
  [/(BCC ADMIN PASSWORD:\s*)[^\s]+/giu, `$1${REDACTED}`],
];

export function redactLoadTestOutput(output) {
  return PATTERNS.reduce(
    (redacted, [pattern, replacement]) => redacted.replace(pattern, replacement),
    output,
  );
}
