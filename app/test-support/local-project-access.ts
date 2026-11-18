import type { LocalProject } from '../shared/local-project.ts';

export type ProjectBinding = {
  directory: string;
  write: boolean;
  restricted?: boolean;
};
export class ProjectError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export type LocalProjectAccess = {
  read(project: string): LocalProject;
  binding(project: string, agent: string, folder?: string): ProjectBinding | undefined;
};
