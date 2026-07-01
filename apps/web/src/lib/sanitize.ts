import createDOMPurify from "dompurify";

const purifyWindow = typeof globalThis.window !== "undefined" ? globalThis.window : undefined;
const DOMPurify = purifyWindow
  ? createDOMPurify(purifyWindow as unknown as never)
  : createDOMPurify();

const BASIC_ALLOWED_TAGS = ["p", "strong", "em", "ul", "ol", "li", "br", "h2", "h3", "span"] as const;
const BASIC_ALLOWED_ATTRS: string[] = [];

export function sanitizeWordingHtml(value: string): string {
  return DOMPurify.sanitize(value, {
    ALLOWED_TAGS: [...BASIC_ALLOWED_TAGS],
    ALLOWED_ATTR: BASIC_ALLOWED_ATTRS,
  });
}

export function sanitizeRoundNarrativeHtml(value: string): string {
  return sanitizeWordingHtml(value);
}
