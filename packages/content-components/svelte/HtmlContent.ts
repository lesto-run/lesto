export interface HtmlContentProps {
  html: string;
  class?: string;
}

export function createHtmlContentProps(html: string, className?: string): HtmlContentProps {
  return { html, ...(className === undefined ? {} : { class: className }) };
}
