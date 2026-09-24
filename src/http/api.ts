import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

import { createApplication, applicationStatuses, updateApplication, type ApplicationStatus } from '../domain/application.ts';
import { hashPassword, signToken, verifyPassword, verifyToken, type TokenClaims } from '../domain/auth.ts';
import { buildDueReminders } from '../domain/reminders.ts';
import { JsonStore } from '../store/json-store.ts';
import { createResume, updateResume } from '../domain/resume.ts';

interface ApiOptions {
  store: JsonStore;
  jwtSecret: string;
  now?: () => Date;
  publicDirectory?: string;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(response: ServerResponse, status: number, body?: unknown): void {
  response.statusCode = status;
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('cache-control', 'no-store');
  if (body === undefined) {
    response.end();
    return;
  }
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function serveStatic(pathname: string, publicDirectory: string, response: ServerResponse): Promise<boolean> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (decoded.includes('..') || decoded.includes('\\')) return false;
  const root = resolve(publicDirectory);
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const file = resolve(root, relative);
  if (!file.startsWith(`${root}${sep}`)) return false;
  try {
    const contents = await readFile(file);
    response.statusCode = 200;
    response.setHeader('content-type', contentTypes[extname(file)] ?? 'application/octet-stream');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('content-security-policy', "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'");
    response.end(contents);
    return true;
  } catch {
    return false;
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body must be valid JSON');
  }
}

function bearer(request: IncomingMessage, secret: string, now: Date): TokenClaims {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) {
    throw new HttpError(401, 'UNAUTHORIZED', 'Authentication is required');
  }
  try {
    return verifyToken(authorization.slice(7), secret, now);
  } catch {
    throw new HttpError(401, 'UNAUTHORIZED', 'Authentication token is invalid or expired');
  }
}

function emailFrom(body: Record<string, unknown>): string {
  if (typeof body.email !== 'string' || !/^\S+@\S+\.\S+$/.test(body.email.trim())) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Email is invalid');
  }
  return body.email.trim().toLowerCase();
}

function passwordFrom(body: Record<string, unknown>): string {
  if (typeof body.password !== 'string' || body.password.length < 8) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Password must contain at least 8 characters');
  }
  return body.password;
}

export function createApiServer(options: ApiOptions): Server {
  const now = options.now ?? (() => new Date());

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const method = request.method ?? 'GET';

      if (method === 'GET' && !url.pathname.startsWith('/api/') && options.publicDirectory) {
        if (await serveStatic(url.pathname, options.publicDirectory, response)) return;
      }

      if (method === 'POST' && url.pathname === '/api/auth/register') {
        const body = await readJson(request);
        const email = emailFrom(body);
        const password = passwordFrom(body);
        let user;
        try {
          user = await options.store.createUser({
            id: crypto.randomUUID(),
            email,
            passwordHash: await hashPassword(password),
            createdAt: now().toISOString(),
          });
        } catch (error) {
          if ((error as Error).message === 'Email is already registered') {
            throw new HttpError(409, 'EMAIL_EXISTS', 'Email is already registered');
          }
          throw error;
        }
        json(response, 201, { token: signToken({ sub: user.id, email: user.email }, options.jwtSecret, now()) });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/auth/login') {
        const body = await readJson(request);
        const email = emailFrom(body);
        const password = passwordFrom(body);
        const user = await options.store.findUserByEmail(email);
        if (!user || !await verifyPassword(password, user.passwordHash)) {
          throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
        }
        json(response, 200, { token: signToken({ sub: user.id, email: user.email }, options.jwtSecret, now()) });
        return;
      }

      if (!url.pathname.startsWith('/api/')) {
        throw new HttpError(404, 'NOT_FOUND', 'Route not found');
      }

      const claims = bearer(request, options.jwtSecret, now());

      if (method === 'GET' && url.pathname === '/api/resumes') {
        const resumes = await options.store.listResumes(claims.sub);
        json(response, 200, { resumes });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/resumes') {
        const body = await readJson(request);
        let resume;
        try {
          resume = createResume(body, claims.sub, now());
        } catch (error) {
          throw new HttpError(400, 'VALIDATION_ERROR', (error as Error).message);
        }
        await options.store.addResume(resume);
        json(response, 201, { resume });
        return;
      }

      const resumeMatch = url.pathname.match(/^\/api\/resumes\/([^/]+)$/);
      if (resumeMatch) {
        const id = decodeURIComponent(resumeMatch[1]);
        const existing = await options.store.getResume(claims.sub, id);
        if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Resume not found');

        if (method === 'GET') {
          json(response, 200, { resume: existing });
          return;
        }

        if (method === 'PATCH') {
          const body = await readJson(request);
          let resume;
          try {
            resume = updateResume(existing, body, now());
          } catch (error) {
            throw new HttpError(400, 'VALIDATION_ERROR', (error as Error).message);
          }
          await options.store.replaceResume(claims.sub, resume);
          json(response, 200, { resume });
          return;
        }

        if (method === 'DELETE') {
          await options.store.deleteResume(claims.sub, id);
          json(response, 204);
          return;
        }
      }

      if (method === 'GET' && url.pathname === '/api/applications') {
        const rawStatus = url.searchParams.get('status');
        if (rawStatus && !applicationStatuses.includes(rawStatus as ApplicationStatus)) {
          throw new HttpError(400, 'VALIDATION_ERROR', 'Status filter is invalid');
        }
        const applications = await options.store.listApplications(claims.sub, {
          query: url.searchParams.get('q') ?? undefined,
          status: rawStatus as ApplicationStatus | undefined,
        });
        json(response, 200, { applications });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/applications') {
        const body = await readJson(request);
        if (typeof body.resumeId === 'string' && body.resumeId.trim() !== '') {
          const resume = await options.store.getResume(claims.sub, body.resumeId.trim());
          if (!resume) throw new HttpError(404, 'NOT_FOUND', 'Resume not found');
        }
        let application;
        try {
          application = createApplication(body, claims.sub, now());
        } catch (error) {
          throw new HttpError(400, 'VALIDATION_ERROR', (error as Error).message);
        }
        await options.store.addApplication(application);
        json(response, 201, { application });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/reminders/generate') {
        await readJson(request);
        const applications = await options.store.listApplications(claims.sub);
        const existing = await options.store.listReminders(claims.sub);
        const due = buildDueReminders(
          applications,
          existing,
          claims.sub,
          now().toISOString().slice(0, 10),
          now(),
        );
        const reminders = await options.store.addReminders(due);
        json(response, 201, { reminders });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/reminders') {
        json(response, 200, { reminders: await options.store.listReminders(claims.sub) });
        return;
      }

      const match = url.pathname.match(/^\/api\/applications\/([^/]+)$/);
      if (match) {
        const id = decodeURIComponent(match[1]);
        const existing = await options.store.getApplication(claims.sub, id);
        if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Application not found');

        if (method === 'GET') {
          json(response, 200, { application: existing });
          return;
        }
        if (method === 'PATCH') {
          const body = await readJson(request);
        if (typeof body.resumeId === 'string' && body.resumeId.trim() !== '') {
          const resume = await options.store.getResume(claims.sub, body.resumeId.trim());
          if (!resume) throw new HttpError(404, 'NOT_FOUND', 'Resume not found');
        }
          let application;
          try {
            application = updateApplication(existing, body, now());
          } catch (error) {
            throw new HttpError(400, 'VALIDATION_ERROR', (error as Error).message);
          }
          await options.store.replaceApplication(claims.sub, application);
          json(response, 200, { application });
          return;
        }
        if (method === 'DELETE') {
          await options.store.deleteApplication(claims.sub, id);
          json(response, 204);
          return;
        }
      }

      throw new HttpError(404, 'NOT_FOUND', 'Route not found');
    } catch (error) {
      if (error instanceof HttpError) {
        json(response, error.status, { error: { code: error.code, message: error.message } });
        return;
      }
      json(response, 500, { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
    }
  });
}