export type ApplicationStatus =
  | 'SAVED'
  | 'APPLIED'
  | 'ASSESSMENT'
  | 'INTERVIEW'
  | 'OFFER'
  | 'REJECTED';

export type ScheduledStage = 'APPLIED' | 'ASSESSMENT' | 'INTERVIEW' | 'OFFER';
export type StageDates = Record<ScheduledStage, string>;

const scheduledStages: readonly ScheduledStage[] = ['APPLIED', 'ASSESSMENT', 'INTERVIEW', 'OFFER'];

export const emptyStageDates = (): StageDates => ({
  APPLIED: '',
  ASSESSMENT: '',
  INTERVIEW: '',
  OFFER: '',
});

export interface JobApplication {
  id: string;
  userId: string;
  company: string;
  role: string;
  location: string;
  applicationUrl: string;
  deadline: string;
  followUpDate: string;
  notes: string;
  resumeId?: string;
  stageDates: StageDates;
  status: ApplicationStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationInput {
  company?: unknown;
  role?: unknown;
  location?: unknown;
  applicationUrl?: unknown;
  deadline?: unknown;
  followUpDate?: unknown;
  notes?: unknown;
  resumeId? : unknown;
  stageDates?: unknown;
}

export interface ApplicationPatch extends ApplicationInput {
  status?: unknown;
}

const nextStatuses: Record<ApplicationStatus, ReadonlySet<ApplicationStatus>> = {
  SAVED: new Set(['APPLIED', 'REJECTED']),
  APPLIED: new Set(['ASSESSMENT', 'REJECTED']),
  ASSESSMENT: new Set(['INTERVIEW', 'REJECTED']),
  INTERVIEW: new Set(['OFFER', 'REJECTED']),
  OFFER: new Set(),
  REJECTED: new Set(),
};

export const applicationStatuses = Object.freeze(Object.keys(nextStatuses) as ApplicationStatus[]);

export function canTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return from === to || nextStatuses[from].has(to);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function optionalText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error('Text fields must be strings');
  return value.trim();
}

function validDate(value: unknown, label: string): string {
  const date = optionalText(value);
  if (date !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`${label} must use YYYY-MM-DD`);
  }
  return date;
}

function validUrl(value: unknown): string {
  const url = optionalText(value);
  if (url === '') return '';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Application URL must be valid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Application URL must use http or https');
  }
  return url;
}

function validStageDates(value: unknown, existing = emptyStageDates()): StageDates {
  if (value === undefined) return { ...existing };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stage dates must be an object');
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !scheduledStages.includes(key as ScheduledStage));
  if (unknown.length > 0) throw new Error(`Unknown stage date: ${unknown[0]}`);
  const dates = { ...existing };
  for (const stage of scheduledStages) {
    if (Object.hasOwn(record, stage)) dates[stage] = validDate(record[stage], `${stage} date`);
  }
  return dates;
}

function normalizeFields(input: ApplicationInput, existingStageDates = emptyStageDates()) {
  return {
    company: requiredText(input.company, 'Company'),
    role: requiredText(input.role, 'Role'),
    location: optionalText(input.location),
    applicationUrl: validUrl(input.applicationUrl),
    deadline: validDate(input.deadline, 'Deadline'),
    followUpDate: validDate(input.followUpDate, 'Follow-up date'),
    notes: optionalText(input.notes),
    ...(input.resumeId !== undefined ? { resumeId: optionalText(input.resumeId) } :{}),
    stageDates: validStageDates(input.stageDates, existingStageDates),
  };
}

export function normalizeStoredApplication(value: JobApplication): JobApplication {
  return {
    ...value,
    resumeId: optionalText(value.resumeId),
    stageDates: validStageDates(value.stageDates, emptyStageDates()),
  };
}

export function createApplication(
  input: ApplicationInput,
  userId: string,
  now = new Date(),
  id = crypto.randomUUID(),
): JobApplication {
  const timestamp = now.toISOString();
  return {
    id,
    userId,
    ...normalizeFields(input),
    status: 'SAVED',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function updateApplication(
  existing: JobApplication,
  patch: ApplicationPatch,
  now = new Date(),
): JobApplication {
  let status = existing.status;
  if (patch.status !== undefined) {
    if (typeof patch.status !== 'string' || !applicationStatuses.includes(patch.status as ApplicationStatus)) {
      throw new Error('Status is invalid');
    }
    const requested = patch.status as ApplicationStatus;
    if (!canTransition(existing.status, requested)) {
      throw new Error(`Cannot move application from ${existing.status} to ${requested}`);
    }
    status = requested;
  }

  const fields = normalizeFields({
    company: patch.company ?? existing.company,
    role: patch.role ?? existing.role,
    location: patch.location ?? existing.location,
    applicationUrl: patch.applicationUrl ?? existing.applicationUrl,
    deadline: patch.deadline ?? existing.deadline,
    followUpDate: patch.followUpDate ?? existing.followUpDate,
    notes: patch.notes ?? existing.notes,
    resumeId: patch.resumeId ?? existing.resumeId,
    stageDates: patch.stageDates,
  }, existing.stageDates ?? emptyStageDates());

  return { ...existing, ...fields, status, updatedAt: now.toISOString() };
}
