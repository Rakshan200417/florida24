import { NextResponse } from "next/server";
import pool from "@/lib/db";
import {
  sendArticleNewsletterNotification,
  ensureNewsletterEmailLogsTable,
  prepareNewsletterEmailContent,
} from "@/lib/newsletterEmailService";
import { resolveParentCategory } from "@/lib/newsletterCategoryService";
import nodemailer from "nodemailer";
import { getAuthUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET /api/newsletter/notify?articleId=... or limit=50
// Returns email notification delivery logs
export async function GET(request: Request) {
  try {
    await ensureNewsletterEmailLogsTable();
    const { searchParams } = new URL(request.url);
    const articleId = searchParams.get("articleId");
    const limit = Math.min(Number(searchParams.get("limit")) || 50, 200);

    let query = `
      SELECT 
        l.*,
        a.title AS article_title,
        a.category AS article_category,
        a.slug AS article_slug
      FROM newsletter_email_logs l
      LEFT JOIN articles a ON l.article_id = a.id
    `;
    const params: any[] = [];

    if (articleId) {
      query += " WHERE l.article_id = ?";
      params.push(Number(articleId));
    }

    query += " ORDER BY l.sent_at DESC LIMIT ?";
    params.push(limit);

    const [rows]: any = await pool.query(query, params);

    return NextResponse.json({ logs: rows });
  } catch (err: any) {
    console.error("[GET /api/newsletter/notify Error]:", err);
    return NextResponse.json(
      { error: "Failed to fetch notification logs", details: err.message },
      { status: 500 }
    );
  }
}

// POST /api/newsletter/notify
// Body: { articleId: number, testEmail?: string }
export async function POST(request: Request) {
  try {
    const sessionUser = getAuthUser(request);
    if (sessionUser && sessionUser.role !== 'admin') {
      return NextResponse.json({ error: 'Unauthorized: Admin role required to broadcast emails' }, { status: 403 });
    }

    await ensureNewsletterEmailLogsTable();
    const body = await request.json();
    const { articleId, testEmail } = body;

    if (!articleId) {
      return NextResponse.json(
        { error: "articleId is required" },
        { status: 400 }
      );
    }

    // If testEmail is provided, send a single test email directly to that recipient
    if (testEmail && typeof testEmail === "string" && testEmail.includes("@")) {
      const [articleRows]: any = await pool.query(
        "SELECT * FROM articles WHERE id = ?",
        [Number(articleId)]
      );

      if (!articleRows || articleRows.length === 0) {
        return NextResponse.json(
          { error: "Article not found" },
          { status: 404 }
        );
      }

      const article = articleRows[0];
      const primaryDisplayCategory = resolveParentCategory(article.category);
      const prepared = await prepareNewsletterEmailContent(article, primaryDisplayCategory);

      const host = process.env.SMTP_HOST;
      const port = Number(process.env.SMTP_PORT) || 465;
      const user = process.env.SMTP_USER;
      const pass = process.env.SMTP_PASS || process.env.SMTP_PASSWORD;
      const secure = process.env.SMTP_SECURE === "true" || port === 465;

      if (host && user && pass) {
        const transporter = nodemailer.createTransport({
          host,
          port,
          secure,
          auth: { user, pass },
          tls: { rejectUnauthorized: process.env.NODE_ENV === "production" },
        });

        await transporter.sendMail({
          from: process.env.SMTP_FROM || '"Florida 24" <direct@florida24news.com>',
          to: testEmail.trim(),
          subject: `[Test] ${prepared.subject}`,
          html: prepared.html,
          attachments: prepared.attachments,
          replyTo: "direct@florida24news.com",
        });

        return NextResponse.json({
          success: true,
          message: `Live test email sent successfully to ${testEmail}!`,
        });
      } else {
        return NextResponse.json({
          success: true,
          simulated: true,
          message: `Test email simulated for ${testEmail}. Add SMTP credentials to .env.local to send live emails.`,
        });
      }
    }

    // Standard run: match all subscribers and targeted emails
    const result = await sendArticleNewsletterNotification(Number(articleId));
    return NextResponse.json(result);
  } catch (err: any) {
    console.error("[POST /api/newsletter/notify Error]:", err);
    return NextResponse.json(
      { error: "Failed to process newsletter notification", details: err.message },
      { status: 500 }
    );
  }
}

