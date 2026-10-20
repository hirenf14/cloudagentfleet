import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

/**
 * Builds the GitHub Pages site into site-dist/: the landing page from site/,
 * and the docs pages rendered from docs/*.md so the docs live in one place.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "site-dist");
const REPO = "https://github.com/hirenf14/cloudagentfleet";

/** Published docs, in sidebar order. Other docs stay on GitHub. */
const DOCS = [
  { file: "GETTING-STARTED.md", slug: "getting-started", title: "Getting started" },
  { file: "CLI-ENROLLMENT.md", slug: "cli", title: "CLI and enrollment" },
  { file: "TAILSCALE-SERVE.md", slug: "tailscale", title: "Tailscale Serve" },
  { file: "THREAT-MODEL.md", slug: "security", title: "Security" },
  { file: "BACKEND-ABSTRACTION.md", slug: "backends", title: "How backends work" },
  { file: "CODEMAN-WORKER.md", slug: "codeman-worker", title: "Codeman Worker" },
  { file: "ROADMAP.md", slug: "roadmap", title: "Roadmap" },
  { file: "ACKNOWLEDGEMENTS.md", slug: "credits", title: "Credits" },
];
const pageFor = new Map(DOCS.map((doc) => [doc.file, `${doc.slug}.html`]));

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function slugify(text) {
  return text.toLowerCase().replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Links between published docs stay on the site; anything else points at GitHub. */
function rewriteLink(href) {
  if (/^(https?:|mailto:|#)/.test(href)) return href;
  const [path, hash] = href.split("#");
  const name = path.split("/").at(-1);
  if (pageFor.has(name)) return `${pageFor.get(name)}${hash ? `#${hash}` : ""}`;
  const fromDocs = path.startsWith("../") ? path.slice(3) : `docs/${path}`;
  return `${REPO}/blob/master/${fromDocs}${hash ? `#${hash}` : ""}`;
}

/** Renders one doc: heading anchors, rewritten links, and the h2/h3 outline. */
function renderDoc(markdown) {
  const toc = [];
  const used = new Set();
  let html = marked.parse(markdown, { gfm: true });
  html = html.replace(/<h([1-4])>([\s\S]*?)<\/h\1>/g, (_, depth, inner) => {
    let id = slugify(inner) || "section";
    while (used.has(id)) id = `${id}-x`;
    used.add(id);
    const level = Number(depth);
    if (level === 2 || level === 3) toc.push({ id, level, text: inner.replace(/<[^>]+>/g, "") });
    const anchor = level === 2 || level === 3 ? `<a class="anchor" href="#${id}" aria-label="Link to this section">#</a>` : "";
    return `<h${depth} id="${id}">${inner}${anchor}</h${depth}>`;
  });
  html = html.replace(/href="([^"]+)"/g, (_, href) => `href="${escapeHtml(rewriteLink(href.replaceAll("&amp;", "&")))}"`);
  const title = markdown.match(/^#\s+(.+)$/m)?.[1] ?? "";
  return { html, toc, title };
}

function layout({ title, description, body, current }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Cloud Agent Fleet</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="theme-color" content="#000000">
  <link rel="icon" href="../favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="../styles.css">
</head>
<body>
  <header class="site-header">
    <div class="wrap">
      <a class="brand" href="../"><span class="brand__mark" aria-hidden="true">✦</span>Cloud Agent Fleet</a>
      <nav class="site-nav" aria-label="Site">
        <a href="getting-started.html"${current ? ' aria-current="page"' : ""}>Docs</a>
        <a class="optional" href="../#install">Install</a>
        <a href="${REPO}">GitHub</a>
      </nav>
    </div>
  </header>
  <main class="wrap">${body}</main>
  <footer class="site-footer">
    <div class="wrap">
      <span>Cloud Agent Fleet · independent, not affiliated with Codeman or Open WebUI</span>
      <span><a href="../">Home</a> · <a href="credits.html">Credits</a> · <a href="${REPO}">GitHub</a> · <a href="https://www.npmjs.com/package/@cloudagentfleet/hub">npm</a></span>
    </div>
  </footer>
</body>
</html>
`;
}

await rm(out, { recursive: true, force: true });
await mkdir(join(out, "docs"), { recursive: true });
await cp(join(root, "site"), out, { recursive: true });
// GitHub Pages must serve files as-is (no Jekyll processing).
await writeFile(join(out, ".nojekyll"), "");

for (const [index, doc] of DOCS.entries()) {
  const markdown = await readFile(join(root, "docs", doc.file), "utf8");
  const { html, toc, title } = renderDoc(markdown.replaceAll("\r\n", "\n"));
  const nav = DOCS.map((item) => `<a href="${item.slug}.html"${item.slug === doc.slug ? ' aria-current="page"' : ""}>${escapeHtml(item.title)}</a>`).join("");
  const outline = toc.length > 1
    ? `<aside class="docs__toc" aria-label="On this page"><h4>On this page</h4>${toc.map((entry) => `<a class="depth-${entry.level}" href="#${entry.id}">${escapeHtml(entry.text)}</a>`).join("")}</aside>`
    : "<aside class=\"docs__toc\"></aside>";
  const previous = DOCS[index - 1];
  const next = DOCS[index + 1];
  const pager = `<nav class="docs__pager" aria-label="Pages">${previous ? `<a href="${previous.slug}.html"><small>Previous</small>${escapeHtml(previous.title)}</a>` : "<span></span>"}${next ? `<a href="${next.slug}.html"><small>Next</small>${escapeHtml(next.title)}</a>` : ""}</nav>`;
  const body = `<div class="docs">
    <nav class="docs__nav" aria-label="Docs"><h4>Docs</h4>${nav}</nav>
    <article class="prose">${html}${pager}<p class="docs__edit"><a href="${REPO}/edit/master/docs/${doc.file}">Edit this page on GitHub</a></p></article>
    ${outline}
  </div>`;
  const description = markdown.split("\n").find((line) => line.trim() && !line.startsWith("#"))?.trim().slice(0, 160) ?? "";
  await writeFile(join(out, "docs", `${doc.slug}.html`), layout({ title: title || doc.title, description, body, current: true }));
}
await writeFile(
  join(out, "docs", "index.html"),
  '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=getting-started.html"><link rel="canonical" href="getting-started.html"><title>Docs</title>',
);
console.log(`Site built: ${out} (${DOCS.length} docs pages)`);
