// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { RoundManageHeader } from "../RoundManageHeader.js";
import type { Round } from "@bccweb/types";

function makeRound(ptStatus?: "pending" | "processing" | "ready" | "failed", ptGroupId?: number, ptGroupName?: string, ptGroupSlug?: string): Round {
  return {
    id: "r1",
    date: "2026-06-09",
    status: "Locked",
    isLocked: true,
    maxTeams: 8,
    minimumScore: 0,
    site: { id: "s1", name: "Milk Hill" },
    organisingClub: { id: "cA", name: "Club A" },
    season: { year: 2026 },
    teams: [],
    pureTrack: ptStatus ? { status: ptStatus, attemptId: "123" } : undefined,
    pureTrackGroupId: ptGroupId,
    pureTrackGroupName: ptGroupName,
    pureTrackGroupSlug: ptGroupSlug,
  } as unknown as Round; // Using 'as unknown as Round' for brevity, only including what's needed
}

describe("RoundManageHeader", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders 'PureTrack Groups Ready' when ready and group exists", () => {
    render(
      <MemoryRouter>
        <RoundManageHeader
          r={makeRound("ready", 123, "Group 1", "group-1")}
          canManage={true}
          pollTimeout={null}
          ptPollTimeout={null}
          regeneratePdf={vi.fn()}
          recreatePureTrack={vi.fn()}
        />
      </MemoryRouter>
    );

    expect(screen.getByText("PureTrack Groups Ready")).toBeInTheDocument();
  });

  it("renders 'PureTrack: no groups (none created)' when ready but no group exists", () => {
    render(
      <MemoryRouter>
        <RoundManageHeader
          r={makeRound("ready", undefined, undefined, undefined)}
          canManage={true}
          pollTimeout={null}
          ptPollTimeout={null}
          regeneratePdf={vi.fn()}
          recreatePureTrack={vi.fn()}
        />
      </MemoryRouter>
    );

    expect(screen.getByText("PureTrack: no groups (none created)")).toBeInTheDocument();
    expect(screen.queryByText("PureTrack Groups Ready")).not.toBeInTheDocument();
  });
});
