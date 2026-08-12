/**
 * Audiobookshelf response shapes.
 *
 * Every field is optional on purpose. ABS returns materially different payloads
 * depending on server version and on whether `minified=1` was requested (for
 * example `metadata.authors[]` vs a comma-joined `metadata.authorName`), so the
 * mapper in `map.ts` reads defensively rather than trusting one shape.
 */

export interface AbsStatus {
  isInit?: boolean;
  serverVersion?: string;
  language?: string;
  authMethods?: string[];
}

export interface AbsUserPermissions {
  download?: boolean;
  update?: boolean;
  delete?: boolean;
  upload?: boolean;
  accessAllLibraries?: boolean;
  accessAllTags?: boolean;
  accessExplicitContent?: boolean;
}

export interface AbsUser {
  id?: string;
  username?: string;
  type?: string;
  token?: string;
  accessToken?: string;
  refreshToken?: string;
  isActive?: boolean;
  permissions?: AbsUserPermissions;
  librariesAccessible?: string[];
}

export interface AbsLoginResponse {
  user?: AbsUser;
  userDefaultLibraryId?: string;
  serverSettings?: Record<string, unknown>;
  /** Newer JWT-based servers may surface tokens at the top level. */
  accessToken?: string;
  refreshToken?: string;
}

export interface AbsFolder {
  id?: string;
  fullPath?: string;
  libraryId?: string;
  addedAt?: number;
}

export interface AbsLibrary {
  id?: string;
  name?: string;
  folders?: AbsFolder[];
  displayOrder?: number;
  icon?: string;
  mediaType?: string;
  provider?: string;
}

export interface AbsLibrariesResponse {
  libraries?: AbsLibrary[];
}

export interface AbsAuthorRef {
  id?: string;
  name?: string;
}

export interface AbsSeriesRef {
  id?: string;
  name?: string;
  sequence?: string | null;
}

export interface AbsBookMetadata {
  title?: string | null;
  titleIgnorePrefix?: string | null;
  subtitle?: string | null;
  /** Full payloads use structured arrays… */
  authors?: AbsAuthorRef[];
  narrators?: string[];
  series?: AbsSeriesRef[];
  /** …minified payloads use comma-joined strings. */
  authorName?: string | null;
  narratorName?: string | null;
  seriesName?: string | null;
  asin?: string | null;
  isbn?: string | null;
  publishedYear?: string | null;
  publishedDate?: string | null;
  publisher?: string | null;
  language?: string | null;
  genres?: string[];
  description?: string | null;
  explicit?: boolean;
  abridged?: boolean;
}

export interface AbsAudioFile {
  index?: number;
  ino?: string;
  duration?: number;
  metadata?: { filename?: string; size?: number; ext?: string; path?: string; relPath?: string };
  mimeType?: string;
}

export interface AbsEbookFile {
  ino?: string;
  ebookFormat?: string;
  metadata?: { filename?: string; size?: number; ext?: string };
}

export interface AbsLibraryFile {
  ino?: string;
  fileType?: string;
  metadata?: { filename?: string; size?: number; ext?: string; path?: string; relPath?: string };
}

export interface AbsBookMedia {
  id?: string;
  metadata?: AbsBookMetadata;
  coverPath?: string | null;
  duration?: number;
  size?: number;
  numTracks?: number;
  numAudioFiles?: number;
  numChapters?: number;
  audioFiles?: AbsAudioFile[];
  tracks?: AbsAudioFile[];
  ebookFile?: AbsEbookFile | null;
  ebookFormat?: string | null;
}

export interface AbsLibraryItem {
  id?: string;
  ino?: string;
  libraryId?: string;
  folderId?: string;
  path?: string;
  relPath?: string;
  mediaType?: string;
  isFile?: boolean;
  isMissing?: boolean;
  isInvalid?: boolean;
  size?: number;
  numFiles?: number;
  addedAt?: number;
  updatedAt?: number;
  /** Filesystem mtime; some versions expose this instead of updatedAt. */
  mtimeMs?: number;
  birthtimeMs?: number;
  media?: AbsBookMedia;
  libraryFiles?: AbsLibraryFile[];
}

export interface AbsPagedItems {
  results?: AbsLibraryItem[];
  total?: number;
  limit?: number;
  page?: number;
  sortBy?: string;
  sortDesc?: boolean;
}

export interface AbsSeries {
  id?: string;
  name?: string;
  nameIgnorePrefix?: string;
  description?: string | null;
  addedAt?: number;
  books?: AbsLibraryItem[];
  totalDuration?: number;
}

export interface AbsPagedSeries {
  results?: AbsSeries[];
  total?: number;
  limit?: number;
  page?: number;
}

export interface AbsAudioTrack {
  index?: number;
  startOffset?: number;
  duration?: number;
  title?: string;
  contentUrl?: string;
  mimeType?: string;
  metadata?: { filename?: string; ext?: string; size?: number };
}

export interface AbsPlaybackSession {
  id?: string;
  userId?: string;
  libraryItemId?: string;
  mediaType?: string;
  playMethod?: number;
  audioTracks?: AbsAudioTrack[];
  duration?: number;
  currentTime?: number;
  startedAt?: number;
}

export interface AbsUploadResponse {
  /** ABS has returned different shapes here across versions. */
  libraryItem?: AbsLibraryItem;
  libraryItems?: AbsLibraryItem[];
  results?: AbsLibraryItem[];
  success?: boolean;
  error?: string;
}
