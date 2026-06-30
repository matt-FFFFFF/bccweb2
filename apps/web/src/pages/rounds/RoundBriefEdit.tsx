import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router";
import type { RoundBrief } from "@bccweb/types";
import { useAuth } from "../../hooks/useAuth.js";
import { api, ApiError } from "../../lib/api.js";
import { LoadingSpinner } from "../../components/LoadingSpinner.js";

interface PutResponse {
  brief: RoundBrief;
  materialChanged: boolean;
  invalidatedSignatureCount: number;
}

export default function RoundBriefEdit() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { identity } = useAuth();
  const token = localStorage.getItem("bcc_access_token");
  const [brief, setBrief] = useState<RoundBrief | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmModal, setConfirmModal] = useState<PutResponse | null>(null);

  useEffect(() => {
    if (!id) return;
    api.get<RoundBrief>(`rounds/${id}/brief`)
      .then((data) => {
        if (!data.briefer) {
          data.briefer = { name: "", bhpaCoachLevel: "", bhpaNumber: "", phoneNumber: "", emailAddress: "" };
        }
        setBrief(data);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) {
          setError("Brief not found. Ensure the round is locked and brief is generated.");
        } else if (err instanceof ApiError && err.status === 403) {
          setError("Forbidden.");
        } else {
          setError(err instanceof Error ? err.message : "Error loading brief");
        }
      })
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <LoadingSpinner />;
  if (error || !brief) {
    if (error === "Forbidden.") return <div className="p-4 text-red-700">Forbidden.</div>;
    return <div className="p-4 text-red-700">{error || "Failed to load brief"}</div>;
  }

  // Pre-flight validation (could also just rely on backend 403)
  const isAdmin = identity?.roles?.includes("Admin");
  const isCoord = identity?.roles?.includes("RoundsCoord");
  if (!isAdmin && !isCoord) { // The backend checks scoped clubId
    return <div className="p-4 text-red-700">Forbidden.</div>;
  }

  const handleChange = <K extends keyof RoundBrief>(field: K, value: RoundBrief[K]) => {
    setBrief((prev) => prev ? { ...prev, [field]: value } : null);
  };

  const handleBrieferChange = (field: keyof NonNullable<RoundBrief["briefer"]>, value: string) => {
    setBrief((prev) => {
      if (!prev) return null;
      return { ...prev, briefer: { ...(prev.briefer || {}), [field]: value } };
    });
  };

  const handleSave = async (dryRun: boolean) => {
    setSaving(true);
    setError(null);
    try {
      const res = await api.put<PutResponse>(`rounds/${id}/brief?dryRun=${dryRun}`, brief);
      if (dryRun) {
        if (res.materialChanged) {
          setConfirmModal(res);
        } else {
          // If purely cosmetic, save directly
          await handleSave(false);
        }
      } else {
        navigate(`/rounds/${id}/brief`);
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === "BRIEF_LOCKED") {
        setError("Round is locked; unlock first to edit the brief.");
      } else {
        setError(err instanceof Error ? err.message : "Failed to save");
      }
    } finally {
      setSaving(false);
    }
  };

  const uploadImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setError("Image > 5MB");
      return;
    }

    const fd = new FormData();
    fd.append("file", file);

    try {
      const res = await fetch(`/api/rounds/${id}/brief/images`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Upload failed");
      }
      const data = await res.json();
      setBrief((prev) => prev ? { ...prev, imagePaths: [...(prev.imagePaths || []), data.path] } : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    }
  };

  const removeImage = async (index: number) => {
    try {
      await api.delete(`rounds/${id}/brief/images/${index + 1}`);
      setBrief((prev) => {
        if (!prev) return null;
        const newPaths = [...(prev.imagePaths || [])];
        newPaths.splice(index, 1);
        return { ...prev, imagePaths: newPaths };
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete image");
    }
  };

  return (
    <div className="max-w-4xl mx-auto p-4">
      <h1 className="text-2xl font-bold mb-6">Edit Round Brief</h1>
      {error && <div className="mb-4 p-3 bg-red-100 text-red-800 rounded">{error}</div>}

      <div className="space-y-6">
        <section className="bg-white shadow p-4 rounded">
          <h2 className="text-xl font-semibold mb-4">Core Info (Material)</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Briefing Time</label>
              <input type="text" className="w-full border rounded p-2" value={brief.briefingTime || ""} onChange={e => handleChange("briefingTime", e.target.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Land By Time</label>
              <input type="text" className="w-full border rounded p-2" value={brief.landByTime || ""} onChange={e => handleChange("landByTime", e.target.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Check-in By Time</label>
              <input type="text" className="w-full border rounded p-2" value={brief.checkInByTime || ""} onChange={e => handleChange("checkInByTime", e.target.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Takeoff W3W</label>
              <input type="text" className="w-full border rounded p-2" value={brief.takeOffW3W || ""} onChange={e => handleChange("takeOffW3W", e.target.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Briefing W3W</label>
              <input type="text" className="w-full border rounded p-2" value={brief.briefingW3W || ""} onChange={e => handleChange("briefingW3W", e.target.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Parking W3W</label>
              <input type="text" className="w-full border rounded p-2" value={brief.parkingW3W || ""} onChange={e => handleChange("parkingW3W", e.target.value)} />
            </div>
          </div>
        </section>

        <section className="bg-white shadow p-4 rounded">
          <h2 className="text-xl font-semibold mb-4">Brief Details</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Wind Speed/Direction</label>
              <input type="text" className="w-full border rounded p-2" value={brief.windSpeedDirection || ""} onChange={e => handleChange("windSpeedDirection", e.target.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Direction of Flight</label>
              <input type="text" className="w-full border rounded p-2" value={brief.directionOfFlight || ""} onChange={e => handleChange("directionOfFlight", e.target.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Frequency (MHz)</label>
              <input
                type="number"
                step="0.025"
                min="0"
                max="999.999"
                className="w-full border rounded p-2"
                value={brief.frequencyMhz ?? ""}
                onChange={e => {
                  const raw = e.target.value;
                  if (raw === "") {
                    handleChange("frequencyMhz", undefined);
                  } else {
                    const parsed = Number(raw);
                    handleChange("frequencyMhz", Number.isFinite(parsed) ? parsed : undefined);
                  }
                }}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Expected Landing Area</label>
              <textarea className="w-full border rounded p-2" value={brief.expectedLandingArea || ""} onChange={e => handleChange("expectedLandingArea", e.target.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Airspace & Hazards</label>
              <textarea className="w-full border rounded p-2" value={brief.airspaceAndHazards || ""} onChange={e => handleChange("airspaceAndHazards", e.target.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">NOTAMs (Material)</label>
              <textarea className="w-full border rounded p-2" value={brief.NOTAMs || ""} onChange={e => handleChange("NOTAMs", e.target.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">BENO Line Description (Material)</label>
              <textarea className="w-full border rounded p-2" value={brief.BENO_LineDescription || ""} onChange={e => handleChange("BENO_LineDescription", e.target.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Briefer's Notes</label>
              <textarea className="w-full border rounded p-2" value={brief.briefersNotes || ""} onChange={e => handleChange("briefersNotes", e.target.value)} />
            </div>
          </div>
        </section>

        <section className="bg-white shadow p-4 rounded">
          <h2 className="text-xl font-semibold mb-4">Briefer</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Name</label>
              <input type="text" className="w-full border rounded p-2" value={brief.briefer?.name || ""} onChange={e => handleBrieferChange("name", e.target.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">BHPA Level</label>
              <input type="text" className="w-full border rounded p-2" value={brief.briefer?.bhpaCoachLevel || ""} onChange={e => handleBrieferChange("bhpaCoachLevel", e.target.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">BHPA Number</label>
              <input type="text" className="w-full border rounded p-2" value={brief.briefer?.bhpaNumber || ""} onChange={e => handleBrieferChange("bhpaNumber", e.target.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Phone</label>
              <input type="text" className="w-full border rounded p-2" value={brief.briefer?.phoneNumber || ""} onChange={e => handleBrieferChange("phoneNumber", e.target.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Email</label>
              <input type="text" className="w-full border rounded p-2" value={brief.briefer?.emailAddress || ""} onChange={e => handleBrieferChange("emailAddress", e.target.value)} />
            </div>
          </div>
        </section>

        <section className="bg-white shadow p-4 rounded">
          <h2 className="text-xl font-semibold mb-4">Images</h2>
          <div className="flex flex-wrap gap-4 mb-4">
            {brief.imagePaths?.map((path, i) => (
              <div key={i} className="relative border rounded p-1">
                <img src={`/api/rounds/${id}/brief/images/${i + 1}`} alt={`Brief image ${i + 1}`} className="h-32 w-auto object-contain" />
                <button
                  onClick={() => removeImage(i)}
                  className="absolute top-0 right-0 bg-red-600 text-white rounded-full w-6 h-6 flex items-center justify-center -mt-2 -mr-2"
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
          <input type="file" accept="image/png,image/jpeg" onChange={uploadImage} />
        </section>

        <div className="flex justify-end space-x-4">
          <button
            onClick={() => navigate(`/rounds/${id}/brief`)}
            className="px-4 py-2 border rounded text-gray-700"
            disabled={saving}
          >
            Cancel
          </button>
          <button
            onClick={() => handleSave(true)}
            className="px-4 py-2 bg-blue-600 text-white rounded font-medium"
            disabled={saving}
          >
            {saving ? "Saving..." : "Save Brief"}
          </button>
        </div>
      </div>

      {confirmModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4">
          <div className="bg-white rounded p-6 max-w-md w-full">
            <h3 className="text-xl font-bold mb-4">Material Change Detected</h3>
            <p className="mb-4">
              Your edits modified material fields of the brief. This will invalidate{" "}
              <strong>{confirmModal.invalidatedSignatureCount}</strong> pilot signature(s) (their 'Sign To Fly' flags will be reset).
            </p>
            <p className="mb-6">Do you want to proceed?</p>
            <div className="flex justify-end space-x-4">
              <button
                onClick={() => setConfirmModal(null)}
                className="px-4 py-2 border rounded"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setConfirmModal(null);
                  handleSave(false);
                }}
                className="px-4 py-2 bg-red-600 text-white rounded font-medium"
              >
                Confirm & Invalidate
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
