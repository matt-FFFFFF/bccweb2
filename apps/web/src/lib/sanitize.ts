/**
 * Sanitizes user-published HTML for sign-to-fly wording display. Allowed tags must remain a strict subset; widening this config requires PR review with security signoff. Used by SignToFly.tsx (pilot view) AND SignToFlyWording.tsx (admin preview, Task 48).
 */
import DOMPurify from "dompurify";

export function sanitizeWordingHtml(rawHtml: string): string {
  return DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS: ["p", "strong", "em", "ul", "ol", "li", "br", "h2", "h3", "span"],
    ALLOWED_ATTR: []
  });
}
