/**
 * build.js — Etsy RSS → Static site generator (no Puppeteer)
 * - Pulls listings from Etsy shop RSS
 * - Extracts title, link, description, and a cover image
 * - Downloads ONE image per product (option B)
 * - Generates:
 *    - /products/*.html product pages
 *    - /products/garden-flags.html
 *    - /products/digital-patterns.html
 *    - /shop.html
 *    - sitemap.xml
 * - Leaves your existing index.html, about.html, blog pages in place
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const xml2js = require("xml2js");

// ----------------- CONFIG -----------------

const DOMAIN = "https://thecharmedcardinal.com";
const SHOP_RSS = "https://www.etsy.com/shop/thecharmedcardinal/rss";

const OUT_ROOT = path.join(__dirname, "..");
const ASSETS_DIR = path.join(OUT_ROOT, "assets");
const PRODUCTS_ASSETS_DIR = path.join(ASSETS_DIR, "products");

// Fallback image if we can't get one from RSS
const FALLBACK_IMAGE_WEB = "/assets/og-image.png"; // you already have og-image.png

// ----------------- HELPERS -----------------

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Follow redirects
          res.resume();
          return resolve(httpsGet(res.headers.location));
        }

        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }

        let data = "";
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
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(downloadBinary(res.headers.location, destPath));
        }

        if (res.statusCode !== 200) {
          res.resume();
          return reject(
            new Error(`Image download failed: HTTP ${res.statusCode} for ${url}`)
          );
        }

        const fileStream = fs.createWriteStream(destPath);
        res.pipe(fileStream);
        fileStream.on("finish", () => {
          fileStream.close(() => resolve(destPath));
        });
      })
      .on("error", reject);
  });
}

function stripHtml(html = "") {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function slugFromTitleAndId(title, id) {
  const base = (title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base || "product"}-${id}`;
}

function inferType(title, description) {
  const text = (title + " " + description).toLowerCase();
  if (text.includes("pattern") || text.includes("seamless")) return "digital-pattern";
  if (text.includes("doormat")) return "garden-flag"; // treat as physical decor
  return "garden-flag";
}

// ----------------- RSS → PRODUCTS -----------------

async function fetchProductsFromRSS() {
  console.log(`→ Fetching Etsy RSS: ${SHOP_RSS}`);

  const xml = await httpsGet(SHOP_RSS);

  const parsed = await new Promise((resolve, reject) => {
    xml2js.parseString(xml, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });

  const items = parsed?.rss?.channel?.[0]?.item || [];
  console.log(`✓ RSS items found: ${items.length}`);

  const products = [];

  for (const item of items) {
    const link = item.link?.[0];
    const title = (item.title?.[0] || "").trim();
    const rawDescription = item.description?.[0] || "";
    const description = stripHtml(rawDescription) || "A handmade design from The Charmed Cardinal.";

    if (!link || !title) {
      continue;
    }

    // Extract ID from URL /listing/{id}
    const idMatch = link.match(/\/listing\/(\d+)/);
    const id = idMatch ? idMatch[1] : String(Date.now());

    // Try to get an image from media tags first
    let imageUrl = null;

    if (item["media:content"] && item["media:content"][0]?.$?.url) {
      imageUrl = item["media:content"][0].$.url;
    } else if (item["media:thumbnail"] && item["media:thumbnail"][0]?.$?.url) {
      imageUrl = item["media:thumbnail"][0].$.url;
    } else {
      // As a fallback, try to scrape <img src="..."> out of the description HTML
      const imgMatch = rawDescription.match(/<img[^>]+src=["']([^"']+)["']/i);
      if (imgMatch) {
        imageUrl = imgMatch[1];
      }
    }

    const slug = slugFromTitleAndId(title, id);
    const type = inferType(title, description);

    products.push({
      id,
      slug,
      title,
      description,
      etsy: link,
      type,
      tags: [],
      remoteImageUrl: imageUrl || null,
    });
  }

  console.log(`✓ Parsed products from RSS: ${products.length}`);
  return products;
}

// ----------------- HTML RENDERING -----------------

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderLayout({ title, description, canonical, bodyHtml, ogImage }) {
  const safeTitle = escapeHtml(title);
  const safeDesc = escapeHtml(description);
  const safeCanonical = escapeHtml(canonical);
  const safeOg = escapeHtml(ogImage);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${safeTitle}</title>
  <meta name="description" content="${safeDesc}" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="canonical" href="${safeCanonical}" />
  <link rel="stylesheet" href="/styles.css" />
  <link rel="icon" type="image/png" href="/assets/favicon.png" />

  <meta property="og:title" content="${safeTitle}" />
  <meta property="og:description" content="${safeDesc}" />
  <meta property="og:type" content="product" />
  <meta property="og:url" content="${safeCanonical}" />
  <meta property="og:image" content="${safeOg}" />

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${safeTitle}" />
  <meta name="twitter:description" content="${safeDesc}" />
  <meta name="twitter:image" content="${safeOg}" />
</head>
<body>
  <header class="site-header">
    <div class="container header-inner">
      <a href="/" class="brand">
        <span class="brand-mark">🕊️</span>
        <span class="brand-text">
          <span class="brand-name">The Charmed Cardinal</span>
          <span class="brand-tagline">Garden Flags & Seamless Patterns</span>
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
      document.getElementById('year').textContent = new Date().getFullYear();
    </script>
  </footer>
</body>
</html>`;
}

function renderBreadcrumb(items) {
  return `
<nav aria-label="Breadcrumb" class="section-footnote" style="margin-bottom: 0.75rem;">
  ${items
    .map((item, i) => {
      if (!item.href || i === items.length - 1) {
        return `<span>${escapeHtml(item.label)}</span>`;
      }
      return `<a href="${item.href}">${escapeHtml(item.label)}</a> &raquo; `;
    })
    .join("")}
</nav>`;
}

function renderTags(tags = []) {
  if (!tags.length) return "";
  return `
<p class="section-footnote" style="margin-top: 0.75rem;">
  <strong>Tags:</strong>
  ${tags
    .map(
      (t) =>
        `<span style="display:inline-block;margin-right:0.35rem;">${escapeHtml(
          t
        )}</span>`
    )
    .join("")}
</p>`;
}

function renderProductPage(product) {
  const url = `${DOMAIN}/products/${product.slug}.html`;
  const imageWebPath = product.imageWebPath || FALLBACK_IMAGE_WEB;
  const imageAbsUrl = imageWebPath.startsWith("http")
    ? imageWebPath
    : `${DOMAIN}${imageWebPath}`;

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
          <a class="btn primary" href="${product.etsy}" target="_blank" rel="noopener noreferrer">
            View on Etsy
          </a>
          <a class="btn secondary" href="/shop.html">Back to shop</a>
        </div>
      </div>
    </div>
  </div>
</section>`;

  return renderLayout({
    title: `${product.title} | The Charmed Cardinal`,
    description: product.description,
    canonical: url,
    bodyHtml,
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
        <h2><a href="/products/${p.slug}.html">${escapeHtml(p.title)}</a></h2>
        <p>${escapeHtml(p.description)}</p>
        ${renderTags(p.tags)}
        <p>
          <a class="card-link" href="/products/${p.slug}.html">View details →</a>
          &nbsp;·&nbsp;
          <a class="card-link" href="${p.etsy}" target="_blank" rel="noopener noreferrer">View on Etsy →</a>
        </p>
      </article>`
        )
        .join("")}
    </div>
  </div>
</section>`;

  return renderLayout({
    title: `${title} | The Charmed Cardinal`,
    description: intro,
    canonical: url,
    bodyHtml,
    ogImage: `${DOMAIN}${FALLBACK_IMAGE_WEB}`,
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
      to view details, styling ideas, and a direct link to the Etsy listing.
    </p>

    <h2>Garden Flags</h2>
    <div class="card-grid">
      ${gardenFlags
        .map(
          (p) => `
      <article class="card">
        <h3><a href="/products/${p.slug}.html">${escapeHtml(p.title)}</a></h3>
        <p>${escapeHtml(p.description)}</p>
        ${renderTags(p.tags)}
        <p>
          <a class="card-link" href="/products/${p.slug}.html">View details →</a>
          &nbsp;·&nbsp;
          <a class="card-link" href="${p.etsy}" target="_blank" rel="noopener noreferrer">View on Etsy →</a>
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
        <h3><a href="/products/${p.slug}.html">${escapeHtml(p.title)}</a></h3>
        <p>${escapeHtml(p.description)}</p>
        ${renderTags(p.tags)}
        <p>
          <a class="card-link" href="/products/${p.slug}.html">View details →</a>
          &nbsp;·&nbsp;
          <a class="card-link" href="${p.etsy}" target="_blank" rel="noopener noreferrer">View on Etsy →</a>
        </p>
      </article>`
        )
        .join("")}
    </div>

    <p class="section-footnote" style="margin-top:2rem;">
      Want to see everything in one place? Visit the full Etsy shop:
      <a href="https://www.etsy.com/shop/thecharmedcardinal" target="_blank" rel="noopener noreferrer">
        The Charmed Cardinal on Etsy
      </a>.
    </p>
  </div>
</section>`;

  return renderLayout({
    title: "Shop | The Charmed Cardinal – Garden Flags & Patterns",
    description:
      "Shop The Charmed Cardinal garden flags and digital seamless patterns inspired by nature, dogs, and cozy porch decor.",
    canonical: url,
    bodyHtml,
    ogImage: `${DOMAIN}${FALLBACK_IMAGE_WEB}`,
  });
}

// ----------------- BUILD PIPELINE -----------------

async function build() {
  try {
    console.log("\n🚀 BUILD START\n");

    ensureDir(PRODUCTS_ASSETS_DIR);

    const products = await fetchProductsFromRSS();
    if (!products.length) {
      throw new Error("No products parsed from RSS");
    }

    // Download ONE cover image per product (option B)
    for (const p of products) {
      if (!p.remoteImageUrl) {
        console.log(`⚠ No image URL for "${p.title}" — will use fallback.`);
        p.imageWebPath = FALLBACK_IMAGE_WEB;
        continue;
      }

      // Determine extension
      let ext = "jpg";
      const lower = p.remoteImageUrl.toLowerCase();
      if (lower.includes(".png")) ext = "png";
      else if (lower.includes(".webp")) ext = "webp";
      else if (lower.includes(".jpeg")) ext = "jpeg";

      const filename = `${p.slug}.${ext}`;
      const destPath = path.join(PRODUCTS_ASSETS_DIR, filename);

      // Skip download if already exists
      if (fs.existsSync(destPath)) {
        console.log(`✓ Reusing existing image for "${p.title}"`);
        p.imageWebPath = `/assets/products/${filename}`;
        continue;
      }

      console.log(`→ Downloading image for "${p.title}": ${p.remoteImageUrl}`);
      try {
        await downloadBinary(p.remoteImageUrl, destPath);
        p.imageWebPath = `/assets/products/${filename}`;
      } catch (err) {
        console.log(
          `⚠ Failed to download image for "${p.title}": ${err.message} — using fallback`
        );
        p.imageWebPath = FALLBACK_IMAGE_WEB;
      }
    }

    // Save products.json (for debugging / transparency)
    ensureDir(path.join(OUT_ROOT, "data"));
    fs.writeFileSync(
      path.join(OUT_ROOT, "data", "products.json"),
      JSON.stringify(
        products.map((p) => ({
          id: p.id,
          slug: p.slug,
          title: p.title,
          description: p.description,
          etsy: p.etsy,
          type: p.type,
          tags: p.tags,
          imageWebPath: p.imageWebPath,
        })),
        null,
        2
      )
    );
    console.log("✓ Saved data/products.json");

    // Split by type
    const gardenFlags = products.filter((p) => p.type === "garden-flag");
    const digitalPatterns = products.filter((p) => p.type === "digital-pattern");

    // Ensure products directory exists
    ensureDir(path.join(OUT_ROOT, "products"));

    // Product detail pages
    for (const p of products) {
      const html = renderProductPage(p);
      const outPath = path.join(OUT_ROOT, "products", `${p.slug}.html`);
      fs.writeFileSync(outPath, html);
      console.log("✓ Product page:", `products/${p.slug}.html`);
    }

    // Category pages
    const gardenFlagsPage = renderCategoryPage({
      title: "Garden Flags",
      slug: "garden-flags",
      intro:
        "Decorative garden flags for porches, patios, balconies, and front yards – featuring plants, dogs, kindness, and eco-friendly messages.",
      items: gardenFlags,
    });
    fs.writeFileSync(
      path.join(OUT_ROOT, "products", "garden-flags.html"),
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
    fs.writeFileSync(
      path.join(OUT_ROOT, "products", "digital-patterns.html"),
      digitalPatternsPage
    );
    console.log("✓ Category page: products/digital-patterns.html");

    // Shop page
    const shopHtml = renderShopPage(gardenFlags, digitalPatterns);
    fs.writeFileSync(path.join(OUT_ROOT, "shop.html"), shopHtml);
    console.log("✓ Shop page: shop.html");

    // Sitemap
    const staticPages = [
      "",
      "about.html",
      "shop.html",
      "blog/",
      "blog/style-your-porch-with-garden-flags.html",
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

    fs.writeFileSync(path.join(OUT_ROOT, "sitemap.xml"), sitemap);
    console.log("✓ Sitemap: sitemap.xml");

    console.log("\n✅ BUILD COMPLETE — RSS-based images + full site generated.\n");
  } catch (err) {
    console.error("❌ BUILD FAILED:", err);
    process.exit(1);
  }
}

build();
