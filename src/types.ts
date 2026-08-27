export type Chapter = {
  id: string;
  title: string;
  level: number;
  file: string;
  order: number;
  wordCount: number;
  /** Original source path, used only to resolve local image references. */
  sourcePath?: string;
  /** Directory containing sourcePath, relative to the source root. */
  resourceBase?: string;
};

export type Work = {
  id: string;
  title: string;
  chapters: Chapter[];
  source: string;
};

export type Session = {
  id: string;
  title: string;
  sourceName: string;
  createdAt: string;
  updatedAt: string;
  root: string;
  works: Work[];
  selectedWorkId?: string;
  currentChapter?: number;
};
