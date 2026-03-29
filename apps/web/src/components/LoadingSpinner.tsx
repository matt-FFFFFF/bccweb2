interface LoadingSpinnerProps {
  message?: string;
}

export function LoadingSpinner({ message = "Loading…" }: LoadingSpinnerProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        padding: "2rem",
        color: "#6c757d",
      }}
    >
      <span
        style={{
          display: "inline-block",
          width: "1rem",
          height: "1rem",
          border: "2px solid #dee2e6",
          borderTopColor: "#0066cc",
          borderRadius: "50%",
          animation: "spin 0.7s linear infinite",
        }}
      />
      {message}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

interface ErrorMessageProps {
  error: Error;
  title?: string;
}

export function ErrorMessage({ error, title = "Error" }: ErrorMessageProps) {
  return (
    <div
      style={{
        padding: "1rem",
        backgroundColor: "#f8d7da",
        color: "#58151c",
        borderRadius: "0.375rem",
        border: "1px solid #f1aeb5",
      }}
    >
      <strong>{title}:</strong> {error.message}
    </div>
  );
}
