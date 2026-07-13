// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
function formatRoundDate(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00Z");
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][d.getUTCMonth()];
  const yy = String(d.getUTCFullYear()).slice(-2);
  return `${weekday} ${dd} ${month} ${yy}`;
}

export function roundGroupName(siteName: string, date: string): string {
  return `BCC ${siteName} ${formatRoundDate(date)}`;
}

export function teamGroupName(date: string, teamName: string): string {
  return `BCC ${formatRoundDate(date)} ${teamName}`;
}
