/********************************************************************
 * The Charmed Cardinal — Static Site Builder
 * Source of truth: Etsy RSS + listing pages
 * Output:
 *  - data/products.json
 *  - products/<slug>.html
 *  - products/garden-flags.html
 *  - products/digital-patterns.html
 *  - shop.html
 *  - index.html
 *  - sitemap.xml
 ********************************************************************/

const fs = require("fs");
const path = require("path");
const https = require("https");
const puppeteer = require("puppeteer");
const xml2js = require("xml2js");

// ------------------------------------------------------------
// CONFIG
// ------------------------------------------------------------
const DOMAIN = "https://thecharmedcardinal.com";
const SHOP_URL = "https://www.etsy.com/shop/thecharmedcardinal";
const RSS_URL = `${SHOP_URL}/rss`;

// Use the OG site image as fallback product image too
const DEFAULT_OG_IMAGE = `${DOMAIN}/assets/og-image.jpg`;
const FALLBACK_PRODUCT_IMAGE_WEB = "/assets/og-image.jpg";

// ------------------------------------------------------------
// Generic helpers
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
          return reject(
            new Error(`Image download failed: ${res.statusCode} for ${url}`)
          );
        }

        const fileStream = fs.createWriteStream(destPath);
        res.pipe(fileStream);
        fileStream.on("finish", () => fileStream.close(() => resolve(destPath)));
      })
      .on("error", reject);
  });
}

// Strip HTML + decode basic entities + trim + clamp length
function cleanDescription(html = "") {
  let text = String(html);

  text = text.replace(/<\/?[^>]+>/g, " "); // strip tags
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");

  text = text.replace(/\s+/g, " ").trim();

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
// 1) Fetch listings from Etsy RSS (titles + descriptions)
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
// 3) Ensure product image is downloaded
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
// 4) Rendering helpers
// ------------------------------------------------------------

function renderLayout({
  title,
  description,
  canonical,
  bodyHtml,
  extraHead = "",
  ogImage,
}) {
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
          product.type === "digital-pattern"
            ? "Digital Seamless Pattern"
            : "Garden Flag"
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

function renderCategoryPage({ title, slug, intro, items }) {
  const canonical = `${DOMAIN}/products/${slug}.html`;

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
          <a href="/products/${p.slug}.html">
            <h2>${escapeHtml(p.title)}</h2>
            <p>${escapeHtml(p.description)}</p>
          </a>
        </article>
      `
        )
        .join("")}
    </div>
  </div>
</section>`;

  return renderLayout({
    title: `${title} | The Charmed Cardinal`,
    description: intro,
    canonical,
    bodyHtml,
    ogImage: DEFAULT_OG_IMAGE,
  });
}

function renderShopPage(gardenFlags, digitalPatterns) {
  const canonical = `${DOMAIN}/shop.html`;

  const bodyHtml = `
<section class="section">
  <div class="container">
    ${renderBreadcrumb([{ label: "Home", href: "/" }, { label: "Shop" }])}
    <h1>Shop The Charmed Cardinal</h1>
    <p class="section-intro">
      Browse nature-inspired garden flags and digital seamless patterns. Click any design
      to view details and shop directly on Etsy.
    </p>

    <h2>Garden Flags</h2>
    <div class="card-grid">
      ${gardenFlags
        .map(
          (p) => `
        <article class="card">
          <a href="/products/${p.slug}.html">
            <h3>${escapeHtml(p.title)}</h3>
            <p>${escapeHtml(p.description)}</p>
          </a>
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
          <a href="/products/${p.slug}.html">
            <h3>${escapeHtml(p.title)}</h3>
            <p>${escapeHtml(p.description)}</p>
          </a>
        </article>
      `
        )
        .join("")}
    </div>
  </div>
</section>`;

  return renderLayout({
    title: "Shop | The Charmed Cardinal – Garden Flags & Patterns",
    description:
      "Shop The Charmed Cardinal garden flags and digital seamless patterns inspired by nature, dogs, and cozy porch decor.",
    canonical,
    bodyHtml,
    ogImage: DEFAULT_OG_IMAGE,
  });
}

function renderHomePage(products) {
  // You asked for C: show ALL products on homepage
  const featured = products;

  const heroHtml = `
  <section class="hero">
    <div class="container">
      <h1>Handmade Garden Flags & Seamless Patterns</h1>
      <p class="hero-subtitle">
        Nature-inspired decor and original designs from The Charmed Cardinal Etsy shop.
      </p>
      <div class="hero-buttons">
        <a class="btn primary" href="/products/garden-flags.html">Shop Garden Flags</a>
        <a class="btn secondary" href="/products/digital-patterns.html">Shop Patterns</a>
      </div>
    </div>
  </section>`;

  const featuredHtml = `
  <section class="section">
    <div class="container">
      <h2>Featured Products</h2>
      <div class="card-grid">
        ${featured
          .map(
            (p) => `
          <article class="card">
            <a href="/products/${p.slug}.html">
              <img src="${p.imageWeb ||
                FALLBACK_PRODUCT_IMAGE_WEB}" alt="${escapeHtml(
              p.title
            )}" style="width:100%;border-radius:12px;margin-bottom:0.5rem;">
              <h3>${escapeHtml(p.title)}</h3>
            </a>
          </article>
        `
          )
          .join("")}
      </div>
    </div>
  </section>`;

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
  </section>`;

  const aboutHtml = `
  <section class="section">
    <div class="container">
      <h2>About The Charmed Cardinal</h2>
      <p>
        The Charmed Cardinal is a handmade Etsy shop offering nature-inspired garden flags
        and digital seamless patterns, designed with love and a touch of whimsy.
      </p>
      <p><a class="btn secondary" href="/about.html">Learn more →</a></p>
    </div>
  </section>`;

  const bodyHtml = heroHtml + featuredHtml + categoriesHtml + aboutHtml;

  return renderLayout({
    title: "The Charmed Cardinal | Garden Flags & Patterns",
    description:
      "Handmade garden flags, digital seamless patterns, porch decor, and nature-inspired designs from The Charmed Cardinal Etsy shop.",
    canonical: `${DOMAIN}/`,
    bodyHtml,
    ogImage: DEFAULT_OG_IMAGE,
  });
}

// ------------------------------------------------------------
// MAIN BUILD PIPELINE
// ------------------------------------------------------------

(async function build() {
  try {
    const outRoot = path.join(__dirname, "..");

    // Ensure products directory exists early
    const productsDir = path.join(outRoot, "products");
    fs.mkdirSync(productsDir, { recursive: true });

    console.log("→ Fetching listing list via RSS…");
    const rssListings = await fetchListingsFromRSS();
    if (!rssListings.length) throw new Error("No listings found in RSS!");

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

    // Clean up old "untitled-product-*.html" artifacts if any
    fs.readdirSync(productsDir)
      .filter((f) => f.startsWith("untitled-product-") && f.endsWith(".html"))
      .forEach((f) => fs.unlinkSync(path.join(productsDir, f)));

    // 1) Save products.json
    writeFile(
      path.join(outRoot, "data", "products.json"),
      JSON.stringify(products, null, 2)
    );
    console.log(`✓ Saved ${products.length} products → data/products.json`);

    // 2) Download images + generate product pages
    for (const product of products) {
      const imageInfo = await ensureProductImage(product);
      product.imageWeb = imageInfo?.webPath || FALLBACK_PRODUCT_IMAGE_WEB;

      const html = renderProductPage(product, imageInfo);
      const outPath = path.join(productsDir, `${product.slug}.html`);
      writeFile(outPath, html);
      console.log(`✓ Product page: ${product.slug}.html`);
    }

    // 3) Category pages
    const gardenFlags = products.filter((p) => p.type === "garden-flag");
    const digitalPatterns = products.filter((p) => p.type === "digital-pattern");

    const gardenFlagsHtml = renderCategoryPage({
      title: "Garden Flags",
      slug: "garden-flags",
      intro:
        "Decorative garden flags for porches, patios, balconies, and front yards – featuring plants, dogs, kindness, and eco-friendly messages.",
      items: gardenFlags,
    });
    writeFile(path.join(productsDir, "garden-flags.html"), gardenFlagsHtml);
    console.log("✓ Category page: products/garden-flags.html");

    const digitalPatternsHtml = renderCategoryPage({
      title: "Digital Seamless Patterns",
      slug: "digital-patterns",
      intro:
        "High-resolution seamless patterns for fabric, wrapping paper, print-on-demand products, and digital craft projects.",
      items: digitalPatterns,
    });
    writeFile(
      path.join(productsDir, "digital-patterns.html"),
      digitalPatternsHtml
    );
    console.log("✓ Category page: products/digital-patterns.html");

    // 4) Shop page
    const shopHtml = renderShopPage(gardenFlags, digitalPatterns);
    writeFile(path.join(outRoot, "shop.html"), shopHtml);
    console.log("✓ shop.html created.");

    // 5) Homepage
    console.log("✓ Generating homepage index.html...");
    const homepageHtml = renderHomePage(products);
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
      "products/garden-flags.html",
      "products/digital-patterns.html",
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

    console.log("\n✅ BUILD COMPLETE — full site generated.");
  } catch (err) {
    console.error("❌ Build failed:", err);
    process.exit(1);
  }
})();
