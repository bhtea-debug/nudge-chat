import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET || 'dev-secret-change-in-production-min32');

export async function middleware(req: NextRequest) {
  const token = req.cookies.get('auth-token')?.value;
  const isAuthPage = req.nextUrl.pathname.startsWith('/login');
  const isApiAuth = req.nextUrl.pathname.startsWith('/api/auth');
  const isPublic = req.nextUrl.pathname.startsWith('/_next') ||
                   req.nextUrl.pathname.startsWith('/favicon') ||
                   req.nextUrl.pathname === '/';

  if (isApiAuth || isPublic) {
    return NextResponse.next();
  }

  if (!token) {
    if (isAuthPage) return NextResponse.next();
    return NextResponse.redirect(new URL('/login', req.url));
  }

  try {
    await jwtVerify(token, JWT_SECRET);
    if (isAuthPage) {
      return NextResponse.redirect(new URL('/', req.url));
    }
    return NextResponse.next();
  } catch {
    if (isAuthPage) return NextResponse.next();
    const response = NextResponse.redirect(new URL('/login', req.url));
    response.cookies.delete('auth-token');
    return response;
  }
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|uploads).*)'],
};
