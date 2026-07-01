import React, { Suspense } from "react";
import rehypeSanitize from "rehype-sanitize";
import type { MDEditorProps } from "@uiw/react-md-editor";

// Lazy load the editor
const MDEditor = React.lazy(() => import("@uiw/react-md-editor"));

export type MarkdownEditorProps = Omit<MDEditorProps, "value" | "onChange"> & {
  value: string;
  onChange: (value?: string) => void;
};

export function MarkdownEditor({ value, onChange, ...props }: MarkdownEditorProps) {
  return (
    <Suspense fallback={
      <div className="markdown-editor-fallback">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Loading editor..."
        />
        <span>Loading...</span>
      </div>
    }>
      <MDEditor
        value={value}
        onChange={onChange}
        previewOptions={{
          rehypePlugins: [[rehypeSanitize]]
        }}
        {...props}
      />
    </Suspense>
  );
}
