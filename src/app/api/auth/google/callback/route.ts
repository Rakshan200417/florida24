import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import { createAuthToken, AUTH_COOKIE_NAME, AuthUser } from '@/lib/auth';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error || !code) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(error || 'Google authorization cancelled')}`, url.origin)
    );
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return NextResponse.json(
      { error: 'Google OAuth credentials not configured in environment variables.' },
      { status: 500 }
    );
  }

  // Derive redirect URI dynamically to match current domain/host
  const protocol = url.protocol;
  const host = request.headers.get('host') || url.host;
  const redirectUri = `${protocol}//${host}/api/auth/google/callback`;

  try {
    // 1. Exchange authorization code for tokens
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.access_token) {
      console.error('Failed to exchange code for token:', tokenData);
      return NextResponse.redirect(
        new URL('/login?error=Failed+to+exchange+Google+authorization+code', url.origin)
      );
    }

    // 2. Fetch user profile from Google UserInfo endpoint
    const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
      },
    });

    const profile = await userInfoResponse.json();

    if (!profile.email) {
      return NextResponse.redirect(
        new URL('/login?error=Google+profile+did+not+provide+an+email+address', url.origin)
      );
    }

    const email = profile.email.toLowerCase().trim();
    const name = profile.name || email.split('@')[0];
    const avatarUrl = profile.picture || '';

    // Known admin emails
    const adminEmails = [
      'akramyoonos006@gmail.com',
      'geethliyanage979@gmail.com',
      'direct@florida24news.com',
    ];

    // 3. Check if user already exists in database
    const [existingRows]: any = await pool.execute(
      'SELECT id, name, email, role, avatar_url FROM users WHERE LOWER(email) = ? LIMIT 1',
      [email]
    );

    let loggedInUser: { id: number | string; name: string; email: string; role: string; avatar_url: string };

    if (existingRows && existingRows.length > 0) {
      const user = existingRows[0];
      const effectiveRole = adminEmails.includes(email) ? 'admin' : user.role;
      // Update avatar or promote to admin if designated
      if ((!user.avatar_url && avatarUrl) || (user.role !== effectiveRole)) {
        try {
          await pool.execute('UPDATE users SET avatar_url = COALESCE(NULLIF(avatar_url, ""), ?), role = ? WHERE id = ?', [avatarUrl, effectiveRole, user.id]);
        } catch (e) {
          console.warn('Could not update user record:', e);
        }
      }
      loggedInUser = {
        id: user.id,
        name: user.name || name,
        email: user.email,
        role: effectiveRole,
        avatar_url: user.avatar_url || avatarUrl,
      };
    } else {
      // 4. Create new user account with default role
      const initialRole = adminEmails.includes(email) ? 'admin' : 'reader';
      const [insertResult]: any = await pool.execute(
        `INSERT INTO users (name, email, password, role, avatar_url)
         VALUES (?, ?, 'oauth_google_account', ?, ?)`,
        [name, email, initialRole, avatarUrl]
      );

      loggedInUser = {
        id: insertResult.insertId,
        name,
        email,
        role: initialRole,
        avatar_url: avatarUrl,
      };
    }

    // 5. Render client-side completion script that stores user into localStorage and redirects
    const targetRedirect = loggedInUser.role === 'admin' ? '/admin' : '/';
    const safeUserData = JSON.stringify(loggedInUser);

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Completing Sign In...</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      background-color: #f8f9fa;
      color: #333;
    }
    .card {
      text-align: center;
      padding: 32px;
      background: white;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.08);
      max-width: 380px;
    }
    .spinner {
      border: 3px solid #e5e7eb;
      border-top: 3px solid #ce1126;
      border-radius: 50%;
      width: 28px;
      height: 28px;
      animation: spin 0.8s linear infinite;
      margin: 0 auto 16px;
    }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h3 style="margin: 0 0 8px; font-size: 16px; font-weight: 700;">Signing you in</h3>
    <p style="margin: 0; font-size: 13px; color: #6b7280;">Connecting your Google account with Florida 24...</p>
  </div>
  <script>
    try {
      localStorage.setItem("user", ${JSON.stringify(safeUserData)});
      window.dispatchEvent(new Event("storage"));
      window.dispatchEvent(new CustomEvent("userProfileUpdated"));
    } catch (e) {
      console.error("Storage error:", e);
    }
    setTimeout(function() {
      window.location.href = "${targetRedirect}";
    }, 400);
  </script>
</body>
</html>`;

    const sessionToken = createAuthToken(loggedInUser);
    const isProduction = process.env.NODE_ENV === 'production';
    const secureFlag = isProduction ? '; Secure' : '';
    const cookieHeader = `${AUTH_COOKIE_NAME}=${sessionToken}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}${secureFlag}`;

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': cookieHeader,
      },
    });
  } catch (err: any) {
    console.error('Google OAuth callback error:', err);
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(err.message || 'Authentication error')}`, url.origin)
    );
  }
}
