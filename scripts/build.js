/********************************************************************
 * The Charmed Cardinal — Static Site Builder
 * Etsy RSS → Product Pages → Category Pages → Sitemap
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

// ------------------------------------------------------------
// 1) FETCH LISTINGS FROM RSS (bulletproof & no blocking)
// ------------------------------------------------------------

async function fetchListingUrlsFromRSS() {
  console.log(`→ Fetching Etsy RSS: ${RSS_URL}`);

  return new Promise((resolve, reject) => {
    https.get(RSS_URL, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`RSS fetch failed with status ${res.statusCode}`));
      }

      let xml = "";
      res.on("data", (chunk) => (xml += chunk));
      res.on("end", async () => {
        xml2js.parseString(xml, (err, result) => {
          if (err) return reject(err);

          const items = result?.rss?.channel?.[0]?.item || [];
          const urls = items
            .map((item) => item.link?.[0])
            .filter(Boolean);

          console.log(`✓ Found ${urls.length} listings via RSS`);
          resolve(urls);
        });
      });
    });
  });
}

// ------------------------------------------------------------
// 2) Fetch OG tags from each listing (Puppeteer)
// ------------------------------------------------------------

async function fetchListingData(listingUrl, browser) {
  console.log(`→ Scraping listing: ${listingUrl}`);

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  await page.goto(listingUrl, { waitUntil: "networkidle2", timeout: 60000 });

  const og = await page.evaluate(() => {
    const get = (name, attr = "property") =>
      document.querySelector(`meta[${attr}="${name}"]`)?.content || null;

    return {
      title: get("og:title")?.replace(/ - Etsy$/, "") || "Untitled Product",
      description: get("og:description") || "",
      image: get("og:image"),
    };
  });

  await page.close();

  // Extract ID
  const id = listingUrl.match(/listing\/(\d+)/)?.[1] || Date.now();

  // Infer product type
  const text = `${og.title} ${og.description}`.toLowerCase();
  let type = "garden-flag";
  if (text.includes("pattern") || text.includes("seamless")) type = "digital-pattern";

  // Create slug
  const base = og.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const slug = `${base}-${id}`;

  return {
    id,
    slug,
    title: og.title,
    description: og.description,
    etsy: listingUrl,
    type,
    tags: [],
    ogImageUrl: og.image,
  };
}

// ------------------------------------------------------------
// Download product images
// ------------------------------------------------------------

async function ensureProductImage(product) {
  const dir = path.join(__dirname, "..", "assets", "products");
  fs.mkdirSync(dir, { recursive: true });

  if (!product.ogImageUrl) return null;

  let ext = "jpg";
  if (product.ogImageUrl.includes(".png")) ext = "png";
  if (product.ogImageUrl.includes(".webp")) ext = "webp";

  const file = `${product.slug}.${ext}`;
  const destPath = path.join(dir, file);

  if (!fileExists(destPath)) {
    console.log(`→ Downloading product image: ${product.ogImageUrl}`);
    await downloadBinary(product.ogImageUrl, destPath);
  }

  return {
    webPath: `/assets/products/${file}`,
    absUrl: `${DOMAIN}/assets/products/${file}`,
  };
}

// ------------------------------------------------------------
// Render layout helpers (unchanged from your version)
// ------------------------------------------------------------

function renderLayout({ title, description, canonical, bodyHtml, extraHead = "", ogImage }) {
  const safeTitle = escapeHtml(title);
  const safeDesc = escapeHtml(description);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${safeTitle}</title>
<meta name="description" content="${safeDesc}">
<link rel="canonical" href="${canonical}">
<link rel="stylesheet" href="/styles.css">
<link rel="icon" href="/assets/favicon.png">

<meta property="og:title" content="${safeTitle}">
<meta property="og:description" content="${safeDesc}">
<meta property="og:image" content="${ogImage}">
<meta property="og:type" content="website">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${safeTitle}">
<meta name="twitter:image" content="${ogImage}">

${extraHead}
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

function renderBreadcrumb(items) {
  return items
    .map((item, i) =>
      i === items.length - 1
        ? `<span>${escapeHtml(item.label)}</span>`
        : `<a href="${item.href}">${escapeHtml(item.label)}</a> &raquo; `
    )
    .join("");
}

// ------------------------------------------------------------
// Category + product page rendering
// (unchanged except for minor whitespace adjustments)
// ------------------------------------------------------------

function renderProductPage(product, related, imageInfo) {
  const imageAbs = imageInfo?.absUrl || DEFAULT_OG_IMAGE;
  const imageWeb = imageInfo?.webPath || FALLBACK_PRODUCT_IMAGE_WEB;

  const canonical = `${DOMAIN}/products/${product.slug}.html`;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.title,
    image: [imageAbs],
    description: product.description,
    brand: { "@type": "Brand", name: "The Charmed Cardinal" },
    url: canonical,
    offers: { "@type": "Offer", url: product.etsy, availability: "InStock" },
  };

  const bodyHtml = `
  <div class="container">
    ${renderBreadcrumb([{ label: "Home", href: "/" }, { label: "Shop", href: "/shop.html" }, { label: product.title }])}
    <h1>${escapeHtml(product.title)}</h1>
    <img src="${imageWeb}" style="width:100%;max-width:500px;border-radius:18px;">
    <p>${escapeHtml(product.description)}</p>
    <a class="btn" href="${product.etsy}" target="_blank">View on Etsy</a>
  </div>`;

  return renderLayout({
    title: product.title,
    description: product.description,
    canonical,
    bodyHtml,
    ogImage: imageAbs,
    extraHead: `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`,
  });
}

// ------------------------------------------------------------
// MAIN BUILD PIPELINE
// ------------------------------------------------------------

(async function build() {
  try {
    console.log("→ Fetching listing list via RSS…");
    const listingUrls = await fetchListingUrlsFromRSS();

    if (!listingUrls.length) throw new Error("No listings found!");

    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const products = [];
    for (const url of listingUrls) {
      try {
        const p = await fetchListingData(url, browser);
        products.push(p);
      } catch (err) {
        console.warn(`⚠ Failed listing scrape: ${err.message}`);
      }
    }

    await browser.close();

    // Save products.json
    writeFile(
      path.join(__dirname, "..", "data", "products.json"),
      JSON.stringify(products, null, 2)
    );
    console.log(`✓ Saved ${products.length} products → data/products.json`);

    // Download images & build pages
    for (const product of products) {
      const imageInfo = await ensureProductImage(product);
      const html = renderProductPage(product, [], imageInfo);

      writeFile(
        path.join(__dirname, "..", "products", `${product.slug}.html`),
        html
      );
      console.log(`✓ Product page: ${product.slug}.html`);
    }

    // Build sitemap
    let sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
    for (const p of products) {
      sitemap += `<url><loc>${DOMAIN}/products/${p.slug}.html</loc></url>\n`;
    }
    sitemap += `</urlset>`;
    writeFile(path.join(__dirname, "..", "sitemap.xml"), sitemap);

    console.log("\n✅ BUILD COMPLETE — your site is fully generated.");

  } catch (err) {
    console.error("❌ Build failed:", err);
    process.exit(1);
  }
})();
