export interface ResumeVersion {
  id: string;
  userId: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResumeInput {
  title?: unknown;
  content?: unknown;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function fields(input: ResumeInput) {
  return {
    title: requiredText(input.title, 'Resume title'),
    content: requiredText(input.content, 'Resume content'),
  };
}

export function createResume(
  input: ResumeInput,
  userId: string,
  now = new Date(),
  id = crypto.randomUUID(),
): ResumeVersion {
  const timestamp = now.toISOString();
  return {
    id,
    userId,
    ...fields(input),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function updateResume(
  existing: ResumeVersion,
  input: ResumeInput,
  now = new Date(),
): ResumeVersion {
  return {
    ...existing,
    ...fields({
      title: input.title ?? existing.title,
      content: input.content ?? existing.content,
    }),
    updatedAt: now.toISOString(),
  };
}