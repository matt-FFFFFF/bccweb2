import React, { Suspense } from "react";
import rehypeSanitize from "rehype-sanitize";

// Lazy load the editor
const MDEditor = React.lazy(() => import("@uiw/react-md-editor"));

interface MarkdownEditorProps {
  value: string;
  onChange: (value?: string) => void;
  [key: string]: any;
}

export function MarkdownEditor({ value, onChange, ...props }: MarkdownEditorProps) {
  return (
    <Suspense fallback={
      <div className="markdown-editor-fallback">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Loading editor..."
          {...props}
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
