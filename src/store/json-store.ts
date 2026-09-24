import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { normalizeStoredApplication, type ApplicationStatus, type JobApplication } from '../domain/application.ts';
import type { ResumeVersion } from '../domain/resume.ts';

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}

export interface ReminderRecord {
  id: string;
  userId: string;
  applicationId: string;
  followUpDate: string;
  message: string;
  createdAt: string;
}

interface Database {
  users: UserRecord[];
  applications: JobApplication[];
  reminders: ReminderRecord[];
  resumes: ResumeVersion[];
}

const emptyDatabase = (): Database => ({ users: [], applications: [], reminders: [], resumes: [] });

export class JsonStore {
  readonly #file: string;
  #writeQueue: Promise<unknown> = Promise.resolve();

  constructor(file: string) {
    this.#file = file;
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true });
    try {
      await this.#read();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.#write(emptyDatabase());
    }
  }

  async #read(): Promise<Database> {
    const parsed = JSON.parse(await readFile(this.#file, 'utf8')) as Partial<Database>;
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      applications: Array.isArray(parsed.applications)
        ? parsed.applications.map((application) => normalizeStoredApplication(application))
        : [],
      reminders: Array.isArray(parsed.reminders) ? parsed.reminders : [],
      resumes: Array.isArray(parsed.resumes) ? parsed.resumes : [],
    };
  }

  async #write(database: Database): Promise<void> {
    const temporary = `${this.#file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(database, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.#file);
  }

  #mutate<T>(operation: (database: Database) => T | Promise<T>): Promise<T> {
    const run = async () => {
      const database = await this.#read();
      const result = await operation(database);
      await this.#write(database);
      return result;
    };
    const queued = this.#writeQueue.then(run, run);
    this.#writeQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  async createUser(input: UserRecord): Promise<UserRecord> {
    const email = input.email.trim().toLowerCase();
    if (!email || !email.includes('@')) throw new Error('Email is invalid');
    return this.#mutate((database) => {
      if (database.users.some((user) => user.email === email)) {
        throw new Error('Email is already registered');
      }
      const user = { ...input, email };
      database.users.push(user);
      return user;
    });
  }

  async findUserByEmail(email: string): Promise<UserRecord | undefined> {
    const database = await this.#read();
    const normalized = email.trim().toLowerCase();
    return database.users.find((user) => user.email === normalized);
  }

  async addApplication(application: JobApplication): Promise<JobApplication> {
    return this.#mutate((database) => {
      if (database.applications.some((item) => item.id === application.id)) {
        throw new Error('Application already exists');
      }
      database.applications.push(application);
      return application;
    });
  }

  async listApplications(
    userId: string,
    filters: { query?: string; status?: ApplicationStatus } = {},
  ): Promise<JobApplication[]> {
    const database = await this.#read();
    const query = filters.query?.trim().toLowerCase() ?? '';
    return database.applications.filter((item) => {
      if (item.userId !== userId) return false;
      if (filters.status && item.status !== filters.status) return false;
      return query === '' || item.company.toLowerCase().includes(query) || item.role.toLowerCase().includes(query);
    });
  }

  async getApplication(userId: string, id: string): Promise<JobApplication | undefined> {
    const database = await this.#read();
    return database.applications.find((item) => item.id === id && item.userId === userId);
  }

  async replaceApplication(userId: string, application: JobApplication): Promise<JobApplication | undefined> {
    return this.#mutate((database) => {
      const index = database.applications.findIndex((item) => item.id === application.id && item.userId === userId);
      if (index === -1) return undefined;
      const previous = database.applications[index];
      database.applications[index] = application;
      if (previous.followUpDate !== application.followUpDate || ['OFFER', 'REJECTED'].includes(application.status)) {
        database.reminders = database.reminders.filter((reminder) =>
          reminder.applicationId !== application.id || reminder.userId !== userId);
      }
      return application;
    });
  }

  async deleteApplication(userId: string, id: string): Promise<boolean> {
    return this.#mutate((database) => {
      const index = database.applications.findIndex((item) => item.id === id && item.userId === userId);
      if (index === -1) return false;
      database.applications.splice(index, 1);
      database.reminders = database.reminders.filter((reminder) => reminder.applicationId !== id);
      return true;
    });
  }

  async addResume(resume: ResumeVersion): Promise<ResumeVersion> {
    return this.#mutate((database) => {
      if (database.resumes.some((item) => item.id === resume.id)) {
        throw new Error('Resume already exists');
      }
      database.resumes.push(resume);
      return resume;
    });
  }

  async listResumes(userId: string): Promise<ResumeVersion[]> {
    const database = await this.#read();
    return database.resumes.filter((resume) => resume.userId === userId);
  }

  async getResume(userId: string, id: string): Promise<ResumeVersion | undefined> {
    const database = await this.#read();
    return database.resumes.find((resume) => resume.id === id && resume.userId === userId);
  }

  async replaceResume(userId: string, resume: ResumeVersion): Promise<ResumeVersion | undefined> {
    return this.#mutate((database) => {
      const index = database.resumes.findIndex((item) => item.id === resume.id && item.userId === userId);
      if (index === -1) return undefined;
      database.resumes[index] = resume;
      return resume;
    });
  }

  async deleteResume(userId: string, id: string): Promise<boolean> {
    return this.#mutate((database) => {
      const index = database.resumes.findIndex((resume) => resume.id === id && resume.userId === userId);
      if (index === -1) return false;
      database.resumes.splice(index, 1);
      for (const application of database.applications) {
        if (application.userId === userId && application.resumeId === id) {
          application.resumeId = '';
        }
      }
      return true;
    });
  }

  async listReminders(userId: string): Promise<ReminderRecord[]> {
    const database = await this.#read();
    return database.reminders.filter((reminder) => reminder.userId === userId);
  }

  async addReminders(reminders: ReminderRecord[]): Promise<ReminderRecord[]> {
    return this.#mutate((database) => {
      const existingIds = new Set(database.reminders.map((reminder) => reminder.id));
      const added = reminders.filter((reminder) => {
        if (existingIds.has(reminder.id)) return false;
        const application = database.applications.find((item) =>
          item.id === reminder.applicationId && item.userId === reminder.userId);
        return application?.followUpDate === reminder.followUpDate &&
          application.status !== 'OFFER' && application.status !== 'REJECTED';
      });
      database.reminders.push(...added);
      return added;
    });
  }
}