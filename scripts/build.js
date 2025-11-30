// scripts/build.js
// Build static product pages for thecharmedcardinal.com from Etsy RSS.

const fs = require("fs");
const path = require("path");
const https = require("https");
const Parser = require("rss-parser");

const DOMAIN = "https://thecharmedcardinal.com";
const SHOP_URL = "https://www.etsy.com/shop/thecharmedcardinal";
const RSS_URL = `${SHOP_URL}/rss`;

const OUT_ROOT = path.join(__dirname, "..");
const ASSET_PRODUCT_DIR = path.join(OUT_ROOT, "assets", "products");
const DATA_DIR = path.join(OUT_ROOT, "data");

// ----------------- Small helpers -----------------

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeFile(p, contents) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, contents);
}

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Decode a few common HTML entities coming from RSS
function decodeEntities(str = "") {
  return String(str)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function truncate(str = "", max = 140) {
  const s = String(str).trim();
  if (s.length <= max) return s;
  return s.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

// Very simple "guess" for type from title/description
function inferType(title, description) {
  const t = (title + " " + description).toLowerCase();
  if (t.includes("pattern")) return "digital-pattern";
  if (t.includes("seamless")) return "digital-pattern";
  return "garden-flag";
}

function slugFromTitleAndId(title, id) {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base || "product"}-${id}`;
}

function extractPrice(description = "") {
  const m = description.match(/(\d+(?:\.\d{2})?)\s*USD/i);
  if (!m) return null;
  return `${m[1]} USD`;
}

function stripLeadingPrice(description = "") {
  return description.replace(/^\s*\d+(?:\.\d{2})?\s*USD\s*/i, "").trim();
}

// Download binary file (image) to destPath
function downloadBinary(url, destPath) {
  return new Promise((resolve, reject) => {
    ensureDir(path.dirname(destPath));

    https
      .get(url, (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          return resolve(downloadBinary(res.headers.location, destPath));
        }

        if (res.statusCode !== 200) {
          res.resume();
          return reject(
            new Error(`Image download failed: ${res.statusCode} for ${url}`)
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

// ----------------- RSS → product objects -----------------

async function fetchRssItems() {
  const parser = new Parser({
    customFields: {
      item: ["content:encoded", "media:content"],
    },
  });

  console.log(`→ Fetching Etsy RSS: ${RSS_URL}`);
  const feed = await parser.parseURL(RSS_URL);
  console.log(`✓ RSS items found: ${feed.items.length}`);
  return feed.items;
}

function extractImageUrlFromItem(item) {
  // 1) enclosure
  if (item.enclosure && item.enclosure.url) return item.enclosure.url;

  // 2) media:content (rss-parser may map it oddly, so fall back to raw fields)
  const mc = item["media:content"];
  if (mc && mc.$ && mc.$.url) return mc.$.url;

  // 3) look inside encoded HTML for an Etsy static image
  const html = item["content:encoded"] || item.content || "";
  const m = html.match(/https:\/\/i\.etsystatic\.com\/[^"']+\.jpg/i);
  if (m) return m[0];

  return null;
}

function buildProductsFromRss(items) {
  const products = [];

  items.forEach((item, idx) => {
    const link = item.link || "";
    const idMatch = link.match(/\/listing\/(\d+)/);
    const id = idMatch ? idMatch[1] : String(idx + 1);

    const rawTitle = decodeEntities(item.title || "Untitled product");
    const rawDescription = decodeEntities(
      item.contentSnippet || item.content || ""
    );

    const price = extractPrice(rawDescription);
    const descriptionBody = stripLeadingPrice(rawDescription);
    const description =
      descriptionBody ||
      "A handcrafted design from The Charmed Cardinal on Etsy.";

    const type = inferType(rawTitle, description);
    const slug = slugFromTitleAndId(rawTitle, id);
    const imageRemote = extractImageUrlFromItem(item);

    products.push({
      id,
      slug,
      title: rawTitle,
      description,
      price,
      etsy: link || SHOP_URL,
      type,
      tags: [],
      imageRemote,
      imageWebPath: null,
      imageAbsUrl: null,
    });
  });

  console.log(`✓ Parsed products from RSS: ${products.length}`);
  return products;
}

// Download each product's image into assets/products and attach paths
async function hydrateProductImages(products) {
  ensureDir(ASSET_PRODUCT_DIR);

  for (const p of products) {
    if (!p.imageRemote) {
      console.warn(`⚠ No image URL for "${p.title}"`);
      continue;
    }

    // Use JPG; Etsy’s URLs are JPG in practice
    const filename = `${p.slug}.jpg`;
    const destPath = path.join(ASSET_PRODUCT_DIR, filename);

    if (!fs.existsSync(destPath)) {
      console.log(`→ Downloading image for "${p.title}": ${p.imageRemote}`);
      try {
        await downloadBinary(p.imageRemote, destPath);
      } catch (err) {
        console.warn(
          `⚠ Failed to download image for "${p.title}": ${err.message}`
        );
        continue;
      }
    }

    const webPath = `/assets/products/${filename}`;
    p.imageWebPath = webPath;
    p.imageAbsUrl = `${DOMAIN}${webPath}`;
  }
}

// ----------------- Layout + UI helpers -----------------

function renderLayout({ title, description, bodyHtml, canonical }) {
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
  <meta property="og:image" content="${DOMAIN}/assets/og-image.png" />
</head>
<body>
  <header class="site-header">
    <div class="logo-wrap">
      <a href="/" class="logo-link">
        <img src="/assets/favicon.png" alt="The Charmed Cardinal logo" class="logo-img" />
        <span class="logo-text">
          <span class="logo-title">The Charmed Cardinal</span>
          <span class="logo-tagline">Garden Flags &amp; Seamless Patterns</span>
        </span>
      </a>
    </div>
    <nav class="site-nav">
      <a href="/">Home</a>
      <a href="/shop.html">Shop</a>
      <a href="/about.html">About</a>
      <a href="/blog/">Blog</a>
      <a href="/index.html#contact">Contact</a>
    </nav>
  </header>

  <main>
${bodyHtml}
  </main>

  <footer class="site-footer">
    <p>&copy; ${new Date().getFullYear()} The Charmed Cardinal</p>
  </footer>
</body>
</html>`;
}

function renderBreadcrumb(items) {
  return `
  <nav class="breadcrumb" aria-label="Breadcrumb">
    ${items
      .map((item, idx) => {
        if (!item.href || idx === items.length - 1) {
          return `<span>${escapeHtml(item.label)}</span>`;
        }
        return `<a href="${item.href}">${escapeHtml(item.label)}</a> &raquo; `;
      })
      .join("")}
  </nav>`;
}

function renderProductCard(product) {
  const href = `/products/${product.slug}.html`;
  const title = escapeHtml(product.title);
  const desc = escapeHtml(truncate(product.description, 140));
  const priceHtml = product.price
    ? `<div class="card-price">${escapeHtml(product.price)}</div>`
    : "";

  const imgSrc =
    product.imageWebPath || "/assets/og-image.png"; // defensive fallback

  return `
  <article class="card">
    <a href="${href}" class="card-link-wrap">
      <div class="thumb">
        <img src="${imgSrc}" alt="${title}" loading="lazy" />
      </div>
    </a>
    <div class="card-body">
      <h3 class="card-title"><a href="${href}">${title}</a></h3>
      ${priceHtml}
      <p class="card-desc">${desc}</p>
      <a class="card-link" href="${href}">View details →</a>
    </div>
  </article>`;
}

// ----------------- Page renderers -----------------

function renderProductPage(product) {
  const url = `${DOMAIN}/products/${product.slug}.html`;

  const imgSrc =
    product.imageWebPath || "/assets/og-image.png";

  const priceHtml = product.price
    ? `<p class="price">${escapeHtml(product.price)}</p>`
    : "";

  const typeLabel =
    product.type === "digital-pattern" ? "Digital Pattern" : "Garden Flag / Outdoor Decor";

  const bodyHtml = `
  <section>
    ${renderBreadcrumb([
      { label: "Home", href: "/" },
      { label: "Shop", href: "/shop.html" },
      {
        label:
          product.type === "digital-pattern"
            ? "Digital Patterns"
            : "Garden Flags",
        href:
          product.type === "digital-pattern"
            ? "/products/digital-patterns.html"
            : "/products/garden-flags.html",
      },
      { label: product.title },
    ])}
    <div class="product-page">
      <div class="product-image">
        <img src="${imgSrc}" alt="${escapeHtml(product.title)}" />
      </div>
      <div class="product-info">
        <h1>${escapeHtml(product.title)}</h1>
        ${priceHtml}
        <p>${escapeHtml(product.description)}</p>
        <p><strong>Category:</strong> ${escapeHtml(typeLabel)}</p>
        <a href="${product.etsy}" target="_blank" rel="noopener noreferrer" class="etsy-btn">
          View on Etsy →
        </a>
        <p style="margin-top: 10px;">
          <a href="/shop.html">← Back to shop</a>
        </p>
      </div>
    </div>
  </section>`;

  return renderLayout({
    title: `${product.title} | The Charmed Cardinal`,
    description: product.description,
    bodyHtml,
    canonical: url,
  });
}

function renderCategoryPage({ title, slug, intro, items }) {
  const url = `${DOMAIN}/products/${slug}.html`;
  const cardsHtml = items.map(renderProductCard).join("");

  const bodyHtml = `
  <section>
    ${renderBreadcrumb([
      { label: "Home", href: "/" },
      { label: "Shop", href: "/shop.html" },
      { label: title },
    ])}
    <h1>${escapeHtml(title)}</h1>
    <p class="section-intro">${escapeHtml(intro)}</p>
    <div class="card-grid">
      ${cardsHtml}
    </div>
  </section>`;

  return renderLayout({
    title: `${title} | The Charmed Cardinal`,
    description: intro,
    bodyHtml,
    canonical: url,
  });
}

function renderShopPage(gardenFlags, digitalPatterns) {
  const url = `${DOMAIN}/shop.html`;

  const bodyHtml = `
  <section>
    ${renderBreadcrumb([
      { label: "Home", href: "/" },
      { label: "Shop" },
    ])}
    <h1>Shop The Charmed Cardinal</h1>
    <p class="section-intro">
      Browse nature-inspired garden flags and digital seamless patterns. Click any design to view details and shop directly on Etsy.
    </p>

    <h2>Garden Flags</h2>
    <div class="card-grid">
      ${gardenFlags.map(renderProductCard).join("")}
    </div>

    <h2 style="margin-top: 3rem;">Digital Seamless Patterns</h2>
    <div class="card-grid">
      ${digitalPatterns.map(renderProductCard).join("")}
    </div>
  </section>`;

  return renderLayout({
    title: "Shop | The Charmed Cardinal",
    description:
      "Shop garden flags and digital seamless patterns designed by The Charmed Cardinal.",
    bodyHtml,
    canonical: url,
  });
}

function renderHomePage(products) {
  const url = `${DOMAIN}/`;
  const featured = products.slice(0, 6);

  const bodyHtml = `
<section class="hero">
  <div class="hero-inner">
    <img src="/assets/og-image.png" alt="The Charmed Cardinal Featured Artwork">
    <div class="hero-text">
      <h1>Welcome to The Charmed Cardinal</h1>
      <p>Handcrafted garden flags, seamless patterns, and nature-inspired designs.</p>
      <a href="/shop.html" class="hero-btn">Shop Now →</a>
    </div>
  </div>
</section>


    <section class="featured">
      <h2>Featured Products</h2>
      <div class="card-grid">
        ${featured.map(renderProductCard).join("")}
      </div>
      <p class="section-footnote">
        <a href="/shop.html">View all products →</a>
      </p>
  </section>`;

  return renderLayout({
    title: "The Charmed Cardinal – Garden Flags & Seamless Patterns",
    description:
      "Nature-inspired garden flags, porch decor, and digital seamless patterns from The Charmed Cardinal. Shop cozy outdoor designs and printable patterns.",
    bodyHtml,
    canonical: url,
  });
}

function renderBlogIndexPage() {
  const url = `${DOMAIN}/blog/`;

  const bodyHtml = `
  <section>
    ${renderBreadcrumb([
      { label: "Home", href: "/" },
      { label: "Blog" },
    ])}
    <h1>Blog</h1>
    <p class="section-intro">
      Styling ideas, porch inspiration, and tips for decorating with garden flags and patterns.
    </p>
    <ul class="blog-list">
      <li>
        <a href="/blog/style-your-porch-with-garden-flags.html">
          Style Your Porch with Garden Flags
        </a>
      </li>
    </ul>
  </section>`;

  return renderLayout({
    title: "Blog | The Charmed Cardinal",
    description:
      "Styling tips and ideas for decorating your porch with garden flags and seasonal designs.",
    bodyHtml,
    canonical: url,
  });
}

// ----------------- Sitemap -----------------

function buildSitemap(products) {
  const staticPages = [
    "",
    "index.html",
    "about.html",
    "shop.html",
    "blog/",
    "blog/style-your-porch-with-garden-flags.html",
    "products/garden-flags.html",
    "products/digital-patterns.html",
  ];

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
`;

  staticPages.forEach((p) => {
    const loc = p ? `${DOMAIN}/${p}` : `${DOMAIN}/`;
    xml += `  <url><loc>${loc}</loc></url>\n`;
  });

  products.forEach((p) => {
    xml += `  <url><loc>${DOMAIN}/products/${p.slug}.html</loc></url>\n`;
  });

  xml += `</urlset>\n`;
  return xml;
}

// ----------------- MAIN BUILD -----------------

(async function build() {
  try {
    console.log("\n🚀 BUILD START\n");

    ensureDir(DATA_DIR);
    ensureDir(ASSET_PRODUCT_DIR);

    const rssItems = await fetchRssItems();
    const products = buildProductsFromRss(rssItems);

    await hydrateProductImages(products);

    // Sort by title for deterministic order
    products.sort((a, b) => a.title.localeCompare(b.title));

    // Save JSON for debugging
    writeFile(
      path.join(DATA_DIR, "products.json"),
      JSON.stringify(
        products.map((p) => ({
          slug: p.slug,
          title: p.title,
          type: p.type,
          description: p.description,
          price: p.price,
          etsy: p.etsy,
          image: p.imageWebPath,
        })),
        null,
        2
      )
    );
    console.log("✓ Saved data/products.json");

    const gardenFlags = products.filter((p) => p.type === "garden-flag");
    const digitalPatterns = products.filter(
      (p) => p.type === "digital-pattern"
    );

    // Product pages
    products.forEach((p) => {
      const html = renderProductPage(p);
      const outPath = path.join(OUT_ROOT, "products", `${p.slug}.html`);
      writeFile(outPath, html);
      // console.log("✓ Product page:", outPath);
    });

    // Category pages
    const gardenFlagsPage = renderCategoryPage({
      title: "Garden Flags",
      slug: "garden-flags",
      intro:
        "Decorative garden flags for porches, patios, balconies, and front yards – featuring plants, dogs, kindness, and eco-friendly messages.",
      items: gardenFlags,
    });
    writeFile(
      path.join(OUT_ROOT, "products", "garden-flags.html"),
      gardenFlagsPage
    );

    const digitalPatternsPage = renderCategoryPage({
      title: "Digital Seamless Patterns",
      slug: "digital-patterns",
      intro:
        "High-resolution seamless patterns for fabric, wrapping paper, print-on-demand products, and digital craft projects.",
      items: digitalPatterns,
    });
    writeFile(
      path.join(OUT_ROOT, "products", "digital-patterns.html"),
      digitalPatternsPage
    );

    // Shop page
    const shopHtml = renderShopPage(gardenFlags, digitalPatterns);
    writeFile(path.join(OUT_ROOT, "shop.html"), shopHtml);

    // Home page
    const homeHtml = renderHomePage(products);
    writeFile(path.join(OUT_ROOT, "index.html"), homeHtml);

    // Blog index
    const blogHtml = renderBlogIndexPage();
    writeFile(path.join(OUT_ROOT, "blog", "index.html"), blogHtml);

    // Sitemap
    const sitemap = buildSitemap(products);
    writeFile(path.join(OUT_ROOT, "sitemap.xml"), sitemap);
    console.log("✓ Sitemap: sitemap.xml");

    console.log("\n✅ BUILD COMPLETE — images, cards, and pages generated.\n");
  } catch (err) {
    console.error("\n❌ BUILD FAILED:", err);
    process.exit(1);
  }
})();
