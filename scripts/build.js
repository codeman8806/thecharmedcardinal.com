/********************************************************************
 * The Charmed Cardinal — Static Site Builder (RSS + Puppeteer)
 * - Uses Etsy RSS for titles & descriptions
 * - Cleans description (strip HTML, decode entities)
 * - Uses Puppeteer ONLY for og:image
 * - Generates product pages + sitemap
 ********************************************************************/

const fs = require("fs");
const path = require("path");
const https = require("https");
const puppeteer = require("puppeteer");
const xml2js = require("xml2js");

const DOMAIN = "https://thecharmedcardinal.com";
const SHOP_URL = "https://www.etsy.com/shop/thecharmedcardinal";
const RSS_URL = `${SHOP_URL}/rss`;
const DEFAULT_OG_IMAGE = `${DOMAIN}/assets/og-image.jpg`;
const FALLBACK_PRODUCT_IMAGE_WEB = "/assets/product-placeholder.jpg";

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

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
          return reject(new Error(`Image download failed: ${res.statusCode} for ${url}`));
        }

        const fileStream = fs.createWriteStream(destPath);
        res.pipe(fileStream);
        fileStream.on("finish", () => fileStream.close(() => resolve(destPath)));
      })
      .on("error", reject);
  });
}

// Strip HTML tags + decode some basic entities + trim + collapse whitespace
function cleanDescription(html = "") {
  let text = String(html);

  // Strip tags
  text = text.replace(/<\/?[^>]+>/g, " ");

  // Decode common entities
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");

  // Collapse whitespace
  text = text.replace(/\s+/g, " ").trim();

  // Optional: limit length a bit for meta description
  if (text.length > 320) {
    text = text.slice(0, 317).trimEnd() + "...";
  }

  return text;
}

function slugFromTitleAndId(title, id) {
  const base = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base || "product"}-${id}`;
}

function inferType(title, desc) {
  const t = (title + " " + desc).toLowerCase();
  if (t.includes("pattern") || t.includes("seamless")) return "digital-pattern";
  if (t.includes("flag")) return "garden-flag";
  return "garden-flag";
}

// ------------------------------------------------------------
// 1) FETCH LISTINGS FROM RSS WITH TITLES + DESCRIPTIONS
// ------------------------------------------------------------

async function fetchListingsFromRSS() {
  console.log(`→ Fetching Etsy RSS: ${RSS_URL}`);

  return new Promise((resolve, reject) => {
    https.get(RSS_URL, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`RSS fetch failed with status ${res.statusCode}`));
      }

      let xml = "";
      res.on("data", (chunk) => (xml += chunk));
      res.on("end", () => {
        xml2js.parseString(xml, (err, result) => {
          if (err) return reject(err);

          const items = result?.rss?.channel?.[0]?.item || [];
          const listings = items
            .map((item) => {
              const url = item.link?.[0];
              const rawTitle = item.title?.[0] || "";
              const rawDesc = item.description?.[0] || "";
              if (!url) return null;

              const idMatch = url.match(/listing\/(\d+)/);
              const id = idMatch ? idMatch[1] : Date.now().toString();

              const title = rawTitle.trim();
              const description = cleanDescription(rawDesc);
              const type = inferType(title, description);

              return { url, id, title, description, type };
            })
            .filter(Boolean);

          console.log(`✓ Found ${listings.length} listings via RSS`);
          resolve(listings);
        });
      });
    });
  });
}

// ------------------------------------------------------------
// 2) Puppeteer: fetch only og:image for each listing
// ------------------------------------------------------------

async function createBrowser() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  return browser;
}

async function fetchOgImageForListing(listing, browser) {
  console.log(`→ Getting og:image for: ${listing.url}`);

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  try {
    await page.goto(listing.url, { waitUntil: "networkidle2", timeout: 60000 });

    const ogImage = await page.evaluate(() => {
      const tag = document.querySelector('meta[property="og:image"]');
      return tag ? tag.content : null;
    });

    return ogImage || null;
  } catch (err) {
    console.warn(`⚠ Failed to get og:image for ${listing.url}: ${err.message}`);
    return null;
  } finally {
    await page.close();
  }
}

// ------------------------------------------------------------
// Download product image
// ------------------------------------------------------------

async function ensureProductImage(product) {
  const dir = path.join(__dirname, "..", "assets", "products");
  fs.mkdirSync(dir, { recursive: true });

  if (!product.ogImageUrl) return null;

  let ext = "jpg";
  const lower = product.ogImageUrl.toLowerCase();
  if (lower.includes(".png")) ext = "png";
  else if (lower.includes(".jpeg")) ext = "jpeg";
  else if (lower.includes(".webp")) ext = "webp";

  const filename = `${product.slug}.${ext}`;
  const destPath = path.join(dir, filename);

  if (!fileExists(destPath)) {
    console.log(`→ Downloading image: ${product.ogImageUrl}`);
    try {
      await downloadBinary(product.ogImageUrl, destPath);
    } catch (err) {
      console.warn(`⚠ Failed to download image: ${err.message}`);
      return null;
    }
  }

  return {
    webPath: `/assets/products/${filename}`,
    absUrl: `${DOMAIN}/assets/products/${filename}`,
  };
}

// ------------------------------------------------------------
// Rendering helpers
// ------------------------------------------------------------

function renderLayout({ title, description, canonical, bodyHtml, extraHead = "", ogImage }) {
  const safeTitle = escapeHtml(title);
  const safeDesc = escapeHtml(description || "");
  const og = ogImage || DEFAULT_OG_IMAGE;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${safeTitle}</title>
  <meta name="description" content="${safeDesc}">
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="canonical" href="${canonical}" />
  <link rel="stylesheet" href="/styles.css" />
  <link rel="icon" type="image/png" href="/assets/favicon.png" />

  <meta property="og:title" content="${safeTitle}" />
  <meta property="og:description" content="${safeDesc}" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${canonical}" />
  <meta property="og:image" content="${og}" />

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${safeTitle}" />
  <meta name="twitter:description" content="${safeDesc}" />
  <meta name="twitter:image" content="${og}" />

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
    <p style="text-align:center;">&copy; ${new Date().getFullYear()} The Charmed Cardinal</p>
  </footer>
</body>
</html>`;
}

function renderBreadcrumb(items) {
  return `
<nav class="breadcrumbs">
  ${items
    .map((item, i) =>
      item.href && i < items.length - 1
        ? `<a href="${item.href}">${escapeHtml(item.label)}</a> &raquo; `
        : `<span>${escapeHtml(item.label)}</span>`
    )
    .join("")}
</nav>`;
}

function renderProductPage(product, imageInfo) {
  const canonical = `${DOMAIN}/products/${product.slug}.html`;
  const imageAbs = imageInfo?.absUrl || DEFAULT_OG_IMAGE;
  const imageWeb = imageInfo?.webPath || FALLBACK_PRODUCT_IMAGE_WEB;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.title,
    image: [imageAbs],
    description: product.description,
    brand: { "@type": "Brand", name: "The Charmed Cardinal" },
    url: canonical,
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
        <img src="${imageWeb}" alt="${escapeHtml(
    product.title
  )}" style="width:100%;max-width:480px;border-radius:18px;box-shadow:0 10px 25px rgba(15,23,42,0.15);" />
      </div>
      <div>
        <h1>${escapeHtml(product.title)}</h1>
        <p>${escapeHtml(product.description)}</p>
        <p><strong>Category:</strong> ${
          product.type === "digital-pattern" ? "Digital Seamless Pattern" : "Garden Flag"
        }</p>
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
    canonical,
    bodyHtml,
    ogImage: imageAbs,
    extraHead: `<script type="application/ld+json">${JSON.stringify(
      jsonLd
    )}</script>`,
  });
}

// ------------------------------------------------------------
// MAIN BUILD PIPELINE
// ------------------------------------------------------------

(async function build() {
  try {
    const outRoot = path.join(__dirname, "..");

    // 1) RSS listings with titles + descriptions
    console.log("→ Fetching listing list via RSS…");
    const rssListings = await fetchListingsFromRSS();
    if (!rssListings.length) throw new Error("No listings found in RSS!");

    // 2) Puppeteer for og:image only
    const browser = await createBrowser();
    const products = [];

    for (const listing of rssListings) {
      try {
        const ogImageUrl = await fetchOgImageForListing(listing, browser);

        const slug = slugFromTitleAndId(listing.title, listing.id);
        const product = {
          id: listing.id,
          slug,
          title: listing.title || "Untitled Product",
          description:
            listing.description ||
            "A handmade design from The Charmed Cardinal Etsy shop.",
          etsy: listing.url,
          type: listing.type,
          tags: [],
          ogImageUrl,
        };

        products.push(product);
      } catch (err) {
        console.warn(`⚠ Failed listing scrape: ${err.message}`);
      }
    }

    await browser.close();

    if (!products.length) throw new Error("No products built.");

    // 3) Save products.json
    writeFile(
      path.join(outRoot, "data", "products.json"),
      JSON.stringify(products, null, 2)
    );
    console.log(`✓ Saved ${products.length} products → data/products.json`);

    // 4) Download images + generate product pages
    for (const product of products) {
      const imageInfo = await ensureProductImage(product);
      const html = renderProductPage(product, imageInfo);
      const outPath = path.join(outRoot, "products", `${product.slug}.html`);
      writeFile(outPath, html);
      console.log(`✓ Product page: ${product.slug}.html`);
    }
// ------------------------------------------------------------
// 5) Generate Homepage (index.html)
// ------------------------------------------------------------

function renderHomePage(products) {
  const featured = products.slice(0, 6); // first 6 products

  const heroHtml = `
  <section class="hero">
    <div class="container">
      <h1>Handmade Garden Flags & Seamless Patterns</h1>
      <p class="hero-subtitle">Nature-inspired decor, patterns, and handmade designs from The Charmed Cardinal.</p>
      <div class="hero-buttons">
        <a class="btn primary" href="/products/garden-flags.html">Shop Garden Flags</a>
        <a class="btn secondary" href="/products/digital-patterns.html">Shop Patterns</a>
      </div>
    </div>
  </section>
  `;

  const featuredHtml = `
  <section class="section">
    <div class="container">
      <h2>Featured Products</h2>
      <div class="card-grid">
        ${featured
          .map((p) => {
            const img = p.imageWeb || FALLBACK_PRODUCT_IMAGE_WEB;
            return `
            <article class="card">
              <a href="/products/${p.slug}.html">
                <img src="${img}" alt="${escapeHtml(p.title)}" style="width:100%;border-radius:12px;">
                <h3>${escapeHtml(p.title)}</h3>
              </a>
            </article>
            `;
          })
          .join("")}
      </div>
    </div>
  </section>
  `;

  const categoriesHtml = `
  <section class="section section-alt">
    <div class="container">
      <h2>Browse Categories</h2>
      <div class="grid-two">
        <a class="category-card" href="/products/garden-flags.html">
          🌿 Garden Flags
        </a>
        <a class="category-card" href="/products/digital-patterns.html">
          🎨 Digital Patterns
        </a>
      </div>
    </div>
  </section>
  `;

  const aboutHtml = `
  <section class="section">
    <div class="container">
      <h2>About The Charmed Cardinal</h2>
      <p>The Charmed Cardinal is a handmade Etsy shop offering nature-inspired garden flags and digital seamless patterns designed with love and creativity.</p>
      <p><a class="btn secondary" href="/about.html">Learn more →</a></p>
    </div>
  </section>
  `;

  const bodyHtml = heroHtml + featuredHtml + categoriesHtml + aboutHtml;

  return renderLayout({
    title: "The Charmed Cardinal | Garden Flags & Patterns",
    description:
      "Handmade garden flags, digital seamless patterns, porch decor, and nature-inspired designs from The Charmed Cardinal Etsy shop.",
    canonical: `${DOMAIN}/`,
    bodyHtml,
    ogImage: `${DOMAIN}/assets/og-image.jpg`,
  });
}

// After generating product pages, add this section:

console.log("✓ Generating homepage index.html...");
const homepageHtml = renderHomePage(
  products.map((p) => ({
    ...p,
    imageWeb: `/assets/products/${p.slug}.jpg`, // fallback guess, adjusted later
  }))
);
writeFile(path.join(outRoot, "index.html"), homepageHtml);
console.log("✓ Homepage: index.html");

    // 6) Sitemap
    let sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;

    const staticPages = [
      "",
      "about.html",
      "shop.html",
      "blog/",
      "blog/style-your-porch-with-garden-flags.html",
    ];

    staticPages.forEach((p) => {
      sitemap += `  <url><loc>${DOMAIN}/${p}</loc></url>\n`;
    });

    products.forEach((p) => {
      sitemap += `  <url><loc>${DOMAIN}/products/${p.slug}.html</loc></url>\n`;
    });

    sitemap += `</urlset>\n`;
    writeFile(path.join(outRoot, "sitemap.xml"), sitemap);
    console.log("✓ sitemap.xml built.");

    console.log("\n✅ BUILD COMPLETE — titles + descriptions are now from RSS and cleaned.");
  } catch (err) {
    console.error("❌ Build failed:", err);
    process.exit(1);
  }
})();
