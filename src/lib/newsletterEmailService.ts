import nodemailer from "nodemailer";
import pool from "@/lib/db";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import {
  getApprovedArticleMainCategory,
  isSubscriberMatch,
  resolveParentCategory,
} from "./newsletterCategoryService";

export interface ArticleNotificationData {
  id: number;
  title: string;
  slug: string;
  deck?: string;
  card_summary?: string;
  content?: string;
  category: string;
  subcategories?: string[] | string;
  image?: string;
  writer_name?: string;
  created_at?: string | Date;
  status?: string;
  targeted_email_distribution?: string;
  targeted_emails?: string;
}

export interface PreparedEmailResult {
  html: string;
  subject: string;
  attachments: Array<{
    filename: string;
    path?: string;
    content?: Buffer;
    cid: string;
    contentType?: string;
  }>;
}

let isLogsTableEnsured = false;

/**
 * Resolves the public website base URL for direct links.
 * Prefers NEXT_PUBLIC_SITE_URL or SITE_URL from .env.local, then Vercel, then fallback.
 */
export function getSiteBaseUrl(): string {
  const customUrl =
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.SITE_URL;

  if (customUrl && customUrl.trim()) {
    return customUrl.trim().replace(/\/$/, "");
  }

  if (process.env.VERCEL_URL) {
    const vUrl = process.env.VERCEL_URL.trim().replace(/\/$/, "");
    return vUrl.startsWith("http") ? vUrl : `https://${vUrl}`;
  }

  return "https://florida24.vercel.app";
}

/**
 * Ensures the newsletter_email_logs table exists to track delivery and prevent duplicate emails.
 */
export async function ensureNewsletterEmailLogsTable() {
  if (isLogsTableEnsured) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS newsletter_email_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        article_id INT NOT NULL,
        subscriber_email VARCHAR(255) NOT NULL,
        recipient_type ENUM('subscriber', 'targeted') DEFAULT 'subscriber',
        matched_category VARCHAR(100) NOT NULL,
        status ENUM('sent', 'failed', 'skipped', 'simulated') DEFAULT 'sent',
        error_message TEXT NULL,
        sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_article_subscriber (article_id, subscriber_email),
        INDEX idx_article (article_id),
        INDEX idx_email (subscriber_email)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    isLogsTableEnsured = true;
  } catch (err) {
    console.warn("[NewsletterService] Could not ensure newsletter_email_logs table:", err);
  }
}

/**
 * Creates the Nodemailer SMTP transporter.
 * Supports standard SMTP environment variables.
 */
function getSmtpTransporter() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT) || 465;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS || process.env.SMTP_PASSWORD;
  const secure = process.env.SMTP_SECURE === "true" || port === 465;

  if (!host || !user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user,
      pass,
    },
    tls: {
      rejectUnauthorized: process.env.NODE_ENV === "production",
    },
  });
}

/**
 * Formats a date into "MONTH DD, YYYY" uppercase (e.g. "NOVEMBER 16, 2026").
 */
function formatEmailDate(dateInput?: string | Date): string {
  const d = dateInput ? new Date(dateInput) : new Date();
  const dateStr = isNaN(d.getTime()) ? new Date() : d;
  return dateStr
    .toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    })
    .toUpperCase();
}

/**
 * Extracts a clean excerpt from deck, card summary, or content.
 */
function getCleanExcerpt(article: ArticleNotificationData): string {
  if (article.deck && article.deck.trim()) {
    return article.deck.trim();
  }
  if (article.card_summary && article.card_summary.trim()) {
    return article.card_summary.trim();
  }
  if (article.content) {
    const stripped = article.content
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (stripped.length > 180) {
      return stripped.slice(0, 180) + "...";
    }
    return stripped;
  }
  return "Stay informed with the latest reporting and analysis from Florida 24.";
}

/**
 * Prepares the complete email HTML and CID inline attachments.
 * CID embedding ensures 100% reliable image display across Gmail, Apple Mail, Outlook, and Yahoo.
 */
export async function prepareNewsletterEmailContent(
  article: ArticleNotificationData,
  displayCategory: string
): Promise<PreparedEmailResult> {
  const baseUrl = getSiteBaseUrl();
  let domainLabel = "florida-24.com";
  try {
    domainLabel = new URL(baseUrl).hostname;
  } catch {}

  const articleSlug =
    article.slug ||
    article.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");

  const articleUrl = `${baseUrl}/news/${articleSlug}`;
  const preferencesUrl = `${baseUrl}/newsletters`;
  const publishedDate = formatEmailDate(article.created_at);
  const authorName = article.writer_name || "Florida 24 Staff";
  const excerpt = getCleanExcerpt(article);
  const currentYear = new Date().getFullYear();

  const attachments: Array<{
    filename: string;
    path?: string;
    content?: Buffer;
    cid: string;
    contentType?: string;
  }> = [];

  // 1. Prepare Logo Attachment
  let logoCid = "";
  const logoDiskPath = path.join(process.cwd(), "public", "images", "florida24-email-logo.png");
  if (fs.existsSync(logoDiskPath)) {
    logoCid = "florida24-logo";
    attachments.push({
      filename: "florida24-logo.png",
      path: logoDiskPath,
      cid: logoCid,
      contentType: "image/png",
    });
  }

  // 2. Prepare Article Featured Image Attachment
  let articleImageCid = "";
  let resolvedArticleImageSrc = "";

  const rawImage = (article.image || "").trim();

  if (rawImage) {
    if (rawImage.startsWith("http://") || rawImage.startsWith("https://")) {
      // Cloud image URL (e.g. Backblaze B2, S3, or CDN)
      try {
        const fetchRes = await fetch(rawImage);
        if (fetchRes.ok) {
          const rawBuffer = Buffer.from(await fetchRes.arrayBuffer());
          // Optimize and convert to high-compatibility JPEG buffer
          const optimizedBuffer = await sharp(rawBuffer)
            .resize({ width: 600, withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();

          articleImageCid = "article-featured-image";
          attachments.push({
            filename: "article-featured.jpg",
            content: optimizedBuffer,
            cid: articleImageCid,
            contentType: "image/jpeg",
          });
        }
      } catch (cloudErr) {
        console.warn("[NewsletterService] Cloud image fetch failed, fallback to direct URL:", cloudErr);
        resolvedArticleImageSrc = rawImage;
      }
    } else {
      // Local image upload path (e.g. /uploads/articles/... or uploads/...)
      const cleanRelative = rawImage.replace(/^\/+/, "");
      const fullDiskPath = path.join(process.cwd(), "public", cleanRelative);

      if (fs.existsSync(fullDiskPath)) {
        try {
          const optimizedBuffer = await sharp(fullDiskPath)
            .resize({ width: 600, withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();

          articleImageCid = "article-featured-image";
          attachments.push({
            filename: "article-featured.jpg",
            content: optimizedBuffer,
            cid: articleImageCid,
            contentType: "image/jpeg",
          });
        } catch (sharpErr) {
          console.warn("[NewsletterService] Sharp image conversion error:", sharpErr);
          // Attach raw file if conversion failed
          articleImageCid = "article-featured-image";
          attachments.push({
            filename: "article-featured.jpg",
            path: fullDiskPath,
            cid: articleImageCid,
            contentType: "image/jpeg",
          });
        }
      }
    }
  }

  // If no article image was found or attached, use press-banner fallback
  if (!articleImageCid && !resolvedArticleImageSrc) {
    const fallbackPath = path.join(process.cwd(), "public", "images", "press-banner.webp");
    if (fs.existsSync(fallbackPath)) {
      try {
        const bannerBuf = await sharp(fallbackPath)
          .resize({ width: 600, withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer();

        articleImageCid = "article-featured-image";
        attachments.push({
          filename: "press-banner.jpg",
          content: bannerBuf,
          cid: articleImageCid,
          contentType: "image/jpeg",
        });
      } catch (bErr) {
        console.warn("[NewsletterService] Fallback banner conversion error:", bErr);
      }
    }
  }

  const finalLogoHtml = logoCid
    ? `<img src="cid:${logoCid}" alt="Florida 24" width="220" style="width: 220px; max-width: 240px; height: auto; margin: 0 auto; display: block;" />`
    : `<div style="font-family: 'Times New Roman', Times, Georgia, serif; font-size: 28px; font-weight: 900; letter-spacing: 2px; color: #111827; text-transform: uppercase;">FLORIDA <span style="color: #ce1126;">24</span></div>`;

  const finalArticleImageHtml = articleImageCid
    ? `<img src="cid:${articleImageCid}" alt="${article.title}" width="240" style="width: 240px; height: 180px; object-fit: cover; border-radius: 2px; border: 1px solid #e5e7eb; display: block;" />`
    : resolvedArticleImageSrc
    ? `<img src="${resolvedArticleImageSrc}" alt="${article.title}" width="240" style="width: 240px; height: 180px; object-fit: cover; border-radius: 2px; border: 1px solid #e5e7eb; display: block;" />`
    : `<div style="width: 240px; height: 180px; background-color: #111827; color: #ffffff; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 14px; text-align: center; padding: 20px;">FLORIDA 24 NEWS</div>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Breaking News: ${article.title} - Florida 24</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
  <style>
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { -ms-interpolation-mode: bicubic; border: 0; outline: none; text-decoration: none; display: block; }
    body { margin: 0; padding: 0; width: 100% !important; background-color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
    
    @media only screen and (max-width: 600px) {
      .email-container { width: 100% !important; }
      .responsive-column { display: block !important; width: 100% !important; max-width: 100% !important; }
      .image-container img { width: 100% !important; height: auto !important; max-height: 260px !important; }
      .article-meta-cell { padding-left: 0 !important; padding-top: 18px !important; }
      .header-title { font-size: 26px !important; }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #f3f4f6;">
  <center style="width: 100%; background-color: #f3f4f6; padding: 24px 10px;">
    <!-- Container -->
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 640px; background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.04);" class="email-container">
      
      <!-- Top Website Link -->
      <tr>
        <td align="center" style="padding: 16px 20px 4px 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 11px; letter-spacing: 1px; color: #6b7280;">
          <a href="${baseUrl}" target="_blank" style="color: #6b7280; text-decoration: none; font-weight: 500;">${domainLabel}</a>
        </td>
      </tr>

      <!-- Florida 24 Brand Header Logo -->
      <tr>
        <td align="center" style="padding: 10px 20px 14px 20px; border-bottom: 1px solid #f3f4f6;">
          <a href="${baseUrl}" target="_blank" style="text-decoration: none;">
            ${finalLogoHtml}
          </a>
        </td>
      </tr>

      <!-- Published Category & Date -->
      <tr>
        <td align="center" style="padding: 24px 20px 20px 20px;">
          <div style="font-family: 'Times New Roman', Times, Georgia, serif; font-size: 26px; font-weight: 900; letter-spacing: 2px; text-transform: uppercase; color: #111827; margin: 0; line-height: 1.2;" class="header-title">
            ${displayCategory.toUpperCase()}
          </div>
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 11px; font-weight: 600; letter-spacing: 1.5px; text-transform: uppercase; color: #9ca3af; margin-top: 8px;">
            ${publishedDate}
          </div>
        </td>
      </tr>

      <!-- Article Preview Two-Column Body -->
      <tr>
        <td style="padding: 10px 30px 30px 30px;">
          <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
            <tr>
              <!-- Left Column: Featured Image -->
              <td width="240" valign="top" class="responsive-column image-container" style="width: 240px; vertical-align: top;">
                <a href="${articleUrl}" target="_blank" style="text-decoration: none; display: block;">
                  ${finalArticleImageHtml}
                </a>
              </td>

              <!-- Right Column: Heading, Subheading, Author, Read More -->
              <td valign="top" class="responsive-column article-meta-cell" style="vertical-align: top; padding-left: 24px;">
                <!-- Heading -->
                <h2 style="margin: 0 0 10px 0; font-family: 'Times New Roman', Times, Georgia, serif; font-size: 19px; line-height: 1.3; font-weight: 800; color: #111827;">
                  <a href="${articleUrl}" target="_blank" style="color: #111827; text-decoration: none;">
                    ${article.title}
                  </a>
                </h2>

                <!-- Subheading / Excerpt -->
                <p style="margin: 0 0 12px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 13px; line-height: 1.55; color: #4b5563;">
                  ${excerpt}
                </p>

                <!-- Author Byline -->
                <p style="margin: 0 0 16px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 12px; color: #6b7280; font-style: italic;">
                  By ${authorName}
                </p>

                <!-- Read Full Article Link -->
                <div>
                  <a href="${articleUrl}" target="_blank" style="color: #ce1126; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 12px; font-weight: 800; letter-spacing: 0.5px; text-decoration: underline; text-transform: uppercase;">
                    READ FULL ARTICLE &raquo;
                  </a>
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- Footer Section -->
      <tr>
        <td style="padding: 24px 30px; border-top: 1px solid #f3f4f6; background-color: #fafafa; border-radius: 0 0 4px 4px; text-align: center;">
          <p style="margin: 0 0 6px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 11px; color: #9ca3af; line-height: 1.5;">
            &copy; ${currentYear} Florida 24. All Rights Reserved.
          </p>
          <p style="margin: 0 0 6px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 11px; color: #9ca3af; line-height: 1.5;">
            You received this email because you are on the Florida 24 distribution list.
          </p>
          <p style="margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 11px; color: #9ca3af; line-height: 1.5;">
            To manage your notification preferences, <a href="${preferencesUrl}" target="_blank" style="color: #ce1126; text-decoration: underline;">click here</a>.
          </p>
        </td>
      </tr>

    </table>
  </center>
</body>
</html>`;

  return {
    html,
    subject: `Breaking News: ${article.title}`,
    attachments,
  };
}

/**
 * Main trigger function:
 * Resolves subscribers matching the article's category hierarchy + targeted emails,
 * deduplicates recipients, sends the notification email with CID inline images,
 * and writes delivery records to newsletter_email_logs.
 */
export async function sendArticleNewsletterNotification(
  articleId: number | string
): Promise<{
  success: boolean;
  articleId: number;
  totalSubscribersMatched: number;
  totalTargetedMatched: number;
  totalSent: number;
  totalSkipped: number;
  totalFailed: number;
  isSimulated: boolean;
  message: string;
}> {
  await ensureNewsletterEmailLogsTable();

  const numericId = Number(articleId);
  if (!numericId || isNaN(numericId)) {
    return {
      success: false,
      articleId: 0,
      totalSubscribersMatched: 0,
      totalTargetedMatched: 0,
      totalSent: 0,
      totalSkipped: 0,
      totalFailed: 0,
      isSimulated: false,
      message: "Invalid article ID provided.",
    };
  }

  // 1. Fetch the approved article
  const [articleRows]: any = await pool.query(
    "SELECT * FROM articles WHERE id = ?",
    [numericId]
  );

  if (!articleRows || articleRows.length === 0) {
    return {
      success: false,
      articleId: numericId,
      totalSubscribersMatched: 0,
      totalTargetedMatched: 0,
      totalSent: 0,
      totalSkipped: 0,
      totalFailed: 0,
      isSimulated: false,
      message: `Article ID ${numericId} not found in database.`,
    };
  }

  const article: ArticleNotificationData = articleRows[0];

  // 2. IMPORTANT: Do not send if article is not published (draft, pending, rejected, trash)
  if (article.status !== "published") {
    console.log(
      `[NewsletterService] Article ID ${numericId} status is '${article.status}'. Notification skipped (only 'published' articles trigger notifications).`
    );
    return {
      success: true,
      articleId: numericId,
      totalSubscribersMatched: 0,
      totalTargetedMatched: 0,
      totalSent: 0,
      totalSkipped: 0,
      totalFailed: 0,
      isSimulated: false,
      message: `Article status is '${article.status}'. Only 'published' articles trigger emails.`,
    };
  }

  // 3. Resolve the approved article's primary main category
  // If the admin selected a main category, uses it directly.
  // If the admin selected a subcategory, resolves its parent main category.
  const approvedMainCategory = getApprovedArticleMainCategory(article.category);

  console.log(
    `[NewsletterService] Processing Article #${numericId} - Selected Category: "${article.category}", Resolved Main Category: "${approvedMainCategory}"`
  );

  // 4. Retrieve already live-sent emails for this article to guarantee no duplicates
  const [existingLogs]: any = await pool.query(
    "SELECT subscriber_email FROM newsletter_email_logs WHERE article_id = ? AND status = 'sent'",
    [numericId]
  );
  const alreadySentSet = new Set<string>(
    existingLogs.map((row: any) => row.subscriber_email.toLowerCase().trim())
  );

  // 5. Gather matching subscribers from newsletter_subscribers table
  const [subscriberRows]: any = await pool.query(
    "SELECT email, newsletters FROM newsletter_subscribers"
  );

  const recipientsMap = new Map<
    string,
    { type: "subscriber" | "targeted"; matchedCategory: string }
  >();

  let totalSubscribersMatched = 0;
  for (const sub of subscriberRows) {
    if (!sub.email) continue;
    const cleanEmail = sub.email.toLowerCase().trim();
    if (!cleanEmail.includes("@")) continue;

    // STRICT MATCHING: Send notification ONLY to subscribers whose selected categories
    // match the approved article's resolved main category!
    if (isSubscriberMatch(sub.newsletters, approvedMainCategory)) {
      totalSubscribersMatched++;
      recipientsMap.set(cleanEmail, {
        type: "subscriber",
        matchedCategory: approvedMainCategory,
      });
    } else {
      console.log(
        `[NewsletterService] Subscriber ${cleanEmail} (subscribed to: "${sub.newsletters}") does NOT match article category "${approvedMainCategory}". Skipped.`
      );
    }
  }

  // 6. Gather TARGETED EMAIL DISTRIBUTION recipients
  const targetedRaw =
    article.targeted_email_distribution || article.targeted_emails || "";
  let totalTargetedMatched = 0;

  if (targetedRaw && targetedRaw.trim()) {
    const targetedEmailsList = targetedRaw
      .split(/[,;\s]+/)
      .map((e: string) => e.trim().toLowerCase())
      .filter((e: string) => e.length > 3 && e.includes("@"));

    for (const targetedEmail of targetedEmailsList) {
      totalTargetedMatched++;
      if (!recipientsMap.has(targetedEmail)) {
        recipientsMap.set(targetedEmail, {
          type: "targeted",
          matchedCategory: approvedMainCategory,
        });
      }
    }
  }

  console.log(
    `[NewsletterService] Matched ${totalSubscribersMatched} subscribers and ${totalTargetedMatched} targeted recipients for Article #${numericId}. Total unique: ${recipientsMap.size}`
  );

  // 7. Prepare Content and Attachments
  const prepared = await prepareNewsletterEmailContent(article, approvedMainCategory);
  const transporter = getSmtpTransporter();
  const isSimulated = !transporter;
  const fromEmail = process.env.SMTP_FROM || '"Florida 24" <direct@florida24news.com>';

  let totalSent = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  // 8. Process sending to all unique recipients
  for (const [recipientEmail, meta] of recipientsMap.entries()) {
    if (alreadySentSet.has(recipientEmail)) {
      totalSkipped++;
      continue;
    }

    try {
      if (!isSimulated && transporter) {
        await transporter.sendMail({
          from: fromEmail,
          to: recipientEmail,
          subject: prepared.subject,
          html: prepared.html,
          attachments: prepared.attachments,
          replyTo: "direct@florida24news.com",
        });

        await pool.query(
          `INSERT INTO newsletter_email_logs (article_id, subscriber_email, recipient_type, matched_category, status)
           VALUES (?, ?, ?, ?, 'sent')
           ON DUPLICATE KEY UPDATE status = 'sent', error_message = NULL, sent_at = NOW()`,
          [numericId, recipientEmail, meta.type, meta.matchedCategory]
        );
        totalSent++;
      } else {
        await pool.query(
          `INSERT INTO newsletter_email_logs (article_id, subscriber_email, recipient_type, matched_category, status, error_message)
           VALUES (?, ?, ?, ?, 'simulated', 'SMTP not configured in .env.local. Email rendered and logged successfully.')
           ON DUPLICATE KEY UPDATE status = 'simulated', sent_at = NOW()`,
          [numericId, recipientEmail, meta.type, meta.matchedCategory]
        );
        totalSent++;
      }
    } catch (err: any) {
      console.error(
        `[NewsletterService] Error sending email to ${recipientEmail}:`,
        err.message
      );
      totalFailed++;

      try {
        await pool.query(
          `INSERT INTO newsletter_email_logs (article_id, subscriber_email, recipient_type, matched_category, status, error_message)
           VALUES (?, ?, ?, ?, 'failed', ?)
           ON DUPLICATE KEY UPDATE status = 'failed', error_message = ?, sent_at = NOW()`,
          [numericId, recipientEmail, meta.type, meta.matchedCategory, err.message, err.message]
        );
      } catch (logErr) {
        console.error("[NewsletterService] Error recording failed log:", logErr);
      }
    }
  }

  const message = isSimulated
    ? `Completed in simulation mode. ${totalSent} emails simulated & logged, ${totalSkipped} skipped (already sent).`
    : `Completed. ${totalSent} emails sent successfully, ${totalSkipped} skipped (already sent), ${totalFailed} failed.`;

  console.log(`[NewsletterService] Finished Article #${numericId}: ${message}`);

  return {
    success: true,
    articleId: numericId,
    totalSubscribersMatched,
    totalTargetedMatched,
    totalSent,
    totalSkipped,
    totalFailed,
    isSimulated,
    message,
  };
}
