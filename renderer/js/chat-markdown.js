// Agent replies as markdown: marked parses GitHub-flavored markdown (headings,
// links, tables, block quotes, images, task lists), highlight.js colors code
// blocks, and DOMPurify cleans the result before it reaches the page. Links
// open in the browser through the chat's click handler, never in the window.

import { Marked } from "../vendor/marked.js";
import DOMPurify from "../vendor/purify.js";
import hljs from "../vendor/highlight.js";
import { esc } from "./util.js";

// Longer code blocks are shown plain; highlighting them on every streamed
// chunk costs more than it gives.
const HIGHLIGHT_MAX = 40000;

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }) {
      const name = String(lang || "").trim().split(/\s+/)[0].toLowerCase();
      const known = name && hljs.getLanguage(name);
      let body = esc(text);
      if (known && text.length <= HIGHLIGHT_MAX) {
        try {
          body = hljs.highlight(text, { language: name, ignoreIllegals: true }).value;
        } catch {
          /* plain */
        }
      }
      return "<pre" + (name ? ' data-lang="' + esc(name) + '"' : "") + '><code class="hljs' + (known ? " language-" + esc(name) : "") + '">' + body + "</code></pre>";
    },
  },
});

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("rel", "noopener noreferrer");
    const href = node.getAttribute("href") || "";
    if (href) node.setAttribute("title", href);
  }
  if (node.tagName === "IMG") {
    const src = node.getAttribute("src") || "";
    // Only web and inline images; a bare path would load from inside the app.
    if (!/^(https:|data:image\/)/i.test(src)) {
      node.replaceWith(document.createTextNode(node.getAttribute("alt") || ""));
      return;
    }
    node.setAttribute("loading", "lazy");
    node.setAttribute("referrerpolicy", "no-referrer");
  }
});

const PURIFY = {
  ALLOWED_TAGS: ["a", "b", "blockquote", "br", "code", "del", "details", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "input", "kbd", "li", "ol", "p", "pre", "s", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td", "th", "thead", "tr", "ul"],
  ALLOWED_ATTR: ["href", "title", "alt", "src", "class", "data-lang", "type", "checked", "disabled", "align", "start", "colspan", "rowspan"],
  // DOMPurify checks every attribute value against this, so plain values (a
  // list start, a column span) must pass too. Of the schemes, only these do.
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|data:image\/(?:png|jpeg|gif|webp);|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
};

export function markdown(src) {
  const html = marked.parse(String(src || ""), { async: false });
  return DOMPurify.sanitize(html, PURIFY);
}
