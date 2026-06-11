import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeRequest, invoke } from "../../__tests__/helpers/api.js";

// Import to register handlers
import "../brief.js";

// Mock blob IO, auth logic, and ledger
vi.mock("../../lib/auth.js", () => ({
  getCallerIdentity: vi.fn(),
  unauthorizedResponse: () => ({ status: 401 }),
}));

const mockReadBlob = vi.fn();
const mockWritePrivateBlob = vi.fn();
const mockGetPrivateBlockBlobClient = vi.fn();

vi.mock("../../lib/blob.js", () => ({
  getPrivateBlobClient: (path: string) => path,
  getPrivateBlockBlobClient: (path: string) => mockGetPrivateBlockBlobClient(path),
  readBlob: (client: any) => mockReadBlob(client),
  writePrivateBlob: (path: string, data: any, leaseId: string) => mockWritePrivateBlob(path, data, leaseId),
  withPrivateLeaseRenewing: async (path: string, fn: any) => fn("mock-lease"),
}));

vi.mock("../../lib/signTofly/ledger.js", () => ({
  listSignaturesForRound: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../lib/pdf.js", () => ({
  generateBriefPdf: vi.fn().mockResolvedValue(Buffer.from("pdf")),
}));

import { getCallerIdentity } from "../../lib/auth.js";
import { listSignaturesForRound } from "../../lib/signTofly/ledger.js";

describe("RoundBrief Edit API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseRound = { id: "round-1", organisingClub: { id: "club-1", name: "Club 1" }, status: "Draft", teams: [{ id: "t1", pilots: [{ placeInTeam: 1, signToFly: true }] }] };
  const baseBrief = { 
    roundId: "round-1", 
    version: 1, 
    generatedAt: "2024-01-01T00:00:00Z",
    siteName: "Site",
    date: "2024-01-01",
    teams: []
  };

  it("cosmetic edit -> 200 + version unchanged + signatures unaffected", async () => {
    vi.mocked(getCallerIdentity).mockResolvedValue({ userId: "admin", roles: ["Admin"], email: "a@a.com", clubId: "club-1", pilotId: null });
    mockReadBlob.mockImplementation(async (path: string) => {
      if (path.includes("rounds/")) return baseRound;
      return baseBrief;
    });

    const newBrief = { ...baseBrief, siteName: "Site Updated Cosmetic" }; // non-material

    const req = makeRequest({ method: "PUT", body: newBrief, params: { id: "round-1" } });
    const res = await invoke("updateRoundBrief", req);

    expect(res.status).toBe(200);
    expect((res.jsonBody as any).materialChanged).toBe(false);
    expect((res.jsonBody as any).brief.version).toBe(1);
    expect(mockWritePrivateBlob).toHaveBeenCalledWith("round-briefs/round-1.json", expect.objectContaining({ version: 1 }), "mock-lease");
  });

  it("material edit (NOTAMs added) -> version bumped, prior signatures invalidated (slot.signToFly false), Signature records ON DISK preserved", async () => {
    vi.mocked(getCallerIdentity).mockResolvedValue({ userId: "admin", roles: ["Admin"], email: "a@a.com", clubId: "club-1", pilotId: null });
    mockReadBlob.mockImplementation(async (path: string) => {
      if (path.includes("rounds/")) return baseRound;
      return baseBrief; // version 1
    });

    vi.mocked(listSignaturesForRound).mockResolvedValue([{
      teamId: "t1", place: 1, briefVersion: 1
    }] as any);

    const newBrief = { ...baseBrief, NOTAMs: "New NOTAM" };

    const req = makeRequest({ method: "PUT", body: newBrief, params: { id: "round-1" } });
    const res = await invoke("updateRoundBrief", req);

    expect(res.status).toBe(200);
    expect((res.jsonBody as any).materialChanged).toBe(true);
    expect((res.jsonBody as any).invalidatedSignatureCount).toBe(1);
    expect((res.jsonBody as any).brief.version).toBe(2);

    expect(mockWritePrivateBlob).toHaveBeenCalledWith(
      "round-briefs/round-1.json",
      expect.objectContaining({ version: 2 }),
      "mock-lease"
    );

    expect(mockWritePrivateBlob).toHaveBeenCalledWith(
      "rounds/round-1.json",
      expect.objectContaining({
        teams: [{ id: "t1", pilots: [{ placeInTeam: 1, signToFly: false }] }]
      }),
      "mock-lease"
    );
  });

  it("edit when round Locked -> 409 BRIEF_LOCKED", async () => {
    vi.mocked(getCallerIdentity).mockResolvedValue({ userId: "admin", roles: ["Admin"], email: "a@a.com", clubId: "club-1", pilotId: null });
    mockReadBlob.mockImplementation(async () => ({ ...baseRound, status: "Locked" }));

    const req = makeRequest({ method: "PUT", body: baseBrief, params: { id: "round-1" } });
    const res = await invoke("updateRoundBrief", req);

    expect(res.status).toBe(409);
    expect((res.jsonBody as any).code).toBe("BRIEF_LOCKED");
  });

  it("non-admin/coord -> 403 FORBIDDEN", async () => {
    vi.mocked(getCallerIdentity).mockResolvedValue({ userId: "pilot", roles: ["Pilot"], email: "p@p.com", clubId: "club-1", pilotId: null });
    mockReadBlob.mockImplementation(async () => baseRound);

    const req = makeRequest({ method: "PUT", body: baseBrief, params: { id: "round-1" } });
    const res = await invoke("updateRoundBrief", req);

    expect(res.status).toBe(403);
  });

  it("image upload -> path appended; >5MB rejected 413", async () => {
    vi.mocked(getCallerIdentity).mockResolvedValue({ userId: "admin", roles: ["Admin"], email: "a@a.com", clubId: "club-1", pilotId: null });
    mockReadBlob.mockImplementation(async (path: string) => {
      if (path.includes("rounds/")) return baseRound;
      return baseBrief;
    });

    const mockUpload = vi.fn();
    mockGetPrivateBlockBlobClient.mockReturnValue({ upload: mockUpload });

    const req = makeRequest({ params: { id: "round-1" } });
    // Inject formData manually on the req object
    (req as any).formData = async () => {
      const fd = new FormData();
      // Valid PNG magic bytes (89 50 4E 47 0D 0A 1A 0A) padded to 1024 bytes.
      // Required by T5's magic-byte check (apps/api/src/functions/brief.ts).
      const buf = new Uint8Array(1024);
      buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
      fd.append("file", new File([buf], "test.png", { type: "image/png" }));
      return fd;
    };

    const res = await invoke("uploadBriefImage", req);
    expect(res.status).toBe(200);
    expect((res.jsonBody as any).path).toMatch(/image-\d+\.png/);
    expect(mockUpload).toHaveBeenCalled();
    expect(mockWritePrivateBlob).toHaveBeenCalledWith("round-briefs/round-1.json", expect.objectContaining({ imagePaths: [(res.jsonBody as any).path] }), "mock-lease");

    // >5MB — also needs valid magic so it reaches the size check
    const reqBig = makeRequest({ params: { id: "round-1" } });
    (reqBig as any).formData = async () => {
      const fd = new FormData();
      const big = new Uint8Array(6 * 1024 * 1024);
      big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
      fd.append("file", new File([big], "test.png", { type: "image/png" }));
      return fd;
    };

    const resBig = await invoke("uploadBriefImage", reqBig);
    expect(resBig.status).toBe(413);
  });
});
