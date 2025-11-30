/**
 * build.js — Etsy → Static SEO Site Generator
 * Fully patched for:
 *  - Etsy bot filters
 *  - GDPR region wall
 *  - JS-rendered listings
 *  - Image downloading
 *  - Product/category/shop pages
 *  - Sitemap
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const puppeteer = require("puppeteer");

// ---------------------------------------------
// CONFIG
// ---------------------------------------------
const DOMAIN = "https://thecharmedcardinal.com";
const SHOP_URL = "https://www.etsy.com/shop/thecharmedcardinal";
const DEFAULT_OG_IMAGE = `${DOMAIN}/assets/og-image.jpg`;
const FALLBACK_PRODUCT_IMAGE_WEB = "/assets/product-placeholder.jpg";

// ---------------------------------------------
// BASIC HELPERS
// ---------------------------------------------
function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

// ---------------------------------------------
// FETCH HTML (PUPPETEER) WITH SPOOFING & COOKIES
// ---------------------------------------------
async function launchBrowser() {
  return puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  });
}

async function preparePage(browser) {
  const page = await browser.newPage();

  // Anti-bot fingerprint fixes
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
  });

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/120.0.0.0 Safari/537.36"
  );

  // Etsy-required cookies
  await page.setCookie(
    { name: "uaid", value: "1234567890", domain: ".etsy.com" },
    { name: "ua_session_id", value: "abcdef123456", domain: ".etsy.com" },
    { name: "country", value: "US", domain: ".etsy.com" },
    { name: "region", value: "CO", domain: ".etsy.com" },
    { name: "currency", value: "USD", domain: ".etsy.com" },
    { name: "is_gdpr_country", value: "0", domain: ".etsy.com" },
    { name: "user_prefs", value: "cNYAAAE", domain: ".etsy.com" }
  );

  return page;
}

async function fetchHtml(url) {
  const browser = await launchBrowser();
  try {
    const page = await preparePage(browser);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    return await page.content();
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------
// DOWNLOAD BINARY FILE (IMAGE)
// ---------------------------------------------
function downloadBinary(url, destPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(downloadBinary(res.headers.location, destPath));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Image download failed (${res.statusCode}) for ${url}`));
        }

        const fileStream = fs.createWriteStream(destPath);
        res.pipe(fileStream);
        fileStream.on("finish", () => fileStream.close(() => resolve(destPath)));
      })
      .on("error", reject);
  });
}

// ---------------------------------------------
// META TAG EXTRACTION
// ---------------------------------------------
function extractMeta(html, propOrName, value) {
  const re = new RegExp(`<meta[^>]+${propOrName}=["']${value}["'][^>]*>`, "i");
  const tag = html.match(re);
  if (!tag) return null;

  const match = tag[0].match(/content=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

// ---------------------------------------------
// SLUG & TYPE
// ---------------------------------------------
function slugFromTitleAndId(title, id) {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base}-${id}`;
}

function inferType(title, desc) {
  const t = (title + " " + desc).toLowerCase();
  if (t.includes("pattern") || t.includes("seamless")) return "digital-pattern";
  if (t.includes("flag")) return "garden-flag";
  return "garden-flag";
}

// ---------------------------------------------
// SCRAPE LISTING URLS (DOM-RENDERED, WORKING VERSION)
// ---------------------------------------------
async function fetchListingUrlsFromShop(maxPages = 5) {
  const listingMap = new Map();

  const browser = await launchBrowser();
  const page = await preparePage(browser);

  for (let p = 1; p <= maxPages; p++) {
    const url = p === 1 ? SHOP_URL : `${SHOP_URL}?page=${p}`;

    console.log(`→ Fetching shop page (rendered DOM): ${url}`);

    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    const urls = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href*="/listing/"]'));
      return anchors.map((a) => a.href.split("?")[0]);
    });

    console.log(`  • Found ${urls.length} listings on page ${p}`);

    urls.forEach((u) => {
      const m = u.match(/\/listing\/(\d+)/);
      if (m) listingMap.set(m[1], u);
    });

    if (urls.length === 0) break;
  }

  await browser.close();

  const final = Array.from(listingMap.values());
  console.log(`✓ Total unique listings: ${final.length}`);

  return final;
}

// ---------------------------------------------
// SCRAPE INDIVIDUAL LISTING PAGE
// ---------------------------------------------
async function fetchListingData(listingUrl) {
  console.log(`→ Fetching listing: ${listingUrl}`);

  const html = await fetchHtml(listingUrl);

  const id = (listingUrl.match(/\/listing\/(\d+)/) || [null, ""])[1];

  let title =
    extractMeta(html, "property", "og:title") ||
    extractMeta(html, "name", "title") ||
    "Untitled listing";

  title = title.replace(/\s+-\s+Etsy\s*$/i, "");

  let description =
    extractMeta(html, "property", "og:description") ||
    extractMeta(html, "name", "description") ||
    "";

  description = description.replace(/(?:\s*-\s*Etsy.*)$/i, "").trim();

  const ogImageUrl = extractMeta(html, "property", "og:image");

  return {
    id,
    slug: slugFromTitleAndId(title, id),
    title,
    description,
    etsy: listingUrl,
    type: inferType(title, description),
    ogImageUrl,
    tags: [],
  };
}

// ---------------------------------------------
// IMAGE DOWNLOADER
// ---------------------------------------------
async function ensureProductImage(product) {
  const dir = path.join(__dirname, "..", "assets", "products");
  fs.mkdirSync(dir, { recursive: true });

  const base = product.slug.replace(/[^a-z0-9\-]/gi, "-");

  for (const ext of ["jpg", "jpeg", "png", "webp"]) {
    const local = path.join(dir, `${base}.${ext}`);
    if (fileExists(local)) {
      return {
        webPath: `/assets/products/${base}.${ext}`,
        absUrl: `${DOMAIN}/assets/products/${base}.${ext}`,
      };
    }
  }

  if (!product.ogImageUrl) return null;

  let ext = "jpg";
  const lower = product.ogImageUrl.toLowerCase();
  if (lower.includes(".png")) ext = "png";
  else if (lower.includes(".jpeg")) ext = "jpeg";
  else if (lower.includes(".webp")) ext = "webp";

  const filename = `${base}.${ext}`;
  const dest = path.join(dir, filename);

  console.log(`→ Downloading image: ${product.ogImageUrl}`);

  try {
    await downloadBinary(product.ogImageUrl, dest);
    return {
      webPath: `/assets/products/${filename}`,
      absUrl: `${DOMAIN}/assets/products/${filename}`,
    };
  } catch (err) {
    console.warn(`⚠ Failed to download image: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------
// LAYOUT / PAGES (unchanged)
// ---------------------------------------------
function renderLayout({ title, description, canonical, bodyHtml, extraHead = "", ogImage = DEFAULT_OG_IMAGE }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="canonical" href="${canonical}" />
  <link rel="stylesheet" href="/styles.css" />
  <link rel="icon" type="image/png" href="/assets/favicon.png" />

  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:url" content="${canonical}" />
  <meta property="og:image" content="${ogImage}" />

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
    </nav>
  </div>
</header>

<main>
${bodyHtml}
</main>

<footer class="site-footer">
  <p style="text-align:center;">&copy; ${new Date().getFullYear()} The Charmed Cardinal.</p>
</footer>
</body>
</html>`;
}

function renderBreadcrumb(items) {
  return `
<nav class="breadcrumbs">
  ${items
    .map((i, idx) =>
      i.href && idx < items.length - 1
        ? `<a href="${i.href}">${escapeHtml(i.label)}</a> &raquo; `
        : `<span>${escapeHtml(i.label)}</span>`
    )
    .join("")}
</nav>`;
}

function renderProductPage(product, related, imageInfo) {
  const url = `${DOMAIN}/products/${product.slug}.html`;

  const imgAbs = imageInfo?.absUrl || `${DOMAIN}${FALLBACK_PRODUCT_IMAGE_WEB}`;
  const imgWeb = imageInfo?.webPath || FALLBACK_PRODUCT_IMAGE_WEB;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.title,
    description: product.description,
    image: [imgAbs],
    url,
    brand: { "@type": "Brand", name: "The Charmed Cardinal" },
    offers: {
      "@type": "Offer",
      url: product.etsy,
      availability: "https://schema.org/InStock",
    },
  };

  const bodyHtml = `
<section class="section">
  <div class="container">
    ${renderBreadcrumb([
      { label: "Home", href: "/" },
      { label: "Shop", href: "/shop.html" },
      { label: product.title },
    ])}

    <div class="grid-two">
      <div>
        <img src="${imgWeb}" alt="${escapeHtml(product.title)}" class="product-hero"/>
      </div>
      <div>
        <h1>${escapeHtml(product.title)}</h1>
        <p>${escapeHtml(product.description)}</p>
        <p><strong>Category:</strong> ${product.type}</p>
        <a href="${product.etsy}" class="btn primary" target="_blank">View on Etsy</a>
        <a href="/shop.html" class="btn">Back to Shop</a>
      </div>
    </div>
  </div>
</section>
`;

  return renderLayout({
    title: product.title,
    description: product.description,
    canonical: url,
    bodyHtml,
    ogImage: imgAbs,
    extraHead: `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`,
  });
}

function renderCategoryPage({ title, slug, intro, items }) {
  const url = `${DOMAIN}/products/${slug}.html`;

  const bodyHtml = `
<section class="section">
  <div class="container">
    ${renderBreadcrumb([{ label: "Home", href: "/" }, { label: "Shop", href: "/shop.html" }, { label: title }])}
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(intro)}</p>

    <div class="card-grid">
      ${items
        .map(
          (p) => `
      <article class="card">
        <h2><a href="/products/${p.slug}.html">${escapeHtml(p.title)}</a></h2>
        <p>${escapeHtml(p.description)}</p>
      </article>`
        )
        .join("")}
    </div>
  </div>
</section>
`;

  return renderLayout({
    title,
    description: intro,
    canonical: url,
    bodyHtml,
  });
}

function renderShopPage(flags, patterns) {
  const bodyHtml = `
<section class="section">
  <div class="container">
    ${renderBreadcrumb([{ label: "Home", href: "/" }, { label: "Shop" }])}
    <h1>Shop The Charmed Cardinal</h1>

    <h2>Garden Flags</h2>
    <div class="card-grid">
      ${flags
        .map(
          (p) => `
      <article class="card">
        <h3><a href="/products/${p.slug}.html">${escapeHtml(p.title)}</a></h3>
        <p>${escapeHtml(p.description)}</p>
      </article>`
        )
        .join("")}
    </div>

    <h2 style="margin-top:2rem;">Digital Seamless Patterns</h2>
    <div class="card-grid">
      ${patterns
        .map(
          (p) => `
      <article class="card">
        <h3><a href="/products/${p.slug}.html">${escapeHtml(p.title)}</a></h3>
        <p>${escapeHtml(p.description)}</p>
      </article>`
        )
        .join("")}
    </div>
  </div>
</section>
`;

  return renderLayout({
    title: "Shop The Charmed Cardinal",
    description: "Garden flags & seamless patterns.",
    canonical: `${DOMAIN}/shop.html`,
    bodyHtml,
  });
}

// ---------------------------------------------
// MAIN BUILD PIPELINE
// ---------------------------------------------
(async function build() {
  try {
    const outRoot = path.join(__dirname, "..");

    // 1. Fetch listing URLs
    const listingUrls = await fetchListingUrlsFromShop();
    if (!listingUrls.length) throw new Error("No listings found.");

    // 2. Fetch listing details
    const products = [];
    for (const url of listingUrls) {
      try {
        const p = await fetchListingData(url);
        products.push(p);
      } catch (err) {
        console.warn(`⚠ Skipping listing due to error: ${err.message}`);
      }
    }

    if (!products.length) throw new Error("No products scraped.");

    // 3. Save products.json
    writeFile(
      path.join(outRoot, "data", "products.json"),
      JSON.stringify(products, null, 2)
    );

    console.log(`✓ Saved ${products.length} products → data/products.json`);

    // 4. Product pages
    for (const p of products) {
      const related = products
        .filter((x) => x.type === p.type && x.slug !== p.slug)
        .slice(0, 3);

      const img = await ensureProductImage(p);
      const html = renderProductPage(p, related, img);
      const out = path.join(outRoot, "products", `${p.slug}.html`);

      writeFile(out, html);
      console.log("✓ Product page:", p.slug);
    }

    // 5. Category pages
    const flags = products.filter((p) => p.type === "garden-flag");
    const patterns = products.filter((p) => p.type === "digital-pattern");

    writeFile(
      path.join(outRoot, "products", "garden-flags.html"),
      renderCategoryPage({
        title: "Garden Flags",
        slug: "garden-flags",
        intro: "Decorative garden flags inspired by nature, kindness, and cozy decor.",
        items: flags,
      })
    );

    writeFile(
      path.join(outRoot, "products", "digital-patterns.html"),
      renderCategoryPage({
        title: "Digital Seamless Patterns",
        slug: "digital-patterns",
        intro: "High-resolution seamless patterns for crafting and print-on-demand.",
        items: patterns,
      })
    );

    console.log("✓ Category pages built.");

    // 6. Shop page
    writeFile(path.join(outRoot, "shop.html"), renderShopPage(flags, patterns));
    console.log("✓ shop.html built.");

    // 7. Sitemap
    let sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;

    const staticPages = [
      "",
      "about.html",
      "shop.html",
      "blog/",
      "blog/style-your-porch-with-garden-flags.html",
      "products/garden-flags.html",
      "products/digital-patterns.html",
    ];

    staticPages.forEach((p) => {
      sitemap += `  <url><loc>${DOMAIN}/${p}</loc></url>\n`;
    });

    products.forEach((p) => {
      sitemap += `  <url><loc>${DOMAIN}/products/${p.slug}.html</loc></url>\n`;
    });

    sitemap += `</urlset>`;
    writeFile(path.join(outRoot, "sitemap.xml"), sitemap);
    console.log("✓ sitemap.xml built.");

    console.log("\n🎉 BUILD COMPLETE — site is fully generated!");
  } catch (err) {
    console.error("❌ Build failed:", err);
    process.exit(1);
  }
})();
