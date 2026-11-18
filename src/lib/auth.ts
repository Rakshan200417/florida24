import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';

export interface AuthUser {
  id: number | string;
  name: string;
  email: string;
  role: 'admin' | 'writer' | 'reader' | string;
  avatar_url?: string;
}

export const AUTH_COOKIE_NAME = 'florida24_session';

const getJwtSecret = (): string => {
  return process.env.JWT_SECRET || 'florida24_fallback_jwt_secret_change_in_production_2026';
};

/**
 * Creates a signed JWT token valid for 7 days
 */
export function createAuthToken(user: AuthUser): string {
  const payload = {
    id: user.id,
    name: user.name,
    email: user.email.toLowerCase().trim(),
    role: user.role,
    avatar_url: user.avatar_url || '',
  };

  return jwt.sign(payload, getJwtSecret(), {
    expiresIn: '7d',
  });
}

/**
 * Verifies a JWT token string and returns the authenticated user payload
 */
export function verifyAuthToken(token: string): AuthUser | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret()) as any;
    if (decoded && decoded.email && decoded.role) {
      return {
        id: decoded.id,
        name: decoded.name || decoded.email.split('@')[0],
        email: decoded.email,
        role: decoded.role,
        avatar_url: decoded.avatar_url || '',
      };
    }
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * Extracts and verifies the authenticated user from request cookies or Authorization header
 */
export function getAuthUser(request: Request): AuthUser | null {
  // 1. Try to read from HttpOnly cookie
  const cookieHeader = request.headers.get('cookie') || '';
  const cookies = parseCookies(cookieHeader);
  const cookieToken = cookies[AUTH_COOKIE_NAME];

  if (cookieToken) {
    const user = verifyAuthToken(cookieToken);
    if (user) return user;
  }

  // 2. Fallback to Authorization: Bearer <token>
  const authHeader = request.headers.get('authorization') || '';
  if (authHeader.startsWith('Bearer ')) {
    const bearerToken = authHeader.substring(7).trim();
    const user = verifyAuthToken(bearerToken);
    if (user) return user;
  }

  return null;
}

/**
 * Attaches the signed HttpOnly auth cookie to a NextResponse
 */
export function setAuthCookie(response: NextResponse, token: string): void {
  const isProduction = process.env.NODE_ENV === 'production';
  response.cookies.set({
    name: AUTH_COOKIE_NAME,
    value: token,
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60, // 7 days in seconds
  });
}

/**
 * Clears the auth cookie on logout
 */
export function clearAuthCookie(response: NextResponse): void {
  response.cookies.set({
    name: AUTH_COOKIE_NAME,
    value: '',
    httpOnly: true,
    path: '/',
    expires: new Date(0),
    maxAge: 0,
  });
}

/**
 * Helper to enforce authentication and role authorization in API route handlers
 */
export function requireAuth(
  request: Request,
  allowedRoles?: string[]
): { user: AuthUser } | { errorResponse: NextResponse } {
  const user = getAuthUser(request);

  if (!user) {
    return {
      errorResponse: NextResponse.json(
        { error: 'Unauthorized: Authentication required' },
        { status: 401 }
      ),
    };
  }

  if (allowedRoles && allowedRoles.length > 0) {
    if (!allowedRoles.includes(user.role)) {
      return {
        errorResponse: NextResponse.json(
          { error: `Forbidden: Access restricted to ${allowedRoles.join('/')}` },
          { status: 403 }
        ),
      };
    }
  }

  return { user };
}

/**
 * Simple cookie string parser
 */
function parseCookies(cookieHeader: string): Record<string, string> {
  const list: Record<string, string> = {};
  if (!cookieHeader) return list;

  cookieHeader.split(';').forEach((cookie) => {
    const parts = cookie.split('=');
    const name = parts[0]?.trim();
    if (name) {
      list[name] = decodeURIComponent(parts.slice(1).join('=').trim());
    }
  });

  return list;
}
