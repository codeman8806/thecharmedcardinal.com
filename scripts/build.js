const fs = require("fs");
const path = require("path");
const https = require("https");

const DOMAIN = "https://thecharmedcardinal.com";
const DEFAULT_OG_IMAGE = `${DOMAIN}/assets/og-image.jpg`;
const FALLBACK_PRODUCT_IMAGE_WEB = "/assets/product-placeholder.jpg"; // optional; will use if Etsy image fails

// --- Helpers -------------------------------------------------------------

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeFile(p, contents) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents);
}

function fileExists(p) {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// Simple GET for HTML (follows one level of redirect)
function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        // follow simple redirects
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          return resolve(fetchHtml(res.headers.location));
        }

        if (res.statusCode !== 200) {
          res.resume();
          return reject(
            new Error(`Request failed. Status code: ${res.statusCode} for ${url}`)
          );
        }

        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

// Download binary (image) to disk
function downloadBinary(url, destPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(downloadBinary(res.headers.location, destPath));
        }

        if (res.statusCode !== 200) {
          res.resume();
          return reject(
            new Error(
              `Image download failed. Status code: ${res.statusCode} for ${url}`
            )
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

// Extract og:image from Etsy HTML
function extractOgImage(html) {
  const metaTagMatch = html.match(
    /<meta[^>]+property=["']og:image["'][^>]*>/i
  );
  if (!metaTagMatch) return null;

  const tag = metaTagMatch[0];
  const contentMatch = tag.match(/content=["']([^"']+)["']/i);
  if (!contentMatch) return null;

  return contentMatch[1];
}

// Ensure local product image exists; returns { webPath, absUrl } or null
async function ensureProductImage(product) {
  const assetsDir = path.join(__dirname, "..", "assets", "products");
  fs.mkdirSync(assetsDir, { recursive: true });

  const baseName = product.slug.replace(/[^a-z0-9\-]/gi, "-");
  const possibleExts = ["jpg", "jpeg", "png", "webp"];

  // 1) If we already have a downloaded image, use it
  for (const ext of possibleExts) {
    const local = path.join(assetsDir, `${baseName}.${ext}`);
    if (fileExists(local)) {
      const webPath = `/assets/products/${baseName}.${ext}`;
      return { webPath, absUrl: `${DOMAIN}${webPath}` };
    }
  }

  // 2) Otherwise, scrape Etsy
  try {
    console.log(`→ Fetching Etsy page for image: ${product.etsy}`);
    const html = await fetchHtml(product.etsy);
    const ogImageUrl = extractOgImage(html);
    if (!ogImageUrl) {
      console.warn(`⚠ No og:image found for ${product.etsy}`);
      return null;
    }

    // Guess extension from URL
    let ext = "jpg";
    const lower = ogImageUrl.toLowerCase();
    if (lower.includes(".png")) ext = "png";
    else if (lower.includes(".webp")) ext = "webp";
    else if (lower.includes(".jpeg")) ext = "jpeg";

    const filename = `${baseName}.${ext}`;
    const destPath = path.join(assetsDir, filename);

    console.log(`→ Downloading image to ${destPath}`);
    await downloadBinary(ogImageUrl, destPath);

    const webPath = `/assets/products/${filename}`;
    return { webPath, absUrl: `${DOMAIN}${webPath}` };
  } catch (err) {
    console.error(`⚠ Failed to fetch/download Etsy image for ${product.slug}:`, err.message);
    return null;
  }
}

// Shared layout: header/footer with nav, OG/Twitter, etc.
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

// --- Load data -----------------------------------------------------------

const productsPath = path.join(__dirname, "..", "data", "products.json");
const products = readJson(productsPath);

const gardenFlags = products.filter((p) => p.type === "garden-flag");
const digitalPatterns = products.filter((p) => p.type === "digital-pattern");

// --- Render helpers ------------------------------------------------------

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
    </nav>
  `;
}

function renderTags(tags = []) {
  if (!tags.length) return "";
  return `
    <p class="section-footnote" style="margin-top: 0.75rem;">
      <strong>Tags:</strong>
      ${tags
        .map((t) => `<span style="display:inline-block;margin-right:0.35rem;">${escapeHtml(t)}</span>`)
        .join("")}
    </p>
  `;
}

// Product detail (hero) page
function renderProductPage(product, relatedProducts, imageInfo) {
  const url = `${DOMAIN}/products/${product.slug}.html`;

  const imageWebPath = imageInfo?.webPath || FALLBACK_PRODUCT_IMAGE_WEB;
  const imageAbsUrl =
    imageInfo?.absUrl ||
    (FALLBACK_PRODUCT_IMAGE_WEB
      ? `${DOMAIN}${FALLBACK_PRODUCT_IMAGE_WEB}`
      : DEFAULT_OG_IMAGE);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    "name": product.title,
    "image": [imageAbsUrl],
    "description": product.description,
    "brand": {
      "@type": "Brand",
      "name": "The Charmed Cardinal"
    },
    "url": url,
    "offers": {
      "@type": "Offer",
      "url": product.etsy,
      "availability": "https://schema.org/InStock"
    }
  };

  const extraHead = `
<script type="application/ld+json">
${JSON.stringify(jsonLd, null, 2)}
</script>
  `;

  const breadcrumbItems = [
    { label: "Home", href: "/" },
    { label: "Shop", href: "/shop.html" },
  ];

  if (product.type === "garden-flag") {
    breadcrumbItems.push({ label: "Garden Flags", href: "/products/garden-flags.html" });
  } else if (product.type === "digital-pattern") {
    breadcrumbItems.push({ label: "Digital Patterns", href: "/products/digital-patterns.html" });
  }

  breadcrumbItems.push({ label: product.title });

  const relatedHtml = relatedProducts.length
    ? `
    <section class="section">
      <div class="container">
        <h2>Related ${product.type === "garden-flag" ? "garden flags" : "patterns"}</h2>
        <div class="card-grid">
          ${relatedProducts
            .map(
              (rp) => `
            <article class="card">
              <h3><a href="/products/${rp.slug}.html">${escapeHtml(rp.title)}</a></h3>
              <p>${escapeHtml(rp.description)}</p>
              <a class="card-link" href="/products/${rp.slug}.html">View details →</a>
            </article>
          `
            )
            .join("")}
        </div>
      </div>
    </section>
  `
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
              product.type === "garden-flag" ? "Garden Flag" : "Digital Seamless Pattern"
            }</p>
            ${renderTags(product.tags)}
            <div class="hero-actions">
              <a class="btn primary" href="${product.etsy}" target="_blank" rel="noopener noreferrer">
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
    description: product.description,
    canonical: url,
    bodyHtml,
    extraHead,
    ogImage: imageAbsUrl,
  });
}

// Category pages
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
            </article>
          `
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
  });
}

// Shop overview (root /shop.html)
function renderShopPage() {
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
            </article>
          `
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
            </article>
          `
            )
            .join("")}
        </div>

        <p class="section-footnote" style="margin-top:2rem;">
          Want to see everything in one place? Visit the full Etsy shop:
          <a href="https://www.etsy.com/shop/TheCharmedCardinal" target="_blank" rel="noopener noreferrer">
            The Charmed Cardinal on Etsy
          </a>.
        </p>
      </div>
    </section>
  `;

  return renderLayout({
    title: "Shop | The Charmed Cardinal – Garden Flags & Patterns",
    description:
      "Shop The Charmed Cardinal garden flags and digital seamless patterns inspired by nature, dogs, and cozy porch decor.",
    canonical: url,
    bodyHtml,
  });
}

// --- Build step ----------------------------------------------------------

(async function build() {
  try {
    const outRoot = path.join(__dirname, "..");

    // 1) Product detail pages (with Etsy image scraping)
    for (const product of products) {
      const related = products
        .filter((p) => p.slug !== product.slug && p.type === product.type)
        .slice(0, 3);

      const imageInfo = await ensureProductImage(product); // may be null
      const html = renderProductPage(product, related, imageInfo);

      const outPath = path.join(outRoot, "products", `${product.slug}.html`);
      writeFile(outPath, html);
      console.log("✓ Product page:", outPath);
    }

    // 2) Category pages
    const gardenFlagsPage = renderCategoryPage({
      title: "Garden Flags",
      slug: "garden-flags",
      intro:
        "Decorative garden flags for porches, patios, balconies, and front yards – featuring plants, dogs, kindness, and eco-friendly messages.",
      items: gardenFlags,
    });
    writeFile(path.join(outRoot, "products", "garden-flags.html"), gardenFlagsPage);
    console.log("✓ Category page: products/garden-flags.html");

    const digitalPatternsPage = renderCategoryPage({
      title: "Digital Seamless Patterns",
      slug: "digital-patterns",
      intro:
        "High-resolution seamless patterns for fabric, wrapping paper, print-on-demand products, and digital craft projects.",
      items: digitalPatterns,
    });
    writeFile(
      path.join(outRoot, "products", "digital-patterns.html"),
      digitalPatternsPage
    );
    console.log("✓ Category page: products/digital-patterns.html");

    // 3) Shop overview
    const shopHtml = renderShopPage();
    writeFile(path.join(outRoot, "shop.html"), shopHtml);
    console.log("✓ Shop page: shop.html");

    // 4) Sitemap with all pages
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

    writeFile(path.join(outRoot, "sitemap.xml"), sitemap);
    console.log("✓ Sitemap: sitemap.xml");

    console.log("\n✅ Build complete.");
  } catch (err) {
    console.error("❌ Build failed:", err);
    process.exit(1);
  }
})();
