import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";

interface MarkdownViewProps {
  markdown: string;
}

export function MarkdownView({ markdown }: MarkdownViewProps) {
  return (
    <ReactMarkdown rehypePlugins={[rehypeSanitize]}>
      {markdown}
    </ReactMarkdown>
  );
}
