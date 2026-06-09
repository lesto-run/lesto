"use client";

import { useRef, useState, useEffect, type ComponentProps, type ReactNode, type CSSProperties } from "react";

export interface CodeBlockProps extends ComponentProps<"pre"> {
  children?: ReactNode;
  /** Hide the copy button */
  hideCopyButton?: boolean;
  /** Custom styles for the wrapper div */
  wrapperStyle?: CSSProperties;
  /** Custom class for the wrapper div */
  wrapperClassName?: string;
  /** Custom styles for the copy button */
  buttonStyle?: CSSProperties;
  /** Custom class for the copy button */
  buttonClassName?: string;
  /** Render custom copy button - receives copied/failed states and copy handler */
  renderCopyButton?: (props: { copied: boolean; copyFailed: boolean; onCopy: () => void }) => ReactNode;
}

/**
 * Code block wrapper with copy-to-clipboard functionality.
 *
 * @example Basic usage (automatic via MDXContent)
 * ```tsx
 * <MDXContent code={result.code} />
 * ```
 *
 * @example Custom styling via CSS classes
 * ```tsx
 * <MDXContent
 *   code={result.code}
 *   components={{
 *     pre: (props) => (
 *       <CodeBlock
 *         {...props}
 *         wrapperClassName="my-code-wrapper"
 *         buttonClassName="my-copy-btn"
 *       />
 *     )
 *   }}
 * />
 * ```
 *
 * @example Completely custom pre component
 * ```tsx
 * function MyCodeBlock({ children, ...props }) {
 *   const ref = useRef(null);
 *   const copy = () => navigator.clipboard.writeText(ref.current?.textContent ?? "");
 *   return (
 *     <div className="my-wrapper">
 *       <div className="filename">example.mdx</div>
 *       <pre ref={ref} {...props}>{children}</pre>
 *       <button onClick={copy}>Copy</button>
 *     </div>
 *   );
 * }
 *
 * <MDXContent code={result.code} components={{ pre: MyCodeBlock }} />
 * ```
 */
const COPY_FEEDBACK_TIMEOUT_MS = 2000;

export function CodeBlock({
  children,
  className,
  style,
  hideCopyButton,
  wrapperStyle,
  wrapperClassName,
  buttonStyle,
  buttonClassName,
  renderCopyButton,
  ...props
}: CodeBlockProps) {
  const preRef = useRef<HTMLPreElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  // Cleanup timeout on unmount to prevent memory leak
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const handleCopy = () => {
    const codeEl = preRef.current?.querySelector("code");
    const code = codeEl?.textContent ?? preRef.current?.textContent ?? "";

    // Clear any existing timeout to handle rapid clicks
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(true);
        setCopyFailed(false);
        timeoutRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_TIMEOUT_MS);
        return undefined;
      })
      .catch(() => {
        setCopyFailed(true);
        setCopied(false);
        timeoutRef.current = setTimeout(() => setCopyFailed(false), COPY_FEEDBACK_TIMEOUT_MS);
      });
  };

  const defaultWrapperStyle: CSSProperties = {
    position: "relative",
    ...wrapperStyle,
  };

  const getButtonColor = () => {
    if (copied) return "#22c55e"; // green for success
    if (copyFailed) return "#ef4444"; // red for failure
    return "rgba(255, 255, 255, 0.7)";
  };

  const defaultButtonStyle: CSSProperties = {
    position: "absolute",
    top: "0.5rem",
    right: "0.5rem",
    padding: "0.375rem",
    background: "rgba(255, 255, 255, 0.1)",
    border: "1px solid rgba(255, 255, 255, 0.2)",
    borderRadius: "0.375rem",
    color: getButtonColor(),
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "all 0.2s",
    ...buttonStyle,
  };

  return (
    <div style={defaultWrapperStyle} className={wrapperClassName}>
      <pre ref={preRef} className={className} style={style} {...props}>
        {children}
      </pre>
      {!hideCopyButton && (
        renderCopyButton ? (
          renderCopyButton({ copied, copyFailed, onCopy: handleCopy })
        ) : (
          <button
            type="button"
            onClick={handleCopy}
            aria-label={copied ? "Copied!" : copyFailed ? "Copy failed" : "Copy code"}
            style={buttonClassName ? buttonStyle : defaultButtonStyle}
            className={buttonClassName}
          >
            {copied ? <CheckIcon /> : copyFailed ? <XIcon /> : <CopyIcon />}
          </button>
        )
      )}
    </div>
  );
}

function CopyIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

// Export icons for custom button implementations
export { CopyIcon, CheckIcon, XIcon };
