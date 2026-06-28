import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke, makeRequest } from "../../__tests__/helpers/api.js";

import "../brief.js";

vi.mock("../../lib/auth.js", () => ({
  getCallerIdentity: vi.fn(),
  unauthorizedResponse: () => ({ status: 401 }),
}));

const mockReadBlob = vi.fn();
const mockUpload = vi.fn();
const mockWritePrivateJson = vi.fn();
const mockGetPrivateBlockBlobClient = vi.fn();

vi.mock("../../lib/blob.js", () => ({
  getPrivateBlobClient: (path: string) => path,
  getPrivateBlockBlobClient: (path: string) => mockGetPrivateBlockBlobClient(path),
  readBlob: (client: any) => mockReadBlob(client),
  writePrivateBlob: vi.fn(),
  withPrivateLeaseRenewing: async (_path: string, fn: any) => fn("mock-lease"),
}));

vi.mock("../../lib/blobJson.js", () => ({
  readJson: (client: string) => mockReadBlob(client),
  writePrivateJson: (path: string, _schema: unknown, data: unknown, leaseId?: string) =>
    mockWritePrivateJson(path, data, leaseId),
}));

import { getCallerIdentity } from "../../lib/auth.js";

describe("uploadBriefImage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCallerIdentity).mockResolvedValue({ userId: "admin", roles: ["Admin"], email: "admin@example.com", clubId: "club-1", pilotId: null });
    mockGetPrivateBlockBlobClient.mockReturnValue({ upload: mockUpload });
  });

  it("rejects PNG-declared file with JPEG bytes", async () => {
    mockReadBlob.mockImplementation(async (path: string) => {
      if (path.includes("rounds/")) return { id: "round-1", organisingClub: { id: "club-1", name: "Club 1" }, status: "Draft" };
      return { imagePaths: [] };
    });

    const req = makeRequest({ params: { id: "round-1" } });
    (req as any).formData = async () => {
      const fd = new FormData();
      fd.append("file", new File([new Uint8Array([0xff, 0xd8, 0xff, 0x00])], "foo.png", { type: "image/png" }));
      return fd;
    };

    const res = await invoke("uploadBriefImage", req);
    expect(res.status).toBe(400);
    expect((res.jsonBody).code).toBe("IMAGE_MAGIC_MISMATCH");
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("rejects 11-image upload", async () => {
    mockReadBlob.mockImplementation(async (path: string) => {
      if (path.includes("rounds/")) return { id: "round-1", organisingClub: { id: "club-1", name: "Club 1" }, status: "Draft" };
      return { imagePaths: Array.from({ length: 10 }, (_, i) => "round-briefs/round-1/image-" + (i + 1) + ".jpg") };
    });

    const req = makeRequest({ params: { id: "round-1" } });
    (req as any).formData = async () => {
      const fd = new FormData();
      fd.append("file", new File([new Uint8Array([0xff, 0xd8, 0xff, 0x00])], "ok.jpg", { type: "image/jpeg" }));
      return fd;
    };

    const res = await invoke("uploadBriefImage", req);
    expect(res.status).toBe(400);
    expect((res.jsonBody).code).toBe("TOO_MANY_IMAGES");
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("accepts valid JPEG upload", async () => {
    mockReadBlob.mockImplementation(async (path: string) => {
      if (path.includes("rounds/")) return { id: "round-1", organisingClub: { id: "club-1", name: "Club 1" }, status: "Draft" };
      return { imagePaths: [] };
    });

    const req = makeRequest({ params: { id: "round-1" } });
    (req as any).formData = async () => {
      const fd = new FormData();
      fd.append("file", new File([new Uint8Array([0xff, 0xd8, 0xff, 0x00])], "foo.jpg", { type: "image/jpeg" }));
      return fd;
    };

    const res = await invoke("uploadBriefImage", req);
    expect(res.status).toBe(200);
    expect((res.jsonBody).path).toMatch(/round-briefs\/round-1\/image-1\.jpg/);
    expect(mockUpload).toHaveBeenCalled();
  });
});
