import { describe, expect, test, beforeEach, vi } from "vitest";
import type { ReactNode } from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router";
import { AuthProvider, useAuth } from "../useAuth.js";

function fakeJwt(expEpochSec: number): string {
  return `h.${btoa(JSON.stringify({ exp: expEpochSec }))}.s`;
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <BrowserRouter>
      <AuthProvider>{children}</AuthProvider>
    </BrowserRouter>
  );
}

describe("useAuth logout", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  test("calls POST /api/auth/logout with the bearer token, then clears storage", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const accessToken = fakeJwt(nowSec + 3600);
    localStorage.setItem("bcc_access_token", accessToken);
    localStorage.setItem("bcc_refresh_token", fakeJwt(nowSec + 86_400));
    localStorage.setItem(
      "bcc_identity",
      JSON.stringify({ userId: "u1", email: "a@b.test", roles: ["Pilot"], pilotId: null, clubId: null }),
    );

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.logout();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: `Bearer ${accessToken}` }),
      }),
    );
    expect(localStorage.getItem("bcc_access_token")).toBeNull();
    expect(localStorage.getItem("bcc_refresh_token")).toBeNull();
    expect(localStorage.getItem("bcc_identity")).toBeNull();
  });

  test("without an access token, clears storage and makes no revocation call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.logout();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.identity).toBeNull();
  });
});
