#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const xml2js = require("xml2js");

// ----------------- CONFIG -----------------

const DOMAIN = "https://thecharmedcardinal.com";
const SHOP_URL = "https://www.etsy.com/shop/thecharmedcardinal";
const SHOP_RSS_URL = `${SHOP_URL}/rss`;

const DEFAULT_OG_IMAGE = `${DOMAIN}/assets/og-image.png`;
const FALLBACK_PRODUCT_IMAGE_WEB = "/assets/og-image.png";

const ROOT = path.join(__dirname, "..");
const PRODUCTS_DIR = path.join(ROOT, "products");
const ASSETS_PRODUCTS_DIR = path.join(ROOT, "assets", "products");

// ----------------- GENERIC HELPERS -----------------

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeFile(filePath, contents) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, contents);
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        const { statusCode, headers } = res;
        const contentType = headers["content-type"] || "";

        // Follow redirects
        if (
          statusCode >= 300 &&
          statusCode < 400 &&
          headers.location
        ) {
          res.resume();
          return resolve(httpGet(headers.location));
        }

        if (statusCode < 200 || statusCode >= 300) {
          res.resume();
          return reject(
            new Error(`HTTP ${statusCode} for ${url}`)
          );
        }

        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

function downloadBinary(url, destPath) {
  return new Promise((resolve, reject) => {
    ensureDir(path.dirname(destPath));

    https
      .get(url, (res) => {
        const { statusCode, headers } = res;

        if (
          statusCode >= 300 &&
          statusCode < 400 &&
          headers.location
        ) {
          res.resume();
          return resolve(downloadBinary(headers.location, destPath));
        }

        if (statusCode !== 200) {
          res.resume();
          return reject(
            new Error(`Image HTTP ${statusCode} for ${url}`)
          );
        }

        const stream = fs.createWriteStream(destPath);
        res.pipe(stream);
        stream.on("finish", () => stream.close(() => resolve(destPath)));
      })
      .on("error", reject);
  });
}

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function decodeHtmlEntities(str = "") {
  let s = String(str);
  const map = {
    "&quot;": '"',
    "&apos;": "'",
    "&#39;": "'",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
  };
  Object.keys(map).forEach((k) => {
    s = s.replace(new RegExp(k, "g"), map[k]);
  });

  // numeric dec
  s = s.replace(/&#(\d+);/g, (_, code) =>
    String.fromCharCode(parseInt(code, 10))
  );
  // numeric hex
  s = s.replace(/&#x([0-9a-fA-F]+);/g, (_, code) =>
    String.fromCharCode(parseInt(code, 16))
  );
  return s;
}

function stripHtml(html = "") {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function summarize(text = "", maxLen = 190) {
  const t = text.trim();
  if (t.length <= maxLen) return t;
  const cut = t.lastIndexOf(" ", maxLen - 3);
  const end = cut > 50 ? cut : maxLen - 3;
  return t.slice(0, end) + "...";
}

function slugFromTitleAndId(title, id) {
  const base = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base || "product"}-${id}`;
}

function inferType(title, description) {
  const text = (title + " " + description).toLowerCase();
  if (text.includes("pattern") || text.includes("seamless")) {
    return "digital-pattern";
  }
  // default everything else to "garden-flag" bucket (flags, doormat, tote, etc.)
  return "garden-flag";
}

// ----------------- LAYOUT HELPERS -----------------

function renderLayout({
  title,
  description,
  canonical,
  bodyHtml,
  extraHead = "",
  ogImage = DEFAULT_OG_IMAGE,
}) {
  const safeTitle = escapeHtml(title);
  const safeDesc = escapeHtml(description);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${safeTitle}</title>
  <meta name="description" content="${safeDesc}" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="canonical" href="${canonical}" />

  <link rel="stylesheet" href="/styles.css" />
  <link rel="icon" type="image/png" href="/assets/favicon.png" />

  <meta property="og:title" content="${safeTitle}" />
  <meta property="og:description" content="${safeDesc}" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${canonical}" />
  <meta property="og:image" content="${ogImage}" />

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${safeTitle}" />
  <meta name="twitter:description" content="${safeDesc}" />
  <meta name="twitter:image" content="${ogImage}" />

  ${extraHead}
</head>
<body>
  <header class="site-header">
    <div class="container header-inner">
      <a class="brand" href="/">
        <span class="brand-mark">🕊️</span>
        <span class="brand-text">
          <span class="brand-name">The Charmed Cardinal</span>
          <span class="brand-tagline">Garden Flags &amp; Seamless Patterns</span>
        </span>
      </a>
      <nav class="main-nav">
        <a href="/">Home</a>
        <a href="/shop.html">Shop</a>
        <a href="/about.html">About</a>
        <a href="/blog/">Blog</a>
        <a href="/index.html#contact">Contact</a>
      </nav>
    </div>
  </header>

  <main>
${bodyHtml}
  </main>

  <footer class="site-footer">
    <div class="container footer-inner">
      <p>&copy; <span id="year"></span> The Charmed Cardinal. All rights reserved.</p>
      <nav class="footer-nav">
        <a href="/">Home</a>
        <a href="/shop.html">Shop</a>
        <a href="/about.html">About</a>
        <a href="/blog/">Blog</a>
      </nav>
    </div>
    <script>
      document.getElementById("year").textContent = new Date().getFullYear();
    </script>
  </footer>
</body>
</html>`;
}

function renderBreadcrumb(items) {
  return `
    <nav aria-label="Breadcrumb" class="section-footnote" style="margin-bottom:0.75rem;">
      ${items
        .map((item, i) => {
          if (!item.href || i === items.length - 1) {
            return `<span>${escapeHtml(item.label)}</span>`;
          }
          return `<a href="${item.href}">${escapeHtml(item.label)}</a> &raquo; `;
        })
        .join("")}
    </nav>
  `;
}

function renderTags(tags = []) {
  if (!tags.length) return "";
  return `
    <p class="section-footnote" style="margin-top:0.75rem;">
      <strong>Tags:</strong>
      ${tags
        .map(
          (t) =>
            `<span style="display:inline-block;margin-right:0.35rem;">${escapeHtml(
              t
            )}</span>`
        )
        .join("")}
    </p>
  `;
}

// ----------------- PAGE RENDERERS -----------------

function renderProductPage(product, related, imageInfo) {
  const url = `${DOMAIN}/products/${product.slug}.html`;

  const imageWebPath =
    imageInfo?.webPath || FALLBACK_PRODUCT_IMAGE_WEB;
  const imageAbsUrl =
    imageInfo?.absUrl ||
    (FALLBACK_PRODUCT_IMAGE_WEB
      ? `${DOMAIN}${FALLBACK_PRODUCT_IMAGE_WEB}`
      : DEFAULT_OG_IMAGE);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.title,
    image: [imageAbsUrl],
    description: product.description,
    brand: {
      "@type": "Brand",
      name: "The Charmed Cardinal",
    },
    url,
    offers: {
      "@type": "Offer",
      url: product.etsy,
      availability: "https://schema.org/InStock",
    },
  };

  const extraHead = `
<script type="application/ld+json">
${JSON.stringify(jsonLd, null, 2)}
</script>`;

  const breadcrumbItems = [
    { label: "Home", href: "/" },
    { label: "Shop", href: "/shop.html" },
  ];
  if (product.type === "garden-flag") {
    breadcrumbItems.push({
      label: "Garden Flags",
      href: "/products/garden-flags.html",
    });
  } else if (product.type === "digital-pattern") {
    breadcrumbItems.push({
      label: "Digital Patterns",
      href: "/products/digital-patterns.html",
    });
  }
  breadcrumbItems.push({ label: product.title });

  const relatedHtml = related.length
    ? `
    <section class="section">
      <div class="container">
        <h2>Related ${
          product.type === "garden-flag"
            ? "garden flags"
            : "patterns"
        }</h2>
        <div class="card-grid">
          ${related
            .map(
              (rp) => `
            <article class="card">
              <h3><a href="/products/${rp.slug}.html">${escapeHtml(
                rp.title
              )}</a></h3>
              <p>${escapeHtml(summarize(rp.description, 160))}</p>
              <a class="card-link" href="/products/${
                rp.slug
              }.html">View details →</a>
            </article>`
            )
            .join("")}
        </div>
      </div>
    </section>`
    : "";

  const bodyHtml = `
    <section class="section section-alt">
      <div class="container">
        ${renderBreadcrumb(breadcrumbItems)}
        <div class="grid-two">
          <div class="hero-image">
            <img src="${imageWebPath}" alt="${escapeHtml(
    product.title
  )}" style="width:100%;border-radius:22px;box-shadow:0 10px 25px rgba(15,23,42,0.15);" />
          </div>
          <div class="hero-copy">
            <h1>${escapeHtml(product.title)}</h1>
            <p>${escapeHtml(product.description)}</p>
            <p><strong>Category:</strong> ${
              product.type === "garden-flag"
                ? "Garden Flag / Outdoor Decor"
                : "Digital Seamless Pattern"
            }</p>
            ${renderTags(product.tags)}
            <div class="hero-actions">
              <a class="btn primary" href="${
                product.etsy
              }" target="_blank" rel="noopener noreferrer">
                View on Etsy
              </a>
              <a class="btn secondary" href="/shop.html">
                Back to shop
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
    ${relatedHtml}
  `;

  return renderLayout({
    title: `${product.title} | The Charmed Cardinal`,
    description: summarize(product.description),
    canonical: url,
    bodyHtml,
    extraHead,
    ogImage: imageAbsUrl,
  });
}

function renderCategoryPage({ title, slug, intro, items }) {
  const url = `${DOMAIN}/products/${slug}.html`;

  const bodyHtml = `
    <section class="section">
      <div class="container">
        ${renderBreadcrumb([
          { label: "Home", href: "/" },
          { label: "Shop", href: "/shop.html" },
          { label: title },
        ])}
        <h1>${escapeHtml(title)}</h1>
        <p class="section-intro">${escapeHtml(intro)}</p>

        <div class="card-grid">
          ${items
            .map(
              (p) => `
            <article class="card">
              <h2><a href="/products/${p.slug}.html">${escapeHtml(
                p.title
              )}</a></h2>
              <p>${escapeHtml(summarize(p.description, 200))}</p>
              ${renderTags(p.tags)}
              <p>
                <a class="card-link" href="/products/${
                  p.slug
                }.html">View details →</a>
                &nbsp;·&nbsp;
                <a class="card-link" href="${
                  p.etsy
                }" target="_blank" rel="noopener noreferrer">View on Etsy →</a>
              </p>
            </article>`
            )
            .join("")}
        </div>
      </div>
    </section>
  `;

  return renderLayout({
    title: `${title} | The Charmed Cardinal`,
    description: intro,
    canonical: url,
    bodyHtml,
  });
}

function renderShopPage(gardenFlags, digitalPatterns) {
  const url = `${DOMAIN}/shop.html`;

  const bodyHtml = `
    <section class="section">
      <div class="container">
        ${renderBreadcrumb([{ label: "Home", href: "/" }, { label: "Shop" }])}
        <h1>Shop The Charmed Cardinal</h1>
        <p class="section-intro">
          Browse nature-inspired garden flags and digital seamless patterns. Click any design
          to view details, styling ideas, and shop directly on Etsy.
        </p>

        <h2>Garden Flags</h2>
        <div class="card-grid">
          ${gardenFlags
            .map(
              (p) => `
            <article class="card">
              <h3><a href="/products/${p.slug}.html">${escapeHtml(
                p.title
              )}</a></h3>
              <p>${escapeHtml(summarize(p.description, 200))}</p>
              ${renderTags(p.tags)}
              <p>
                <a class="card-link" href="/products/${
                  p.slug
                }.html">View details →</a>
                &nbsp;·&nbsp;
                <a class="card-link" href="${
                  p.etsy
                }" target="_blank" rel="noopener noreferrer">View on Etsy →</a>
              </p>
            </article>`
            )
            .join("")}
        </div>

        <h2 style="margin-top:2.5rem;">Digital Seamless Patterns</h2>
        <div class="card-grid">
          ${digitalPatterns
            .map(
              (p) => `
            <article class="card">
              <h3><a href="/products/${p.slug}.html">${escapeHtml(
                p.title
              )}</a></h3>
              <p>${escapeHtml(summarize(p.description, 200))}</p>
              ${renderTags(p.tags)}
              <p>
                <a class="card-link" href="/products/${
                  p.slug
                }.html">View details →</a>
                &nbsp;·&nbsp;
                <a class="card-link" href="${
                  p.etsy
                }" target="_blank" rel="noopener noreferrer">View on Etsy →</a>
              </p>
            </article>`
            )
            .join("")}
        </div>

        <p class="section-footnote" style="margin-top:2rem;">
          Want to see everything in one place? Visit the full Etsy shop:
          <a href="${SHOP_URL}" target="_blank" rel="noopener noreferrer">
            The Charmed Cardinal on Etsy
          </a>.
        </p>
      </div>
    </section>
  `;

  return renderLayout({
    title:
      "Shop The Charmed Cardinal – Garden Flags & Digital Patterns",
    description:
      "Shop garden flags, porch decor, and digital seamless patterns inspired by nature, dogs, and cozy outdoor spaces.",
    canonical: url,
    bodyHtml,
  });
}

function renderHomePage(products) {
  const url = `${DOMAIN}/`;
  const featured = products.slice(0, 4);

  const bodyHtml = `
    <section class="section section-alt hero">
      <div class="container grid-two">
        <div class="hero-copy">
          <h1>Garden flags &amp; patterns with heart</h1>
          <p class="section-intro">
            The Charmed Cardinal creates nature-inspired garden flags, cozy porch decor,
            and print-ready seamless patterns for crafters and makers.
          </p>
          <div class="hero-actions">
            <a class="btn primary" href="/shop.html">Shop garden flags</a>
            <a class="btn secondary" href="/products/digital-patterns.html">Shop patterns</a>
          </div>
        </div>
        <div class="hero-image">
          <img
            src="/assets/og-image.png"
            alt="Selection of garden flags and patterns from The Charmed Cardinal"
            style="width:100%;border-radius:22px;box-shadow:0 10px 25px rgba(15,23,42,0.15);"
          />
        </div>
      </div>
    </section>

    <section class="section">
      <div class="container">
        <h2>Featured products</h2>
        <p class="section-intro">
          A quick peek at some of the designs available in the shop. Click any product
          to learn more and see it on Etsy.
        </p>
        <div class="card-grid">
          ${featured
            .map(
              (p) => `
          <article class="card">
            <h3><a href="/products/${p.slug}.html">${escapeHtml(
              p.title
            )}</a></h3>
            <p>${escapeHtml(summarize(p.description, 200))}</p>
            <p>
              <a class="card-link" href="/products/${
                p.slug
              }.html">View details →</a>
              &nbsp;·&nbsp;
              <a class="card-link" href="${
                p.etsy
              }" target="_blank" rel="noopener noreferrer">View on Etsy →</a>
            </p>
          </article>`
            )
            .join("")}
        </div>

        <p class="section-footnote" style="margin-top:2rem;">
          Looking for more? Browse the full <a href="/shop.html">shop page</a> or
          <a href="${SHOP_URL}" target="_blank" rel="noopener noreferrer">visit the Etsy shop</a>.
        </p>
      </div>
    </section>
  `;

  return renderLayout({
    title: "The Charmed Cardinal – Garden Flags & Seamless Patterns",
    description:
      "Nature-inspired garden flags, cozy porch decor, and digital seamless patterns designed by The Charmed Cardinal.",
    canonical: url,
    bodyHtml,
  });
}

function renderBlogIndex() {
  const url = `${DOMAIN}/blog/`;

  const posts = [
    {
      title: "How to Style Your Porch With Garden Flags",
      href: "/blog/style-your-porch-with-garden-flags.html",
      summary:
        "Ideas for choosing, layering, and rotating garden flags so your porch decor feels welcoming in every season.",
    },
  ];

  const bodyHtml = `
    <section class="section">
      <div class="container">
        ${renderBreadcrumb([{ label: "Home", href: "/" }, { label: "Blog" }])}
        <h1>Blog</h1>
        <p class="section-intro">
          Inspiration for styling your porch, choosing garden flags, and using digital patterns
          in your creative projects.
        </p>

        <div class="card-grid">
          ${posts
            .map(
              (p) => `
            <article class="card">
              <h2><a href="${p.href}">${escapeHtml(p.title)}</a></h2>
              <p>${escapeHtml(p.summary)}</p>
              <a class="card-link" href="${p.href}">Read article →</a>
            </article>`
            )
            .join("")}
        </div>
      </div>
    </section>
  `;

  return renderLayout({
    title: "Blog | The Charmed Cardinal",
    description:
      "Articles and inspiration for porch styling, garden flags, and creative uses for seamless patterns.",
    canonical: url,
    bodyHtml,
  });
}

// ----------------- DATA & BUILD HELPERS -----------------

async function fetchProductsFromRss() {
  console.log(`→ Fetching Etsy RSS: ${SHOP_RSS_URL}`);
  const xml = await httpGet(SHOP_RSS_URL);

  const parser = new xml2js.Parser({ explicitArray: false });
  const parsed = await parser.parseStringPromise(xml);

  const itemsRaw =
    parsed?.rss?.channel?.item ||
    parsed?.feed?.entry ||
    [];
  const items = Array.isArray(itemsRaw) ? itemsRaw : [itemsRaw];

  console.log(`✓ RSS items found: ${items.length}`);

  const products = [];

  for (const item of items) {
    if (!item) continue;
    const link = item.link || "";
    const idMatch = String(link).match(/listing\/(\d+)/);
    const id = idMatch ? idMatch[1] : "";

    let titleRaw = item.title || "Untitled product";
    titleRaw = decodeHtmlEntities(titleRaw);
    titleRaw = titleRaw.replace(/\s+by\s+The\s*Charmed\s*Cardinal$/i, "");
    titleRaw = titleRaw.replace(/\s+by\s+TheCharmedCardinal$/i, "");
    const title = titleRaw.trim() || "Untitled product";

    const descHtml =
      item["content:encoded"] || item.description || "";
    const descriptionPlain = stripHtml(
      decodeHtmlEntities(descHtml)
    );

    // image via media:content or description <img>
    let imageUrl = null;
    const media = item["media:content"];
    if (media && media.$ && media.$.url) {
      imageUrl = media.$.url;
    }
    if (!imageUrl) {
      const m = String(descHtml).match(
        /<img[^>]+src=["']([^"']+)["']/i
      );
      if (m) imageUrl = m[1];
    }

    const type = inferType(title, descriptionPlain);
    const slug = slugFromTitleAndId(title, id);

    products.push({
      id,
      slug,
      title,
      description: descriptionPlain || title,
      etsy: link || `${SHOP_URL}`,
      type,
      tags: [],
      imageUrl,
    });
  }

  console.log(`✓ Parsed products from RSS: ${products.length}`);
  return products;
}

async function ensureProductImage(product) {
  ensureDir(ASSETS_PRODUCTS_DIR);

  const baseName = product.slug.replace(/[^a-z0-9\-]/gi, "-");
  const possibleExts = ["jpg", "jpeg", "png", "webp"];

  // Reuse existing file if present
  for (const ext of possibleExts) {
    const candidate = path.join(
      ASSETS_PRODUCTS_DIR,
      `${baseName}.${ext}`
    );
    if (fs.existsSync(candidate)) {
      const webPath = `/assets/products/${baseName}.${ext}`;
      return { webPath, absUrl: `${DOMAIN}${webPath}` };
    }
  }

  if (!product.imageUrl) {
    console.warn(
      `⚠ No image URL in RSS for "${product.title}" – using fallback`
    );
    return null;
  }

  let ext = "jpg";
  const lower = product.imageUrl.toLowerCase();
  if (lower.includes(".png")) ext = "png";
  else if (lower.includes(".webp")) ext = "webp";
  else if (lower.includes(".jpeg")) ext = "jpeg";

  const filename = `${baseName}.${ext}`;
  const dest = path.join(ASSETS_PRODUCTS_DIR, filename);

  console.log(
    `→ Downloading image for "${product.title}": ${product.imageUrl}`
  );
  try {
    await downloadBinary(product.imageUrl, dest);
    const webPath = `/assets/products/${filename}`;
    return { webPath, absUrl: `${DOMAIN}${webPath}` };
  } catch (err) {
    console.warn(
      `⚠ Failed to download image for "${product.title}": ${err.message}`
    );
    return null;
  }
}

function cleanupLegacyUntitledProducts() {
  ensureDir(PRODUCTS_DIR);
  const files = fs.readdirSync(PRODUCTS_DIR);
  const removed = [];
  for (const f of files) {
    if (f.startsWith("untitled-product")) {
      const full = path.join(PRODUCTS_DIR, f);
      fs.unlinkSync(full);
      removed.push(f);
    }
  }
  if (removed.length) {
    console.log(
      `✓ Removed legacy untitled product pages: ${removed.length}`
    );
  }
}

// ----------------- MAIN BUILD -----------------

(async function build() {
  console.log("\n🚀 BUILD START\n");

  try {
    cleanupLegacyUntitledProducts();

    // 1) Fetch products from Etsy RSS
    const products = await fetchProductsFromRss();
    if (!products.length) {
      throw new Error("No products parsed from RSS");
    }

    // 2) Download images & build pages
    const gardenFlags = [];
    const digitalPatterns = [];

    // save basic info JSON (no image path needed for now)
    ensureDir(path.join(ROOT, "data"));
    writeFile(
      path.join(ROOT, "data", "products.json"),
      JSON.stringify(
        products.map((p) => ({
          slug: p.slug,
          title: p.title,
          type: p.type,
          description: p.description,
          etsy: p.etsy,
          tags: p.tags,
        })),
        null,
        2
      )
    );
    console.log("✓ Saved data/products.json");

    // product pages
    for (const product of products) {
      const imgInfo = await ensureProductImage(product);

      const related = products
        .filter(
          (p) => p.slug !== product.slug && p.type === product.type
        )
        .slice(0, 3);

      const html = renderProductPage(product, related, imgInfo);
      const outPath = path.join(
        PRODUCTS_DIR,
        `${product.slug}.html`
      );
      writeFile(outPath, html);
      console.log("✓ Product page:", path.relative(ROOT, outPath));

      if (product.type === "garden-flag") {
        gardenFlags.push(product);
      } else if (product.type === "digital-pattern") {
        digitalPatterns.push(product);
      }
    }

    // 3) Category pages
    const gardenFlagsPage = renderCategoryPage({
      title: "Garden Flags",
      slug: "garden-flags",
      intro:
        "Decorative garden flags for porches, patios, balconies, and front yards – featuring plants, dogs, kindness, and eco-friendly messages.",
      items: gardenFlags,
    });
    writeFile(
      path.join(PRODUCTS_DIR, "garden-flags.html"),
      gardenFlagsPage
    );
    console.log("✓ Category page: products/garden-flags.html");

    const digitalPatternsPage = renderCategoryPage({
      title: "Digital Seamless Patterns",
      slug: "digital-patterns",
      intro:
        "High-resolution seamless patterns for fabric, wrapping paper, print-on-demand products, and digital craft projects.",
      items: digitalPatterns,
    });
    writeFile(
      path.join(PRODUCTS_DIR, "digital-patterns.html"),
      digitalPatternsPage
    );
    console.log("✓ Category page: products/digital-patterns.html");

    // 4) Shop page
    const shopHtml = renderShopPage(gardenFlags, digitalPatterns);
    writeFile(path.join(ROOT, "shop.html"), shopHtml);
    console.log("✓ Shop page: shop.html");

    // 5) Homepage
    const homeHtml = renderHomePage(products);
    writeFile(path.join(ROOT, "index.html"), homeHtml);
    console.log("✓ Homepage: index.html");

    // 6) Blog index
    const blogIndexHtml = renderBlogIndex();
    writeFile(
      path.join(ROOT, "blog", "index.html"),
      blogIndexHtml
    );
    console.log("✓ Blog index: blog/index.html");

    // 7) Sitemap
    const staticPages = [
      "",
      "shop.html",
      "about.html",
      "blog/",
      "products/garden-flags.html",
      "products/digital-patterns.html",
    ];

    let sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
`;
    staticPages.forEach((p) => {
      sitemap += `  <url><loc>${DOMAIN}/${p}</loc></url>\n`;
    });
    products.forEach((p) => {
      sitemap += `  <url><loc>${DOMAIN}/products/${p.slug}.html</loc></url>\n`;
    });
    sitemap += `</urlset>\n`;

    writeFile(path.join(ROOT, "sitemap.xml"), sitemap);
    console.log("✓ Sitemap: sitemap.xml");

    console.log("\n✅ BUILD COMPLETE — full site generated.\n");
  } catch (err) {
    console.error("\n❌ BUILD FAILED:", err);
    process.exit(1);
  }
})();
