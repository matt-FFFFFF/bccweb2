export function normalizeStatus(raw) {
  const value = raw.trim();

  switch (value.toLowerCase()) {
    case "submitted":
      return "Proposed";
    case "verified":
      return "Confirmed";
    case "brief complete":
    case "briefcomplete":
      return "BriefComplete";
    case "deleted":
      return "Cancelled";
    default:
      if (
        value === "Proposed" ||
        value === "Confirmed" ||
        value === "BriefComplete" ||
        value === "Locked" ||
        value === "Complete" ||
        value === "Cancelled"
      ) {
        return value;
      }
      throw new Error(`Unknown status: ${raw}`);
  }
}
