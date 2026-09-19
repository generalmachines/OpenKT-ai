export interface MemoryRecord {
  id: string;
  projectId: string;
  content: string;
  kind: string;
  createdAt: string;
}

export interface MemoryRepository {
  findById(actorUserId: string, memoryId: string): Promise<MemoryRecord | null>;
  listByProject(actorUserId: string, projectId: string, limit: number): Promise<MemoryRecord[]>;
}
