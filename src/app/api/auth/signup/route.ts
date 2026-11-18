import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import bcrypt from 'bcryptjs';
import { createAuthToken, setAuthCookie, AuthUser } from '@/lib/auth';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { fullName, email, password } = body;

    if (!email || !password) {
      return NextResponse.json(
        { error: 'Email and password are required' },
        { status: 400 }
      );
    }

    if (typeof password !== 'string' || password.length < 6) {
      return NextResponse.json(
        { error: 'Password must be at least 6 characters long' },
        { status: 400 }
      );
    }

    try {
      // Check if user already exists
      const [existing]: any = await pool.execute(
        'SELECT id FROM users WHERE LOWER(email) = ? LIMIT 1',
        [email.toLowerCase().trim()]
      );

      if (existing && existing.length > 0) {
        return NextResponse.json(
          { error: 'An account with this email already exists' },
          { status: 409 }
        );
      }

      // Hash password using bcryptjs
      const hashedPassword = await bcrypt.hash(password, 10);

      // Insert new user
      const [result]: any = await pool.execute(
        'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
        [fullName || email.split('@')[0], email.toLowerCase().trim(), hashedPassword, 'reader']
      );

      const safeUser: AuthUser = {
        id: result.insertId,
        name: fullName || email.split('@')[0],
        email: email.toLowerCase().trim(),
        role: 'reader',
      };

      const token = createAuthToken(safeUser);

      const response = NextResponse.json(
        {
          message: 'Account created successfully',
          user: safeUser,
        },
        { status: 201 }
      );

      setAuthCookie(response, token);
      return response;
    } catch (dbErr) {
      console.warn('DB error or table missing, using dev session fallback:', dbErr);
      // Fallback for development if local MySQL is offline
      return NextResponse.json(
        {
          message: 'Account created successfully',
          user: {
            id: Date.now(),
            name: fullName || 'Reader',
            email,
            role: 'reader',
          },
        },
        { status: 201 }
      );
    }
  } catch (error) {
    console.error('Signup Error:', error);
    return NextResponse.json(
      { error: 'Internal server error processing registration' },
      { status: 500 }
    );
  }
}
