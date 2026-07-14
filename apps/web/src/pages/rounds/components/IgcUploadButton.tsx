// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0

import { useState, useRef } from "react";
import type { Flight } from "@bccweb/types";

interface IgcUploadButtonProps {
  roundId: string;
  teamId: string;
  place: number;
  currentFlight: Flight | null;
  onUploaded: (flight: Flight) => void;
}

export function IgcUploadButton({
  roundId,
  teamId,
  place,
  currentFlight,
  onUploaded,
}: IgcUploadButtonProps) {
  const [uploading, setUploading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successFlight, setSuccessFlight] = useState<Flight | null>(null);
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset states
    setErrorMsg(null);
    setSuccessFlight(null);
    setUploading(true);

    const fd = new FormData();
    fd.append("file", file);
    const accessToken = localStorage.getItem("bcc_access_token");

    try {
      const res = await fetch(`/api/rounds/${roundId}/teams/${teamId}/pilots/${place}/igc`, {
        method: "POST",
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
        body: fd,
      });

      if (!res.ok) {
        if (res.status === 413) {
          throw new Error("File too large (max 15MB)");
        } else if (res.status === 415) {
          throw new Error("Not an IGC file");
        } else if (res.status === 409) {
          throw new Error("Round not yet locked");
        } else if (res.status === 400) {
          throw new Error("Could not parse IGC");
        } else {
          const errData = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(errData.error || "Upload failed");
        }
      }

      const flight: Flight = await res.json();
      setSuccessFlight(flight);
      onUploaded(flight);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "0.4rem" }}>
      <input
        type="file"
        accept=".igc,text/plain"
        ref={fileInputRef}
        onChange={handleFileChange}
        style={{ display: "none" }}
        data-testid="upload-igc-input"
      />
      
      <div>
        <button
          type="button"
          className="bcc-btn bcc-btn--outline"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          data-testid="upload-igc-btn"
          style={{ padding: "0.25rem 0.5rem", fontSize: "0.75rem", display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
        >
          {uploading ? (
            <>
              <span
                data-testid="upload-spinner"
                style={{
                  display: "inline-block",
                  width: "0.8rem",
                  height: "0.8rem",
                  border: "2px solid #e05555",
                  borderTopColor: "transparent",
                  borderRadius: "50%",
                  animation: "spin 0.7s linear infinite",
                }}
              />
              Uploading & scoring...
            </>
          ) : (
            currentFlight?.igcPath ? "Replace IGC" : "Upload IGC"
          )}
        </button>
      </div>

      {errorMsg && (
        <div
          style={{
            padding: "0.5rem",
            backgroundColor: "#f8d7da",
            color: "#58151c",
            borderRadius: "0.375rem",
            border: "1px solid #f1aeb5",
            fontSize: "0.85rem",
          }}
        >
          {errorMsg}
        </div>
      )}

      {successFlight && (
        <div
          style={{
            padding: "0.5rem",
            backgroundColor: "#d1e7dd",
            color: "#0a3622",
            borderRadius: "0.375rem",
            border: "1px solid #badbcc",
            fontSize: "0.85rem",
          }}
        >
          <div data-testid="flight-distance">Scored distance: {successFlight.distance} km</div>
          {(successFlight.sanityFlags && successFlight.sanityFlags.length > 0) && (
            <div style={{ marginTop: "0.25rem", color: "#664d03" }}>
              <strong>Flags:</strong> {successFlight.sanityFlags.join(", ")}
            </div>
          )}
          {successFlight.validation && (
            <div style={{ marginTop: "0.4rem", paddingTop: "0.4rem", borderTop: "1px solid #badbcc" }} data-testid="flight-validation">
              {successFlight.validation.date && (
                <div style={{ color: successFlight.validation.date === "invalid" ? "#842029" : "inherit" }}>
                  Date: {successFlight.validation.date}
                </div>
              )}
              {successFlight.validation.signature && (
                <div>
                  Signature: {successFlight.validation.signature === "pending" ? (
                    <span style={{ color: "#055160" }}>checking… (coordinator will see final result)</span>
                  ) : (
                    <span style={{ color: successFlight.validation.signature === "invalid" ? "#842029" : "inherit" }}>
                      {successFlight.validation.signature}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
