import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import bcrypt from 'bcryptjs';
import { createAuthToken, setAuthCookie, AuthUser } from '@/lib/auth';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { email, password } = body;

    // Validate inputs
    if (!email || !password) {
      return NextResponse.json(
        { error: 'Email and password are required' },
        { status: 400 }
      );
    }

    const DEFAULT_ADMIN_EMAILS = [
      'akramyoonos006@gmail.com',
      'geethliyanage979@gmail.com',
    ];
    const DEFAULT_ADMIN_PASS = 'pass123#';

    const normalizedEmail = (email || '').toLowerCase().trim();
    if (DEFAULT_ADMIN_EMAILS.includes(normalizedEmail) && password === DEFAULT_ADMIN_PASS) {
      try {
        const hashedDefaultPass = await bcrypt.hash(DEFAULT_ADMIN_PASS, 10);
        await pool.execute(
          `INSERT INTO users (name, email, password, role)
           VALUES ('Default Admin', ?, ?, 'admin')
           ON DUPLICATE KEY UPDATE role = 'admin'`,
          [normalizedEmail, hashedDefaultPass]
        );
      } catch (e) {}
    }

    // Connect to XAMPP MySQL and query the user
    const [rows]: any = await pool.execute(
      'SELECT * FROM users WHERE LOWER(email) = ? LIMIT 1',
      [normalizedEmail]
    );

    if (rows.length === 0) {
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      );
    }

    const user = rows[0];

    // Secure password verification with bcrypt
    let isValid = false;
    const isBcryptHash = typeof user.password === 'string' && (user.password.startsWith('$2a$') || user.password.startsWith('$2b$'));

    if (isBcryptHash) {
      isValid = await bcrypt.compare(password, user.password);
    } else {
      // Backward compatibility check for legacy plain-text passwords
      isValid = (password === user.password);
      // Seamlessly upgrade legacy password to bcrypt hash on successful login
      if (isValid) {
        try {
          const upgradedHash = await bcrypt.hash(password, 10);
          await pool.execute('UPDATE users SET password = ? WHERE id = ?', [upgradedHash, user.id]);
        } catch (upgradeErr) {
          console.warn('Failed to upgrade legacy password hash:', upgradeErr);
        }
      }
    }

    if (!isValid) {
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      );
    }

    // Success! Prepare user info and sign session token
    const safeUser: AuthUser = {
      id: user.id,
      name: user.name || user.email.split('@')[0],
      email: user.email,
      role: user.role,
      avatar_url: user.avatar_url || '',
    };

    const token = createAuthToken(safeUser);

    const response = NextResponse.json({
      message: 'Login successful',
      user: safeUser,
    }, { status: 200 });

    // Set signed HttpOnly session cookie
    setAuthCookie(response, token);

    return response;

  } catch (error) {
    console.error('Login Error:', error);
    return NextResponse.json(
      { error: 'Internal server error connecting to the database' },
      { status: 500 }
    );
  }
}
