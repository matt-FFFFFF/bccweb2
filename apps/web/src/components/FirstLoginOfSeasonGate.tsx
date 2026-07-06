import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import * as z from "zod/v4";
import { ClubSummarySchema } from "@bccweb/schemas";
import { useAuth } from "../hooks/useAuth.js";
import { api, ApiError } from "../lib/api.js";
import { useBlob } from "../hooks/useBlob.js";
import type { Pilot, WingClass, SeasonResults } from "@bccweb/types";

interface ClubSummary {
  id: string;
  name: string;
}

export default function FirstLoginOfSeasonGate({ children }: { children: React.ReactNode }) {
  const { identity, loading } = useAuth();
  const location = useLocation();
  const [pilot, setPilot] = useState<Pilot | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [localDismiss, setLocalDismiss] = useState(false);
  
  const { data: clubs } = useBlob<ClubSummary[]>("clubs.json", z.array(ClubSummarySchema));

  // Determine if modal should be shown
  const firstLoginOfSeason = identity?.firstLoginOfSeason ?? false;
  const activeYear = identity?.activeSeasonYear;
  
  const { data: seasonResults } = useBlob<SeasonResults>(activeYear ? `results/${activeYear}.json` : null);
  const flown = !!seasonResults?.some((rr) => rr.teamResults.some((tr) => tr.pilots.some((p) => p.pilotId === identity?.pilotId)));
  const isAdmin = identity?.roles.includes("Admin") ?? false;
  const clubLocked = !isAdmin && flown;

  const dismissedUntilStr = localStorage.getItem("bcc_first_login_dismissed_until");
  const isDismissed = dismissedUntilStr && Date.now() < Number(dismissedUntilStr);
  const acknowledged = localStorage.getItem("bcc_first_login_acknowledged_at");
  
  const showModal = firstLoginOfSeason && !isDismissed && !acknowledged && !localDismiss && !loading && identity?.pilotId;

  // Block navigation via simple CSS overlay to swallow clicks
  // Whitelisted paths
  const isSafePath = location.pathname === "/profile" || location.pathname === "/logout" || location.pathname === "/terms" || location.pathname.startsWith("/pilots/") || location.pathname === "/login";
  const intercepting = showModal && !isSafePath;

  const [formData, setFormData] = useState({
    phoneNumber: "",
    emergencyContactName: "",
    emergencyPhoneNumber: "",
    medicalInfo: "",
    helmetColour: "",
    harnessType: "",
    harnessColour: "",
    wingClass: "Other" as WingClass | "Other",
    wingModel: "",
    wingColours: "",
    currentClubId: "",
  });

  useEffect(() => {
    if (showModal && identity?.pilotId && !pilot) {
      api.get<Pilot>(`pilots/${identity.pilotId}`)
        .then(p => {
          setPilot(p);
          setFormData({
            phoneNumber: p.person.phoneNumber ?? "",
            emergencyContactName: p.emergencyContactName ?? "",
            emergencyPhoneNumber: p.emergencyPhoneNumber ?? "",
            medicalInfo: p.medicalInfo ?? "",
            helmetColour: p.helmetColour ?? "",
            harnessType: p.harnessType ?? "",
            harnessColour: p.harnessColour ?? "",
            wingClass: p.wingClass ?? "Other",
            wingModel: p.wingModel ?? "",
            wingColours: p.wingColours ?? "",
            currentClubId: p.currentClub?.id ?? "",
          });
        })
        .catch(() => {});
    }
  }, [showModal, identity?.pilotId, pilot]);

  const handleSkip = () => {
    localStorage.setItem("bcc_first_login_dismissed_until", String(Date.now() + 86400000));
    setLocalDismiss(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!identity?.pilotId) return;
    
    setIsSubmitting(true);
    setError("");
    
    try {
      const selectedClub = clubs?.find(c => c.id === formData.currentClubId);
      
      await api.put(`pilots/${identity.pilotId}`, {
        phoneNumber: formData.phoneNumber,
        emergencyContactName: formData.emergencyContactName,
        emergencyPhoneNumber: formData.emergencyPhoneNumber,
        medicalInfo: formData.medicalInfo,
        helmetColour: formData.helmetColour,
        harnessType: formData.harnessType,
        harnessColour: formData.harnessColour,
        wingClass: formData.wingClass,
        wingModel: formData.wingModel,
        wingColours: formData.wingColours,
        currentClub: selectedClub ? { id: selectedClub.id, name: selectedClub.name } : undefined
      });
      
      localStorage.setItem("bcc_first_login_acknowledged_at", String(Date.now()));
      setLocalDismiss(true);
      
      // Optionally trigger re-fetch of /me to update identity, but local state + acknowledged key is enough to hide
    } catch (err: unknown) {
      if (err instanceof ApiError && err.code === "CLUB_LOCKED") {
        setError("You cannot change your club because you have already flown for another club this season. Please contact an admin.");
      } else {
        setError(err instanceof Error ? err.message : "Failed to update profile");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  if (loading) return <>{children}</>;

  return (
    <>
      <div style={{ pointerEvents: intercepting ? "none" : "auto" }}>
        {children}
      </div>

      {intercepting && (
        <div className="modal-backdrop" style={backdropStyle}>
          <div className="modal-content" style={modalStyle} role="dialog" aria-modal="true">
            <h2>Welcome back to the {activeYear} season!</h2>
            <p style={{ marginBottom: "1rem" }}>
              Please confirm your details are up to date before continuing. 
              This ensures your safety information is accurate for the new season.
            </p>

            {error && <div style={{ color: "red", marginBottom: "1rem" }}>{error}</div>}

            <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "1rem", pointerEvents: "auto", maxHeight: "60vh", overflowY: "auto", padding: "0.5rem" }}>
              
              <div>
                <label style={labelStyle}>Phone Number</label>
                <input style={inputStyle} type="text" value={formData.phoneNumber} onChange={e => setFormData({ ...formData, phoneNumber: e.target.value })} />
              </div>

              <div>
                <label style={labelStyle}>Emergency Contact Name *</label>
                <input style={inputStyle} type="text" required value={formData.emergencyContactName} onChange={e => setFormData({ ...formData, emergencyContactName: e.target.value })} />
              </div>

              <div>
                <label style={labelStyle}>Emergency Phone *</label>
                <input style={inputStyle} type="text" required value={formData.emergencyPhoneNumber} onChange={e => setFormData({ ...formData, emergencyPhoneNumber: e.target.value })} />
              </div>

              <div>
                <label style={labelStyle}>Medical Info</label>
                <textarea style={inputStyle} rows={3} value={formData.medicalInfo} onChange={e => setFormData({ ...formData, medicalInfo: e.target.value })} />
              </div>

              <div>
                <label style={labelStyle}>Helmet Colour</label>
                <input style={inputStyle} type="text" value={formData.helmetColour} onChange={e => setFormData({ ...formData, helmetColour: e.target.value })} />
              </div>

              <div>
                <label style={labelStyle}>Harness Type</label>
                <input style={inputStyle} type="text" value={formData.harnessType} onChange={e => setFormData({ ...formData, harnessType: e.target.value })} />
              </div>

              <div>
                <label style={labelStyle}>Harness Colour</label>
                <input style={inputStyle} type="text" value={formData.harnessColour} onChange={e => setFormData({ ...formData, harnessColour: e.target.value })} />
              </div>

              <div>
                <label style={labelStyle}>Wing Class</label>
                <select style={inputStyle} value={formData.wingClass} onChange={e => setFormData({ ...formData, wingClass: e.target.value as WingClass })}>
                  <option value="EN-A">EN-A</option>
                  <option value="EN-B">EN-B</option>
                  <option value="EN-C">EN-C</option>
                  <option value="EN-D">EN-D</option>
                  <option value="CCC">CCC</option>
                  <option value="Other">Other</option>
                </select>
              </div>

              <div>
                <label style={labelStyle}>Wing Model</label>
                <input style={inputStyle} type="text" value={formData.wingModel} onChange={e => setFormData({ ...formData, wingModel: e.target.value })} />
              </div>

              <div>
                <label style={labelStyle}>Wing Colours</label>
                <input style={inputStyle} type="text" value={formData.wingColours} onChange={e => setFormData({ ...formData, wingColours: e.target.value })} />
              </div>

              <div>
                <label style={labelStyle} htmlFor="currentClub">Current Club</label>
                <select id="currentClub" style={inputStyle} value={formData.currentClubId} onChange={e => setFormData({ ...formData, currentClubId: e.target.value })} disabled={clubLocked}>
                  <option value="">-- None --</option>
                  {clubs?.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                {clubLocked && <p style={{ fontSize: "0.8rem", color: "#666", marginTop: "0.25rem" }}>(locked — you've flown; contact an admin)</p>}
              </div>

              <div style={{ display: "flex", gap: "1rem", marginTop: "1rem" }}>
                <button type="button" onClick={handleSkip} disabled={isSubmitting} style={{ padding: "0.5rem 1rem", border: "1px solid #ccc", background: "white", borderRadius: "0.25rem", cursor: "pointer" }}>
                  Skip for now
                </button>
                <button type="submit" disabled={isSubmitting} style={{ padding: "0.5rem 1rem", background: "#0056b3", color: "white", border: "none", borderRadius: "0.25rem", cursor: "pointer", flex: 1 }}>
                  {isSubmitting ? "Saving..." : "Confirm & Save"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

const backdropStyle: React.CSSProperties = {
  position: "fixed",
  top: 0, left: 0, right: 0, bottom: 0,
  backgroundColor: "rgba(0,0,0,0.5)",
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
  zIndex: 9999,
  pointerEvents: "auto", // the backdrop itself receives events
};

const modalStyle: React.CSSProperties = {
  background: "white",
  padding: "2rem",
  borderRadius: "0.5rem",
  maxWidth: "500px",
  width: "90%",
  boxShadow: "0 4px 6px rgba(0,0,0,0.1)",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  marginBottom: "0.25rem",
  fontWeight: "bold",
  fontSize: "0.875rem",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.5rem",
  border: "1px solid #ccc",
  borderRadius: "0.25rem",
  boxSizing: "border-box",
};
