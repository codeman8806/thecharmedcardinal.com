/**
 * build.js — FINAL: Etsy API + Puppeteer Static Site Generator
 * For: thecharmedcardinal.com
 *
 * Features:
 *  - Uses Etsy's JSON API for listing discovery (zero bot detection)
 *  - Uses Puppeteer ONLY for listing detail pages (og:image, description, etc.)
 *  - Downloads product images
 *  - Generates product pages, shop, categories, sitemap, products.json
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
const ETSY_API_URL =
  "https://www.etsy.com/api/v3/ajax/bespoke/shop/thecharmedcardinal/sections?show_all_listings=true";

const DEFAULT_OG_IMAGE = `${DOMAIN}/assets/og-image.jpg`;
const FALLBACK_PRODUCT_IMAGE_WEB = "/assets/product-placeholder.jpg";

// ---------------------------------------------
// GENERIC HELPERS
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
// FETCH ETSY JSON API (NO PUPPETEER REQUIRED)
// ---------------------------------------------
function fetchEtsyJson() {
  return new Promise((resolve, reject) => {
    https.get(
      ETSY_API_URL,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          Accept: "application/json,text/html",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            // Etsy wraps the JSON in <pre> tags sometimes
            const match = data.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
            const json = match ? match[1] : data;
            resolve(JSON.parse(json));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
  });
}

// ---------------------------------------------
// GET LISTING URLs from Etsy JSON API
// ---------------------------------------------
async function fetchListingUrlsFromShop() {
  console.log("→ Fetching listing list via Etsy API…");

  const json = await fetchEtsyJson();

  const urls = [];

  for (const section of json.sections || []) {
    for (const item of section.listings || []) {
      if (item.url) {
        urls.push(item.url.split("?")[0]);
      }
    }
  }

  const unique = Array.from(new Set(urls));

  console.log(`✓ Found ${unique.length} listings via API`);
  return unique;
}

// ---------------------------------------------
// PUPPETEER SCRAPER FOR LISTING DETAIL PAGE
// ---------------------------------------------
async function launchBrowser() {
  return puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
}

async function preparePage(browser) {
  const page = await browser.newPage();

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
  });

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
  );

  return page;
}

async function fetchHtml(url) {
  const browser = await launchBrowser();
  try {
    const page = await preparePage(browser);

    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    return await page.content();
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------
// META EXTRACTOR
// ---------------------------------------------
function extractMeta(html, propOrName, value) {
  const re = new RegExp(`<meta[^>]+${propOrName}=["']${value}["'][^>]*>`, "i");
  const tag = html.match(re);
  if (!tag) return null;

  const content = tag[0].match(/content=["']([^"']+)["']/i);
  return content ? content[1] : null;
}

// ---------------------------------------------
// SLUGS AND TYPES
// ---------------------------------------------
function slugFromTitleAndId(title, id) {
  const clean = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${clean}-${id}`;
}

function inferType(title, desc) {
  const t = (title + " " + desc).toLowerCase();
  if (t.includes("pattern") || t.includes("seamless")) return "digital-pattern";
  if (t.includes("flag")) return "garden-flag";
  return "garden-flag";
}

// ---------------------------------------------
// FETCH INDIVIDUAL LISTING DATA
// ---------------------------------------------
async function fetchListingData(listingUrl) {
  console.log(`→ Fetching listing details: ${listingUrl}`);

  const html = await fetchHtml(listingUrl);

  const id = (listingUrl.match(/\/listing\/(\d+)/) || [null, ""])[1];

  let title =
    extractMeta(html, "property", "og:title") ||
    extractMeta(html, "name", "title") ||
    "Untitled Listing";

  title = title.replace(/\s+-\s+Etsy$/i, "");

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
    tags: [],
    ogImageUrl,
  };
}

// ---------------------------------------------
// DOWNLOAD PRODUCT IMAGE
// ---------------------------------------------
async function ensureProductImage(product) {
  const dir = path.join(__dirname, "..", "assets", "products");
  fs.mkdirSync(dir, { recursive: true });

  const base = product.slug.replace(/[^a-z0-9\-]/gi, "-");

  // Already exists?
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

  console.log(`→ Downloading product image: ${product.ogImageUrl}`);

  try {
    await new Promise((resolve, reject) => {
      https.get(product.ogImageUrl, (res) => {
        if (res.statusCode !== 200) return reject();

        const f = fs.createWriteStream(dest);
        res.pipe(f);
        f.on("finish", () => resolve());
      });
    });

    return {
      webPath: `/assets/products/${filename}`,
      absUrl: `${DOMAIN}/assets/products/${filename}`,
    };
  } catch {
    console.warn("⚠ Failed to download image.");
    return null;
  }
}

// ---------------------------------------------
// PAGE RENDERING (unchanged from earlier version)
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
  <meta property="og:image" content="${ogImage}" />

  ${extraHead}
</head>
<body>
<header class="site-header">
  <h1 style="text-align:center;">The Charmed Cardinal</h1>
</header>

<main>
${bodyHtml}
</main>

<footer class="site-footer">
  <p style="text-align:center;">&copy; ${new Date().getFullYear()} The Charmed Cardinal</p>
</footer>
</body>
</html>`;
}

function renderProductPage(product, related, img) {
  const url = `${DOMAIN}/products/${product.slug}.html`;
  const imgAbs = img?.absUrl || `${DOMAIN}${FALLBACK_PRODUCT_IMAGE_WEB}`;
  const imgWeb = img?.webPath || FALLBACK_PRODUCT_IMAGE_WEB;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.title,
    description: product.description,
    image: [imgAbs],
    url,
    offers: { "@type": "Offer", url: product.etsy },
  };

  const bodyHtml = `
<section class="section">
  <img src="${imgWeb}" alt="${escapeHtml(product.title)}" style="max-width:300px;margin:auto;display:block;" />
  <h1>${escapeHtml(product.title)}</h1>
  <p>${escapeHtml(product.description)}</p>
  <p>Category: ${product.type}</p>
  <a href="${product.etsy}" target="_blank" class="btn primary">View on Etsy</a>
  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</section>`;

  return renderLayout({
    title: product.title,
    description: product.description,
    canonical: url,
    bodyHtml,
    ogImage: imgAbs,
    extraHead: "",
  });
}

function renderCategoryPage({ title, slug, intro, items }) {
  const bodyHtml = `
<section class="section">
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(intro)}</p>
  ${items
    .map(
      (p) =>
        `<p><a href="/products/${p.slug}.html">${escapeHtml(p.title)}</a></p>`
    )
    .join("")}
</section>`;

  return renderLayout({
    title,
    description: intro,
    canonical: `${DOMAIN}/products/${slug}.html`,
    bodyHtml,
  });
}

function renderShopPage(flags, patterns) {
  const bodyHtml = `
<section class="section">
  <h1>Shop</h1>
  <h2>Garden Flags</h2>
  ${flags
    .map(
      (p) =>
        `<p><a href="/products/${p.slug}.html">${escapeHtml(p.title)}</a></p>`
    )
    .join("")}

  <h2>Seamless Patterns</h2>
  ${patterns
    .map(
      (p) =>
        `<p><a href="/products/${p.slug}.html">${escapeHtml(p.title)}</a></p>`
    )
    .join("")}
</section>`;

  return renderLayout({
    title: "Shop | The Charmed Cardinal",
    description: "Garden flags & seamless patterns",
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

    // 1. Fetch listings from Etsy API
    const listingUrls = await fetchListingUrlsFromShop();
    if (!listingUrls.length) throw new Error("No listings found via API.");

    // 2. Fetch details for each listing
    const products = [];
    for (const url of listingUrls) {
      try {
        const p = await fetchListingData(url);
        products.push(p);
      } catch (err) {
        console.warn("⚠ Error:", err.message);
      }
    }

    if (!products.length) throw new Error("No products scraped.");

    writeFile(
      path.join(outRoot, "data", "products.json"),
      JSON.stringify(products, null, 2)
    );

    console.log(`✓ Saved ${products.length} products.`);

    // 3. Product pages
    for (const p of products) {
      const related = products
        .filter((x) => x.type === p.type && x.slug !== p.slug)
        .slice(0, 3);

      const img = await ensureProductImage(p);

      writeFile(
        path.join(outRoot, "products", `${p.slug}.html`),
        renderProductPage(p, related, img)
      );

      console.log("✓ Product:", p.slug);
    }

    // 4. Category pages
    const flags = products.filter((p) => p.type === "garden-flag");
    const patterns = products.filter((p) => p.type === "digital-pattern");

    writeFile(
      path.join(outRoot, "products", "garden-flags.html"),
      renderCategoryPage({
        title: "Garden Flags",
        slug: "garden-flags",
        intro: "Decorative garden flags for your home.",
        items: flags,
      })
    );

    writeFile(
      path.join(outRoot, "products", "digital-patterns.html"),
      renderCategoryPage({
        title: "Digital Seamless Patterns",
        slug: "digital-patterns",
        intro: "Printable seamless digital patterns.",
        items: patterns,
      })
    );

    console.log("✓ Category pages built.");

    // 5. Shop page
    writeFile(
      path.join(outRoot, "shop.html"),
      renderShopPage(flags, patterns)
    );

    console.log("✓ shop.html created.");

    // 6. Sitemap
    let sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;

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
      sitemap += `<url><loc>${DOMAIN}/${p}</loc></url>\n`;
    });

    products.forEach((p) => {
      sitemap += `<url><loc>${DOMAIN}/products/${p.slug}.html</loc></url>\n`;
    });

    sitemap += `</urlset>`;

    writeFile(path.join(outRoot, "sitemap.xml"), sitemap);
    console.log("✓ Sitemap complete.");

    console.log("\n🎉 Build complete!");
  } catch (err) {
    console.error("❌ Build failed:", err);
    process.exit(1);
  }
})();
