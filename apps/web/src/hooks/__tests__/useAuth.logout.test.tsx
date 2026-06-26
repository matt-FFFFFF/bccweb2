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

const nowSec = () => Math.floor(Date.now() / 1000);

const IDENTITY = JSON.stringify({ userId: "u1", email: "a@b.test", roles: ["Pilot"], pilotId: null, clubId: null });

describe("useAuth logout", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  test("revokes server-side with a valid access token, then clears storage", async () => {
    const accessToken = fakeJwt(nowSec() + 3600);
    localStorage.setItem("bcc_access_token", accessToken);
    localStorage.setItem("bcc_refresh_token", fakeJwt(nowSec() + 86_400));
    localStorage.setItem("bcc_identity", IDENTITY);

    const fetchMock = vi.fn(async () => ({ ok: true, status: 204, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.logout();
    });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/auth/logout",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: `Bearer ${accessToken}` }),
        }),
      ),
    );
    expect(fetchMock).not.toHaveBeenCalledWith("/api/auth/refresh", expect.anything());
    expect(localStorage.getItem("bcc_access_token")).toBeNull();
  });

  test("mints a fresh access token when the stored one is expired, then revokes", async () => {
    const freshAccess = fakeJwt(nowSec() + 3600);
    localStorage.setItem("bcc_access_token", fakeJwt(nowSec() + 3600));
    localStorage.setItem("bcc_refresh_token", fakeJwt(nowSec() + 86_400));
    localStorage.setItem("bcc_identity", IDENTITY);

    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/auth/refresh") {
        return { ok: true, status: 200, json: async () => ({ accessToken: freshAccess, expiresIn: 3600 }) };
      }
      return { ok: true, status: 204, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    localStorage.setItem("bcc_access_token", fakeJwt(nowSec() - 60));

    act(() => {
      result.current.logout();
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/auth/refresh", expect.anything()));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/auth/logout",
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: `Bearer ${freshAccess}` }) }),
      ),
    );
  });

  test("clears storage without a revocation call when no usable token exists", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 204, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.logout();
    });

    expect(fetchMock).not.toHaveBeenCalledWith("/api/auth/logout", expect.anything());
    expect(result.current.identity).toBeNull();
  });
});
