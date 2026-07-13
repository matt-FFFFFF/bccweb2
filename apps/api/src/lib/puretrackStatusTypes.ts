// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import type { PureTrackStatus, RoundStatus } from "@bccweb/types";

export interface SetPureTrackStatusOptions {
  readonly error?: string;
  readonly expectAttemptId?: string;
  readonly expectOwnerToken?: string;
  readonly fromStatuses?: readonly PureTrackStatus[];
  readonly newAttemptId?: string;
  readonly newOwnerToken?: string;
  readonly requireRoundStatuses?: readonly RoundStatus[];
  readonly rejectStatuses?: readonly PureTrackStatus[];
}
