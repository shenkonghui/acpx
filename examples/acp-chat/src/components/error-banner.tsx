export function ErrorBanner({
  errors,
  catalogError,
  onDismiss,
}: {
  errors: string[];
  catalogError?: string;
  onDismiss: () => void;
}) {
  const messages = [...(catalogError ? [catalogError] : []), ...errors];
  if (messages.length === 0) {
    return null;
  }

  return (
    <div className="error-banner" role="alert">
      <ul>
        {messages.map((message, index) => (
          <li key={`${index}-${message}`}>{message}</li>
        ))}
      </ul>
      <button type="button" onClick={onDismiss}>
        关闭
      </button>
    </div>
  );
}
