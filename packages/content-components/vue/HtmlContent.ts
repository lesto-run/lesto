import { defineComponent, h, computed, type PropType } from "vue";
import { sanitizeHtml } from "@lesto/content-shared/sanitize";

export interface HtmlContentProps {
  html: string;
  class?: string;
  /** Skip sanitization - DANGEROUS. Only use with trusted content. */
  unsanitized?: boolean;
}

/**
 * Renders pre-rendered HTML content.
 *
 * By default, HTML is sanitized using DOMPurify to prevent XSS attacks.
 * For custom Vue components in content, use MDX instead of markdown.
 */
export const HtmlContent = defineComponent({
  name: "HtmlContent",
  props: {
    html: {
      type: String as PropType<string>,
      required: true,
    },
    class: {
      type: String as PropType<string>,
      default: undefined,
    },
    unsanitized: {
      type: Boolean as PropType<boolean>,
      default: false,
    },
  },
  setup(props) {
    const safeHtml = computed(() => (props.unsanitized ? props.html : sanitizeHtml(props.html)));
    return () => h("div", { class: props.class, innerHTML: safeHtml.value });
  },
});
