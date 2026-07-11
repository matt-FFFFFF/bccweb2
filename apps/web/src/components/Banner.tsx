// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
export function Banner({ msg, ok }: { msg: string; ok?: boolean }) {
  return (
    <div
      style={{
        padding: "0.5rem 0.75rem",
        borderRadius: "0.35rem",
        marginTop: "0.5rem",
        fontSize: "0.85rem",
        background: ok ? "#d1e7dd" : "#f8d7da",
        color: ok ? "#0a3622" : "#58151c",
      }}
    >
      {msg}
    </div>
  );
}
