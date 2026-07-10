// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
export const XSS_CORPUS: readonly string[] = [
  "<script>alert('xss')</script>",
  "<img src=x onerror=alert(1)>",
  "<iframe src=\"javascript:alert(1)\"></iframe>",
  "<a href=\"javascript:alert(1)\">Click me</a>",
  "<div onmouseover=\"alert(1)\">Hover me</div>",
  "<body onload=\"alert(1)\"></body>",
  "<a href=\"data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==\">Data URI</a>",
  "<svg onload=\"alert(1)\"></svg>",
  "![x](x) <img src=x onerror=alert(1)>"
];
