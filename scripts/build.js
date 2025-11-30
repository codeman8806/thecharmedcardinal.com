/**
 * THE CHARMED CARDINAL — FULL SEO STATIC SITE GENERATOR
 * Etsy → RSS → Listing JSON-LD → Product Pages + Category Pages + Homepage
 *
 * RELIABLE + FUTURE-PROOF VERSION (NO PUPPETEER)
 * ---------------------------------------------------
 * Scrapes:
 *   - Title
 *   - Description
 *   - IMAGE (FULL RESOLUTION)
 *
 * Outputs:
 *   /data/products.json
 *   /products/*.html
 *   /products/garden-flags.html
 *   /products/digital-patterns.html
 *   /shop.html
 *   /index.html
 *   /sitemap.xml
 */

const fs = require("fs");
const path = require("path");
const fetch = (...args) => import("node-fetch").then(({default: fetch}) => fetch(...args));
const xml2js = require("xml2js");

const DOMAIN = "https://thecharmedcardinal.com";
const SHOP_URL = "https://www.etsy.com/shop/thecharmedcardinal";
const RSS_URL = `${SHOP_URL}/rss`;

const PRODUCT_IMG_DIR = path.join(__dirname, "..", "assets", "products");
fs.mkdirSync(PRODUCT_IMG_DIR, { recursive: true });

/* ----------------------------------------------------------
   HELPERS
----------------------------------------------------------- */

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

async function downloadImage(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download image ${url}`);

  const buffer = await res.buffer();
  fs.writeFileSync(destPath, buffer);
  return destPath;
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`Failed HTML fetch: ${url}`);
  return res.text();
}

/* ----------------------------------------------------------
   PARSE ETSY JSON-LD (THE GOOD STUFF)
----------------------------------------------------------- */

function parseJsonLD(html) {
  const match = html.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/
  );
  if (!match) return null;

  try {
    const data = JSON.parse(match[1]);

    // Some listings wrap JSON-LD inside an array
    if (Array.isArray(data)) {
      return data.find((x) => x["@type"] === "Product") || data[0];
    }

    return data;
  } catch (err) {
    return null;
  }
}

async function scrapeListing(listingUrl) {
  console.log("→ Scraping listing:", listingUrl);
  const html = await fetchHtml(listingUrl);

  const jsonld = parseJsonLD(html);
  if (!jsonld) throw new Error("JSON-LD not found");

  const idMatch = listingUrl.match(/listing\/(\d+)/);
  const id = idMatch ? idMatch[1] : Date.now().toString();

  const title = jsonld.name || "Untitled Product";
  const description =
    jsonld.description || "Handmade item from The Charmed Cardinal.";

  // Etsy image array always full-res
  let image = null;
  if (Array.isArray(jsonld.image) && jsonld.image.length > 0) {
    image = jsonld.image[0];
  } else if (typeof jsonld.image === "string") {
    image = jsonld.image;
  }

  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") + `-${id}`;

  // classify items
  const txt = (title + " " + description).toLowerCase();
  const type = txt.includes("pattern") ? "digital-pattern" : "garden-flag";

  return { id, slug, title, description, image, type, etsy: listingUrl };
}

/* ----------------------------------------------------------
   FETCH RSS → LISTINGS
----------------------------------------------------------- */

async function fetchListingUrls() {
  console.log("→ Fetching Etsy RSS:", RSS_URL);

  const xml = await fetch(RSS_URL).then((r) => r.text());
  const rss = await xml2js.parseStringPromise(xml);

  const items = rss?.rss?.channel?.[0]?.item || [];
  const urls = items.map((i) => i.link[0]);

  console.log(`✓ RSS listings found: ${urls.length}`);
  return urls;
}

/* ----------------------------------------------------------
   RENDER HTML PAGES
----------------------------------------------------------- */

function layout({ title, description, canonical, body, ogImage }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}" />
<link rel="canonical" href="${canonical}" />
<meta name="viewport" content="width=device-width, initial-scale=1" />

<link rel="stylesheet" href="/styles.css" />
<link rel="icon" type="image/png" href="/assets/favicon.png" />

<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:image" content="${ogImage}" />
<meta property="og:url" content="${canonical}" />
<meta name="twitter:card" content="summary_large_image" />

</head>
<body>
<header class="site-header">
  <div class="container header-inner">
    <a href="/" class="brand">
      <span class="brand-mark">🕊️</span>
      <span class="brand-text">The Charmed Cardinal</span>
    </a>
    <nav class="main-nav">
      <a href="/">Home</a>
      <a href="/shop.html">Shop</a>
      <a href="/about.html">About</a>
      <a href="/blog/">Blog</a>
    </nav>
  </div>
</header>

<main>${body}</main>

<footer class="site-footer">
  <div class="container footer-inner">
    <p>© ${new Date().getFullYear()} The Charmed Cardinal</p>
  </div>
</footer>
</body>
</html>`;
}

function productCard(p) {
  const img = `/assets/products/${p.slug}.jpg`;
  return `
<article class="card">
  <a href="/products/${p.slug}.html">
    <img class="card-thumb" src="${img}" alt="${escapeHtml(p.title)}" />
    <h3>${escapeHtml(p.title)}</h3>
  </a>
  <p>${escapeHtml(p.description.slice(0, 90))}...</p>
</article>`;
}

/* ----------------------------------------------------------
   BUILD
----------------------------------------------------------- */

(async function build() {
  try {
    console.log("\n🚀 BUILD START\n");

    const urls = await fetchListingUrls();
    if (!urls.length) throw new Error("No listings in RSS");

    const products = [];

    for (const url of urls) {
      const p = await scrapeListing(url);

      // download full-resolution image
      if (p.image) {
        const imgPath = path.join(PRODUCT_IMG_DIR, `${p.slug}.jpg`);
        console.log("→ Downloading full-res image");
        await downloadImage(p.image, imgPath);
      }

      products.push(p);
    }

    writeFile(
      path.join(__dirname, "..", "data", "products.json"),
      JSON.stringify(products, null, 2)
    );

    /* -----------------------
       PRODUCT PAGES
    ------------------------*/
    for (const p of products) {
      const html = layout({
        title: `${p.title} | The Charmed Cardinal`,
        description: p.description,
        canonical: `${DOMAIN}/products/${p.slug}.html`,
        ogImage: `${DOMAIN}/assets/products/${p.slug}.jpg`,
        body: `
<section class="section">
  <div class="container">
    <img class="product-hero" src="/assets/products/${p.slug}.jpg" alt="${escapeHtml(
          p.title
        )}" />
    <h1>${escapeHtml(p.title)}</h1>
    <p>${escapeHtml(p.description)}</p>
    <a class="btn primary" href="${p.etsy}" target="_blank">View on Etsy</a>
  </div>
</section>`,
      });

      writeFile(
        path.join(__dirname, "..", "products", `${p.slug}.html`),
        html
      );
    }

    /* -----------------------
       CATEGORY PAGES
    ------------------------*/
    const flags = products.filter((p) => p.type === "garden-flag");
    const patterns = products.filter((p) => p.type === "digital-pattern");

    writeFile(
      path.join(__dirname, "..", "products", "garden-flags.html"),
      layout({
        title: "Garden Flags | The Charmed Cardinal",
        description: "Decorative handmade garden flags.",
        canonical: `${DOMAIN}/products/garden-flags.html`,
        ogImage: `${DOMAIN}/assets/og-image.png`,
        body: `<section class="section"><div class="container">
<h1>Garden Flags</h1>
<div class="card-grid">${flags.map(productCard).join("")}</div>
</div></section>`,
      })
    );

    writeFile(
      path.join(__dirname, "..", "products", "digital-patterns.html"),
      layout({
        title: "Digital Patterns | The Charmed Cardinal",
        description: "High-resolution seamless patterns.",
        canonical: `${DOMAIN}/products/digital-patterns.html`,
        ogImage: `${DOMAIN}/assets/og-image.png`,
        body: `<section class="section"><div class="container">
<h1>Digital Patterns</h1>
<div class="card-grid">${patterns.map(productCard).join("")}</div>
</div></section>`,
      })
    );

    /* -----------------------
       SHOP PAGE
    ------------------------*/
    writeFile(
      path.join(__dirname, "..", "shop.html"),
      layout({
        title: "Shop | The Charmed Cardinal",
        description: "Browse garden flags and seamless patterns.",
        canonical: `${DOMAIN}/shop.html`,
        ogImage: `${DOMAIN}/assets/og-image.png`,
        body: `
<section class="section"><div class="container">
<h1>Shop The Charmed Cardinal</h1>
<h2>Garden Flags</h2>
<div class="card-grid">${flags.map(productCard).join("")}</div>
<h2 style="margin-top:3rem;">Digital Patterns</h2>
<div class="card-grid">${patterns.map(productCard).join("")}</div>
</div></section>`,
      })
    );

    /* -----------------------
       HOMEPAGE
    ------------------------*/
    writeFile(
      path.join(__dirname, "..", "index.html"),
      layout({
        title: "The Charmed Cardinal | Garden Flags & Patterns",
        description:
          "Nature-inspired garden flags and seamless patterns handmade by The Charmed Cardinal.",
        canonical: `${DOMAIN}/`,
        ogImage: `${DOMAIN}/assets/og-image.png`,
        body: `
<section class="section hero">
 <div class="container">
  <h1>Garden Flags & Seamless Patterns</h1>
  <p>Handmade seasonal decor, porch flags, and digital craft patterns.</p>
  <a class="btn primary" href="/shop.html">Shop Now</a>
 </div>
</section>

<section class="section">
 <div class="container">
  <h2>Featured Products</h2>
  <div class="card-grid">
   ${products.map(productCard).join("")}
  </div>
 </div>
</section>
`,
      })
    );

    /* -----------------------
       SITEMAP
    ------------------------*/
    const sitemap =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      [`${DOMAIN}/`,
       `${DOMAIN}/shop.html`,
       `${DOMAIN}/products/garden-flags.html`,
       `${DOMAIN}/products/digital-patterns.html`,
       ...products.map(
         (p) => `${DOMAIN}/products/${p.slug}.html`
       )]
        .map((loc) => ` <url><loc>${loc}</loc></url>`)
        .join("\n") +
      `\n</urlset>`;

    writeFile(path.join(__dirname, "..", "sitemap.xml"), sitemap);

    console.log("\n✅ BUILD COMPLETE — Full images + JSON-LD + homepage + categories done.\n");
  } catch (err) {
    console.error("\n❌ BUILD FAILED:", err);
  }
})();
